'use strict';
/**
 * A small local stand-in for OpenVibe.Tools' job API (/api/v1/jobs), for tests only. The SDK's
 * createMockPlatform() has no Tools, so this mock plays the documented behaviour:
 *
 *   POST   /api/v1/jobs              multipart type/input/file, Idempotency-Key -> 202 (200 + Idempotent-Replayed on repeat)
 *   GET    /api/v1/jobs/:id          the job view
 *   GET    /api/v1/jobs/:id/events   SSE with ids; Last-Event-ID replays only later events; 204 when finished and nothing newer
 *   GET    /api/v1/jobs/:id/files/:n a result file
 *
 * Tokens are verified against the mock platform's key: RS256, audience openvibe.tools, the
 * tools.job.* capability for the action. Jobs are owner-scoped (the token's sub).
 */
const crypto = require('node:crypto');
const http = require('node:http');

const ULID = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const newJobId = () => `job_${Array.from(crypto.randomBytes(26), (b) => ULID[b & 31]).join('')}`;
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
const CAPS = { create: 'tools.job.create', read: 'tools.job.read' };

function createMockToolsServer({ publicKey, stepMs = 25, dropStreamsAfter = 0 } = {}) {
    const jobs = new Map();
    const idem = new Map();
    const listeners = new Map();
    const stats = { submits: 0, streams: [], replays: 0 };
    let drops = dropStreamsAfter;

    function verify(req, action) {
        const auth = String(req.headers.authorization || '');
        const parts = auth.startsWith('Bearer ') ? auth.slice(7).split('.') : [];
        if (parts.length !== 3) return { error: [401, 'token.missing'] };
        let header, claims;
        try {
            header = JSON.parse(Buffer.from(parts[0], 'base64url'));
            claims = JSON.parse(Buffer.from(parts[1], 'base64url'));
        } catch { return { error: [401, 'token.malformed'] }; }
        if (header.alg !== 'RS256' || !crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), publicKey, Buffer.from(parts[2], 'base64url'))) return { error: [401, 'token.bad_signature'] };
        if (!claims.exp || claims.exp * 1000 < Date.now()) return { error: [401, 'token.expired'] };
        if (!(claims.aud || []).includes('openvibe.tools')) return { error: [401, 'token.wrong_audience'] };
        if (!(claims.cap || []).includes(CAPS[action])) return { error: [403, 'capability.denied'] };
        return { owner: claims.sub };
    }

    function view(job) {
        return {
            id: job.id, object: 'tools.job', service: 'img', type: job.type, type_version: 1, state: job.state,
            progress: { percent: job.percent, message: job.message }, attempts: job.state === 'queued' ? 0 : 1, max_attempts: 2,
            result: job.result ? { files: job.result.files.map((f, i) => ({ name: f.name, mime: f.mime, size: f.bytes.length, url: `/api/v1/jobs/${job.id}/files/${i}` })), data: job.result.data } : null,
            error: null, retryable: false,
            links: { self: `/api/v1/jobs/${job.id}`, events: `/api/v1/jobs/${job.id}/events`, cancel: TERMINAL.has(job.state) ? null : `/api/v1/jobs/${job.id}` },
        };
    }

    function emit(job, event) {
        const e = { seq: job.events.length + 1, event, data: view(job) };
        job.events.push(e);
        for (const fn of listeners.get(job.id) || []) fn(e);
    }

    function lifecycle(job) {
        const steps = [
            () => { job.state = 'running'; emit(job, 'job.running'); },
            () => { job.percent = 50; job.message = 'converting'; emit(job, 'job.progress'); },
            () => {
                job.state = 'succeeded'; job.percent = 100; job.message = null;
                job.result = { files: [{ name: job.fileName.replace(/\.[^.]+$/, '') + '.' + (job.input.format || 'out'), mime: `image/${job.input.format || 'png'}`, bytes: Buffer.concat([Buffer.from('converted:'), job.bytes]) }], data: { tool: job.input.tool } };
                emit(job, 'job.succeeded');
            },
        ];
        const next = () => { const s = steps.shift(); if (s) { s(); setTimeout(next, stepMs); } };
        setTimeout(next, stepMs);
    }

    const problem = (res, status, code, detail) => {
        res.writeHead(status, { 'Content-Type': 'application/problem+json' });
        res.end(JSON.stringify({ type: `https://openvibe.network/problems/${code}`, title: String(status), status, code, detail: detail || code }));
    };

    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://tools.invalid');
        let m;
        if (req.method === 'POST' && url.pathname === '/api/v1/jobs') {
            const who = verify(req, 'create');
            if (who.error) return problem(res, ...who.error);
            const chunks = [];
            for await (const c of req) chunks.push(c);
            const raw = Buffer.concat(chunks);
            const form = await new Request('http://tools.invalid/', { method: 'POST', headers: { 'content-type': req.headers['content-type'] }, body: raw }).formData();
            const key = String(req.headers['idempotency-key'] || '');
            if (key.length < 8 || key.length > 200) return problem(res, 400, 'tools.job.invalid', 'Idempotency-Key must be 8-200 characters');
            // Like Tools: the request is identified by type, input and the files' hashes (not the multipart bytes).
            const fileHashes = [];
            for (const f of form.getAll('file')) if (typeof f !== 'string') fileHashes.push(crypto.createHash('sha256').update(Buffer.from(await f.arrayBuffer())).digest('hex'));
            const hash = crypto.createHash('sha256').update(JSON.stringify([String(form.get('type')), String(form.get('input') || '{}'), fileHashes])).digest('hex');
            const prior = idem.get(`${who.owner}|${key}`);
            if (prior) {
                if (prior.hash !== hash) return problem(res, 409, 'tools.job.idempotency_conflict', 'This Idempotency-Key was used for a different request');
                stats.replays++;
                res.writeHead(200, { 'Content-Type': 'application/json', Location: `/api/v1/jobs/${prior.id}`, 'Idempotent-Replayed': 'true' });
                return res.end(JSON.stringify(view(jobs.get(prior.id))));
            }
            const file = form.get('file');
            if (!file || typeof file === 'string') return problem(res, 400, 'tools.job.invalid', 'one file is required');
            stats.submits++;
            const job = {
                id: newJobId(), owner: who.owner, type: String(form.get('type')), input: JSON.parse(String(form.get('input') || '{}')),
                state: 'queued', percent: null, message: null, events: [], result: null,
                fileName: file.name, bytes: Buffer.from(await file.arrayBuffer()),
            };
            jobs.set(job.id, job);
            idem.set(`${who.owner}|${key}`, { id: job.id, hash });
            emit(job, 'job.queued');
            lifecycle(job);
            res.writeHead(202, { 'Content-Type': 'application/json', Location: `/api/v1/jobs/${job.id}` });
            return res.end(JSON.stringify(view(job)));
        }
        if ((m = url.pathname.match(/^\/api\/v1\/jobs\/([^/]+)(\/events|\/files\/(\d+))?$/)) && req.method === 'GET') {
            const who = verify(req, 'read');
            if (who.error) return problem(res, ...who.error);
            const job = jobs.get(m[1]);
            if (!job || job.owner !== who.owner) return problem(res, 404, 'tools.job.not_found', 'No such job');
            if (!m[2]) {
                res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
                return res.end(JSON.stringify(view(job)));
            }
            if (m[3] !== undefined) {
                if (job.state !== 'succeeded') return problem(res, 409, 'tools.job.not_ready', `The job is ${job.state}`);
                const f = job.result.files[Number(m[3])];
                if (!f) return problem(res, 404, 'tools.job.file_not_found', 'No such result file');
                res.writeHead(200, { 'Content-Type': f.mime, 'Content-Disposition': `attachment; filename="${f.name}"` });
                return res.end(f.bytes);
            }
            const after = Math.max(0, parseInt(req.headers['last-event-id'] || url.searchParams.get('last_event_id') || '0', 10) || 0);
            stats.streams.push(after);
            const pending = job.events.filter((e) => e.seq > after);
            if (TERMINAL.has(job.state) && !pending.length) { res.writeHead(204); return res.end(); }
            res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store' });
            res.write(`retry: ${stepMs}\n\n`);
            let last = after;
            let written = 0;
            const set = listeners.get(job.id) || new Set();
            listeners.set(job.id, set);
            const close = () => { set.delete(write); res.end(); };
            const write = (e) => {
                if (e.seq <= last || res.writableEnded) return;
                last = e.seq;
                res.write(`id: ${e.seq}\nevent: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`);
                written++;
                if (TERMINAL.has(e.data.state) && e.event !== 'job.progress') return setImmediate(close);
                if (drops > 0 && written >= 1) { drops--; setImmediate(close); }     // simulate a dropped connection
            };
            set.add(write);
            for (const e of job.events) write(e);
            req.on('close', () => set.delete(write));
            return undefined;
        }
        return problem(res, 404, 'not_found', 'Not found');
    });

    return {
        server,
        stats,
        jobs,
        async listen() {
            await new Promise((r) => server.listen(0, '127.0.0.1', r));
            return `http://127.0.0.1:${server.address().port}`;
        },
        close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }),
    };
}

module.exports = { createMockToolsServer };
