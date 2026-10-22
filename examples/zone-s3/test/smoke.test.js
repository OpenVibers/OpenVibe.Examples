'use strict';
/**
 * Smoke test: zone.js through the real AWS SDK v3 against a local stand-in for Zone's S3 endpoint (path-style
 * /<zone>/<key>, region us-east-1, Signature Version 4, aws-chunked bodies as OpenVibe.Media's server/s3/routes.js
 * reads them). It checks what the SDK sends (the signing region and service, path-style addressing, the access key
 * id, never the secret) and what comes back. The stand-in listens on 127.0.0.1 only; nothing reaches the network.
 */
const assert = require('node:assert/strict');
const http = require('node:http');
const { loadConfig, createS3, put, get, list, share, remove, roundTrip } = require('../zone');

const ACCESS = 'ovk_TESTKEYNOTREAL';
const SECRET = 'test-secret-not-real-0123456789';
const objects = new Map();   // "<zone>/<key>" → { body, type }
const seen = [];

/** aws-chunked (STREAMING-UNSIGNED-PAYLOAD-TRAILER or signed chunks): <hex size>[;…]\r\n<data>\r\n … 0\r\n<trailers>\r\n\r\n */
function dechunk(buf) {
    const out = [];
    let i = 0;
    for (;;) {
        const eol = buf.indexOf('\r\n', i);
        const size = parseInt(buf.subarray(i, eol).toString().split(';')[0], 16);
        if (!size) break;
        out.push(buf.subarray(eol + 2, eol + 2 + size));
        i = eol + 2 + size + 2;
    }
    return Buffer.concat(out);
}

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let body = Buffer.concat(chunks);
    const u = new URL(req.url, 'http://x');
    const auth = String(req.headers.authorization || '');
    const presigned = u.searchParams.get('X-Amz-Algorithm') === 'AWS4-HMAC-SHA256';
    const cred = presigned ? u.searchParams.get('X-Amz-Credential') : (/Credential=([^,]+)/.exec(auth) || [])[1];
    seen.push({ method: req.method, path: u.pathname, cred, presigned, auth, sha: req.headers['x-amz-content-sha256'], query: u.search });
    // Signed by the access key, for us-east-1 and s3, as Zone checks; the secret never travels.
    if (!cred || !/^ovk_TESTKEYNOTREAL\/\d{8}\/us-east-1\/s3\/aws4_request$/.test(cred)) { res.writeHead(403); return res.end('<Error><Code>AccessDenied</Code></Error>'); }
    if (JSON.stringify(req.headers).includes(SECRET) || req.url.includes(SECRET)) { res.writeHead(400); return res.end('secret on the wire'); }
    const [, zone, ...rest] = decodeURIComponent(u.pathname).split('/');
    const key = rest.join('/');
    if (req.method === 'PUT' && key) {
        if (/STREAMING/.test(String(req.headers['x-amz-content-sha256'] || '')) || /aws-chunked/.test(String(req.headers['content-encoding'] || ''))) body = dechunk(body);
        objects.set(`${zone}/${key}`, { body, type: req.headers['content-type'] || 'application/octet-stream' });
        res.writeHead(200, { ETag: '"etag-1"' });
        return res.end();
    }
    if (req.method === 'GET' && key) {
        const o = objects.get(`${zone}/${key}`);
        if (!o) { res.writeHead(404, { 'Content-Type': 'application/xml' }); return res.end('<Error><Code>NoSuchKey</Code></Error>'); }
        res.writeHead(200, { 'Content-Type': o.type, 'Content-Length': o.body.length, ETag: '"etag-1"' });
        return res.end(o.body);
    }
    if (req.method === 'DELETE' && key) { objects.delete(`${zone}/${key}`); res.writeHead(204); return res.end(); }
    if (req.method === 'GET' && !key && u.searchParams.get('list-type') === '2') {
        const prefix = u.searchParams.get('prefix') || '';
        const all = [...objects.keys()].filter((k) => k.startsWith(`${zone}/${prefix}`)).map((k) => k.slice(zone.length + 1)).sort();
        // Two to a page here, so the SDK's paginator follows continuation tokens.
        const start = Number(u.searchParams.get('continuation-token') || 0);
        const page = all.slice(start, start + 2);
        const more = start + 2 < all.length;
        res.writeHead(200, { 'Content-Type': 'application/xml' });
        return res.end(`<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${xml(zone)}</Name><Prefix>${xml(prefix)}</Prefix><KeyCount>${page.length}</KeyCount><MaxKeys>2</MaxKeys><IsTruncated>${more}</IsTruncated>${more ? `<NextContinuationToken>${start + 2}</NextContinuationToken>` : ''}${page.map((k) => `<Contents><Key>${xml(k)}</Key><Size>${objects.get(`${zone}/${k}`).body.length}</Size><LastModified>2026-10-22T00:00:00.000Z</LastModified><ETag>"etag-1"</ETag></Contents>`).join('')}</ListBucketResult>`);
    }
    res.writeHead(400); res.end();
});

(async () => {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const endpoint = `http://127.0.0.1:${server.address().port}`;
    try {
        assert.throws(() => loadConfig({}), /missing environment variables: OV_S3_ACCESS_KEY_ID, OV_S3_SECRET_ACCESS_KEY, OV_ZONE/);
        assert.throws(() => loadConfig({ OV_S3_ACCESS_KEY_ID: ACCESS, OV_S3_SECRET_ACCESS_KEY: SECRET, OV_ZONE: 'My_Bucket' }), /zone name/);
        assert.throws(() => loadConfig({ OV_S3_ACCESS_KEY_ID: ACCESS, OV_S3_SECRET_ACCESS_KEY: SECRET, OV_ZONE: 'a--b' }), /zone name/);
        assert.equal(loadConfig({ OV_S3_ACCESS_KEY_ID: ACCESS, OV_S3_SECRET_ACCESS_KEY: SECRET, OV_ZONE: 'assets' }).endpoint, 'https://s3.openvibe.media');
        const config = loadConfig({ OV_S3_ACCESS_KEY_ID: ACCESS, OV_S3_SECRET_ACCESS_KEY: SECRET, OV_ZONE: 'assets', OV_S3_ENDPOINT: endpoint });
        const s3 = createS3(config);

        // Put and get: path-style, signed for us-east-1 by the access key; the bytes and type come back.
        await put(s3, 'assets', 'notes/a.txt', 'first');
        await put(s3, 'assets', 'notes/b.json', Buffer.from('{"b":2}'));
        await put(s3, 'assets', 'notes/c.txt', 'third');
        const putReq = seen.find((x) => x.method === 'PUT');
        assert.equal(putReq.path, '/assets/notes/a.txt', 'path-style /<zone>/<key>');
        assert.match(putReq.auth, /^AWS4-HMAC-SHA256 Credential=ovk_TESTKEYNOTREAL\/\d{8}\/us-east-1\/s3\/aws4_request, SignedHeaders=[^,]+, Signature=[0-9a-f]{64}$/);
        const a = await get(s3, 'assets', 'notes/a.txt');
        assert.deepEqual([a.bytes.toString(), a.contentType], ['first', 'text/plain; charset=utf-8']);
        assert.equal((await get(s3, 'assets', 'notes/b.json')).contentType, 'application/json');

        // List follows pages (two to a page here).
        assert.deepEqual((await list(s3, 'assets', 'notes/')).map((o) => o.key), ['notes/a.txt', 'notes/b.json', 'notes/c.txt']);
        assert.ok(seen.filter((x) => x.query.includes('list-type=2')).length >= 2, 'the paginator asked for a second page');

        // A share link: presigned GET, at most 7 days, opens without credentials.
        await assert.rejects(share(s3, 'assets', 'notes/a.txt', 8 * 24 * 3600), /1 s to 7 days/);
        const url = await share(s3, 'assets', 'notes/a.txt', 600);
        const link = new URL(url);
        assert.equal(link.pathname, '/assets/notes/a.txt');
        assert.equal(link.searchParams.get('X-Amz-Expires'), '600');
        assert.ok(!url.includes(SECRET), 'the secret is never in a link');
        assert.equal(await (await fetch(url)).text(), 'first');

        // Delete, then a missing key is the SDK's NoSuchKey.
        await remove(s3, 'assets', 'notes/a.txt');
        await assert.rejects(get(s3, 'assets', 'notes/a.txt'), (err) => err.name === 'NoSuchKey');

        // The CLI's round trip.
        const lines = [];
        const r = await roundTrip(s3, 'assets', { log: (l) => lines.push(l) });
        assert.equal(r.same, true);
        assert.ok(!objects.has(`assets/${r.key}`), 'the round trip cleans up');
        assert.deepEqual(lines.map((l) => l.split(/\s+/)[0]), ['put', 'list', 'share', 'get', 'delete']);
        assert.ok(lines.every((l) => !l.includes(SECRET)));

        // A key from somewhere else is refused (the stand-in checks the credential scope like Zone).
        const other = createS3({ ...config, accessKeyId: 'ovk_OTHER' });
        await assert.rejects(get(other, 'assets', 'notes/b.json'), (err) => err.$metadata && err.$metadata.httpStatusCode === 403);

        console.log('zone-s3 smoke: put, get, paged list, share link, delete and the round trip through the AWS SDK v3; SigV4 for us-east-1, path-style');
    } finally {
        server.close();
    }
})().catch((err) => { console.error(err); process.exit(1); });
