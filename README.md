# OpenVibe.Examples

> Executable public integration examples for the OpenVibe platform: the SDK, scoped credentials
> and public APIs, nothing else.

**Status:** alpha (roadmap Wave 20). Nine examples, each with a smoke test that CI runs on Node
22.22.1 against `openvibe-sdk/testing`'s mock platform and two small local mocks. **None of them
runs against the live platform in CI**, and several cannot run against it yet: see
[What works against the real platform today](#what-works-against-the-real-platform-today).  
**Built on:** [openvibe-sdk v0.2.2](https://github.com/OpenVibers/OpenVibe.SDK/tree/v0.2.2), and
openvibe-contracts v0.26.0 for the mod manifest.  
**Plan:** OpenVibe End-to-End Realignment & Implementation Plan, revision 3 (20 Sep 2026), §15.1
and §18.9; roadmap Wave 20, §30 (public SDK surface), ADR-014 (developer projects).  
**License:** MIT ([LICENSE](LICENSE)), so you can copy any example into your own project. The
OpenVibe services themselves are AGPL-3.0.

## The examples

| Example | What it proves | Uses |
|---|---|---|
| [browser-app](examples/browser-app) | A plain page (no build step) signs in with PKCE and reads a public API from the browser; a public app needs no secret | `openvibe-sdk/auth/browser`, `/registry`, `/core` |
| [node-server-app](examples/node-server-app) | Client-credentials app token per audience, registry discovery, contracts version check, trace propagation | `openvibe-sdk/auth`, `/registry`, `/core` |
| [webhook-consumer](examples/webhook-consumer) | `X-OpenVibe-Signature` verified on the raw body; exactly-once handling with an inbox; secret rotation | `openvibe-sdk/events` (`parseDelivery`, `createInbox`, `subscriptions.create`) |
| [event-subscriber](examples/event-subscriber) | Realtime subscription and pull with a durable cursor; resume after drops and restarts; gap handling | `openvibe-sdk/realtime`, `/events` |
| [media-uploader](examples/media-uploader) | Upload into your project's Media namespace with an app token; content-addressed, safe retries | `openvibe-sdk/media` |
| [chat-bot](examples/chat-bot) | A bot on Chat's WebSocket protocol that stays in its one configured room and always identifies as a bot | Chat `/ws/chat` protocol |
| [tool-job](examples/tool-job) | An OpenVibe.Tools job submitted once (idempotency key), reattached after a restart, SSE resumed with `Last-Event-ID` | Tools `/api/v1/jobs`, `openvibe-sdk/core` |
| [mod-manifest](examples/mod-manifest) | A `mods.mod-manifest@1` validated against the schema, the capability catalog and compatibility ranges | `openvibe-contracts`, `openvibe-sdk/registry` |
| [oauth-app](examples/oauth-app) | Authorization code + PKCE with the exchange on the server; offline token verification; session hygiene | `openvibe-sdk/auth` |

Each example folder has a README, a `.env.example`, its own `package.json` and a
`test/smoke.test.js`. Configuration is environment variables only (`OV_CLIENT_ID`,
`OV_CLIENT_SECRET`, `OV_NETWORK_URL`, …); secrets are never logged or sent to a browser.

## Running the tests

```bash
fnm use 22.22.1            # or any Node 22
npm ci                     # one install for all examples (npm workspaces)
npm test                   # every smoke test + the repository checks
npm test -- chat oauth     # only some
cd examples/tool-job && npm test
```

How the tests stay offline:

- Network, Events and Media are `createMockPlatform()` from `openvibe-sdk/testing`: an in-process
  fake at the real public origins, with real RS256 tokens and the same audience, capability and
  namespace checks.
- Chat and Tools have no SDK mock, so their examples carry a small local mock in their `test/`
  folder (`mock-chat-server.js`, `mock-tools-server.js`) that plays the documented protocol.
- Every smoke test replaces the global `fetch` with one that throws, so an accidental real network
  call fails the test.

Repository checks (`test/`):

- `public-surface.test.js` fails on the loopback shared-key header, on the platform's internal
  route prefix, on hard-coded loopback service ports outside the local mocks, and on any secret
  value in a `.env.example`.
- `structure.test.js` checks the nine examples are complete and copyable: README with "What it
  proves" and "Run it against the real platform", a `.env.example` that names every variable the
  code reads, MIT license, `openvibe-sdk` pinned to the v0.2.2 tag, no `file:` links.

## End-to-end walkthrough

From a new account to running the examples, with public surfaces only. OpenVibe.Codes (the
developer portal) will be the UI for these steps; it has not launched, so this uses the
developer-projects API on OpenVibe.Network directly. Every call is documented in Network's
[developer projects](https://github.com/OpenVibers/OpenVibe.Network/blob/main/docs/developer-projects.md) doc.

**1. Create an account** at <https://openvibe.network> (or `POST /api/auth/register`).

**2. Get a user access token** for the projects API (it reads no cookies). This reads your
password without echoing it or putting it on a command line:

```bash
NET=https://openvibe.network
read -r -p 'username: ' OV_USER; read -r -s -p 'password: ' OV_PASS; echo; export OV_USER OV_PASS
TOKEN=$(node -e 'process.stdout.write(JSON.stringify({ username: process.env.OV_USER, password: process.env.OV_PASS }))' \
  | curl -s "$NET/api/auth/login" -H 'Content-Type: application/json' --data-binary @- \
  | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')
unset OV_PASS
auth=(-H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json')
```

**3. See what can be granted** (only `public`, `active` capabilities; `first-party` and `internal` never are):

```bash
curl -s "$NET/api/v1/projects/catalog" "${auth[@]}"
```

**4. Create a project.** You are its owner. A new project is `sandbox` only.

```bash
PRJ=$(curl -s -X POST "$NET/api/v1/projects" "${auth[@]}" -d '{"name":"My first OpenVibe app"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).id')
```

**5. Create a sandbox app.** A confidential app gets a client secret, shown **once**; this writes
it straight into an example's `.env` instead of the terminal:

```bash
cd examples/node-server-app
curl -s -X POST "$NET/api/v1/projects/$PRJ/apps" "${auth[@]}" \
  -d '{"name":"examples","environment":"sandbox","type":"confidential","redirect_uris":["http://localhost:3009/callback"]}' \
  | node -e 'const a = JSON.parse(require("fs").readFileSync(0)); require("fs").writeFileSync(".env", `OV_CLIENT_ID=${a.client_id}\nOV_CLIENT_SECRET=${a.credential.client_secret}\n`, { mode: 0o600 }); console.log(a.client_id)'
```

For [browser-app](examples/browser-app) create a second app with `"type":"public"` and the
redirect URI `http://localhost:3001/callback` (no secret).

**6. Request grants.** One call per capability; the audience is the owning service
(`openvibe.media` for `media.*`). As the project owner, a request inside the project's allowance is
approved at once; a developer's request waits for an owner or admin
(`POST …/grants/<capability>/approve`).

```bash
APP=app_...   # the client id printed above
for c in media.object.upload media.object.read tools.job.create tools.job.read; do
  curl -s -X POST "$NET/api/v1/projects/$PRJ/apps/$APP/grants" "${auth[@]}" -d "{\"capability\":\"$c\"}"; echo
done
```

**7. Run the examples.** Start with [node-server-app](examples/node-server-app): its `/status`
shows the services the registry knows and, per audience, whether Network will give your app a
token and which capabilities it carries. Then follow each example's "Run it against the real
platform" section.

Rotate a secret with `POST …/apps/$APP/credentials/rotate`, revoke one with
`POST …/credentials/<id>/revoke`, revoke the app with `DELETE …/apps/$APP`. Issued tokens end
within their 5-minute lifetime.

## What works against the real platform today

These are the platform-side conditions as of this release, read from the services' code and docs.
Nothing here was run against production.

| Example | Today |
|---|---|
| mod-manifest | Works: validation is offline; `--registry` reads the public registry. Publishing a mod is not public yet. |
| node-server-app | Discovery and registry work for anyone. App tokens: see "Tokens" below. |
| chat-bot | Should work on openvibe.live chat with a Live API token (`hbt_…`, scope `chat`) from a dedicated bot account. Not a developer-app credential: Chat has no app principal, and `chat.message.send` is `first-party`. |
| tool-job | Tools accepts app tokens on `/api/v1/jobs`. Needs a token for `openvibe.tools` (see "Tokens"). |
| media-uploader | Needs a token for `openvibe.media` (see "Tokens") **and** a Media tenant named after your project id, created by the Media operators. |
| oauth-app, browser-app | Sign-in needs a token for the requested audience (see "Tokens"); production apps need an https redirect URI. The browser cannot read the registry cross-origin yet (Network's CORS allow-list runs first), so browser-app falls back to its own server and says so. |
| event-subscriber | Realtime works anonymously for `public` events. Pull cannot work: `events.event.read` is `internal` and the pull API is not on Events' public host. |
| webhook-consumer | Cannot be demonstrated: `events.subscription.manage` is `internal`, the subscription API is not on Events' public host, and deliveries only go to allow-listed hosts. The consumer itself is ready. |

**Tokens.** Two defaults on Network block every app token until staff change them:

- `DEV_SANDBOX_AUDIENCES` is empty, so a **sandbox** app gets `400 invalid_target` for every
  audience, and receivers built on openvibe-contracts ≥ 0.26 also refuse `env: sandbox` tokens
  unless they opt in. A **production** app avoids this, but only after staff switch the project to
  `sandbox+production`.
- `DEV_DEFAULT_ALLOWANCE` is empty, so a grant request stays unapproved (`403 grant.beyond_allowance`
  on approval) until staff put the capability in your project's allowance.

Capabilities a developer app can hold today (`public` + `active` in openvibe-contracts v0.26.0):
`media.object.upload`, `media.object.read`, `tools.job.create`, `tools.job.read`,
`tools.job.cancel`, `games.mod.read`, `games.world.announce`, `games.prop.place`. No `events.*`,
`chat.*` or identity capability is grantable.

So the Wave 20 exit criterion ("a new external developer goes from account creation to a working
Media, event and capability integration using only public documentation, the SDK and scoped
credentials") is **not met on the live platform yet**: Media needs staff actions (sandbox
audience or production policy, allowance, Media tenant), and the event integration has no public
path except anonymous realtime.

## Layout

```
examples/<name>/          one example: README.md, .env.example, package.json, code, test/smoke.test.js
test/run.js               runs every smoke test and the repository checks (npm test)
test/public-surface.test.js, test/structure.test.js
.github/workflows/ci.yml  Node 22.22.1: npm ci && npm test
```

## Owns

- the nine charter examples: vanilla browser app, Node server app, webhook consumer, event
  subscriber, Media uploader, Chat bot, tool/job example, mod manifest example, OAuth app example

## Does not own

- any platform service, the SDK (OpenVibe.SDK) or the contracts (OpenVibe.Contracts)

## Depends on

- OpenVibe.SDK (v0.2.2), OpenVibe.Contracts (v0.26.0, mod manifest only)
- at run time against the real platform: Network (tokens, registry, developer projects), Events
  (realtime), Media, Tools, Chat (on openvibe.live)

## Acceptance

- CI runs every example: **yes**, against the SDK's mock platform and local mocks (no network).
  Running them in CI against an integration environment needs sandbox-enabled audiences and a
  CI project with grants; that environment does not exist yet.
- No example needs a loopback-only internal key or first-party database access: **yes**, enforced
  by `test/public-surface.test.js`.

---

Part of the [OpenVibe network](https://openvibe.network). Built in the open by [OpenVibers](https://github.com/OpenVibers).
