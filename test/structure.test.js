'use strict';
/**
 * Every example is copyable on its own: a README (with how to run it against the real platform),
 * a .env.example naming every variable its code reads, an MIT package.json whose dependencies are
 * pinned tags (no file: links), and a smoke test that the root runner picks up.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const EXPECTED = ['browser-app', 'chat-bot', 'event-subscriber', 'media-uploader', 'mod-manifest', 'node-server-app', 'oauth-app', 'tool-job', 'webhook-consumer'];
const SDK = 'https://codeload.github.com/OpenVibers/OpenVibe.SDK/tar.gz/refs/tags/v0.2.2';

const dirs = fs.readdirSync(path.join(ROOT, 'examples')).filter((d) => fs.statSync(path.join(ROOT, 'examples', d)).isDirectory()).sort();
assert.deepEqual(dirs, EXPECTED, 'the nine charter examples');

function sources(dir) {
    const out = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === 'test') continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...sources(p));
        else if (/\.js$/.test(e.name)) out.push(p);
    }
    return out;
}

for (const name of EXPECTED) {
    const dir = path.join(ROOT, 'examples', name);
    for (const f of ['README.md', '.env.example', 'package.json', 'test/smoke.test.js']) {
        assert.ok(fs.existsSync(path.join(dir, f)), `${name}/${f} exists`);
    }
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    assert.equal(pkg.license, 'MIT', `${name}: MIT`);
    assert.equal(pkg.scripts.test, 'node test/smoke.test.js', `${name}: npm test runs the smoke test`);
    for (const [dep, spec] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
        assert.ok(!/^(file|link):/.test(spec), `${name}: ${dep} is not a local link`);
        if (dep === 'openvibe-sdk') assert.equal(spec, SDK, `${name}: openvibe-sdk pinned to v0.2.2`);
    }

    const readme = fs.readFileSync(path.join(dir, 'README.md'), 'utf8');
    assert.match(readme, /^## Run it against the real platform$/m, `${name}: README says how to run it for real`);
    assert.match(readme, /^## What it proves$/m, `${name}: README says what it proves`);

    const envExample = fs.readFileSync(path.join(dir, '.env.example'), 'utf8');
    const declared = new Set([...envExample.matchAll(/^#?\s*(OV_[A-Z_]+)=/gm)].map((m) => m[1]));
    const used = new Set();
    for (const file of sources(dir)) {
        for (const m of fs.readFileSync(file, 'utf8').matchAll(/env\.(OV_[A-Z_]+)/g)) used.add(m[1]);
    }
    for (const v of used) assert.ok(declared.has(v), `${name}: ${v} is read by the code but missing from .env.example`);
}

// The root runner and CI.
const ci = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
assert.match(ci, /node-version: 22\.22\.1/);
assert.match(ci, /npm test/);
assert.equal(JSON.parse(fs.readFileSync(path.join(ROOT, 'STATUS.json'), 'utf8')).stage, 'alpha');
assert.match(fs.readFileSync(path.join(ROOT, 'LICENSE'), 'utf8'), /^MIT License/);
console.log('structure: ok');
