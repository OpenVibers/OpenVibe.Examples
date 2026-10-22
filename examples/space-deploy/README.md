# Deploy to Space from CI

Ship a static site to [OpenVibe.Space](https://openvibe.space) from your build pipeline. Every push
to `main` goes live and every pull request gets a preview. A rollback is one command.

```bash
npm run build && node --env-file=.env deploy.js
# Uploading 42 file(s), 318.4 KB, from dist
# Live: site sit_01J… now serves deploy dpl_01J…

OV_PREVIEW=1 node --env-file=.env deploy.js       # a preview, never live
node --env-file=.env deploy.js --rollback           # back to the previous deploy
```

[`github-workflow.yml`](github-workflow.yml) is a ready GitHub Actions workflow: copy it to
`.github/workflows/deploy-to-space.yml` with `deploy.js`.

## What it proves

- **An app token, not a person's:**
  - a developer app's client credentials, for audience `openvibe.space`, scoped to
    `space.deploy.create` alone;
  - the app is a member of the site's project with the **deployer** role, so it can deploy and roll
    back, and nothing more;
  - the SDK caches the five-minute token and refreshes it.
- **The built folder becomes one deploy:**
  - `space.deploys.uploadFiles()` sends every file with its path and type;
  - dotfiles (`.env`, `.git`) stay behind, and an `index.html` at the top is required;
  - Space checks the whole upload before anything changes.
- **Live or preview:**
  - live (`activate`) switches the site to the new deploy in one atomic step;
  - a preview (`preview`) is never activated; it is the site's preview until it expires.
- **A refused upload changes nothing.** A full quota or a file Space won't serve comes back as
  Space's problem+json code (`quota.exceeded`, `upload.busy`, …), and the site keeps serving what
  it served.
- **Rollback** (`space.deploys.rollback`) goes back to the previous deploy, or a named `dpl_…`,
  just as atomically.

For thousands of files or a big site, `space.deploys.uploadArchive()` takes a tar.gz in one body.

## Files

| File | What |
|---|---|
| `deploy.js` | `loadConfig()`, `createSpace()`, `collectFiles()`, `deploy()`, `rollback()`, CLI |
| `github-workflow.yml` | the GitHub Actions workflow: live on `main`, preview on pull requests |
| `test/smoke.test.js` | token, upload, preview, refusal and rollback against a stand-in for Network and Space |

## Run the smoke test

```bash
npm test
```

The test hands the SDK a `fetch` that answers like Network's `/oauth/token` and Space's deploy
routes (`server/http/api.js` on OpenVibe.Space's main). It checks:
- the token's audience and scope, and that the token is cached;
- the form's file names and types, with dotfiles left out;
- the `activate` and `preview` flags;
- that a `quota.exceeded` refusal reaches the caller;
- both rollback forms.

Nothing reaches the network.

## Run it against the real platform

1. At [openvibe.space](https://openvibe.space), create a project and a site. The site's page shows
   its id (`sit_…`) and address.
2. At [openvibe.services](https://openvibe.services), create a developer app in the same project
   and copy its client id and secret.
3. Back in Space, open **project → Members** and add `app:<client id>` as a **deployer**.
4. Locally: `cp .env.example .env`, fill it in, and run `npm run build && npm start`.
5. In CI, store `OV_CLIENT_ID` and `OV_CLIENT_SECRET` as repository secrets and `OV_SPACE_SITE` as
   a variable.

The site's address and its deploy history are on its page in the Space dashboard. Reading them from
code needs `space.site.manage`, which a deploy job doesn't need.
