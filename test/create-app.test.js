'use strict';
/**
 * create-openvibe-app (WS-N task 6): every template scaffolds a working app. The copy is the tested
 * example without node_modules or .env, renamed, with a .gitignore, and its own smoke test passes
 * where it lands (resolving the SDK from this repository's install, as `npm install` would).
 * A non-empty target and an unknown template are refused; nothing needs the network.
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BIN = path.join(ROOT, 'scripts', 'create-openvibe-app.js');
const { TEMPLATES, packageName } = require(BIN);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'create-ov-app-'));
const run = (args, opts = {}) => spawnSync(process.execPath, [BIN, ...args], { cwd: tmp, encoding: 'utf8', ...opts });

try {
    assert.equal(require(path.join(ROOT, 'package.json')).bin['create-openvibe-app'], 'scripts/create-openvibe-app.js', 'the package exposes the bin');
    assert.equal(packageName('My Cool App!'), 'my-cool-app');

    for (const [template, t] of Object.entries(TEMPLATES)) {
        const dir = `app-${template}`;
        const r = run([dir, '--template', template]);
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, new RegExp(`Created app-${template} in ${dir} from the ${template} template`));
        const target = path.join(tmp, dir);
        const files = fs.readdirSync(target);
        assert.ok(!files.includes('node_modules') && !files.includes('.env'), `${template}: no node_modules or .env copied`);
        assert.ok(files.includes('.gitignore') && files.includes('.env.example') && files.includes('README.md'), `${template}: .gitignore, .env.example, README`);
        assert.equal(fs.readFileSync(path.join(target, '.gitignore'), 'utf8'), 'node_modules/\n.env\n');
        const pkg = JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8'));
        const orig = require(path.join(ROOT, 'examples', t.example, 'package.json'));
        assert.equal(pkg.name, `app-${template}`);
        assert.equal(pkg.version, '0.1.0');
        assert.deepEqual(pkg.dependencies || {}, orig.dependencies || {}, `${template}: the pinned dependencies are the example's`);
        assert.match(fs.readFileSync(path.join(target, 'README.md'), 'utf8'), new RegExp(`^# app-${template}\\n\\nStarted with create-openvibe-app`));
        // The scaffolded app's own smoke test, where it landed.
        const smoke = spawnSync(process.execPath, ['test/smoke.test.js'], { cwd: target, encoding: 'utf8', env: { ...process.env, NODE_PATH: path.join(ROOT, 'node_modules') }, timeout: 60000 });
        assert.equal(smoke.status, 0, `${template} smoke:\n${smoke.stdout}\n${smoke.stderr}`);
    }

    // Refusals: a non-empty directory, an unknown template.
    let r = run(['app-web', '--template', 'web']);
    assert.notEqual(r.status, 0); assert.match(r.stderr, /exists and is not empty/);
    r = run(['other', '--template', 'nope']);
    assert.notEqual(r.status, 0); assert.match(r.stderr, /Unknown template "nope"/);
    // Without a terminal and without --template, the web template.
    r = run(['plain'], { input: '' });
    assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /from the web template/);
    console.log('create-openvibe-app: all checks passed');
} finally {
    fs.rmSync(tmp, { recursive: true, force: true });
}
