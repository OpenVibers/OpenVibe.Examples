# Tool job

Run an OpenVibe.Tools job (here: convert an image to WebP) as a developer app, and survive
dropped connections and restarts without running the job twice.

```bash
node --env-file=.env run-job.js ./photo.png
# submitted job_01K… (queued)
# job.queued
# job.running
# job.progress 50% converting
# job.succeeded 100%
# saved ./out/photo.webp
```

## What it proves

- An app token for `openvibe.tools` scoped to `tools.job.create tools.job.read` (both `public`
  capabilities a developer app can hold).
- **Submit once.** `POST /api/v1/jobs` carries an `Idempotency-Key` derived from the request
  (type, input, file). If the process dies after submitting, running it again gets the **same**
  job back (`200 Idempotent-Replayed: true`), not a second one.
- **Reattach.** The job id and the last event id are kept in `.job-state.json`; a restart
  reattaches to the job instead of submitting.
- **Resume the stream.** `GET /api/v1/jobs/:id/events` (SSE) is reopened with `Last-Event-ID`
  after a drop, and Tools replays only later events: every event is seen once, in order.
  `204` means the job finished and nothing is newer.
- The result files are downloaded with the same token. Jobs are owner-scoped: another app gets `404`.

## Files

| File | What |
|---|---|
| `run-job.js` | `createJobRunner()` (`submit`, `watch`, `get`, `download`, `run`), `readEventStream()`, CLI |
| `test/mock-tools-server.js` | a local `/api/v1/jobs` that behaves as documented (the SDK mock has no Tools) |
| `test/smoke.test.js` | full run with a dropped stream, reattach after a crash, idempotent resubmit, 204, owner scoping, no grant |

## Run the smoke test

```bash
npm test
```

Network is the SDK's mock platform; the Tools mock verifies its tokens (RS256, audience
`openvibe.tools`, the `tools.job.*` capability) and plays queued → running → progress → succeeded.

## Run it against the real platform

1. Create a project and a **confidential** app, request `tools.job.create` and `tools.job.read`
   ([walkthrough](../../README.md#end-to-end-walkthrough)).
2. `cp .env.example .env`, fill in `OV_CLIENT_ID` and `OV_CLIENT_SECRET`.
3. `node --env-file=.env run-job.js ./photo.png`

`img.process` runs on `https://img.openvibe.tools`; audio and docs jobs run on their own
satellites (set `OV_TOOLS_JOBS_URL`, `OV_JOB_TYPE`, `OV_JOB_INPUT`). Tools accepts app tokens on
this API today. What has to be true on the platform side first: the capabilities are in your
project's allowance, and your app can get an `openvibe.tools` token — a **sandbox** app cannot
until staff list `openvibe.tools` in Network's `DEV_SANDBOX_AUDIENCES` (and Tools accepts
sandbox tokens), so use a production app.
