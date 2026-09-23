'use strict';
/**
 * Smoke test: the app creates its subscription (events.app.subscribe) on the SDK's mock platform,
 * then the mock's delivery worker (deliverEvents) POSTs signed deliveries to the consumer running
 * on a local port: exactly once, retry after a handler failure, secret rotation. Attacks (wrong
 * secret, tampered body, forged header) are crafted by hand. mock-app-events.js adds Events'
 * developer-app rules in front of the mock (the SDK mock has no events.app.*). No network.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMockPlatform } = require('openvibe-sdk/testing');
const { signDelivery } = require('openvibe-sdk/events');
const { createConsumer, loadConfig, openDatabase } = require('../server');
const { createSubscription, loadConfig: loadSubscribeConfig, projectKey } = require('../subscribe');
const { createAppEventsFetch } = require('./mock-app-events');

const realFetch = globalThis.fetch;
globalThis.fetch = () => { throw new Error('network access in a smoke test'); };

const ENDPOINT = 'https://hooks.example.com/webhooks/openvibe';

(async () => {
    const platform = createMockPlatform();
    const fetch = createAppEventsFetch(platform);
    const app = platform.addApp({ env: 'sandbox', grants: ['events.app.subscribe'] });
    const noGrant = platform.addApp({ env: 'sandbox', project: app.projectId, grants: ['events.app.read'] });
    const key = projectKey(app.projectId);
    const subEnv = { OV_CLIENT_ID: app.id, OV_CLIENT_SECRET: app.secret };

    // 1. Create the subscription: the project's own topic by default, https only, own project only.
    const created = await createSubscription(loadSubscribeConfig(subEnv), { endpoint: ENDPOINT }, { fetch });
    assert.match(created.subscription.id, /^sub_/);
    assert.equal(created.subscription.topic_pattern, `app.${key}.*`);
    assert.equal('secret' in created.subscription, false, 'the printable part never carries the secret');
    assert.match(created.secret, /^whsec_[0-9a-f]{64}$/);
    await assert.rejects(createSubscription(loadSubscribeConfig(subEnv), { endpoint: 'http://hooks.example.com/x' }, { fetch }), /https/);
    await assert.rejects(createSubscription(loadSubscribeConfig(subEnv), { endpoint: ENDPOINT, topicPattern: 'app.pother.*' }, { fetch }),
        (err) => err.status === 403 && err.code === 'events.topic_not_allowed');
    await assert.rejects(createSubscription(loadSubscribeConfig(subEnv), { endpoint: ENDPOINT, topicPattern: '*' }, { fetch }),
        (err) => err.code === 'events.topic_not_allowed');
    await assert.rejects(createSubscription(loadSubscribeConfig({ OV_CLIENT_ID: noGrant.id, OV_CLIENT_SECRET: noGrant.secret }), { endpoint: ENDPOINT }, { fetch }),
        (err) => err.code === 'invalid_scope', 'no events.app.subscribe grant: Network issues no token for it');

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
    let local = `http://127.0.0.1:${consumer.server.address().port}/webhooks/openvibe`;

    // The mock's delivery worker POSTs to the subscription's https endpoint; route it to the local
    // consumer and keep what was sent (to replay one later, like a retry after a lost 2xx).
    const sent = [];
    const worker = (url, init) => {
        assert.equal(url, ENDPOINT);
        sent.push({ body: init.body, headers: init.headers });
        return realFetch(local, init);
    };
    const appEvent = (name) => platform.publishEvent({
        event_type: `app.${key}.${name}`, source: `app-${app.id.slice(4).toLowerCase()}`,
        actor: { type: 'app', id: app.id }, subject: { type: 'order', id: '42' }, payload: { size: 12 },
    }, `app:${app.id}`);

    const e1 = appEvent('order.created');
    platform.publishEvent({ event_type: 'live.stream.started', source: 'live', actor: { type: 'service', id: 'live' }, subject: { type: 'stream', id: '1' } });
    let round = await platform.deliverEvents({ fetch: worker });
    assert.deepEqual([round.delivered, round.failed], [1, 0], 'only the subscribed topic is delivered');
    assert.deepEqual(handled, [e1.event_id]);
    const firstDelivery = sent[0];
    assert.equal(firstDelivery.headers['X-OpenVibe-Event-Id'], e1.event_id);

    // Redelivery of the same bytes (a retry after a lost 2xx, or a replay): acknowledged, not processed again.
    const replay = async (d, extra = {}, body = d.body) => {
        const res = await realFetch(local, { method: 'POST', headers: { ...d.headers, ...extra }, body });
        return { status: res.status, body: await res.json() };
    };
    assert.deepEqual(await replay(firstDelivery, { 'X-OpenVibe-Delivery-Attempt': '2' }), { status: 200, body: { ok: true, duplicate: true } });
    assert.deepEqual(handled, [e1.event_id]);

    // A handler failure leaves no receipt: the worker sees a 500, retries on its next round (attempt 2).
    const e2 = appEvent('order.paid');
    failNext = true;
    round = await platform.deliverEvents({ fetch: worker });
    assert.equal(round.failed, 1);
    assert.equal(round.attempts[0].status, 500);
    assert.equal(consumer.inbox.seen('webhook-consumer', e2.event_id), false);
    round = await platform.deliverEvents({ fetch: worker });
    assert.deepEqual([round.delivered, round.attempts[0].attempt], [1, 2]);
    assert.deepEqual(handled, [e1.event_id, e2.event_id]);

    // Attacks: wrong secret, tampered body, missing signature: 401 and no side effect.
    const last = sent.at(-1);
    const e3 = appEvent('order.refunded');
    const forgedBody = last.body.replaceAll(e2.event_id, e3.event_id);
    assert.equal((await replay(last, { 'X-OpenVibe-Signature': signDelivery(forgedBody, 'whsec_not_the_secret'), 'X-OpenVibe-Event-Id': e3.event_id }, forgedBody)).status, 401);
    assert.equal((await replay(last, { 'X-OpenVibe-Event-Id': e3.event_id }, forgedBody)).status, 401, 'changed bytes, old signature');
    assert.equal((await replay(last, { 'X-OpenVibe-Signature': '' })).status, 401);
    // Header and signed body disagree on the event id: refused.
    assert.equal((await replay(last, { 'X-OpenVibe-Event-Id': e3.event_id })).status, 400);
    assert.deepEqual(handled, [e1.event_id, e2.event_id]);

    // Secret rotation: deliveries signed with the previous secret are accepted while it is configured.
    consumer.server.close();
    const rotated = createConsumer(loadConfig({ OV_WEBHOOK_SECRET: 'whsec_new_secret_after_rotation_0000000000', OV_WEBHOOK_SECRET_PREVIOUS: created.secret, OV_DB_PATH: config.dbPath }), {
        db: consumer.db, handle: (event) => handled.push(event.event_id), log: { log() {}, error() {} },
    });
    await new Promise((res) => rotated.server.listen(0, '127.0.0.1', res));
    local = `http://127.0.0.1:${rotated.server.address().port}/webhooks/openvibe`;
    round = await platform.deliverEvents({ fetch: worker });              // e3, still signed with the old secret
    assert.equal(round.delivered, 1);
    platform.state.subscriptions.get(created.subscription.id).secret = 'whsec_new_secret_after_rotation_0000000000';
    const e4 = appEvent('order.closed');
    round = await platform.deliverEvents({ fetch: worker });              // e4, signed with the new one
    assert.equal(round.delivered, 1);
    assert.deepEqual(handled, [e1.event_id, e2.event_id, e3.event_id, e4.event_id]);

    // The receipt and the app's own row were written together.
    const rows = consumer.db.prepare('SELECT event_id FROM received_events ORDER BY seq').all().map((x) => x.event_id);
    assert.deepEqual(rows, handled);

    // Oversized bodies are refused before parsing.
    const big = await realFetch(local, { method: 'POST', body: 'x'.repeat(1024 * 1024 + 10) });
    assert.equal(big.status, 413);

    // No secret in the logs.
    assert.ok(!logs.join('\n').includes(created.secret));

    rotated.server.close();
    consumer.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
    console.log('webhook-consumer: ok');
})().catch((err) => { console.error(err); process.exit(1); });
