'use strict';
/**
 * Smoke test: subscription creation against the SDK's mock platform, then deliveries shaped and
 * signed exactly like OpenVibe.Events' delivery worker sends them (the mock has no delivery
 * worker, so this test plays that part with openvibe-sdk/events signDelivery()).
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMockPlatform } = require('openvibe-sdk/testing');
const { signDelivery } = require('openvibe-sdk/events');
const { ulid } = require('openvibe-sdk/core');
const { createConsumer, loadConfig, openDatabase } = require('../server');
const { createSubscription } = require('../subscribe');

const realFetch = globalThis.fetch;
globalThis.fetch = () => { throw new Error('network access in a smoke test'); };

const APP = 'app_01JEXAMPLEWEBHOOK000000000';
const SECRET = 'ovsec_webhook_consumer_test_secret';

function envelope(type = 'media.object.uploaded') {
    return {
        event_id: `evt_${ulid()}`, event_type: type, version: 1, source: 'media', timestamp: new Date().toISOString(),
        actor: { type: 'service', id: 'media' }, subject: { type: 'object', id: 'med_01JEXAMPLEOBJECT0000000000' }, payload: { size: 12 },
    };
}

/** POST a delivery the way the Events worker does. */
async function deliver(port, event, seq, secret, { attempt = 1, tamper, headers = {} } = {}) {
    const body = JSON.stringify({ event, seq });
    const sent = tamper ? tamper(body) : body;
    const res = await realFetch(`http://127.0.0.1:${port}/webhooks/openvibe`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-OpenVibe-Event-Id': event.event_id,
            'X-OpenVibe-Event-Type': event.event_type,
            'X-OpenVibe-Seq': String(seq),
            'X-OpenVibe-Subscription-Id': 'sub_test',
            'X-OpenVibe-Delivery-Attempt': String(attempt),
            'X-OpenVibe-Signature': signDelivery(body, secret),
            ...headers,
        },
        body: sent,
    });
    return { status: res.status, body: await res.json() };
}

(async () => {
    // 1. Create the subscription (events.subscription.manage) and keep the secret it was created with.
    const platform = createMockPlatform({
        clients: { [APP]: { secret: SECRET, grants: [{ capability: 'events.subscription.manage', audience: 'openvibe.events' }] } },
    });
    const created = await createSubscription(
        { network: 'https://openvibe.network', clientId: APP, clientSecret: SECRET },
        { topicPattern: 'media.object.*', endpoint: 'https://hooks.example.com/webhooks/openvibe' },
        { fetch: platform.fetch },
    );
    assert.match(created.subscription.id, /^sub_/);
    assert.equal(created.subscription.topic_pattern, 'media.object.*');
    assert.equal('secret' in created.subscription, false, 'the printable part never carries the secret');
    assert.match(created.secret, /^whsec_[0-9a-f]{64}$/);
    await assert.rejects(createSubscription({ network: 'https://openvibe.network', clientId: APP, clientSecret: SECRET },
        { topicPattern: 'x.y.*', endpoint: 'http://hooks.example.com/x' }, { fetch: platform.fetch }), /https/);

    // 2. Run the consumer with that secret.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-webhook-'));
    const config = loadConfig({ OV_WEBHOOK_SECRET: created.secret, OV_DB_PATH: path.join(dir, 'consumer.db') });
    const handled = [];
    let failNext = false;
    const logs = [];
    const consumer = createConsumer(config, {
        db: openDatabase(config.dbPath),
        handle(event) {
            if (failNext) { failNext = false; throw new Error('downstream unavailable'); }
            handled.push(event.event_id);
        },
        log: { log: (m) => logs.push(m), error: (m) => logs.push(m) },
    });
    await new Promise((r) => consumer.server.listen(0, '127.0.0.1', r));
    const { port } = consumer.server.address();

    const e1 = envelope();
    let r = await deliver(port, e1, 1, created.secret);
    assert.deepEqual(r, { status: 200, body: { ok: true, duplicate: false } });
    assert.deepEqual(handled, [e1.event_id]);

    // Redelivery (a retry after a lost 2xx, or a replay): acknowledged, not processed again.
    r = await deliver(port, e1, 1, created.secret, { attempt: 2 });
    assert.deepEqual(r, { status: 200, body: { ok: true, duplicate: true } });
    assert.deepEqual(handled, [e1.event_id]);

    // Wrong secret, tampered body, missing signature: 401 and no side effect.
    const e2 = envelope();
    assert.equal((await deliver(port, e2, 2, 'whsec_not_the_secret')).status, 401);
    assert.equal((await deliver(port, e2, 2, created.secret, { tamper: (b) => b.replace('"size":12', '"size":13') })).status, 401);
    assert.equal((await deliver(port, e2, 2, created.secret, { headers: { 'X-OpenVibe-Signature': '' } })).status, 401);
    assert.equal(handled.length, 1);

    // Header and signed body disagree on the event id: refused.
    assert.equal((await deliver(port, e2, 2, created.secret, { headers: { 'X-OpenVibe-Event-Id': 'evt_01JOTHER0000000000000000000' } })).status, 400);

    // A handler failure leaves no receipt: 500 now, processed on the retry.
    failNext = true;
    assert.equal((await deliver(port, e2, 2, created.secret)).status, 500);
    assert.equal(consumer.inbox.seen('webhook-consumer', e2.event_id), false);
    r = await deliver(port, e2, 2, created.secret, { attempt: 2 });
    assert.equal(r.status, 200);
    assert.deepEqual(handled, [e1.event_id, e2.event_id]);

    // Secret rotation: deliveries signed with the previous secret are accepted while it is configured.
    consumer.server.close();
    const rotated = createConsumer(loadConfig({ OV_WEBHOOK_SECRET: 'whsec_new', OV_WEBHOOK_SECRET_PREVIOUS: created.secret, OV_DB_PATH: config.dbPath }), {
        db: consumer.db, handle: (event) => handled.push(event.event_id), log: { log() {}, error() {} },
    });
    await new Promise((res) => rotated.server.listen(0, '127.0.0.1', res));
    const p2 = rotated.server.address().port;
    const e3 = envelope();
    assert.equal((await deliver(p2, e3, 3, created.secret)).status, 200);
    const e4 = envelope();
    assert.equal((await deliver(p2, e4, 4, 'whsec_new')).status, 200);
    assert.equal((await deliver(p2, e4, 4, 'whsec_new')).body.duplicate, true);
    assert.deepEqual(handled, [e1.event_id, e2.event_id, e3.event_id, e4.event_id]);

    // The receipt and the app's own row were written together.
    const rows = consumer.db.prepare('SELECT event_id FROM received_events ORDER BY seq').all().map((x) => x.event_id);
    assert.deepEqual(rows, handled);

    // Oversized bodies are refused before parsing.
    const big = await realFetch(`http://127.0.0.1:${p2}/webhooks/openvibe`, { method: 'POST', body: 'x'.repeat(1024 * 1024 + 10) });
    assert.equal(big.status, 413);

    // No secret in the logs.
    assert.ok(!logs.join('\n').includes(created.secret));

    rotated.server.close();
    consumer.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
    console.log('webhook-consumer: ok');
})().catch((err) => { console.error(err); process.exit(1); });
