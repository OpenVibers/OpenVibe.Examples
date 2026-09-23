# Webhook consumer

Receive OpenVibe.Events deliveries over HTTPS, verify `X-OpenVibe-Signature`, and handle every
event **exactly once** even though delivery is at least once.

```bash
node --env-file=.env subscribe.js 'media.object.*' https://hooks.example.com/webhooks/openvibe
node --env-file=.env --env-file=.env.webhook server.js     # POST /webhooks/openvibe on :3003
```

## What it proves

- **Signature first, on the raw bytes.** `openvibe-sdk/events` `parseDelivery()` checks
  `sha256=<HMAC-SHA256 of the raw body>` in constant time before anything is parsed. A wrong
  secret, a changed byte or a missing header is `401`, with no detail.
- **Exactly once.** `createInbox(db).once(consumer, event_id, fn)` writes the receipt and runs your
  handler in one SQLite transaction. A redelivery (a retry after a lost `2xx`, a replay) is
  answered `200 { duplicate: true }` without running the handler. A handler that throws leaves
  no receipt, the consumer answers `500`, and Events retries with backoff.
- **The signed body is the truth.** `X-OpenVibe-Event-Id` must match the body's `event_id`.
- **Secret rotation** without downtime: `OV_WEBHOOK_SECRET_PREVIOUS` is accepted while it is set.
- `subscribe.js` creates the subscription with `events.subscriptions.create()`. It generates the
  signing secret itself and writes it to `.env.webhook` (mode 0600); it never prints it.

## Files

| File | What |
|---|---|
| `server.js` | `createConsumer()`: the HTTP endpoint, signature check, inbox, `received_events` table |
| `subscribe.js` | `createSubscription()`: create the Events subscription with an app token |
| `test/smoke.test.js` | subscription via the SDK mock, then deliveries signed and shaped exactly like the Events delivery worker's |

## Run the smoke test

```bash
npm test
```

The SDK's mock platform stores subscriptions but has no delivery worker, so the test plays the
worker: it signs each body with `signDelivery()` and sends the same headers Events sends
(`X-OpenVibe-Event-Id`, `-Event-Type`, `-Seq`, `-Subscription-Id`, `-Delivery-Attempt`, `-Signature`).

## Run it against the real platform

**This cannot be demonstrated against the real platform yet.** The consumer side is ready, but a
developer app cannot create a subscription:

- `events.subscription.manage` (and every other `events.*` capability) has visibility `internal`
  in openvibe-contracts, so Network never grants it to an app.
- OpenVibe.Events' public host exposes only `/realtime/stream` and health; its subscription API
  is reachable from the platform's own hosts only.
- The Events delivery worker only POSTs to endpoint hosts on its allow-list.

When those change, the steps are: an app with `events.subscription.manage`, `cp .env.example .env`,
`node --env-file=.env subscribe.js '<topic pattern>' https://<your host>/webhooks/openvibe`, then run
`server.js` behind HTTPS with `--env-file=.env.webhook`.

Signature scheme note: the HMAC covers the body only, with no timestamp, so a captured delivery
can be replayed later. The inbox makes a replay harmless (it is a duplicate), which is why the
inbox is not optional.
