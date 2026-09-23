# Event subscriber

Follow OpenVibe.Events topics without losing or double-handling events, across dropped
connections, restarts and retention gaps.

```bash
OV_TOPICS='chat.message.created' node --env-file=.env subscriber.js              # realtime, no credentials
OV_EVENTS_MODE=pull node --env-file=.env subscriber.js                           # pull, needs events.event.read
```

## What it proves

- **Realtime** (`openvibe-sdk/realtime` `subscribe()`): SSE from `/realtime/stream`. Without
  credentials you receive `public` events only; `internal` events never reach you. After a
  dropped connection or a restart it resumes from the saved cursor with `Last-Event-ID`, and
  nothing is delivered twice.
- **Pull** (`openvibe-sdk/events` `iterate()`): pages from the saved cursor to the head. The
  cursor is saved after each handled event, and moved past non-matching events (the page's
  `next_after_seq`) only once every item of that page is handled. A handler that throws leaves
  the cursor on the last event that succeeded, so the failed event is retried next time.
- **Gaps**: when Events can no longer supply part of the range (retention pruned it, or a restored
  cursor is ahead of the stream), `onResync(gap)` is called. Nothing can replay the missing events,
  so reload whatever state you derive from them from its source of truth.
- The cursor file is replaced atomically (write + rename).

## Files

| File | What |
|---|---|
| `subscriber.js` | `createSubscriber()` (`start()`, `stop()`, `pullOnce()`), `createCursorStore()` |
| `test/smoke.test.js` | pull with cursor and failure, pull gap, anonymous realtime, reconnect, restart, cursor-ahead gap |

## Run the smoke test

```bash
npm test
```

The SDK mock never prunes events, so the pull-gap case wraps the mock's `fetch` to add the `gap`
field Events returns after pruning. Realtime gaps come from the mock itself (`cursor_ahead`).

## Run it against the real platform

- **Realtime works without an app**: `cp .env.example .env`, keep `OV_EVENTS_MODE=realtime`, set
  `OV_TOPICS`, run `node --env-file=.env subscriber.js`. The stream is
  `https://events.openvibe.network/realtime/stream` (from the registry). You will only see
  events that a producer publishes with visibility `public` on those topics. Chat's
  `chat.message.created` is public, but Chat has not been cut over yet, so whether anything
  arrives depends on which producers are live.
- **Pull cannot be demonstrated yet.** `events.event.read` is an `internal` capability (never
  granted to apps), and the pull API (`/api/v1/events`, checkpoints) is not exposed on Events'
  public host. Checkpoints stored in Events are therefore not used here: the cursor is a local file.
