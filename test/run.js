#!/usr/bin/env node
'use strict';
/**
 * Runs every example's smoke test (examples/<name>/test/smoke.test.js) and the repository checks
 * in test/*.test.js, each in its own process. No test needs the network or a running service:
 * the examples run against openvibe-sdk/testing's mock platform and small local mocks.
 *
 *   npm test                   # everything
 *   npm test -- chat oauth     # only names containing one of the words
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const filters = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const TIMEOUT_MS = 120000;

const tests = [
    ...fs.readdirSync(path.join(ROOT, 'examples')).sort()
        .filter((d) => fs.existsSync(path.join(ROOT, 'examples', d, 'test', 'smoke.test.js')))
        .map((d) => ({ name: `examples/${d}`, file: path.join(ROOT, 'examples', d, 'test', 'smoke.test.js'), cwd: path.join(ROOT, 'examples', d) })),
    ...fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.js')).sort()
        .map((f) => ({ name: `test/${f}`, file: path.join(__dirname, f), cwd: ROOT })),
].filter((t) => !filters.length || filters.some((w) => t.name.includes(w)));

function runOne(t) {
    return new Promise((resolve) => {
        const started = Date.now();
        const child = spawn(process.execPath, [t.file], { cwd: t.cwd, env: { ...process.env, NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '';
        child.stdout.on('data', (c) => { output += c; });
        child.stderr.on('data', (c) => { output += c; });
        const timer = setTimeout(() => { output += `\n[run] timed out after ${TIMEOUT_MS}ms`; child.kill('SIGKILL'); }, TIMEOUT_MS);
        child.on('close', (code, signal) => {
            clearTimeout(timer);
            resolve({ ...t, ok: code === 0, code: code ?? signal, ms: Date.now() - started, output });
        });
    });
}

(async () => {
    if (!tests.length) { console.error('no tests matched'); process.exit(1); }
    console.log(`node ${process.version}`);
    const results = [];
    for (const t of tests) {
        const r = await runOne(t);
        results.push(r);
        console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name.padEnd(34)} ${String(r.ms).padStart(6)}ms`);
    }
    const failed = results.filter((r) => !r.ok);
    for (const r of failed) {
        console.log(`\n-- ${r.name} (exit ${r.code}) --`);
        console.log(r.output.split('\n').slice(-60).join('\n'));
    }
    console.log(`\n${results.length - failed.length}/${results.length} passed`);
    process.exit(failed.length ? 1 : 0);
})();
