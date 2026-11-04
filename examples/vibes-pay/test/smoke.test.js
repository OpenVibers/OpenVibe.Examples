'use strict';
/**
 * Smoke test: the shop against a local Billing stand-in, never the network.
 *
 * The stand-in for openvibe-sdk/vibes speaks the same wire contract (charges.create POSTs with the
 * app token and the reference as Idempotency-Key) and verifies the same X-OpenVibe-Signature-V2, so
 * the example runs before openvibe-sdk v0.84.0 and openvibe-shared 4.111.0 are released. Once those
 * tags exist, package.json pins the SDK and the page loads the released shared/vibes-pay.js.
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { loadConfig, createShop } = require('../server');

globalThis.fetch = globalThis.fetch;   // the local stand-ins are the only network this test touches

const hmac = (secret, text) => crypto.createHmac('sha256', String(secret)).update(text).digest('hex');
const sign = (body, secret) => { const t = Math.floor(Date.now() / 1000); return `t=${t},v2=${hmac(secret, `${t}.${body}`)}`; };
function verifyWebhook(raw, header, secret) {
    const m = String(header || '').match(/^t=(\d{1,12}),v2=([0-9a-f]{64})$/i);
    if (!m) return false;
    const t = Number(m[1]);
    if (Math.abs(Date.now() / 1000 - t) > 300) return false;
    const expected = hmac(secret, `${t}.${Buffer.from(raw).toString('utf8')}`);
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(m[2].toLowerCase(), 'hex'));
}

function readBody(req) {
    return new Promise((resolve) => { const c = []; req.on('data', (x) => c.push(x)); req.on('end', () => resolve(Buffer.concat(c))); });
}
const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };

(async () => {
    assert.throws(() => loadConfig({}), /missing environment variables: OV_APP_TOKEN, OV_VIBES_WEBHOOK_SECRET/);
    assert.throws(() => loadConfig({ OV_APP_TOKEN: 'a', OV_VIBES_WEBHOOK_SECRET: 's', OV_PRICE_VIBES: '1.5' }), /positive whole number/);

    const billingCalls = [];
    const charges = new Map();
    const billing = http.createServer(async (req, res) => {
        const body = await readBody(req);
        if (req.method === 'POST' && req.url === '/api/v1/vibes/charges') {
            const input = JSON.parse(body.toString('utf8'));
            billingCalls.push({ url: req.url, authorization: req.headers.authorization, idempotency: req.headers['idempotency-key'], body: input });
            if (req.headers.authorization !== 'Bearer app-token') return json(res, 401, { code: 'token.missing' });
            if (!Number.isSafeInteger(input.amount) || input.amount <= 0) return json(res, 422, { code: 'billing.invalid_input' });
            const id = `vch_${String(charges.size + 1).padStart(26, '0')}`;
            charges.set(input.reference, { id, pay_url: `https://openvibe.network/pay/${id}`, status: 'pending' });
            return json(res, 201, charges.get(input.reference));
        }
        return json(res, 404, { code: 'not_found' });
    });
    await new Promise((r) => billing.listen(0, '127.0.0.1', r));
    const billingUrl = `http://127.0.0.1:${billing.address().port}`;

    // The SDK stand-in: the same calls over the wire, and the same webhook check.
    const vibes = {
        charges: {
            async create(input) {
                const res = await fetch(`${billingUrl}/api/v1/vibes/charges`, {
                    method: 'POST',
                    headers: { Authorization: 'Bearer app-token', 'Content-Type': 'application/json', 'Idempotency-Key': input.reference },
                    body: JSON.stringify(input),
                });
                if (!res.ok) throw new Error(`Billing ${res.status}`);
                return await res.json();
            },
        },
        webhooks: { verify: verifyWebhook },
    };

    const config = loadConfig({
        OV_APP_TOKEN: 'app-token',
        OV_VIBES_WEBHOOK_SECRET: 'whsec_test_not_real',
        OV_BILLING_URL: billingUrl,
        OV_PUBLIC_URL: 'http://127.0.0.1',
        OV_ITEM_NAME: 'Sticker pack: Neon cats',
        OV_PRICE_VIBES: '50',
    });
    const shop = createShop({ config, vibes });
    await new Promise((r) => shop.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${shop.address().port}`;
    config.publicUrl = base;

    try {
        // 1. The page: it loads vibes-pay.js and carries the auto-bound button with the charge's pay_url.
        const pageRes = await fetch(`${base}/`);
        assert.equal(pageRes.status, 200);
        const page = await pageRes.text();
        assert.match(page, /<script src="https:\/\/openvibe\.network\/shared\/vibes-pay\.js" defer><\/script>/);
        const payUrl = page.match(/<button[^>]*data-ov-vibes-pay="([^"]+)"/)[1];
        assert.match(payUrl, /^https:\/\/openvibe\.network\/pay\/vch_/);
        const reference = page.match(/<main data-order="([^"]+)"/)[1];
        assert.match(reference, /^order_/);

        // 2. The server created the charge with the SDK: the app token, whole Vibes, the order id, its return_url.
        assert.equal(billingCalls.length, 1);
        const call = billingCalls[0];
        assert.equal(call.authorization, 'Bearer app-token');
        assert.equal(call.idempotency, reference);
        assert.deepEqual(call.body, {
            amount: 50, description: 'Sticker pack: Neon cats', reference,
            return_url: `${base}/thanks?order=${reference}`,
        });

        const order = async (ref = reference) => (await (await fetch(`${base}/api/orders/${encodeURIComponent(ref)}`)).json());
        assert.equal((await order()).status, 'pending');

        // 3. A bad signature is refused and changes nothing.
        const event = JSON.stringify({ type: 'billing.vibes.charge.paid', data: { id: charges.get(reference).id, status: 'paid', reference } });
        const bad = await fetch(`${base}/webhooks/vibes`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-OpenVibe-Signature-V2': 't=1,v2=' + '0'.repeat(64) }, body: event });
        assert.equal(bad.status, 401);
        assert.equal((await order()).status, 'pending');

        // 4. The signed delivery marks the order paid; a replay says duplicate and changes nothing.
        const paid = await fetch(`${base}/webhooks/vibes`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-OpenVibe-Signature-V2': sign(event, 'whsec_test_not_real') }, body: event });
        assert.equal(paid.status, 200);
        assert.deepEqual(await paid.json(), { ok: true, reference, charge_id: charges.get(reference).id, status: 'paid', duplicate: false });
        assert.equal((await order()).status, 'paid');
        const replay = await fetch(`${base}/webhooks/vibes`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-OpenVibe-Signature-V2': sign(event, 'whsec_test_not_real') }, body: event });
        assert.equal(replay.status, 200);
        assert.equal((await replay.json()).duplicate, true);
        assert.equal((await order()).status, 'paid');

        // 5. A refund is its own signed event; the return page is served.
        const refunded = JSON.stringify({ type: 'billing.vibes.charge.refunded', data: { id: charges.get(reference).id, status: 'refunded', reference } });
        const refund = await fetch(`${base}/webhooks/vibes`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-OpenVibe-Signature-V2': sign(refunded, 'whsec_test_not_real') }, body: refunded });
        assert.equal(refund.status, 200);
        assert.equal((await order()).status, 'refunded');
        const thanks = await (await fetch(`${base}/thanks?order=${reference}`)).text();
        assert.match(thanks, /Back to the shop/);

        // 6. Another order is a different reference and a different charge; the shop creates no duplicate.
        const second = await (await fetch(`${base}/api/orders`, { method: 'POST' })).json();
        assert.notEqual(second.order.reference, reference);
        assert.equal(billingCalls.length, 2);
        assert.equal(billingCalls[1].idempotency, second.order.reference);

        console.log('vibes-pay example: ok');
    } finally {
        await new Promise((r) => shop.close(r));
        await new Promise((r) => billing.close(r));
    }
})().catch((err) => { console.error(err); process.exit(1); });
