/* OpenVibe browser app example: sign in with PKCE, then read the public registry.
 * Plain browser JavaScript, no framework and no build step: an ES module that imports
 * openvibe-sdk's browser bundle (browser/openvibe-sdk.mjs, served by this app's server).
 * DOM nodes are built with textContent, never innerHTML. */
import { createClient, auth, registry } from '/vendor/openvibe-sdk.mjs';

const PKCE_KEY = 'ov_example_pkce';
const $ = (id) => document.getElementById(id);

function showError(err) {
    const el = $('auth-error');
    el.textContent = `Sign-in failed: ${(err && (err.code || err.message)) || 'unknown error'}`;
    el.hidden = false;
}

async function getJson(url, init = {}) {
    const res = await fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' }, ...init });
    return { status: res.status, body: await res.json() };
}

/** Back from Network on /callback: check state, hand code + verifier to this app's server. */
async function finishSignIn() {
    const href = location.href;
    let saved = null;
    try { saved = JSON.parse(sessionStorage.getItem(PKCE_KEY) || 'null'); } catch { saved = null; }
    sessionStorage.removeItem(PKCE_KEY);
    history.replaceState(null, '', '/');
    let callback;
    try {
        if (!saved) throw Object.assign(new Error('no sign-in was started here'), { code: 'oauth.no_pending_sign_in' });
        callback = auth.readCallback(href, { expectedState: saved.state });
    } catch (err) { showError(err); return; }
    const r = await getJson('/auth/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ code: callback.code, codeVerifier: saved.codeVerifier }),
    });
    if (r.status !== 200) showError({ code: r.body.error });
}

/** An app asks for capability ids of ONE audience; the code is bound to that audience. */
async function startSignIn(config) {
    const a = await auth.startAuthorization({
        network: config.network, clientId: config.clientId, redirectUri: config.redirectUri, audience: config.audience, scope: config.scope,
    });
    sessionStorage.setItem(PKCE_KEY, JSON.stringify({ state: a.state, codeVerifier: a.codeVerifier }));
    location.assign(a.url);
}

async function showSession() {
    const r = await getJson('/api/session');
    const signedIn = r.status === 200;
    $('who').textContent = signedIn
        ? `Signed in with OpenVibe as ${r.body.subject}. This app may: ${r.body.capabilities.join(', ') || 'nothing'}.`
        : 'Not signed in.';
    $('sign-in').hidden = signedIn;
    $('sign-out').hidden = !signedIn;
}

function renderServices(services, via) {
    const list = $('services');
    list.textContent = '';
    for (const s of services) {
        const li = document.createElement('li');
        const name = document.createElement('code');
        name.textContent = s.id;
        li.appendChild(name);
        li.appendChild(document.createTextNode(` ${s.status}${s.publicOrigin ? ` - ${s.publicOrigin}` : ''}`));
        list.appendChild(li);
    }
    $('registry-status').textContent = `${services.length} services, ${via}.`;
}

/**
 * A public API straight from the browser: no token, no cookie. Network answers the registry to
 * any origin (CORS, preflight included). The server-side read is an opt-in fallback
 * (OV_REGISTRY_PROXY=1) for pages that cannot reach Network from the browser.
 */
async function loadRegistry(config) {
    try {
        const client = createClient({ network: config.network, retries: 1 });
        renderServices(await registry.createRegistryClient(client).services(), `read by this page from ${config.network}`);
    } catch (err) {
        if (!config.registryProxy) {
            $('registry-status').textContent = `Could not read the registry: ${err.code || err.message}`;
            return;
        }
        const r = await getJson('/api/registry/services');
        if (r.status !== 200) { $('registry-status').textContent = `Could not read the registry: ${r.body.error}`; return; }
        renderServices(r.body.services, 'read through this app\'s server (OV_REGISTRY_PROXY)');
    }
}

const { body: config } = await getJson('/config.json');
$('sign-in').addEventListener('click', () => { startSignIn(config).catch(showError); });
$('sign-out').addEventListener('click', async () => {
    await getJson('/auth/logout', { method: 'POST' });
    await showSession();
});
if (location.pathname === new URL(config.redirectUri).pathname) await finishSignIn();
await showSession();
await loadRegistry(config);
