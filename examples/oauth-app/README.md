# OAuth app

"Sign in with OpenVibe" for a **confidential** developer app: authorization code + PKCE, with the
code exchanged on the server.

```bash
node --env-file=.env server.js      # open http://localhost:3009 and click "Sign in with OpenVibe"
```

## What it proves

| Step | Where | What |
|---|---|---|
| `/login` | server | `startAuthorization()` makes the PKCE pair (S256) and `state`; both stay in this browser's **server-side** session (HttpOnly, SameSite=Lax cookie); redirect to Network's `/oauth/authorize` with the `audience` and the capability ids to ask for (`scope`) |
| Network | | the person signs in and chooses to continue; Network redirects back with `code` and `state` |
| `/callback` | server | `readCallback()` checks `state` (refuses callbacks this browser did not start, and `error=` answers); `exchangeCode()` exchanges the code **once**, with the client secret, the PKCE verifier and the same `audience`; `verifyAppToken()` checks the app token offline against Network's JWKS (signature, issuer, audience, expiry, claim shape); the session id is replaced (no session fixation) |
| `/api/me` | server | who signed in (`usr_…`), and the capabilities this app may use for them |

What comes back is an **app token acting for the person**: `actor_type: app`, `sub: app:<your app id>`,
`on_behalf_of: usr_…`, `cap` = what they authorized, `aud` = the one audience, 5-minute lifetime
and **no refresh token**. When it expires the person signs in again. The app checks the token was
minted for itself (`sub`) before trusting `on_behalf_of`.

Also covered by the test: a replayed callback, a forged `state`, a declined sign-in
(`oauth.access_denied`), someone outside the project trying to authorize its sandbox app
(`oauth.access_denied`), a code bound to another PKCE challenge (`invalid_grant`), sign-out, and
that neither the secret nor any token reaches the browser or the logs.

## Files

| File | What |
|---|---|
| `server.js` | `createApp()`, `signedInSubject()` |
| `test/smoke.test.js` | the flow against `openvibe-sdk/testing`, whose `/oauth/authorize` plays Network's account chooser |

## Run the smoke test

```bash
npm test
```

## Run it against the real platform

1. Create a project and a **confidential** sandbox app with the redirect URI
   `http://localhost:3009/callback` ([walkthrough](../../README.md#end-to-end-walkthrough);
   `npm run new-app` at the repository root registers exactly that one). `http://localhost`
   redirect URIs are allowed for sandbox apps only; a production app needs an https one.
2. Request a grant for every capability in `OV_SCOPE` (the default `media.object.upload
   media.object.read`, audience `openvibe.media`, are both in the sandbox allowance).
3. `cp .env.example .env`, fill in `OV_CLIENT_ID`, `OV_CLIENT_SECRET`, `OV_AUDIENCE`, `OV_SCOPE`.
4. `node --env-file=.env server.js` and sign in **as a member of the project**: a sandbox app can
   only be authorized by its project's members.

What is still missing on the platform:

- **No consent screen.** Network's account chooser names the app (marked "third-party app") but
  does not list the capabilities it asks for yet.
- **No refresh tokens for apps.** The token lasts 5 minutes; then the person signs in again.
- **No identity for apps.** An app learns the person's `usr_…` id (`on_behalf_of`) and nothing
  else: profile lookups are `first-party` capabilities.
