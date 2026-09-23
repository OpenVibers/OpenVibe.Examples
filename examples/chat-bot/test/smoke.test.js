'use strict';
/** Smoke test: the bot against the local /ws/chat mock (the SDK's mock platform has no Chat). */
const assert = require('node:assert/strict');
const { createMockChatServer } = require('./mock-chat-server');
const { createBot, loadConfig } = require('../bot');

globalThis.fetch = () => { throw new Error('network access in a smoke test'); };

const BOT_TOKEN = 'hbt_helperbot_test_token_value';
const quiet = () => { const lines = []; return { lines, log: (m) => lines.push(m), error: (m) => lines.push(m) }; };

async function waitFor(check, what, ms = 3000) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
        if (check()) return;
        await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`timed out waiting for ${what}`);
}

/** A person in a room, over the same protocol. */
async function person(url, token, room) {
    const ws = new WebSocket(url);
    const seen = [];
    ws.addEventListener('message', (ev) => seen.push(JSON.parse(ev.data)));
    await new Promise((r) => ws.addEventListener('open', r));
    ws.send(JSON.stringify({ type: 'join', token, ...room }));
    await waitFor(() => seen.some((m) => m.type === 'auth'), 'the join');
    return { say: (message) => ws.send(JSON.stringify({ type: 'chat', message })), seen, close: () => ws.close() };
}

(async () => {
    const chat = createMockChatServer({
        tokens: {
            [BOT_TOKEN]: { id: 99, username: 'HelperBot' },
            hbt_other_bot: { id: 98, username: 'OtherBot' },
            hbt_ana: { id: 1, username: 'ana' },
            hbt_bo: { id: 2, username: 'bo' },
        },
        streams: { 555: 7 },
    });
    const url = await chat.listen();
    const env = { OV_CHAT_WS_URL: url, OV_CHAT_TOKEN: BOT_TOKEN, OV_CHAT_CHANNEL_USER_ID: '7', OV_BOT_MIN_INTERVAL_MS: '40', OV_BOT_OWNER: 'example.dev' };
    const out = quiet();
    const bot = createBot(loadConfig(env), { log: out }).start();
    await waitFor(() => bot.ready, 'the bot to join');
    assert.equal(bot.username, 'HelperBot');

    const ana = await person(url, 'hbt_ana', { channelUserId: 7 });
    const bo = await person(url, 'hbt_bo', { channelUserId: 8 });
    const botPosts = () => chat.record.posts.filter((p) => p.username === 'HelperBot');

    // 1. A command in its room is answered there, labelled as a bot.
    ana.say('?ping');
    await waitFor(() => botPosts().length === 1, 'the pong');
    assert.deepEqual(botPosts()[0], { room: '0:7', username: 'HelperBot', message: '[bot] pong' });

    // 2. The same command in another room is not answered, and the bot never posts there.
    bo.say('?ping');
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(botPosts().length, 1);
    assert.ok(chat.record.posts.filter((p) => p.room === '0:8').every((p) => p.username === 'bo'));

    // 3. A frame about another room delivered to the bot's socket anyway: ignored.
    chat.pushToAll({ type: 'chat', username: 'mallory', core_username: 'mallory', message: '?ping', channel_user_id: 8, stream_id: null, is_global: false });
    chat.pushToAll({ type: 'chat', username: 'mallory', core_username: 'mallory', message: '?ping', channel_user_id: null, stream_id: null, is_global: true });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(botPosts().length, 1);

    // 4. It never answers itself or another bot, and ignores unknown commands and ! / commands.
    const other = await person(url, 'hbt_other_bot', { channelUserId: 7 });
    other.say('[bot] ?ping');
    ana.say('?nope');
    ana.say('!ping');
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(botPosts().length, 1);

    // 5. help / about identify it; replies are paced but not dropped.
    ana.say('?help');
    await new Promise((r) => setTimeout(r, 5));
    ana.say('?about');
    await waitFor(() => botPosts().length === 3, 'help and about');
    assert.equal(botPosts()[1].message, '[bot] commands: ?ping, ?help, ?about');
    assert.equal(botPosts()[2].message, '[bot] I am an automated bot run by example.dev. I only talk in this room and only answer ?commands.');

    // 6. say() is one line, labelled, bounded; a leading "/" can never become a command.
    bot.say('/ban bo\nnow');
    await waitFor(() => botPosts().length === 4, 'the formatted line');
    assert.equal(botPosts()[3].message, '[bot] /ban bo now');
    bot.say('x'.repeat(500));
    await waitFor(() => botPosts().length === 5, 'the long line');
    assert.equal(botPosts()[4].message.length, 280);

    // 7. Dropped connection: it reconnects and rejoins ITS room only.
    bot._setBackoff(20);
    chat.dropAll();
    await waitFor(() => !bot.ready, 'the drop');
    await waitFor(() => bot.ready, 'the reconnect');
    const ana2 = await person(url, 'hbt_ana', { channelUserId: 7 });
    ana2.say('?ping');
    await waitFor(() => botPosts().length === 6, 'the pong after reconnect');
    const botJoins = chat.record.joins.filter((j) => j.user === 'HelperBot');
    assert.ok(botJoins.length >= 2);
    assert.ok(botJoins.every((j) => j.channelUserId === 7 && j.streamId === null), 'every join is the configured room');

    // 8. The token never appears in a URL or a log line.
    assert.ok(chat.record.urls.every((u) => !u.includes(BOT_TOKEN) && !u.includes('token')));
    assert.ok(!out.lines.join('\n').includes(BOT_TOKEN));
    bot.stop();

    // 9. Stream rooms: configured by stream id, answers only that stream's messages.
    const streamBot = createBot(loadConfig({ ...env, OV_CHAT_CHANNEL_USER_ID: '', OV_CHAT_STREAM_ID: '555' }), { log: quiet() }).start();
    await waitFor(() => streamBot.ready, 'the stream bot');
    const viewer = await person(url, 'hbt_ana', { streamId: 555 });
    const before = botPosts().length;
    viewer.say('?ping');
    await waitFor(() => botPosts().length === before + 1, 'the stream pong');
    assert.equal(botPosts()[before].room, '555:7');
    streamBot.stop();

    // 10. A token that is not accepted: the bot stops instead of chatting anonymously.
    const anon = createBot(loadConfig({ ...env, OV_CHAT_TOKEN: 'hbt_revoked' }), { log: quiet() });
    const stopped = new Promise((r) => anon.on('stop', r));
    anon.start();
    assert.deepEqual(await stopped, { code: 'bot.not_authenticated' });

    // 11. An account whose name does not say "bot": refused.
    const person1 = createBot(loadConfig({ ...env, OV_CHAT_TOKEN: 'hbt_ana' }), { log: quiet() });
    const refused = new Promise((r) => person1.on('stop', r));
    person1.start();
    assert.deepEqual(await refused, { code: 'bot.name_required' });

    // 12. Configuration guards.
    assert.throws(() => loadConfig({ OV_CHAT_TOKEN: 't' }), /exactly one/);
    assert.throws(() => loadConfig({ OV_CHAT_TOKEN: 't', OV_CHAT_CHANNEL_USER_ID: '7', OV_CHAT_STREAM_ID: '5' }), /exactly one/);
    assert.throws(() => loadConfig({ ...env, OV_BOT_PREFIX: '' }), /prefix/i);
    assert.throws(() => loadConfig({ ...env, OV_BOT_PREFIX: '/me ' }), /prefix/i);
    assert.throws(() => loadConfig({ ...env, OV_BOT_TRIGGER: '!' }), /trigger/i);

    for (const p of [ana, bo, other, ana2, viewer]) p.close();
    await chat.close();
    console.log('chat-bot: ok');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
