#!/usr/bin/env node
'use strict';
/**
 * Webhook consumer: receives OpenVibe.Events deliveries, verifies their signature and handles each
 * event exactly once.
 *
 *   node --env-file=.env server.js        # POST http://localhost:3003/webhooks/openvibe
 *
 * A delivery is POSTed as { "event": <events.event-envelope@1> } (no sequence number: dedupe on the event id) with
 * X-OpenVibe-Timestamp: <unix seconds> and
 * X-OpenVibe-Signature-V2: t=<that timestamp>,v2=<HMAC-SHA256 of "<t>.<raw body>" with the subscription secret>
 * (plus the older body-only X-OpenVibe-Signature, which this consumer does not accept on its own).
 *
 *   1. Read the RAW body (the signature covers the exact bytes; never re-serialize JSON first).
 *   2. openvibe-sdk/events parseDelivery(..., { requireV2: true }) checks the v2 signature in
 *      constant time, refuses a timestamp more than 300 s from this clock or a missing v2 header
 *      (a replayed capture), and parses it. A bad signature is 401 and nothing else is said.
 *   3. Delivery is at least once (retries, replays). inbox.once() records the event id and runs
 *      the handler in ONE PostgreSQL transaction (openvibe-sdk/events createPgInbox), so a repeat is
 *      answered 200 without running it again, and a handler that throws leaves no receipt: the 500 makes
 *      Events retry later.
 *
 * The database is PostgreSQL: OV_DATABASE_URL, or an embedded PGlite in OV_DATA_DIR (default ./data/pg) when no URL
 * is set, so the example runs with nothing installed but Node.
 *
 * Secret rotation: set OV_WEBHOOK_SECRET_PREVIOUS to the old secret while both are in use.
 */
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { createDb, sql } = require('openvibe-sdk/db');
const { parseDelivery, createPgInbox, inboxSchema } = require('openvibe-sdk/events');

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
        databaseUrl: env.OV_DATABASE_URL || null,
        dataDir: env.OV_DATA_DIR || path.join(__dirname, 'data', 'pg'),
        port: Number(env.OV_PORT || 3003),
        path: env.OV_WEBHOOK_PATH || '/webhooks/openvibe',
    };
}

/** The database and its two tables: the inbox's receipts and the app's own row per event. */
async function openDatabase(config) {
    let db;
    if (config.databaseUrl) db = createDb({ url: config.databaseUrl, service: 'webhook-consumer' });
    else {
        if (config.dataDir !== 'memory') fs.mkdirSync(config.dataDir, { recursive: true });
        db = createDb({ pglite: config.dataDir === 'memory' ? true : config.dataDir, service: 'webhook-consumer' });
    }
    await db.query(inboxSchema());
    await db.query(`CREATE TABLE IF NOT EXISTS received_events (
        id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        event_id    text NOT NULL UNIQUE,
        event_type  text NOT NULL,
        source      text NOT NULL,
        subject     text,
        received_at timestamptz NOT NULL DEFAULT now()
    )`);
    return db;
}

/**
 * createConsumer(config, { db, handle, log })   db: from openDatabase(config)
 *   handle(event, { attempt }, t) runs inside the inbox transaction (t, the transaction handle: write with it and the
 *   write commits with the receipt). Put side effects that need the network in your own outbox table instead.
 */
function createConsumer(config, { db, handle = () => {}, log = console } = {}) {
    if (!db) throw new TypeError('createConsumer: pass { db } from openDatabase(config)');
    const inbox = createPgInbox(db);

    function verify(raw, headers) {
        for (const secret of config.secrets) {
            const d = parseDelivery(raw, headers, secret, { requireV2: true });
            if (d) return d;
        }
        return null;
    }

    async function receive(raw, headers) {
        const delivery = verify(raw, headers);
        if (!delivery) return { status: 401, body: { error: 'bad_signature' } };
        const { event, attempt } = delivery;
        if (!event || typeof event.event_id !== 'string' || typeof event.event_type !== 'string') return { status: 400, body: { error: 'bad_envelope' } };
        // The header is informational; the signed body is the truth. They must agree.
        const headerId = headers['x-openvibe-event-id'];
        if (headerId && headerId !== event.event_id) return { status: 400, body: { error: 'event_id_mismatch' } };
        const out = await inbox.once(CONSUMER, event.event_id, async (t) => {
            await t.exec(sql`INSERT INTO received_events (event_id, event_type, source, subject)
                VALUES (${event.event_id}, ${event.event_type}, ${String(event.source || '')}, ${event.subject ? `${event.subject.type}:${event.subject.id}` : null})`);
            return await handle(event, { attempt }, t);
        });
        log.log(`[webhook] ${event.event_type} ${event.event_id} attempt=${attempt}${out.duplicate ? ' (duplicate, skipped)' : ''}`);
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
        req.on('end', async () => {
            if (tooLarge) return send(413, { error: 'too_large' });
            try {
                const out = await receive(Buffer.concat(chunks), req.headers);
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
    openDatabase(config).then((db) => {
        const { server } = createConsumer(config, {
            db,
            async handle(event, meta, t) {
                // Your side effect goes here: write with `t` and it commits with the receipt.
            },
        });
        server.listen(config.port, () => console.log(`webhook-consumer: POST http://localhost:${config.port}${config.path}`));
    }).catch((err) => { console.error(`webhook-consumer: ${err.message}`); process.exit(1); });
}

module.exports = { loadConfig, openDatabase, createConsumer, CONSUMER };
