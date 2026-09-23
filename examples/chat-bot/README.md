# Chat bot

A small bot that answers `?ping`, `?help` and `?about` in **one** chat room, and says it is a bot
every time it speaks.

```bash
node --env-file=.env bot.js
# [bot] HelperBot joined channel 42
```

## What it proves

Chat's WebSocket protocol (`/ws/chat`, as moved from Live into OpenVibe.Chat):

```text
-> { "type": "join", "token": "<hbt_…>", "channelUserId": 42 }       (or "streamId": 1234)
<- { "type": "auth", "authenticated": true, "username": "HelperBot", "core_username": "HelperBot", … }
-> { "type": "chat", "message": "[bot] pong" }                     posts into the joined room
<- { "type": "chat", "core_username": "ana", "message": "?ping", "channel_user_id": 42, "stream_id": null, … }
<- { "type": "system", "message": "Slow down! …" }
```

And the rules a well-behaved bot keeps:

- **One room.** It joins exactly the configured room (channel or stream), on every reconnect, and
  never sends another join. A socket can only post into the room it joined, and the bot only
  answers messages whose room matches its configuration; frames for other rooms or global chat
  are ignored even if they reach it.
- **Says it is a bot.** It refuses to run unless the account's name contains "bot", and every
  line starts with `OV_BOT_PREFIX` (`[bot] ` by default). Because of the prefix nothing it posts
  can start with `/` or `!`, so it can never run a chat command. `?about` says who runs it.
- **Never anonymous.** If the token is not accepted, the server treats the socket as a guest; the
  bot stops instead of chatting as one.
- **No loops, no floods.** It ignores itself and anything starting with the bot prefix, answers
  only known commands, keeps one line of at most 280 characters, paces replies
  (`OV_BOT_MIN_INTERVAL_MS`) and drops rather than queues more than five pending replies.
- **The token stays secret.** It goes in the join frame, never in the URL (URLs end up in access
  logs), and is never logged.

## Files

| File | What |
|---|---|
| `bot.js` | `loadConfig()`, `createBot()` (`start`, `stop`, `say`, `on('ready'|'stop')`), `COMMANDS` |
| `test/mock-chat-server.js` | a local `/ws/chat` that plays the frames above (the SDK mock has no Chat) |
| `test/smoke.test.js` | room isolation, bot labelling, loop and command safety, pacing, reconnect, refusals |

## Run the smoke test

```bash
npm test
```

Uses Node 22's built-in `WebSocket` for the bot; `ws` is a dev dependency for the mock server only.

## Run it against the real platform

1. Create a **dedicated account** for the bot whose username contains "bot" (for example
   `HelperBot`). Do not use your own account.
2. Signed in as that account on openvibe.live, create an API token with the `chat` scope
   (Dashboard → API Tokens, or `POST https://openvibe.live/api/auth/tokens`; see
   [API tokens](https://openvibe.live/docs/api-tokens)). It is shown once.
3. `cp .env.example .env`, set `OV_CHAT_TOKEN`, and **one** of `OV_CHAT_CHANNEL_USER_ID` (the
   streamer's user id: the channel room, live or offline) or `OV_CHAT_STREAM_ID`.
4. `node --env-file=.env bot.js`, then type `?ping` in that channel's chat.

Only use it in a channel whose streamer agreed to have it there; they can ban it like anyone else.

Limits today:

- **Not an app credential.** Chat has no bot or app principal: the bot signs in with a Live API
  token, which is a scoped credential of a person's account, not a Network developer-app token.
  `chat.message.send` is a `first-party` capability, so a developer app cannot be granted it.
- **No bot flag in the protocol.** The `[bot]` prefix and the account name are the only way the
  bot can identify itself; chat clients cannot mark bots differently yet.
- Chat is still served on `openvibe.live` (`openvibe.chat` has not launched). The Live API-token
  doc shows the token and stream in the URL query; this example uses the join frame instead.
