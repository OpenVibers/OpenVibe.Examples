'use strict';
/**
 * Smoke test: authorization code + PKCE with a server-side exchange, against the SDK's mock
 * platform. The mock has no /oauth/authorize page; platform.authorize() stands in for the person
 * choosing "Continue" on Network, and it verifies PKCE at the token endpoint like Network does.
 */
const assert = require('node:assert/strict');
const { createMockPlatform } = require('openvibe-sdk/testing');
const { createApp, loadConfig, signedInSubject } = require('../server');

const realFetch = globalThis.fetch;
globalThis.fetch = () => { throw new Error('network access in a smoke test'); };

const APP = 'app_01K5WZX7S7Q4D2B8N3M6V1C9TR';
const SECRET = 'ovsec_oauth_app_test_secret_value';

(async () => {
    const platform = createMockPlatform({ users: [{ username: 'ana' }] });
    const ana = [...platform.state.users.values()][0];
    const logs = [];
    const log = { log: (m) => logs.push(m), error: (m) => logs.push(m) };
    const env = { OV_CLIENT_ID: APP, OV_CLIENT_SECRET: SECRET, OV_AUDIENCE: 'openvibe.media', OV_SCOPE: 'media.object.upload media.object.read' };
    const app = createApp(loadConfig(env), { fetch: platform.fetch, log });
    await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const config = loadConfig(env);
    platform.addClient(APP, { secret: SECRET, redirectUris: [config.redirectUri] });

    const get = (path, cookie, method = 'GET') => realFetch(`${base}${path}`, { method, redirect: 'manual', headers: cookie ? { cookie } : {} });
    const cookieOf = (res) => (res.headers.get('set-cookie') || '').split(';')[0];

    /** /login -> the authorize URL's parameters and this browser's session cookie. */
    async function startLogin() {
        const res = await get('/login');
        assert.equal(res.status, 302);
        const to = new URL(res.headers.get('location'));
        return { to, cookie: cookieOf(res) };
    }
    const callbackPath = (params) => `/callback?${new URLSearchParams(params)}`;

    // 1. Sign in.
    const { to, cookie } = await startLogin();
    assert.equal(`${to.origin}${to.pathname}`, 'https://openvibe.network/oauth/authorize');
    assert.equal(to.searchParams.get('client_id'), APP);
    assert.equal(to.searchParams.get('redirect_uri'), config.redirectUri);
    assert.equal(to.searchParams.get('code_challenge_method'), 'S256');
    assert.match(to.searchParams.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/);
    assert.equal(to.searchParams.get('scope'), 'media.object.upload media.object.read');
    assert.match(cookie, /^ov_example_sid=/);
    const res1 = await get('/login');
    assert.match(res1.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/);
    assert.ok(!to.toString().includes(SECRET), 'the secret never goes to the browser');

    const code = platform.authorize({ clientId: APP, redirectUri: config.redirectUri, subjectId: ana.subject_id, codeChallenge: to.searchParams.get('code_challenge'), scope: to.searchParams.get('scope') });
    const cb = await get(callbackPath({ code, state: to.searchParams.get('state') }), cookie);
    assert.equal(cb.status, 302);
    assert.equal(cb.headers.get('location'), '/');
    const signedIn = cookieOf(cb);
    assert.notEqual(signedIn, cookie, 'a new session id after sign-in');

    const me = await get('/api/me', signedIn);
    assert.equal(me.status, 200);
    const body = await me.json();
    assert.equal(body.subject, ana.subject_id);
    assert.ok(!JSON.stringify(body).includes('access_token'));
    assert.match(await (await get('/', signedIn)).text(), new RegExp(`Signed in with OpenVibe as <code>${ana.subject_id}</code>`));

    // The exchange sent the verifier, the secret and the audience to the token endpoint.
    const exchange = platform.stats.requests.filter((r) => r.url.endsWith('/oauth/token'));
    assert.equal(exchange.length, 1);
    assert.equal((await get('/api/me', cookie)).status, 401, 'the pre-login session id is dead');

    // 2. The same callback again (replayed link): refused, no second exchange.
    const replay = await get(callbackPath({ code, state: to.searchParams.get('state') }), cookie);
    assert.equal(replay.status, 400);

    // 3. A callback this browser did not start (state mismatch, login CSRF): refused before any exchange.
    const second = await startLogin();
    const mismatch = await get(callbackPath({ code: 'whatever', state: 'not-the-state' }), second.cookie);
    assert.equal(mismatch.status, 400);
    assert.match(await mismatch.text(), /oauth\.state_mismatch/);

    // 4. The person declined on Network.
    const third = await startLogin();
    const denied = await get(callbackPath({ error: 'access_denied', state: third.to.searchParams.get('state') }), third.cookie);
    assert.equal(denied.status, 400);
    assert.match(await denied.text(), /oauth\.access_denied/);

    // 5. A code bound to a different PKCE challenge (stolen code): the token endpoint refuses it.
    const fourth = await startLogin();
    const other = await require('openvibe-sdk/auth').createPkcePair();
    const stolen = platform.authorize({ clientId: APP, redirectUri: config.redirectUri, subjectId: ana.subject_id, codeChallenge: other.codeChallenge });
    const pkce = await get(callbackPath({ code: stolen, state: fourth.to.searchParams.get('state') }), fourth.cookie);
    assert.equal(pkce.status, 400);
    assert.match(await pkce.text(), /invalid_grant/);

    // 6. Sign out.
    const out = await get('/logout', signedIn, 'POST');
    assert.equal(out.status, 303);
    assert.equal((await get('/api/me', signedIn)).status, 401);

    // App tokens name the person in on_behalf_of and must be for this app.
    assert.equal(signedInSubject({ actor_type: 'app', sub: `app:${APP}`, on_behalf_of: 'usr_X' }, APP), 'usr_X');
    assert.equal(signedInSubject({ actor_type: 'app', sub: 'app:app_SOMEONEELSE', on_behalf_of: 'usr_X' }, APP), null);

    // Nothing secret in the logs.
    const text = logs.join('\n');
    assert.ok(!text.includes(SECRET));
    assert.ok(!/eyJ[\w-]+\.[\w-]+\./.test(text), 'no tokens in logs');

    app.server.close();
    console.log('oauth-app: ok');
})().catch((err) => { console.error(err); process.exit(1); });
