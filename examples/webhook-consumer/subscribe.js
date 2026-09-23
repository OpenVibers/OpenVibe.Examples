#!/usr/bin/env node
'use strict';
/**
 * Create the OpenVibe.Events subscription that delivers to this consumer.
 *
 *   node --env-file=.env subscribe.js 'media.object.*' https://hooks.example.com/webhooks/openvibe
 *
 * Needs an app token for openvibe.events holding events.subscription.manage. The signing secret
 * is generated here and sent with the request, then written to .env.webhook (mode 0600) for
 * server.js to read. It is never printed.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createClient, isOpenVibeError } = require('openvibe-sdk/core');
const { createServiceTokenClient } = require('openvibe-sdk/auth');
const { createEventsClient } = require('openvibe-sdk/events');

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
        eventsUrl: env.OV_EVENTS_URL || null,
    };
}

/** -> { id, topic_pattern, endpoint, enabled } plus the secret it was created with (kept out of logs). */
async function createSubscription(config, { topicPattern, endpoint, secret = `whsec_${crypto.randomBytes(32).toString('hex')}` }, { fetch } = {}) {
    if (!/^https:\/\//.test(endpoint) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(endpoint)) {
        throw new TypeError('the endpoint must be an https:// URL');
    }
    const client = createClient({
        network: config.network,
        fetch,
        tokenProvider: createServiceTokenClient({ network: config.network, clientId: config.clientId, clientSecret: config.clientSecret, fetch }),
        baseUrls: config.eventsUrl ? { events: config.eventsUrl } : undefined,
    });
    const events = createEventsClient(client, { source: config.clientId });
    const sub = await events.subscriptions.create({ topicPattern, endpoint, secret });
    return { subscription: { id: sub.id, topic_pattern: sub.topic_pattern, endpoint: sub.endpoint, enabled: sub.enabled }, secret: sub.secret || secret };
}

async function main([topicPattern, endpoint] = process.argv.slice(2)) {
    if (!topicPattern || !endpoint) {
        console.error('usage: node subscribe.js <topic-pattern> <https endpoint>');
        return 2;
    }
    try {
        const { subscription, secret } = await createSubscription(loadConfig(), { topicPattern, endpoint });
        const file = path.join(__dirname, '.env.webhook');
        fs.writeFileSync(file, `OV_WEBHOOK_SECRET=${secret}\n`, { mode: 0o600 });
        console.log(JSON.stringify(subscription, null, 2));
        console.log(`signing secret written to ${file} (start the consumer with --env-file=.env.webhook)`);
        return 0;
    } catch (err) {
        console.error(`subscribe failed: ${isOpenVibeError(err) ? `${err.code}${err.detail ? `: ${err.detail}` : ''}` : err.message}`);
        if (isOpenVibeError(err) && ['invalid_scope', 'invalid_target', 'capability.denied'].includes(err.code)) {
            console.error('events.subscription.manage is not grantable to developer apps today; see the README.');
        }
        return 1;
    }
}

if (require.main === module) main().then((code) => { process.exitCode = code; });

module.exports = { loadConfig, createSubscription, main };
