#!/usr/bin/env node
'use strict';
/**
 * npm run tools-job-proof: the scheduled end-to-end proof of OpenVibe.Tools jobs (roadmap WS-L task 4).
 * A first-party client that uses the public API and openvibe-sdk only, with a service principal's
 * client credentials (production environment: sandbox jobs are never announced or copied to Media):
 *
 *   1. token     client credentials for tools.job.create + tools.job.read (openvibe.tools) and
 *                events.event.read (openvibe.events)
 *   2. cursor    the head of the Events store for tools.job.*, taken before anything is submitted
 *   3. submit    a converter job: img.process, convert a small generated PNG to WebP
 *   4. reattach  follow the job's progress stream, drop it after the first event and reattach with
 *                Last-Event-ID the way the Tools UI does after a reload: every later event once, in
 *                order, up to job.succeeded
 *   5. result    the durable job reads back succeeded; its result file is stored in OpenVibe.Media
 *                (storage "media" with a media id) and downloads as a WebP with the listed sha256
 *                (Tools serves a Media-stored result from Media only: no local copy is kept)
 *   6. events    tools.job.created, tools.job.started and tools.job.succeeded for this job are in the
 *                Events store, after the cursor
 *
 *   OV_CLIENT_ID=… OV_CLIENT_SECRET=… npm run tools-job-proof [-- --result <file>]
 *
 * OV_OAUTH_CLIENT_ID / OV_OAUTH_CLIENT_SECRET (what Network's service-principal setup writes) work too.
 * Optional: OV_NETWORK_URL, OV_TOOLS_JOBS_URL. Refuses to run in CI against the production Network; CI
 * runs it against openvibe-sdk/testing's mock platform (test/tools-job-proof.test.js). Never prints the
 * secret or a token. --result writes step names and outcomes only (OpenVibe.Host openvibe-toolsjob.timer).
 * Exit 0 when every step passed, 1 when one failed, 2 when it refused to start.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const zlib = require('node:zlib');
const { createClient, isOpenVibeError } = require('openvibe-sdk/core');
const { createServiceTokenClient } = require('openvibe-sdk/auth');
const { createJobsClient } = require('openvibe-sdk/jobs');
const { createEventsClient } = require('openvibe-sdk/events');

const PRODUCTION_NETWORK = 'https://openvibe.network';
const STEPS = ['token', 'cursor', 'submit', 'reattach', 'result', 'events'];
const EVENT_TYPES = ['tools.job.created', 'tools.job.started', 'tools.job.succeeded'];
const STEP_TIMEOUT_MS = 180000;

const describeError = (err) => (isOpenVibeError(err) || (err && err.code && err.status !== undefined)
    ? `${err.code}${err.status ? ` (${err.status})` : ''}${err.detail ? `: ${err.detail}` : ''}${err.requestId ? ` request=${err.requestId}` : ''}`
    : String((err && err.message) || err));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function timeout(promise, what) {
    let timer;
    return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} took longer than ${STEP_TIMEOUT_MS / 1000} s`)), STEP_TIMEOUT_MS); })])
        .finally(() => clearTimeout(timer));
}

/** A small valid RGB PNG (a gradient), made here so the proof needs no file. */
function tinyPng(w = 16, h = 16) {
    const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
    const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
    const chunk = (type, data) => {
        const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
        const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
        const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
        return Buffer.concat([len, body, sum]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;   // 8-bit RGB
    const raw = Buffer.alloc((w * 3 + 1) * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set([x * 16, y * 16, 160], y * (w * 3 + 1) + 1 + x * 3);
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const isWebp = (b) => b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP';

async function runToolsJobProof({ network = PRODUCTION_NETWORK, toolsUrl, clientId, clientSecret, fetch: fetchImpl = globalThis.fetch, log = (m) => console.log(m), eventsWaitMs = 90000, pollMs = 3000, reconnectDelayMs } = {}) {
    network = network.replace(/\/+$/, '');
    const say = (m) => log(`    ${m}`);
    const st = { jobs: null, events: null, cursor: 0, jobId: null, job: null };
    const steps = [];
    let failed = false;

    async function step(name, fn) {
        log(`[${steps.length + 1}/${STEPS.length}] ${name}`);
        if (failed) { steps.push({ name, ok: false, skipped: true }); log('    skipped (an earlier step failed)\n'); return; }
        try {
            await timeout(fn(), name);
            steps.push({ name, ok: true });
            log('    ok\n');
        } catch (err) {
            failed = true;
            steps.push({ name, ok: false, error: describeError(err) });
            log(`    FAILED: ${describeError(err)}\n`);
        }
    }

    await step('token', async () => {
        const tokens = createServiceTokenClient({
            network, clientId, clientSecret, fetch: fetchImpl,
            scope: { 'openvibe.tools': 'tools.job.create tools.job.read', 'openvibe.events': 'events.event.read' },
        });
        // Ask for both now, so a missing grant fails here and not halfway through.
        for (const audience of ['openvibe.tools', 'openvibe.events']) {
            const t = await tokens.getToken({ audience });
            if (!t) throw new Error(`no token for ${audience}`);
        }
        const client = createClient({ network, fetch: fetchImpl, tokenProvider: tokens });
        st.jobs = createJobsClient(client, toolsUrl ? { baseUrl: toolsUrl } : undefined);
        st.events = createEventsClient(client);
        say('tokens for openvibe.tools (tools.job.create, tools.job.read) and openvibe.events (events.event.read)');
    });

    await step('cursor', async () => {
        const page = await st.events.pull({ topic: 'tools.job.*', afterSeq: Number.MAX_SAFE_INTEGER, limit: 1 });
        st.cursor = Number(page.latest_seq) || 0;
        say(`Events head: seq ${st.cursor}`);
    });

    await step('submit', async () => {
        const png = tinyPng();
        const { job, replayed } = await st.jobs.submit({
            type: 'img.process', input: { tool: 'convert', format: 'webp' },
            files: [{ name: 'tools-job-proof.png', data: png, type: 'image/png' }],
            idempotencyKey: `proof-${crypto.randomUUID()}`,
        });
        if (replayed) throw new Error('a fresh Idempotency-Key was answered as a replay');
        st.jobId = job.id;
        say(`submitted ${job.id} (${job.state}), ${png.length} bytes of PNG`);
    });

    await step('reattach', async () => {
        // First connection: one event, then the stream is dropped (a reload, a lost connection).
        let first = null;
        for await (const e of st.jobs.events(st.jobId, { reconnectDelayMs })) { first = e; break; }
        if (!first || first.id == null) throw new Error('the progress stream sent no event with an id');
        say(`first stream: ${first.event} (id ${first.id}), then dropped`);
        // Reattach from the last id seen: only later events, each once, in order, up to the end.
        const later = [];
        for await (const e of st.jobs.events(st.jobId, { lastEventId: first.id, reconnectDelayMs })) later.push(e);
        const ids = later.map((e) => Number(e.id));
        if (ids.some((id, i) => !(id > (i ? ids[i - 1] : Number(first.id))))) throw new Error(`reattached stream replayed or reordered events: ${[first.id, ...ids].join(', ')}`);
        const last = later.length ? later[later.length - 1] : first;
        if (last.event !== 'job.succeeded') throw new Error(`the job ended with ${last.event}${last.job && last.job.error ? ` (${last.job.error.code})` : ''}`);
        say(`reattached with Last-Event-ID ${first.id}: ${later.map((e) => e.event).join(' → ') || '(finished already, 204)'}`);
    });

    await step('result', async () => {
        const job = await st.jobs.get(st.jobId);
        if (!job) throw new Error('the job is gone (404)');
        if (job.state !== 'succeeded') throw new Error(`the job reads back ${job.state}`);
        const f = job.result && job.result.files && job.result.files[0];
        if (!f) throw new Error('the job has no result file');
        if (f.storage !== 'media' || !f.media || !f.media.media_id) throw new Error(`the result is stored "${f.storage}", not in OpenVibe.Media`);
        const res = await st.jobs.file(st.jobId, 0);
        const bytes = Buffer.from(await res.arrayBuffer());
        const sha = crypto.createHash('sha256').update(bytes).digest('hex');
        if (f.sha256 && sha !== f.sha256) throw new Error('the downloaded result does not match its sha256');
        if (!isWebp(bytes)) throw new Error('the result is not a WebP image');
        st.job = job;
        say(`succeeded; ${f.name} (${bytes.length} bytes, WebP) is Media object ${f.media.media_id}, downloaded with sha256 ${sha.slice(0, 16)}…`);
    });

    await step('events', async () => {
        const found = new Map();
        let after = st.cursor;
        const deadline = Date.now() + eventsWaitMs;
        for (;;) {
            let page;
            do {
                page = await st.events.pull({ topic: 'tools.job.*', afterSeq: after, limit: 200 });
                for (const { seq, event } of page.events || []) {
                    if (event && event.subject && event.subject.id === st.jobId && EVENT_TYPES.includes(event.event_type)) found.set(event.event_type, seq);
                }
                after = page.next_after_seq != null ? page.next_after_seq : after;
            } while ((page.events || []).length && after < page.latest_seq);
            if (EVENT_TYPES.every((t) => found.has(t))) break;
            if (Date.now() >= deadline) throw new Error(`not in the Events store after ${eventsWaitMs / 1000} s: ${EVENT_TYPES.filter((t) => !found.has(t)).join(', ')}`);
            await sleep(pollMs);
        }
        say(EVENT_TYPES.map((t) => `${t} seq ${found.get(t)}`).join(', '));
    });

    const ok = steps.every((s) => s.ok);
    log(`${steps.filter((s) => s.ok).length}/${steps.length} steps ok`);
    return { ok, steps, jobId: st.jobId };
}

/** The outcome as JSON (written to file.tmp, then renamed): step names and ok only. → the record */
function writeResult(file, result, { network, started = Date.now(), now = Date.now() } = {}) {
    const record = {
        ok: !!result.ok, network, started_at: new Date(started).toISOString(), finished_at: new Date(now).toISOString(),
        steps: result.steps.map((st) => ({ name: st.name, ok: !!st.ok, ...(st.skipped ? { skipped: true } : {}) })),
    };
    fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o644 });
    fs.renameSync(`${file}.tmp`, file);
    return record;
}

async function main(argv = process.argv.slice(2), env = process.env) {
    const network = (env.OV_NETWORK_URL || PRODUCTION_NETWORK).replace(/\/+$/, '');
    if (env.CI && new URL(network).host === new URL(PRODUCTION_NETWORK).host) {
        console.error('tools-job-proof: refusing to run against the production Network in CI (CI is set). Nothing was sent.');
        return 2;
    }
    const clientId = env.OV_CLIENT_ID || env.OV_OAUTH_CLIENT_ID;
    const clientSecret = env.OV_CLIENT_SECRET || env.OV_OAUTH_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
        console.error('tools-job-proof: missing OV_CLIENT_ID and OV_CLIENT_SECRET (or OV_OAUTH_CLIENT_ID and OV_OAUTH_CLIENT_SECRET). Nothing was sent.');
        return 2;
    }
    console.log(`OpenVibe Tools job proof against ${network}\n`);
    const started = Date.now();
    const result = await runToolsJobProof({ network, toolsUrl: env.OV_TOOLS_JOBS_URL || undefined, clientId, clientSecret });
    const out = argv.indexOf('--result');
    if (out >= 0 && argv[out + 1]) writeResult(argv[out + 1], result, { network, started });
    return result.ok ? 0 : 1;
}

module.exports = { runToolsJobProof, writeResult, tinyPng, STEPS, EVENT_TYPES, PRODUCTION_NETWORK };

if (require.main === module) {
    main().then((code) => { process.exitCode = code; }, (err) => { console.error(`tools-job-proof: ${describeError(err)}`); process.exitCode = 1; });
}
