# AI chat

Use OpenVibe.AI from the official [`openai`](https://www.npmjs.com/package/openai) npm client: point
its `baseURL` at `https://ai.openvibe.services/v1` and give it a Network app token. Plain answers,
streamed answers, and your project's own provider.

```bash
node --env-file=.env chat.js "Say hi in five words"
# Hi there, nice to meet!
# run run_01K… on local, $0

node --env-file=.env chat.js --stream "Count to five"
# One, two, three, four, five.
```

## What it proves

- An app token for `openvibe.ai` scoped to `ai.app.run` (in the sandbox allowance: a sandbox app
  holds it without staff). Network tokens last five minutes, so `apiKey` is a **function**
  (`tokens.getToken`): the client calls it before each request and `openvibe-sdk/auth` caches and
  refreshes the token.
- `chat.completions.create()` works unchanged. `model` may be anything (`openvibe` here): AI's router
  picks the upstream, the answer's `model` names the one that ran, and `x_openvibe` adds `run_id`,
  `provider`, `fallback_used` and `cost_usd`.
- `stream: true` streams the upstream's deltas as they arrive; with `stream_options.include_usage`
  the stream ends with `usage`, then `x_openvibe`, then `[DONE]`.
- **Your project's own provider** (ADR-056): set `OV_PROVIDER_SECRET` and the request carries
  `x_openvibe.provider: { base_url, model, secret }`. `secret` is the **name** of a project secret
  (OpenVibe.Services → project → Secrets) granted to `ai` for that base URL's origin; Network
  reveals the key to AI for that one run, and the key never passes through this code. Your project
  pays its provider directly.
- Errors keep OpenAI's shape (`{ error: { message, type, code } }`), so the client's `APIError` has
  `status` and `code` (for example `401 token.missing`, `403 project_secret.refused`).

## Files

| File | What |
|---|---|
| `chat.js` | `loadConfig()`, `createAiClient()` (an `OpenAI` instance), `ask()`, `askStreamed()`, CLI |
| `test/smoke.test.js` | plain, streamed, own provider and a refusal, against a stand-in for Network and AI |

## Run the smoke test

```bash
npm test
```

The test hands the `openai` client and the token client a `fetch` that answers like Network's
`/oauth/token` and AI's `/v1/chat/completions` (`server/api/openai.js` on OpenVibe.AI's main):
a `chat.completion`, a chunk stream, OpenAI's error object. Nothing reaches the network.

## Run it against the real platform

1. Create a project and a **confidential** sandbox app ([walkthrough](../../README.md#end-to-end-walkthrough));
   `ai.app.run` is in the sandbox allowance.
2. `cp .env.example .env`, fill in `OV_CLIENT_ID` and `OV_CLIENT_SECRET`.
3. `node --env-file=.env chat.js "Say hi"` or `node --env-file=.env chat.js --stream "Count to five"`.

Production app runs on the router are limited to free and local capacity (a small local model without
tools). For a bigger model or tool calls, add your provider's key as a project secret, grant it to
`ai` for the provider's origin, and set `OV_PROVIDER_SECRET` (plus `OV_PROVIDER_BASE_URL` and
`OV_PROVIDER_MODEL`). A secret that is missing or not granted answers `403 project_secret.refused`;
a base URL that is not `https` answers `400`.

Without a token the endpoint answers (production, 2026-10-22):

```json
{"error":{"message":"a service token (audience openvibe.ai) is required","type":"authentication_error","code":"token.missing","param":null}}
```
