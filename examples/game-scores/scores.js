#!/usr/bin/env node
'use strict';
/**
 * Game scores: achievements and a leaderboard for your game on OpenVibe.Play, from your game's server.
 *
 *   node --env-file=.env scores.js           # register the title, post a round, unlock, read the board, delete it
 *   node --env-file=.env scores.js --keep    # keep the title (see it at play.openvibe.network/t/<id>)
 *
 *   1. App token for openvibe.play (client credentials, play.title.manage and play.result.write): the SDK's
 *      service-token client caches it and gets a new one before it expires.
 *   2. titles.define(): the game's achievements and boards. A sandbox app's title id starts with `sandbox-` (up to
 *      three, unlisted, guest players only); your production app registers the real name.
 *   3. scores.post() (idempotent by `ref`: a retry never counts twice) and achievements.unlock() (answers the new
 *      ones) for a player: a guest your game names (`guest:<opaque>`), or a person's `usr_…` id in production.
 *   4. boards.get(): the public leaderboard (rank, name, score, never a player id), readable by any page, no token.
 *   5. titles.remove(): a sandbox title goes with everything in it (a production title is never deleted).
 */
const crypto = require('node:crypto');
const { createClient } = require('openvibe-sdk/core');
const { createServiceTokenClient } = require('openvibe-sdk/auth');
const { createPlayClient } = require('openvibe-sdk/play');

const TITLE_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;

function loadConfig(env = process.env) {
    const missing = ['OV_CLIENT_ID', 'OV_CLIENT_SECRET'].filter((k) => !env[k]);
    if (missing.length) {
        throw Object.assign(new Error(`missing environment variables: ${missing.join(', ')} (see .env.example)`), { code: 'config.missing' });
    }
    const title = env.OV_PLAY_TITLE || `sandbox-gem-run-${crypto.randomBytes(3).toString('hex')}`;
    if (!TITLE_RE.test(title)) throw Object.assign(new Error('OV_PLAY_TITLE is 2 to 40 of a-z, 0-9 and - (a sandbox app\'s starts with sandbox-)'), { code: 'config.invalid' });
    return {
        network: env.OV_NETWORK_URL || 'https://openvibe.network',
        clientId: env.OV_CLIENT_ID,
        clientSecret: env.OV_CLIENT_SECRET,
        playUrl: env.OV_PLAY_URL || 'https://play.openvibe.network',
        title,
    };
}

function createGame(config, { fetch } = {}) {
    const tokens = createServiceTokenClient({
        network: config.network, clientId: config.clientId, clientSecret: config.clientSecret, fetch,
        scope: { 'openvibe.play': 'play.title.manage play.result.write' },
    });
    return createPlayClient(createClient({ network: config.network, fetch, tokenProvider: tokens, baseUrls: { play: config.playUrl } }), { baseUrl: config.playUrl });
}

/** The title's definition: two achievements (one secret) and a best-score board. */
const DEFINITION = {
    name: 'Gem Run', summary: 'Collect gems before the timer runs out.',
    achievements: [
        { id: 'first-gem', name: 'First Gem', description: 'Pick up a gem.' },
        { id: 'perfect-run', name: 'Perfect Run', description: 'Finish without missing a gem.', hidden: true },
    ],
    boards: [{ id: 'high-score', name: 'High score', kind: 'best' }],
};

/** One round, start to finish: define, post, unlock, read the board; then delete the title unless asked to keep it. */
async function playRound(play, config, { player = 'guest:example-player-1', name = 'Example player', score = 1200, ref = 'round-1', keep = false } = {}) {
    const defined = await play.titles.define(config.title, DEFINITION);
    const title = defined.title || defined;
    const posted = await play.scores.post(config.title, { board: 'high-score', ref, entries: [{ player, name, score }] });
    const again = await play.scores.post(config.title, { board: 'high-score', ref, entries: [{ player, name, score }] });
    const unlocked = await play.achievements.unlock(config.title, { player, achievements: ['first-gem'] });
    const board = await play.boards.get(config.title, 'high-score', { period: 'week' });
    if (!keep) await play.titles.remove(config.title);
    return { title, created: !!defined.created, posted, again, unlocked: unlocked.unlocked || [], board, removed: !keep };
}

async function main(argv = process.argv.slice(2)) {
    const config = loadConfig();
    const keep = argv.includes('--keep');
    const out = await playRound(createGame(config), config, { keep });
    console.log(`${out.created ? 'registered' : 'updated'} ${config.title}${out.title.sandbox ? ' (sandbox: unlisted, guests only)' : ''}`);
    console.log(`scores: recorded ${out.posted.recorded}; the same round again recorded ${out.again.recorded}`);
    console.log(`unlocked: ${out.unlocked.join(', ') || 'nothing new'}`);
    for (const e of out.board.entries) console.log(`  #${e.rank} ${e.name} ${e.score}`);
    console.log(out.removed ? 'deleted the title' : `kept: ${config.playUrl}/t/${config.title}`);
}

module.exports = { loadConfig, createGame, playRound, DEFINITION };

if (require.main === module) {
    main().catch((err) => { console.error(`game-scores: ${err.code ? `${err.code}: ` : ''}${err.message}`); process.exitCode = 1; });
}
