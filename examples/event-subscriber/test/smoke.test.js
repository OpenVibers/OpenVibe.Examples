'use strict';
/**
 * Smoke test: publish to the project's own topic, pull it with a durable cursor as the app, gap
 * handling after retention, and anonymous realtime with resume. Network and Events (incl.
 * /realtime/stream and Events' developer-app rules) are openvibe-sdk/testing's mock platform.
 * No network.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMockPlatform } = require('openvibe-sdk/testing');
const { projectKey, appSource } = require('openvibe-sdk/events');
const { createSubscriber, loadConfig, createCursorStore } = require('../subscriber');
const { publishAppEvent, loadConfig: loadPublishConfig } = require('../publish');

globalThis.fetch = () => { throw new Error('network access in a smoke test'); };

const quiet = { log() {}, error() {} };

async function waitFor(check, what, ms = 3000) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
        if (check()) return;
        await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`timed out waiting for ${what}`);
}

const firstParty = (visibility = 'public', type = 'media.object.uploaded') => ({
    event_type: type, source: 'media', visibility,
    actor: { type: 'service', id: 'media' }, subject: { type: 'object', id: 'med_01JEXAMPA0BJECT0000000000' },
});

(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-subscriber-'));
    const platform = createMockPlatform();
    const { fetch } = platform;
    // A sandbox app (the default for a new project) with the events grants, and one of another project.
    const app = platform.addApp({ env: 'sandbox', grants: ['events.app.publish', 'events.app.read'] });
    const other = platform.addApp({ env: 'sandbox', grants: ['events.app.publish', 'events.app.read'] });
    const publishOnly = platform.addApp({ env: 'sandbox', project: app.projectId, grants: ['events.app.publish'] });

    // Names: project_key and source exactly as Events defines them.
    assert.equal(projectKey('prj_01JAB2C3D4E5F6G7H8J9K0MNPQ'), 'p01jab2c3d4e5f6g7h8j9k0mnpq');
    assert.equal(appSource('app_01JAB2C3D4E5F6G7H8J9K0MNPQ'), 'app-01jab2c3d4e5f6g7h8j9k0mnpq');
    assert.equal(appSource('app:app_01JAB2C3D4E5F6G7H8J9K0MNPQ'), 'app-01jab2c3d4e5f6g7h8j9k0mnpq');
    const key = projectKey(app.projectId);

    // ── publish to the own topic ────────────────────────────
    const env = { OV_CLIENT_ID: app.id, OV_CLIENT_SECRET: app.secret };
    const pub = (e, opts) => publishAppEvent(loadPublishConfig(e || env), opts || {}, { fetch });
    const a = await pub(env, { name: 'order.created', payload: { total: 3 } });
    assert.equal(a.event_type, `app.${key}.order.created`);
    assert.equal(a.duplicate, false);
    const stored = platform.state.events.find((x) => x.event.event_id === a.event_id).event;
    assert.equal(stored.source, appSource(app.id));
    assert.deepEqual(stored.actor, { type: 'app', id: app.id });
    // Same event_id again: Events answers with the stored seq, nothing new.
    assert.equal((await pub(env, { name: 'order.created', eventId: a.event_id })).duplicate, true);
    await assert.rejects(pub(env, { name: 'Bad Name' }), /dot-separated/);

    platform.publishEvent(firstParty('public', 'live.stream.started'));          // first-party, another topic
    await pub({ OV_CLIENT_ID: other.id, OV_CLIENT_SECRET: other.secret }, { name: 'order.created' });   // another project
    platform.publishEvent(firstParty('internal', `app.${key}.forged`));         // not from this project's apps: never shown
    const b = await pub(env, { name: 'order.paid' });

    // ── pull: own topic by default, durable cursor ──────────
    const pullEnv = { ...env, OV_CURSOR_PATH: path.join(dir, 'pull.json') };
    let seen = [];
    let s = createSubscriber(loadConfig(pullEnv), { fetch, log: quiet, onEvent: (e, { seq }) => { seen.push(seq); } });
    assert.deepEqual(await s.resolveTopics(), [`app.${key}.*`], 'the project id comes from the app token');
    assert.equal(await s.pullOnce({ limit: 2 }), 2);
    assert.deepEqual(seen, [a.seq, b.seq], 'own project only: not the other project, not the forged one');
    const head = platform.state.events.at(-1).seq;
    assert.equal(createCursorStore(pullEnv.OV_CURSOR_PATH).get('pull'), head, 'cursor saved at the head');

    // A new process resumes from the cursor: only what is new.
    const c = await pub(env, { name: 'order.shipped' });
    seen = [];
    s = createSubscriber(loadConfig(pullEnv), { fetch, log: quiet, onEvent: (e, { seq }) => { seen.push(seq); } });
    assert.equal(await s.pullOnce(), 1);
    assert.deepEqual(seen, [c.seq]);

    // A handler that fails leaves the cursor on the last event that succeeded.
    const d = await pub(env);
    const e = await pub(env);
    seen = [];
    s = createSubscriber(loadConfig(pullEnv), {
        fetch, log: quiet,
        onEvent: (ev, { seq }) => { if (seq === e.seq) throw new Error('boom'); seen.push(seq); },
    });
    await assert.rejects(s.pullOnce(), /boom/);
    assert.equal(createCursorStore(pullEnv.OV_CURSOR_PATH).get('pull'), d.seq);
    s = createSubscriber(loadConfig(pullEnv), { fetch, log: quiet, onEvent: (ev, { seq }) => { seen.push(seq); } });
    await s.pullOnce();
    assert.deepEqual(seen, [d.seq, e.seq], 'the failed event is retried, nothing is skipped');

    // A gap: retention pruned the range the cursor still needs. onResync is told, reading continues.
    const gapEnv = { ...env, OV_CURSOR_PATH: path.join(dir, 'gap.json') };
    createCursorStore(gapEnv.OV_CURSOR_PATH).set('pull', a.seq);
    platform.pruneEvents(c.seq);
    const f = await pub(env);
    const resyncs = [];
    seen = [];
    s = createSubscriber(loadConfig(gapEnv), { fetch, log: quiet, onEvent: (ev, { seq }) => { seen.push(seq); }, onResync: (g, { via }) => resyncs.push({ ...g, via }) });
    await s.pullOnce();
    assert.deepEqual(resyncs, [{ from_seq: a.seq + 1, to_seq: c.seq, via: 'pull' }]);
    assert.deepEqual(seen, [d.seq, e.seq, f.seq]);

    // Public first-party topics can be added (the earlier one was pruned: publish another).
    platform.publishEvent(firstParty('public', 'live.stream.started'));
    platform.publishEvent(firstParty('internal', 'live.stream.ended'));       // internal: never to an app
    const withPlatform = [];
    s = createSubscriber(loadConfig({ ...env, OV_TOPICS: 'order.*', OV_PLATFORM_TOPICS: 'live.stream.*', OV_CURSOR_PATH: path.join(dir, 'platform.json') }), {
        fetch, log: quiet, onEvent: (ev) => { withPlatform.push(ev.event_type); },
    });
    assert.deepEqual(await s.resolveTopics(), [`app.${key}.order.*`, 'live.stream.*']);
    await s.pullOnce();
    assert.ok(withPlatform.includes('live.stream.started'), 'public first-party events as well');
    assert.ok(!withPlatform.includes('live.stream.ended'), 'but never internal ones');
    assert.ok(withPlatform.every((t) => t === 'live.stream.started' || t.startsWith(`app.${key}.order.`)), 'only the asked-for topics');

    // Another project's topic is refused (the SDK refuses to build it; Events would answer 403);
    // so is a pull without events.app.read.
    s = createSubscriber(loadConfig({ ...pullEnv, OV_TOPICS: `app.${projectKey(other.projectId)}.*` }), { fetch, log: quiet, onEvent() {} });
    await assert.rejects(s.pullOnce(), /another project/);
    s = createSubscriber(loadConfig({ ...pullEnv, OV_CLIENT_ID: publishOnly.id, OV_CLIENT_SECRET: publishOnly.secret }), { fetch, log: quiet, onEvent() {} });
    await assert.rejects(s.pullOnce(), (err) => err.status === 403 && err.code === 'capability.denied');

    // Pull needs credentials; realtime needs topics but no credentials.
    assert.throws(() => loadConfig({}), /OV_CLIENT_ID/);
    assert.throws(() => loadConfig({ OV_EVENTS_MODE: 'realtime' }), /OV_TOPICS/);

    // ── realtime: anonymous, public first-party events only, resume ──
    const rtEnv = { OV_EVENTS_MODE: 'realtime', OV_TOPICS: 'media.object.*', OV_CURSOR_PATH: path.join(dir, 'realtime.json') };
    const live = [];
    const rt = createSubscriber(loadConfig(rtEnv), { fetch, log: quiet, onEvent: (ev, { seq }) => { live.push({ seq, type: ev.event_type }); } });
    const subscription = rt.start();
    await waitFor(() => subscription.connected, 'the realtime connection');
    const p1 = platform.publishEvent(firstParty());
    platform.publishEvent(firstParty('internal'));                           // never reaches an anonymous viewer
    const p2 = platform.publishEvent(firstParty('public', 'media.object.deleted'));
    await waitFor(() => live.length === 2, 'two public events');
    assert.deepEqual(live.map((x) => x.seq), [p1.seq, p2.seq]);
    await waitFor(() => createCursorStore(rtEnv.OV_CURSOR_PATH).get('realtime') === p2.seq, 'the realtime cursor');

    // The connection drops; an event published meanwhile arrives once after the reconnect.
    platform.dropRealtime();
    const p3 = platform.publishEvent(firstParty());
    await waitFor(() => live.length === 3, 'the event published during the drop');
    assert.equal(live[2].seq, p3.seq);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(live.length, 3, 'no duplicates after resuming');
    rt.stop();

    // A restart resumes from the saved cursor: the event published while stopped is delivered.
    const p4 = platform.publishEvent(firstParty());
    const after = [];
    const rt2 = createSubscriber(loadConfig(rtEnv), { fetch, log: quiet, onEvent: (ev, { seq }) => { after.push(seq); } });
    rt2.start();
    await waitFor(() => after.length === 1, 'the event published while stopped');
    assert.deepEqual(after, [p4.seq]);
    rt2.stop();

    // A cursor ahead of the stream (restored from another environment): a gap, then live events.
    const aheadPath = path.join(dir, 'ahead.json');
    createCursorStore(aheadPath).set('realtime', 9999);
    const rtGaps = [];
    const rt3 = createSubscriber(loadConfig({ ...rtEnv, OV_CURSOR_PATH: aheadPath }), { fetch, log: quiet, onEvent() {}, onResync: (g, { via }) => rtGaps.push({ ...g, via }) });
    rt3.start();
    await waitFor(() => rtGaps.length === 1, 'the realtime gap');
    assert.equal(rtGaps[0].reason, 'cursor_ahead');
    assert.equal(rtGaps[0].via, 'realtime');
    rt3.stop();

    // Realtime never carried credentials, even with an app configured.
    const streamCalls = platform.stats.requests.filter((r) => r.url.includes('/realtime/stream'));
    assert.ok(streamCalls.length >= 3);
    assert.ok(streamCalls.every((r) => !r.headers.authorization));

    fs.rmSync(dir, { recursive: true, force: true });
    console.log('event-subscriber: ok');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
