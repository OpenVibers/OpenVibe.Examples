#!/usr/bin/env node
'use strict';
/**
 * Event subscriber: follow OpenVibe.Events topics without losing or double-handling events.
 *
 *   node --env-file=.env subscriber.js
 *
 * Two ways in, one cursor discipline:
 *
 *   pull      GET /api/v1/events through openvibe-sdk/events iterate(), from the saved cursor, as
 *             your developer app (events.app.read, audience openvibe.events). The default topic is
 *             your project's own events, app.<project_key>.*; add public first-party topics
 *             (live.stream.*) if you want those too. Another project's app.* topics are refused.
 *   realtime  GET /realtime/stream (SSE) through openvibe-sdk/realtime subscribe(), anonymously:
 *             public first-party events only. Events never streams app.* events over realtime.
 *             Resumes with Last-Event-ID from the saved cursor after a restart or a drop.
 *
 * The cursor is saved only AFTER an event was handled, so a crash replays at most the event in
 * hand (make your handler idempotent on event_id). In pull mode the cursor also moves past events
 * that did not match the topic, to the page's next_after_seq: iterate() calls onPage only after
 * every item of that page was handled, so saving it there is crash-safe.
 *
 * A gap means Events can no longer give you part of the range (retention pruned it: sandbox app
 * events are kept 7 days; or the cursor is ahead of the stream after a restore). Nothing can replay
 * it, so the subscriber calls onResync(gap): reload whatever state you derive from these events.
 */
const fs = require('node:fs');
const path = require('node:path');
const { createClient, isOpenVibeError } = require('openvibe-sdk/core');
const { createServiceTokenClient } = require('openvibe-sdk/auth');
const { createEventsClient } = require('openvibe-sdk/events');
const { subscribe } = require('openvibe-sdk/realtime');

/** `p` + the project's ULID in lowercase: the second segment of your app event types. */
function projectKey(projectId) {
    const m = /^prj_([0-9A-HJKMNP-TV-Z]{26})$/i.exec(String(projectId || ''));
    if (!m) throw Object.assign(new TypeError(`not a project id: ${projectId}`), { code: 'config.invalid' });
    return `p${m[1].toLowerCase()}`;
}

/** `app-` + the app's ULID in lowercase: the `source` of the events your app publishes. */
function appSource(appId) {
    const m = /^(?:app:)?app_([0-9A-HJKMNP-TV-Z]{26})$/i.exec(String(appId || ''));
    if (!m) throw Object.assign(new TypeError(`not an app id: ${appId}`), { code: 'config.invalid' });
    return `app-${m[1].toLowerCase()}`;
}

function loadConfig(env = process.env) {
    const mode = env.OV_EVENTS_MODE || 'pull';
    if (!['realtime', 'pull'].includes(mode)) throw Object.assign(new Error('OV_EVENTS_MODE must be pull or realtime'), { code: 'config.invalid' });
    const hasCreds = Boolean(env.OV_CLIENT_ID && env.OV_CLIENT_SECRET);
    if (mode === 'pull' && !hasCreds) {
        throw Object.assign(new Error('pull mode needs OV_CLIENT_ID and OV_CLIENT_SECRET (see .env.example)'), { code: 'config.missing' });
    }
    const topics = String(env.OV_TOPICS || '').split(',').map((t) => t.trim()).filter(Boolean);
    if (mode === 'realtime' && !topics.length) {
        throw Object.assign(new Error('realtime mode needs OV_TOPICS (public first-party topics, e.g. chat.message.created)'), { code: 'config.missing' });
    }
    return {
        mode,
        network: env.OV_NETWORK_URL || 'https://openvibe.network',
        clientId: env.OV_CLIENT_ID || null,
        clientSecret: env.OV_CLIENT_SECRET || null,
        projectId: env.OV_PROJECT_ID || null,
        eventsUrl: env.OV_EVENTS_URL || null,
        topics,                                         // empty in pull mode: your project's app.<project_key>.*
        cursorPath: env.OV_CURSOR_PATH || path.join(__dirname, 'data', 'cursor.json'),
        pollMs: Number(env.OV_POLL_MS || 5000),
    };
}

/** A tiny durable cursor: { realtime: seq, pull: seq } in a JSON file, replaced atomically. */
function createCursorStore(file) {
    let state = {};
    try { state = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { state = {}; }
    return {
        get: (name) => (Number.isFinite(state[name]) ? state[name] : null),
        set(name, seq) {
            if (!Number.isFinite(seq) || seq === state[name]) return;
            state = { ...state, [name]: seq };
            fs.mkdirSync(path.dirname(file), { recursive: true });
            const tmp = `${file}.${process.pid}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(state));
            fs.renameSync(tmp, file);
        },
    };
}

/**
 * createSubscriber(config, { onEvent, onResync, fetch, log })
 *   onEvent(event, { seq, via })       handle one event (may be async)
 *   onResync(gap, { via })             state derived from events may be stale: reload it
 */
function createSubscriber(config, { onEvent, onResync = () => {}, fetch, log = console, cursor = createCursorStore(config.cursorPath) } = {}) {
    if (typeof onEvent !== 'function') throw new TypeError('onEvent is required');
    const baseUrls = config.eventsUrl ? { events: config.eventsUrl } : undefined;
    const tokens = config.clientId && config.clientSecret
        ? createServiceTokenClient({ network: config.network, clientId: config.clientId, clientSecret: config.clientSecret, fetch })
        : null;
    // Pull runs as your app; realtime is anonymous (public events only), so it never sends the app token.
    const client = createClient({ network: config.network, fetch, tokenProvider: tokens || undefined, baseUrls });
    const anonymous = createClient({ network: config.network, fetch, baseUrls });
    const stats = { handled: 0, gaps: 0 };

    async function gap(g, via) {
        stats.gaps++;
        log.log(`[events] gap via ${via}: ${g.reason || 'pruned'} seq ${g.from_seq}..${g.to_seq}; resyncing`);
        await onResync(g, { via });
    }

    /** OV_TOPICS, or your project's own topic app.<project_key>.* (project id from OV_PROJECT_ID or the token). */
    let topics = config.topics.length ? config.topics : null;
    async function resolveTopics() {
        if (topics) return topics;
        let projectId = config.projectId;
        if (!projectId) {
            const info = await tokens.getTokenInfo({ audience: 'openvibe.events' });   // decoded, not verified: fine for naming
            projectId = info.unverifiedClaims && info.unverifiedClaims.project_id;
        }
        topics = [`app.${projectKey(projectId)}.*`];
        return topics;
    }

    // ── pull ────────────────────────────────────────────────
    const events = createEventsClient(client);
    /** Read from the saved cursor to the head once. Returns the number of events handled. */
    async function pullOnce({ limit = 100 } = {}) {
        let handled = 0;
        const iterator = events.iterate({
            topic: await resolveTopics(),
            afterSeq: cursor.get('pull') || 0,
            limit,
            onGap: (g) => gap(g, 'pull'),
            // After every item of the page was handled: also moves past events of other topics.
            onPage: (page) => cursor.set('pull', page.next_after_seq),
        });
        for await (const { seq, event } of iterator) {
            await onEvent(event, { seq, via: 'pull' });
            cursor.set('pull', seq);
            handled++;
            stats.handled++;
        }
        return handled;
    }

    let stopped = false;
    let timer = null;
    let sub = null;

    async function pollLoop() {
        while (!stopped) {
            try { await pullOnce(); } catch (err) {
                log.error(`[events] pull failed: ${isOpenVibeError(err) ? `${err.code}${err.detail ? `: ${err.detail}` : ''} request=${err.requestId}` : err.message}`);
            }
            if (stopped) break;
            await new Promise((r) => { timer = setTimeout(r, config.pollMs); });
        }
    }

    // ── realtime ────────────────────────────────────────────
    function startRealtime() {
        let chain = Promise.resolve();
        sub = subscribe(config.topics, (event, { seq }) => {
            // Handle strictly in order; save the cursor only after the handler finished.
            chain = chain.then(async () => {
                await onEvent(event, { seq, via: 'realtime' });
                cursor.set('realtime', seq);
                stats.handled++;
            }).catch((err) => log.error(`[events] handler failed at seq ${seq}: ${err.message}`));
        }, {
            client: anonymous,
            fetch,
            transport: 'fetch',
            lastEventId: cursor.get('realtime'),
            onGap: (g) => { chain = chain.then(() => gap(g, 'realtime')); },
            onOpen: () => log.log(`[events] realtime connected (${config.topics.join(', ')}) from seq ${sub ? sub.lastEventId : cursor.get('realtime')}`),
            onError: (err) => log.error(`[events] realtime: ${isOpenVibeError(err) ? err.code : err.message}`),
        });
        return sub;
    }

    return {
        client,
        stats,
        cursor,
        pullOnce,
        resolveTopics,
        start() {
            stopped = false;
            if (config.mode === 'pull') { pollLoop(); return null; }
            return startRealtime();
        },
        stop() {
            stopped = true;
            clearTimeout(timer);
            if (sub) sub.close();
        },
        get subscription() { return sub; },
    };
}

if (require.main === module) {
    let config;
    try { config = loadConfig(); } catch (err) { console.error(err.message); process.exit(2); }
    const s = createSubscriber(config, {
        onEvent(event, { seq, via }) {
            console.log(`${via} #${seq} ${event.event_type} ${event.event_id} subject=${event.subject && `${event.subject.type}:${event.subject.id}`}`);
        },
        onResync(gap) {
            console.log(`resync needed: events ${gap.from_seq}..${gap.to_seq} are gone; reload your state from its source`);
        },
    });
    s.start();
    if (config.mode === 'pull') {
        s.resolveTopics().then((t) => console.log(`pulling ${t.join(', ')} every ${config.pollMs} ms`), () => {});
    }
    const stop = () => { s.stop(); process.exit(0); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
}

module.exports = { loadConfig, createCursorStore, createSubscriber, projectKey, appSource };
