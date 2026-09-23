#!/usr/bin/env node
'use strict';
/**
 * OAuth app: "Sign in with OpenVibe" for a confidential developer app, done on the server.
 *
 *   node --env-file=.env server.js        # http://localhost:3009
 *
 *   /login     make a PKCE pair and a state (openvibe-sdk/auth), keep them in this browser's
 *              server-side session, redirect to Network's /oauth/authorize.
 *   /callback  check the state (readCallback), exchange the code on the server with the client
 *              secret AND the PKCE verifier, verify the token offline against Network's JWKS, then
 *              start a fresh session (new session id: no session fixation).
 *   /api/me    who signed in, and what this app may do on their behalf.
 *
 * What comes back is an APP token acting for the person (actor_type app, on_behalf_of usr_…,
 * cap = the capabilities they authorized, 5-minute lifetime, no refresh token). When it expires
 * the person signs in again. The secret, the verifier and tokens never reach the browser or logs.
 */
const crypto = require('node:crypto');
const http = require('node:http');
const { createClient, isOpenVibeError } = require('openvibe-sdk/core');
const { startAuthorization, readCallback, verifyUserToken } = require('openvibe-sdk/auth');

const SESSION_COOKIE = 'ov_example_sid';
const PENDING_TTL_MS = 10 * 60 * 1000;

function loadConfig(env = process.env) {
    const missing = ['OV_CLIENT_ID', 'OV_CLIENT_SECRET', 'OV_AUDIENCE', 'OV_SCOPE'].filter((k) => !env[k]);
    if (missing.length) {
        throw Object.assign(new Error(`missing environment variables: ${missing.join(', ')} (see .env.example)`), { code: 'config.missing' });
    }
    const redirectUri = env.OV_REDIRECT_URI || 'http://localhost:3009/callback';
    return {
        network: env.OV_NETWORK_URL || 'https://openvibe.network',
        clientId: env.OV_CLIENT_ID,
        clientSecret: env.OV_CLIENT_SECRET,
        redirectUri,
        audience: env.OV_AUDIENCE,
        scope: env.OV_SCOPE.split(/[\s,]+/).filter(Boolean),
        port: Number(env.OV_PORT || new URL(redirectUri).port || 3009),
        secureCookie: redirectUri.startsWith('https://'),
    };
}

/**
 * POST <network>/oauth/token (authorization_code) for a developer app. openvibe-sdk 0.2.2's
 * exchangeCode() cannot send `audience`, which Network requires for app clients, so this calls
 * the public token endpoint through the SDK's core client. No retries: a code works once.
 */
async function exchangeAppCode(client, { clientId, clientSecret, code, codeVerifier, redirectUri, audience, scope }) {
    return client.json({
        service: 'network', path: '/oauth/token', method: 'POST', auth: false, retries: 0, idempotencyKey: false,
        urlencoded: {
            grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: codeVerifier,
            client_id: clientId, client_secret: clientSecret || undefined, audience, scope: scope && scope.length ? scope.join(' ') : undefined,
        },
    });
}

/** Who signed in, from verified claims: an app token names them in on_behalf_of. */
function signedInSubject(claims, clientId) {
    if (claims.actor_type === 'app') {
        if (claims.sub !== `app:${clientId}`) return null;          // a token minted for some other app
        return claims.on_behalf_of || null;
    }
    return claims.subject_id || null;                                // a plain user token
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function parseCookies(header) {
    const out = {};
    for (const part of String(header || '').split(';')) {
        const i = part.indexOf('=');
        if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
}

function createApp(config, { fetch, log = console } = {}) {
    const client = createClient({ network: config.network, fetch });
    const sessions = new Map();            // sid -> { pending?, auth? }   (use a real store in production)

    const newSid = () => crypto.randomBytes(32).toString('base64url');
    const cookie = (sid, maxAge) => `${SESSION_COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${config.secureCookie ? '; Secure' : ''}`;
    function sessionOf(req) {
        const sid = parseCookies(req.headers.cookie)[SESSION_COOKIE];
        return sid && sessions.has(sid) ? { sid, s: sessions.get(sid) } : null;
    }
    function current(req) {
        const found = sessionOf(req);
        if (!found || !found.s.auth) return null;
        if (found.s.auth.expiresAt <= Date.now()) { found.s.auth = null; return null; }
        return found.s.auth;
    }

    /** Forget abandoned sign-ins and expired sessions (an in-memory store has to clean up after itself). */
    function prune() {
        const now = Date.now();
        for (const [sid, s] of sessions) {
            const pendingDead = !s.pending || now - s.pending.at > PENDING_TTL_MS;
            const authDead = !s.auth || s.auth.expiresAt <= now;
            if (pendingDead && authDead) sessions.delete(sid);
        }
    }

    async function login(req, res) {
        prune();
        const found = sessionOf(req);
        const sid = found ? found.sid : newSid();
        const { url, state, codeVerifier } = await startAuthorization({
            network: config.network, clientId: config.clientId, redirectUri: config.redirectUri, scope: config.scope,
        });
        sessions.set(sid, { ...(found ? found.s : {}), pending: { state, codeVerifier, at: Date.now() } });
        res.writeHead(302, { Location: url, 'Set-Cookie': cookie(sid, 3600), 'Cache-Control': 'no-store' });
        res.end();
    }

    async function callback(req, res) {
        const found = sessionOf(req);
        const pending = found && found.s.pending;
        if (found) found.s.pending = null;                           // one attempt per /login
        if (!pending || Date.now() - pending.at > PENDING_TTL_MS) return page(res, 400, 'Sign-in expired', 'Start again from the sign-in link.');
        let code;
        try {
            ({ code } = readCallback(`http://app.invalid${req.url}`, { expectedState: pending.state }));
        } catch (err) {
            log.log(`[oauth] callback refused: ${err.code}`);
            return page(res, 400, 'Sign-in failed', err.code === 'oauth.state_mismatch' ? 'This sign-in was not started here.' : `Network answered ${err.code}.`, err.code);
        }
        try {
            const tokens = await exchangeAppCode(client, { ...config, code, codeVerifier: pending.codeVerifier });
            const d = await client.discover();
            const claims = await verifyUserToken(tokens.access_token, {
                jwks: d.jwksUri || `${config.network}/api/.well-known/jwks`, issuer: d.issuer || undefined, audience: config.audience,
                allowServiceTokens: true, fetch,
            });
            const subject = signedInSubject(claims, config.clientId);
            if (!subject) return page(res, 400, 'Sign-in failed', 'The token does not name a person for this app.', 'token.no_subject');
            sessions.delete(found.sid);                              // fresh session id after sign-in
            const sid = newSid();
            sessions.set(sid, {
                auth: {
                    subject, app: claims.sub || null, projectId: claims.project_id || null, env: claims.env || null,
                    capabilities: claims.cap || String(tokens.scope || '').split(' ').filter(Boolean),
                    expiresAt: claims.exp * 1000, accessToken: tokens.access_token,
                },
            });
            log.log(`[oauth] signed in ${subject}`);
            res.writeHead(302, { Location: '/', 'Set-Cookie': cookie(sid, Math.max(60, claims.exp - Math.floor(Date.now() / 1000))), 'Cache-Control': 'no-store' });
            return res.end();
        } catch (err) {
            log.error(`[oauth] exchange failed: ${isOpenVibeError(err) ? `${err.code} request=${err.requestId}` : err.message}`);
            return page(res, 400, 'Sign-in failed', 'Network did not accept the sign-in. Start again.', isOpenVibeError(err) ? err.code : 'exchange_failed');
        }
    }

    function page(res, status, title, text, code) {
        res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(`<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title><h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p>${code ? `<p><code data-error="${escapeHtml(code)}">${escapeHtml(code)}</code></p>` : ''}<p><a href="/">Back</a></p>`);
    }

    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://app.invalid');
        try {
            if (req.method === 'GET' && url.pathname === '/') {
                const auth = current(req);
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
                return res.end(`<!doctype html><meta charset="utf-8"><title>OpenVibe OAuth app example</title><h1>OpenVibe OAuth app example</h1>${auth
                    ? `<p>Signed in with OpenVibe as <code>${escapeHtml(auth.subject)}</code>.</p><p>This app may: ${auth.capabilities.map((c) => `<code>${escapeHtml(c)}</code>`).join(', ') || 'nothing'}.</p><form method="post" action="/logout"><button>Sign out</button></form>`
                    : '<p><a href="/login">Sign in with OpenVibe</a></p>'}`);
            }
            if (req.method === 'GET' && url.pathname === '/login') return await login(req, res);
            if (req.method === 'GET' && url.pathname === new URL(config.redirectUri).pathname) return await callback(req, res);
            if (req.method === 'GET' && url.pathname === '/api/me') {
                const auth = current(req);
                res.writeHead(auth ? 200 : 401, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
                return res.end(JSON.stringify(auth
                    ? { subject: auth.subject, app: auth.app, project_id: auth.projectId, env: auth.env, capabilities: auth.capabilities, expires_at: new Date(auth.expiresAt).toISOString() }
                    : { error: 'not_signed_in' }));
            }
            if (req.method === 'POST' && url.pathname === '/logout') {
                const found = sessionOf(req);
                if (found) sessions.delete(found.sid);
                res.writeHead(303, { Location: '/', 'Set-Cookie': cookie('', 0) });
                return res.end();
            }
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            return res.end('not found');
        } catch (err) {
            log.error(`[oauth] ${err.message}`);
            if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end('error'); }
            return undefined;
        }
    });

    return { server, sessions };
}

if (require.main === module) {
    let config;
    try { config = loadConfig(); } catch (err) { console.error(err.message); process.exit(2); }
    const { server } = createApp(config);
    server.listen(config.port, () => console.log(`oauth-app: http://localhost:${config.port} (redirect URI ${config.redirectUri})`));
}

module.exports = { loadConfig, createApp, exchangeAppCode, signedInSubject };
