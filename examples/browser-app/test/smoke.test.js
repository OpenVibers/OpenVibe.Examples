'use strict';
/**
 * Smoke test: the page's own module script (public/app.js) and the SDK's browser bundle, as this
 * app's server serves them, run as ES modules in a small fake browser (a vm context with a minimal
 * DOM, sessionStorage, location, a cookie jar and fetch), against the server and the SDK's mock
 * platform. Covers: the registry read from the page, sign-in -> Network's authorize URL with PKCE
 * and the audience, the account chooser's redirect back -> exchange -> signed-in session, a forged
 * callback, the optional server-side registry fallback, and sign-out.
 *
 * ES modules in a vm context need vm.SourceTextModule, which Node 22 has behind
 * --experimental-vm-modules; this file re-runs itself with that flag.
 */
const vm = require('node:vm');

if (typeof vm.SourceTextModule !== 'function') {
    const { spawnSync } = require('node:child_process');
    const r = spawnSync(process.execPath, ['--experimental-vm-modules', '--disable-warning=ExperimentalWarning', __filename], { stdio: 'inherit' });
    process.exit(r.status == null ? 1 : r.status);
}

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createMockPlatform } = require('openvibe-sdk/testing');
const { createApp, loadConfig } = require('../server');

const realFetch = globalThis.fetch;
globalThis.fetch = () => { throw new Error('network access in a smoke test'); };

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
    const crossOriginCalls = [];
    async function browserFetch(input, init = {}) {
        const url = new URL(String(input && input.url ? input.url : input), location.href);
        if (url.origin === origin) {
            const headers = new Headers(init.headers || {});
            if (jar.cookie) headers.set('cookie', jar.cookie);
            if ((init.method || 'GET') !== 'GET') headers.set('origin', origin);     // browsers send Origin on POST
            const res = await realFetch(`${base}${url.pathname}${url.search}`, { ...init, headers });
            const set = res.headers.get('set-cookie');
            if (set) jar.cookie = set.split(';')[0].endsWith('=') ? '' : set.split(';')[0];
            return res;
        }
        crossOriginCalls.push({ url: url.href, credentials: init.credentials });
        if (crossOrigin === 'refuse') throw new TypeError('Failed to fetch');       // what a CORS refusal looks like
        return platform.fetch(input, init);
    }
    const context = vm.createContext({
        document, location, sessionStorage, fetch: browserFetch,
        history: { replaceState: (_s, _t, u) => setUrl(u) },
        console, setTimeout, clearTimeout, URL, URLSearchParams, Headers, Request, Response, AbortController, AbortSignal,
        TextEncoder, TextDecoder, btoa, atob, crypto: globalThis.crypto, Blob, FormData, ReadableStream,
    });
    context.window = context;
    return { context, el, location, setUrl, crossOriginCalls };
}

(async () => {
    const platform = createMockPlatform({ users: [{ username: 'ana' }] });
    const ana = [...platform.state.users.values()][0];
    const project = platform.addProject({ owner: ana.subject_id, environmentPolicy: 'sandbox' });
    const redirectUri = 'http://localhost:3001/callback';
    // A public sandbox app: no secret, redirect URI registered, a grant for the audience it signs in for.
    const devApp = platform.addApp({ project, env: 'sandbox', type: 'public', redirectUris: [redirectUri], grants: ['media.object.read'] });
    assert.equal(devApp.secret, undefined);
    platform.setAuthorization({ subjectId: ana.subject_id });

    const env = { OV_CLIENT_ID: devApp.id, OV_AUDIENCE: 'openvibe.media', OV_SCOPE: 'media.object.read', OV_REDIRECT_URI: redirectUri };
    const config = loadConfig(env);
    const logs = [];
    const app = createApp(config, { fetch: platform.fetch, log: { log: (m) => logs.push(m), error: (m) => logs.push(m) } });
    await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${app.server.address().port}`;

    // The page loads the SDK's own browser bundle, unchanged, as an ES module.
    const page = await (await realFetch(`${base}/`)).text();
    assert.match(page, /<script type="module" src="\/app\.js"><\/script>/);
    const bundleRes = await realFetch(`${base}/vendor/openvibe-sdk.mjs`);
    assert.equal(bundleRes.status, 200);
    assert.match(bundleRes.headers.get('content-type'), /^text\/javascript/);
    const bundle = await bundleRes.text();
    assert.equal(bundle, fs.readFileSync(require.resolve('openvibe-sdk/browser/openvibe-sdk.mjs'), 'utf8'));
    assert.ok(!/client_secret|process\.env|require\('node:/.test(bundle), 'nothing server-side in the browser bundle');
    assert.equal((await realFetch(`${base}/vendor/openvibe-sdk.mjs`, { headers: { 'if-none-match': bundleRes.headers.get('etag') } })).status, 304);
    const publicConfig = await (await realFetch(`${base}/config.json`)).json();
    assert.deepEqual(Object.keys(publicConfig).sort(), ['audience', 'clientId', 'network', 'redirectUri', 'registryProxy', 'scope']);
    assert.equal((await realFetch(`${base}/api/registry/services`)).status, 404, 'the server-side registry read is opt-in');
    const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

    const storage = new Map();
    const sessionStorage = { getItem: (k) => (storage.has(k) ? storage.get(k) : null), setItem: (k, v) => storage.set(k, String(v)), removeItem: (k) => storage.delete(k) };
    const jar = { cookie: '' };
    /** Load the page at `url` in a fresh browsing context: app.js imports /vendor/openvibe-sdk.mjs. */
    const load = async (url, { serverBase = base, ...opts } = {}) => {
        const b = createBrowser({ base: serverBase, origin: config.origin, platform, sessionStorage, jar, ...opts });
        b.setUrl(url);
        const sdk = new vm.SourceTextModule(bundle, { context: b.context, identifier: `${config.origin}/vendor/openvibe-sdk.mjs` });
        const mod = new vm.SourceTextModule(appJs, { context: b.context, identifier: `${config.origin}/app.js` });
        await mod.link((specifier) => {
            if (specifier === '/vendor/openvibe-sdk.mjs') return sdk;
            throw new Error(`app.js imports ${specifier}`);
        });
        b.done = mod.evaluate();
        b.done.catch((err) => { b.error = err; });
        return b;
    };

    // 1. First visit: not signed in; the registry is read by the page itself, cross-origin, with
    //    no token and no cookie.
    let b = await load('/');
    await waitFor(() => /services, read by this page/.test(b.el('registry-status').textContent), 'the registry read');
    assert.equal(b.el('who').textContent, 'Not signed in.');
    assert.equal(b.el('sign-in').hidden, false);
    assert.ok(b.el('services').children.some((li) => li.textContent.startsWith('media alpha')));
    assert.ok(b.crossOriginCalls.some((c) => c.url.startsWith('https://openvibe.network/api/v1/registry/services')));
    const registryCall = platform.stats.requests.find((r) => r.url.includes('/api/v1/registry/services'));
    assert.ok(!registryCall.headers.authorization);
    assert.ok(b.crossOriginCalls.every((c) => c.credentials !== 'include'));

    // 2. Sign in: the page makes the PKCE pair and goes to Network's authorize URL.
    b.el('sign-in').click();
    await waitFor(() => b.location.assigned, 'the redirect to Network');
    const to = new URL(b.location.assigned);
    assert.equal(`${to.origin}${to.pathname}`, 'https://openvibe.network/oauth/authorize');
    assert.equal(to.searchParams.get('client_id'), devApp.id);
    assert.equal(to.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(to.searchParams.get('audience'), 'openvibe.media');
    assert.equal(to.searchParams.get('scope'), 'media.object.read');
    const saved = JSON.parse(storage.get('ov_example_pkce'));
    assert.equal(saved.state, to.searchParams.get('state'));

    // 3. At Network the person continues; the account chooser redirects back with a code.
    const atNetwork = await platform.fetch(to.toString(), { redirect: 'manual' });
    assert.equal(atNetwork.status, 302);
    const back = new URL(atNetwork.headers.get('location'));
    assert.equal(`${back.origin}${back.pathname}`, redirectUri);
    b = await load(`${back.pathname}${back.search}`);
    await waitFor(() => b.el('who').textContent.startsWith('Signed in'), 'the signed-in session');
    assert.equal(b.el('who').textContent, `Signed in with OpenVibe as ${ana.subject_id}. This app may: media.object.read.`);
    assert.equal(b.location.pathname, '/', 'the code is removed from the address bar');
    assert.equal(storage.has('ov_example_pkce'), false, 'the verifier is used once');
    assert.match(jar.cookie, /^ov_browser_example_sid=/);
    const exchanges = () => platform.stats.requests.filter((r) => r.url.endsWith('/oauth/token'));
    assert.equal(exchanges().length, 1, 'exchanged once, by this app\'s server');
    assert.ok(!b.crossOriginCalls.some((c) => c.url.includes('/oauth/token')), 'the browser never calls the token endpoint');

    // 4. A callback this browser did not start: refused before any exchange.
    storage.set('ov_example_pkce', JSON.stringify({ state: 'mine', codeVerifier: saved.codeVerifier }));
    b = await load('/callback?code=abc&state=forged');
    await waitFor(() => b.el('auth-error').textContent !== '', 'the state error');
    assert.match(b.el('auth-error').textContent, /oauth\.state_mismatch/);
    assert.equal(exchanges().length, 1);

    // 5. When the browser cannot reach Network (a CORS refusal), the page says so; with
    //    OV_REGISTRY_PROXY=1 it reads the same registry through its own server instead.
    b = await load('/', { crossOrigin: 'refuse' });
    await waitFor(() => /Could not read the registry/.test(b.el('registry-status').textContent), 'the registry error');
    const proxied = createApp(loadConfig({ ...env, OV_REGISTRY_PROXY: '1' }), { fetch: platform.fetch, log: { log() {}, error() {} } });
    await new Promise((r) => proxied.server.listen(0, '127.0.0.1', r));
    b = await load('/', { crossOrigin: 'refuse', serverBase: `http://127.0.0.1:${proxied.server.address().port}` });
    await waitFor(() => /through this app's server/.test(b.el('registry-status').textContent), 'the registry fallback');
    assert.ok(b.el('services').children.length > 0);
    proxied.server.close();

    // 6. The exchange endpoint accepts only this page: same Origin and a JSON body.
    const cross = await realFetch(`${base}/auth/exchange`, { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' });
    assert.equal(cross.status, 403);
    const form = await realFetch(`${base}/auth/exchange`, { method: 'POST', headers: { origin: config.origin, 'content-type': 'application/x-www-form-urlencoded' }, body: 'code=x' });
    assert.equal(form.status, 415);

    // 7. Sign out.
    b = await load('/');
    await waitFor(() => b.el('who').textContent.startsWith('Signed in'), 'the session on reload');
    b.el('sign-out').click();
    await waitFor(() => b.el('who').textContent === 'Not signed in.', 'the sign-out');

    assert.ok(!/eyJ[\w-]+\.[\w-]+\./.test(logs.join('\n')), 'no tokens in logs');
    app.server.close();
    console.log('browser-app: ok');
})().catch((err) => { console.error(err); process.exit(1); });
