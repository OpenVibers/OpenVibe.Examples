#!/usr/bin/env node
'use strict';
/**
 * Tool job: run an OpenVibe.Tools job as a developer app and survive disconnects and restarts.
 *
 *   node --env-file=.env run-job.js ./photo.png           # img.process, convert to WebP by default
 *
 *   1. App token for openvibe.tools (client credentials, scope tools.job.create tools.job.read).
 *   2. POST /api/v1/jobs (multipart: type, input, file) with an Idempotency-Key derived from the
 *      request, so re-running after a crash gets the SAME job back (200 Idempotent-Replayed).
 *   3. The job id and the last event id are saved in a state file. Running the script again
 *      reattaches to the job instead of submitting a new one.
 *   4. GET /api/v1/jobs/:id/events (SSE). When the stream drops, reconnect with Last-Event-ID: the
 *      server replays only later events. 204 means the job finished and nothing is newer.
 *   5. GET /api/v1/jobs/:id for the result, then download each result file.
 *
 * openvibe-sdk has no jobs client yet (sdk-jobs), so the job routes are called with the SDK's core
 * client, which still supplies the token, deadlines, safe retries, problem errors and tracing. The
 * event stream is the exception: the core client cannot return a streaming body, so it is read
 * with fetch and the same app token.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createClient, isOpenVibeError, OpenVibeError, startSpan } = require('openvibe-sdk/core');
const { createServiceTokenClient } = require('openvibe-sdk/auth');

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);

function loadConfig(env = process.env) {
    const missing = ['OV_CLIENT_ID', 'OV_CLIENT_SECRET'].filter((k) => !env[k]);
    if (missing.length) {
        throw Object.assign(new Error(`missing environment variables: ${missing.join(', ')} (see .env.example)`), { code: 'config.missing' });
    }
    let input;
    try { input = JSON.parse(env.OV_JOB_INPUT || '{"tool":"convert","format":"webp"}'); } catch {
        throw Object.assign(new Error('OV_JOB_INPUT must be a JSON object'), { code: 'config.invalid' });
    }
    return {
        network: env.OV_NETWORK_URL || 'https://openvibe.network',
        clientId: env.OV_CLIENT_ID,
        clientSecret: env.OV_CLIENT_SECRET,
        toolsUrl: env.OV_TOOLS_JOBS_URL || 'https://img.openvibe.tools',
        type: env.OV_JOB_TYPE || 'img.process',
        input,
        outDir: env.OV_OUT_DIR || path.join(process.cwd(), 'out'),
        statePath: env.OV_JOB_STATE || path.join(process.cwd(), '.job-state.json'),
    };
}

/** Parse a text/event-stream body: calls onEvent({ id, event, data }) per event, onRetry(ms). */
async function readEventStream(body, onEvent, onRetry = () => {}) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let cur = { data: [] };
    const line = (l) => {
        if (l === '') {
            if (cur.data.length) onEvent({ id: cur.id, event: cur.event || 'message', data: cur.data.join('\n') });
            cur = { data: [] };
            return;
        }
        if (l.startsWith(':')) return;
        const i = l.indexOf(':');
        const field = i < 0 ? l : l.slice(0, i);
        const value = i < 0 ? '' : l.slice(i + 1).replace(/^ /, '');
        if (field === 'data') cur.data.push(value);
        else if (field === 'event') cur.event = value;
        else if (field === 'id') cur.id = value;
        else if (field === 'retry' && /^\d+$/.test(value)) onRetry(Number(value));
    };
    for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let m;
        while ((m = /\r\n|\n|\r/.exec(buf))) {
            if (m[0] === '\r' && m.index === buf.length - 1) break;
            line(buf.slice(0, m.index));
            buf = buf.slice(m.index + m[0].length);
        }
    }
}

function createJobRunner(config, { fetch, log = console } = {}) {
    const tokens = createServiceTokenClient({
        network: config.network, clientId: config.clientId, clientSecret: config.clientSecret, fetch,
        scope: { 'openvibe.tools': 'tools.job.create tools.job.read' },
    });
    const client = createClient({ network: config.network, fetch, tokenProvider: tokens, baseUrls: { tools: config.toolsUrl } });
    const fetchImpl = fetch || globalThis.fetch;

    const loadState = () => { try { return JSON.parse(fs.readFileSync(config.statePath, 'utf8')); } catch { return null; } };
    const saveState = (s) => {
        const tmp = `${config.statePath}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
        fs.renameSync(tmp, config.statePath);
    };
    const clearState = () => { try { fs.unlinkSync(config.statePath); } catch { /* none */ } };

    /** Submit, or reattach to the job this state file already names for the same request. */
    async function submit(filePath) {
        const bytes = await fs.promises.readFile(filePath);
        const fingerprint = crypto.createHash('sha256').update(config.type).update('\0').update(JSON.stringify(config.input)).update('\0').update(bytes).digest('hex');
        const saved = loadState();
        if (saved && saved.fingerprint === fingerprint && saved.jobId) {
            log.log(`reattaching to ${saved.jobId}`);
            return { jobId: saved.jobId, reattached: true };
        }
        const form = new FormData();
        form.append('type', config.type);
        form.append('input', JSON.stringify(config.input));
        form.append('file', new Blob([bytes]), path.basename(filePath));
        const res = await client.request({
            service: 'tools', method: 'POST', path: '/api/v1/jobs', form,
            idempotencyKey: `ex-${fingerprint.slice(0, 40)}`,   // same request -> same job, even after a crash
        });
        const job = res.data;
        saveState({ jobId: job.id, fingerprint, lastEventId: 0, submittedAt: new Date().toISOString() });
        log.log(`${res.headers.get('idempotent-replayed') ? 'existing' : 'submitted'} ${job.id} (${job.state})`);
        return { jobId: job.id, reattached: false, replayed: Boolean(res.headers.get('idempotent-replayed')) };
    }

    /**
     * Open the job's event stream. The SDK's core client cannot hand back a streaming body
     * (responseType 'response' drops the Response), so this one call uses fetch directly with the
     * same app token.
     */
    async function openStream(jobId, lastEventId) {
        const url = `${config.toolsUrl.replace(/\/+$/, '')}/api/v1/jobs/${encodeURIComponent(jobId)}/events`;
        for (let attempt = 0; attempt < 2; attempt++) {
            const token = await tokens.getToken({ audience: 'openvibe.tools' });
            const res = await fetchImpl(url, {
                headers: { Accept: 'text/event-stream', Authorization: `Bearer ${token}`, 'Last-Event-ID': String(lastEventId), traceparent: startSpan().traceparent },
            });
            if (res.status === 401 && attempt === 0) { tokens.invalidate({ audience: 'openvibe.tools' }); continue; }
            if (!res.ok) {
                const body = await res.json().catch(() => null);
                throw OpenVibeError.fromResponse({ status: res.status, body, method: 'GET', url });
            }
            return res;
        }
        throw new Error('unreachable');
    }

    /** Follow the job's events until it finishes, reconnecting with Last-Event-ID. */
    async function watch(jobId, { onEvent = () => {}, maxReconnects = 20 } = {}) {
        let retryMs = 1000;
        let reconnects = 0;
        for (;;) {
            const state = loadState() || {};
            const lastEventId = state.jobId === jobId ? state.lastEventId || 0 : 0;
            let finished = false;
            try {
                const res = await openStream(jobId, lastEventId);
                if (res.status === 204) return;                      // finished, nothing newer
                await readEventStream(res.body, (e) => {
                    let data = null;
                    try { data = JSON.parse(e.data); } catch { /* keep null */ }
                    if (e.id) saveState({ ...(loadState() || {}), jobId, lastEventId: Number(e.id) });
                    onEvent({ id: Number(e.id), event: e.event, job: data });
                    if (data && TERMINAL.has(data.state) && e.event !== 'job.progress') finished = true;
                }, (ms) => { retryMs = ms; });
            } catch (err) {
                if (isOpenVibeError(err) && err.status >= 400 && err.status < 500) throw err;   // 401/403/404: do not loop
                log.error(`event stream interrupted: ${isOpenVibeError(err) ? err.code : err.message}`);
            }
            if (finished) return;
            if (++reconnects > maxReconnects) throw new Error(`gave up after ${maxReconnects} reconnects`);
            await new Promise((r) => setTimeout(r, retryMs));
        }
    }

    async function get(jobId) {
        return client.json({ service: 'tools', path: `/api/v1/jobs/${encodeURIComponent(jobId)}` });
    }

    async function download(job) {
        const saved = [];
        fs.mkdirSync(config.outDir, { recursive: true });
        for (const [n, f] of ((job.result && job.result.files) || []).entries()) {
            const res = await client.request({ service: 'tools', path: `/api/v1/jobs/${encodeURIComponent(job.id)}/files/${n}`, responseType: 'arrayBuffer' });
            const name = path.basename(String(f.name || `result-${n}`)).replace(/[^\w.-]/g, '_');
            const out = path.join(config.outDir, name);
            fs.writeFileSync(out, Buffer.from(res.data));
            saved.push(out);
        }
        return saved;
    }

    /** submit -> watch -> result -> download; clears the state file once the job is done. */
    async function run(filePath, { onEvent } = {}) {
        const { jobId } = await submit(filePath);
        await watch(jobId, { onEvent });
        const job = await get(jobId);
        const files = job.state === 'succeeded' ? await download(job) : [];
        clearState();
        return { job, files };
    }

    return { client, submit, watch, get, download, run, loadState };
}

async function main([file] = process.argv.slice(2)) {
    if (!file) { console.error('usage: node run-job.js <file>'); return 2; }
    try {
        const runner = createJobRunner(loadConfig());
        const { job, files } = await runner.run(file, {
            onEvent: ({ event, job: j }) => {
                const pct = j && j.progress && j.progress.percent != null ? ` ${j.progress.percent}%` : '';
                console.log(`${event}${pct}${j && j.progress && j.progress.message ? ` ${j.progress.message}` : ''}`);
            },
        });
        if (job.state !== 'succeeded') {
            console.error(`job ${job.id} ${job.state}${job.error ? `: ${job.error.code} ${job.error.detail || ''}` : ''}`);
            return 1;
        }
        for (const f of files) console.log(`saved ${f}`);
        return 0;
    } catch (err) {
        console.error(`job failed: ${isOpenVibeError(err) ? `${err.code}${err.detail ? `: ${err.detail}` : ''}` : err.message}`);
        return 1;
    }
}

if (require.main === module) main().then((code) => { process.exitCode = code; });

module.exports = { loadConfig, createJobRunner, readEventStream, main };
