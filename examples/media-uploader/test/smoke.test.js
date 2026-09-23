'use strict';
/**
 * Smoke test: the uploader against openvibe-sdk/testing's mock platform (fake Network + Media at
 * their public origins, real RS256 tokens, Media's tenant rules: the project id addresses the
 * tenant, the token's env picks `prj_…` or `prj_…-sandbox`, upload/delete need media.object.upload
 * and reads media.object.read), with a sandbox app as a new project has. No network.
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMockPlatform } = require('openvibe-sdk/testing');
const { createUploader, explain, loadConfig } = require('../upload');

// CI has no network: anything that is not the mock platform fails loudly.
globalThis.fetch = () => { throw new Error('network access in a smoke test'); };

(async () => {
    const platform = createMockPlatform();
    const app = platform.addApp({ env: 'sandbox', grants: ['media.object.upload', 'media.object.read'] });
    const uploadOnly = platform.addApp({ env: 'sandbox', project: app.projectId, grants: ['media.object.upload'] });
    const other = platform.addApp({ env: 'sandbox', grants: ['media.object.upload'] });
    const noGrant = platform.addApp({ env: 'sandbox', grants: ['tools.job.read'] });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-'));
    const file = path.join(dir, 'hello.txt');
    fs.writeFileSync(file, 'hello from an OpenVibe example\n');

    const env = { OV_CLIENT_ID: app.id, OV_CLIENT_SECRET: app.secret };

    // 1. Upload: token for openvibe.media with only media.object.upload, Media origin from
    //    discovery, the project id from the token, the file stored in the project's sandbox tenant.
    const uploader = createUploader(loadConfig(env), { fetch: platform.fetch });
    const out = await uploader.upload(file);
    assert.match(out.key, /^[0-9a-f]{12}-[0-9a-f]{8}-hello\.txt$/);
    assert.equal(out.project_id, app.projectId);
    assert.equal(out.mime, 'text/plain');
    assert.equal(out.sha256, crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
    assert.ok(platform.state.files.has(`${app.projectId}-sandbox|${out.key}`), 'stored in the project\'s sandbox tenant');

    // Sandbox files are never public: a signed, expiring URL, which the mock (like Media) serves.
    assert.equal(out.sandbox, true);
    assert.match(out.url, new RegExp(`^https://openvibe\\.media/f/${out.key}\\?exp=\\d+&sig=`));
    assert.ok(Date.parse(out.url_expires_at) > Date.now());
    const signed = await platform.fetch(out.url);
    assert.equal(signed.status, 200);
    assert.equal(await signed.text(), fs.readFileSync(file, 'utf8'));
    assert.equal((await platform.fetch(`https://openvibe.media/f/${out.key}`)).status, 404, 'not without the signature');

    // The upload carried a short-lived Network token scoped to the one capability, and a trace.
    const call = platform.stats.requests.find((r) => r.url === `https://openvibe.media/api/v1/${app.projectId}/files`);
    assert.ok(call, 'Media was called at the discovered origin, addressed by the project id');
    assert.match(call.headers.traceparent, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    const claims = JSON.parse(Buffer.from(call.headers.authorization.split('.')[1], 'base64url'));
    assert.deepEqual(claims.cap, ['media.object.upload']);
    assert.equal(claims.env, 'sandbox');

    // 2. Same bytes again: content-addressed, deduplicated, safe to retry.
    const again = await uploader.upload(file);
    assert.equal(again.key, out.key);
    assert.equal(again.deduplicated, true);

    // 3. Read it back (media.object.read), with a fresh signed URL; delete it (media.object.upload).
    const meta = await uploader.get(out.key);
    assert.equal(meta.sha256, out.sha256);
    assert.equal(meta.sandbox, true);
    assert.match(meta.url, /\?exp=\d+&sig=/);
    const readCall = platform.stats.requests.filter((r) => r.url.startsWith(`https://openvibe.media/api/v1/${app.projectId}/files/`)).at(-1);
    assert.deepEqual(JSON.parse(Buffer.from(readCall.headers.authorization.split('.')[1], 'base64url')).cap, ['media.object.read']);
    // Without media.object.read, Network issues no token for the read.
    const cannotRead = createUploader(loadConfig({ OV_CLIENT_ID: uploadOnly.id, OV_CLIENT_SECRET: uploadOnly.secret }), { fetch: platform.fetch });
    await assert.rejects(cannotRead.get(out.key), (err) => err.code === 'invalid_scope');
    assert.equal(await uploader.remove(out.key), true);
    assert.equal(await uploader.get(out.key), null);
    assert.equal(await uploader.remove(out.key), false, 'nothing left to delete');

    // 4. Another project's tenant is refused by Media (the token's project decides).
    const wrong = createUploader(loadConfig({ ...env, OV_PROJECT_ID: other.projectId }), { fetch: platform.fetch });
    await assert.rejects(wrong.upload(file), (err) => err.status === 403 && err.code === 'capability.namespace_denied' && /OV_PROJECT_ID/.test(explain(err)));

    // 5. No grant: Network issues no token for the capability.
    const nope = createUploader(loadConfig({ OV_CLIENT_ID: noGrant.id, OV_CLIENT_SECRET: noGrant.secret }), { fetch: platform.fetch });
    await assert.rejects(nope.upload(file), (err) => err.code === 'invalid_scope' && /Request it/.test(explain(err)));

    // 6. Wrong secret: invalid_client, and the secret never appears in the explanation.
    const badSecret = createUploader(loadConfig({ ...env, OV_CLIENT_SECRET: 'wrong-secret-value' }), { fetch: platform.fetch });
    await assert.rejects(badSecret.upload(file), (err) => err.code === 'invalid_client' && !explain(err).includes('wrong-secret-value'));

    // 7. Missing configuration names the variables, never their values.
    assert.throws(() => loadConfig({ OV_CLIENT_SECRET: app.secret }), (err) => err.code === 'config.missing' && /OV_CLIENT_ID/.test(err.message) && !err.message.includes(app.secret));

    fs.rmSync(dir, { recursive: true, force: true });
    console.log('media-uploader: ok');
})().catch((err) => { console.error(err); process.exit(1); });
