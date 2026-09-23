'use strict';
/**
 * The examples use public surfaces only. Fails on:
 *   - the loopback shared-key header used between first-party services;
 *   - paths under the platform's internal route prefix;
 *   - hard-coded loopback service ports (127.0.0.1:<digits>, localhost:4xxx = the platform's
 *     service port range), except in the local test mocks (test/mock-*.js);
 *   - a secret-looking value in any .env.example.
 * Scans every file in the repository except node_modules, .git and this file.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SELF = __filename;
const SKIP_DIRS = new Set(['node_modules', '.git']);
const TEXT = /\.(js|mjs|cjs|json|md|html|css|yml|yaml|txt)$|\.env\.example$|^\.gitignore$/;

function walk(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (SKIP_DIRS.has(entry.name)) continue;
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(p, out);
        else if (TEXT.test(entry.name) && p !== SELF && entry.name !== 'package-lock.json') out.push(p);
    }
    return out;
}

const RULES = [
    { name: 'internal key header', re: new RegExp(['X', 'Internal', 'Key'].join('-'), 'i') },
    { name: 'internal route', re: new RegExp(`/${'internal'}/`) },
    { name: 'loopback service port', re: new RegExp(`127\\.0\\.0\\.1:\\d|localhost:4\\d{3}\\b`), allow: (rel) => /(^|\/)test\/mock-[\w-]+\.js$/.test(rel) },
];

const files = walk(ROOT);
assert.ok(files.length > 20, 'the scan found the examples');
const problems = [];
for (const file of files) {
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
        for (const rule of RULES) {
            if (rule.re.test(line) && !(rule.allow && rule.allow(rel))) problems.push(`${rel}:${i + 1} ${rule.name}: ${line.trim().slice(0, 120)}`);
        }
    });
    if (rel.endsWith('.env.example')) {
        lines.forEach((line, i) => {
            const m = line.match(/^\s*(OV_[A-Z_]*(SECRET|TOKEN)[A-Z_]*)\s*=\s*(\S+)/);
            if (m) problems.push(`${rel}:${i + 1} ${m[1]} has a value in .env.example; leave secrets empty`);
        });
    }
}
assert.deepEqual(problems, [], `public-surface violations:\n${problems.join('\n')}`);

// The rule itself works (so a green run means something).
assert.ok(RULES[0].re.test('X-' + 'Internal-Key: k'));
assert.ok(RULES[1].re.test("path: '/" + "internal/identity/resolve'"));
assert.ok(RULES[2].re.test('http://127.0.0.1:' + '4300/api'));
assert.ok(!RULES[2].re.test('`http://127.0.0.1:${port}`'));
console.log(`public-surface: ok (${files.length} files)`);
