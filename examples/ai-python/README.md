# AI from Python

Use OpenVibe.AI from the official [`openai`](https://pypi.org/project/openai/) Python client:
- point `base_url` at `https://ai.openvibe.services/v1`;
- give it a Network app token for `openvibe.ai`, scoped `ai.app.run`.

```bash
pip install openai httpx
OV_CLIENT_ID=… OV_CLIENT_SECRET=… python3 chat.py "Say hi in five words"
# Hi there, nice to meet you!
# (qwen/qwen3-8b-abliterated:q4_k_m@3f2a1c9, $1e-06)
```

## What it proves

- **The token.** The app's client credentials get a five-minute token from Network. `chat.py` keeps the token and
  asks again a minute before it ends.
- **The call.** `chat.completions.create()` works unchanged.
- **The model.** `model` is a dynamic name or an exact model id.
- **The answer.** It names the model that ran, and `x_openvibe` (in the response's extra fields) carries the run,
  the provider and the cost.

## Run the smoke test

`npm test -w examples/ai-python` checks the token request and the base URL, and compiles the script when Python is
on the machine.

## Run it against the real platform

1. Make a sandbox app in your project on OpenVibe.Services (Projects → Apps). It holds `ai.app.run`.
2. Install the client: `pip install openai httpx`.
3. Run `OV_CLIENT_ID=… OV_CLIENT_SECRET=… python3 chat.py "Say hi in five words"`.
