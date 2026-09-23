'use strict';
/** Smoke test: client-credentials app token + registry discovery against the SDK's mock platform. */
const assert = require('node:assert/strict');
const http = require('node:http');
const { createMockPlatform } = require('openvibe-sdk/testing');
const { createApp, loadConfig } = require('../server');

const realFetch = globalThis.fetch;
globalThis.fetch = () => { throw new Error('network access in a smoke test'); };


function get(port, path, headers = {}) {
    return new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path, headers }, (res) => {
            let body = '';
            res.on('data', (c) => { body += c; });
            res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
        }).on('error', reject);
    });
}

(async () => {
    const platform = createMockPlatform({
        capabilities: [{ id: 'media.object.upload', owner: 'media', visibility: 'public', status: 'active', description: 'Upload an object into a granted namespace' }],
        contractsVersion: '0.28.0',
    });
    // A sandbox confidential app, as a new project has, with one Media grant and nothing for Tools.
    const devApp = platform.addApp({ env: 'sandbox', grants: ['media.object.upload'] });
    const [APP, SECRET, PRJ] = [devApp.id, devApp.secret, devApp.projectId];
    const logs = [];
    const log = { error: (m) => logs.push(m), log: (m) => logs.push(m) };
    const app = createApp(loadConfig({ OV_CLIENT_ID: APP, OV_CLIENT_SECRET: SECRET, OV_AUDIENCES: 'openvibe.media,openvibe.tools' }), { fetch: platform.fetch, log });
    await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
    const { port } = app.server.address();

    const traceparent = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
    const res = await get(port, '/status', { traceparent });
    assert.equal(res.status, 200);
    const s = res.body;

    // Discovery: origins and the contracts version check.
    assert.equal(s.contracts.version, '0.28.0');
    assert.equal(s.contracts.compatible, true);
    const media = s.services.find((x) => x.id === 'media');
    assert.equal(media.origin, 'https://openvibe.media');

    // The token for openvibe.media carries the approved grant, described by the registry.
    const mediaGrants = s.grants.find((g) => g.audience === 'openvibe.media');
    assert.deepEqual(mediaGrants.capabilities.map((c) => c.id), ['media.object.upload']);
    assert.equal(mediaGrants.capabilities[0].visibility, 'public');
    assert.deepEqual(mediaGrants.namespaces, [PRJ]);
    assert.equal(mediaGrants.project_id, PRJ);
    assert.equal(mediaGrants.env, 'sandbox');
    assert.equal(mediaGrants.subject, `app:${APP}`);
    assert.ok(Date.parse(mediaGrants.expires_at) > Date.now());

    // No grant for openvibe.tools: reported, not thrown.
    const toolsGrants = s.grants.find((g) => g.audience === 'openvibe.tools');
    assert.equal(toolsGrants.refused, 'invalid_scope');
    assert.deepEqual(toolsGrants.capabilities, []);

    // The incoming trace continues on the outbound registry calls.
    const registryCall = platform.stats.requests.find((r) => r.url.includes('/api/v1/registry/services'));
    assert.ok(registryCall.headers.traceparent.startsWith('00-0af7651916cd43dd8448eb211c80319c-'));

    // Tokens are cached per audience: a second /status does not ask Network for a new media token.
    const before = platform.stats.tokenRequests;
    await get(port, '/status');
    assert.equal(platform.stats.tokenRequests - before, 1, 'only the refused audience is asked again');

    // Nothing secret leaves the process.
    assert.ok(!JSON.stringify(s).includes(SECRET));
    assert.ok(!logs.join('\n').includes(SECRET));

    // Health.
    assert.deepEqual((await get(port, '/healthz')).body, { ok: true });

    app.server.close();
    globalThis.fetch = realFetch;
    console.log('node-server-app: ok');
})().catch((err) => { console.error(err); process.exit(1); });
