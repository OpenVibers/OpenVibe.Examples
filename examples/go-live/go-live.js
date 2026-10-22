'use strict';
/**
 * Go live on OpenVibe.Live from code: no OBS, no browser, no follower minimum.
 *
 * A Live API token (scopes read + stream) finds or creates a WHIP slot, reads the slot's WHIP URL, and FFmpeg 8+
 * publishes a source over WHIP (a test pattern and a tone by default; a video file or a camera). Posting to the WHIP
 * URL starts the live session, so there is no "Go live" call; the stream is live once media flows. The script then
 * names the session, prints the channel's address, and ends the stream when FFmpeg stops (OV_SECONDS, the file's
 * end, or Ctrl-C), so nothing lingers.
 *
 *   node --env-file=.env go-live.js
 *   OV_SOURCE=talk.mp4 node --env-file=.env go-live.js
 *
 * The stream key is a password (anyone holding it can broadcast to the channel): it goes to FFmpeg as an argument
 * and is never printed.
 */
const { spawn } = require('node:child_process');
const { createClient } = require('openvibe-sdk/core');
const { createLiveClient } = require('openvibe-sdk/live');

const TOKEN_RE = /^hbt_[A-Za-z0-9_-]{8,}$/;

function loadConfig(env = process.env) {
    const missing = ['OV_LIVE_TOKEN'].filter((k) => !env[k]);
    if (missing.length) throw new Error(`missing environment variables: ${missing.join(', ')}`);
    if (!TOKEN_RE.test(env.OV_LIVE_TOKEN)) throw new Error('OV_LIVE_TOKEN is a Live API token (hbt_…) with the read and stream scopes');
    const seconds = env.OV_SECONDS == null || env.OV_SECONDS === '' ? 60 : Number(env.OV_SECONDS);
    if (!Number.isFinite(seconds) || seconds < 0) throw new Error('OV_SECONDS is a number of seconds (0 runs until stopped)');
    const slotId = env.OV_SLOT_ID ? Number(env.OV_SLOT_ID) : null;
    if (env.OV_SLOT_ID && !Number.isInteger(slotId)) throw new Error('OV_SLOT_ID is a slot id (a number)');
    return {
        token: env.OV_LIVE_TOKEN,
        liveUrl: String(env.OV_LIVE_URL || 'https://openvibe.live').replace(/\/+$/, ''),
        slotId,
        title: String(env.OV_TITLE || 'Live from code').slice(0, 140),
        category: env.OV_CATEGORY || null,
        source: env.OV_SOURCE || 'test',
        seconds,
        ffmpeg: env.OV_FFMPEG || 'ffmpeg',
    };
}

/** The core client and Live's: the API token is the bearer on Live's own routes, never on the WHIP request. */
function createLive(config, { fetch } = {}) {
    const client = createClient({ token: config.token, baseUrls: { live: config.liveUrl }, ...(fetch ? { fetch } : {}) });
    return { client, live: createLiveClient(client) };
}

/** OV_SLOT_ID, else a WHIP or browser slot with this title, else a new WHIP slot. */
async function ensureSlot({ live }, config) {
    const { managed_streams: slots = [] } = await live.slots.list();
    if (config.slotId) {
        const slot = slots.find((s) => Number(s.id) === config.slotId);
        if (!slot) throw new Error(`slot ${config.slotId} is not one of yours`);
        return { slot, created: false };
    }
    const found = slots.find((s) => s.title === config.title && ['whip', 'browser'].includes(s.streaming_method));
    if (found) return { slot: found, created: false };
    const { managed_stream: slot } = await live.slots.create({
        title: config.title, streaming_method: 'whip', ...(config.category ? { category: config.category } : {}),
    });
    return { slot, created: true };
}

/** The slot's WHIP URL (docs: https://openvibe.live/docs/whip#getting-your-whip-url). */
async function whipUrl({ client }, slotId) {
    const profile = await client.json({ service: 'live', audience: 'openvibe.live', path: `/api/streams/managed/${Number(slotId)}/profile` });
    if (!profile.stream_key || !profile.whip_url_base) {
        // A slot OpenRestream ingests publishes there, not to Live's WHIP.
        throw new Error(`slot ${slotId} has no Live WHIP URL${profile.ingest_authority ? ` (its ingest is ${profile.ingest_authority})` : ''}`);
    }
    return `${String(profile.whip_url_base).replace(/\/+$/, '')}/whip/${profile.stream_key}`;
}

/**
 * FFmpeg's arguments: what Live accepts over WHIP (docs/whip#media-requirements): H.264 Constrained Baseline with
 * no B-frames, and Opus at 48 kHz, one encoding each. 'test' is a moving pattern with a clock and a 440 Hz tone; a
 * path is read at its own speed; 'camera:<device>' is a V4L2 camera with the default microphone (Linux).
 */
function ffmpegArgs(url, { source = 'test', seconds = 60 } = {}) {
    const input = source === 'test'
        ? ['-re', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000']
        : source.startsWith('camera:')
            ? ['-f', 'v4l2', '-framerate', '30', '-video_size', '1280x720', '-i', source.slice(7), '-f', 'pulse', '-i', 'default']
            : ['-re', '-i', source];
    return [
        '-hide_banner', '-loglevel', 'warning', ...input,
        ...(seconds > 0 ? ['-t', String(seconds)] : []),
        '-c:v', 'libx264', '-profile:v', 'baseline', '-level', '3.1', '-pix_fmt', 'yuv420p', '-bf', '0',
        '-g', '60', '-b:v', '2500k', '-maxrate', '2500k', '-bufsize', '5000k', '-tune', 'zerolatency',
        '-c:a', 'libopus', '-ar', '48000', '-ac', '2', '-b:a', '128k',
        '-f', 'whip', url,
    ];
}

/** The live session the slot started, once Live shows it (media takes a few seconds to flow). */
async function waitForSession({ live }, slotId, { attempts = 20, delayMs = 1500, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    for (let i = 0; i < attempts; i++) {
        const { streams = [] } = await live.streams.mine();
        const s = streams.find((x) => Number(x.managed_stream_id) === Number(slotId) && (x.is_live === true || x.is_live === 1));
        if (s) return s;
        await sleep(delayMs);
    }
    return null;
}

/**
 * Publish until FFmpeg stops, then make sure the stream ended. Returns { stream, channelUrl, code }.
 * `run` starts FFmpeg (child_process.spawn by default) and `log` prints progress.
 */
async function goLive(sdk, config, { run = (cmd, args) => spawn(cmd, args, { stdio: ['ignore', 'inherit', 'inherit'] }), log = console.log, sleep } = {}) {
    const { slot, created } = await ensureSlot(sdk, config);
    log(`${created ? 'Created' : 'Using'} slot ${slot.id} "${slot.title}"`);
    const url = await whipUrl(sdk, slot.id);
    const ff = run(config.ffmpeg, ffmpegArgs(url, config));
    const exited = new Promise((resolve) => {
        ff.once('error', (err) => resolve({ code: null, error: err }));
        ff.once('exit', (code) => resolve({ code }));
    });
    const stop = () => { try { ff.kill('SIGINT'); } catch { /* already gone */ } };   // FFmpeg DELETEs its WHIP session on SIGINT
    process.once('SIGINT', stop);
    try {
        const stream = await Promise.race([waitForSession(sdk, slot.id, { sleep }), exited.then(() => null)]);
        let channelUrl = null;
        if (stream) {
            await sdk.live.streams.update(stream.id, { title: config.title, ...(config.category ? { category: config.category } : {}) });
            const { user } = await sdk.client.json({ service: 'live', audience: 'openvibe.live', path: '/api/auth/me' });
            channelUrl = await sdk.live.channels.url(user.username);
            log(`Live: ${channelUrl} (stream ${stream.id})${config.seconds > 0 ? ` for ${config.seconds} s` : ' until Ctrl-C'}`);
        } else {
            log('FFmpeg stopped before the stream went live (does `ffmpeg -muxers` list whip? FFmpeg 8.0 added it; it also needs libx264 and libopus)');
        }
        const { code, error } = await exited;
        if (error) throw new Error(`could not start ${config.ffmpeg}: ${error.message}`);
        // FFmpeg ends the WHIP session on a clean exit; ending the stream as well covers a crash, so nothing lingers.
        if (stream) {
            await sdk.live.streams.end(stream.id).catch((err) => { if (err.status !== 404 && err.status !== 409) throw err; });
            log(`Ended stream ${stream.id}; its recording is on openvibe.video once Media finishes it`);
        }
        return { stream, channelUrl, code };
    } finally {
        process.removeListener('SIGINT', stop);
    }
}

module.exports = { loadConfig, createLive, ensureSlot, whipUrl, ffmpegArgs, waitForSession, goLive };

if (require.main === module) {
    (async () => {
        const config = loadConfig();
        const { code } = await goLive(createLive(config), config);
        process.exit(code === 0 || code === 255 ? 0 : 1);   // 255: FFmpeg stopped by Ctrl-C
    })().catch((err) => { console.error(err.code ? `${err.code}: ${err.message}` : err.message); process.exit(1); });
}
