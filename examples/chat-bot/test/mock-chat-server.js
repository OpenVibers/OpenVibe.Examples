'use strict';
/**
 * A small local stand-in for OpenVibe.Chat's /ws/chat, for tests only (the SDK's mock platform has
 * no Chat). It plays the documented frames: join (token + channelUserId | streamId) -> auth;
 * chat -> broadcast to the sockets in the same room; system for slow mode. A socket posts only
 * into the room it joined, as on the real server.
 */
const http = require('node:http');
const { WebSocketServer } = require('ws');

function createMockChatServer({ tokens = {}, streams = {}, slowMs = 0 } = {}) {
    const server = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
    const wss = new WebSocketServer({ server, path: '/ws/chat' });
    const clients = new Map();                // ws -> { user, streamId, channelUserId, lastChatAt }
    const record = { joins: [], posts: [], urls: [] };

    const roomOf = (c) => `${c.streamId || 0}:${c.channelUserId || 0}`;
    const send = (ws, frame) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame)); };

    wss.on('connection', (ws, req) => {
        record.urls.push(req.url);
        clients.set(ws, { user: null, streamId: null, channelUserId: null, lastChatAt: 0 });
        ws.on('message', (data) => {
            let msg;
            try { msg = JSON.parse(String(data)); } catch { return; }
            const c = clients.get(ws);
            if (msg.type === 'join') {
                if (msg.token && tokens[msg.token]) c.user = tokens[msg.token];
                c.streamId = parseInt(msg.streamId, 10) || null;
                c.channelUserId = c.streamId ? (streams[c.streamId] || null) : (parseInt(msg.channelUserId, 10) || null);
                record.joins.push({ user: c.user && c.user.username, streamId: c.streamId, channelUserId: c.channelUserId });
                send(ws, { type: 'auth', authenticated: Boolean(c.user), username: c.user ? c.user.username : 'anon1234', core_username: c.user ? c.user.username : null, role: c.user ? 'user' : 'anon', user_id: c.user ? c.user.id : null });
                return;
            }
            if (msg.type === 'chat') {
                const text = String(msg.message || '').trim();
                if (!text) return;
                if (slowMs && Date.now() - c.lastChatAt < slowMs) return send(ws, { type: 'system', message: 'Slow down! You are sending messages too fast.' });
                c.lastChatAt = Date.now();
                const frame = {
                    type: 'chat', username: c.user ? c.user.username : 'anon1234', core_username: c.user ? c.user.username : null,
                    user_id: c.user ? c.user.id : null, message: text, stream_id: c.streamId, channel_user_id: c.channelUserId,
                    is_global: !c.streamId && !c.channelUserId, timestamp: new Date().toISOString(),
                };
                record.posts.push({ room: roomOf(c), username: frame.username, message: text });
                for (const [other, oc] of clients) if (roomOf(oc) === roomOf(c)) send(other, frame);
            }
            return undefined;
        });
        ws.on('close', () => clients.delete(ws));
    });

    return {
        record,
        async listen() {
            await new Promise((r) => server.listen(0, '127.0.0.1', r));
            return `ws://127.0.0.1:${server.address().port}/ws/chat`;
        },
        /** Send a raw frame to every socket (e.g. a frame for another room, to prove the bot ignores it). */
        pushToAll(frame) { for (const ws of clients.keys()) send(ws, frame); },
        /** Drop every connection (the bot must reconnect and rejoin its own room). */
        dropAll() { for (const ws of clients.keys()) ws.terminate(); },
        close: () => new Promise((r) => { for (const ws of clients.keys()) ws.terminate(); wss.close(); server.close(r); }),
    };
}

module.exports = { createMockChatServer };
