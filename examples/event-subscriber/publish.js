#!/usr/bin/env node
'use strict';
/**
 * Publish one event to your project's own topic, so the subscriber (and webhook-consumer) have
 * something to receive.
 *
 *   node --env-file=.env publish.js                          # app.<project_key>.example.ping
 *   node --env-file=.env publish.js order.created '{"total":3}'
 *
 * An app publishes with events.app.publish (audience openvibe.events). Events enforces the names,
 * and openvibe-sdk/events createAppEvents() fills them in from the project and app ids:
 *   event_type  app.<project_key>.<name>    project_key = p + your project's ULID in lowercase
 *   source      app-<your app's ULID in lowercase>
 *   actor       { type: 'app', id: <your app id> }
 * plus event_id (evt_<ULID>), timestamp, version and trace_id. Publishing the same event_id again
 * is answered with the stored seq (duplicate: true), so retries are safe.
 */
const { createClient, isOpenVibeError } = require('openvibe-sdk/core');
const { createServiceTokenClient } = require('openvibe-sdk/auth');
const { createAppEvents } = require('openvibe-sdk/events');

const NAME_RE = /^[a-z0-9_]+(\.[a-z0-9_]+)*$/;

function loadConfig(env = process.env) {
    const missing = ['OV_CLIENT_ID', 'OV_CLIENT_SECRET'].filter((k) => !env[k]);
    if (missing.length) throw Object.assign(new Error(`missing environment variables: ${missing.join(', ')} (see .env.example)`), { code: 'config.missing' });
    return {
        network: env.OV_NETWORK_URL || 'https://openvibe.network',
        clientId: env.OV_CLIENT_ID,
        clientSecret: env.OV_CLIENT_SECRET,
        projectId: env.OV_PROJECT_ID || null,
        eventsUrl: env.OV_EVENTS_URL || null,
    };
}

/** -> { event_id, seq, duplicate, event_type } */
async function publishAppEvent(config, { name = 'example.ping', subject = { type: 'example', id: '1' }, payload = {}, eventId } = {}, { fetch } = {}) {
    if (!NAME_RE.test(name)) throw new TypeError('the event name is dot-separated segments of a-z, 0-9 and _ (e.g. order.created)');
    const tokens = createServiceTokenClient({
        network: config.network, clientId: config.clientId, clientSecret: config.clientSecret, fetch,
        scope: { 'openvibe.events': 'events.app.publish' },
    });
    const client = createClient({ network: config.network, fetch, tokenProvider: tokens, baseUrls: config.eventsUrl ? { events: config.eventsUrl } : undefined });
    const projectId = config.projectId || (await tokens.getTokenInfo({ audience: 'openvibe.events' })).unverifiedClaims.project_id;
    const events = createAppEvents(client, { projectId, appId: config.clientId });
    const out = await events.publish({ ...(eventId ? { event_id: eventId } : {}), event_type: name, subject, payload });
    return { ...out, event_type: events.topic(name) };
}

async function main([name, payload] = process.argv.slice(2)) {
    try {
        const out = await publishAppEvent(loadConfig(), { name: name || undefined, payload: payload ? JSON.parse(payload) : {} });
        console.log(JSON.stringify(out, null, 2));
        return 0;
    } catch (err) {
        console.error(`publish failed: ${isOpenVibeError(err) ? `${err.code}${err.detail ? `: ${err.detail}` : ''} (request ${err.requestId})` : err.message}`);
        return 1;
    }
}

if (require.main === module) main().then((code) => { process.exitCode = code; });

module.exports = { loadConfig, publishAppEvent, main };
