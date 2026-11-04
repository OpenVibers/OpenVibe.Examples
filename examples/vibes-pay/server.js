#!/usr/bin/env node
'use strict';
/**
 * Vibes Pay: a tiny Node shop that sells one sticker pack for whole Vibes (MONEY.md, D12).
 *
 *   1. GET / creates an order and a charge with openvibe-sdk/vibes (the app token, capability
 *      billing.vibes.charge; the order id is the reference, so a retry is the same charge);
 *   2. the page opens the pay sheet with openvibe-shared/vibes-pay.js (OpenVibe.vibes.pay, or the
 *      auto-bound [data-ov-vibes-pay] button);
 *   3. Billing posts billing.vibes.charge.paid to /webhooks/vibes; the server verifies the raw body
 *      with the SDK and marks the order paid, once.
 *
 * The app token and the webhook secret stay here, never in the page. Run it with:
 *
 *   npm start                         # reads .env (node --env-file-if-exists)
 *   node server.js
 *
 * This example only uses public surfaces: Billing's /api/v1/vibes routes and the SDK. The smoke test
 * runs the same shop against a local Billing stand-in, never the network.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const PUBLIC = path.join(__dirname, 'public');
const INDEX = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
const THANKS = fs.readFileSync(path.join(PUBLIC, 'thanks.html'), 'utf8');
const CSS = fs.readFileSync(path.join(PUBLIC, 'shop.css'), 'utf8');
const MAX_BODY = 64 * 1024;

function loadConfig(env = process.env) {
    const missing = ['OV_APP_TOKEN', 'OV_VIBES_WEBHOOK_SECRET'].filter((k) => !env[k]);
    if (missing.length) {
        throw Object.assign(new Error(`missing environment variables: ${missing.join(', ')} (see .env.example)`), { code: 'config.missing' });
    }
    const port = Number(env.OV_PORT || 8099);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('OV_PORT is a port number');
    const price = Number(env.OV_PRICE_VIBES || 50);
    if (!Number.isSafeInteger(price) || price <= 0) throw new Error('OV_PRICE_VIBES is a positive whole number of Vibes');
    const publicUrl = String(env.OV_PUBLIC_URL || `http://localhost:${port}`).replace(/\/+$/, '');
    let parsed;
    try { parsed = new URL(publicUrl); } catch { throw new Error('OV_PUBLIC_URL is an http(s) URL'); }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('OV_PUBLIC_URL is an http(s) URL');
    return {
        port,
        publicUrl,
        billingUrl: String(env.OV_BILLING_URL || 'https://billing.openvibe.network').replace(/\/+$/, ''),
        appToken: env.OV_APP_TOKEN,
        webhookSecret: env.OV_VIBES_WEBHOOK_SECRET,
        item: env.OV_ITEM_NAME || 'Sticker pack: Neon cats',
        price,
    };
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function render(template, vars) {
    return template.replace(/\{\{(\w+)\}\}/g, (_, key) => (key in vars ? escapeHtml(vars[key]) : ''));
}

function readBody(req, limit = MAX_BODY) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > limit) {
                const err = new Error('body too large');
                err.status = 413;
                reject(err);
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
    const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(payload);
}

/**
 * Build the shop. `vibes` is the openvibe-sdk/vibes client in production and a stand-in in the smoke
 * test; it must have charges.create/get/refund and webhooks.verify.
 */
function createShop({ config, vibes, logger = console, now = Date.now }) {
    if (!config || !vibes) throw new TypeError('createShop: config and vibes are required');
    if (!vibes.charges || typeof vibes.charges.create !== 'function') throw new TypeError('createShop: vibes.charges.create is required');
    if (!vibes.webhooks || typeof vibes.webhooks.verify !== 'function') throw new TypeError('createShop: vibes.webhooks.verify is required');
    const orders = new Map();
    const byCharge = new Map();

    function reference() {
        return `order_${now().toString(36)}_${crypto.randomBytes(5).toString('hex')}`;
    }

    async function createOrder() {
        const ref = reference();
        const order = {
            reference: ref,
            charge_id: null,
            pay_url: null,
            amount: config.price,
            item: config.item,
            status: 'creating',
            created_at: new Date(now()).toISOString(),
            paid_at: null,
        };
        orders.set(ref, order);
        try {
            const charge = await vibes.charges.create({
                amount: config.price,
                description: config.item,
                reference: ref,
                return_url: `${config.publicUrl}/thanks?order=${encodeURIComponent(ref)}`,
            });
            if (!charge || !charge.id || !charge.pay_url) throw new Error('Billing answered no charge id or pay_url');
            order.charge_id = charge.id;
            order.pay_url = charge.pay_url;
            order.status = charge.status || 'pending';
            byCharge.set(charge.id, order);
            return order;
        } catch (err) {
            orders.delete(ref);
            throw err;
        }
    }

    /** Apply a verified webhook payload. The same delivery may arrive twice; the order changes once. */
    function applyEvent(event) {
        const type = String((event && event.type) || '');
        const data = event && event.data && typeof event.data === 'object' ? event.data : (event || {});
        const charge = data.charge && typeof data.charge === 'object' ? data.charge : data;
        const chargeId = String(charge.id || data.charge_id || data.id || '');
        const ref = String(charge.reference || data.reference || '');
        const status = String(charge.status || data.status || (type === 'billing.vibes.charge.paid' ? 'paid'
            : type === 'billing.vibes.charge.refunded' ? 'refunded' : ''));
        const order = (ref && orders.get(ref)) || (chargeId && byCharge.get(chargeId));
        if (!order) return { ok: false, reason: 'unknown_order', charge_id: chargeId || null, reference: ref || null };
        const was = order.status;
        if (status === 'paid') {
            if (order.status !== 'paid') { order.status = 'paid'; order.paid_at = new Date(now()).toISOString(); }
        } else if (status === 'refunded') {
            order.status = 'refunded';
        } else if ((status === 'cancelled' || status === 'expired') && order.status === 'pending') {
            order.status = status;
        }
        return { ok: true, reference: order.reference, charge_id: order.charge_id, status: order.status, duplicate: was === 'paid' && order.status === 'paid' };
    }

    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, config.publicUrl);
        try {
            if (req.method === 'GET' && url.pathname === '/') {
                const order = await createOrder();
                const html = render(INDEX, { item: config.item, price: config.price, pay_url: order.pay_url, reference: order.reference });
                return send(res, 200, html, 'text/html; charset=utf-8');
            }
            if (req.method === 'GET' && url.pathname === '/thanks') {
                return send(res, 200, THANKS, 'text/html; charset=utf-8');
            }
            if (req.method === 'GET' && url.pathname === '/shop.css') {
                return send(res, 200, CSS, 'text/css; charset=utf-8');
            }
            if (req.method === 'POST' && url.pathname === '/api/orders') {
                const order = await createOrder();
                return send(res, 201, { order });
            }
            if (req.method === 'GET' && url.pathname.startsWith('/api/orders/')) {
                const ref = decodeURIComponent(url.pathname.slice('/api/orders/'.length));
                const order = orders.get(ref);
                if (!order) return send(res, 404, { ok: false, error: 'unknown_order' });
                return send(res, 200, { reference: order.reference, charge_id: order.charge_id, status: order.status, amount: order.amount, paid_at: order.paid_at });
            }
            if (req.method === 'POST' && url.pathname === '/webhooks/vibes') {
                const raw = await readBody(req);
                const signature = req.headers['x-openvibe-signature-v2'] || req.headers['x-openvibe-signature'] || '';
                if (!vibes.webhooks.verify(raw, signature, config.webhookSecret)) {
                    return send(res, 401, { ok: false, error: 'bad_signature' });
                }
                let event;
                try { event = JSON.parse(raw.toString('utf8')); } catch { return send(res, 400, { ok: false, error: 'bad_json' }); }
                const out = applyEvent(event);
                // 2xx ends the retries; an unknown order is not an error (another deploy may own it).
                return send(res, 200, out);
            }
            if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true });
            return send(res, 404, { ok: false, error: 'not_found' });
        } catch (err) {
            logger.error && logger.error('[vibes-pay]', err && err.message ? err.message : err);
            return send(res, err && err.status === 413 ? 413 : 502, { ok: false, error: err && err.status === 413 ? 'body_too_large' : 'shop_unavailable' });
        }
    });
    server.orders = orders;
    server.createOrder = createOrder;
    server.applyEvent = applyEvent;
    return server;
}

/** The production wiring: the real SDK, the real Billing. */
async function main(env = process.env) {
    const config = loadConfig(env);
    const { createVibesClient } = require('openvibe-sdk/vibes');
    const vibes = createVibesClient({ appToken: config.appToken, billingUrl: config.billingUrl });
    const server = createShop({ config, vibes });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, '127.0.0.1', resolve);
    });
    console.log(`Vibes Pay shop: ${config.item} for ${config.price} Vibes at ${config.publicUrl}`);
    console.log('Webhook endpoint: POST /webhooks/vibes (X-OpenVibe-Signature-V2)');
    return { server, config };
}

if (require.main === module) {
    main().catch((err) => { console.error(`vibes-pay: ${err.message}`); process.exitCode = 1; });
}

module.exports = { loadConfig, createShop, main };
