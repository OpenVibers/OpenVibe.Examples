#!/usr/bin/env node
'use strict';
/**
 * AI with the Anthropic SDK: the official `@anthropic-ai/sdk` client, pointed at OpenVibe.AI's Anthropic Messages
 * endpoint (POST https://ai.openvibe.services/v1/messages).
 *
 *   node --env-file=.env ask.js "Say hi in five words"
 *
 *   1. An app token for openvibe.ai (client credentials, scope ai.app.run: the public capability developer apps
 *      call AI with). Network tokens last five minutes: the SDK's `credentials` provider asks openvibe-sdk for one
 *      before it expires, and the SDK sends it as a Bearer token.
 *   2. new Anthropic({ baseURL: 'https://ai.openvibe.services', credentials }).
 *   3. messages.create(): `model` is a dynamic name (openvibe picks within your rules) or an exact model id from
 *      https://openvibe.network/models; the answer names the model that ran.
 */
const Anthropic = require('@anthropic-ai/sdk');
const { createServiceTokenClient } = require('openvibe-sdk/auth');

function loadConfig(env = process.env) {
    const missing = ['OV_CLIENT_ID', 'OV_CLIENT_SECRET'].filter((k) => !env[k]);
    if (missing.length) throw Object.assign(new Error(`missing environment variables: ${missing.join(', ')} (see .env.example)`), { code: 'config.missing' });
    return {
        network: env.OV_NETWORK_URL || 'https://openvibe.network',
        clientId: env.OV_CLIENT_ID,
        clientSecret: env.OV_CLIENT_SECRET,
        aiUrl: env.OV_AI_URL || 'https://ai.openvibe.services',
        model: env.OV_MODEL || 'openvibe',
    };
}

function createClient(config, { fetch } = {}) {
    const tokens = createServiceTokenClient({
        network: config.network, clientId: config.clientId, clientSecret: config.clientSecret, fetch,
        audience: 'openvibe.ai', scope: 'ai.app.run',
    });
    return new Anthropic({
        baseURL: config.aiUrl,
        // The SDK caches what this returns until expiresAt; openvibe-sdk refreshes the token a minute early.
        credentials: async () => ({ token: await tokens.getToken(), expiresAt: Math.floor(Date.now() / 1000) + 60 }),
        ...(fetch ? { fetch } : {}),
    });
}

async function ask(client, config, prompt) {
    const reply = await client.messages.create({ model: config.model, max_tokens: 512, messages: [{ role: 'user', content: prompt }] });
    const text = reply.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    return { text, model: reply.model, usage: reply.usage, x_openvibe: reply.x_openvibe || null };
}

if (require.main === module) {
    (async () => {
        const config = loadConfig();
        const prompt = process.argv.slice(2).join(' ') || 'Say hi in five words';
        const out = await ask(createClient(config), config, prompt);
        console.log(out.text);
        console.log(`(${out.model}${out.x_openvibe && out.x_openvibe.cost_usd != null ? `, $${out.x_openvibe.cost_usd}` : ''})`);
    })().catch((e) => { console.error(e.message || e); process.exit(1); });
}

module.exports = { loadConfig, createClient, ask };
