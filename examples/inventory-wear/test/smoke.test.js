'use strict';
/**
 * Smoke test: wear.js against a stand-in for OpenVibe.Inventory's public reads (the shapes server/http/api.js answers,
 * sampled from production on 2026-10-22): no token sent, the catalog read once per kind, equipped sets fetched 100
 * people per call, a look built from the slots (a retired definition shows nothing), and the line and HTML rendered
 * with names escaped. No network.
 */
const assert = require('node:assert/strict');
const { loadConfig, createInventory, loadCatalog, equippedOf, lookOf, renderLine, renderHtml } = require('../wear');

globalThis.fetch = () => { throw new Error('network access in a smoke test'); };

const A = 'usr_01JABCDEFGHJKMNPQRSTVWXYZ0';
const B = 'usr_01JABCDEFGHJKMNPQRSTVWXYZ1';
const KINDS = [
    { id: 'live.chat_tag', slots: ['chat_tag'] }, { id: 'live.hat', slots: ['hat'] },
    { id: 'live.name_effect', slots: ['name_effect'] }, { id: 'network.badge', slots: ['badge'] },
];
const DEFS = {
    'live.hat': [{ id: 'itd_01M4GGQ9Y4DWMP43ERNQ3BQW1V', kind: 'live.hat', name: 'Cowboy Hat', art: { emoji: '🤠' }, attributes: { tier: 2 } }],
    'live.chat_tag': [{ id: 'itd_01M4GGQ9Z0000000000000000A', kind: 'live.chat_tag', name: 'VIP tag', art: {}, attributes: { text: 'VIP' } }],
    'live.name_effect': [{ id: 'itd_01M4GGQ9VT32FM9CFD8J0FVX3H', kind: 'live.name_effect', name: 'Divine Name', art: { emoji: '✝️', token: 'name-fx-divine' }, attributes: { css_class: 'name-fx-divine' } }],
    'network.badge': [{ id: 'itd_01M4GGQ9Z0000000000000000B', kind: 'network.badge', name: 'Early Supporter', art: { emoji: '⭐' }, attributes: {} }],
};
const calls = [];
const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
async function fakeFetch(url, init = {}) {
    const u = new URL(String(url));
    calls.push({ path: u.pathname, query: Object.fromEntries(u.searchParams), auth: new Headers(init.headers).get('authorization') });
    assert.equal(u.origin, 'https://inventory.openvibe.network');
    if (u.pathname === '/api/v1/kinds') return json({ kinds: KINDS });
    if (u.pathname === '/api/v1/definitions') return json({ definitions: DEFS[u.searchParams.get('kind')] || [] });
    if (u.pathname === '/api/v1/equipped') {
        const subjects = u.searchParams.get('subjects').split(',');
        return json({ equipped: subjects.map((s) => ({
            subject: s, updated_at: '2026-10-22T19:00:00.000Z',
            slots: s === A ? {
                'live.hat:hat': { instance_id: 'inv_1', definition_id: 'itd_01M4GGQ9Y4DWMP43ERNQ3BQW1V' },
                'live.chat_tag:chat_tag': { instance_id: 'inv_2', definition_id: 'itd_01M4GGQ9Z0000000000000000A' },
                'live.name_effect:name_effect': { instance_id: 'inv_3', definition_id: 'itd_01M4GGQ9VT32FM9CFD8J0FVX3H', token: 'name-fx-divine' },
                'network.badge:badge': { instance_id: 'inv_4', definition_id: 'itd_01M4GGQ9Z0000000000000000B' },
                'live.particle:particle': { instance_id: 'inv_5', definition_id: 'itd_RETIRED' },
            } : {},
        })) });
    }
    throw new Error(`unexpected ${u.pathname}`);
}

(async () => {
    assert.equal(loadConfig({}).inventoryUrl, 'https://inventory.openvibe.network');
    const inv = createInventory(loadConfig({}), { fetch: fakeFetch });

    // The catalog: kinds once, then each kind's published definitions.
    const catalog = await loadCatalog(inv);
    assert.equal(catalog.kinds.size, 4);
    assert.equal(catalog.definitions.size, 4);
    assert.deepEqual(calls.filter((c) => c.path === '/api/v1/definitions').map((c) => c.query.kind).sort(), ['live.chat_tag', 'live.hat', 'live.name_effect', 'network.badge']);
    assert.ok(calls.every((c) => c.auth === null), 'public reads: no token is sent');

    // Who wears what: 100 people per call.
    calls.length = 0;
    const many = [A, B, ...Array.from({ length: 150 }, (_, i) => `usr_01JABCDEFGHJKMNPQRST${String(i).padStart(6, '0').replace(/[ILOU]/g, '0')}`)];
    const eq = await equippedOf(inv, many);
    assert.equal(eq.size, 152);
    assert.deepEqual(calls.map((c) => c.query.subjects.split(',').length), [100, 52]);
    await assert.rejects(equippedOf(inv, ['alex']), /not a person's id/);

    // A's look: hat before, tag in brackets, badge after, the name effect as a class; the retired item shows nothing.
    const look = lookOf(eq.get(A), catalog);
    assert.deepEqual([look.before, look.tag, look.after, look.nameClass], [['🤠'], 'VIP', ['⭐'], 'name-fx-divine']);
    assert.equal(renderLine('alex', look), '🤠 [VIP] alex ⭐  (Cowboy Hat · VIP tag · Divine Name · Early Supporter)');
    assert.equal(renderHtml('<b>alex</b>', look), '🤠 <span class="ov-tag">VIP</span> <span class="name-fx-divine">&lt;b&gt;alex&lt;/b&gt;</span> ⭐', 'names are escaped');
    // B wears nothing: just the name.
    assert.equal(renderLine('sam', lookOf(eq.get(B), catalog)), 'sam');
    assert.equal(renderHtml('sam', lookOf(eq.get(B), catalog)), '<span>sam</span>');
    // A class that is not a plain token is never put into the page.
    assert.equal(renderHtml('x', { ...look, nameClass: 'a" onmouseover="x' }).includes('onmouseover'), false);

    console.log('inventory-wear smoke: public catalog and equipped reads without a token, 100 per call, the look rendered as text and escaped HTML');
})().catch((err) => { console.error(err); process.exit(1); });
