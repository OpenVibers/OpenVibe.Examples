#!/usr/bin/env node
'use strict';
/**
 * Create the OpenVibe.Events subscription that delivers to this consumer.
 *
 *   node --env-file=.env subscribe.js https://hooks.example.com/webhooks/openvibe            # app.<project_key>.*
 *   node --env-file=.env subscribe.js https://hooks.example.com/webhooks/openvibe 'order.*'     # app.<project_key>.order.*
 *
 * Needs an app token for openvibe.events holding events.app.subscribe. Events accepts, for an app:
 *   - topic patterns that start with a literal segment; an app.* pattern must name YOUR project
 *     (app.<project_key>.*, project_key = p + the project's ULID in lowercase); first-party
 *     patterns (live.*) deliver only public events;
 *   - endpoints that are https, without credentials, resolving only to public addresses (checked
 *     at subscribe time and again on every delivery; redirects are never followed).
 * The signing secret is generated here and sent with the request, then written to .env.webhook
 * (mode 0600) for server.js to read. It is never printed.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createClient, isOpenVibeError } = require('openvibe-sdk/core');
const { createServiceTokenClient } = require('openvibe-sdk/auth');
const { createAppEvents } = require('openvibe-sdk/events');

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
        projectId: env.OV_PROJECT_ID || null,
        eventsUrl: env.OV_EVENTS_URL || null,
    };
}

/**
 * -> { subscription: { id, topic_pattern, endpoint, enabled }, secret } (the secret is kept out of
 * the printable part). `topicPattern` is relative to the project (`order.*`; default `*`, i.e.
 * app.<project_key>.*); createAppEvents() turns it into the full pattern.
 */
async function createSubscription(config, { endpoint, topicPattern, secret = `whsec_${crypto.randomBytes(32).toString('hex')}` }, { fetch } = {}) {
    let u;
    try { u = new URL(endpoint); } catch { u = null; }
    if (!u || u.protocol !== 'https:' || u.username || u.password) throw new TypeError('the endpoint must be a public https:// URL without credentials');
    const tokens = createServiceTokenClient({
        network: config.network, clientId: config.clientId, clientSecret: config.clientSecret, fetch,
        scope: { 'openvibe.events': 'events.app.subscribe' },
    });
    const client = createClient({ network: config.network, fetch, tokenProvider: tokens, baseUrls: config.eventsUrl ? { events: config.eventsUrl } : undefined });
    const projectId = config.projectId || (await tokens.getTokenInfo({ audience: 'openvibe.events' })).unverifiedClaims.project_id;
    const events = createAppEvents(client, { projectId, appId: config.clientId });
    const sub = await events.subscriptions.create({ topicPattern: topicPattern || '*', endpoint, secret });
    return { subscription: { id: sub.id, topic_pattern: sub.topic_pattern, endpoint: sub.endpoint, enabled: sub.enabled }, secret: sub.secret || secret };
}

async function main([endpoint, topicPattern] = process.argv.slice(2)) {
    if (!endpoint) {
        console.error('usage: node subscribe.js <https endpoint> [topic-pattern]');
        return 2;
    }
    try {
        const { subscription, secret } = await createSubscription(loadConfig(), { endpoint, topicPattern });
        const file = path.join(__dirname, '.env.webhook');
        fs.writeFileSync(file, `OV_WEBHOOK_SECRET=${secret}\n`, { mode: 0o600 });
        console.log(JSON.stringify(subscription, null, 2));
        console.log(`signing secret written to ${file} (start the consumer with --env-file=.env.webhook)`);
        return 0;
    } catch (err) {
        console.error(`subscribe failed: ${isOpenVibeError(err) ? `${err.code}${err.detail ? `: ${err.detail}` : ''}` : err.message}`);
        if (isOpenVibeError(err) && ['invalid_scope', 'capability.denied'].includes(err.code)) {
            console.error('Request events.app.subscribe on your app (it is in the sandbox allowance) and try again.');
        }
        return 1;
    }
}

if (require.main === module) main().then((code) => { process.exitCode = code; });

module.exports = { loadConfig, createSubscription, main };
