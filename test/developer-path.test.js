'use strict';
/**
 * The developer path (scripts/developer-path.js) against openvibe-sdk/testing's mock platform:
 * every step passes, it leaves nothing behind (file deleted, credential revoked, project archived),
 * it never writes a secret or a token, a failed step skips the rest but still archives the project,
 * and the real-platform CLI refuses to start without credentials or in CI against production.
 */
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { runAgainstMock } = require('../scripts/developer-path-mock');
const { STEPS } = require('../scripts/developer-path');

globalThis.fetch = () => { throw new Error('network access in a test'); };
const CLI = path.join(__dirname, '..', 'scripts', 'developer-path.js');

(async () => {
    // 1. The whole path passes on the mock platform.
    const { result, platform, output } = await runAgainstMock();
    assert.equal(result.ok, true, output);
    assert.deepEqual(result.steps.map((s) => [s.name, s.ok]), STEPS.map((n) => [n, true]));
    assert.match(result.projectId, /^prj_/);
    assert.match(result.appId, /^app_/);

    // 2. Nothing is left behind.
    assert.equal([...platform.state.files.keys()].filter((k) => k.startsWith(result.projectId)).length, 0, 'the uploaded file was deleted');
    const project = platform.state.projects.get(result.projectId);
    assert.ok(project.archived_at, 'the project is archived');
    const app = platform.state.apps.get(result.appId);
    assert.ok(app.revoked_at, 'archiving revoked the app');
    assert.equal(app.credentials.length, 2, 'the original credential and the rotated one');
    assert.ok(app.credentials[0].revoked_at, 'the first credential was revoked');

    // 3. No secret or token in the output. The app's secrets are only in the mock's state.
    for (const s of app.credentials.map((c) => c.secret)) assert.ok(!output.includes(s), 'a client secret was printed');
    assert.ok(!/eyJ[\w-]{8,}\.[\w-]{8,}\./.test(output), 'a token was printed');
    assert.ok(!output.includes('mock-password-not-checked'), 'the password was printed');
    assert.match(output, /url=https:\/\/openvibe\.media\/f\/\S+ \(signed\)/, 'signed URLs without the signature');

    // 4. A failing step (no grants approved: an empty allowance) skips the rest but still cleans up.
    const broken = await runAgainstMock({ platformOptions: { defaultAllowance: [] } });
    assert.equal(broken.result.ok, false);
    const byName = Object.fromEntries(broken.result.steps.map((s) => [s.name, s]));
    assert.equal(byName.grants.ok, false);
    assert.match(byName.grants.error, /not approved: media\.object\.upload/);
    for (const n of ['media', 'events', 'credentials']) assert.equal(byName[n].skipped, true, `${n} skipped`);
    assert.equal(byName.cleanup.ok, true, 'cleanup still ran');
    assert.match(broken.output, /archived prj_/);

    // 5. The real-platform CLI refuses (exit 2, nothing sent) without credentials, and in CI
    //    against the production Network even with them.
    const run = (env, args = []) => spawnSync(process.execPath, [CLI, ...args], { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8', timeout: 20000 });
    const none = run({});
    assert.equal(none.status, 2, none.stderr);
    assert.match(none.stderr, /missing OV_E2E_USERNAME and OV_E2E_PASSWORD, or OV_USER_TOKEN\. Nothing was sent\./);
    const reg = run({ OV_USER_TOKEN: 'x' }, ['--register']);
    assert.equal(reg.status, 2, 'registering needs a username and password');
    const ci = run({ CI: 'true', OV_E2E_USERNAME: 'someone', OV_E2E_PASSWORD: 'secret-value' });
    assert.equal(ci.status, 2);
    assert.match(ci.stderr, /refusing to run against the production Network in CI/);
    const ciExplicit = run({ CI: 'true', OV_NETWORK_URL: 'https://openvibe.network/', OV_USER_TOKEN: 'x' });
    assert.equal(ciExplicit.status, 2, 'also with OV_NETWORK_URL set to production');

    console.log('developer-path: ok');
})().catch((err) => { console.error(err); process.exit(1); });
