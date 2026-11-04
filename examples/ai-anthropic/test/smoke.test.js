'use strict';
/**
 * Smoke test: the Anthropic SDK against stand-ins of Network's /oauth/token and AI's /v1/messages, answering in the
 * shapes server/api/messages.js answers (a message with content blocks, usage and x_openvibe). No network.
 */
const assert = require('node:assert/strict');
const { loadConfig, createClient, ask } = require('../ask');

globalThis.fetch = () => { throw new Error('network access in a smoke test'); };
const calls = [];
const json = (status, o) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });

async function fakeFetch(url, init = {}) {
    const u = String(url);
    const headers = new Headers(init.headers);
    if (u === 'https://openvibe.network/oauth/token') {
        const form = new URLSearchParams(String(init.body));
        calls.push({ kind: 'token', audience: form.get('audience'), scope: form.get('scope') });
        return json(200, { access_token: 'tok-1', token_type: 'Bearer', expires_in: 300, scope: 'ai.app.run' });
    }
    if (u === 'https://ai.openvibe.services/v1/messages') {
        calls.push({ kind: 'messages', auth: headers.get('authorization'), apiKey: headers.get('x-api-key'), body: JSON.parse(init.body) });
        return json(200, {
            id: 'msg_01TEST', type: 'message', role: 'assistant', model: 'qwen/qwen3-8b-abliterated:q4_k_m@3f2a1c9', stop_reason: 'end_turn', stop_sequence: null,
            content: [{ type: 'text', text: 'Hi there, nice to meet you!' }], usage: { input_tokens: 12, output_tokens: 7 },
            x_openvibe: { run_id: 'run_01TEST', provider: 'own', fallback_used: false, cost_usd: 0.000001 },
        });
    }
    throw new Error(`unexpected request ${u}`);
}

(async () => {
    assert.throws(() => loadConfig({}), /missing environment variables: OV_CLIENT_ID, OV_CLIENT_SECRET/);
    const config = loadConfig({ OV_CLIENT_ID: 'app_01TEST', OV_CLIENT_SECRET: 'not-a-real-secret' });
    const client = createClient(config, { fetch: fakeFetch });
    const out = await ask(client, config, 'Say hi in five words');
    assert.equal(out.text, 'Hi there, nice to meet you!');
    assert.equal(out.model, 'qwen/qwen3-8b-abliterated:q4_k_m@3f2a1c9', 'the answer names the model that ran');
    assert.equal(out.x_openvibe.run_id, 'run_01TEST');
    const token = calls.find((c) => c.kind === 'token');
    assert.deepEqual([token.audience, token.scope], ['openvibe.ai', 'ai.app.run'], 'an app token of openvibe.ai, scoped ai.app.run');
    const m = calls.find((c) => c.kind === 'messages');
    assert.equal(m.auth, 'Bearer tok-1', 'the Network token as a Bearer token');
    assert.ok(!m.apiKey, 'no x-api-key: this is not an Anthropic key');
    assert.equal(m.body.model, 'openvibe');
    assert.deepEqual(m.body.messages, [{ role: 'user', content: 'Say hi in five words' }]);
    console.log('ai-anthropic smoke: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
