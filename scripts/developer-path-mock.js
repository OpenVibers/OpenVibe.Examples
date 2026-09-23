#!/usr/bin/env node
'use strict';
/**
 * npm run developer-path:mock: scripts/developer-path.js, step for step, against
 * openvibe-sdk/testing's mock platform instead of the real one. CI runs it on every push. No
 * network: anything that is not the mock fails.
 *
 * The mock platform answers Network's projects API, /oauth/token, discovery, Media and Events at
 * their public origins with real RS256 tokens. It has no account API, so this adds the two routes
 * the flow uses, /api/auth/register and /api/auth/login, as a thin layer: register creates a mock
 * user and returns a Network user token for it; login returns one for an existing user (the mock
 * does not check passwords). Everything after the account step is the platform mock's own.
 */
const { createMockPlatform } = require('openvibe-sdk/testing');
const { runDeveloperPath, PRODUCTION_NETWORK } = require('./developer-path');

function withAccounts(platform, network = PRODUCTION_NETWORK) {
    const byName = new Map();
    const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    return async (input, init = {}) => {
        const url = new URL(typeof input === 'string' ? input : input.url);
        const method = (init.method || (typeof input === 'string' ? 'GET' : input.method) || 'GET').toUpperCase();
        if (url.origin === network && method === 'POST' && (url.pathname === '/api/auth/register' || url.pathname === '/api/auth/login')) {
            const body = JSON.parse(init.body || '{}');
            const username = String(body.username || '');
            if (!username || !body.password) return reply(400, { error: 'Username and password required' });
            if (url.pathname === '/api/auth/register') {
                if (byName.has(username.toLowerCase())) return reply(409, { error: 'Username already taken' });
                const user = platform.addUser({ username });
                byName.set(username.toLowerCase(), user);
                return reply(201, { token: platform.signUserToken(user), user: { username, subject_id: user.subject_id } });
            }
            const user = byName.get(username.toLowerCase());
            return user ? reply(200, { token: platform.signUserToken(user) }) : reply(401, { error: 'Invalid credentials' });
        }
        return platform.fetch(input, init);
    };
}

/** → { result, platform, output }. platformOptions go to createMockPlatform (tests use them to break a step). */
async function runAgainstMock({ log, platformOptions = {} } = {}) {
    const platform = createMockPlatform(platformOptions);
    const lines = [];
    const result = await runDeveloperPath({
        network: PRODUCTION_NETWORK,
        fetch: withAccounts(platform),
        account: { username: 'developer_path', password: 'mock-password-not-checked', register: true },
        log: (m) => { lines.push(m); if (log) log(m); },
    });
    return { result, platform, output: lines.join('\n') };
}

module.exports = { runAgainstMock, withAccounts };

if (require.main === module) {
    // CI has no network: anything that is not the mock platform fails loudly.
    globalThis.fetch = () => { throw new Error('network access in the mock developer path'); };
    console.log('OpenVibe developer path against openvibe-sdk/testing\'s mock platform\n');
    runAgainstMock({ log: (m) => console.log(m) }).then(({ result }) => { process.exitCode = result.ok ? 0 : 1; }, (err) => { console.error(err); process.exitCode = 1; });
}
