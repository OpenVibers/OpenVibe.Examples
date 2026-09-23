# Mod manifest

Write a `mods.mod-manifest@1` document and check it before you publish, with openvibe-contracts.

```bash
node validate.js mod.json               # schema + catalog + compatibility, offline
node validate.js mod.json --registry    # also asks the network's public registry about each capability
node validate.js --new-id               # a fresh mod_<ULID> for a draft
```

`mod.json` is a small valid manifest: a `games.browser` mod on the `games-content@1` runtime that
asks for `games.world.announce` and `games.prop.place`.

## What it proves

- **Schema**: `contracts.validate('mods.mod-manifest@1', manifest)` (ADR-013), with JSON-pointer paths.
- **Catalog**: every requested capability exists in the openvibe-contracts catalog, is `public`
  (`first-party` and `internal` capabilities are never granted to mods or third-party apps, so
  asking for one can only fail at install time) and `active` (a `planned` one is a warning).
- **Publisher** is a user or an app.
- **Compatibility**: the runtime's major version is inside `compatibility.runtime`; a
  `compatibility.contracts` range that excludes the contracts release you validated with is a warning.
- **Registry** (optional): each capability as the live network's registry knows it, with
  `openvibe-sdk/registry` and no credentials.

A manifest only **requests** capabilities. What a mod may do is the approved subset of its
install's grants; trust tiers are metadata and never change a grant check.

## Files

| File | What |
|---|---|
| `mod.json` | the example manifest |
| `validate.js` | `validateManifest()`, `checkRegistry()`, CLI |
| `test/smoke.test.js` | the example validates; each class of mistake is caught at its path |

## Run the smoke test

```bash
npm test
```

## Run it against the real platform

Validation is offline and works today: `node validate.js mod.json`. The `--registry` check reads
`https://openvibe.network/api/v1/registry/capabilities/<id>` (public, no credentials).

Publishing is not public yet: registering a mod and managing installs (`games.mod.manage`) is a
`first-party` capability, install grants (`mods.grant.manage`) are `planned`, and the manifest
editor and release flow belong to OpenVibe.Codes, which has not launched. Mod ids are assigned
by that flow; `--new-id` only gives a draft a well-formed id.
