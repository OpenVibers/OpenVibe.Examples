#!/usr/bin/env node
'use strict';
/**
 * Create a project and a sandbox app for the examples with openvibe-sdk/projects, the same
 * /api/v1/projects API https://openvibe.codes uses. Nothing here needs staff: a new project is
 * sandbox, and the project owner's grant requests inside the sandbox allowance are approved at once.
 *
 *   npm run new-app                       # new project + confidential sandbox app -> ./.env
 *   npm run new-app -- --project prj_…    # add the app to a project you already have
 *   npm run new-app -- --public           # a PUBLIC app for examples/browser-app (no secret)
 *
 * It needs a Network user access token: OV_USER_TOKEN, or it asks for your username and password
 * (the password is not echoed) and signs in at <network>/api/auth/login. The confidential app's
 * secret is shown ONCE by Network; this writes it straight into ./.env (mode 0600) with
 * OV_CLIENT_ID and OV_PROJECT_ID and never prints it. An existing .env is never overwritten.
 */
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { createClient, isOpenVibeError } = require('openvibe-sdk/core');
const { createProjectsClient } = require('openvibe-sdk/projects');

const ROOT = path.join(__dirname, '..');
const SANDBOX_GRANTS = [
    'media.object.upload', 'media.object.read',
    'events.app.publish', 'events.app.read', 'events.app.subscribe',
    'tools.job.create', 'tools.job.read', 'tools.job.cancel',
];

function ask(question, { hidden = false } = {}) {
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
        if (hidden) rl._writeToOutput = (s) => { if (s.includes(question)) process.stdout.write(s); };
        rl.question(question, (answer) => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(answer); });
    });
}

async function userToken(network) {
    if (process.env.OV_USER_TOKEN) return process.env.OV_USER_TOKEN;
    if (!process.stdin.isTTY) throw new Error('set OV_USER_TOKEN, or run this in a terminal to sign in');
    const username = await ask('OpenVibe username: ');
    const password = await ask('password: ', { hidden: true });
    const res = await fetch(`${network}/api/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ username, password }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.token) throw new Error(`sign-in refused (${res.status})`);
    return body.token;
}

async function main(argv = process.argv.slice(2)) {
    const network = (process.env.OV_NETWORK_URL || 'https://openvibe.network').replace(/\/+$/, '');
    const isPublic = argv.includes('--public');
    const pi = argv.indexOf('--project');
    const existing = pi >= 0 ? argv[pi + 1] : null;
    const envFile = path.join(ROOT, '.env');
    if (!isPublic && fs.existsSync(envFile)) {
        console.error(`${envFile} exists; move it away first (this never overwrites a secret).`);
        return 2;
    }
    try {
        const projects = createProjectsClient(createClient({ network, token: await userToken(network) }));
        let projectId = existing;
        if (!projectId) {
            const p = await projects.create({ name: 'OpenVibe examples' });
            projectId = (p.project || p).id;
            console.log(`project ${projectId} (sandbox)`);
        }
        const created = await projects.apps.create(projectId, isPublic
            ? { name: 'examples browser-app', environment: 'sandbox', type: 'public', redirectUris: ['http://localhost:3001/callback'] }
            : { name: 'examples', environment: 'sandbox', type: 'confidential', redirectUris: ['http://localhost:3009/callback'] });
        const app = created.app || created;
        const appId = app.id || app.client_id;
        console.log(`app ${appId} (sandbox, ${isPublic ? 'public' : 'confidential'})`);
        for (const capability of isPublic ? ['media.object.read'] : SANDBOX_GRANTS) {
            try {
                const g = await projects.grants.request(projectId, appId, capability);
                console.log(`  grant ${capability}: ${(g.grant || g).status}`);
            } catch (err) {
                console.log(`  grant ${capability}: ${isOpenVibeError(err) ? err.code : err.message}`);
            }
        }
        if (isPublic) {
            console.log(`\nexamples/browser-app/.env: OV_CLIENT_ID=${appId} (a public app has no secret)`);
            return 0;
        }
        const secret = (created.credential || app.credential || {}).client_secret || created.client_secret;
        if (!secret) throw new Error('Network returned no client secret; rotate one on the app (openvibe.codes)');
        fs.writeFileSync(envFile, `OV_CLIENT_ID=${appId}\nOV_CLIENT_SECRET=${secret}\nOV_PROJECT_ID=${projectId}\n`, { mode: 0o600 });
        console.log(`\nwrote ${envFile} (OV_CLIENT_ID, OV_CLIENT_SECRET, OV_PROJECT_ID; mode 0600). Next: npm run e2e`);
        return 0;
    } catch (err) {
        console.error(`failed: ${isOpenVibeError(err) ? `${err.code}${err.detail ? `: ${err.detail}` : ''} (request ${err.requestId})` : err.message}`);
        return 1;
    }
}

main().then((code) => { process.exitCode = code; });
