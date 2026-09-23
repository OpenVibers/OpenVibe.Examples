'use strict';
/**
 * Smoke test: the uploader against openvibe-sdk/testing's mock platform (fake Network + Media at
 * their public origins, real RS256 tokens, audience/capability/namespace checks). No network.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMockPlatform } = require('openvibe-sdk/testing');
const { createUploader, explain, loadConfig } = require('../upload');

// CI has no network: anything that is not the mock platform fails loudly.
globalThis.fetch = () => { throw new Error('network access in a smoke test'); };

const APP = 'app_01JEXAMPLEMEDIA0000000000';
const PRJ = 'prj_01JEXAMPLEPROJECT00000000';
const OTHER = 'prj_01JSOMEONEELSE00000000000';
const SECRET = 'ovsec_media_uploader_test_secret';

(async () => {
    const platform = createMockPlatform({
        clients: {
            [APP]: { secret: SECRET, grants: [{ capability: 'media.object.upload', audience: 'openvibe.media', namespaces: [PRJ] }] },
            app_01JNOGRANTS000000000000000: { secret: 'x', grants: [] },
        },
        mediaApps: { [PRJ]: {}, [OTHER]: {} },
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-media-'));
    const file = path.join(dir, 'hello.txt');
    fs.writeFileSync(file, 'hello from an OpenVibe example\n');

    const env = { OV_CLIENT_ID: APP, OV_CLIENT_SECRET: SECRET, OV_MEDIA_NAMESPACE: PRJ };

    // 1. Upload: token for openvibe.media, Media origin from discovery, file stored in the project namespace.
    const uploader = createUploader(loadConfig(env), { fetch: platform.fetch });
    const out = await uploader.upload(file);
    assert.match(out.key, /^[0-9a-f]{12}-hello\.txt$/);
    assert.equal(out.public_url, `https://openvibe.media/f/${out.key}`);
    assert.equal(out.mime, 'text/plain');
    assert.equal(out.sha256, require('node:crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
    assert.ok(platform.state.files.has(`${PRJ}|${out.key}`), 'stored under the project namespace');

    // The upload carried a short-lived Network token (not an API key) and a trace.
    const call = platform.stats.requests.find((r) => r.url === `https://openvibe.media/api/v1/${PRJ}/files`);
    assert.ok(call, 'Media was called at the discovered origin');
    assert.match(call.headers.authorization, /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    assert.match(call.headers.traceparent, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    const token = platform.stats.requests.find((r) => r.url.endsWith('/oauth/token'));
    assert.ok(token);

    // 2. Same bytes again: content-addressed, deduplicated, safe to retry.
    const again = await uploader.upload(file);
    assert.equal(again.key, out.key);
    assert.equal(again.deduplicated, true);

    // 3. Another project's namespace is refused by Media (the token's ns is this project only).
    const wrongNs = createUploader(loadConfig({ ...env, OV_MEDIA_NAMESPACE: OTHER }), { fetch: platform.fetch });
    await assert.rejects(wrongNs.upload(file), (err) => err.status === 403 && err.code === 'capability.namespace_denied');

    // 4. No grant: Network issues no token for the audience.
    const noGrant = createUploader(loadConfig({ ...env, OV_CLIENT_ID: 'app_01JNOGRANTS000000000000000', OV_CLIENT_SECRET: 'x' }), { fetch: platform.fetch });
    await assert.rejects(noGrant.upload(file), (err) => err.code === 'invalid_scope' && /request it/i.test(explain(err)));

    // 5. Wrong secret: invalid_client, and the secret never appears in the explanation.
    const badSecret = createUploader(loadConfig({ ...env, OV_CLIENT_SECRET: 'wrong-secret-value' }), { fetch: platform.fetch });
    await assert.rejects(badSecret.upload(file), (err) => err.code === 'invalid_client' && !explain(err).includes('wrong-secret-value'));

    // 6. Missing configuration names the variables, never their values.
    assert.throws(() => loadConfig({ OV_CLIENT_SECRET: SECRET }), (err) => err.code === 'config.missing' && /OV_CLIENT_ID/.test(err.message) && !err.message.includes(SECRET));

    fs.rmSync(dir, { recursive: true, force: true });
    console.log('media-uploader: ok');
})().catch((err) => { console.error(err); process.exit(1); });
