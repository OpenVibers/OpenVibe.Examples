'use strict';
/**
 * Smoke test: the page's own script (public/app.js) and the served SDK bundle run in a small fake
 * browser (a vm context with a minimal DOM, sessionStorage, location, a cookie jar and fetch),
 * against this app's server and the SDK's mock platform. Covers: sign-in button -> authorize URL
 * with PKCE, the callback -> exchange -> signed-in session, the registry read from the page, and
 * the fallback through the app's server when the browser refuses the cross-origin call.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createMockPlatform } = require('openvibe-sdk/testing');
const { createApp, loadConfig } = require('../server');

const realFetch = globalThis.fetch;
globalThis.fetch = () => { throw new Error('network access in a smoke test'); };

const APP = 'app_01K5WZX7S7Q4D2B8N3M6V1C9TA';

async function waitFor(check, what, ms = 3000) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
        if (check()) return;
        await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`timed out waiting for ${what}`);
}

/** A tiny browser: enough DOM for app.js, and fetch that talks to the app server or the mock. */
function createBrowser({ base, origin, platform, sessionStorage, jar, crossOrigin = 'allow' }) {
    const elements = new Map();
    const el = (id) => {
        if (!elements.has(id)) {
            const node = {
                id, hidden: false, children: [], listeners: {}, _text: '',
                get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); },
                set textContent(v) { this._text = String(v); this.children = []; },
                appendChild(c) { this.children.push(c); return c; },
                addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
                click() { for (const fn of this.listeners.click || []) fn({}); },
            };
            elements.set(id, node);
        }
        return elements.get(id);
    };
    const document = {
        getElementById: el,
        createElement: () => el(`anon-${elements.size}`),
        createTextNode: (t) => ({ textContent: String(t) }),
    };
    const location = {
        href: '', pathname: '/', assigned: null,
        assign(u) { this.assigned = u; },
    };
    const setUrl = (u) => { const x = new URL(u, origin); location.href = x.href; location.pathname = x.pathname; };
    async function browserFetch(input, init = {}) {
        const url = new URL(String(input), location.href);
        if (url.origin === origin) {
            const headers = new Headers(init.headers || {});
            if (jar.cookie) headers.set('cookie', jar.cookie);
            if ((init.method || 'GET') !== 'GET') headers.set('origin', origin);     // browsers send Origin on POST
            const res = await realFetch(`${base}${url.pathname}${url.search}`, { ...init, headers });
            const set = res.headers.get('set-cookie');
            if (set) jar.cookie = set.split(';')[0].endsWith('=') ? '' : set.split(';')[0];
            return res;
        }
        if (crossOrigin === 'refuse') throw new TypeError('Failed to fetch');       // what a CORS refusal looks like
        return platform.fetch(input, init);
    }
    const context = vm.createContext({
        document, location, sessionStorage, fetch: browserFetch,
        history: { replaceState: (_s, _t, u) => setUrl(u) },
        console, setTimeout, clearTimeout, URL, URLSearchParams, Headers, Request, Response, AbortController,
        TextEncoder, TextDecoder, btoa, atob, crypto: globalThis.crypto,
    });
    context.window = context;
    return { context, el, location, setUrl };
}

(async () => {
    const platform = createMockPlatform({ users: [{ username: 'ana' }] });
    const ana = [...platform.state.users.values()][0];
    const env = { OV_CLIENT_ID: APP, OV_AUDIENCE: 'openvibe.media', OV_SCOPE: 'media.object.read' };
    const config = loadConfig(env);
    platform.addClient(APP, { secret: null, redirectUris: [config.redirectUri] });   // a public app: no secret
    const logs = [];
    const app = createApp(config, { fetch: platform.fetch, log: { log: (m) => logs.push(m), error: (m) => logs.push(m) } });
    await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${app.server.address().port}`;

    // The served bundle is browser-safe: only SDK modules, nothing server-side.
    const bundleRes = await realFetch(`${base}/sdk/openvibe-sdk.js`);
    assert.equal(bundleRes.status, 200);
    const bundle = await bundleRes.text();
    assert.ok(!/client_secret|process\.env|require\('node:|require\('crypto'\)/.test(bundle));
    assert.deepEqual(app.bundle.modules.sort(), ['src/auth/browser.js', 'src/core/client.js', 'src/core/errors.js', 'src/core/ids.js', 'src/core/index.js', 'src/core/paginate.js', 'src/core/semver.js', 'src/core/trace.js', 'src/registry.js']);
    assert.equal((await realFetch(`${base}/sdk/openvibe-sdk.js`, { headers: { 'if-none-match': bundleRes.headers.get('etag') } })).status, 304);
    const page = await (await realFetch(`${base}/`)).text();
    assert.match(page, /<script src="\/sdk\/openvibe-sdk\.js"><\/script>/);
    const publicConfig = await (await realFetch(`${base}/config.json`)).json();
    assert.deepEqual(Object.keys(publicConfig).sort(), ['clientId', 'network', 'redirectUri', 'scope']);
    const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

    const storage = new Map();
    const sessionStorage = { getItem: (k) => (storage.has(k) ? storage.get(k) : null), setItem: (k, v) => storage.set(k, String(v)), removeItem: (k) => storage.delete(k) };
    const jar = { cookie: '' };
    const load = (url, opts = {}) => {
        const b = createBrowser({ base, origin: config.origin, platform, sessionStorage, jar, ...opts });
        b.setUrl(url);
        vm.runInContext(bundle, b.context);
        vm.runInContext(appJs, b.context);
        return b;
    };

    // 1. First visit: not signed in; the registry is read by the page itself (no token, no cookie).
    let b = load('/');
    await waitFor(() => /services, read by this page/.test(b.el('registry-status').textContent), 'the registry read');
    assert.equal(b.el('who').textContent, 'Not signed in.');
    assert.equal(b.el('sign-in').hidden, false);
    assert.ok(b.el('services').children.some((li) => li.textContent.startsWith('media alpha')));
    const registryCall = platform.stats.requests.find((r) => r.url.includes('/api/v1/registry/services'));
    assert.ok(!registryCall.headers.authorization);

    // 2. Sign in: the page makes the PKCE pair and goes to Network's authorize URL.
    b.el('sign-in').click();
    await waitFor(() => b.location.assigned, 'the redirect to Network');
    const to = new URL(b.location.assigned);
    assert.equal(`${to.origin}${to.pathname}`, 'https://openvibe.network/oauth/authorize');
    assert.equal(to.searchParams.get('client_id'), APP);
    assert.equal(to.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(to.searchParams.get('scope'), 'media.object.read');
    const saved = JSON.parse(storage.get('ov_example_pkce'));
    assert.equal(saved.state, to.searchParams.get('state'));

    // 3. Network sends the browser back with a code (platform.authorize stands in for the consent page).
    const code = platform.authorize({ clientId: APP, redirectUri: config.redirectUri, subjectId: ana.subject_id, codeChallenge: to.searchParams.get('code_challenge') });
    b = load(`/callback?code=${code}&state=${encodeURIComponent(saved.state)}`);
    await waitFor(() => b.el('who').textContent.startsWith('Signed in'), 'the signed-in session');
    assert.match(b.el('who').textContent, new RegExp(`Signed in with OpenVibe as ${ana.subject_id}`));
    assert.equal(b.location.pathname, '/', 'the code is removed from the address bar');
    assert.equal(storage.has('ov_example_pkce'), false, 'the verifier is used once');
    assert.match(jar.cookie, /^ov_browser_example_sid=/);
    const exchange = platform.stats.requests.filter((r) => r.url.endsWith('/oauth/token'));
    assert.equal(exchange.length, 1);

    // 4. A callback this browser did not start: refused before any exchange.
    storage.set('ov_example_pkce', JSON.stringify({ state: 'mine', codeVerifier: saved.codeVerifier }));
    b = load('/callback?code=abc&state=forged');
    await waitFor(() => b.el('auth-error').textContent !== '', 'the state error');
    assert.match(b.el('auth-error').textContent, /oauth\.state_mismatch/);
    assert.equal(platform.stats.requests.filter((r) => r.url.endsWith('/oauth/token')).length, 1);

    // 5. When the browser refuses the cross-origin registry call, the page reads it through its server.
    b = load('/', { crossOrigin: 'refuse' });
    await waitFor(() => /through this app's server/.test(b.el('registry-status').textContent), 'the registry fallback');
    assert.ok(b.el('services').children.length > 0);

    // 6. The exchange endpoint accepts only this page: same Origin and a JSON body.
    const cross = await realFetch(`${base}/auth/exchange`, { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' });
    assert.equal(cross.status, 403);
    const form = await realFetch(`${base}/auth/exchange`, { method: 'POST', headers: { origin: config.origin, 'content-type': 'application/x-www-form-urlencoded' }, body: 'code=x' });
    assert.equal(form.status, 415);

    // 7. Sign out.
    b = load('/');
    await waitFor(() => b.el('who').textContent.startsWith('Signed in'), 'the session on reload');
    b.el('sign-out').click();
    await waitFor(() => b.el('who').textContent === 'Not signed in.', 'the sign-out');

    assert.ok(!/eyJ[\w-]+\.[\w-]+\./.test(logs.join('\n')), 'no tokens in logs');
    app.server.close();
    console.log('browser-app: ok');
})().catch((err) => { console.error(err); process.exit(1); });
