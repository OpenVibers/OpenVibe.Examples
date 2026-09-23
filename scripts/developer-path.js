#!/usr/bin/env node
'use strict';
/**
 * npm run developer-path: the roadmap Wave 20 exit check, repeatable. A developer goes from an
 * account to a working Media and Events integration with public endpoints, the SDK and scoped
 * credentials only, then rotates and revokes those credentials and archives the project:
 *
 *   1. account     register (--register) or sign in at <network>/api/auth/*, or OV_USER_TOKEN
 *   2. discovery   GET /.well-known/openvibe, as any origin may
 *   3. project     a new project (sandbox) through /api/v1/projects (openvibe-sdk/projects)
 *   4. app         a confidential sandbox app; its secret is held in memory only
 *   5. grants      media.object.upload|read and events.app.publish|read, approved at once for the
 *                  project owner inside the sandbox allowance
 *   6. media       examples/media-uploader: upload a small file, read it back, delete it
 *   7. events      examples/event-subscriber: publish app.<project_key>.developer_path.ran, pull it
 *   8. credentials rotate with no overlap, revoke the first credential; the old secret is refused
 *                  at /oauth/token and the new one works
 *   9. cleanup     archive the project (always attempted once it exists); the app's secret is
 *                  refused afterwards
 *
 * The same flow runs in CI against openvibe-sdk/testing's mock platform (scripts/developer-path-mock.js,
 * `npm run developer-path:mock`). Against the real platform it runs ONLY when a person starts it:
 *
 *   OV_E2E_USERNAME=… OV_E2E_PASSWORD=… npm run developer-path              # sign in
 *   OV_E2E_USERNAME=… OV_E2E_PASSWORD=… npm run developer-path -- --register  # create that account first
 *   OV_USER_TOKEN=… npm run developer-path                                    # an existing Network token
 *
 * Credentials come from the environment only (or ./.env). It refuses to start without them, and
 * refuses to run in CI against the production Network (CI set and OV_NETWORK_URL unset or
 * openvibe.network). Optional: OV_NETWORK_URL. It never prints a password, secret or token: they
 * are masked in all output, and signed URLs are shown without their signature. Exit 0 when every
 * step passed, 1 when one failed, 2 when it refused to start.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createClient, isOpenVibeError } = require('openvibe-sdk/core');
const { createProjectsClient } = require('openvibe-sdk/projects');
const { projectKey } = require('openvibe-sdk/events');

const ROOT = path.join(__dirname, '..');
const { createUploader, explain, loadConfig: mediaConfig } = require(path.join(ROOT, 'examples/media-uploader/upload'));
const { publishAppEvent, loadConfig: publishConfig } = require(path.join(ROOT, 'examples/event-subscriber/publish'));
const { createSubscriber, createCursorStore, loadConfig: subscriberConfig } = require(path.join(ROOT, 'examples/event-subscriber/subscriber'));

const PRODUCTION_NETWORK = 'https://openvibe.network';
const GRANTS = ['media.object.upload', 'media.object.read', 'events.app.publish', 'events.app.read'];
const STEPS = ['account', 'discovery', 'project', 'app', 'grants', 'media', 'events', 'credentials', 'cleanup'];
const STEP_TIMEOUT_MS = 120000;

const withoutQuery = (u) => { try { const x = new URL(u); return `${x.origin}${x.pathname}${x.search ? ' (signed)' : ''}`; } catch { return u; } };
const describeError = (err) => (isOpenVibeError(err) || (err && err.code && err.status !== undefined)
    ? `${err.code}${err.status ? ` (${err.status})` : ''}${err.detail ? `: ${err.detail}` : ''}${err.requestId ? ` request=${err.requestId}` : ''}`
    : String((err && err.message) || err));

function timeout(promise, what) {
    let timer;
    return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} took longer than ${STEP_TIMEOUT_MS / 1000} s`)), STEP_TIMEOUT_MS); })])
        .finally(() => clearTimeout(timer));
}

/** POST a JSON body to Network's public auth API → { status, body }. */
async function postJson(fetchImpl, url, body) {
    const res = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => ({})) };
}

/** POST /oauth/token client_credentials → { status, error } (the token itself is not kept). */
async function tryToken(fetchImpl, network, clientId, clientSecret, audience) {
    const res = await fetchImpl(`${network}/oauth/token`, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret, audience }),
    });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, ok: res.ok && typeof body.access_token === 'string', error: body.error || null };
}

/**
 * Runs the nine steps. account: { token } | { username, password, register }. onSecret(value) is
 * called with every password, secret and token as soon as it is known, so the caller can mask it.
 * → { ok, steps: [{ name, ok, skipped?, error? }], projectId, appId }
 */
async function runDeveloperPath({ network = PRODUCTION_NETWORK, fetch: fetchImpl = globalThis.fetch, account, log = (m) => console.log(m), onSecret = () => {}, now = () => new Date() }) {
    network = network.replace(/\/+$/, '');
    const say = (m) => log(`    ${m}`);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-developer-path-'));
    const st = { token: null, projects: null, projectId: null, appId: null, secret: null, credentialId: null, newSecret: null };
    const steps = [];
    let failed = false;

    async function step(name, fn, { always = false } = {}) {
        log(`[${steps.length + 1}/${STEPS.length}] ${name}`);
        if (failed && !always) { steps.push({ name, ok: false, skipped: true }); log('    skipped (an earlier step failed)\n'); return; }
        try {
            await timeout(fn(), name);
            steps.push({ name, ok: true });
            log('    ok\n');
        } catch (err) {
            failed = true;
            steps.push({ name, ok: false, error: describeError(err) });
            log(`    FAILED: ${describeError(err)}\n`);
        }
    }
    const creds = (secret = st.secret) => ({ OV_CLIENT_ID: st.appId, OV_CLIENT_SECRET: secret, OV_PROJECT_ID: st.projectId, OV_NETWORK_URL: network });

    await step('account', async () => {
        if (account.password) onSecret(account.password);
        if (account.token) {
            onSecret(account.token);
            st.token = account.token;
            say('using OV_USER_TOKEN');
            return;
        }
        if (account.register) {
            const r = await postJson(fetchImpl, `${network}/api/auth/register`, { username: account.username, password: account.password });
            if (r.status === 201 || r.status === 200) {
                st.token = r.body.token;
                say(`registered a new account ${account.username}`);
            } else if (r.status === 409) {
                say(`${account.username} already exists; signing in instead (this run does not prove account creation)`);
            } else {
                throw new Error(`registration refused (${r.status}): ${r.body.error || 'no detail'}`);
            }
        }
        if (!st.token) {
            const r = await postJson(fetchImpl, `${network}/api/auth/login`, { username: account.username, password: account.password });
            if (!r.body.token) throw new Error(`sign-in refused (${r.status}): ${r.body.error || 'no detail'}`);
            st.token = r.body.token;
            say(`signed in as ${account.username}`);
        }
        onSecret(st.token);
        st.projects = createProjectsClient(createClient({ network, fetch: fetchImpl, token: st.token }));
    });

    await step('discovery', async () => {
        const res = await fetchImpl(`${network}/.well-known/openvibe`, { headers: { Accept: 'application/json', Origin: 'https://example.dev' } });
        if (!res.ok) throw new Error(`/.well-known/openvibe answered ${res.status}`);
        const d = await res.json();
        if (!d.name || !d.token_endpoint) throw new Error('the discovery document has no name or token_endpoint');
        say(`${d.name}: token endpoint ${d.token_endpoint}${d.registry ? `, registry ${d.registry}` : ''}`);
    });

    await step('project', async () => {
        if (!st.projects) st.projects = createProjectsClient(createClient({ network, fetch: fetchImpl, token: st.token }));
        const p = await st.projects.create({ name: `Developer path check ${now().toISOString().slice(0, 16).replace('T', ' ')}` });
        const project = p.project || p;
        st.projectId = project.id;
        say(`project ${project.id} (${(project.environments || ['sandbox']).join(', ')}), role ${project.role || 'owner'}`);
    });

    await step('app', async () => {
        const created = await st.projects.apps.create(st.projectId, { name: 'developer-path', environment: 'sandbox', type: 'confidential', redirectUris: ['http://localhost:3009/callback'] });
        const app = created.app || created;
        const credential = created.credential || app.credential || {};
        st.appId = app.id;
        st.secret = credential.client_secret || created.client_secret;
        if (!st.secret) throw new Error('Network returned no client secret for a confidential app');
        onSecret(st.secret);
        st.credentialId = credential.id;
        say(`app ${st.appId} (sandbox, confidential), credential ${credential.id || '?'} ending …${credential.hint || '?'}; secret received once, kept in memory only`);
    });

    await step('grants', async () => {
        const statuses = {};
        for (const capability of GRANTS) {
            const g = await st.projects.grants.request(st.projectId, st.appId, capability);
            statuses[capability] = (g.grant || g).status;
            say(`${capability}: ${statuses[capability]}`);
        }
        const notApproved = GRANTS.filter((c) => statuses[c] !== 'approved');
        if (notApproved.length) throw new Error(`not approved: ${notApproved.join(', ')}`);
    });

    await step('media', async () => {
        const file = path.join(dir, 'developer-path.txt');
        fs.writeFileSync(file, `OpenVibe developer path check ${now().toISOString()}\n`);
        const uploader = createUploader(mediaConfig(creds()), { fetch: fetchImpl });
        let out;
        try { out = await uploader.upload(file); } catch (err) { throw Object.assign(err, { detail: explain(err) }); }
        say(`uploaded ${out.key} (${out.size} bytes, ${out.mime}) into project ${out.project_id}; sandbox=${out.sandbox} url=${withoutQuery(out.url)}`);
        const meta = await uploader.get(out.key);
        if (!meta || meta.sha256 !== out.sha256) throw new Error('media.object.read did not return the file just uploaded');
        say(`read back with media.object.read: sha256 ${meta.sha256.slice(0, 16)}…`);
        if (!(await uploader.remove(out.key))) throw new Error('the delete removed nothing');
        say('deleted');
    });

    await step('events', async () => {
        const pub = await publishAppEvent(publishConfig(creds()), { name: 'developer_path.ran', subject: { type: 'check', id: 'developer-path' }, payload: { at: now().toISOString() } }, { fetch: fetchImpl });
        say(`published ${pub.event_type} ${pub.event_id} -> seq ${pub.seq}`);
        const cursorPath = path.join(dir, 'cursor.json');
        createCursorStore(cursorPath).set('pull', Math.max(0, pub.seq - 1));
        const seen = [];
        const s = createSubscriber(subscriberConfig({ ...creds(), OV_EVENTS_MODE: 'pull', OV_CURSOR_PATH: cursorPath }), {
            fetch: fetchImpl, log: { log: () => {}, error: (m) => say(m) }, onEvent: (event, { seq }) => { seen.push({ seq, id: event.event_id }); },
        });
        const topics = await s.resolveTopics();
        if (topics[0] !== `app.${projectKey(st.projectId)}.*`) throw new Error(`unexpected topic ${topics[0]}`);
        const n = await s.pullOnce();
        const mine = seen.find((e) => e.id === pub.event_id);
        if (!mine) throw new Error(`the published event ${pub.event_id} was not in the pull of ${topics[0]}`);
        say(`pulled ${topics[0]} with events.app.read: ${n} event(s), found ${mine.id} at seq ${mine.seq}`);
    });

    await step('credentials', async () => {
        const rotated = await st.projects.credentials.rotate(st.projectId, st.appId, { overlapSeconds: 0 });
        st.newSecret = rotated.credential.client_secret;
        onSecret(st.newSecret);
        say(`rotated: new credential ${rotated.credential.id} ending …${rotated.credential.hint}, no overlap`);
        if (st.credentialId) {
            const revoked = await st.projects.credentials.revoke(st.projectId, st.appId, st.credentialId);
            say(`revoked ${st.credentialId}: ${(revoked.credential || revoked).state || 'revoked'}`);
        }
        const old = await tryToken(fetchImpl, network, st.appId, st.secret, 'openvibe.media');
        if (old.ok) throw new Error('the revoked secret still gets a token');
        say(`old secret refused at /oauth/token: ${old.status} ${old.error}`);
        const fresh = await tryToken(fetchImpl, network, st.appId, st.newSecret, 'openvibe.media');
        if (!fresh.ok) throw new Error(`the new secret gets no token: ${fresh.status} ${fresh.error}`);
        say('new secret gets a token');
    });

    await step('cleanup', async () => {
        if (!st.projectId) { say('no project was created'); return; }
        await st.projects.archive(st.projectId);
        say(`archived ${st.projectId}: every app in it is revoked`);
        if (st.appId && (st.newSecret || st.secret)) {
            const after = await tryToken(fetchImpl, network, st.appId, st.newSecret || st.secret, 'openvibe.media');
            if (after.ok) throw new Error('the app still gets a token after the project was archived');
            say(`the app's secret is refused: ${after.status} ${after.error}`);
        }
    }, { always: true });

    fs.rmSync(dir, { recursive: true, force: true });
    const ok = steps.every((s) => s.ok);
    log(`${steps.filter((s) => s.ok).length}/${steps.length} steps ok`);
    return { ok, steps, projectId: st.projectId, appId: st.appId };
}

/** Mask every known secret, and anything token-shaped, in everything this process writes. */
function maskOutput() {
    const secrets = new Set();
    const mask = (s) => {
        let out = String(s);
        for (const v of secrets) out = out.split(v).join('[secret]');
        return out.replace(/eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]+/g, '[token]');
    };
    for (const stream of [process.stdout, process.stderr]) {
        const write = stream.write.bind(stream);
        stream.write = (chunk, ...rest) => write(typeof chunk === 'string' || Buffer.isBuffer(chunk) ? mask(chunk.toString()) : chunk, ...rest);
    }
    return (v) => { if (v && String(v).length >= 4) secrets.add(String(v)); };
}

function refuse(message) {
    console.error(message);
    console.error('\nusage: OV_E2E_USERNAME=… OV_E2E_PASSWORD=… npm run developer-path [-- --register]');
    console.error('   or: OV_USER_TOKEN=… npm run developer-path');
    return 2;
}

async function main(argv = process.argv.slice(2), env = process.env) {
    const network = (env.OV_NETWORK_URL || PRODUCTION_NETWORK).replace(/\/+$/, '');
    if (env.CI && new URL(network).host === new URL(PRODUCTION_NETWORK).host) {
        return refuse('developer-path: refusing to run against the production Network in CI (CI is set). CI runs npm run developer-path:mock. Nothing was sent.');
    }
    const register = argv.includes('--register');
    let account;
    if (env.OV_USER_TOKEN && !register) account = { token: env.OV_USER_TOKEN };
    else if (env.OV_E2E_USERNAME && env.OV_E2E_PASSWORD) account = { username: env.OV_E2E_USERNAME, password: env.OV_E2E_PASSWORD, register };
    else return refuse(`developer-path: missing ${register ? 'OV_E2E_USERNAME and OV_E2E_PASSWORD' : 'OV_E2E_USERNAME and OV_E2E_PASSWORD, or OV_USER_TOKEN'}. Nothing was sent.`);
    const onSecret = maskOutput();
    console.log(`OpenVibe developer path against ${network}\n`);
    const result = await runDeveloperPath({ network, account, onSecret });
    return result.ok ? 0 : 1;
}

module.exports = { runDeveloperPath, GRANTS, STEPS, PRODUCTION_NETWORK };

if (require.main === module) {
    main().then((code) => { process.exitCode = code; }, (err) => { console.error(`developer-path: ${describeError(err)}`); process.exitCode = 1; });
}
