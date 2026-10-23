# Go live from code

Stream to [OpenVibe.Live](https://openvibe.live) from a script: a robot's camera, a test rig, a
video file on a loop. No OBS, no browser and no follower minimum. A Live API token sets up the slot,
and FFmpeg publishes over [WHIP](https://openvibe.live/docs/whip).

```bash
node --env-file=.env go-live.js
# Created slot 41 "Live from code"
# Live: https://openvibe.live/@you (stream 900) for 60 s
# Ended stream 900; its recording is on openvibe.video once Media finishes it

OV_SOURCE=talk.mp4 OV_SECONDS=0 node --env-file=.env go-live.js     # a file, until it ends or Ctrl-C
```

## What it proves

- **A Live API token** (`hbt_…`, scopes `read` and `stream`) is enough to go live. It is the
  bearer on Live's own routes (`openvibe-sdk/live`):
  - `slots.list` and `slots.create` (streaming method `whip`);
  - the slot's profile (`GET /api/streams/managed/:id/profile`) for its WHIP URL;
  - `streams.mine`, `streams.update` and `streams.end`.

  Money, staff and credential routes refuse API tokens, so this token can't touch your balance.
- **Posting to the WHIP URL starts the live session.** There is no "Go live" call: the slot goes
  live when media flows, and the script finds that session to name it.
- **What Live accepts over WHIP:**
  - H.264 Constrained Baseline without B-frames (or VP8), and Opus at 48 kHz;
  - one encoding each, no simulcast;
  - no STUN or TURN, since Live is an ICE-lite server on a public address.

  `ffmpegArgs()` sets exactly that.
- **Nothing lingers.** FFmpeg ends its WHIP session when it stops (`OV_SECONDS`, the file's end, or
  Ctrl-C). The script also ends the stream, which covers a crash, and the recording appears on
  openvibe.video once Media finishes it.
- **The stream key stays secret.** It is a password: anyone holding it can broadcast to your
  channel. It goes to FFmpeg as an argument and is never printed.
- A slot whose ingest is OpenRestream has no Live WHIP URL, and the script says so rather than
  publishing somewhere that would refuse it.

## Files

| File | What |
|---|---|
| `go-live.js` | `loadConfig()`, `createLive()`, `ensureSlot()`, `whipUrl()` (the SDK's `live.whip.forSlot`), `ffmpegArgs()`, `waitForSession()`, `goLive()`, CLI |
| `test/smoke.test.js` | the whole run against a stand-in for Live's routes and a fake FFmpeg |

## Run the smoke test

```bash
npm test
```

The test hands the SDK a `fetch` that answers like Live's routes (`server/streaming/routes.js` and
`server/auth/routes.js` on OpenVibe.Live's main) and a fake FFmpeg. It checks:
- the slot is created once and reused after;
- the WHIP URL comes from the profile;
- FFmpeg gets Live's codecs and the URL;
- the session is named once live and ended when FFmpeg stops;
- a missing FFmpeg is a clear error;
- the key never appears in the output.

Nothing reaches the network.

## Run it against the real platform

1. On [openvibe.live](https://openvibe.live), open **Dashboard → API tokens** and create a token
   with the **Stream Controller** preset (`read`, `stream`, `control`) or just `read` and `stream`.
2. Install **FFmpeg 8.0 or later**. 8.0 added the WHIP muxer: `ffmpeg -hide_banner -muxers | grep whip`
   should list it. Your FFmpeg also needs libx264 and libopus, as most builds have.
3. `cp .env.example .env`, set `OV_LIVE_TOKEN`, then `npm install && npm start`.

This goes live on your own channel: viewers can see it, and it is recorded. Use `OV_SECONDS` for a
short test, and delete the slot from the dashboard afterwards if you don't want it.
Your channel's page is `https://openvibe.live/@<you>`.

To stream from a browser tab instead, with no code at all, use openvibe.live's **Go live** button
or the [single-file WHIP publisher](https://openvibe.live/whip-publisher.html).
