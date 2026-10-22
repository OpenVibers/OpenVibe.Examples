'use strict';
/**
 * Smoke test: deploy.js against a stand-in for Network's /oauth/token and Space's deploy routes (the shapes
 * server/http/api.js answers): one app token for openvibe.space with space.deploy.create, the built folder sent as
 * files with their paths and types (dotfiles left behind), live or as a preview, a refusal passed on with Space's
 * code, and a rollback. No network.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig, createSpace, collectFiles, deploy, rollback } = require('../deploy');

globalThis.fetch = () => { throw new Error('network access in a smoke test'); };

const SITE = 'sit_01JABCDEFGHJKMNPQRSTVWXYZ0';
const DPL = 'dpl_01JABCDEFGHJKMNPQRSTVWXYZ1';
const PREV = 'dpl_01JABCDEFGHJKMNPQRSTVWXYZ2';
const calls = [];
let refuse = false;
const json = (status, o, type = 'application/json') => new Response(JSON.stringify(o), { status, headers: { 'content-type': type } });

async function fakeFetch(url, init = {}) {
    const u = new URL(String(url));
    const method = init.method || 'GET';
    const headers = new Headers(init.headers);
    if (u.href === 'https://openvibe.network/oauth/token') {
        const form = new URLSearchParams(String(init.body));
        calls.push({ kind: 'token', audience: form.get('audience'), scope: form.get('scope'), grant: form.get('grant_type') });
        return json(200, { access_token: 'tok-1', token_type: 'Bearer', expires_in: 300, scope: 'space.deploy.create' });
    }
    assert.equal(u.origin, 'https://openvibe.space');
    assert.equal(headers.get('authorization'), 'Bearer tok-1');
    if (method === 'POST' && u.pathname === `/api/v1/sites/${SITE}/deploys`) {
        const form = await new Request(u, { method, headers, body: init.body }).formData();
        const files = form.getAll('files').map((f) => ({ name: f.name, type: f.type, size: f.size }));
        calls.push({ kind: 'deploy', query: Object.fromEntries(u.searchParams), files });
        if (refuse) return json(413, { type: 'about:blank', title: 'Quota exceeded', status: 413, code: 'quota.exceeded', detail: 'this deploy would take the project past its 1 GB', deploy_id: DPL, log: ['error: quota.exceeded'] }, 'application/problem+json');
        const preview = u.searchParams.get('preview') === '1';
        return json(201, { deploy: { id: DPL, status: 'ready', files: files.length }, log: [], activated: preview ? null : { changed: true }, preview: preview ? { deploy_id: DPL, expires_at: '2026-10-29T00:00:00.000Z' } : null });
    }
    if (method === 'POST' && u.pathname === `/api/v1/sites/${SITE}/rollback`) {
        const body = JSON.parse(init.body || '{}');
        calls.push({ kind: 'rollback', body });
        return json(200, { active_deploy_id: body.deploy_id || PREV, previous_deploy_id: DPL, changed: true });
    }
    throw new Error(`unexpected ${method} ${u.pathname}`);
}

(async () => {
    // A built site in a temporary folder, with a dotfile that must stay behind.
    const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'space-deploy-'));
    fs.mkdirSync(path.join(dist, 'css'));
    fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>Hi</title><link rel="stylesheet" href="css/site.css">');
    fs.writeFileSync(path.join(dist, 'css', 'site.css'), 'body{margin:0}');
    fs.writeFileSync(path.join(dist, '.env'), 'SECRET=never-uploaded');
    try {
        assert.throws(() => loadConfig({}), /missing environment variables: OV_CLIENT_ID, OV_CLIENT_SECRET, OV_SPACE_SITE/);
        assert.throws(() => loadConfig({ OV_CLIENT_ID: 'app_1', OV_CLIENT_SECRET: 's', OV_SPACE_SITE: 'my-site' }), /sit_…/);
        const config = loadConfig({ OV_CLIENT_ID: 'app_01TEST', OV_CLIENT_SECRET: 'test-secret-not-real', OV_SPACE_SITE: SITE, OV_DIR: dist });
        assert.deepEqual([config.dir, config.preview, config.spaceUrl], [dist, false, 'https://openvibe.space']);

        // The folder: paths with forward slashes and types; dotfiles stay behind; an index.html is required.
        assert.deepEqual(collectFiles(dist).map((f) => [f.path, f.type]).sort(), [['css/site.css', 'text/css; charset=utf-8'], ['index.html', 'text/html; charset=utf-8']]);
        assert.throws(() => collectFiles(path.join(dist, 'css')), /no index\.html/);
        assert.throws(() => collectFiles(path.join(dist, 'missing')), /not a folder: build the site first/);

        const space = createSpace(config, { fetch: fakeFetch });

        // Live: one token (openvibe.space, space.deploy.create), the files as a form, activate=1.
        const lines = [];
        const live = await deploy(space, config, { log: (l) => lines.push(l) });
        assert.equal(live.deploy.id, DPL);
        const token = calls.find((c) => c.kind === 'token');
        assert.deepEqual([token.audience, token.scope, token.grant], ['openvibe.space', 'space.deploy.create', 'client_credentials']);
        const up = calls.find((c) => c.kind === 'deploy');
        assert.deepEqual(up.query, { activate: '1' });
        assert.deepEqual(up.files.map((f) => f.name).sort(), ['css/site.css', 'index.html']);
        assert.equal(up.files.find((f) => f.name === 'index.html').type, 'text/html; charset=utf-8');
        assert.deepEqual(lines, [`Uploading 2 file(s), ${((84 + 14) / 1024).toFixed(1)} KB, from ${dist}`, `Live: site ${SITE} now serves deploy ${DPL}`]);

        // A preview (pull requests): preview=1, never activated.
        calls.length = 0;
        const pv = await deploy(space, { ...config, preview: true }, { log: () => {} });
        assert.deepEqual(calls.find((c) => c.kind === 'deploy').query, { preview: '1' });
        assert.equal(pv.preview.expires_at, '2026-10-29T00:00:00.000Z');
        assert.equal(calls.filter((c) => c.kind === 'token').length, 0, 'the token is cached between calls');

        // A refused upload: Space's code reaches the caller; the site keeps its current deploy.
        refuse = true;
        await assert.rejects(deploy(space, config, { log: () => {} }), (err) => err.code === 'quota.exceeded' && err.status === 413);
        refuse = false;

        // Rollback: the previous deploy, or a named one.
        const back = [];
        const r = await rollback(space, config, undefined, { log: (l) => back.push(l) });
        assert.equal(r.active_deploy_id, PREV);
        assert.deepEqual(calls.at(-1).body, {});
        await rollback(space, config, PREV, { log: () => {} });
        assert.deepEqual(calls.at(-1).body, { deploy_id: PREV });
        await assert.rejects(rollback(space, config, 'yesterday', { log: () => {} }), /deploy id \(dpl_…\)/);
        assert.deepEqual(back, [`Rolled back: site ${SITE} serves deploy ${PREV} (was ${DPL})`]);

        console.log('space-deploy smoke: app token for openvibe.space, the folder as files (no dotfiles), live and preview deploys, a refusal, rollback');
    } finally {
        fs.rmSync(dist, { recursive: true, force: true });
    }
})().catch((err) => { console.error(err); process.exit(1); });
