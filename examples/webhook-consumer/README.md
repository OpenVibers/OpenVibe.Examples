# Webhook consumer

Receive OpenVibe.Events deliveries for your project's events over HTTPS, verify
`X-OpenVibe-Signature`, and handle every event **exactly once** even though delivery is at least once.

```bash
node --env-file=.env subscribe.js https://hooks.example.com/webhooks/openvibe      # app.<project_key>.*
node --env-file=.env --env-file=.env.webhook server.js                            # POST /webhooks/openvibe on :3003
```

## What it proves

- **An app subscription** (`events.app.subscribe`): `subscribe.js` creates it with
  `openvibe-sdk/events` `createAppEvents().subscriptions.create()`, whose topic pattern is relative
  to the project (default `*`, i.e. `app.<project_key>.*`). Events refuses `*`, `app.*` and other
  projects' keys
  (`403 events.topic_not_allowed`), and accepts only `https` endpoints that resolve to public
  addresses. `subscribe.js` generates the signing secret itself and writes it to `.env.webhook`
  (mode 0600); it never prints it.
- **Signature first, on the raw bytes.** `parseDelivery()` checks
  `sha256=<HMAC-SHA256 of the raw body>` in constant time before anything is parsed. A wrong
  secret, a changed byte or a missing header is `401`, with no detail.
- **Exactly once.** `createInbox(db).once(consumer, event_id, fn)` writes the receipt and runs your
  handler in one SQLite transaction. A redelivery (a retry after a lost `2xx`, a replay) is
  answered `200 { duplicate: true }` without running the handler. A handler that throws leaves
  no receipt, the consumer answers `500`, and Events retries with backoff.
- **The signed body is the truth.** `X-OpenVibe-Event-Id` must match the body's `event_id`.
- **Secret rotation** without downtime: `OV_WEBHOOK_SECRET_PREVIOUS` is accepted while it is set.

## Files

| File | What |
|---|---|
| `server.js` | `createConsumer()`: the HTTP endpoint, signature check, inbox, `received_events` table |
| `subscribe.js` | `createSubscription()`: create the Events subscription with an app token |
| `test/smoke.test.js` | subscription and its topic/endpoint rules, then deliveries from the mock's delivery worker |

## Run the smoke test

```bash
npm test
```

Deliveries come from `openvibe-sdk/testing`'s delivery worker (`deliverEvents()`): signed POSTs
with Events' headers, in order, retried on a non-2xx. The test routes the subscription's https
endpoint to the consumer on a local port. Wrong-secret, tampered and forged deliveries are made by
hand. The mock plays Events' developer-app rules (capability, own-project topics, public https
endpoints: a private address is `422 events.endpoint_not_allowed`).

## Run it against the real platform

1. Create a project and a **confidential** sandbox app with `events.app.subscribe` (and
   `events.app.publish` if you want to send yourself events with
   [event-subscriber](../event-subscriber)'s `publish.js`); see the
   [walkthrough](../../README.md#end-to-end-walkthrough).
2. Run `server.js` somewhere Events can reach over **https** with a public address (a VPS behind a
   TLS proxy, or a tunnel). `localhost`, private and link-local addresses are refused, when you
   subscribe and again on every delivery, and redirects are not followed.
3. `cp .env.example .env`, fill in `OV_CLIENT_ID` and `OV_CLIENT_SECRET`, then
   `node --env-file=.env subscribe.js https://<your host>/webhooks/openvibe`.
4. Start the consumer with `--env-file=.env --env-file=.env.webhook` and publish an event
   (`node --env-file=.env ../event-subscriber/publish.js`).

Limits: a sandbox project may have 5 subscriptions. Sandbox subscriptions receive sandbox events
only. When the app is revoked or loses `events.app.subscribe`, Events disables its subscriptions.

Signature scheme note: the HMAC covers the body only, with no timestamp, so a captured delivery
can be replayed later. The inbox makes a replay harmless (it is a duplicate), which is why the
inbox is not optional.
