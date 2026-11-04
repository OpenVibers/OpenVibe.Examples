# Vibes Pay: a tiny sticker shop

Sell one thing for Vibes (MONEY.md, D12). The server creates the charge with `openvibe-sdk/vibes`; the page opens
OpenVibe's pay sheet with `openvibe-shared/vibes-pay.js`; a signed webhook marks the order paid. No card form is drawn
anywhere: the person pays Vibes they already have.

```bash
cp .env.example .env          # fill OV_APP_TOKEN and OV_VIBES_WEBHOOK_SECRET
npm start                     # http://localhost:8099
```

The app needs `billing.vibes.charge`; make a sandbox app in your project and grant it. Set its webhook URL to your
public `/webhooks/vibes` endpoint.

## What it proves

- **The charge is the server's.** `GET /` calls `vibes.charges.create({ amount, description, reference,
  return_url })` with the app token. `amount` is a whole number of Vibes, and the order id is the reference, so the
  SDK sends it as the idempotency key: a retried create is the same charge, never a second one. The app token never
  reaches the page.
- **The page uses `vibes-pay.js`.** `public/index.html` loads
  `https://openvibe.network/shared/vibes-pay.js` and has
  `<button data-ov-vibes-pay="{{pay_url}}">`; the button binds itself in the Vibes accent, opens the sheet (a popup
  on a computer, a full page on a phone), and the page listens for the `ov-vibes-pay` result as a hint to refresh.
- **The webhook is the confirmation.** `POST /webhooks/vibes` reads the raw body, verifies
  `X-OpenVibe-Signature-V2` with `vibes.webhooks.verify`, and marks the order paid once. A bad signature is 401 and
  changes nothing; a repeat delivery is `duplicate: true`. A refund event moves the order to `refunded`.
- **The page never decides money.** `GET /api/orders/:reference` is the server's own state; the return page
  (`/thanks?order=…`) reads it too.

The smoke test runs the shop against a local Billing stand-in and a stand-in for the two SDK calls, so it needs no
network, no released SDK and no real Vibes. It checks the create body and idempotency key, the page's button and
`vibes-pay.js`, a refused signature, a paid delivery, its replay, a refund and a second order.

## Run it against the real platform

1. Create a project and a **sandbox app** on <https://openvibe.services>, then grant the app
   `billing.vibes.charge`.
2. Put the app's token and its webhook secret in `.env` (`OV_APP_TOKEN`, `OV_VIBES_WEBHOOK_SECRET`); set
   `OV_PUBLIC_URL` to an HTTPS origin that reaches this server, because Billing posts the webhook there and the
   `return_url` is built from it.
3. `npm start`, open the shop, and pay with sandbox Vibes in the sheet.
4. Open `/api/orders/<reference>` (or watch the server log): the webhook marks it `paid`. Refund it from the app's
   server with `vibes.charges.refund(id)` and watch the refund event.

Sandbox charges use sandbox Vibes (test grants worth nothing) and never touch a person's real Vibes. Production Vibes
Pay opens when the owner enables Billing's `billing.vibes` settings; see openvibe.services `/docs/vibes` for the
plain-HTTP flow, signatures, limits and payouts.

## Pins left to bump

`package.json` pins the released SDK. The `openvibe-sdk/vibes` client and `openvibe-shared/vibes-pay.js` are not
released yet, so the smoke test stands in for both:

- `openvibe-sdk`: `v0.82.0` today → **v0.84.0** (`openvibe-sdk/vibes`) after that release.
- `openvibe-shared`: the page loads it from `https://openvibe.network/shared/vibes-pay.js`; the serving site's pin
  moves to **v4.111.0** after that release.

For local testing before the releases, these branch tarballs may be used **only in a comment or a local install**,
never in `package.json`:

```bash
# https://codeload.github.com/OpenVibers/OpenVibe.SDK/tar.gz/refs/heads/d12-sdk-vibes
# https://codeload.github.com/OpenVibers/OpenVibe.Shared/tar.gz/refs/heads/d12-shared-vibes
```
