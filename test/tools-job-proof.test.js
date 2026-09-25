'use strict';
/**
 * scripts/tools-job-proof.js against openvibe-sdk/testing's mock platform: a service principal with
 * tools.job.* and events.event.read, a mock img.process converter. The mock keeps job results locally
 * and has no Tools relay, so a thin layer plays Tools' production side: the job view says where
 * Tools put the result (storage "media"), and tools.job.created/started/succeeded reach the Events
 * store shortly after the submit, as the outbox relay posts them. Also: each check fails when its
 * part is missing, --result holds step names only, and the script refuses to start without
 * credentials or in CI against production. No network.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { createMockPlatform } = require('openvibe-sdk/testing');
const { runToolsJobProof, writeResult, tinyPng, STEPS } = require('../scripts/tools-job-proof');

globalThis.fetch = () => { throw new Error('network access in a test'); };

const TOOLS = 'https://openvibe.tools';
const GRANTS = [['tools.job.create', 'openvibe.tools'], ['tools.job.read', 'openvibe.tools'], ['events.event.read', 'openvibe.events']];
const webp = (from) => Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), from.subarray(0, 32)]);

function setup({ grants = GRANTS, media = true, relay = true } = {}) {
    const platform = createMockPlatform({
        jobs: {
            stepMs: 5,
            handlers: {
                'img.process': async ({ input, files, progress }) => {
                    await progress(50, 'converting');
                    return { data: { format: input.format }, files: [{ name: 'tools-job-proof.webp', mime: 'image/webp', bytes: webp(files[0].bytes) }] };
                },
            },
        },
    });
    platform.addClient('probe', { secret: 'probe-secret', grants });
    const announce = (type, id) => platform.publishEvent({ event_type: type, source: 'tools', priority: type === 'tools.job.succeeded' ? 'important' : 'low', actor: { type: 'service', id: 'tools' }, subject: { type: 'job', id }, visibility: 'internal' }, 'svc:tools');
    const fetch = async (input, init = {}) => {
        const url = new URL(typeof input === 'string' ? input : input.url);
        const method = (init.method || 'GET').toUpperCase();
        const res = await platform.fetch(input, init);
        if (url.origin !== TOOLS) return res;
        if (relay && method === 'POST' && url.pathname === '/api/v1/jobs' && res.status === 202) {
            const { id } = await res.clone().json();
            announce('tools.job.created', id);
            setTimeout(() => { announce('tools.job.started', id); announce('tools.job.succeeded', id); }, 30);
        }
        if (media && method === 'GET' && /^\/api\/v1\/jobs\/job_[^/]+$/.test(url.pathname) && res.ok) {
            const job = await res.json();
            if (job.result) job.result.files = job.result.files.map((f, i) => ({ ...f, storage: 'media', media: { media_id: `med_proof${i}`, role: 'output' } }));
            return new Response(JSON.stringify(job), { status: res.status, headers: res.headers });
        }
        return res;
    };
    return { platform, fetch };
}

const run = (fetch, extra = {}) => runToolsJobProof({ fetch, clientId: 'probe', clientSecret: 'probe-secret', log: () => {}, eventsWaitMs: 2000, pollMs: 20, reconnectDelayMs: 10, ...extra });

(async () => {
    // The generated input is a real PNG: signature, IHDR 16x16 RGB, and IDAT that inflates to its rows.
    const png = tinyPng();
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.equal(png.toString('ascii', 12, 16), 'IHDR');
    assert.equal(png.readUInt32BE(16), 16);
    const idatLen = png.readUInt32BE(33);
    assert.equal(png.toString('ascii', 37, 41), 'IDAT');
    assert.equal(zlib.inflateSync(png.subarray(41, 41 + idatLen)).length, (16 * 3 + 1) * 16);

    // 1. Every step passes; the stream was dropped and reattached with Last-Event-ID.
    {
        const { platform, fetch } = setup();
        const result = await run(fetch);
        assert.deepEqual(result.steps.map((s) => [s.name, s.ok]), STEPS.map((n) => [n, true]), JSON.stringify(result.steps));
        assert.equal(result.ok, true);
        const streams = platform.stats.requests.filter((r) => r.url.endsWith('/events'));
        assert.equal(streams.length, 2, 'one stream, then one reattach');
        assert.equal(streams[1].headers['last-event-id'], '1');
        const file = platform.stats.requests.filter((r) => /\/files\/0/.test(r.url));
        assert.equal(file.length, 1, 'the result was downloaded');
    }

    // 2. A result that stayed on the Tools host fails the result step; the rest is skipped.
    {
        const { fetch } = setup({ media: false });
        const result = await run(fetch);
        const r = result.steps.find((s) => s.name === 'result');
        assert.equal(r.ok, false);
        assert.match(r.error, /not in OpenVibe\.Media/);
        assert.deepEqual(result.steps.find((s) => s.name === 'events'), { name: 'events', ok: false, skipped: true });
    }

    // 3. Events that never reach the store fail the events step.
    {
        const { fetch } = setup({ relay: false });
        const result = await run(fetch, { eventsWaitMs: 100 });
        assert.equal(result.ok, false);
        assert.match(result.steps.find((s) => s.name === 'events').error, /tools\.job\.created, tools\.job\.started, tools\.job\.succeeded/);
    }

    // 4. A principal without events.event.read fails at the token step, before submitting anything.
    {
        const { platform, fetch } = setup({ grants: GRANTS.slice(0, 2) });
        const result = await run(fetch);
        assert.equal(result.steps[0].name, 'token');
        assert.equal(result.steps[0].ok, false);
        assert.equal(platform.stats.requests.filter((r) => r.method === 'POST' && r.url.endsWith('/api/v1/jobs')).length, 0);
    }

    // 5. --result: step names and outcomes, no error text, id or secret.
    {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-toolsproof-'));
        const file = path.join(dir, 'last.json');
        const rec = writeResult(file, { ok: false, jobId: 'job_secretish', steps: [{ name: 'token', ok: true }, { name: 'cursor', ok: false, error: 'events.forbidden (403) request=req_1' }, { name: 'submit', ok: false, skipped: true }] }, { network: 'https://openvibe.network', started: 0, now: 1000 });
        const text = fs.readFileSync(file, 'utf8');
        assert.deepEqual(JSON.parse(text), rec);
        assert.deepEqual(rec.steps, [{ name: 'token', ok: true }, { name: 'cursor', ok: false }, { name: 'submit', ok: false, skipped: true }]);
        assert.doesNotMatch(text, /forbidden|req_1|job_secretish/);
        fs.rmSync(dir, { recursive: true, force: true });
    }

    // 6. It refuses to start without credentials, and in CI against production.
    {
        const script = path.join(__dirname, '..', 'scripts', 'tools-job-proof.js');
        const { spawnSync } = require('node:child_process');
        const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(OV_|CI$)/.test(k)));
        const none = spawnSync(process.execPath, [script], { env: clean, encoding: 'utf8' });
        assert.equal(none.status, 2);
        assert.match(none.stderr, /missing OV_CLIENT_ID/);
        const ci = spawnSync(process.execPath, [script], { env: { ...clean, CI: 'true', OV_CLIENT_ID: 'x', OV_CLIENT_SECRET: 'y' }, encoding: 'utf8' });
        assert.equal(ci.status, 2);
        assert.match(ci.stderr, /refusing to run against the production Network in CI/);
    }

    console.log('tools-job-proof: all checks passed');
})().catch((err) => { console.error(err); process.exitCode = 1; });
