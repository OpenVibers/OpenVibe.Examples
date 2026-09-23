#!/usr/bin/env node
'use strict';
/**
 * Tool job: run an OpenVibe.Tools job as a developer app and survive disconnects and restarts.
 *
 *   node --env-file=.env run-job.js ./photo.png           # img.process, convert to WebP by default
 *
 *   1. App token for openvibe.tools (client credentials, scope tools.job.create tools.job.read).
 *      Tools accepts sandbox app tokens (a sandbox project may have 2 active jobs, 30 minutes each).
 *   2. openvibe-sdk/jobs submit() with an Idempotency-Key derived from the request, so re-running
 *      after a crash gets the SAME job back (Tools answers 200 Idempotent-Replayed).
 *   3. The job id and the last event id are saved in a state file. Running the script again
 *      reattaches to the job instead of submitting a new one.
 *   4. jobs.events() follows the job's SSE stream and reconnects with Last-Event-ID after a drop;
 *      every event arrives once, in order, and a finished job ends the stream (204).
 *   5. jobs.get() for the result, jobs.file() for each result file.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createClient, isOpenVibeError } = require('openvibe-sdk/core');
const { createServiceTokenClient } = require('openvibe-sdk/auth');
const { createJobsClient } = require('openvibe-sdk/jobs');

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

function createJobRunner(config, { fetch, log = console, reconnectDelayMs } = {}) {
    const tokens = createServiceTokenClient({
        network: config.network, clientId: config.clientId, clientSecret: config.clientSecret, fetch,
        scope: { 'openvibe.tools': 'tools.job.create tools.job.read' },
    });
    const client = createClient({ network: config.network, fetch, tokenProvider: tokens });
    const jobs = createJobsClient(client, { baseUrl: config.toolsUrl });

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
        const { job, replayed } = await jobs.submit({
            type: config.type, input: config.input,
            files: [{ name: path.basename(filePath), data: bytes }],
            idempotencyKey: `ex-${fingerprint.slice(0, 40)}`,        // same request -> same job, even after a crash
        });
        saveState({ jobId: job.id, fingerprint, lastEventId: 0, submittedAt: new Date().toISOString() });
        log.log(`${replayed ? 'existing' : 'submitted'} ${job.id} (${job.state})`);
        return { jobId: job.id, reattached: false, replayed };
    }

    /** Follow the job's events until it finishes; the last event id survives a restart. */
    async function watch(jobId, { onEvent = () => {} } = {}) {
        const state = loadState() || {};
        const lastEventId = state.jobId === jobId ? state.lastEventId || 0 : 0;
        for await (const e of jobs.events(jobId, { lastEventId, reconnectDelayMs })) {
            if (e.id != null) saveState({ ...(loadState() || {}), jobId, lastEventId: e.id });
            await onEvent(e);
        }
    }

    /** The job, or null when it does not exist or is not yours (Tools answers both with 404). */
    const get = (jobId) => jobs.get(jobId);

    async function download(job) {
        const saved = [];
        fs.mkdirSync(config.outDir, { recursive: true });
        for (const [n, f] of ((job.result && job.result.files) || []).entries()) {
            const res = await jobs.file(job.id, n);
            const name = path.basename(String(f.name || `result-${n}`)).replace(/[^\w.-]/g, '_');
            const out = path.join(config.outDir, name);
            fs.writeFileSync(out, Buffer.from(await res.arrayBuffer()));
            saved.push(out);
        }
        return saved;
    }

    /** submit -> watch -> result -> download; clears the state file once the job is done. */
    async function run(filePath, { onEvent } = {}) {
        const { jobId } = await submit(filePath);
        await watch(jobId, { onEvent });
        const job = await get(jobId);
        const files = job && job.state === 'succeeded' ? await download(job) : [];
        clearState();
        return { job, files };
    }

    return { client, jobs, submit, watch, get, download, run, loadState };
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
        if (!job || job.state !== 'succeeded') {
            console.error(job ? `job ${job.id} ${job.state}${job.error ? `: ${job.error.code} ${job.error.detail || ''}` : ''}` : 'the job is gone (expired, or not this app\'s)');
            return 1;
        }
        for (const f of files) console.log(`saved ${f}`);
        return 0;
    } catch (err) {
        console.error(`job failed: ${isOpenVibeError(err) ? `${err.code}${err.detail ? `: ${err.detail}` : ''}${err.requestId ? ` (request ${err.requestId})` : ''}` : err.message}`);
        return 1;
    }
}

if (require.main === module) main().then((code) => { process.exitCode = code; });

module.exports = { loadConfig, createJobRunner, main };
