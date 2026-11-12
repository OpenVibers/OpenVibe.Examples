# AGENTS.md — OpenVibe.Examples

## Project overview

Executable, copyable public integration examples for the OpenVibe platform: the SDK, scoped developer-app
credentials and public APIs, **nothing else**. Each example is small, runs on its own and proves one thing
with a smoke test. **MIT**, so any example can be copied into a developer's own project (the services
themselves are AGPL-3.0).

- There is **no service here**: no unit, port, env file or package publish, and nothing is deployed from
  this repository. CI runs `npm test` and the developer-path check against the SDK's mock platform.
- Pin at this release: `openvibe-sdk` v0.150.0 (a dev dependency; `openvibe-contracts` v0.410.0 for the
  mod manifest), Node 22.22.1 in CI.

## What it owns

- Eighteen examples, each with `README.md`, `.env.example`, `package.json`, code and
  `test/smoke.test.js`:
  - the nine charter ones: `browser-app`, `node-server-app`, `webhook-consumer`, `event-subscriber`,
    `media-uploader`, `chat-bot`, `tool-job`, `mod-manifest`, `oauth-app`;
  - and `ai-chat`, `go-live`, `zone-s3`, `space-deploy`, `inventory-wear`, `game-scores`,
    `developer-path`-style walkthroughs and the newer app examples listed in the README table.
- The on-demand end-to-end run (`npm run e2e`: Media, Events pull, a Tools job against the real platform
  with the developer's own sandbox app) and the sandbox-app setup (`npm run new-app`).
- The Wave 20 exit check: `npm run developer-path` against the real platform and
  `npm run developer-path:mock` against the mock (CI).
- The repository checks: `test/public-surface.test.js`, `test/structure.test.js`,
  `test/create-app.test.js`, `test/developer-path.test.js`, `test/tools-job-proof.test.js`.

Not owned: any platform service, the SDK (OpenVibe.SDK), the contracts (OpenVibe.Contracts) or the
developer console (OpenVibe.Services).

## What each example proves (short)

| Example | Proves |
|---|---|
| `browser-app` | a no-build page imports the SDK browser bundle, reads the registry cross-origin and signs in with PKCE (a public app needs no secret) |
| `node-server-app` | client-credentials app token per audience, registry discovery, contracts version, trace propagation |
| `media-uploader` | upload/read/delete in the project's Media tenant; sandbox files get signed URLs |
| `event-subscriber` | publish to `app.<project_key>.*`, pull with a durable cursor, gaps; anonymous realtime for public events |
| `webhook-consumer` | an app subscription, `X-OpenVibe-Signature-V2` (±300 s), exactly-once inbox, secret rotation |
| `tool-job` | a Tools job submitted once (idempotency key), reattached after restart, SSE resumed |
| `oauth-app` | authorization code + PKCE for a confidential app, server exchange, offline token checks |
| `chat-bot` | Chat's `/ws/chat` protocol, one configured room, always a bot (no app principal yet) |
| `mod-manifest` | a `mods.mod-manifest@1` validated against schema, catalog and compatibility |
| `go-live` | a Live API token finds/creates a WHIP slot; FFmpeg 8+ publishes; the stream key is never printed |
| `game-scores` | Play achievements/leaderboard from a sandbox app, idempotent round |
| `inventory-wear` | public catalog + who wears what, 100 per call, no token |
| `space-deploy` | Space deploy+rollback from CI with an app token |
| `zone-s3` | Zone's S3 surface with AWS SDK v3, scoped access key, presigned share ≤7 days |

## Repository map

- [examples/](examples/) — one directory per example; each has `README.md`, `.env.example`,
  `package.json`, source and `test/smoke.test.js`.
- [scripts/e2e.js](scripts/e2e.js) — on demand only, real platform.
- [scripts/developer-path.js](scripts/developer-path.js) — the real exit check;
  [scripts/developer-path-mock.js](scripts/developer-path-mock.js) — the same against the mock (CI).
- [scripts/new-sandbox-app.js](scripts/new-sandbox-app.js) — project + sandbox app + grants.
- [scripts/tools-job-proof.js](scripts/tools-job-proof.js) — the Tools job proof.
- [test/run.js](test/run.js) — runs every example's smoke test plus the repository checks.
- [test/public-surface.test.js](test/public-surface.test.js), [test/structure.test.js](test/structure.test.js).
- [.github/workflows/ci.yml](.github/workflows/ci.yml) — Node 22.22.1, `npm test`, the mock developer path.

## Commands

```bash
fnm use 22.22.1            # or any Node 22
npm ci                     # one install for all examples (npm workspaces)
npm test                   # every smoke test + repository checks, no network
npm test -- chat oauth     # only names containing a word; --strict makes a skip fail
npm run e2e                # three examples against the real platform (needs .env/sandbox app)
npm run new-app            # create a project + sandbox app + grants
npm run developer-path     # the Wave 20 exit check against the real platform
npm run developer-path:mock  # the same against the mock (what CI runs)
ov test                    # the harness's sharded run of what the change reaches
```

## How the tests stay offline

`npm test` runs each example's smoke test against `openvibe-sdk/testing`'s `createMockPlatform()`: an
in-process fake at the real public origins with real RS256 tokens, developer apps/projects, sandbox
handling per service, `/oauth/authorize` with auto-consent, retention gaps (`pruneEvents()`), a delivery
worker and Tools jobs with SSE. The mock plays the developer-app rules as production does (own-project
events topics, Media project tenants, sandbox URLs). Chat is the one service the SDK does not mock, so
`chat-bot` ships `test/mock-chat-server.js`. Every smoke test replaces the global `fetch` with one that
throws, so an accidental network call fails the test.

## Conventions

- The public surface only: `openvibe-sdk`, scoped developer-app credentials and public APIs. **Never** a
  first-party loopback key, a first-party database, an internal header or a service token.
- One example proves one thing; its smoke test asserts the observable result, including the refusal cases.
- No build step: the browser example loads the SDK bundle directly; Node examples run as written.
- No secret in the repository or the tests; `.env.example` names variables only, and a test never prints a
  token or a key.
- MIT header stays; a copy of an example into another project must keep working.

## Pitfalls

- **A first-party shortcut invalidates the example.** If it needs an internal first-party key header, a
  loopback URL, a database or a service token, it is not an example of the public platform.
- **Production apps need staff in some cases:** switching a project to `sandbox+production` and setting
  its allowance is an operator step; a sandbox app cannot do it.
- **Chat has no app principal yet.** `chat.message.send` is first-party, so `chat-bot` uses a dedicated
  bot's Live `hbt_` token, not a developer app. Do not present it as an app-token flow.
- **No refresh tokens and no profile:** a Network app token lasts 5 minutes and the app learns only the
  person's `usr_…` id; `identity.subject.resolve` is first-party. Design the example around that.
- **`/oauth/token` is not CORS-open**, so a browser exchanges the code on its own server (`browser-app`
  does).
- **Publishing a mod into Games is not public** (`games.mod.manage` is first-party); the manifest example
  validates, it does not publish.
- **`npm test` must stay offline.** The mock's `fetch`-throws guard is the enforcement; do not add a test
  that reaches the network.
- **`npm run e2e` is not part of CI** and needs real sandbox credentials; do not make it a required check.
- **Version drift is real:** the README's "Built on" lines can lag `package.json` (SDK v0.150.0 now). Trust
  `package.json`/the lockfile for what runs.

## Documentation

- [README.md](README.md) — the example table, starting a new app, the end-to-end walkthrough, how the
  platform works for a sandbox app, the developer path, what still does not work, running tests, layout.
- Each [examples/&lt;name&gt;/README.md](examples/) — the example's own setup and claims.
- [SECURITY.md](SECURITY.md), [STATUS.json](STATUS.json).
- The SDK is OpenVibe.SDK; the platform docs are at https://openvibe.services.
