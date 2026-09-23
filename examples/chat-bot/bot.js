#!/usr/bin/env node
'use strict';
/**
 * Chat bot: a small, clearly labelled bot that answers commands in ONE chat room.
 *
 *   node --env-file=.env bot.js
 *
 * Protocol (OpenVibe.Chat's /ws/chat, served on openvibe.live until openvibe.chat launches):
 *   -> { type: 'join', token, channelUserId }   or   { type: 'join', token, streamId }
 *   <- { type: 'auth', authenticated, username, core_username, role, user_id, ... }
 *   -> { type: 'chat', message }                 posts into the room this socket joined
 *   <- { type: 'chat', username, core_username, message, stream_id, channel_user_id, is_global, ... }
 *   <- { type: 'system', message }               slow mode, bans, ...
 *
 * Rules this bot keeps, whatever it receives:
 *   - It joins exactly the room in its configuration, on every (re)connect, and never another.
 *     A socket posts only into the room it joined, and the bot only answers messages whose room
 *     matches its configuration.
 *   - It identifies as a bot: it refuses to run unless the account's name says "bot", and every
 *     line it posts starts with OV_BOT_PREFIX (default "[bot] "), which also means nothing it
 *     posts can ever start with "/" or "!" and be run as a chat command.
 *   - It never runs anonymously: if the token is not accepted it stops instead of chatting as a guest.
 *   - It never answers itself or other bots (lines starting with the prefix), and it paces its
 *     replies (OV_BOT_MIN_INTERVAL_MS) below the server's slow mode.
 *   - The token is sent in the join frame, never in the URL, and never logged.
 *
 * Credentials: a Live API token (hbt_…, scope `chat`) created by a DEDICATED bot account on its
 * dashboard (see docs on openvibe.live/docs/api-tokens). Chat has no app-principal bot login yet.
 */

const COMMANDS = {
    ping: () => 'pong',
    help: (bot) => `commands: ${Object.keys(COMMANDS).map((c) => `${bot.config.trigger}${c}`).join(', ')}`,
    about: (bot) => `I am an automated bot${bot.config.owner ? ` run by ${bot.config.owner}` : ''}. I only talk in this room and only answer ${bot.config.trigger}commands.`,
};

function loadConfig(env = process.env) {
    const missing = ['OV_CHAT_TOKEN'].filter((k) => !env[k]);
    if (!env.OV_CHAT_CHANNEL_USER_ID === !env.OV_CHAT_STREAM_ID) missing.push('exactly one of OV_CHAT_CHANNEL_USER_ID / OV_CHAT_STREAM_ID');
    if (missing.length) throw Object.assign(new Error(`missing configuration: ${missing.join(', ')} (see .env.example)`), { code: 'config.missing' });
    const room = env.OV_CHAT_CHANNEL_USER_ID
        ? { kind: 'channel', id: Number(env.OV_CHAT_CHANNEL_USER_ID) }
        : { kind: 'stream', id: Number(env.OV_CHAT_STREAM_ID) };
    if (!Number.isInteger(room.id) || room.id <= 0) throw Object.assign(new Error('the room id must be a positive integer'), { code: 'config.invalid' });
    const prefix = env.OV_BOT_PREFIX === undefined ? '[bot] ' : env.OV_BOT_PREFIX;
    if (!prefix.trim() || /^[/!]/.test(prefix)) throw Object.assign(new Error('OV_BOT_PREFIX must be visible text and must not start with / or !'), { code: 'config.invalid' });
    const trigger = env.OV_BOT_TRIGGER || '?';
    if (/^[/!]/.test(trigger)) throw Object.assign(new Error('OV_BOT_TRIGGER must not start with / or ! (the server runs those as commands)'), { code: 'config.invalid' });
    return {
        wsUrl: env.OV_CHAT_WS_URL || 'wss://openvibe.live/ws/chat',
        token: env.OV_CHAT_TOKEN,
        room,
        prefix,
        trigger,
        owner: env.OV_BOT_OWNER || '',
        minIntervalMs: Number(env.OV_BOT_MIN_INTERVAL_MS || 2000),
        maxLength: 280,
    };
}

function createBot(config, { WebSocket = globalThis.WebSocket, log = console } = {}) {
    if (typeof WebSocket !== 'function') throw new TypeError('no WebSocket implementation (Node 22+ has one built in)');
    const joinFrame = Object.freeze(config.room.kind === 'channel'
        ? { type: 'join', token: config.token, channelUserId: config.room.id }
        : { type: 'join', token: config.token, streamId: config.room.id });
    const state = { ws: null, ready: false, me: null, stopped: false, failure: null, backoffMs: 1000, queue: [], lastSentAt: 0, timer: null };
    const listeners = { ready: [], stop: [] };
    const emit = (name, arg) => { for (const fn of listeners[name]) fn(arg); };

    /** Is this chat frame from the room the bot is configured for? */
    function inMyRoom(msg) {
        if (msg.is_global) return false;
        if (config.room.kind === 'stream') return Number(msg.stream_id) === config.room.id;
        return Number(msg.channel_user_id) === config.room.id;
    }

    /** One line, no control characters, labelled, bounded. */
    function format(text) {
        const clean = String(text).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
        const room = config.maxLength - config.prefix.length;
        return `${config.prefix}${clean.length > room ? `${clean.slice(0, room - 1)}…` : clean}`;
    }

    function flush() {
        clearTimeout(state.timer);
        state.timer = null;
        if (!state.queue.length || !state.ready || !state.ws || state.ws.readyState !== WebSocket.OPEN) return;
        const wait = state.lastSentAt + config.minIntervalMs - Date.now();
        if (wait > 0) { state.timer = setTimeout(flush, wait); return; }
        const line = state.queue.shift();
        state.ws.send(JSON.stringify({ type: 'chat', message: line }));
        state.lastSentAt = Date.now();
        if (state.queue.length) state.timer = setTimeout(flush, config.minIntervalMs);
    }

    /** Queue a line for the configured room. Refused unless signed in and joined. */
    function say(text) {
        if (!state.ready) throw Object.assign(new Error('not joined yet'), { code: 'bot.not_ready' });
        if (state.queue.length >= 5) return false;                 // never build a backlog to flood with later
        state.queue.push(format(text));
        flush();
        return true;
    }

    function onChat(msg) {
        if (!inMyRoom(msg)) return;
        const text = String(msg.message || '');
        if (msg.core_username && state.me && msg.core_username.toLowerCase() === state.me.toLowerCase()) return;
        if (text.startsWith(config.prefix.trim())) return;       // another bot: never answer bots
        if (!text.startsWith(config.trigger)) return;
        const name = text.slice(config.trigger.length).split(/\s+/)[0].toLowerCase();
        if (!Object.prototype.hasOwnProperty.call(COMMANDS, name)) return;
        say(COMMANDS[name](api, msg));
    }

    function stop(failure) {
        state.stopped = true;
        state.ready = false;
        state.failure = failure || null;
        clearTimeout(state.timer);
        if (state.ws) { try { state.ws.close(); } catch { /* closed */ } }
        emit('stop', failure || null);
    }

    function connect() {
        if (state.stopped) return;
        const ws = new WebSocket(config.wsUrl);
        state.ws = ws;
        ws.addEventListener('open', () => ws.send(JSON.stringify(joinFrame)));
        ws.addEventListener('message', (ev) => {
            let msg;
            try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8')); } catch { return; }
            if (msg.type === 'auth') {
                if (!msg.authenticated) {
                    log.error('[bot] the chat token was not accepted; a bot never posts anonymously, stopping');
                    return stop({ code: 'bot.not_authenticated' });
                }
                if (!/bot/i.test(`${msg.core_username || ''} ${msg.username || ''}`)) {
                    log.error(`[bot] "${msg.core_username}" does not say it is a bot; use a dedicated bot account, stopping`);
                    return stop({ code: 'bot.name_required' });
                }
                state.me = msg.core_username || msg.username;
                state.ready = true;
                state.backoffMs = 1000;
                log.log(`[bot] ${state.me} joined ${config.room.kind} ${config.room.id}`);
                emit('ready', { username: state.me });
                return flush();
            }
            if (msg.type === 'chat') return onChat(msg);
            if (msg.type === 'system' && msg.message) log.log(`[bot] system: ${msg.message}`);
            return undefined;
        });
        ws.addEventListener('close', () => {
            state.ready = false;
            if (state.stopped) return;
            const wait = state.backoffMs;
            state.backoffMs = Math.min(30000, state.backoffMs * 2);
            log.log(`[bot] disconnected; reconnecting in ${wait} ms`);
            setTimeout(connect, wait);
        });
        ws.addEventListener('error', () => { /* close follows */ });
    }

    const api = {
        config,
        start() { state.stopped = false; connect(); return api; },
        stop: () => stop(null),
        say,
        on(name, fn) { listeners[name].push(fn); return api; },
        get ready() { return state.ready; },
        get failure() { return state.failure; },
        get username() { return state.me; },
        _setBackoff(ms) { state.backoffMs = ms; },
    };
    return api;
}

if (require.main === module) {
    let config;
    try { config = loadConfig(); } catch (err) { console.error(err.message); process.exit(2); }
    const bot = createBot(config).start();
    bot.on('stop', (failure) => { if (failure) process.exitCode = 1; });
    const quit = () => { bot.stop(); setTimeout(() => process.exit(), 100); };
    process.on('SIGINT', quit);
    process.on('SIGTERM', quit);
}

module.exports = { loadConfig, createBot, COMMANDS };
