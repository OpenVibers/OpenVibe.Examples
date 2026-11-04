'use strict';
/**
 * Smoke test of the Python example: it compiles (python3 -m py_compile, when Python is on the machine), and it asks
 * Network the right token (audience openvibe.ai, scope ai.app.run) and calls the right base URL. No network.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const file = path.join(__dirname, '..', 'chat.py');
const src = fs.readFileSync(file, 'utf8');
assert.match(src, /"audience": "openvibe\.ai"/);
assert.match(src, /"scope": "ai\.app\.run"/);
assert.match(src, /https:\/\/ai\.openvibe\.services\/v1/);
assert.match(src, /OpenAI\(base_url=AI, api_key=app_token\(\)\)/);
const py = spawnSync('python3', ['-m', 'py_compile', file], { encoding: 'utf8' });
if (py.error && py.error.code === 'ENOENT') console.log('ai-python smoke: no python3 here; the source checks passed');
else {
    assert.equal(py.status, 0, py.stderr);
    console.log('ai-python smoke: compiles; all checks passed');
}
