#!/usr/bin/env node
'use strict';
/**
 * AI chat: the official `openai` npm client, pointed at OpenVibe.AI's OpenAI-compatible endpoint.
 *
 *   node --env-file=.env chat.js "Say hi in five words"            # one answer
 *   node --env-file=.env chat.js --stream "Count to five"           # streamed, deltas as they arrive
 *
 *   1. App token for openvibe.ai (client credentials, scope ai.app.run). Network tokens last five
 *      minutes, so the client gets a token function: openvibe-sdk caches it and refreshes it in time.
 *   2. new OpenAI({ baseURL: 'https://ai.openvibe.services/v1', apiKey: <that function> }).
 *   3. chat.completions.create(): `model` may be anything, AI's router picks the upstream; the answer
 *      names the model that ran and adds x_openvibe (run_id, provider, cost_usd).
 *   4. With OV_PROVIDER_* set, x_openvibe.provider sends the run to the project's own OpenAI-format API
 *      (ADR-056): `secret` is the NAME of a project secret granted to ai; Network reveals the key for
 *      that one run, and this code never sees it.
 */
const OpenAI = require('openai');
const { createServiceTokenClient } = require('openvibe-sdk/auth');

function loadConfig(env = process.env) {
    const missing = ['OV_CLIENT_ID', 'OV_CLIENT_SECRET'].filter((k) => !env[k]);
    if (missing.length) {
        throw Object.assign(new Error(`missing environment variables: ${missing.join(', ')} (see .env.example)`), { code: 'config.missing' });
    }
    const provider = env.OV_PROVIDER_SECRET
        ? { base_url: env.OV_PROVIDER_BASE_URL || 'https://api.openai.com/v1', model: env.OV_PROVIDER_MODEL || 'gpt-5-mini', secret: env.OV_PROVIDER_SECRET }
        : null;
    return {
        network: env.OV_NETWORK_URL || 'https://openvibe.network',
        clientId: env.OV_CLIENT_ID,
        clientSecret: env.OV_CLIENT_SECRET,
        aiUrl: env.OV_AI_URL || 'https://ai.openvibe.services/v1',
        provider,
    };
}

function createAiClient(config, { fetch } = {}) {
    const tokens = createServiceTokenClient({
        network: config.network, clientId: config.clientId, clientSecret: config.clientSecret, fetch,
        audience: 'openvibe.ai', scope: 'ai.app.run',
    });
    return new OpenAI({
        baseURL: config.aiUrl,
        apiKey: () => tokens.getToken(),          // called before each request; cached until a minute before expiry
        ...(fetch ? { fetch } : {}),
    });
}

/** The request body: the project's own provider rides along as x_openvibe.provider (an extra field). */
function body(config, prompt, extra = {}) {
    return {
        model: 'openvibe',
        messages: [{ role: 'user', content: prompt }],
        ...extra,
        ...(config.provider ? { x_openvibe: { provider: config.provider } } : {}),
    };
}

async function ask(openai, config, prompt) {
    const answer = await openai.chat.completions.create(body(config, prompt));
    return { text: answer.choices[0].message.content, model: answer.model, openvibe: answer.x_openvibe, usage: answer.usage };
}

async function askStreamed(openai, config, prompt, onText = (t) => process.stdout.write(t)) {
    const stream = await openai.chat.completions.create(body(config, prompt, { stream: true, stream_options: { include_usage: true } }));
    let text = '';
    let usage = null;
    let openvibe = null;
    for await (const chunk of stream) {
        const piece = chunk.choices && chunk.choices[0] && chunk.choices[0].delta && chunk.choices[0].delta.content;
        if (piece) { text += piece; onText(piece); }
        if (chunk.usage) usage = chunk.usage;
        if (chunk.x_openvibe) openvibe = chunk.x_openvibe;
    }
    return { text, usage, openvibe };
}

async function main(argv = process.argv.slice(2)) {
    const stream = argv[0] === '--stream';
    const prompt = (stream ? argv.slice(1) : argv).join(' ');
    if (!prompt) { console.error('usage: node chat.js [--stream] <prompt>'); return 2; }
    try {
        const config = loadConfig();
        const openai = createAiClient(config);
        const out = stream ? await askStreamed(openai, config, prompt) : await ask(openai, config, prompt);
        if (!stream) console.log(out.text);
        else process.stdout.write('\n');
        if (out.openvibe) console.error(`run ${out.openvibe.run_id} on ${out.openvibe.provider}, $${out.openvibe.cost_usd}`);
        return 0;
    } catch (err) {
        // The endpoint answers OpenAI's error shape, so the openai client's APIError carries it.
        console.error(`chat failed: ${err.status ? `${err.status} ${err.code || ''} ` : ''}${err.message}`);
        return 1;
    }
}

if (require.main === module) main().then((code) => { process.exitCode = code; });

module.exports = { loadConfig, createAiClient, ask, askStreamed, main };
