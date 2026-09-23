#!/usr/bin/env node
'use strict';
/**
 * Node server app: an app principal that authenticates with client credentials and finds the
 * platform through the registry.
 *
 *   node --env-file=.env server.js        # http://localhost:3002/status
 *
 * GET /status answers:
 *   - the platform descriptor (Network's /.well-known/openvibe): service origins and the contracts
 *     release the network runs, checked against the range this SDK supports;
 *   - the registry's services;
 *   - for each audience in OV_AUDIENCES, the capabilities an app token for that audience carries
 *     (approved grants within the project's allowance, plus the sandbox allowance for a sandbox
 *     app), with the token's project_id and env, each capability described by the registry.
 *
 * The app token is requested from the public token endpoint and cached per audience until shortly
 * before it expires (5-minute lifetime). The client secret is never printed or returned.
 */
const http = require('node:http');
const { createClient, isOpenVibeError } = require('openvibe-sdk/core');
const { createServiceTokenClient } = require('openvibe-sdk/auth');
const { createRegistryClient } = require('openvibe-sdk/registry');

function loadConfig(env = process.env) {
    const missing = ['OV_CLIENT_ID', 'OV_CLIENT_SECRET'].filter((k) => !env[k]);
    if (missing.length) {
        const err = new Error(`missing environment variables: ${missing.join(', ')} (see .env.example)`);
        err.code = 'config.missing';
        throw err;
    }
    return {
        network: env.OV_NETWORK_URL || 'https://openvibe.network',
        clientId: env.OV_CLIENT_ID,
        clientSecret: env.OV_CLIENT_SECRET,
        audiences: String(env.OV_AUDIENCES || 'openvibe.media,openvibe.events,openvibe.tools').split(',').map((s) => s.trim()).filter(Boolean),
        port: Number(env.OV_PORT || 3002),
    };
}

function createApp(config, { fetch, log = console } = {}) {
    const tokens = createServiceTokenClient({ network: config.network, clientId: config.clientId, clientSecret: config.clientSecret, fetch });
    const client = createClient({ network: config.network, fetch, tokenProvider: tokens });

    /** What an app token for `audience` carries right now, or the reason there is none. */
    async function grantsFor(audience, registry) {
        let info;
        try {
            info = await tokens.getTokenInfo({ audience });
        } catch (err) {
            if (isOpenVibeError(err) && ['invalid_scope', 'invalid_target', 'unauthorized_client'].includes(err.code)) {
                return { audience, capabilities: [], refused: err.code, detail: err.detail || null };
            }
            throw err;
        }
        // Decoded, NOT verified: fine for showing what Network granted. The services that receive
        // the token are the ones that verify it.
        const claims = info.unverifiedClaims || {};
        const capabilities = await Promise.all((claims.cap || []).map(async (id) => {
            const c = await registry.capability(id);
            return { id, known: Boolean(c), visibility: c ? c.visibility || null : null, description: c ? c.description || null : null };
        }));
        return {
            audience,
            capabilities,
            subject: claims.sub || null,
            project_id: claims.project_id || null,
            env: claims.env || null,
            namespaces: claims.ns || [],
            expires_at: info.expiresAt,
        };
    }

    async function status(req) {
        // Continue the caller's trace on every outbound call (traceparent + X-OpenVibe-Request-Id).
        const scoped = req ? client.fromRequest(req) : client;
        const registry = createRegistryClient(scoped);
        const d = await scoped.discover();
        const services = await registry.services();
        return {
            app: config.clientId,
            network: config.network,
            contracts: { version: d.contractsVersion, supported_range: d.contractsRange, compatible: d.compatible },
            services: services.map((s) => ({ id: s.id, status: s.status, origin: d.origins[s.id] || s.publicOrigin || null })),
            grants: await Promise.all(config.audiences.map((a) => grantsFor(a, registry))),
            checked_at: new Date().toISOString(),
        };
    }

    const server = http.createServer(async (req, res) => {
        const send = (code, body) => {
            res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify(body, null, 2));
        };
        const url = new URL(req.url, 'http://app.invalid');
        try {
            if (req.method === 'GET' && url.pathname === '/healthz') return send(200, { ok: true });
            if (req.method === 'GET' && url.pathname === '/status') return send(200, await status(req));
            return send(404, { error: 'not_found' });
        } catch (err) {
            // Log the stable code and request id, never tokens or secrets.
            log.error(`[status] ${isOpenVibeError(err) ? `${err.code} request=${err.requestId}` : err.message}`);
            return send(502, { error: isOpenVibeError(err) ? err.code : 'upstream_error', request_id: isOpenVibeError(err) ? err.requestId : null });
        }
    });

    return { server, client, tokens, status };
}

if (require.main === module) {
    let config;
    try { config = loadConfig(); } catch (err) { console.error(err.message); process.exit(2); }
    const { server } = createApp(config);
    server.listen(config.port, () => console.log(`node-server-app: http://localhost:${config.port}/status (app ${config.clientId})`));
}

module.exports = { loadConfig, createApp };
