'use strict';
/**
 * Smoke test: authorization code + PKCE with a server-side exchange, against the SDK's mock
 * platform. Its GET /oauth/authorize plays Network's account chooser (it continues, or declines,
 * as platform.setAuthorization() says) and its token endpoint checks PKCE, the audience the code
 * was bound to, and that a sandbox app is authorized by a member of its project.
 */
const assert = require('node:assert/strict');
const { createMockPlatform } = require('openvibe-sdk/testing');
const { createPkcePair } = require('openvibe-sdk/auth');
const { createApp, loadConfig, signedInSubject } = require('../server');

const realFetch = globalThis.fetch;
globalThis.fetch = () => { throw new Error('network access in a smoke test'); };

(async () => {
    const platform = createMockPlatform({ users: [{ username: 'ana' }, { username: 'bo' }] });
    const [ana, bo] = [...platform.state.users.values()];
    // ana owns the project; its sandbox app may only be authorized by members.
    const project = platform.addProject({ owner: ana.subject_id, environmentPolicy: 'sandbox' });
    const redirectUri = 'http://localhost:3009/callback';
    const app = platform.addApp({ project, env: 'sandbox', type: 'confidential', redirectUris: [redirectUri], grants: ['media.object.upload', 'media.object.read'] });
    const SECRET = app.secret;

    const logs = [];
    const log = { log: (m) => logs.push(m), error: (m) => logs.push(m) };
    const env = { OV_CLIENT_ID: app.id, OV_CLIENT_SECRET: SECRET, OV_AUDIENCE: 'openvibe.media', OV_SCOPE: 'media.object.read', OV_REDIRECT_URI: redirectUri };
    const config = loadConfig(env);
    const server = createApp(config, { fetch: platform.fetch, log });
    await new Promise((r) => server.server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.server.address().port}`;

    const get = (path, cookie, method = 'GET') => realFetch(`${base}${path}`, { method, redirect: 'manual', headers: cookie ? { cookie } : {} });
    const cookieOf = (res) => (res.headers.get('set-cookie') || '').split(';')[0];

    /** /login -> the authorize URL and this browser's session cookie. */
    async function startLogin() {
        const res = await get('/login');
        assert.equal(res.status, 302);
        return { to: new URL(res.headers.get('location')), cookie: cookieOf(res) };
    }
    /** The browser at Network: the account chooser answers with a redirect back to the app. */
    async function atNetwork(to) {
        const res = await platform.fetch(to.toString(), { redirect: 'manual' });
        assert.equal(res.status, 302);
        const back = new URL(res.headers.get('location'));
        assert.equal(`${back.origin}${back.pathname}`, redirectUri);
        return `${back.pathname}${back.search}`;
    }

    // 1. Sign in as ana (a project member).
    platform.setAuthorization({ subjectId: ana.subject_id });
    const { to, cookie } = await startLogin();
    assert.equal(`${to.origin}${to.pathname}`, 'https://openvibe.network/oauth/authorize');
    assert.equal(to.searchParams.get('client_id'), app.id);
    assert.equal(to.searchParams.get('redirect_uri'), redirectUri);
    assert.equal(to.searchParams.get('code_challenge_method'), 'S256');
    assert.match(to.searchParams.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/);
    assert.equal(to.searchParams.get('audience'), 'openvibe.media');
    assert.equal(to.searchParams.get('scope'), 'media.object.read', 'capability ids, not "profile theme"');
    assert.match(cookie, /^ov_example_sid=/);
    assert.ok(!to.toString().includes(SECRET), 'the secret never goes to the browser');
    const res1 = await get('/login');
    assert.match(res1.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/);

    const callbackPath = await atNetwork(to);
    const cb = await get(callbackPath, cookie);
    assert.equal(cb.status, 302);
    assert.equal(cb.headers.get('location'), '/');
    const signedIn = cookieOf(cb);
    assert.notEqual(signedIn, cookie, 'a new session id after sign-in');

    const me = await get('/api/me', signedIn);
    assert.equal(me.status, 200);
    const body = await me.json();
    assert.equal(body.subject, ana.subject_id);
    assert.equal(body.app, `app:${app.id}`);
    assert.equal(body.project_id, project);
    assert.equal(body.env, 'sandbox');
    assert.deepEqual(body.capabilities, ['media.object.read'], 'only what was asked for, not everything the app holds');
    assert.ok(!JSON.stringify(body).includes('access_token'));
    assert.match(await (await get('/', signedIn)).text(), new RegExp(`Signed in with OpenVibe as <code>${ana.subject_id}</code>`));

    // The exchange sent the verifier, the secret and the audience to the token endpoint, once.
    assert.equal(platform.stats.requests.filter((r) => r.url.endsWith('/oauth/token')).length, 1);
    assert.equal((await get('/api/me', cookie)).status, 401, 'the pre-login session id is dead');

    // 2. The same callback again (replayed link): refused, no second exchange.
    const replay = await get(callbackPath, cookie);
    assert.equal(replay.status, 400);

    // 3. A callback this browser did not start (state mismatch, login CSRF): refused before any exchange.
    const second = await startLogin();
    const mismatch = await get(`/callback?${new URLSearchParams({ code: 'whatever', state: 'not-the-state' })}`, second.cookie);
    assert.equal(mismatch.status, 400);
    assert.match(await mismatch.text(), /oauth\.state_mismatch/);

    // 4. The person declined on Network.
    platform.setAuthorization({ decision: 'deny' });
    const third = await startLogin();
    const denied = await get(await atNetwork(third.to), third.cookie);
    assert.equal(denied.status, 400);
    assert.match(await denied.text(), /oauth\.access_denied/);
    platform.setAuthorization({ decision: 'allow' });

    // 5. Someone who is not a member of the project cannot authorize its sandbox app.
    platform.setAuthorization({ subjectId: bo.subject_id });
    const fourth = await startLogin();
    const outsider = await get(await atNetwork(fourth.to), fourth.cookie);
    assert.equal(outsider.status, 400);
    assert.match(await outsider.text(), /oauth\.access_denied/);
    platform.setAuthorization({ subjectId: ana.subject_id });

    // 6. A code bound to a different PKCE challenge (stolen code): the token endpoint refuses it.
    const fifth = await startLogin();
    const other = await createPkcePair();
    const stolen = platform.authorize({ clientId: app.id, redirectUri, subjectId: ana.subject_id, codeChallenge: other.codeChallenge, audience: 'openvibe.media', scope: 'media.object.read' });
    const pkce = await get(`/callback?${new URLSearchParams({ code: stolen, state: fifth.to.searchParams.get('state') })}`, fifth.cookie);
    assert.equal(pkce.status, 400);
    assert.match(await pkce.text(), /invalid_grant/);

    // 7. Sign out.
    const out = await get('/logout', signedIn, 'POST');
    assert.equal(out.status, 303);
    assert.equal((await get('/api/me', signedIn)).status, 401);

    // App tokens name the person in on_behalf_of and must be for this app.
    assert.equal(signedInSubject({ actor_type: 'app', sub: `app:${app.id}`, on_behalf_of: 'usr_X' }, app.id), 'usr_X');
    assert.equal(signedInSubject({ actor_type: 'app', sub: 'app:app_SOMEONEELSE', on_behalf_of: 'usr_X' }, app.id), null);

    // Nothing secret in the logs.
    const text = logs.join('\n');
    assert.ok(!text.includes(SECRET));
    assert.ok(!/eyJ[\w-]+\.[\w-]+\./.test(text), 'no tokens in logs');

    server.server.close();
    console.log('oauth-app: ok');
})().catch((err) => { console.error(err); process.exit(1); });
