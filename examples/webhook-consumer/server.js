#!/usr/bin/env node
'use strict';
/**
 * Webhook consumer: receives OpenVibe.Events deliveries, verifies their signature and handles each
 * event exactly once.
 *
 *   node --env-file=.env server.js        # POST http://localhost:3003/webhooks/openvibe
 *
 * A delivery is POSTed as { "event": <events.event-envelope@1>, "seq": <n> } with
 * X-OpenVibe-Timestamp: <unix seconds> and
 * X-OpenVibe-Signature-V2: t=<that timestamp>,v2=<HMAC-SHA256 of "<t>.<raw body>" with the subscription secret>
 * (plus the older body-only X-OpenVibe-Signature, which this consumer does not accept on its own).
 *
 *   1. Read the RAW body (the signature covers the exact bytes; never re-serialize JSON first).
 *   2. openvibe-sdk/events parseDelivery(..., { requireV2: true }) checks the v2 signature in
 *      constant time, refuses a timestamp more than 300 s from this clock or a missing v2 header
 *      (a replayed capture), and parses it. A bad signature is 401 and nothing else is said.
 *   3. Delivery is at least once (retries, replays). inbox.once() records the event id and runs
 *      the handler in ONE SQLite transaction, so a repeat is answered 200 without running it again,
 *      and a handler that throws leaves no receipt: the 500 makes Events retry later.
 *
 * Secret rotation: set OV_WEBHOOK_SECRET_PREVIOUS to the old secret while both are in use.
 */
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const Database = require('better-sqlite3');
const { parseDelivery, createInbox } = require('openvibe-sdk/events');

const MAX_BODY = 1024 * 1024;
const CONSUMER = 'webhook-consumer';

function loadConfig(env = process.env) {
    if (!env.OV_WEBHOOK_SECRET) {
        const err = new Error('missing environment variable: OV_WEBHOOK_SECRET (see .env.example)');
        err.code = 'config.missing';
        throw err;
    }
    return {
        secrets: [env.OV_WEBHOOK_SECRET, env.OV_WEBHOOK_SECRET_PREVIOUS].filter(Boolean),
        dbPath: env.OV_DB_PATH || path.join(__dirname, 'data', 'webhook-consumer.db'),
        port: Number(env.OV_PORT || 3003),
        path: env.OV_WEBHOOK_PATH || '/webhooks/openvibe',
    };
}

function openDatabase(dbPath) {
    if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.exec(`CREATE TABLE IF NOT EXISTS received_events (
        event_id    TEXT PRIMARY KEY,
        event_type  TEXT NOT NULL,
        source      TEXT NOT NULL,
        seq         INTEGER,
        subject     TEXT,
        received_at TEXT NOT NULL
    )`);
    return db;
}

/**
 * createConsumer(config, { db, handle, log })
 *   handle(event, { seq, attempt }) runs inside the inbox transaction and must be synchronous
 *   (better-sqlite3). Put side effects that need the network in your own outbox table instead.
 */
function createConsumer(config, { db = openDatabase(config.dbPath), handle = () => {}, log = console } = {}) {
    const inbox = createInbox(db);
    inbox.ensureSchema();
    const record = db.prepare('INSERT INTO received_events (event_id, event_type, source, seq, subject, received_at) VALUES (?, ?, ?, ?, ?, ?)');

    function verify(raw, headers) {
        for (const secret of config.secrets) {
            const d = parseDelivery(raw, headers, secret, { requireV2: true });
            if (d) return d;
        }
        return null;
    }

    function receive(raw, headers) {
        const delivery = verify(raw, headers);
        if (!delivery) return { status: 401, body: { error: 'bad_signature' } };
        const { event, seq, attempt } = delivery;
        if (!event || typeof event.event_id !== 'string' || typeof event.event_type !== 'string') return { status: 400, body: { error: 'bad_envelope' } };
        // The header is informational; the signed body is the truth. They must agree.
        const headerId = headers['x-openvibe-event-id'];
        if (headerId && headerId !== event.event_id) return { status: 400, body: { error: 'event_id_mismatch' } };
        const out = inbox.once(CONSUMER, event.event_id, () => {
            record.run(event.event_id, event.event_type, String(event.source || ''), Number.isFinite(seq) ? seq : null,
                event.subject ? `${event.subject.type}:${event.subject.id}` : null, new Date().toISOString());
            return handle(event, { seq, attempt });
        });
        log.log(`[webhook] ${event.event_type} ${event.event_id} seq=${seq} attempt=${attempt}${out.duplicate ? ' (duplicate, skipped)' : ''}`);
        return { status: 200, body: { ok: true, duplicate: out.duplicate } };
    }

    const server = http.createServer((req, res) => {
        const send = (status, body) => {
            res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(body));
        };
        const url = new URL(req.url, 'http://consumer.invalid');
        if (req.method === 'GET' && url.pathname === '/healthz') return send(200, { ok: true });
        if (req.method !== 'POST' || url.pathname !== config.path) return send(404, { error: 'not_found' });
        const chunks = [];
        let size = 0;
        let tooLarge = false;
        req.on('data', (c) => {
            size += c.length;
            if (size > MAX_BODY) { tooLarge = true; chunks.length = 0; return; }
            chunks.push(c);
        });
        req.on('end', () => {
            if (tooLarge) return send(413, { error: 'too_large' });
            try {
                const out = receive(Buffer.concat(chunks), req.headers);
                send(out.status, out.body);
            } catch (err) {
                // No receipt was written: Events retries this delivery with backoff.
                log.error(`[webhook] handler failed: ${err.message}`);
                send(500, { error: 'handler_failed' });
            }
        });
    });

    return { server, db, inbox, receive };
}

if (require.main === module) {
    let config;
    try { config = loadConfig(); } catch (err) { console.error(err.message); process.exit(2); }
    const { server } = createConsumer(config, {
        handle(event) {
            // Your side effect goes here (synchronous, same transaction as the receipt).
        },
    });
    server.listen(config.port, () => console.log(`webhook-consumer: POST http://localhost:${config.port}${config.path}`));
}

module.exports = { loadConfig, openDatabase, createConsumer, CONSUMER };
