#!/usr/bin/env node
'use strict';
/**
 * Runs every example's smoke test (examples/<name>/test/smoke.test.js) and the repository checks
 * in test/*.test.js, each in its own process. No test needs the network or a running service:
 * the examples run against openvibe-sdk/testing's mock platform and small local mocks.
 *
 *   npm test                   # everything
 *   npm test -- chat oauth     # only names containing one of the words
 *   npm test -- --strict       # a skipped test fails the run too (or OV_TEST_STRICT=1)
 *
 * A test that cannot run something here prints `<label>: skipped (<why>)`: it is listed as `skip`
 * with its reasons and not counted as passed, so the summary reads `20/21 passed, 1 skipped (…)`;
 * only a run with nothing skipped says `N/N passed`. This is the rule of openvibe-shared/test-runner,
 * copied here because this repository does not depend on openvibe-shared.
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const strict = process.argv.includes('--strict') || process.env.OV_TEST_STRICT === '1';
const filters = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const TIMEOUT_MS = 120000;

/** `<label>: skipped (<why>)` on a line of its own (SKIP_RE from openvibe-shared/test-runner). */
const SKIP_RE = /^[ \t]*[\w .,'()/+#-]{1,120}: skipped \((.+)\)[ \t]*$/gm;

/** The skip lines in a test's output, in order, without repeats (skipsIn from openvibe-shared/test-runner). */
function skipsIn(output) {
    const out = [];
    for (const m of String(output || '').matchAll(SKIP_RE)) {
        const line = m[0].trim();
        if (!out.includes(line)) out.push(line);
    }
    return out;
}

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
            const ok = code === 0;
            const skips = ok ? skipsIn(output) : [];
            resolve({ ...t, ok, state: !ok ? 'fail' : skips.length ? 'skip' : 'pass', skips, code: code ?? signal, ms: Date.now() - started, output });
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
        const mark = r.state === 'pass' ? 'ok  ' : r.state === 'skip' ? 'skip' : 'FAIL';
        console.log(`${mark} ${r.name.padEnd(34)} ${String(r.ms).padStart(6)}ms${r.state === 'skip' ? `  ${r.skips.join('; ')}` : ''}`);
    }
    const failed = results.filter((r) => r.state === 'fail');
    const skipped = results.filter((r) => r.state === 'skip');
    for (const r of failed) {
        console.log(`\n-- ${r.name} (exit ${r.code}) --`);
        console.log(r.output.split('\n').slice(-60).join('\n'));
    }
    const passed = results.length - failed.length - skipped.length;
    console.log(skipped.length
        ? `\n${passed}/${results.length} passed, ${skipped.length} skipped (${skipped.map((r) => `${r.name}: ${r.skips.join('; ')}`).join(' | ')})${strict ? ' — strict: skips fail the run' : ''}`
        : `\n${passed}/${results.length} passed`);
    process.exit(failed.length || (strict && skipped.length) ? 1 : 0);
})();
