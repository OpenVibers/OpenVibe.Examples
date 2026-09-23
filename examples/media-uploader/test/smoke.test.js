'use strict';
/**
 * Smoke test: the uploader against openvibe-sdk/testing's mock platform (fake Network + Media at
 * their public origins, real RS256 tokens, audience/capability/namespace/sandbox checks), with a
 * sandbox app as a new project has. No network.
 *
 * Not covered here: --get and --delete. The SDK 0.3.0 mock's Media accepts app tokens on upload
 * only (reads need its app API key), while the real Media accepts media.object.read for reads;
 * `npm run e2e` exercises them against the platform.
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMockPlatform } = require('openvibe-sdk/testing');
const { createUploader, describe, explain, loadConfig } = require('../upload');

// CI has no network: anything that is not the mock platform fails loudly.
globalThis.fetch = () => { throw new Error('network access in a smoke test'); };

(async () => {
    // Media accepts sandbox app tokens on the project's own tenant.
    const platform = createMockPlatform({ acceptSandbox: ['openvibe.media'] });
    const app = platform.addApp({ env: 'sandbox', grants: ['media.object.upload', 'media.object.read'] });
    const other = platform.addApp({ env: 'sandbox', grants: ['media.object.upload'] });
    const noGrant = platform.addApp({ env: 'sandbox', grants: ['tools.job.read'] });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-'));
    const file = path.join(dir, 'hello.txt');
    fs.writeFileSync(file, 'hello from an OpenVibe example\n');

    const env = { OV_CLIENT_ID: app.id, OV_CLIENT_SECRET: app.secret };

    // 1. Upload: token for openvibe.media with only media.object.upload, Media origin from
    //    discovery, the project id from the token, the file stored in the project's tenant.
    const uploader = createUploader(loadConfig(env), { fetch: platform.fetch });
    const out = await uploader.upload(file);
    assert.match(out.key, /^[0-9a-f]{12}-hello\.txt$/);
    assert.equal(out.project_id, app.projectId);
    assert.equal(out.url, `https://openvibe.media/f/${out.key}`);
    assert.equal(out.mime, 'text/plain');
    assert.equal(out.sha256, crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
    assert.ok(platform.state.files.has(`${app.projectId}|${out.key}`), 'stored under the project id');

    // The upload carried a short-lived Network token scoped to the one capability, and a trace.
    const call = platform.stats.requests.find((r) => r.url === `https://openvibe.media/api/v1/${app.projectId}/files`);
    assert.ok(call, 'Media was called at the discovered origin');
    assert.match(call.headers.authorization, /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    assert.match(call.headers.traceparent, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    const claims = JSON.parse(Buffer.from(call.headers.authorization.split('.')[1], 'base64url'));
    assert.deepEqual(claims.cap, ['media.object.upload']);
    assert.equal(claims.env, 'sandbox');

    // 2. Same bytes again: content-addressed, deduplicated, safe to retry.
    const again = await uploader.upload(file);
    assert.equal(again.key, out.key);
    assert.equal(again.deduplicated, true);

    // 3. Another project's tenant is refused by Media (the token's ns is this project only).
    const wrong = createUploader(loadConfig({ ...env, OV_PROJECT_ID: other.projectId }), { fetch: platform.fetch });
    await assert.rejects(wrong.upload(file), (err) => err.status === 403 && err.code === 'capability.namespace_denied' && /OV_PROJECT_ID/.test(explain(err)));

    // 4. No grant: Network issues no token for the capability.
    const nope = createUploader(loadConfig({ OV_CLIENT_ID: noGrant.id, OV_CLIENT_SECRET: noGrant.secret }), { fetch: platform.fetch });
    await assert.rejects(nope.upload(file), (err) => err.code === 'invalid_scope' && /Request it/.test(explain(err)));

    // 5. Wrong secret: invalid_client, and the secret never appears in the explanation.
    const badSecret = createUploader(loadConfig({ ...env, OV_CLIENT_SECRET: 'wrong-secret-value' }), { fetch: platform.fetch });
    await assert.rejects(badSecret.upload(file), (err) => err.code === 'invalid_client' && !explain(err).includes('wrong-secret-value'));

    // 6. Missing configuration names the variables, never their values.
    assert.throws(() => loadConfig({ OV_CLIENT_SECRET: app.secret }), (err) => err.code === 'config.missing' && /OV_CLIENT_ID/.test(err.message) && !err.message.includes(app.secret));

    // 7. A sandbox upload as the real Media answers it: signed, expiring URL, never a public one.
    const sandboxFile = describe({
        key: 'a1b2c3d4e5f6-hello.txt', url: 'https://openvibe.media/f/a1b2c3d4e5f6-hello.txt?exp=1790000000&sig=abc',
        public_url: 'https://openvibe.media/f/a1b2c3d4e5f6-hello.txt?exp=1790000000&sig=abc', url_expires_at: '2026-09-23T12:00:00Z',
        sandbox: true, size: 31, mime: 'text/plain', sha256: 'x',
    });
    assert.equal(sandboxFile.sandbox, true);
    assert.match(sandboxFile.url, /\?exp=\d+&sig=/);
    assert.equal(sandboxFile.url_expires_at, '2026-09-23T12:00:00Z');

    fs.rmSync(dir, { recursive: true, force: true });
    console.log('media-uploader: ok');
})().catch((err) => { console.error(err); process.exit(1); });
