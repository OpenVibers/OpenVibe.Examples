# Tool job

Run an OpenVibe.Tools job (here: convert an image to WebP) as a developer app with
`openvibe-sdk/jobs`, and survive dropped connections and restarts without running the job twice.

```bash
node --env-file=.env run-job.js ./photo.png
# submitted job_01K… (queued)
# job.queued
# job.running
# job.progress 20% Processing
# job.succeeded 100%
# saved ./out/photo.webp
```

## What it proves

- An app token for `openvibe.tools` scoped to `tools.job.create tools.job.read` (both in the
  sandbox allowance: a sandbox app gets them without staff).
- **Submit once.** `jobs.submit()` carries an `Idempotency-Key` derived from the request
  (type, input, file). If the process dies after submitting, running it again gets the **same**
  job back (`replayed: true`), not a second one.
- **Reattach.** The job id and the last event id are kept in `.job-state.json`; a restart
  reattaches to the job instead of submitting.
- **Resume the stream.** `jobs.events()` reopens the job's SSE stream with `Last-Event-ID` after a
  drop, and Tools replays only later events: every event is seen once, in order. A finished job
  with nothing newer answers `204` and the stream ends.
- The result files are downloaded with `jobs.file()` and the same token. Jobs are owner-scoped:
  another app gets `404` (`jobs.get()` returns `null`).

## Files

| File | What |
|---|---|
| `run-job.js` | `createJobRunner()` (`submit`, `watch`, `get`, `download`, `run`), CLI |
| `test/smoke.test.js` | full run with a dropped stream, reattach after a crash, idempotent resubmit, 204, owner scoping, no grant |

## Run the smoke test

```bash
npm test
```

Network and Tools are `openvibe-sdk/testing`'s mock platform with `jobs` enabled, answering at
`https://img.openvibe.tools` like the real satellite (an `img.process` handler plays queued →
running → progress → succeeded; `acceptSandbox: ['openvibe.tools']` because Tools accepts sandbox
app tokens on jobs); `dropJobStreams()` cuts the event stream after the first event.

## Run it against the real platform

1. Create a project and a **confidential** sandbox app with `tools.job.create` and
   `tools.job.read` ([walkthrough](../../README.md#end-to-end-walkthrough)).
2. `cp .env.example .env`, fill in `OV_CLIENT_ID` and `OV_CLIENT_SECRET`.
3. `node --env-file=.env run-job.js ./photo.png`

`img.process` runs on `https://img.openvibe.tools` (`input.tool` is one of its tools, for example
`convert` with `format`); audio and docs jobs run on their own satellites (set
`OV_TOOLS_JOBS_URL`, `OV_JOB_TYPE`, `OV_JOB_INPUT`). Tools accepts sandbox app tokens on
`/api/v1/jobs`: a sandbox project may have 2 active jobs of at most 30 minutes, and its results are
never copied to Media.
