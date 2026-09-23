# Event subscriber

Follow OpenVibe.Events topics without losing or double-handling events, across dropped
connections, restarts and retention gaps. As a developer app, the topic you own is your project's
`app.<project_key>.*`.

```bash
node --env-file=.env publish.js order.created '{"total":3}'      # something to receive (events.app.publish)
node --env-file=.env subscriber.js                                # pull your project's topic (events.app.read)
OV_EVENTS_MODE=realtime OV_TOPICS=chat.message.created node subscriber.js   # public first-party events, no credentials
```

## What it proves

- **Your own topic.** A developer app publishes and reads `app.<project_key>.<name…>`, where
  `project_key` is `p` followed by the project's ULID in lowercase (`prj_01JAB…` → `p01jab…`), and
  its events carry `source: app-<app ULID in lowercase>` and `actor: { type: 'app', id: <app id> }`.
  `openvibe-sdk/events` `createAppEvents({ projectId, appId })` fills all of that in: event types
  and topic patterns are written relative to the project (`order.created`, `order.*`, `*`), and
  `publish()` adds `event_id`, `timestamp`, `version` and `trace_id` (a repeated `event_id` is
  answered as a duplicate, so retries are safe). Another project's `app.*` topic is refused by the
  SDK before anything is sent (and by Events with `403 events.topic_not_allowed`).
  `OV_PLATFORM_TOPICS` adds public first-party topics (`live.stream.*`) to a pull.
- **Pull** (`openvibe-sdk/events` `iterate()`): pages from the saved cursor to the head. The
  cursor is saved after each handled event, and moved past non-matching events (the page's
  `next_after_seq`) in `onPage`, which the SDK calls only after every item of that page was
  handled. A handler that throws leaves the cursor on the last event that succeeded, so the failed
  event is retried next time.
- **Gaps**: when Events can no longer supply part of the range (retention pruned it: sandbox app
  events are kept 7 days; or a restored cursor is ahead of the stream), `onResync(gap)` is called.
  Nothing can replay the missing events, so reload whatever state you derive from them.
- **Realtime** (`openvibe-sdk/realtime` `subscribe()`): SSE from `/realtime/stream`,
  anonymously, for public first-party events. It resumes from the saved cursor with
  `Last-Event-ID`, and nothing is delivered twice. The app token is never sent on it.
- The cursor file is replaced atomically (write + rename).

## Files

| File | What |
|---|---|
| `subscriber.js` | `createSubscriber()` (`start()`, `stop()`, `pullOnce()`, `resolveTopics()`), `createCursorStore()` |
| `publish.js` | `publishAppEvent()`: one event on your project's topic |
| `test/smoke.test.js` | publish, pull with cursor and failure, pull gap after pruning, platform topics, topic scope, anonymous realtime, reconnect, restart, cursor-ahead gap |

## Run the smoke test

```bash
npm test
```

Network and Events are `openvibe-sdk/testing`'s mock platform, which plays Events'
developer-app rules (`events.app.*` capabilities, the `app.<project_key>.` prefix, the
`app-<ULID>` source, own-project and own-environment reads, no app events on realtime);
retention gaps come from its `pruneEvents()`.

## Run it against the real platform

1. Create a project and a **confidential** sandbox app with `events.app.publish` and
   `events.app.read` ([walkthrough](../../README.md#end-to-end-walkthrough)).
2. `cp .env.example .env`, fill in `OV_CLIENT_ID` and `OV_CLIENT_SECRET` (`OV_PROJECT_ID` is
   optional: it is read from the app token).
3. `node --env-file=.env publish.js`, then `node --env-file=.env subscriber.js`. The subscriber
   prints `pulling app.<project_key>.* every 5000 ms` and each event it handles.

Things to know:

- Pull goes to `https://events.openvibe.network/api/v1/events` (the origin comes from the registry).
  You see your project's events in your app's environment only: a sandbox app never sees production
  events and the other way round. A first-party pattern in `OV_PLATFORM_TOPICS`, such as
  `live.stream.*`, returns only that namespace's `public` events.
- Realtime never streams `app.*` events, to anyone; use pull (or a webhook, see
  [webhook-consumer](../webhook-consumer)) for your own events. Anonymous realtime shows public
  first-party events only; which ones arrive depends on which producers publish public events.
- Events limits a sandbox project to 30 published events per minute and 5 MiB of retained events.
