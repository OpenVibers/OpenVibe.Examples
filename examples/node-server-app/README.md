# Node server app

A small HTTP server that runs as a developer app: it authenticates with **client credentials**
and finds the platform through the **registry**.

```bash
node --env-file=.env server.js
curl -s localhost:3002/status
```

`GET /status` answers with:

- `contracts`: the openvibe-contracts release the network runs, and whether this SDK supports it;
- `services`: every registered service with its status and origin (from the registry);
- `grants`: for each audience in `OV_AUDIENCES`, the capabilities an app token for it carries
  (approved grants within your project's allowance), each described by the registry, plus the
  token's `project_id`, `env` and `ns`; or why Network refused (`invalid_scope`, `invalid_target`).

## What it proves

- Discovery with no credentials: `client.discover()` reads `https://openvibe.network/.well-known/openvibe`
  and `openvibe-sdk/registry` reads `/api/v1/registry/*`. Both are public.
- One cached app token per audience (`createServiceTokenClient` as the client's `tokenProvider`),
  refreshed shortly before its 5-minute expiry. A second `/status` does not ask Network again.
- The incoming request's `traceparent` continues on every outbound call (`client.fromRequest(req)`).
- Errors are reported by stable code and request id; the secret and tokens never leave the process.

## Files

| File | What |
|---|---|
| `server.js` | `loadConfig()`, `createApp()` (the HTTP server and `status()`), `peekClaims()` |
| `test/smoke.test.js` | discovery, registry, grants per audience, token caching, trace propagation |

## Run the smoke test

```bash
npm test
```

## Run it against the real platform

1. Create a project and a **confidential** app ([walkthrough](../../README.md#end-to-end-walkthrough)).
2. `cp .env.example .env`, fill in `OV_CLIENT_ID` and `OV_CLIENT_SECRET`, set `OV_AUDIENCES` to
   the audiences you hold grants for (`openvibe.media`, `openvibe.tools`, …).
3. `node --env-file=.env server.js` and open `http://localhost:3002/status`.

Discovery and the registry work for anyone today. The `grants` part shows a token only when
Network will issue one: a **sandbox** app gets `invalid_target` for every audience until staff list
that audience in `DEV_SANDBOX_AUDIENCES` (empty by default), and any app gets `invalid_scope` until
a grant is approved inside the project's allowance (also empty by default).
