# Vanilla browser app

A plain HTML page, no framework and no build step, that signs in with OpenVibe using PKCE
(`openvibe-sdk/auth/browser`) and reads a public API (the ecosystem registry) straight from the browser.

```bash
node --env-file=.env server.js      # open http://localhost:3001
```

## What it proves

- **PKCE in the browser.** The page calls `startAuthorization()`; the verifier and `state` live in
  `sessionStorage` until Network redirects back to `/callback`, where `readCallback()` checks
  `state` and the address bar is cleaned. The verifier is used once.
- **A public app has no secret.** The app is registered as `public`. Its tiny server exchanges
  code + verifier at Network's token endpoint (no secret; `audience` is sent) and keeps the
  resulting token in an HttpOnly session. It holds no secrets at all. The exchange endpoint only
  accepts same-origin JSON requests (`Origin` check, `415` otherwise), so another site cannot drive it.
- **A public API from the page.** `openvibe-sdk/registry` lists the network's services with no
  token and no cookie. The DOM is built with `textContent`, never `innerHTML`, under a strict CSP.
- **The SDK in a page without a bundler.** `openvibe-sdk` is CommonJS, so `lib/sdk-bundle.js`
  serves its browser-safe modules (`core`, `auth/browser`, `registry`) as one script that sets
  `window.OpenVibeSDK`. It refuses to include anything that is not a relative SDK module, and the
  test checks the served script contains no server-only code. With a bundler, import
  `openvibe-sdk/auth/browser` directly instead.

## Files

| File | What |
|---|---|
| `public/index.html`, `public/app.js` | the page |
| `server.js` | static files, `/sdk/openvibe-sdk.js`, `/config.json`, `/auth/exchange`, `/api/session`, `/api/registry/services`, `/auth/logout` |
| `lib/sdk-bundle.js` | the serve-time wrapper for the SDK's browser modules |
| `test/smoke.test.js` | runs `public/app.js` and the served bundle in a small fake browser (vm) against the server and the SDK mock |

## Run the smoke test

```bash
npm test
```

There is no real browser in CI: the test gives the page's own script a minimal DOM,
`sessionStorage`, `location`, a cookie jar and `fetch`, clicks "Sign in", follows the redirect with
a code from `platform.authorize()` (which stands in for Network's consent page and verifies PKCE),
and checks the signed-in state, a forged callback, the registry read and its fallback.

## Run it against the real platform

1. Create a project and a **public** app with the redirect URI `http://localhost:3001/callback`
   ([walkthrough](../../README.md#end-to-end-walkthrough)); request `media.object.read` (or any
   grant for the audience you put in `OV_AUDIENCE`).
2. `cp .env.example .env`, set `OV_CLIENT_ID`.
3. `node --env-file=.env server.js`, open `http://localhost:3001`, sign in as a project member.

What does not work yet on the real platform:

- **The registry refuses third-party browser origins.** Network answers the registry with
  `Access-Control-Allow-Origin: *`, but its site-wide CORS allow-list rejects unknown origins
  first, and SDK calls carry `traceparent` / `X-OpenVibe-Request-Id` headers, which need a
  preflight. The page therefore falls back to reading the same public registry through its own
  server (`/api/registry/services`) and says so on the page.
- **Sign-in** needs Network to mint a token for `OV_AUDIENCE`: a sandbox app gets `invalid_target`
  until staff list that audience in `DEV_SANDBOX_AUDIENCES`; a production app needs an https
  redirect URI. Sign-in always asks for a capability: there is no identity-only sign-in for
  apps, and an app learns only the person's `usr_…` id (profile lookups are `first-party`).
