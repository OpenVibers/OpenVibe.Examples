#!/usr/bin/env node
'use strict';
/**
 * npm run e2e: three examples against the REAL platform, as your sandbox app. Not part of npm test
 * and not run in CI: it needs your credentials and the network.
 *
 *   OV_CLIENT_ID=app_… OV_CLIENT_SECRET=… OV_PROJECT_ID=prj_… npm run e2e     # or put them in ./.env
 *
 * The app must be a CONFIDENTIAL app of that project with the sandbox grants media.object.upload,
 * media.object.read, events.app.publish, events.app.read, tools.job.create and tools.job.read
 * (scripts/new-sandbox-app.js or https://openvibe.codes create one). Optional: OV_NETWORK_URL,
 * OV_TOOLS_JOBS_URL.
 *
 *   1. media-uploader   upload a small text file into the project's Media tenant, read its
 *                       metadata back, delete it
 *   2. event-subscriber publish app.<project_key>.e2e.ran, then pull the project's topic from just
 *                       before it with a durable cursor and find it
 *   3. tool-job         convert a 1x1 PNG to WebP on img.openvibe.tools, following the job's events
 *
 * It refuses to start without the three variables, prints what each step did, and never prints a
 * secret: the client secret and anything shaped like a token are masked in all output, and signed
 * URLs are shown without their signature.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const REQUIRED = ['OV_CLIENT_ID', 'OV_CLIENT_SECRET', 'OV_PROJECT_ID'];
const STEP_TIMEOUT_MS = 180000;
// A 1x1 PNG, so the Tools step needs no file of yours.
const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

function refuse(message) {
    console.error(message);
    console.error('\nusage: OV_CLIENT_ID=app_… OV_CLIENT_SECRET=… OV_PROJECT_ID=prj_… npm run e2e');
    console.error('The app: a confidential sandbox app with media.object.upload, media.object.read, events.app.publish,');
    console.error('events.app.read, tools.job.create and tools.job.read (see the README walkthrough).');
    process.exit(2);
}

/** Mask the secret and anything token-shaped in everything this process writes. */
function maskOutput(secret) {
    const mask = (s) => String(s).split(secret).join('[secret]').replace(/eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]+/g, '[token]');
    for (const stream of [process.stdout, process.stderr]) {
        const write = stream.write.bind(stream);
        stream.write = (chunk, ...rest) => write(typeof chunk === 'string' || Buffer.isBuffer(chunk) ? mask(chunk.toString()) : chunk, ...rest);
    }
}

const withoutQuery = (u) => { try { const x = new URL(u); return `${x.origin}${x.pathname}${x.search ? ' (signed)' : ''}`; } catch { return u; } };
const describeError = (err) => (err && err.code && err.status !== undefined
    ? `${err.code}${err.status ? ` (${err.status})` : ''}${err.detail ? `: ${err.detail}` : ''}${err.requestId ? ` request=${err.requestId}` : ''}`
    : String((err && err.message) || err));

function timeout(promise, what) {
    let timer;
    return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} took longer than ${STEP_TIMEOUT_MS / 1000} s`)), STEP_TIMEOUT_MS); })])
        .finally(() => clearTimeout(timer));
}

async function main() {
    const missing = REQUIRED.filter((k) => !process.env[k]);
    if (missing.length) refuse(`e2e: missing ${missing.join(', ')}. Nothing was sent.`);
    const env = process.env;
    if (!/^app_[0-9A-HJKMNP-TV-Z]{26}$/.test(env.OV_CLIENT_ID)) refuse('e2e: OV_CLIENT_ID is not an app id (app_<ULID>). Nothing was sent.');
    if (!/^prj_[0-9A-HJKMNP-TV-Z]{26}$/.test(env.OV_PROJECT_ID)) refuse('e2e: OV_PROJECT_ID is not a project id (prj_<ULID>). Nothing was sent.');
    maskOutput(env.OV_CLIENT_SECRET);

    const { createUploader, explain } = require(path.join(ROOT, 'examples/media-uploader/upload'));
    const { projectKey } = require('openvibe-sdk/events');
    const { createSubscriber, createCursorStore, loadConfig: subscriberConfig } = require(path.join(ROOT, 'examples/event-subscriber/subscriber'));
    const { publishAppEvent, loadConfig: publishConfig } = require(path.join(ROOT, 'examples/event-subscriber/publish'));
    const { createJobRunner, loadConfig: jobConfig } = require(path.join(ROOT, 'examples/tool-job/run-job'));
    const { loadConfig: mediaConfig } = require(path.join(ROOT, 'examples/media-uploader/upload'));

    const base = { OV_CLIENT_ID: env.OV_CLIENT_ID, OV_CLIENT_SECRET: env.OV_CLIENT_SECRET, OV_PROJECT_ID: env.OV_PROJECT_ID, ...(env.OV_NETWORK_URL ? { OV_NETWORK_URL: env.OV_NETWORK_URL } : {}) };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-examples-e2e-'));
    const log = { log: (m) => console.log(`    ${m}`), error: (m) => console.log(`    ${m}`) };
    console.log(`OpenVibe.Examples e2e against ${env.OV_NETWORK_URL || 'https://openvibe.network'}`);
    console.log(`app ${env.OV_CLIENT_ID}, project ${env.OV_PROJECT_ID}\n`);

    const results = [];
    async function step(name, fn) {
        console.log(`[${results.length + 1}/3] ${name}`);
        try {
            await timeout(fn(), name);
            results.push({ name, ok: true });
            console.log('    ok\n');
        } catch (err) {
            results.push({ name, ok: false });
            console.log(`    FAILED: ${describeError(err)}\n`);
        }
    }

    await step('media-uploader: upload, read back, delete', async () => {
        const file = path.join(dir, 'openvibe-examples-e2e.txt');
        fs.writeFileSync(file, `OpenVibe.Examples e2e ${new Date().toISOString()}\n`);
        const uploader = createUploader(mediaConfig(base));
        let out;
        try { out = await uploader.upload(file); } catch (err) { throw Object.assign(err, { detail: explain(err) }); }
        console.log(`    uploaded ${out.key} (${out.size} bytes, ${out.mime}) into project ${out.project_id}${out.deduplicated ? ', deduplicated' : ''}`);
        console.log(`    sandbox=${out.sandbox} url=${withoutQuery(out.url)}${out.url_expires_at ? ` expires ${out.url_expires_at}` : ''}`);
        const meta = await uploader.get(out.key);
        if (!meta || meta.sha256 !== out.sha256) throw new Error('media.object.read did not return the file just uploaded');
        console.log(`    read back with media.object.read: sha256 ${meta.sha256.slice(0, 16)}…`);
        console.log(`    deleted: ${await uploader.remove(out.key)}`);
    });

    await step('event-subscriber: publish to the own topic, then pull it', async () => {
        const pub = await publishAppEvent(publishConfig(base), { name: 'e2e.ran', subject: { type: 'check', id: 'e2e' }, payload: { at: new Date().toISOString() } });
        console.log(`    published ${pub.event_type} ${pub.event_id} -> seq ${pub.seq}${pub.duplicate ? ' (duplicate)' : ''}`);
        const cursorPath = path.join(dir, 'cursor.json');
        createCursorStore(cursorPath).set('pull', Math.max(0, pub.seq - 1));
        const seen = [];
        const s = createSubscriber(subscriberConfig({ ...base, OV_EVENTS_MODE: 'pull', OV_CURSOR_PATH: cursorPath }), {
            log, onEvent: (event, { seq }) => { seen.push({ seq, id: event.event_id, type: event.event_type }); },
        });
        const topics = await s.resolveTopics();
        if (topics[0] !== `app.${projectKey(env.OV_PROJECT_ID)}.*`) throw new Error(`unexpected topic ${topics[0]}`);
        const n = await s.pullOnce();
        console.log(`    pulled ${topics.join(', ')} from seq ${pub.seq - 1}: ${n} event(s), cursor now ${createCursorStore(cursorPath).get('pull')}`);
        const mine = seen.find((e) => e.id === pub.event_id);
        if (!mine) throw new Error(`the published event ${pub.event_id} was not in the pull`);
        console.log(`    found ${mine.id} at seq ${mine.seq}`);
    });

    await step('tool-job: img.process convert to WebP', async () => {
        const file = path.join(dir, 'pixel.png');
        fs.writeFileSync(file, PNG_1X1);
        const runner = createJobRunner(jobConfig({
            ...base, OV_JOB_STATE: path.join(dir, 'job-state.json'), OV_OUT_DIR: path.join(dir, 'out'),
            ...(env.OV_TOOLS_JOBS_URL ? { OV_TOOLS_JOBS_URL: env.OV_TOOLS_JOBS_URL } : {}),
        }), { log });
        const { job, files } = await runner.run(file, {
            onEvent: ({ id, event, job: j }) => {
                const pct = j && j.progress && j.progress.percent != null ? ` ${j.progress.percent}%` : '';
                console.log(`    #${id} ${event}${pct}${j && j.progress && j.progress.message ? ` ${j.progress.message}` : ''}`);
            },
        });
        if (!job || job.state !== 'succeeded') throw new Error(job ? `job ${job.id} ${job.state}${job.error ? `: ${job.error.code}` : ''}` : 'the job is gone');
        for (const f of files) console.log(`    result ${path.basename(f)} (${fs.statSync(f).size} bytes)`);
        if (!files.length) throw new Error('the job succeeded but returned no file');
    });

    fs.rmSync(dir, { recursive: true, force: true });
    const ok = results.filter((r) => r.ok).length;
    console.log(`${ok}/${results.length} steps ok`);
    return ok === results.length ? 0 : 1;
}

main().then((code) => { process.exitCode = code; }, (err) => { console.error(`e2e: ${describeError(err)}`); process.exitCode = 1; });
