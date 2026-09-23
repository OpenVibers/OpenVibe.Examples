#!/usr/bin/env node
'use strict';
/**
 * Media uploader: upload a file to OpenVibe.Media as a developer app, read it back, delete it.
 *
 *   node --env-file=.env upload.js ./logo.png           # media.object.upload
 *   node --env-file=.env upload.js --get <key>          # media.object.read
 *   node --env-file=.env upload.js --delete <key>       # media.object.upload
 *
 * 1. Ask OpenVibe.Network for an app token (client credentials, audience openvibe.media) carrying
 *    exactly the capability the operation needs (`scope`).
 * 2. Find Media's origin in the platform descriptor (registry discovery), never a hard-coded host.
 * 3. Use the Media tenant of your project: the path names your project id (prj_…), the same id
 *    Network puts in the token's `project_id` and `ns` claims. Media keeps a sandbox app's files in
 *    a separate sandbox tenant of that project (you still address it by the project id) and never
 *    serves them publicly: a sandbox upload comes back with a signed, expiring `url` instead.
 *
 * Only openvibe-sdk and the public token endpoint are used. The client secret is read from the
 * environment and never printed.
 */
const fs = require('node:fs');
const path = require('node:path');
const { createClient, isOpenVibeError } = require('openvibe-sdk/core');
const { createServiceTokenClient } = require('openvibe-sdk/auth');
const { createMediaClient } = require('openvibe-sdk/media');

const TYPES = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
    '.svg': 'image/svg+xml', '.txt': 'text/plain', '.json': 'application/json', '.pdf': 'application/pdf',
    '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.webm': 'video/webm',
};

function loadConfig(env = process.env) {
    const missing = ['OV_CLIENT_ID', 'OV_CLIENT_SECRET'].filter((k) => !env[k]);
    if (missing.length) {
        const err = new Error(`missing environment variables: ${missing.join(', ')} (see .env.example)`);
        err.code = 'config.missing';
        throw err;
    }
    return {
        network: env.OV_NETWORK_URL || 'https://openvibe.network',
        clientId: env.OV_CLIENT_ID,
        clientSecret: env.OV_CLIENT_SECRET,
        projectId: env.OV_PROJECT_ID || null,
        mediaUrl: env.OV_MEDIA_URL || null,
    };
}

/** What a caller should see of a Media file: never more than this. */
function describe(file) {
    if (!file) return null;
    return {
        key: file.key,
        url: file.public_url || file.url || null,          // public URL, or a signed one for sandbox files
        url_expires_at: file.url_expires_at || null,
        sandbox: Boolean(file.sandbox),
        size: file.size, mime: file.mime, sha256: file.sha256,
        deduplicated: Boolean(file.deduplicated),
    };
}

function createUploader(config, { fetch } = {}) {
    const clients = new Map();
    /** One token client per capability, so each token carries only what that call needs. */
    function clientFor(capability) {
        if (!clients.has(capability)) {
            const tokens = createServiceTokenClient({
                network: config.network, clientId: config.clientId, clientSecret: config.clientSecret, fetch,
                scope: { 'openvibe.media': capability },
            });
            clients.set(capability, {
                tokens,
                client: createClient({ network: config.network, fetch, tokenProvider: tokens, baseUrls: config.mediaUrl ? { media: config.mediaUrl } : undefined }),
            });
        }
        return clients.get(capability);
    }

    /** The Media client for the project, for calls that need `capability`. */
    async function mediaFor(capability) {
        const { client, tokens } = clientFor(capability);
        const discovery = await client.discover();                  // origins + contracts version check
        const projectId = config.projectId || (await tokens.getTokenInfo({ audience: 'openvibe.media' })).unverifiedClaims.project_id;
        return { media: createMediaClient(client, { app: projectId, publicOrigin: await client.origin('media') }), projectId, discovery };
    }

    return {
        /** Upload one file -> { key, url, url_expires_at, sandbox, size, mime, sha256, deduplicated, project_id, contracts } */
        async upload(filePath) {
            const { media, projectId, discovery } = await mediaFor('media.object.upload');
            const bytes = await fs.promises.readFile(filePath);
            const filename = path.basename(filePath);
            const contentType = TYPES[path.extname(filename).toLowerCase()] || 'application/octet-stream';
            const file = await media.upload(bytes, { filename, contentType });
            return { ...describe(file), project_id: projectId, contracts: discovery.contractsVersion };
        },
        /** A file's metadata (media.object.read), or null when it does not exist in this project and environment. */
        async get(key) {
            const { media } = await mediaFor('media.object.read');
            return describe(await media.files.get(key));
        },
        /** Delete a file (media.object.upload): true, or false when there was no such file. */
        async remove(key) {
            const { media } = await mediaFor('media.object.upload');
            return media.files.delete(key);
        },
    };
}

/** A human hint for the errors a new developer is most likely to meet. */
function explain(err) {
    const code = isOpenVibeError(err) ? err.code : err && err.code;
    switch (code) {
        case 'config.missing': return err.message;
        case 'invalid_client': return 'Network refused the client id or secret. Check OV_CLIENT_ID / OV_CLIENT_SECRET (rotate the secret in your project if it was lost).';
        case 'invalid_target': return 'Network does not issue tokens for openvibe.media to this app (its environment is not enabled for that audience).';
        case 'invalid_scope': return 'The app holds no approved grant for this operation (media.object.upload to upload or delete, media.object.read to read). Request it on your app (openvibe.codes, or the projects API).';
        case 'capability.namespace_denied': return 'Your token is not valid for this project. OV_PROJECT_ID must be the project your app belongs to (or leave it empty).';
        case 'token.sandbox_refused': return 'Media refused a sandbox token on this route. Sandbox apps can use their own project tenant only (/api/v1/<project id>/files).';
        default: return isOpenVibeError(err) ? `${err.code}${err.detail ? `: ${err.detail}` : ''}${err.requestId ? ` (request ${err.requestId})` : ''}` : String(err && err.message);
    }
}

async function main(argv = process.argv.slice(2)) {
    const [first, key] = argv;
    if (!first || (['--get', '--delete'].includes(first) && !key)) {
        console.error('usage: node upload.js <file> | --get <key> | --delete <key>');
        return 2;
    }
    try {
        const uploader = createUploader(loadConfig());
        if (first === '--get') {
            const file = await uploader.get(key);
            if (!file) { console.error(`no file ${key} in this project (and environment)`); return 1; }
            console.log(JSON.stringify(file, null, 2));
        } else if (first === '--delete') {
            console.log((await uploader.remove(key)) ? `deleted ${key}` : `no file ${key}`);
        } else {
            const out = await uploader.upload(first);
            console.log(JSON.stringify(out, null, 2));
        }
        return 0;
    } catch (err) {
        console.error(`media failed: ${explain(err)}`);
        return 1;
    }
}

if (require.main === module) main().then((code) => { process.exitCode = code; });

module.exports = { loadConfig, createUploader, describe, explain, main };
