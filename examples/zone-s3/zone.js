'use strict';
/**
 * OpenVibe.Zone over S3 with the official AWS SDK v3: private buckets ("zones") of an OpenVibe project, reached by any
 * S3 tool. A zone's objects are OpenVibe.Media objects, so the same files are readable through Media's API too.
 *
 * Zone's S3 endpoint is path-style, region us-east-1, Signature Version 4 (https://openvibe.zone/docs#s3). An access
 * key belongs to one project environment and may be limited to some zones and to read or write; its secret is shown
 * once, when it is issued in the Zone console. This file shows the everyday calls: put, get, list, a presigned link
 * to share, and delete.
 *
 *   node --env-file=.env zone.js                     # the round trip: put, list, share, get, delete
 *   node --env-file=.env zone.js put ./report.pdf reports/2026-10.pdf
 *   node --env-file=.env zone.js ls reports/
 *   node --env-file=.env zone.js share reports/2026-10.pdf 86400
 *
 * Larger files: one request carries at most 256 MB; @aws-sdk/lib-storage's Upload (or `aws s3 cp`, rclone) sends
 * bigger ones in parts, which Zone accepts with S3's rules.
 */
const fs = require('node:fs');
const path = require('node:path');
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, paginateListObjectsV2 } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const MAX_SHARE_SECONDS = 7 * 24 * 3600;   // Zone's limit for a presigned URL, as S3's

function loadConfig(env = process.env) {
    const missing = ['OV_S3_ACCESS_KEY_ID', 'OV_S3_SECRET_ACCESS_KEY', 'OV_ZONE'].filter((k) => !env[k]);
    if (missing.length) throw new Error(`missing environment variables: ${missing.join(', ')}`);
    // Zone's own rule for names: 3 to 63 lowercase letters and digits, single hyphens between them.
    if (!/^(?=.{3,63}$)[a-z0-9]+(-[a-z0-9]+)*$/.test(env.OV_ZONE)) throw new Error('OV_ZONE is a zone name (3 to 63 lowercase letters, digits and single hyphens)');
    return {
        endpoint: String(env.OV_S3_ENDPOINT || 'https://s3.openvibe.media').replace(/\/+$/, ''),
        zone: env.OV_ZONE,
        accessKeyId: env.OV_S3_ACCESS_KEY_ID,
        secretAccessKey: env.OV_S3_SECRET_ACCESS_KEY,
    };
}

/** An S3 client for Zone: its endpoint, path-style addressing, us-east-1. The SDK's own defaults do the rest. */
function createS3(config) {
    return new S3Client({
        endpoint: config.endpoint, region: 'us-east-1', forcePathStyle: true,
        credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    });
}

const TYPES = { '.txt': 'text/plain; charset=utf-8', '.json': 'application/json', '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.pdf': 'application/pdf', '.mp4': 'video/mp4' };
const typeOf = (key) => TYPES[path.extname(key).toLowerCase()] || 'application/octet-stream';

async function put(s3, zone, key, body, contentType = typeOf(key)) {
    const out = await s3.send(new PutObjectCommand({ Bucket: zone, Key: key, Body: body, ContentType: contentType }));
    return { key, etag: out.ETag };
}

async function get(s3, zone, key) {
    const out = await s3.send(new GetObjectCommand({ Bucket: zone, Key: key }));
    return { bytes: Buffer.from(await out.Body.transformToByteArray()), contentType: out.ContentType };
}

/** Every key under a prefix, page after page (Zone pages like S3: 1000 a page). */
async function list(s3, zone, prefix = '') {
    const keys = [];
    for await (const page of paginateListObjectsV2({ client: s3 }, { Bucket: zone, Prefix: prefix })) {
        for (const o of page.Contents || []) keys.push({ key: o.Key, size: o.Size, modified: o.LastModified });
    }
    return keys;
}

/** A link anyone can open until it expires (at most 7 days), or until the key that signed it is revoked. */
async function share(s3, zone, key, seconds = 3600) {
    if (!(seconds > 0 && seconds <= MAX_SHARE_SECONDS)) throw new Error(`a share link lasts 1 s to 7 days (${MAX_SHARE_SECONDS} s)`);
    return await getSignedUrl(s3, new GetObjectCommand({ Bucket: zone, Key: key }), { expiresIn: seconds });
}

async function remove(s3, zone, key) {
    await s3.send(new DeleteObjectCommand({ Bucket: zone, Key: key }));
}

/** The round trip the CLI runs with no arguments. */
async function roundTrip(s3, zone, { log = console.log, fetchImpl = globalThis.fetch } = {}) {
    const key = `openvibe-example/hello-${Date.now()}.txt`;
    const text = `Hello from the zone-s3 example, ${new Date().toISOString()}\n`;
    await put(s3, zone, key, text);
    log(`put    s3://${zone}/${key}`);
    const listed = await list(s3, zone, 'openvibe-example/');
    log(`list   ${listed.length} object(s) under openvibe-example/`);
    const url = await share(s3, zone, key, 600);
    const viaLink = await (await fetchImpl(url)).text();
    log(`share  a 10-minute link reads ${viaLink === text ? 'the same bytes' : 'something else'}`);
    const back = (await get(s3, zone, key)).bytes.toString('utf8');
    log(`get    ${back === text ? 'the same bytes' : 'something else'} (${Buffer.byteLength(back)} bytes)`);
    await remove(s3, zone, key);
    log(`delete s3://${zone}/${key}`);
    return { key, same: back === text && viaLink === text, listed: listed.length };
}

module.exports = { loadConfig, createS3, put, get, list, share, remove, roundTrip, MAX_SHARE_SECONDS };

if (require.main === module) {
    (async () => {
        const config = loadConfig();
        const s3 = createS3(config);
        const [cmd, a, b] = process.argv.slice(2);
        if (!cmd) { const r = await roundTrip(s3, config.zone); process.exit(r.same ? 0 : 1); }
        if (cmd === 'put') console.log((await put(s3, config.zone, b || path.basename(a), fs.readFileSync(a))).etag);
        else if (cmd === 'get') process.stdout.write((await get(s3, config.zone, a)).bytes);
        else if (cmd === 'ls') for (const o of await list(s3, config.zone, a || '')) console.log(`${String(o.size).padStart(12)}  ${o.key}`);
        else if (cmd === 'share') console.log(await share(s3, config.zone, a, b ? Number(b) : 3600));
        else if (cmd === 'rm') await remove(s3, config.zone, a);
        else throw new Error('usage: zone.js [put <file> [key] | get <key> | ls [prefix] | share <key> [seconds] | rm <key>]');
    })().catch((err) => { console.error(err.name && err.$metadata ? `${err.name}: ${err.message}` : err.message); process.exit(1); });
}
