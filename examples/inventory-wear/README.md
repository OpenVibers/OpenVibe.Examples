# What people wear, in your app

On OpenVibe, a person's hat, chat tag, badge and name effect follow them from site to site through
[OpenVibe.Inventory](https://inventory.openvibe.network), the network-wide inventory. This example
shows them next to names in **your** app, as OpenVibe.Live's chat does. Both reads are public, so
you need no token and no app.

```bash
node wear.js usr_01J… usr_01J…
# 🤠 [VIP] alex ⭐  (Cowboy Hat · VIP tag · Divine Name · Early Supporter)
# sam
```

## What it proves

- **The catalog is public and changes rarely.** It's two reads:
  - `kinds.list()`: each kind's slots and how surfaces render it;
  - `definitions.list({ kind })`: names, art, attributes.

  Read it once and keep it. Production had 6 kinds and 70 published items on 2026-10-22.
- **Who wears what** is one public read for up to 100 people (`inventory.equipped(subjects)`), the
  same call chat renders use. `equippedOf()` splits larger lists into calls of 100.
- **A look:**
  - the hat's emoji goes before the name;
  - a chat tag goes in brackets;
  - a badge's emoji goes after;
  - a name effect is the CSS class OpenVibe's pages use (`name-fx-divine`, …).

  An item whose definition is retired or unpublished shows nothing rather than a guess.
- **`renderHtml()` escapes the name** and adds a class only when it is a plain token, so a person's
  name can't inject markup.
- **Reading is for everyone; issuing is not.** Defining and granting items is for each kind's
  issuer (OpenVibe's own services today, `inventory.definition.manage` and `inventory.item.grant`
  are first-party), and nothing is sold or traded.

## Files

| File | What |
|---|---|
| `wear.js` | `loadConfig()`, `createInventory()`, `loadCatalog()`, `equippedOf()`, `lookOf()`, `renderLine()`, `renderHtml()`, CLI |
| `test/smoke.test.js` | the catalog, batched equipped reads and both renderings against a stand-in for Inventory |

## Run the smoke test

```bash
npm test
```

The test hands the SDK a `fetch` that answers like Inventory's public routes (`server/http/api.js`
on OpenVibe.Inventory's main, shapes sampled from production on 2026-10-22). It checks:
- that no token is sent;
- one definitions read per kind;
- 152 people fetched in calls of 100 and 52;
- the look, including a retired item that shows nothing;
- the text line;
- the escaped HTML, with an unsafe class refused.

Nothing reaches the network.

## Run it against the real platform

```bash
npm install
node wear.js usr_01J…          # anyone's subject id (usr_…), as your app learns it from sign-in
```

An app that signs people in with OpenVibe (see [oauth-app](../oauth-app)) learns each person's
`usr_…` id from their token, and that id is all these reads need.
