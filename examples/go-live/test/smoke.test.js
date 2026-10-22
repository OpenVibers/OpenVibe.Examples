'use strict';
/**
 * Smoke test: go-live.js against a stand-in for Live's routes (the shapes server/streaming/routes.js and
 * server/auth/routes.js answer) and a fake FFmpeg. Slot found or created, the WHIP URL read from the slot's profile,
 * FFmpeg given Live's codecs and the URL, the session named once live, the stream ended when FFmpeg stops, and the
 * stream key never printed. No network, no FFmpeg.
 */
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { loadConfig, createLive, ensureSlot, whipUrl, ffmpegArgs, goLive } = require('../go-live');

globalThis.fetch = () => { throw new Error('network access in a smoke test'); };

const KEY = 'a'.repeat(32);
const TOKEN = 'hbt_testtokennotreal';
const calls = [];
let slots = [];
let live = false;

const json = (status, o) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
async function fakeFetch(url, init = {}) {
    const u = new URL(String(url));
    const method = init.method || 'GET';
    const auth = new Headers(init.headers).get('authorization');
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, path: u.pathname, auth, body });
    assert.equal(u.origin, 'https://openvibe.live');
    assert.equal(auth, `Bearer ${TOKEN}`, 'the API token is the bearer on Live\'s routes');
    if (method === 'GET' && u.pathname === '/api/streams/managed') return json(200, { managed_streams: slots, limit: 5 });
    if (method === 'POST' && u.pathname === '/api/streams/managed') {
        const slot = { id: 41, user_id: 7, title: body.title, streaming_method: body.streaming_method, stream_key: KEY };
        slots.push(slot);
        return json(201, { managed_stream: slot });
    }
    if (method === 'GET' && u.pathname === '/api/streams/managed/41/profile') {
        return json(200, { managed_stream: { id: 41, title: 'Robot cam' }, stream_key: KEY, whip_url_base: 'https://whip.openvibe.live', rtmp_url: 'rtmp://openvibe.live:1935/live' });
    }
    if (method === 'GET' && u.pathname === '/api/streams/managed/42/profile') {
        return json(200, { managed_stream: { id: 42 }, stream_key: null, whip_url_base: null, ingest_authority: 'openre' });
    }
    if (method === 'GET' && u.pathname === '/api/streams/mine') {
        return json(200, { streams: live ? [{ id: 900, managed_stream_id: 41, is_live: 1, title: 'Robot cam' }, { id: 899, managed_stream_id: 41, is_live: 0 }] : [] });
    }
    if (method === 'PUT' && u.pathname === '/api/streams/900') return json(200, { stream: { id: 900, ...body } });
    if (method === 'GET' && u.pathname === '/api/auth/me') return json(200, { user: { id: 7, username: 'robotlab' }, capabilities: {} });
    if (method === 'DELETE' && u.pathname === '/api/streams/900') { live = false; return json(200, { message: 'Stream ended' }); }
    throw new Error(`unexpected ${method} ${u.pathname}`);
}

/** A stand-in for FFmpeg: media "flows" when it starts, and it exits 0 when told to. */
function fakeFfmpeg(record) {
    return (cmd, args) => {
        record.push({ cmd, args });
        const child = new EventEmitter();
        child.kill = () => setImmediate(() => child.emit('exit', 255));
        live = true;
        setTimeout(() => child.emit('exit', 0), 30);
        return child;
    };
}

(async () => {
    // Configuration: the token is required and must be a Live API token.
    assert.throws(() => loadConfig({}), /missing environment variables: OV_LIVE_TOKEN/);
    assert.throws(() => loadConfig({ OV_LIVE_TOKEN: 'eyJhbGciOi' }), /Live API token \(hbt_…\)/);
    assert.throws(() => loadConfig({ OV_LIVE_TOKEN: TOKEN, OV_SECONDS: '-1' }), /OV_SECONDS/);
    const config = loadConfig({ OV_LIVE_TOKEN: TOKEN, OV_TITLE: 'Robot cam', OV_SECONDS: '30' });
    assert.deepEqual([config.liveUrl, config.source, config.seconds, config.slotId], ['https://openvibe.live', 'test', 30, null]);

    // FFmpeg gets what Live's WHIP accepts: H.264 baseline without B-frames, Opus 48 kHz, the WHIP muxer, the URL last.
    const args = ffmpegArgs('https://whip.openvibe.live/whip/k', { source: 'test', seconds: 30 });
    for (const [flag, value] of [['-c:v', 'libx264'], ['-profile:v', 'baseline'], ['-bf', '0'], ['-c:a', 'libopus'], ['-ar', '48000'], ['-f', 'whip'], ['-t', '30']]) {
        assert.equal(args[args.indexOf(flag, flag === '-f' ? args.lastIndexOf('-f') : 0) + 1], value, `${flag} ${value}`);
    }
    assert.equal(args.at(-1), 'https://whip.openvibe.live/whip/k');
    assert.ok(args.includes('testsrc2=size=1280x720:rate=30'));
    assert.deepEqual(ffmpegArgs('u', { source: 'talk.mp4', seconds: 0 }).slice(3, 6), ['-re', '-i', 'talk.mp4'], 'a file plays at its own speed');
    assert.ok(!ffmpegArgs('u', { source: 'talk.mp4', seconds: 0 }).includes('-t'), 'OV_SECONDS=0 runs until stopped');
    assert.deepEqual(ffmpegArgs('u', { source: 'camera:/dev/video0' }).slice(3, 11), ['-f', 'v4l2', '-framerate', '30', '-video_size', '1280x720', '-i', '/dev/video0']);

    const sdk = createLive(config, { fetch: fakeFetch });

    // A slot from another ingest has no Live WHIP URL: said plainly.
    await assert.rejects(whipUrl(sdk, 42), /slot 42 has no Live WHIP URL \(its ingest is openre\)/);

    // The whole run: a new WHIP slot, its WHIP URL, FFmpeg, the session named, the stream ended.
    const runs = [];
    const lines = [];
    const out = await goLive(sdk, config, { run: fakeFfmpeg(runs), log: (l) => lines.push(l), sleep: () => new Promise((r) => setTimeout(r, 1)) });
    assert.equal(out.code, 0);
    assert.equal(out.stream.id, 900);
    assert.equal(out.channelUrl, 'https://openvibe.live/@robotlab');
    assert.deepEqual(calls.find((c) => c.method === 'POST').body, { title: 'Robot cam', streaming_method: 'whip' });
    assert.equal(runs.length, 1);
    assert.equal(runs[0].cmd, 'ffmpeg');
    assert.equal(runs[0].args.at(-1), `https://whip.openvibe.live/whip/${KEY}`);
    assert.deepEqual(calls.find((c) => c.method === 'PUT').body, { title: 'Robot cam' });
    assert.ok(calls.some((c) => c.method === 'DELETE' && c.path === '/api/streams/900'), 'the stream is ended, so nothing lingers');
    assert.deepEqual(lines, [
        'Created slot 41 "Robot cam"',
        'Live: https://openvibe.live/@robotlab (stream 900) for 30 s',
        'Ended stream 900; its recording is on openvibe.video once Media finishes it',
    ]);
    assert.ok(!lines.join('\n').includes(KEY), 'the stream key is never printed');

    // A second run reuses the slot instead of making another.
    calls.length = 0;
    const again = await ensureSlot(sdk, config);
    assert.deepEqual([again.slot.id, again.created], [41, false]);
    assert.ok(!calls.some((c) => c.method === 'POST'));
    await assert.rejects(ensureSlot(sdk, { ...config, slotId: 77 }), /slot 77 is not one of yours/);

    // FFmpeg missing: a clear error, and no stream left behind.
    calls.length = 0;
    const missing = () => { const c = new EventEmitter(); c.kill = () => {}; setImmediate(() => c.emit('error', new Error('spawn ffmpeg ENOENT'))); return c; };
    await assert.rejects(goLive(sdk, config, { run: missing, log: () => {}, sleep: () => Promise.resolve() }), /could not start ffmpeg: spawn ffmpeg ENOENT/);
    assert.ok(!calls.some((c) => c.method === 'PUT' || c.method === 'DELETE'));

    console.log('go-live smoke: slot, WHIP URL, FFmpeg arguments, the live session named and ended, key never printed');
})().catch((err) => { console.error(err); process.exit(1); });
