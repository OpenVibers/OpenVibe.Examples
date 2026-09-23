# Media uploader

Upload a file to OpenVibe.Media as a developer app, read it back and delete it, using
`openvibe-sdk/media` and nothing else.

```bash
node --env-file=.env upload.js ./logo.png
# {
#   "key": "3f2a9c0d1b7e-5d0c11aa-logo.png",
#   "url": "https://openvibe.media/f/3f2a9c0d1b7e-5d0c11aa-logo.png?exp=…&sig=…",
#   "url_expires_at": "2026-…",
#   "sandbox": true,
#   "size": 5120, "mime": "image/png", "sha256": "…", "deduplicated": false,
#   "project_id": "prj_…", "contracts": "0.28.0"
# }
node --env-file=.env upload.js --get 3f2a9c0d1b7e-5d0c11aa-logo.png
node --env-file=.env upload.js --delete 3f2a9c0d1b7e-5d0c11aa-logo.png
```

## What it proves

- An app with only a client id, a secret and its grants gets a 5-minute app token from Network's
  public token endpoint, asking for exactly the capability each call needs (`scope`):
  `media.object.upload` to upload or delete, `media.object.read` to read.
- Media's origin comes from the platform descriptor (`client.discover()`), not a hard-coded host,
  and the contracts version the network runs is checked against the SDK's supported range.
- **Your project is your Media tenant.** The path names the project id (`prj_…`), which is also the
  token's `project_id` and `ns`; it is read from the token when `OV_PROJECT_ID` is empty. Another
  project's tenant is refused with `403 capability.namespace_denied`.
- **Sandbox files are private.** Media keeps a sandbox app's files in a separate sandbox tenant of
  the project (you still address it by the project id) and never serves them publicly: an upload
  comes back with `sandbox: true` and a signed, expiring `url`. A production app's files get a
  public `/f/<key>` URL.
- Uploads are content-addressed: the same bytes again come back `deduplicated`, so retries are safe.
- The secret is read from the environment and never printed, not even in error messages.

## Files

| File | What |
|---|---|
| `upload.js` | `loadConfig()`, `createUploader()` (`upload`, `get`, `remove`), `describe()`, `explain()` (hints for the usual errors), CLI |
| `test/smoke.test.js` | upload, signed URL, read back, delete, and the refusals, against `openvibe-sdk/testing` with a sandbox app |

## Run the smoke test

```bash
npm test          # from this folder, or `npm test -- media` from the repository root
```

No network: Network and Media are the SDK's in-process mock, with real RS256 tokens and Media's
tenant rules: the project id addresses the tenant, the token's env picks `prj_…` or
`prj_…-sandbox`, uploads and deletes need `media.object.upload`, reads `media.object.read`, and a
sandbox file answers with a signed `url` that its `/f/<key>` serves only with the signature.

## Run it against the real platform

1. Create a project and a **confidential** sandbox app with `media.object.upload` and
   `media.object.read` ([walkthrough](../../README.md#end-to-end-walkthrough)).
2. `cp .env.example .env` and fill in `OV_CLIENT_ID` and `OV_CLIENT_SECRET`.
3. `node --env-file=.env upload.js ./some-file.png`

Media creates the project's tenant on first use; no operator step is needed. A sandbox tenant has
a small quota (100 MB by default; beyond it an upload is `413`). Open a sandbox file with the signed `url`
before `url_expires_at`; `--get` returns a fresh one.
