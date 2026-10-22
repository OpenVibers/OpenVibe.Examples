'use strict';
/**
 * Smoke test: the openai client against a stand-in for Network's /oauth/token and AI's
 * /v1/chat/completions, answering in the shapes server/api/openai.js answers (chat.completion with
 * x_openvibe, the chunk stream ending in usage, x_openvibe and [DONE], OpenAI's error object). No network.
 */
const assert = require('node:assert/strict');
const { loadConfig, createAiClient, ask, askStreamed } = require('../chat');

globalThis.fetch = () => { throw new Error('network access in a smoke test'); };

const calls = [];
let tokenN = 0;
const json = (status, o) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
const xo = { run_id: 'run_01TEST', provider: 'local', fallback_used: false, cost_usd: 0 };

async function fakeFetch(url, init = {}) {
    const u = String(url);
    const headers = new Headers(init.headers);
    if (u === 'https://openvibe.network/oauth/token') {
        const form = new URLSearchParams(String(init.body));
        calls.push({ kind: 'token', audience: form.get('audience'), scope: form.get('scope'), grant: form.get('grant_type') });
        return json(200, { access_token: `tok-${++tokenN}`, token_type: 'Bearer', expires_in: 300, scope: 'ai.app.run' });
    }
    if (u === 'https://ai.openvibe.services/v1/chat/completions') {
        const b = JSON.parse(init.body);
        calls.push({ kind: 'chat', auth: headers.get('authorization'), body: b });
        if (headers.get('authorization') !== 'Bearer tok-1') {
            // The answer production gives today without a token (checked 2026-10-22).
            return json(401, { error: { message: 'a service token (audience openvibe.ai) is required', type: 'authentication_error', code: 'token.missing', param: null } });
        }
        if (b.x_openvibe && b.x_openvibe.provider && b.x_openvibe.provider.secret === 'not-granted') {
            return json(403, { error: { message: 'project secret refused', type: 'authentication_error', code: 'project_secret.refused', param: null } });
        }
        const model = b.x_openvibe && b.x_openvibe.provider ? b.x_openvibe.provider.model : 'qwen-local';
        if (!b.stream) {
            return json(200, { id: 'chatcmpl-run_01TEST', object: 'chat.completion', created: 1, model,
                choices: [{ index: 0, message: { role: 'assistant', content: 'Hello from OpenVibe' }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 }, x_openvibe: xo });
        }
        const chunk = (delta, finish = null) => ({ id: 'chatcmpl-run_01TEST', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta, finish_reason: finish }] });
        const events = [chunk({ role: 'assistant', content: 'one ' }), chunk({ content: 'two ' }), chunk({ content: 'three' }), chunk({}, 'stop'),
            { id: 'chatcmpl-run_01TEST', object: 'chat.completion.chunk', created: 1, model, choices: [], usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 } },
            { id: 'chatcmpl-run_01TEST', object: 'chat.completion.chunk', created: 1, model, choices: [], x_openvibe: xo }];
        const sse = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n';
        return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8', 'x-openvibe-run-id': 'run_01TEST' } });
    }
    throw new Error(`unexpected request ${u}`);
}

(async () => {
    assert.throws(() => loadConfig({}), /missing environment variables: OV_CLIENT_ID, OV_CLIENT_SECRET/);
    const env = { OV_CLIENT_ID: 'app_01TEST', OV_CLIENT_SECRET: 'test-secret-not-real' };
    const config = loadConfig(env);
    assert.equal(config.provider, null);
    const openai = createAiClient(config, { fetch: fakeFetch });

    // 1. Plain: one token for openvibe.ai (ai.app.run), Bearer on the request, x_openvibe in the answer.
    const plain = await ask(openai, config, 'Say hi');
    assert.equal(plain.text, 'Hello from OpenVibe');
    assert.equal(plain.model, 'qwen-local');
    assert.equal(plain.openvibe.run_id, 'run_01TEST');
    assert.deepEqual(calls[0], { kind: 'token', audience: 'openvibe.ai', scope: 'ai.app.run', grant: 'client_credentials' });
    assert.equal(calls[1].auth, 'Bearer tok-1');
    assert.equal(calls[1].body.model, 'openvibe');
    assert.equal(calls[1].body.x_openvibe, undefined, 'no provider: the router picks');

    // 2. Streamed: deltas in order, then usage and x_openvibe; the token is reused from the cache.
    const pieces = [];
    const streamed = await askStreamed(openai, config, 'Count', (t) => pieces.push(t));
    assert.deepEqual(pieces, ['one ', 'two ', 'three']);
    assert.equal(streamed.text, 'one two three');
    assert.equal(streamed.usage.total_tokens, 7);
    assert.equal(streamed.openvibe.run_id, 'run_01TEST');
    assert.equal(calls.at(-1).body.stream, true);
    assert.deepEqual(calls.at(-1).body.stream_options, { include_usage: true });
    assert.equal(calls.filter((c) => c.kind === 'token').length, 1, 'one token for both calls');

    // 3. The project's own provider: x_openvibe.provider carries the secret's NAME, never a key.
    const own = loadConfig({ ...env, OV_PROVIDER_SECRET: 'openai-key', OV_PROVIDER_MODEL: 'gpt-5-mini' });
    tokenN = 0;
    const viaOwn = await ask(createAiClient(own, { fetch: fakeFetch }), own, 'Hi');
    assert.equal(viaOwn.model, 'gpt-5-mini');
    assert.deepEqual(calls.at(-1).body.x_openvibe, { provider: { base_url: 'https://api.openai.com/v1', model: 'gpt-5-mini', secret: 'openai-key' } });

    // 4. Errors keep OpenAI's shape, so the client's APIError has status and code.
    const refused = loadConfig({ ...env, OV_PROVIDER_SECRET: 'not-granted' });
    tokenN = 0;
    await assert.rejects(ask(createAiClient(refused, { fetch: fakeFetch }), refused, 'Hi'), (err) => err.status === 403 && err.code === 'project_secret.refused');

    console.log('ai-chat: ok');
})().catch((err) => { console.error(err); process.exit(1); });
