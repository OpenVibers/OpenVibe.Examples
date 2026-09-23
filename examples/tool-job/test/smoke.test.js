'use strict';
/**
 * Smoke test: submit -> watch (with a dropped stream) -> result -> download, reattach after a
 * restart, idempotent resubmission, owner scoping. Network and Tools jobs are openvibe-sdk/testing's
 * mock platform (jobs: true), with a sandbox app as a new project has. No network.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMockPlatform } = require('openvibe-sdk/testing');
const { createJobRunner, loadConfig } = require('../run-job');

globalThis.fetch = () => { throw new Error('network access in a smoke test'); };

const quiet = { log() {}, error() {} };
const TOOLS = ['tools.job.create', 'tools.job.read'];

(async () => {
    const platform = createMockPlatform({
        acceptSandbox: ['openvibe.tools'],            // Tools accepts developer-app sandbox tokens on /api/v1/jobs
        jobs: {
            stepMs: 5,
            handlers: {
                'img.process': async ({ input, files, progress }) => {
                    await progress(50, 'converting');
                    const name = files[0].name.replace(/\.[^.]+$/, '') + `.${input.format}`;
                    return { data: { format: input.format }, files: [{ name, mime: `image/${input.format}`, bytes: Buffer.concat([Buffer.from('converted:'), files[0].bytes]) }] };
                },
            },
        },
    });
    const app = platform.addApp({ env: 'sandbox', grants: TOOLS });
    const other = platform.addApp({ env: 'sandbox', grants: TOOLS });
    const noGrant = platform.addApp({ env: 'sandbox', grants: ['media.object.upload'] });
    const { fetch } = platform;

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-tooljob-'));
    const file = path.join(dir, 'photo.png');
    fs.writeFileSync(file, Buffer.from('not really a png, the mock does not care'));
    const env = { OV_CLIENT_ID: app.id, OV_CLIENT_SECRET: app.secret, OV_OUT_DIR: path.join(dir, 'out'), OV_JOB_STATE: path.join(dir, 'state.json') };
    const submits = () => platform.stats.requests.filter((r) => r.method === 'POST' && r.url.endsWith('/api/v1/jobs')).length;
    const streams = () => platform.stats.requests.filter((r) => r.url.endsWith('/events'));

    // 1. The whole flow, with the event stream dropped right after its first event.
    const seen = [];
    const runner = createJobRunner(loadConfig(env), { fetch, log: quiet, reconnectDelayMs: 10 });
    const { job, files } = await runner.run(file, {
        onEvent: (e) => { seen.push(e); if (seen.length === 1) platform.dropJobStreams(); },
    });
    assert.equal(job.state, 'succeeded');
    assert.deepEqual(seen.map((e) => e.event), ['job.queued', 'job.running', 'job.progress', 'job.succeeded']);
    assert.deepEqual(seen.map((e) => e.id), [1, 2, 3, 4], 'every event once, in order');
    assert.ok(streams().length >= 2, 'reconnected after the drop');
    assert.equal(streams()[1].headers['last-event-id'], '1', 'with Last-Event-ID');
    assert.equal(files.length, 1);
    assert.equal(path.basename(files[0]), 'photo.webp');
    assert.equal(fs.readFileSync(files[0], 'utf8'), 'converted:not really a png, the mock does not care');
    assert.equal(fs.existsSync(env.OV_JOB_STATE), false, 'state cleared once done');
    assert.equal(submits(), 1);
    assert.ok(platform.stats.requests.some((r) => r.url === 'https://img.openvibe.tools/api/v1/jobs'), 'img.process went to the img satellite (the default)');
    const submitCall = platform.stats.requests.find((r) => r.method === 'POST' && r.url.endsWith('/api/v1/jobs'));
    assert.match(submitCall.headers['idempotency-key'], /^ex-[0-9a-f]{40}$/);

    // 2. Crash after submitting: a new process with the same state file reattaches, no second job.
    const file2 = path.join(dir, 'second.png');
    fs.writeFileSync(file2, 'second image');
    const crashed = createJobRunner(loadConfig(env), { fetch, log: quiet });
    const first = await crashed.submit(file2);
    assert.equal(first.reattached, false);
    const restarted = createJobRunner(loadConfig(env), { fetch, log: quiet });
    const again = await restarted.run(file2);
    assert.equal(again.job.id, first.jobId);
    assert.equal(submits(), 2, 'reattached instead of resubmitting');

    // 3. Lost state file: the Idempotency-Key is derived from the request, so Tools replays the same job.
    const lost = createJobRunner(loadConfig(env), { fetch, log: quiet });
    const replay = await lost.submit(file2);
    assert.equal(replay.jobId, first.jobId);
    assert.equal(replay.replayed, true);

    // 4. A finished job with nothing newer answers 204: watch() returns at once.
    const t0 = Date.now();
    await lost.watch(first.jobId);
    assert.ok(Date.now() - t0 < 1000);

    // 5. Jobs are owner-scoped: another app sees nothing (404), and a 4xx is not retried in a loop.
    const otherRunner = createJobRunner(loadConfig({ ...env, OV_CLIENT_ID: other.id, OV_CLIENT_SECRET: other.secret, OV_JOB_STATE: path.join(dir, 'other.json') }), { fetch, log: quiet });
    assert.equal(await otherRunner.get(first.jobId), null);
    await assert.rejects(otherRunner.watch(first.jobId), (err) => err.status === 404 && err.code === 'tools.job.not_found');

    // 6. No grant: Network refuses the token, nothing reaches Tools.
    const before = submits();
    const nogrant = createJobRunner(loadConfig({ ...env, OV_CLIENT_ID: noGrant.id, OV_CLIENT_SECRET: noGrant.secret }), { fetch, log: quiet });
    await assert.rejects(nogrant.submit(path.join(dir, 'photo.png')), (err) => err.code === 'invalid_scope');
    assert.equal(submits(), before);

    fs.rmSync(dir, { recursive: true, force: true });
    console.log('tool-job: ok');
})().catch((err) => { console.error(err); process.exit(1); });
