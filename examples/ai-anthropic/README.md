# AI with the Anthropic SDK

Use OpenVibe.AI from the official [`@anthropic-ai/sdk`](https://www.npmjs.com/package/@anthropic-ai/sdk) client.
Point its `baseURL` at `https://ai.openvibe.services` (the SDK adds `/v1/messages`) and give it a Network app token
through `credentials`.

```bash
node --env-file=.env ask.js "Say hi in five words"
# Hi there, nice to meet you!
# (qwen/qwen3-8b-abliterated:q4_k_m@3f2a1c9, $0.000001)
```

## What it proves

- **An app token of `openvibe.ai`, scoped `ai.app.run`.** This is the public capability developer apps call AI
  with; a sandbox app holds it without staff.
  - Network tokens last five minutes, so the SDK's `credentials` provider asks `openvibe-sdk/auth` for a fresh one.
  - The SDK sends it as `Authorization: Bearer`, never as an Anthropic `x-api-key`.
- **`messages.create()` works unchanged.**
  - `model` is a dynamic name (`openvibe`, `openvibe/economy`, …) or an exact model id from the model list.
  - The answer's `model` names the model that ran, and `x_openvibe` adds the run, the provider and the cost.

## Run the smoke test

`npm test -w examples/ai-anthropic` runs the real SDK against stand-ins of Network and AI, with no network.

## Run it against the real platform

1. Make a sandbox app in your project on OpenVibe.Services (Projects → Apps). It holds `ai.app.run`.
2. Copy `.env.example` to `.env` and fill in the app's client id and secret.
3. Run `node --env-file=.env ask.js "Say hi in five words"`.
