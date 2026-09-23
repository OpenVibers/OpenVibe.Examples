# Vanilla browser app

A plain HTML page, no framework and no build step, that signs in with OpenVibe using PKCE and
reads a public API (the ecosystem registry) straight from the browser. The page imports the SDK's
browser bundle, `openvibe-sdk/browser/openvibe-sdk.mjs`, as an ES module.

```bash
node --env-file=.env server.js      # open http://localhost:3001
```

## What it proves

- **The SDK in a page without a bundler.** `public/app.js` is a module that imports
  `createClient`, `auth` and `registry` from `/vendor/openvibe-sdk.mjs`, which the server serves
  unchanged from `node_modules/openvibe-sdk/browser/`. The bundle holds only browser-safe code (no
  service tokens, no JWT verification, no secrets); the SDK tests that, and so does this example.
- **A public API from the page.** The page reads `https://openvibe.network/api/v1/registry/services`
  itself, cross-origin, with no token and no cookie: Network answers the registry and
  `/.well-known/openvibe` to any origin (CORS, preflight included). The DOM is built with
  `textContent`, never `innerHTML`, under a strict CSP.
- **PKCE in the browser.** The page calls `auth.startAuthorization()` with the app's `audience`
  and the capability ids it asks for; the verifier and `state` live in `sessionStorage` until
  Network redirects back to `/callback`, where `readCallback()` checks `state` and the address bar
  is cleaned. The verifier is used once.
- **A public app has no secret.** The app is registered as `public`. Its tiny server exchanges
  code + verifier with `exchangeCode()` (no secret; the audience is sent), verifies the app token
  with `verifyAppToken()` and keeps it in an HttpOnly session. It holds no secrets at all. The
  exchange endpoint only accepts same-origin JSON requests (`Origin` check, `415` otherwise), so
  another site cannot drive it.

## Files

| File | What |
|---|---|
| `public/index.html`, `public/app.js` | the page and its module script |
| `server.js` | static files, `/vendor/openvibe-sdk.mjs`, `/config.json`, `/auth/exchange`, `/api/session`, `/auth/logout`, and the optional `/api/registry/services` |
| `test/smoke.test.js` | runs `public/app.js` and the SDK bundle as ES modules in a small fake browser (vm) against the server and the SDK mock |

## Run the smoke test

```bash
npm test
```

There is no real browser in CI: the test links the page's module script to the served bundle with
`vm.SourceTextModule` (Node 22 runs it with `--experimental-vm-modules`; the test re-runs itself
with that flag), gives it a minimal DOM, `sessionStorage`, `location`, a cookie jar and `fetch`,
clicks "Sign in", follows Network's authorize URL on the SDK mock (its account chooser redirects
back with a code), and checks the signed-in state, a forged callback, the registry read and the
optional server fallback.

## Run it against the real platform

1. Create a project and a **public** sandbox app with the redirect URI
   `http://localhost:3001/callback` and the grant `media.object.read`
   ([walkthrough](../../README.md#end-to-end-walkthrough); `npm run new-app -- --public
   --project prj_…` at the repository root does exactly that). Any grant works if you change
   `OV_AUDIENCE` / `OV_SCOPE` to match it.
2. `cp .env.example .env`, set `OV_CLIENT_ID`.
3. `node --env-file=.env server.js`, open `http://localhost:3001`, sign in as a member of the
   project (a sandbox app can only be authorized by its project's members).

Things to know:

- **The token exchange stays on a server.** Network's `/oauth/*` routes are not CORS-open to
  third-party origins, so a browser cannot call the token endpoint itself; this is also where
  the token is best kept (an HttpOnly session, not page scripts).
- **The server-side registry read is optional.** With `OV_REGISTRY_PROXY=1` the server also
  answers `/api/registry/services`, and the page falls back to it when the browser cannot reach
  Network. It is off by default because the registry is readable from the browser.
- **No consent screen** yet (Network's account chooser does not list the capabilities), and an app
  learns only the person's `usr_…` id: there is no identity-only sign-in for apps, and profile
  lookups are `first-party`.
