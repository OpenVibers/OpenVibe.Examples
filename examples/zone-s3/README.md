# Zone over S3 (AWS SDK v3)

Use [OpenVibe.Zone](https://openvibe.zone)'s private buckets ("zones") from Node with the official
AWS SDK v3, as you would S3. Zone's S3 endpoint is **path-style, region `us-east-1`, Signature
Version 4**.

```bash
node --env-file=.env zone.js
# put    s3://assets/openvibe-example/hello-1729….txt
# list   1 object(s) under openvibe-example/
# share  a 10-minute link reads the same bytes
# get    the same bytes (62 bytes)
# delete s3://assets/openvibe-example/hello-1729….txt

node --env-file=.env zone.js put ./report.pdf reports/2026-10.pdf
node --env-file=.env zone.js ls reports/
node --env-file=.env zone.js share reports/2026-10.pdf 86400
```

## What it proves

- **An `S3Client` for Zone** is three settings: `endpoint: 'https://s3.openvibe.media'`,
  `region: 'us-east-1'` and `forcePathStyle: true`. Everything else is the SDK's defaults, including
  its flexible checksums and aws-chunked uploads, which Zone accepts.
- **The everyday calls:**
  - `PutObjectCommand` with a content type;
  - `GetObjectCommand`;
  - `paginateListObjectsV2`, which follows pages;
  - a presigned GET link from `@aws-sdk/s3-request-presigner`, lasting 1 s to 7 days, which opens
    without credentials until it expires or its key is revoked;
  - `DeleteObjectCommand`.
- **The access key** is the only credential. It belongs to one project environment and may be
  limited to some zones and to read or write. Its secret is shown once, when it is issued, and it
  signs requests: it never travels, appears in a link or is printed.
- **Large files:** one request carries at most 256 MB. `@aws-sdk/lib-storage`'s `Upload` (or
  `aws s3 cp`, or rclone) sends bigger files in parts, under S3's rules (every part but the last at
  least 5 MiB).
- A zone's objects are OpenVibe.Media objects. Media's API
  (`/api/v2/:project_id/objects` with `namespace` set to the zone's id) reads the same files.

## Files

| File | What |
|---|---|
| `zone.js` | `loadConfig()`, `createS3()`, `put()`, `get()`, `list()`, `share()`, `remove()`, `roundTrip()`, CLI |
| `test/smoke.test.js` | the real AWS SDK v3 against a local stand-in for Zone's S3 endpoint |

## Run the smoke test

```bash
npm test
```

The test runs the real `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` against a stand-in
for Zone's endpoint on 127.0.0.1. The stand-in handles path-style requests and decodes aws-chunked
bodies, as OpenVibe.Media's `server/s3/routes.js` does. It checks:
- the signature's scope (`<key id>/<date>/us-east-1/s3/aws4_request`);
- path-style addressing;
- the list paginator following continuation tokens;
- the share link's expiry and that it opens without credentials;
- `NoSuchKey` after a delete;
- that a key from elsewhere is refused;
- that the secret never appears on the wire or in output.

## Run it against the real platform

1. Sign in at [openvibe.zone](https://openvibe.zone), pick a project (or make one at
   openvibe.services) and create a zone, for example `assets`. You can also create zones with
   `openvibe-sdk/zone` (`zone.zones.create(projectId, { env, name, quota_bytes })`) from an app of
   the project.
2. Issue an access key that can read and write that zone, and copy its secret, which is shown once.
3. `cp .env.example .env`, fill in `OV_S3_ACCESS_KEY_ID`, `OV_S3_SECRET_ACCESS_KEY` and `OV_ZONE`,
   then `npm install && npm start`.

The round trip writes one small object under `openvibe-example/` and deletes it again.

The same settings work in other tools:
- the AWS CLI: `aws --endpoint-url https://s3.openvibe.media s3 ls s3://assets/`;
- rclone: `provider Other`, the endpoint above, `no_check_bucket true`.
