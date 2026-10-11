#!/usr/bin/env node
'use strict';
/**
 * Event subscriber: follow OpenVibe.Events topics without losing or double-handling events.
 *
 *   node --env-file=.env subscriber.js
 *
 * Two ways in, one cursor discipline:
 *
 *   pull      GET /api/v1/events through openvibe-sdk/events createAppEvents().iterate(), from the
 *             saved cursor, as your developer app (events.app.read, audience openvibe.events).
 *             OV_TOPICS are relative to your project (`order.*`; default `*`, i.e. all of
 *             app.<project_key>.*); OV_PLATFORM_TOPICS adds public first-party topics
 *             (live.stream.*). Another project's app.* topics are refused.
 *   realtime  GET /realtime/stream (SSE) through openvibe-sdk/realtime subscribe(), anonymously:
 *             public first-party events only. Events never streams app.* events over realtime.
 *             Resumes with Last-Event-ID from the saved cursor after a restart or a drop.
 *
 * The cursor is saved only AFTER an event was handled, so a crash replays at most the event in
 * hand (make your handler idempotent on event_id). In pull mode the cursor also moves past events
 * that did not match the topic, to the page's next_cursor: iterate() calls onPage only after
 * every item of that page was handled, so saving it there is crash-safe. Every position saved is
 * Events' opaque cursor (ADR-042): keep it as a string and hand it back; never compute with it.
 *
 * A gap means Events can no longer give you part of the range (retention pruned it: sandbox app
 * events are kept 7 days; or the cursor is ahead of the stream after a restore). Nothing can replay
 * it, so the subscriber calls onResync(gap): reload whatever state you derive from these events.
 */
const fs = require('node:fs');
const path = require('node:path');
const { createClient, isOpenVibeError } = require('openvibe-sdk/core');
const { createServiceTokenClient } = require('openvibe-sdk/auth');
const { createAppEvents, projectKey, appSource } = require('openvibe-sdk/events');
const { subscribe } = require('openvibe-sdk/realtime');

function loadConfig(env = process.env) {
    const mode = env.OV_EVENTS_MODE || 'pull';
    if (!['realtime', 'pull'].includes(mode)) throw Object.assign(new Error('OV_EVENTS_MODE must be pull or realtime'), { code: 'config.invalid' });
    const hasCreds = Boolean(env.OV_CLIENT_ID && env.OV_CLIENT_SECRET);
    if (mode === 'pull' && !hasCreds) {
        throw Object.assign(new Error('pull mode needs OV_CLIENT_ID and OV_CLIENT_SECRET (see .env.example)'), { code: 'config.missing' });
    }
    const list = (v) => String(v || '').split(',').map((t) => t.trim()).filter(Boolean);
    const topics = list(env.OV_TOPICS);
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
        topics,                                         // pull: project-relative (empty = '*'); realtime: first-party
        platformTopics: list(env.OV_PLATFORM_TOPICS),   // pull only: public first-party topics as well
        cursorPath: env.OV_CURSOR_PATH || path.join(__dirname, 'data', 'cursor.json'),
        pollMs: Number(env.OV_POLL_MS || 5000),
    };
}

/** A tiny durable cursor: { realtime: <cursor>, pull: <cursor> } in a JSON file, replaced atomically. */
function createCursorStore(file) {
    let state = {};
    try { state = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { state = {}; }
    const usable = (v) => typeof v === 'string' && v.length > 0;
    return {
        get: (name) => (usable(state[name]) ? state[name] : null),
        set(name, cursor) {
            if (!usable(cursor) || cursor === state[name]) return;
            state = { ...state, [name]: cursor };
            fs.mkdirSync(path.dirname(file), { recursive: true });
            const tmp = `${file}.${process.pid}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(state));
            fs.renameSync(tmp, file);
        },
    };
}

/**
 * createSubscriber(config, { onEvent, onResync, fetch, log })
 *   onEvent(event, { cursor, via })    handle one event (may be async); dedupe on event.event_id
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

    /** The app-scoped events client: the project id comes from OV_PROJECT_ID or the app token. */
    let appEvents = null;
    async function eventsForApp() {
        if (appEvents) return appEvents;
        let projectId = config.projectId;
        if (!projectId) {
            const info = await tokens.getTokenInfo({ audience: 'openvibe.events' });   // decoded, not verified: fine for naming
            projectId = info.unverifiedClaims && info.unverifiedClaims.project_id;
        }
        appEvents = createAppEvents(client, { projectId, appId: config.clientId });
        return appEvents;
    }
    /** The full topic patterns a pull reads: app.<project_key>.<OV_TOPICS or *>, plus OV_PLATFORM_TOPICS. */
    async function resolveTopics() {
        const ev = await eventsForApp();
        return [...(config.topics.length ? config.topics : ['*']).map(ev.topic), ...config.platformTopics];
    }

    // ── pull ────────────────────────────────────────────────
    /** Read from the saved cursor to the head once. Returns the number of events handled. */
    async function pullOnce({ limit = 100 } = {}) {
        const ev = await eventsForApp();
        let handled = 0;
        const iterator = ev.iterate({
            topic: config.topics.length ? config.topics : '*',
            platformTopics: config.platformTopics,
            ...(cursor.get('pull') ? { after: cursor.get('pull') } : {}),
            limit,
            onGap: (g) => gap(g, 'pull'),
            // After every item of the page was handled: also moves past events of other topics.
            onPage: (page) => cursor.set('pull', page.next_cursor),
        });
        for await (const { cursor: at, event } of iterator) {
            await onEvent(event, { cursor: at, via: 'pull' });
            cursor.set('pull', at);
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
        sub = subscribe(config.topics, (event, { cursor: at }) => {
            // Handle strictly in order; save the cursor (the event's SSE id) only after the handler finished.
            chain = chain.then(async () => {
                await onEvent(event, { cursor: at, via: 'realtime' });
                cursor.set('realtime', at);
                stats.handled++;
            }).catch((err) => log.error(`[events] handler failed at ${event.event_id}: ${err.message}`));
        }, {
            client: anonymous,
            fetch,
            transport: 'fetch',
            lastEventId: cursor.get('realtime'),
            onGap: (g) => { chain = chain.then(() => gap(g, 'realtime')); },
            onOpen: () => log.log(`[events] realtime connected (${config.topics.join(', ')}) from ${(sub ? sub.lastEventId : cursor.get('realtime')) || 'now'}`),
            onError: (err) => log.error(`[events] realtime: ${isOpenVibeError(err) ? err.code : err.message}`),
        });
        return sub;
    }

    /** Start pulling from now: the pull cursor becomes Events' head (latest_cursor), so history is skipped. → the cursor */
    async function startAtHead() {
        const ev = await eventsForApp();
        const page = await ev.pull({ topic: config.topics.length ? config.topics : '*', platformTopics: config.platformTopics, limit: 1 });
        if (page.latest_cursor) cursor.set('pull', page.latest_cursor);
        return page.latest_cursor || null;
    }

    return {
        client,
        stats,
        cursor,
        pullOnce,
        startAtHead,
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
        onEvent(event, { via }) {
            console.log(`${via} ${event.event_type} ${event.event_id} subject=${event.subject && `${event.subject.type}:${event.subject.id}`}`);
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

module.exports = { loadConfig, createCursorStore, createSubscriber };
