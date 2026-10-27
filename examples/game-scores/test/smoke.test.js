'use strict';
/**
 * Smoke test: scores.js against a stand-in for Network's /oauth/token and OpenVibe.Play's API, answering in the shapes
 * Play's server/http/api.js answers (sandbox rules from Play#41/#42): the token asked for openvibe.play with the two
 * capabilities, a sandbox title registered, a round posted twice (counted once), an unlock, the public board read
 * without a token, the title deleted, and a real name refused from a sandbox app. No network.
 */
const assert = require('node:assert/strict');
const { loadConfig, createGame, playRound } = require('../scores');

globalThis.fetch = () => { throw new Error('network access in a smoke test'); };

const calls = [];
const titles = new Map();
const json = (status, o) => new Response(o === null ? null : JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
const problem = (status, code, detail) => new Response(JSON.stringify({ type: 'about:blank', title: code, status, code, detail }), { status, headers: { 'content-type': 'application/problem+json' } });

async function fakeFetch(url, init = {}) {
    const u = new URL(String(url));
    const method = (init.method || 'GET').toUpperCase();
    const auth = new Headers(init.headers).get('authorization');
    if (u.href === 'https://openvibe.network/oauth/token') {
        const form = new URLSearchParams(String(init.body));
        calls.push({ kind: 'token', audience: form.get('audience'), scope: form.get('scope') });
        return json(200, { access_token: 'app-token-1', token_type: 'Bearer', expires_in: 300, scope: form.get('scope') });
    }
    assert.equal(u.origin, 'https://play.openvibe.network');
    calls.push({ kind: 'play', method, path: u.pathname, auth });
    const m = u.pathname.match(/^\/api\/v1\/titles\/([a-z0-9-]+)(?:\/(scores|unlocks|boards\/([a-z0-9_-]+)))?$/);
    if (!m) return problem(404, 'route.not_found', 'no such route');
    const [, id, what, board] = m;
    const writing = method !== 'GET';
    if (writing && auth !== 'Bearer app-token-1') return problem(401, 'token.required', 'a token for openvibe.play');
    if (method === 'PUT' && !what) {
        if (!id.startsWith('sandbox-')) return problem(400, 'play.sandbox_title', 'a sandbox app\'s title id starts with sandbox- (the real name comes with a production app)');
        const created = !titles.has(id);
        const body = JSON.parse(init.body);
        titles.set(id, { id, name: body.name, sandbox: true, rounds: new Set(), scores: [], unlocked: new Set() });
        return json(created ? 201 : 200, { title: { id, name: body.name, sandbox: true, achievements: body.achievements, boards: body.boards }, created });
    }
    const t = titles.get(id);
    if (!t) return problem(404, 'play.unknown_title', 'no such title');
    if (method === 'DELETE' && !what) { titles.delete(id); return new Response(null, { status: 204 }); }
    if (what === 'scores') {
        const b = JSON.parse(init.body);
        if (b.entries.some((e) => !e.player.startsWith('guest:'))) return problem(400, 'play.sandbox_guests_only', 'a sandbox title\'s players are guests');
        if (t.rounds.has(b.ref)) return json(200, { recorded: 0, repeated: b.entries.length });
        t.rounds.add(b.ref);
        t.scores.push(...b.entries);
        return json(200, { recorded: b.entries.length, repeated: 0 });
    }
    if (what === 'unlocks') {
        const b = JSON.parse(init.body);
        const fresh = b.achievements.filter((a) => !t.unlocked.has(a));
        fresh.forEach((a) => t.unlocked.add(a));
        return json(200, { unlocked: fresh });
    }
    if (board) {
        const entries = [...t.scores].sort((a, b) => b.score - a.score).map((e, i) => ({ rank: i + 1, name: e.name, score: e.score, signed_in: false }));
        return json(200, { title: id, title_name: t.name, board, name: 'High score', kind: 'best', period: 'week', page: 1, pages: 1, total: entries.length, entries });
    }
    return problem(404, 'route.not_found', 'no such route');
}

(async () => {
    assert.throws(() => loadConfig({}), /OV_CLIENT_ID, OV_CLIENT_SECRET/);
    assert.throws(() => loadConfig({ OV_CLIENT_ID: 'a', OV_CLIENT_SECRET: 'b', OV_PLAY_TITLE: 'Not An Id' }), /OV_PLAY_TITLE/);
    const config = loadConfig({ OV_CLIENT_ID: 'app_01TEST', OV_CLIENT_SECRET: 'secret' });
    assert.match(config.title, /^sandbox-gem-run-[0-9a-f]{6}$/, 'a sandbox title by default');
    const play = createGame(config, { fetch: fakeFetch });

    const out = await playRound(play, config);
    assert.deepEqual(calls.filter((c) => c.kind === 'token').map((c) => [c.audience, c.scope]), [['openvibe.play', 'play.title.manage play.result.write']]);
    assert.equal(out.created, true);
    assert.equal(out.title.sandbox, true);
    assert.deepEqual([out.posted.recorded, out.again.recorded], [1, 0], 'the same round again counts once');
    assert.deepEqual(out.unlocked, ['first-gem']);
    assert.deepEqual(out.board.entries.map((e) => [e.rank, e.name, e.score]), [[1, 'Example player', 1200]]);
    assert.equal(calls.find((c) => c.kind === 'play' && c.path.endsWith('/boards/high-score')).auth, null, 'the board is a public read');
    assert.equal(out.removed, true);
    assert.equal(titles.size, 0, 'the sandbox title is gone');

    // --keep leaves it; a real name from a sandbox app is refused with Play's code.
    const kept = await playRound(play, config, { keep: true });
    assert.equal(kept.removed, false);
    assert.ok(titles.has(config.title));
    await assert.rejects(play.titles.define('gem-run', { name: 'Gem Run' }), (e) => e.status === 400 && e.code === 'play.sandbox_title');

    console.log('game-scores smoke: an openvibe.play token, a sandbox title, a round counted once, an unlock, the public board, the title deleted');
})().catch((err) => { console.error(err); process.exit(1); });
