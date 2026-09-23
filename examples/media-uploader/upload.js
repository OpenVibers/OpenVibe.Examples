#!/usr/bin/env node
'use strict';
/**
 * Media uploader: upload a file to OpenVibe.Media as a developer app.
 *
 *   node --env-file=.env upload.js ./logo.png
 *
 * 1. Ask OpenVibe.Network for an app token (client credentials, audience openvibe.media, scope
 *    media.object.upload).
 * 2. Find Media's origin in the platform descriptor (registry discovery), never a hard-coded host.
 * 3. Upload to the Media namespace your grant names. For a developer app that is your project id
 *    (prj_…), because Network puts the project id in the token's `ns` claim.
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
    const missing = ['OV_CLIENT_ID', 'OV_CLIENT_SECRET', 'OV_MEDIA_NAMESPACE'].filter((k) => !env[k]);
    if (missing.length) {
        const err = new Error(`missing environment variables: ${missing.join(', ')} (see .env.example)`);
        err.code = 'config.missing';
        throw err;
    }
    return {
        network: env.OV_NETWORK_URL || 'https://openvibe.network',
        clientId: env.OV_CLIENT_ID,
        clientSecret: env.OV_CLIENT_SECRET,
        namespace: env.OV_MEDIA_NAMESPACE,
        mediaUrl: env.OV_MEDIA_URL || null,
    };
}

function createUploader(config, { fetch } = {}) {
    const tokens = createServiceTokenClient({
        network: config.network,
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        scope: { 'openvibe.media': 'media.object.upload' },   // ask for exactly what this program uses
        fetch,
    });
    const client = createClient({
        network: config.network,
        fetch,
        tokenProvider: tokens,
        baseUrls: config.mediaUrl ? { media: config.mediaUrl } : undefined,
    });

    return {
        client,
        /** Upload one file -> { key, url, public_url, size, mime, sha256, deduplicated? } */
        async upload(filePath) {
            const discovery = await client.discover();           // origins + contracts version check
            const media = createMediaClient(client, { app: config.namespace, publicOrigin: await client.origin('media') });
            const bytes = await fs.promises.readFile(filePath);
            const filename = path.basename(filePath);
            const contentType = TYPES[path.extname(filename).toLowerCase()] || 'application/octet-stream';
            const file = await media.upload(bytes, { filename, contentType });
            return { ...file, contracts: discovery.contractsVersion };
        },
    };
}

/** A human hint for the errors a new developer is most likely to meet. */
function explain(err) {
    const code = isOpenVibeError(err) ? err.code : err && err.code;
    switch (code) {
        case 'config.missing': return err.message;
        case 'invalid_client': return 'Network refused the client id or secret. Check OV_CLIENT_ID / OV_CLIENT_SECRET (rotate the secret in your project if it was lost).';
        case 'invalid_target': return 'Network does not issue tokens for openvibe.media to this app. Sandbox apps only get tokens for audiences that accept sandbox traffic; see the README.';
        case 'invalid_scope': return 'The app holds no approved media.object.upload grant. Request it on your app and have a project admin approve it.';
        case 'capability.namespace_denied': return 'Your token is not valid for this namespace. OV_MEDIA_NAMESPACE must be your project id (prj_...).';
        case 'token.sandbox_refused': return 'Media does not accept sandbox tokens yet. See the README section "Running against the real platform".';
        default: return isOpenVibeError(err) ? `${err.code}${err.detail ? `: ${err.detail}` : ''}${err.requestId ? ` (request ${err.requestId})` : ''}` : String(err && err.message);
    }
}

async function main(argv = process.argv.slice(2)) {
    const file = argv[0];
    if (!file) {
        console.error('usage: node upload.js <file>');
        return 2;
    }
    try {
        const uploader = createUploader(loadConfig());
        const out = await uploader.upload(file);
        console.log(JSON.stringify({ key: out.key, public_url: out.public_url, size: out.size, mime: out.mime, sha256: out.sha256, deduplicated: Boolean(out.deduplicated) }, null, 2));
        return 0;
    } catch (err) {
        console.error(`upload failed: ${explain(err)}`);
        return 1;
    }
}

if (require.main === module) main().then((code) => { process.exitCode = code; });

module.exports = { loadConfig, createUploader, explain, main };
