# Media uploader

Upload a file to OpenVibe.Media as a developer app, using `openvibe-sdk/media` and nothing else.

```bash
node --env-file=.env upload.js ./logo.png
# {
#   "key": "3f2a9c0d1b7e-logo.png",
#   "public_url": "https://openvibe.media/f/3f2a9c0d1b7e-logo.png",
#   "size": 5120, "mime": "image/png", "sha256": "…", "deduplicated": false
# }
```

## What it proves

- An app with only a client id, a secret and one grant (`media.object.upload`) gets a 5-minute
  app token from Network's public token endpoint, asking for exactly that capability (`scope`).
- Media's origin comes from the platform descriptor (`client.discover()`), not a hard-coded host,
  and the contracts version the network runs is checked against the SDK's supported range.
- The upload lands in the app's own namespace. For a developer app that is the **project id**
  (`prj_…`), because Network puts the project id in the token's `ns` claim. Another namespace is
  refused by Media with `403 capability.namespace_denied`.
- Uploads are content-addressed: the same bytes again come back `deduplicated`, so retries are safe.
- The secret is read from the environment and never printed, not even in error messages.

## Files

| File | What |
|---|---|
| `upload.js` | `loadConfig()`, `createUploader()`, `explain()` (hints for the usual errors), CLI |
| `test/smoke.test.js` | the flow against `openvibe-sdk/testing` (fake Network + Media) |

## Run the smoke test

```bash
npm test          # from this folder, or `npm test -- media` from the repository root
```

No network: Network and Media are the SDK's in-process mock, with real RS256 tokens and the same
audience, capability and namespace checks.

## Run it against the real platform

1. Follow the [walkthrough](../../README.md#end-to-end-walkthrough) to create a project and a
   **confidential** app, and request `media.object.upload` on it.
2. `cp .env.example .env` and fill in `OV_CLIENT_ID`, `OV_CLIENT_SECRET` and
   `OV_MEDIA_NAMESPACE` (your `prj_…` project id).
3. `node --env-file=.env upload.js ./some-file.png`

What has to be true on the platform side first, and is **not** true by default today:

- **Sandbox apps get no Media token.** Network issues sandbox tokens only for audiences listed in
  `DEV_SANDBOX_AUDIENCES`, which is empty by default, so a sandbox app gets `invalid_target`.
  Media must also accept `env: sandbox` tokens. Until both opt in, use a production app (staff
  switch the project to `sandbox+production`).
- **The capability must be in your project's allowance** (staff set it; the default allowance is empty).
- **Media needs a tenant named after your project id.** Media only accepts uploads for tenants it
  knows, and tenants are created by the Media operators.
- Media v1 accepts app tokens for **upload only**. Listing, reading metadata and deleting
  (`media.files.list/get/delete`) need a Media app API key, which developer apps do not have.
