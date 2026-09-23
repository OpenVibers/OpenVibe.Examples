'use strict';
/**
 * For tests only. openvibe-sdk 0.3.0's mock Events knows the first-party capabilities
 * (events.event.publish|read, events.subscription.manage) but not the developer-app ones, so an
 * app token holding events.app.* gets 403 there. This fetch plays OpenVibe.Events' developer-app
 * rules (its README, "Developer apps") in front of the mock, then hands the call to it:
 *
 *   - app tokens are verified here: RS256 with the mock's key, audience openvibe.events, the
 *     events.app.* capability of the route; env sandbox is accepted (Events accepts it on these
 *     routes only);
 *   - publish (events.app.publish): event_type app.<project_key>.<name…>, source
 *     app-<lowercased app ULID>, actor the app itself;
 *   - read and subscribe (events.app.read / events.app.subscribe): every pattern starts with a
 *     literal segment, an app.* pattern names the app's own project_key, subscriptions go to https
 *     endpoints only; reads only return the app's own project's events (and public first-party ones).
 *
 * Not modelled: sandbox/production separation, quotas, revocation, the SSRF address checks.
 * Everything else (service tokens, /realtime/stream, other origins) goes to the mock unchanged.
 */
const crypto = require('node:crypto');

const CAPS = { publish: 'events.app.publish', read: 'events.app.read', subscribe: 'events.app.subscribe' };
const b64 = (s) => Buffer.from(String(s), 'base64url');
const projectKey = (projectId) => `p${String(projectId).replace(/^prj_/, '').toLowerCase()}`;
const appSource = (appId) => `app-${String(appId).replace(/^app:/, '').replace(/^app_/, '').toLowerCase()}`;

function problem(status, code, detail) {
    return new Response(JSON.stringify({ type: `https://openvibe.network/problems/${code}`, title: code, status, code, detail }), {
        status, headers: { 'Content-Type': 'application/problem+json' },
    });
}

function patternError(pattern, key) {
    const [first, second] = String(pattern).split('.');
    if (!first || first === '*') return 'an app topic pattern must start with a literal segment (e.g. app.<project_key>.* or live.*)';
    if (first === 'app' && second !== key) return `app.* patterns must name your project: app.${key}.*`;
    return null;
}

function createAppEventsFetch(platform) {
    const owners = new Map();           // event_id -> project_id of the app that published it
    const eventsOrigin = new URL(platform.origins.events).origin;

    function appClaims(req) {
        const auth = req.headers.get('authorization') || '';
        const parts = auth.startsWith('Bearer ') ? auth.slice(7).split('.') : [];
        if (parts.length !== 3) return null;
        try {
            const header = JSON.parse(b64(parts[0]));
            if (header.alg !== 'RS256' || !crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), platform.keys.publicKey, b64(parts[2]))) return null;
            const claims = JSON.parse(b64(parts[1]));
            return claims.actor_type === 'app' && claims.exp * 1000 > Date.now() && (claims.aud || []).includes('openvibe.events') ? claims : null;
        } catch { return null; }
    }

    /** The same call, as a first-party principal the mock understands (consumer = app:app_…). */
    function forward(req, claims, capability, body) {
        const token = platform.signServiceToken(claims.sub, { audience: 'openvibe.events', capabilities: [capability] });
        const headers = new Headers(req.headers);
        headers.set('authorization', `Bearer ${token}`);
        return platform.fetch(new Request(req.url, { method: req.method, headers, body: body === undefined ? undefined : body }));
    }

    return async function fetch(input, init) {
        const req = input instanceof Request && !init ? input : new Request(input, init);
        const url = new URL(req.url);
        if (url.origin !== eventsOrigin || !url.pathname.startsWith('/api/v1/')) return platform.fetch(req);
        const claims = appClaims(req);
        if (!claims) return platform.fetch(req);
        const key = projectKey(claims.project_id);
        const has = (cap) => (claims.cap || []).includes(cap);
        const path = url.pathname;

        if (path === '/api/v1/events' && req.method === 'POST') {
            if (!has(CAPS.publish)) return problem(403, 'capability.denied', `${CAPS.publish} not granted`);
            const env = await req.json().catch(() => null);
            if (!env || !/^evt_[0-9A-HJKMNP-TV-Z]{26}$/.test(env.event_id || '') || !env.event_type || !env.actor || !env.subject || !env.timestamp) {
                return problem(422, 'events.invalid_envelope', 'envelope does not match events.event-envelope@1');
            }
            if (env.source !== appSource(claims.sub)) return problem(403, 'events.source_mismatch', `source must be your app's "${appSource(claims.sub)}", not "${env.source}"`);
            if (!env.event_type.startsWith(`app.${key}.`)) return problem(403, 'events.type_not_allowed', `an app may publish app.${key}.<name> only, not ${env.event_type}`);
            if (env.actor.type !== 'app' || `app:${env.actor.id}` !== claims.sub) return problem(403, 'events.actor_mismatch', `actor must be { type: 'app', id: '${claims.sub.slice(4)}' }`);
            const out = platform.publishEvent(env, claims.sub);
            owners.set(out.event_id, claims.project_id);
            return new Response(JSON.stringify(out), { status: out.duplicate ? 200 : 201, headers: { 'Content-Type': 'application/json' } });
        }

        if (path === '/api/v1/events' && req.method === 'GET') {
            if (!has(CAPS.read)) return problem(403, 'capability.denied', `${CAPS.read} not granted`);
            for (const p of (url.searchParams.get('topic') || '*').split(',')) {
                const err = patternError(p, key);
                if (err) return problem(403, 'events.topic_not_allowed', err);
            }
            const res = await forward(req, claims, 'events.event.read');
            if (!res.ok) return res;
            const page = await res.json();
            const mine = (e) => (e.event.event_type.startsWith('app.') ? owners.get(e.event.event_id) === claims.project_id : e.event.visibility === 'public');
            return new Response(JSON.stringify({ ...page, events: page.events.filter(mine) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }

        if (path.startsWith('/api/v1/subscriptions')) {
            if (!has(CAPS.subscribe)) return problem(403, 'capability.denied', `${CAPS.subscribe} not granted`);
            let body;
            if (req.method === 'POST' && path === '/api/v1/subscriptions') {
                body = await req.text();
                const b = JSON.parse(body || '{}');
                const err = patternError(b.topic_pattern, key);
                if (err) return problem(403, 'events.topic_not_allowed', err);
                if (!/^https:\/\/[^/@]+\//.test(String(b.endpoint || ''))) return problem(422, 'events.endpoint_not_allowed', 'an app endpoint must be a public https URL');
            }
            return forward(req, claims, 'events.subscription.manage', body);
        }

        if (path === '/api/v1/checkpoints') {
            if (!has(CAPS.read)) return problem(403, 'capability.denied', `${CAPS.read} not granted`);
            return forward(req, claims, 'events.event.read', req.method === 'GET' ? undefined : await req.text());
        }
        return problem(403, 'capability.denied', 'app tokens are not accepted on this route');
    };
}

module.exports = { createAppEventsFetch, projectKey, appSource };
