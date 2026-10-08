#!/usr/bin/env node
'use strict';
/**
 * npm run developer-path:mock: scripts/developer-path.js, step for step, against
 * openvibe-sdk/testing's mock platform instead of the real one. CI runs it on every push. No
 * network: anything that is not the mock fails.
 *
 * The mock platform answers Network's projects API, /oauth/token, discovery, Media and Events at
 * their public origins with real RS256 tokens. It has no account API, so this adds the two routes
 * the flow uses, /api/auth/register and /api/auth/login, as a thin layer: register creates a mock
 * user and returns a Network user token for it; login returns one for an existing user (the mock
 * does not check passwords). It also mints Network's export tokens (the export step, signed by the
 * platform like any app token) and stands in for OpenVibe.Codes' release API (the release step):
 * an app token for openvibe.codes carrying codes.release.manage manages the app's own releases,
 * draft → published → deprecated → revoked, and the public list shows every release but drafts, like Codes.
 * Everything else is the platform mock's own.
 */
const { createMockPlatform } = require('openvibe-sdk/testing');
const { runDeveloperPath, PRODUCTION_NETWORK, PRODUCTION_CODES } = require('./developer-path');

function withAccounts(platform, network = PRODUCTION_NETWORK) {
    const byName = new Map();
    const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    // OpenVibe.Codes' release API, in memory (the token's signature is the platform's; here its claims decide).
    const releases = new Map();
    let n = 0;
    function codes(url, method, init) {
        const m = url.pathname.match(/^\/api\/v1\/(?:apps\/(app_[0-9A-Z]+)\/releases|releases\/([a-z0-9_]+)\/(publish|deprecate|revoke))$/i);
        if (!m) return reply(404, { code: 'route.not_found' });
        const list = (appId) => [...releases.values()].filter((r) => r.app_id === appId && r.status !== 'draft');
        if (m[1] && method === 'GET') return reply(200, { app_id: m[1], releases: list(m[1]) });
        let claims = null;
        try { claims = JSON.parse(Buffer.from(String((init.headers || {}).Authorization || '').replace(/^Bearer /, '').split('.')[1], 'base64url').toString('utf8')); } catch { claims = null; }
        if (!claims) return reply(401, { code: 'auth.required' });
        if (!(claims.aud || []).includes('openvibe.codes') || !(claims.cap || []).includes('codes.release.manage')) return reply(403, { code: 'capability.denied' });
        const body = JSON.parse(init.body || '{}');
        if (m[1]) {
            if (claims.sub !== `app:${m[1]}` || !body.manifest || body.manifest.id !== m[1]) return reply(403, { code: 'release.forbidden' });
            const rel = { id: `rel_mock${++n}`, app_id: m[1], version: body.manifest.version, status: body.publish ? 'published' : 'draft' };
            releases.set(rel.id, rel);
            return reply(201, { release: rel, warnings: [] });
        }
        const rel = releases.get(m[2]);
        if (!rel || claims.sub !== `app:${rel.app_id}`) return reply(404, { code: 'release.not_found' });
        const next = { publish: ['draft', 'published'], deprecate: ['published', 'deprecated'], revoke: [null, 'revoked'] }[m[3]];
        if (next[0] && rel.status !== next[0]) return reply(409, { code: 'release.invalid_state' });
        rel.status = next[1];
        return reply(200, { release: rel });
    }

    return async (input, init = {}) => {
        const url = new URL(typeof input === 'string' ? input : input.url);
        const method = (init.method || (typeof input === 'string' ? 'GET' : input.method) || 'GET').toUpperCase();
        if (url.origin === network && method === 'POST' && (url.pathname === '/api/auth/register' || url.pathname === '/api/auth/login')) {
            const body = JSON.parse(init.body || '{}');
            const username = String(body.username || '');
            if (!username || !body.password) return reply(400, { error: 'Username and password required' });
            if (url.pathname === '/api/auth/register') {
                if (byName.has(username.toLowerCase())) return reply(409, { error: 'Username already taken' });
                const user = platform.addUser({ username });
                byName.set(username.toLowerCase(), user);
                return reply(201, { token: platform.signUserToken(user), user: { username, subject_id: user.subject_id } });
            }
            const user = byName.get(username.toLowerCase());
            return user ? reply(200, { token: platform.signUserToken(user) }) : reply(401, { error: 'Invalid credentials' });
        }
        // Network's export tokens (WS-N task 9): read-only app-shaped tokens for the project's owner, as Network mints them.
        const ex = url.origin === network && method === 'POST' && url.pathname.match(/^\/api\/v1\/projects\/(prj_[0-9A-Z]+)\/export-tokens$/i);
        if (ex) {
            const body = JSON.parse(init.body || '{}');
            const caps = { 'openvibe.media': ['media.object.list', 'media.object.read'], 'openvibe.events': ['events.app.read'] }[body.audience];
            if (!caps) return reply(422, { code: 'export.invalid_audience' });
            const token = platform.signAppToken(`app_${ex[1].slice(4)}`, { audience: body.audience, capabilities: caps, projectId: ex[1], env: body.env || 'production' });
            return reply(201, { access_token: token, token_type: 'Bearer', expires_in: 300, scope: caps.join(' ') });
        }
        if (url.origin === PRODUCTION_CODES) return codes(url, method, init);
        return platform.fetch(input, init);
    };
}

/** → { result, platform, output }. platformOptions go to createMockPlatform (tests use them to break a step). */
async function runAgainstMock({ log, platformOptions = {} } = {}) {
    const platform = createMockPlatform(platformOptions);
    const lines = [];
    const result = await runDeveloperPath({
        network: PRODUCTION_NETWORK,
        fetch: withAccounts(platform),
        account: { username: 'developer_path', password: 'mock-password-not-checked', register: true },
        log: (m) => { lines.push(m); if (log) log(m); },
    });
    return { result, platform, output: lines.join('\n') };
}

module.exports = { runAgainstMock, withAccounts };

if (require.main === module) {
    // CI has no network: anything that is not the mock platform fails loudly.
    globalThis.fetch = () => { throw new Error('network access in the mock developer path'); };
    console.log('OpenVibe developer path against openvibe-sdk/testing\'s mock platform\n');
    runAgainstMock({ log: (m) => console.log(m) }).then(({ result }) => { process.exitCode = result.ok ? 0 : 1; }, (err) => { console.error(err); process.exitCode = 1; });
}
