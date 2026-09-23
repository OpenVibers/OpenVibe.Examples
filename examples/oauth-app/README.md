# OAuth app

"Sign in with OpenVibe" for a **confidential** developer app: authorization code + PKCE, with the
code exchanged on the server.

```bash
node --env-file=.env server.js      # open http://localhost:3009 and click "Sign in with OpenVibe"
```

## What it proves

| Step | Where | What |
|---|---|---|
| `/login` | server | `startAuthorization()` makes the PKCE pair (S256) and `state`; both stay in this browser's **server-side** session (HttpOnly, SameSite=Lax cookie); redirect to Network's `/oauth/authorize` with the capability ids to ask for (`scope`) |
| Network | | the person signs in and chooses to continue; Network redirects back with `code` and `state` |
| `/callback` | server | `readCallback()` checks `state` (refuses callbacks this browser did not start, and `error=` answers); the code is exchanged **once**, with the client secret, the PKCE verifier and the `audience`; the token is verified offline against Network's JWKS (signature, issuer, audience, expiry); the session id is replaced (no session fixation) |
| `/api/me` | server | who signed in (`usr_…`), and the capabilities this app may use for them |

What comes back is an **app token acting for the person**: `actor_type: app`, `sub: app:<your app id>`,
`on_behalf_of: usr_…`, `cap` = what they authorized, `aud` = the one audience, 5-minute lifetime
and **no refresh token**. When it expires the person signs in again. The app checks the token was
minted for itself (`sub`) before trusting `on_behalf_of`.

Also covered by the test: a replayed callback, a forged `state`, a declined consent
(`oauth.access_denied`), a code bound to another PKCE challenge (`invalid_grant`), sign-out, and
that neither the secret nor any token reaches the browser or the logs.

## Files

| File | What |
|---|---|
| `server.js` | `createApp()`, `exchangeAppCode()`, `signedInSubject()` |
| `test/smoke.test.js` | the flow against `openvibe-sdk/testing` (`platform.authorize()` stands in for the consent page) |

## Run the smoke test

```bash
npm test
```

## Run it against the real platform

1. Create a project and a **confidential** app with the redirect URI
   `http://localhost:3009/callback` ([walkthrough](../../README.md#end-to-end-walkthrough)).
   `localhost` redirect URIs are allowed for sandbox apps only; a production app needs an https one.
2. Request a grant for every capability in `OV_SCOPE` (for example `media.object.read` for audience
   `openvibe.media`). Signing in needs at least one approved grant for `OV_AUDIENCE`.
3. `cp .env.example .env`, fill in `OV_CLIENT_ID`, `OV_CLIENT_SECRET`, `OV_AUDIENCE`, `OV_SCOPE`.
4. `node --env-file=.env server.js` and sign in **as a member of the project** (a sandbox app can
   only be authorized by its project's members).

What blocks it today: Network mints the token only if the app may have one for `OV_AUDIENCE`. A
sandbox app gets `invalid_target` at the exchange until staff list that audience in
`DEV_SANDBOX_AUDIENCES` (empty by default). A production app avoids that but needs an https
redirect URI, so it has to run somewhere with TLS. Network's account chooser does not list the
requested capabilities yet (no consent screen).

## Why not `exchangeCode()`?

`openvibe-sdk` 0.2.2's `exchangeCode()` requires a client secret and cannot send `audience`, which
Network requires when the client is a developer app. `exchangeAppCode()` here calls the same
public token endpoint through the SDK's core client (with retries off: a code works once).
