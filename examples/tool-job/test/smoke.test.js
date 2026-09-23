'use strict';
/**
 * Smoke test: submit -> watch (with a dropped stream) -> result -> download, reattach after a
 * restart, idempotent resubmission. Network is the SDK's mock platform; Tools is the local mock in
 * this folder (the SDK mock has no Tools). No network.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMockPlatform } = require('openvibe-sdk/testing');
const { createJobRunner, loadConfig } = require('../run-job');
const { createMockToolsServer } = require('./mock-tools-server');

const realFetch = globalThis.fetch;
globalThis.fetch = () => { throw new Error('network access in a smoke test'); };

const APP = 'app_01JEXAMPLETOOLJOB000000000';
const OTHER = 'app_01JANOTHERAPP0000000000000';
const SECRET = 'ovsec_tool_job_test_secret';
const quiet = { log() {}, error() {} };

(async () => {
    const toolsGrants = [{ capability: 'tools.job.create', audience: 'openvibe.tools' }, { capability: 'tools.job.read', audience: 'openvibe.tools' }];
    const platform = createMockPlatform({
        clients: { [APP]: { secret: SECRET, grants: toolsGrants }, [OTHER]: { secret: 'o', grants: toolsGrants }, app_01JNOGRANT0000000000000000: { secret: 'n', grants: [] } },
    });
    const tools = createMockToolsServer({ publicKey: platform.keys.publicKey, dropStreamsAfter: 1 });
    const toolsUrl = await tools.listen();
    // Network calls go to the mock platform, Tools calls to the local mock server.
    const fetch = (input, init) => (String(input && input.url ? input.url : input).startsWith(toolsUrl) ? realFetch(input, init) : platform.fetch(input, init));

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-tooljob-'));
    const file = path.join(dir, 'photo.png');
    fs.writeFileSync(file, Buffer.from('not really a png, the mock does not care'));
    const env = { OV_CLIENT_ID: APP, OV_CLIENT_SECRET: SECRET, OV_TOOLS_JOBS_URL: toolsUrl, OV_OUT_DIR: path.join(dir, 'out'), OV_JOB_STATE: path.join(dir, 'state.json') };

    // 1. The whole flow, with the event stream dropped after its first event.
    const seen = [];
    const runner = createJobRunner(loadConfig(env), { fetch, log: quiet });
    const { job, files } = await runner.run(file, { onEvent: (e) => seen.push(e) });
    assert.equal(job.state, 'succeeded');
    assert.deepEqual(seen.map((e) => e.event), ['job.queued', 'job.running', 'job.progress', 'job.succeeded']);
    assert.deepEqual(seen.map((e) => e.id), [1, 2, 3, 4], 'every event once, in order');
    assert.deepEqual(tools.stats.streams.slice(0, 2), [0, 1], 'reconnected with Last-Event-ID: 1');
    assert.equal(files.length, 1);
    assert.equal(path.basename(files[0]), 'photo.webp');
    assert.equal(fs.readFileSync(files[0], 'utf8'), 'converted:not really a png, the mock does not care');
    assert.equal(fs.existsSync(env.OV_JOB_STATE), false, 'state cleared once done');
    assert.equal(tools.stats.submits, 1);

    // 2. Crash after submitting: a new process with the same state file reattaches, no second job.
    const file2 = path.join(dir, 'second.png');
    fs.writeFileSync(file2, 'second image');
    const crashed = createJobRunner(loadConfig(env), { fetch, log: quiet });
    const first = await crashed.submit(file2);
    assert.equal(first.reattached, false);
    const restarted = createJobRunner(loadConfig(env), { fetch, log: quiet });
    const again = await restarted.run(file2);
    assert.equal(again.job.id, first.jobId);
    assert.equal(tools.stats.submits, 2, 'reattached instead of resubmitting');

    // 3. Lost state file: the Idempotency-Key is derived from the request, so Tools replays the same job.
    const lost = createJobRunner(loadConfig(env), { fetch, log: quiet });
    const replay = await lost.submit(file2);
    assert.equal(replay.jobId, first.jobId);
    assert.equal(replay.replayed, true);
    assert.equal(tools.stats.submits, 2);

    // 4. A finished job with nothing newer answers 204: watch() returns at once.
    const t0 = Date.now();
    await lost.watch(first.jobId);
    assert.ok(Date.now() - t0 < 1000);

    // 5. Jobs are owner-scoped: another app gets 404, and a 4xx is not retried in a loop.
    const other = createJobRunner(loadConfig({ ...env, OV_CLIENT_ID: OTHER, OV_CLIENT_SECRET: 'o', OV_JOB_STATE: path.join(dir, 'other.json') }), { fetch, log: quiet });
    await assert.rejects(other.get(first.jobId), (err) => err.status === 404 && err.code === 'tools.job.not_found');
    await assert.rejects(other.watch(first.jobId), (err) => err.status === 404);

    // 6. No grant: Network refuses the token, nothing reaches Tools.
    const before = tools.stats.submits;
    const nogrant = createJobRunner(loadConfig({ ...env, OV_CLIENT_ID: 'app_01JNOGRANT0000000000000000', OV_CLIENT_SECRET: 'n' }), { fetch, log: quiet });
    await assert.rejects(nogrant.submit(path.join(dir, 'photo.png')), (err) => err.code === 'invalid_scope');
    assert.equal(tools.stats.submits, before);

    await tools.close();
    fs.rmSync(dir, { recursive: true, force: true });
    console.log('tool-job: ok');
})().catch((err) => { console.error(err); process.exit(1); });
