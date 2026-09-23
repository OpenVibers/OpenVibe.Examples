#!/usr/bin/env node
'use strict';
/**
 * Vanilla browser app: a static page that signs in with OpenVibe.Network using PKCE
 * (openvibe-sdk/auth/browser in the browser) and calls a public API (the ecosystem registry)
 * straight from the browser.
 *
 *   node --env-file=.env server.js        # http://localhost:3001
 *
 * The app is a PUBLIC developer app: it has no client secret. The browser makes the PKCE pair and
 * keeps the verifier in sessionStorage; after the redirect it hands code + verifier to this tiny
 * server, which exchanges them at Network's token endpoint (Network does not open its token
 * endpoint to third-party origins, and the resulting token is kept out of page scripts in an
 * HttpOnly session). The server has no secrets at all.
 *
 *   GET  /, /callback         the page (public/index.html)
 *   GET  /app.js              the page's script
 *   GET  /sdk/openvibe-sdk.js openvibe-sdk's browser-safe modules as one script (lib/sdk-bundle.js)
 *   GET  /config.json         public settings: network, client id, redirect URI, scope
 *   POST /auth/exchange       { code, codeVerifier } -> session cookie, { subject }
 *   GET  /api/session         who is signed in
 *   GET  /api/registry/services  the same public registry read, server side: the page's fallback
 *                             while Network does not allow third-party origins on the registry
 *   POST /auth/logout
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { createClient, isOpenVibeError } = require('openvibe-sdk/core');
const { verifyUserToken } = require('openvibe-sdk/auth');
const { createRegistryClient } = require('openvibe-sdk/registry');
const { buildSdkBundle } = require('./lib/sdk-bundle');

const SESSION_COOKIE = 'ov_browser_example_sid';
const PUBLIC = path.join(__dirname, 'public');

function loadConfig(env = process.env) {
    const missing = ['OV_CLIENT_ID', 'OV_AUDIENCE', 'OV_SCOPE'].filter((k) => !env[k]);
    if (missing.length) throw Object.assign(new Error(`missing environment variables: ${missing.join(', ')} (see .env.example)`), { code: 'config.missing' });
    const redirectUri = env.OV_REDIRECT_URI || 'http://localhost:3001/callback';
    return {
        network: env.OV_NETWORK_URL || 'https://openvibe.network',
        clientId: env.OV_CLIENT_ID,
        audience: env.OV_AUDIENCE,
        scope: env.OV_SCOPE.split(/[\s,]+/).filter(Boolean),
        redirectUri,
        origin: new URL(redirectUri).origin,
        port: Number(env.OV_PORT || new URL(redirectUri).port || 3001),
    };
}

/** Network's token endpoint, authorization_code for a public app (no secret; `audience` is required). */
async function exchangePublicCode(client, { clientId, code, codeVerifier, redirectUri, audience, scope }) {
    return client.json({
        service: 'network', path: '/oauth/token', method: 'POST', auth: false, retries: 0, idempotencyKey: false,
        urlencoded: { grant_type: 'authorization_code', client_id: clientId, code, code_verifier: codeVerifier, redirect_uri: redirectUri, audience, scope: scope.join(' ') },
    });
}

function createApp(config, { fetch, log = console } = {}) {
    const client = createClient({ network: config.network, fetch });
    const bundle = buildSdkBundle();
    const sessions = new Map();          // sid -> { subject, capabilities, expiresAt }
    const secure = config.redirectUri.startsWith('https://');
    const cookie = (sid, maxAge) => `${SESSION_COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
    const sidOf = (req) => {
        const m = String(req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([A-Za-z0-9_-]+)`));
        return m ? m[1] : null;
    };
    const current = (req) => {
        const s = sessions.get(sidOf(req));
        return s && s.expiresAt > Date.now() ? s : null;
    };
    const publicConfig = JSON.stringify({ network: config.network, clientId: config.clientId, redirectUri: config.redirectUri, scope: config.scope });

    function json(res, status, body, headers = {}) {
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
        res.end(JSON.stringify(body));
    }
    function file(res, name, type) {
        res.writeHead(200, {
            'Content-Type': type, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy': `default-src 'self'; connect-src 'self' ${config.network}; img-src 'self' data:; style-src 'self' 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
        });
        res.end(fs.readFileSync(path.join(PUBLIC, name)));
    }
    function readJson(req, limit = 16 * 1024) {
        return new Promise((resolve, reject) => {
            let body = '';
            req.on('data', (c) => { body += c; if (body.length > limit) reject(Object.assign(new Error('too large'), { status: 413 })); });
            req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { reject(Object.assign(new Error('bad json'), { status: 400 })); } });
        });
    }

    async function exchange(req, res) {
        // Only this page may call this: same Origin, JSON body (a cross-site form cannot send either).
        if (req.headers.origin !== config.origin) return json(res, 403, { error: 'bad_origin' });
        if (!/^application\/json\b/.test(req.headers['content-type'] || '')) return json(res, 415, { error: 'json_required' });
        const { code, codeVerifier } = await readJson(req);
        if (typeof code !== 'string' || !code || typeof codeVerifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(codeVerifier)) {
            return json(res, 400, { error: 'bad_request' });
        }
        try {
            const tokens = await exchangePublicCode(client, { ...config, code, codeVerifier });
            const d = await client.discover();
            const claims = await verifyUserToken(tokens.access_token, {
                jwks: d.jwksUri || `${config.network}/api/.well-known/jwks`, issuer: d.issuer || undefined, audience: config.audience, allowServiceTokens: true, fetch,
            });
            // Developer-app tokens name the person in on_behalf_of and must be for this app.
            const subject = claims.actor_type === 'app' ? (claims.sub === `app:${config.clientId}` ? claims.on_behalf_of : null) : claims.subject_id;
            if (!subject) return json(res, 400, { error: 'no_subject' });
            for (const [k, v] of sessions) if (v.expiresAt <= Date.now()) sessions.delete(k);     // in-memory store: clean up
            const sid = crypto.randomBytes(32).toString('base64url');
            sessions.set(sid, { subject, capabilities: claims.cap || [], expiresAt: claims.exp * 1000 });
            log.log(`[browser-app] signed in ${subject}`);
            return json(res, 200, { subject, capabilities: claims.cap || [] }, { 'Set-Cookie': cookie(sid, Math.max(60, claims.exp - Math.floor(Date.now() / 1000))) });
        } catch (err) {
            log.error(`[browser-app] exchange failed: ${isOpenVibeError(err) ? `${err.code} request=${err.requestId}` : err.message}`);
            return json(res, 400, { error: isOpenVibeError(err) ? err.code : 'exchange_failed' });
        }
    }

    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://app.invalid');
        try {
            if (req.method === 'GET' && (url.pathname === '/' || url.pathname === new URL(config.redirectUri).pathname)) return file(res, 'index.html', 'text/html; charset=utf-8');
            if (req.method === 'GET' && url.pathname === '/app.js') return file(res, 'app.js', 'text/javascript; charset=utf-8');
            if (req.method === 'GET' && url.pathname === '/sdk/openvibe-sdk.js') {
                if (req.headers['if-none-match'] === bundle.etag) { res.writeHead(304, { ETag: bundle.etag }); return res.end(); }
                res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache', ETag: bundle.etag });
                return res.end(bundle.code);
            }
            if (req.method === 'GET' && url.pathname === '/config.json') {
                res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
                return res.end(publicConfig);
            }
            if (req.method === 'POST' && url.pathname === '/auth/exchange') return await exchange(req, res);
            if (req.method === 'GET' && url.pathname === '/api/session') {
                const s = current(req);
                return s ? json(res, 200, { subject: s.subject, capabilities: s.capabilities, expires_at: new Date(s.expiresAt).toISOString() }) : json(res, 401, { error: 'not_signed_in' });
            }
            if (req.method === 'GET' && url.pathname === '/api/registry/services') {
                return json(res, 200, { services: await createRegistryClient(client).services() }, { 'Cache-Control': 'public, max-age=30' });
            }
            if (req.method === 'POST' && url.pathname === '/auth/logout') {
                if (req.headers.origin !== config.origin) return json(res, 403, { error: 'bad_origin' });
                sessions.delete(sidOf(req));
                return json(res, 200, { ok: true }, { 'Set-Cookie': cookie('', 0) });
            }
            return json(res, 404, { error: 'not_found' });
        } catch (err) {
            if (!res.headersSent) json(res, err.status || 500, { error: err.status ? err.message : 'error' });
            return undefined;
        }
    });
    return { server, sessions, bundle };
}

if (require.main === module) {
    let config;
    try { config = loadConfig(); } catch (err) { console.error(err.message); process.exit(2); }
    const { server } = createApp(config);
    server.listen(config.port, () => console.log(`browser-app: ${config.origin} (redirect URI ${config.redirectUri})`));
}

module.exports = { loadConfig, createApp, exchangePublicCode };
