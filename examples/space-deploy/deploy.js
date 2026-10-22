'use strict';
/**
 * Deploy a static site to OpenVibe.Space from CI: an app's client-credentials token (audience openvibe.space, scope
 * space.deploy.create) uploads a built folder as a new deploy, and Space switches the site to it in one atomic step,
 * or keeps it as the site's preview for a pull request. A refused upload changes nothing: the site keeps serving its
 * current deploy. `--rollback` goes back to the previous deploy (or a named one) just as atomically.
 *
 *   node --env-file=.env deploy.js                    # upload ./dist and make it live
 *   OV_PREVIEW=1 node --env-file=.env deploy.js       # a preview deploy (pull requests)
 *   node --env-file=.env deploy.js --rollback          # back to the previous deploy
 *
 * The app must be a member of the site's project with the deployer role (Space → project → Members → add app:<id>).
 * github-workflow.yml next to this file runs it on every push to main and as a preview for pull requests.
 */
const fs = require('node:fs');
const path = require('node:path');
const { createClient } = require('openvibe-sdk/core');
const { createServiceTokenClient } = require('openvibe-sdk/auth');
const { createSpaceClient } = require('openvibe-sdk/space');

const SITE_RE = /^sit_[0-9A-HJKMNP-TV-Z]{26}$/;
const MAX_FILES = 5000;

function loadConfig(env = process.env) {
    const missing = ['OV_CLIENT_ID', 'OV_CLIENT_SECRET', 'OV_SPACE_SITE'].filter((k) => !env[k]);
    if (missing.length) throw new Error(`missing environment variables: ${missing.join(', ')}`);
    if (!SITE_RE.test(env.OV_SPACE_SITE)) throw new Error('OV_SPACE_SITE is a site id (sit_…), shown on the site\'s page in the Space dashboard');
    return {
        network: env.OV_NETWORK_URL || 'https://openvibe.network',
        spaceUrl: String(env.OV_SPACE_URL || 'https://openvibe.space').replace(/\/+$/, ''),
        clientId: env.OV_CLIENT_ID,
        clientSecret: env.OV_CLIENT_SECRET,
        site: env.OV_SPACE_SITE,
        dir: env.OV_DIR || 'dist',
        preview: env.OV_PREVIEW === '1' || env.OV_PREVIEW === 'true',
    };
}

/** Space's client on an app token that the SDK caches and refreshes (Network tokens last five minutes). */
function createSpace(config, { fetch } = {}) {
    const tokens = createServiceTokenClient({
        network: config.network, clientId: config.clientId, clientSecret: config.clientSecret, fetch,
        audience: 'openvibe.space', scope: 'space.deploy.create',
    });
    return createSpaceClient(createClient({ tokenProvider: tokens, baseUrls: { space: config.spaceUrl }, ...(fetch ? { fetch } : {}) }));
}

const TYPES = {
    '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
    '.gif': 'image/gif', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml', '.wasm': 'application/wasm',
};

/** Every file under dir as { path, data, type }, paths with forward slashes; dotfiles (.git, .env) stay behind. */
function collectFiles(dir) {
    const root = path.resolve(dir);
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`${dir} is not a folder: build the site first`);
    const files = [];
    (function walk(d) {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            if (e.name.startsWith('.')) continue;
            const p = path.join(d, e.name);
            if (e.isDirectory()) walk(p);
            else if (e.isFile()) {
                const rel = path.relative(root, p).split(path.sep).join('/');
                files.push({ path: rel, data: fs.readFileSync(p), type: TYPES[path.extname(e.name).toLowerCase()] || 'application/octet-stream' });
                if (files.length > MAX_FILES) throw new Error(`more than ${MAX_FILES} files in ${dir}: upload a tar.gz with space.deploys.uploadArchive instead`);
            }
        }
    })(root);
    if (!files.some((f) => f.path === 'index.html')) throw new Error(`${dir} has no index.html at its top`);
    return files;
}

/** Upload the folder → { deploy, activated, preview }. Live unless config.preview. */
async function deploy(space, config, { log = console.log } = {}) {
    const files = collectFiles(config.dir);
    const bytes = files.reduce((n, f) => n + f.data.length, 0);
    log(`Uploading ${files.length} file(s), ${(bytes / 1024).toFixed(1)} KB, from ${config.dir}${config.preview ? ' as a preview' : ''}`);
    // The token holds space.deploy.create only: reading the site itself (its address) needs space.site.manage, which
    // a deploy job has no use for. The address is on the site's page in the Space dashboard.
    const out = await space.deploys.uploadFiles(config.site, files, config.preview ? { preview: true } : { activate: true });
    if (out.preview) log(`Preview deploy ${out.deploy.id} is ready until ${out.preview.expires_at}; open it from the site's page in the Space dashboard`);
    else log(`Live: site ${config.site} now serves deploy ${out.deploy.id}`);
    return out;
}

/** Back to an earlier deploy (the previous one, or deployId) → { active_deploy_id, previous_deploy_id, changed }. */
async function rollback(space, config, deployId, { log = console.log } = {}) {
    if (deployId && !/^dpl_[0-9A-HJKMNP-TV-Z]{26}$/.test(deployId)) throw new Error('--rollback takes a deploy id (dpl_…), or nothing for the previous deploy');
    const r = await space.deploys.rollback(config.site, deployId ? { deploy_id: deployId } : {});
    log(r.changed ? `Rolled back: site ${config.site} serves deploy ${r.active_deploy_id} (was ${r.previous_deploy_id})` : `Site ${config.site} already serves deploy ${r.active_deploy_id}`);
    return r;
}

module.exports = { loadConfig, createSpace, collectFiles, deploy, rollback };

if (require.main === module) {
    (async () => {
        const config = loadConfig();
        const space = createSpace(config);
        const i = process.argv.indexOf('--rollback');
        if (i >= 0) await rollback(space, config, process.argv[i + 1]);
        else await deploy(space, config);
    })().catch((err) => {
        // Space answers problem+json with a stable code (quota.exceeded, site.not_found, upload.busy, …) and, for a
        // refused upload, the reasons in its log.
        console.error(err.code ? `${err.code}: ${err.message}` : err.message);
        process.exit(1);
    });
}
