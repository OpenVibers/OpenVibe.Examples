'use strict';
/**
 * Smoke test: pull with a durable cursor, realtime with resume, and gap handling in both, against
 * the SDK's mock platform (fake Network + Events, including /realtime/stream). No network.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMockPlatform } = require('openvibe-sdk/testing');
const { createSubscriber, loadConfig, createCursorStore } = require('../subscriber');

globalThis.fetch = () => { throw new Error('network access in a smoke test'); };

const APP = 'app_01JEXAMPLESUBSCRIBER000000';
const SECRET = 'ovsec_event_subscriber_test_secret';
const quiet = { log() {}, error() {} };

async function waitFor(check, what, ms = 3000) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
        if (check()) return;
        await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`timed out waiting for ${what}`);
}

const media = (visibility = 'public', type = 'media.object.uploaded') => ({
    event_type: type, source: 'media', visibility,
    actor: { type: 'service', id: 'media' }, subject: { type: 'object', id: 'med_01JEXAMPLEOBJECT0000000000' },
});

(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-subscriber-'));
    const platform = createMockPlatform({
        clients: { [APP]: { secret: SECRET, grants: [{ capability: 'events.event.read', audience: 'openvibe.events' }] } },
    });

    // ── pull: durable cursor ────────────────────────────────
    const a = platform.publishEvent(media());
    platform.publishEvent(media('public', 'chat.message.created'));      // another topic: skipped, cursor moves past it
    const b = platform.publishEvent(media('internal', 'media.object.deleted'));
    const pullEnv = { OV_EVENTS_MODE: 'pull', OV_CLIENT_ID: APP, OV_CLIENT_SECRET: SECRET, OV_TOPICS: 'media.object.*', OV_CURSOR_PATH: path.join(dir, 'pull.json') };
    let seen = [];
    let s = createSubscriber(loadConfig(pullEnv), { fetch: platform.fetch, log: quiet, onEvent: (e, { seq }) => { seen.push(seq); } });
    assert.equal(await s.pullOnce({ limit: 2 }), 2);
    assert.deepEqual(seen, [a.seq, b.seq]);
    assert.equal(createCursorStore(pullEnv.OV_CURSOR_PATH).get('pull'), 3, 'cursor saved at the head');

    // A new process resumes from the cursor: only what is new.
    const c = platform.publishEvent(media());
    seen = [];
    s = createSubscriber(loadConfig(pullEnv), { fetch: platform.fetch, log: quiet, onEvent: (e, { seq }) => { seen.push(seq); } });
    assert.equal(await s.pullOnce(), 1);
    assert.deepEqual(seen, [c.seq]);

    // A handler that fails leaves the cursor on the last event that succeeded.
    const d = platform.publishEvent(media());
    const e = platform.publishEvent(media());
    seen = [];
    s = createSubscriber(loadConfig(pullEnv), {
        fetch: platform.fetch, log: quiet,
        onEvent: (ev, { seq }) => { if (seq === e.seq) throw new Error('boom'); seen.push(seq); },
    });
    await assert.rejects(s.pullOnce(), /boom/);
    assert.equal(createCursorStore(pullEnv.OV_CURSOR_PATH).get('pull'), d.seq);
    s = createSubscriber(loadConfig(pullEnv), { fetch: platform.fetch, log: quiet, onEvent: (ev, { seq }) => { seen.push(seq); } });
    await s.pullOnce();
    assert.deepEqual(seen, [d.seq, e.seq], 'the failed event is retried, nothing is skipped');

    // A gap (retention pruned the range): onResync is told, reading continues. The mock never
    // prunes, so this wraps its fetch to answer the way Events does after pruning.
    const gapFetch = async (input, init) => {
        const res = await platform.fetch(input, init);
        const url = String(input && input.url ? input.url : input);
        if (!url.includes('/api/v1/events?')) return res;
        const body = await res.json();
        return new Response(JSON.stringify({ ...body, gap: { from_seq: 7, to_seq: 9, reason: 'retention' } }), { status: res.status, headers: { 'Content-Type': 'application/json' } });
    };
    const f = platform.publishEvent(media());
    const resyncs = [];
    seen = [];
    s = createSubscriber(loadConfig(pullEnv), { fetch: gapFetch, log: quiet, onEvent: (ev, { seq }) => { seen.push(seq); }, onResync: (g, { via }) => resyncs.push({ ...g, via }) });
    await s.pullOnce();
    assert.deepEqual(resyncs, [{ from_seq: 7, to_seq: 9, reason: 'retention', via: 'pull' }]);
    assert.deepEqual(seen, [f.seq]);

    // Pull needs credentials; realtime does not.
    assert.throws(() => loadConfig({ OV_EVENTS_MODE: 'pull' }), /OV_CLIENT_ID/);

    // ── realtime: anonymous, public events only, resume ────
    const rtEnv = { OV_EVENTS_MODE: 'realtime', OV_TOPICS: 'media.object.*', OV_CURSOR_PATH: path.join(dir, 'realtime.json') };
    const live = [];
    const rt = createSubscriber(loadConfig(rtEnv), { fetch: platform.fetch, log: quiet, onEvent: (ev, { seq }) => { live.push({ seq, type: ev.event_type }); } });
    const subscription = rt.start();
    await waitFor(() => subscription.connected, 'the realtime connection');
    const p1 = platform.publishEvent(media());
    platform.publishEvent(media('internal'));                             // never reaches an anonymous viewer
    const p2 = platform.publishEvent(media('public', 'media.object.deleted'));
    await waitFor(() => live.length === 2, 'two public events');
    assert.deepEqual(live.map((x) => x.seq), [p1.seq, p2.seq]);
    await waitFor(() => createCursorStore(rtEnv.OV_CURSOR_PATH).get('realtime') === p2.seq, 'the realtime cursor');

    // The connection drops; an event published meanwhile arrives once after the reconnect.
    platform.dropRealtime();
    const p3 = platform.publishEvent(media());
    await waitFor(() => live.length === 3, 'the event published during the drop');
    assert.equal(live[2].seq, p3.seq);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(live.length, 3, 'no duplicates after resuming');
    rt.stop();

    // A restart resumes from the saved cursor: the event published while stopped is delivered.
    const p4 = platform.publishEvent(media());
    const after = [];
    const rt2 = createSubscriber(loadConfig(rtEnv), { fetch: platform.fetch, log: quiet, onEvent: (ev, { seq }) => { after.push(seq); } });
    rt2.start();
    await waitFor(() => after.length === 1, 'the event published while stopped');
    assert.deepEqual(after, [p4.seq]);
    rt2.stop();

    // A cursor ahead of the stream (restored from another environment): a gap, then live events.
    const aheadPath = path.join(dir, 'ahead.json');
    createCursorStore(aheadPath).set('realtime', 9999);
    const rtGaps = [];
    const rt3 = createSubscriber(loadConfig({ ...rtEnv, OV_CURSOR_PATH: aheadPath }), { fetch: platform.fetch, log: quiet, onEvent() {}, onResync: (g, { via }) => rtGaps.push({ ...g, via }) });
    rt3.start();
    await waitFor(() => rtGaps.length === 1, 'the realtime gap');
    assert.equal(rtGaps[0].reason, 'cursor_ahead');
    assert.equal(rtGaps[0].via, 'realtime');
    rt3.stop();

    // No credentials were sent on the anonymous stream.
    const streamCalls = platform.stats.requests.filter((r) => r.url.includes('/realtime/stream'));
    assert.ok(streamCalls.length >= 3);
    assert.ok(streamCalls.every((r) => !r.headers.authorization));

    fs.rmSync(dir, { recursive: true, force: true });
    console.log('event-subscriber: ok');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
