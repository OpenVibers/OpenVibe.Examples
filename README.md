# OpenVibe.Examples

> Executable public integration examples for the OpenVibe platform: the SDK, scoped credentials
> and public APIs, nothing else.

**Status:** alpha, 0.2.0 (roadmap Wave 20). Nine examples, each with a smoke test that CI runs on
Node 22.22.1 against `openvibe-sdk/testing`'s mock platform (no network). `npm run e2e` runs three
of them (Media, Events pull, a Tools job) against the real platform with your own sandbox app; it
is not part of CI or `npm test`, and it was not run against production as part of this release.  
**Built on:** [openvibe-sdk v0.3.0](https://github.com/OpenVibers/OpenVibe.SDK/tree/v0.3.0), and
openvibe-contracts v0.26.0 for the mod manifest.  
**Plan:** OpenVibe End-to-End Realignment & Implementation Plan, revision 3 (20 Sep 2026), §15.1
and §18.9; roadmap Wave 20, §30 (public SDK surface), ADR-014 (developer projects).  
**License:** MIT ([LICENSE](LICENSE)), so you can copy any example into your own project. The
OpenVibe services themselves are AGPL-3.0.

## The examples

| Example | What it proves | Uses |
|---|---|---|
| [browser-app](examples/browser-app) | A plain page (no build step) imports the SDK's browser bundle, reads the registry cross-origin and signs in with PKCE; a public app needs no secret | `openvibe-sdk/browser/openvibe-sdk.mjs`, `/auth` (`exchangeCode`, `verifyAppToken`) |
| [node-server-app](examples/node-server-app) | Client-credentials app token per audience and what it carries, registry discovery, contracts version check, trace propagation | `openvibe-sdk/auth` (`getTokenInfo`), `/registry`, `/core` |
| [media-uploader](examples/media-uploader) | Upload into, read from and delete in your project's Media tenant; sandbox files come back with signed URLs | `openvibe-sdk/media` |
| [event-subscriber](examples/event-subscriber) | Publish to your project's topic `app.<project_key>.*`, pull it with a durable cursor, gaps; anonymous realtime for public events | `openvibe-sdk/events`, `/realtime` |
| [webhook-consumer](examples/webhook-consumer) | An app subscription on your own topic; `X-OpenVibe-Signature` verified on the raw body; exactly-once handling with an inbox; secret rotation | `openvibe-sdk/events` (`subscriptions.create`, `parseDelivery`, `createInbox`) |
| [tool-job](examples/tool-job) | An OpenVibe.Tools job submitted once (idempotency key), reattached after a restart, its SSE stream resumed with `Last-Event-ID` | `openvibe-sdk/jobs` |
| [oauth-app](examples/oauth-app) | Authorization code + PKCE for a confidential app, exchange on the server, offline app-token verification, session hygiene | `openvibe-sdk/auth` |
| [chat-bot](examples/chat-bot) | A bot on Chat's WebSocket protocol that stays in its one configured room and always identifies as a bot | Chat `/ws/chat` protocol (no SDK client: Chat is first-party) |
| [mod-manifest](examples/mod-manifest) | A `mods.mod-manifest@1` validated against the schema, the capability catalog and compatibility ranges | `openvibe-contracts`, `openvibe-sdk/registry` |

Each example folder has a README, a `.env.example`, its own `package.json` and a
`test/smoke.test.js`. Configuration is environment variables only (`OV_CLIENT_ID`,
`OV_CLIENT_SECRET`, `OV_PROJECT_ID`, …); secrets are never logged or sent to a browser.

## End-to-end walkthrough

From a new account to the examples running against the platform, with public surfaces only.
Nothing here needs staff: a new project is `sandbox`, and a sandbox app's owner gets the sandbox
capabilities approved at once.

**1. Create an account** at <https://openvibe.network>.

**2. Create a project, a sandbox app and its grants.** Either:

- **in the developer portal, <https://openvibe.codes>:** sign in, create a project, add a
  **confidential** app in the `sandbox` environment with the redirect URI
  `http://localhost:3009/callback` (for [oauth-app](examples/oauth-app)), copy the client secret
  (it is shown **once**), and request the grants `media.object.upload`, `media.object.read`,
  `events.app.publish`, `events.app.read`, `events.app.subscribe`, `tools.job.create`,
  `tools.job.read`; or
- **with the projects API** (`openvibe-sdk/projects`): `npm run new-app` does exactly the above
  and writes `OV_CLIENT_ID`, `OV_CLIENT_SECRET` and `OV_PROJECT_ID` into `./.env` (mode 0600)
  without printing the secret. It signs in with your username and password (not echoed) or uses
  `OV_USER_TOKEN`. The same in code:

  ```js
  const { createClient } = require('openvibe-sdk/core');
  const { createProjectsClient } = require('openvibe-sdk/projects');
  const projects = createProjectsClient(createClient({ token: userAccessToken }));   // a Network user token
  const project = await projects.create({ name: 'My first OpenVibe app' });           // sandbox, you are the owner
  const app = await projects.apps.create(project.id, { name: 'server', environment: 'sandbox', type: 'confidential' });
  app.credential.client_secret;                                                        // shown ONCE: store it now
  await projects.grants.request(project.id, app.id, 'media.object.upload');            // approved at once for the owner
  ```

For [browser-app](examples/browser-app) add a second, **public** app with the redirect URI
`http://localhost:3001/callback` and `media.object.read` (`npm run new-app -- --public --project
prj_…`). A public app has no secret.

**3. Check it works end to end:**

```bash
npm ci
npm run e2e          # reads ./.env: OV_CLIENT_ID, OV_CLIENT_SECRET, OV_PROJECT_ID
```

It uploads a small file to your Media tenant, reads it back and deletes it; publishes
`app.<project_key>.e2e.ran` and pulls your topic until it finds it; converts a 1x1 PNG to WebP on
`img.openvibe.tools`, following the job's events. It prints each step (never the secret, a token
or a URL signature) and exits `1` if a step failed, `2` if a variable is missing.

**4. Run the examples.** Each reads `.env` in its own folder (`cp .env.example .env`), or point it
at the root one: `node --env-file=../../.env upload.js ./logo.png`.

| Example | App | Grants | Environment variables |
|---|---|---|---|
| [node-server-app](examples/node-server-app) | confidential | any | `OV_CLIENT_ID`, `OV_CLIENT_SECRET`, `OV_AUDIENCES` |
| [media-uploader](examples/media-uploader) | confidential | `media.object.upload`, `media.object.read` | `OV_CLIENT_ID`, `OV_CLIENT_SECRET`, optional `OV_PROJECT_ID` |
| [event-subscriber](examples/event-subscriber) | confidential | `events.app.publish`, `events.app.read` | `OV_CLIENT_ID`, `OV_CLIENT_SECRET`, optional `OV_PROJECT_ID`, `OV_TOPICS`; realtime: `OV_EVENTS_MODE=realtime`, `OV_TOPICS` only |
| [webhook-consumer](examples/webhook-consumer) | confidential | `events.app.subscribe` | `OV_CLIENT_ID`, `OV_CLIENT_SECRET`; the consumer: `OV_WEBHOOK_SECRET` (written by `subscribe.js`); a public https host |
| [tool-job](examples/tool-job) | confidential | `tools.job.create`, `tools.job.read` | `OV_CLIENT_ID`, `OV_CLIENT_SECRET`, optional `OV_TOOLS_JOBS_URL`, `OV_JOB_TYPE`, `OV_JOB_INPUT` |
| [oauth-app](examples/oauth-app) | confidential, redirect `http://localhost:3009/callback` | every capability in `OV_SCOPE` | `OV_CLIENT_ID`, `OV_CLIENT_SECRET`, `OV_AUDIENCE`, `OV_SCOPE` |
| [browser-app](examples/browser-app) | public, redirect `http://localhost:3001/callback` | `media.object.read` | `OV_CLIENT_ID`, `OV_AUDIENCE`, `OV_SCOPE` |
| [chat-bot](examples/chat-bot) | none: a Live API token (`hbt_…`) of a dedicated bot account | Live token scope `chat` | `OV_CHAT_TOKEN`, one of `OV_CHAT_CHANNEL_USER_ID` / `OV_CHAT_STREAM_ID` |
| [mod-manifest](examples/mod-manifest) | none | none | `OV_NETWORK_URL` for `--registry` |

Rotate a secret in the portal or with `projects.credentials.rotate()`, revoke the app with
`projects.apps.revoke()`. Issued tokens end within their 5-minute lifetime.

## How the platform works for a sandbox app

Verified in production on 2026-09-23 with a brand-new account, using the public endpoints only:

- **Projects.** A new project is `sandbox`. Its owner's grant requests for the sandbox allowance
  are approved at once: `media.object.upload|read`, `events.app.publish|read|subscribe`,
  `tools.job.create|read|cancel`.
- **Tokens.** `POST https://openvibe.network/oauth/token` with `grant_type=client_credentials`
  gives a confidential sandbox app a 5-minute token for `openvibe.media`, `openvibe.events` or
  `openvibe.tools`, with `project_id`, `env: sandbox`, `ns: [project_id]` and the approved
  capabilities for that audience.
- **Media.** The tenant is the project id: `/api/v1/<prj_…>/files`. Sandbox objects are stored in
  a separate sandbox tenant (`<prj_…>-sandbox`, not addressable by path) and never served
  publicly: signed URLs only.
- **Events.** App events are `app.<project_key>.<name…>` (`project_key` = `p` + the lowercased
  project ULID) with `source: app-<lowercased app ULID>`. Read them with
  `GET /api/v1/events?topic=app.<project_key>.*`; subscribe with public https endpoints only.
  Realtime (SSE) never streams app events.
- **Tools.** `/api/v1/jobs` accepts sandbox app tokens.
- **Discovery.** `/.well-known/openvibe` and `/api/v1/registry/*` answer any origin (CORS), so a
  browser page reads them directly.

## What still does not work

- **No consent screen.** Network's account chooser names the app but does not list the
  capabilities it asks for. Apps get no refresh tokens and learn only the person's `usr_…` id.
- **`/oauth/token` is not CORS-open**, like every Network route outside discovery and the
  registry, so a browser app exchanges its code on its own server
  ([browser-app](examples/browser-app) does).
- **Chat has no app principal.** `chat.message.send` is `first-party`; the
  [chat-bot](examples/chat-bot) signs in with a Live API token (`hbt_…`, scope `chat`) of a
  dedicated bot account, not with a developer app.
- **Production apps need staff**: switching a project to `sandbox+production` and setting its
  allowance.
- **Publishing a mod** into Games is not public (`games.mod.manage` is `first-party`).

## Running the tests

```bash
fnm use 22.22.1            # or any Node 22
npm ci                     # one install for all examples (npm workspaces)
npm test                   # every smoke test + the repository checks
npm test -- chat oauth     # only some
cd examples/tool-job && npm test
```

How the tests stay offline:

- Network, Events, Media and Tools jobs are `createMockPlatform()` from `openvibe-sdk/testing`: an
  in-process fake at the real public origins, with real RS256 tokens, developer apps and projects,
  sandbox refusal unless a service opts in, `/oauth/authorize` with auto-consent, retention gaps
  (`pruneEvents()`), a delivery worker (`deliverEvents()`) and Tools jobs with SSE.
- Where the mock falls short, a small documented stand-in in the example's `test/` folder fills
  in: `mock-app-events.js` (Events' `events.app.*` rules, in event-subscriber and
  webhook-consumer) and `mock-chat-server.js` (Chat's WebSocket, which the SDK does not mock).
- Every smoke test replaces the global `fetch` with one that throws, so an accidental real network
  call fails the test.

Repository checks (`test/`):

- `public-surface.test.js` fails on the loopback shared-key header, on the platform's internal
  route prefix, on hard-coded loopback service ports outside the local mocks, and on any secret
  value in a `.env.example`.
- `structure.test.js` checks the nine examples are complete and copyable: README with "What it
  proves" and "Run it against the real platform", a `.env.example` that names every variable the
  code reads, MIT license, `openvibe-sdk` pinned to the v0.3.0 tag, no `file:` links; and that
  `npm run e2e` is outside CI and `npm test` and refuses to start without its variables.

## Layout

```
examples/<name>/          one example: README.md, .env.example, package.json, code, test/smoke.test.js
scripts/e2e.js            npm run e2e: three examples against the real platform (on demand only)
scripts/new-sandbox-app.js  npm run new-app: project + sandbox app + grants via openvibe-sdk/projects
test/run.js               runs every smoke test and the repository checks (npm test)
test/public-surface.test.js, test/structure.test.js
.github/workflows/ci.yml  Node 22.22.1: npm ci && npm test
```

## Owns

- the nine charter examples: vanilla browser app, Node server app, webhook consumer, event
  subscriber, Media uploader, Chat bot, tool/job example, mod manifest example, OAuth app example
- the on-demand end-to-end run (`npm run e2e`) and the sandbox-app setup script

## Does not own

- any platform service, the SDK (OpenVibe.SDK), the contracts (OpenVibe.Contracts) or the
  developer portal (OpenVibe.Codes)

## Depends on

- OpenVibe.SDK (v0.3.0), OpenVibe.Contracts (v0.26.0, mod manifest only)
- at run time against the real platform: Network (tokens, registry, developer projects), Events,
  Media, Tools, Chat (on openvibe.live)

## Acceptance

- CI runs every example: **yes**, against the SDK's mock platform and two small documented
  stand-ins (no network). Against the real platform on demand: `npm run e2e` with a sandbox app's
  credentials; there is no CI project with credentials.
- A new developer goes from account creation to a working Media, event and capability
  integration using only public documentation, the SDK and scoped credentials: the platform path
  was verified in production on 2026-09-23 (see
  [How the platform works](#how-the-platform-works-for-a-sandbox-app)); `npm run e2e` walks it with
  these examples.
- No example needs a loopback-only internal key or first-party database access: **yes**, enforced
  by `test/public-surface.test.js`.

---

Part of the [OpenVibe network](https://openvibe.network). Built in the open by [OpenVibers](https://github.com/OpenVibers).
