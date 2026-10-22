'use strict';
/**
 * Show what people wear on OpenVibe next to their names in your own app: the network-wide inventory
 * (OpenVibe.Inventory) is public to read, with no token. A person's hat, badge, name effect and chat tag follow them
 * from site to site, and any app can render them the way OpenVibe.Live's chat does.
 *
 *   node wear.js usr_01J… usr_01J…
 *   # 🤠 [VIP] alex  (Cowboy Hat · name effect: name-fx-divine)
 *
 * Two reads, both public and cacheable:
 *   - the catalog: every kind (its slots and how surfaces render it) and the published definitions (names, art,
 *     attributes), which change rarely, so read them once and keep them;
 *   - who wears what: GET /api/v1/equipped for up to 100 people per call, as chat renders do.
 * Defining and granting items is for each kind's issuer (OpenVibe's own services today); an app reads.
 */
const { createClient } = require('openvibe-sdk/core');
const { createInventoryClient } = require('openvibe-sdk/inventory');

const SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const BATCH = 100;   // Inventory's limit per /equipped call

function loadConfig(env = process.env) {
    return { inventoryUrl: String(env.OV_INVENTORY_URL || 'https://inventory.openvibe.network').replace(/\/+$/, '') };
}

/** Inventory's client with no token: these reads are public. */
function createInventory(config, { fetch } = {}) {
    return createInventoryClient(createClient({ baseUrls: { inventory: config.inventoryUrl }, ...(fetch ? { fetch } : {}) }));
}

/** The catalog: kinds by id and published definitions by id (page through a kind's definitions as needed). */
async function loadCatalog(inv) {
    const { kinds = [] } = await inv.kinds.list();
    const definitions = new Map();
    for (const k of kinds) {
        const { definitions: list = [] } = await inv.definitions.list({ kind: k.id, limit: 200 });
        for (const d of list) definitions.set(d.id, d);
    }
    return { kinds: new Map(kinds.map((k) => [k.id, k])), definitions };
}

/** Everyone's equipped slots, 100 people per call → Map(subject → slots). */
async function equippedOf(inv, subjects) {
    const want = [...new Set(subjects)];
    for (const s of want) if (!SUBJECT_RE.test(s)) throw new TypeError(`${s} is not a person's id (usr_…)`);
    const out = new Map();
    for (let i = 0; i < want.length; i += BATCH) {
        const { equipped = [] } = await inv.equipped(want.slice(i, i + BATCH));
        for (const e of equipped) out.set(e.subject, e.slots || {});
    }
    return out;
}

/**
 * One person's look as plain parts: the hat's emoji before the name, a chat tag in brackets, a badge's emoji after,
 * and a name effect as the CSS class OpenVibe's pages use (with its emoji when there is one).
 */
function lookOf(slots, catalog) {
    const look = { before: [], after: [], tag: null, nameClass: null, items: [] };
    for (const [slotKey, slot] of Object.entries(slots || {})) {
        const kindId = slotKey.slice(0, slotKey.lastIndexOf(':'));
        const def = catalog.definitions.get(slot.definition_id);
        if (!def) continue;   // retired or not published: show nothing rather than a guess
        const emoji = def.art && def.art.emoji;
        look.items.push({ kind: kindId, name: def.name });
        if (kindId === 'live.hat' && emoji) look.before.push(emoji);
        else if (kindId === 'live.chat_tag') look.tag = (def.attributes && def.attributes.text) || def.name;
        else if (kindId === 'network.badge' && emoji) look.after.push(emoji);
        else if (kindId === 'live.name_effect') look.nameClass = (def.art && def.art.token) || (def.attributes && def.attributes.css_class) || null;
    }
    return look;
}

/** The text line a terminal or a plain list shows. */
function renderLine(name, look) {
    return [...look.before, look.tag ? `[${look.tag}]` : null, name, ...look.after].filter(Boolean).join(' ')
        + (look.items.length ? `  (${look.items.map((i) => i.name).join(' · ')})` : '');
}

/** HTML for a web page, escaped; style the name-fx-* classes as you like. */
function renderHtml(name, look) {
    const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    const tag = look.tag ? `<span class="ov-tag">${esc(look.tag)}</span> ` : '';
    const cls = look.nameClass && /^[a-z0-9-]{1,40}$/.test(look.nameClass) ? ` class="${look.nameClass}"` : '';
    return `${look.before.map(esc).join('')}${look.before.length ? ' ' : ''}${tag}<span${cls}>${esc(name)}</span>${look.after.length ? ' ' : ''}${look.after.map(esc).join('')}`;
}

module.exports = { loadConfig, createInventory, loadCatalog, equippedOf, lookOf, renderLine, renderHtml };

if (require.main === module) {
    (async () => {
        const subjects = process.argv.slice(2);
        if (!subjects.length) throw new Error('usage: wear.js <usr_…> [usr_…]');
        const inv = createInventory(loadConfig());
        const [catalog, equipped] = await Promise.all([loadCatalog(inv), equippedOf(inv, subjects)]);
        for (const s of subjects) console.log(renderLine(s, lookOf(equipped.get(s), catalog)));
    })().catch((err) => { console.error(err.code ? `${err.code}: ${err.message}` : err.message); process.exit(1); });
}
