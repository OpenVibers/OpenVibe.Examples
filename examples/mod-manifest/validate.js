#!/usr/bin/env node
'use strict';
/**
 * Mod manifest: check a mod manifest before you publish it.
 *
 *   node validate.js mod.json                 # schema + catalog checks, offline
 *   node validate.js mod.json --registry      # also ask the network's registry about each capability
 *   node validate.js --new-id                 # a fresh mod_<ULID> for a draft manifest
 *
 * 1. Schema: openvibe-contracts validate('mods.mod-manifest@1', manifest) (ADR-013).
 * 2. Catalog: every requested capability must exist in the contracts catalog, be `active`, and have
 *    visibility `public`. first-party and internal capabilities are never granted to mods or apps,
 *    so asking for one can only fail at install time; this says so now.
 * 3. Compatibility: the `runtime` major must fall inside compatibility.runtime, and
 *    compatibility.contracts (if given) should include the contracts release you validated with.
 * 4. With --registry: openvibe-sdk/registry capability(id) on the live network (public, no token).
 *
 * The manifest only REQUESTS capabilities. What a mod may actually do is the approved subset of an
 * install's grants; trust tiers are metadata and never change a grant check.
 */
const fs = require('node:fs');
const contracts = require('openvibe-contracts');
const { createClient, satisfiesRange } = require('openvibe-sdk/core');
const { createRegistryClient } = require('openvibe-sdk/registry');

const CONTRACTS_VERSION = require('openvibe-contracts/package.json').version;
const PUBLISHER_TYPES = new Set(['user', 'app']);

/** -> { valid, errors: [{ path, message }], warnings: [{ path, message }] } */
function validateManifest(manifest, { catalog = contracts.capabilities, contractsVersion = CONTRACTS_VERSION } = {}) {
    const errors = [];
    const warnings = [];
    const schema = contracts.validate('mods.mod-manifest@1', manifest);
    if (!schema.valid) {
        for (const e of schema.errors) errors.push({ path: e.path || '/', message: e.message });
        return { valid: false, errors, warnings };
    }

    if (!PUBLISHER_TYPES.has(manifest.publisher.type)) {
        errors.push({ path: '/publisher/type', message: `a mod is published by a user or an app, not a ${manifest.publisher.type}` });
    }

    manifest.permissions.capabilities.forEach((id, i) => {
        const p = `/permissions/capabilities/${i}`;
        const cap = catalog.get(id);
        if (!cap) return errors.push({ path: p, message: `${id} is not in the openvibe-contracts ${contractsVersion} catalog` });
        if (cap.visibility !== 'public') return errors.push({ path: p, message: `${id} is ${cap.visibility}: it is never granted to mods or third-party apps` });
        if (cap.status !== 'active') warnings.push({ path: p, message: `${id} is ${cap.status}, not active yet` });
        return undefined;
    });
    if (!manifest.permissions.capabilities.length) warnings.push({ path: '/permissions/capabilities', message: 'the mod asks for no capabilities' });

    const major = Number(manifest.runtime.split('@')[1]);
    try {
        if (!satisfiesRange(`${major}.0.0`, manifest.compatibility.runtime)) {
            errors.push({ path: '/compatibility/runtime', message: `runtime ${manifest.runtime} is outside ${manifest.compatibility.runtime}` });
        }
    } catch {
        errors.push({ path: '/compatibility/runtime', message: `not a semver range: ${manifest.compatibility.runtime}` });
    }
    if (manifest.compatibility.contracts) {
        try {
            if (!satisfiesRange(contractsVersion, manifest.compatibility.contracts)) {
                warnings.push({ path: '/compatibility/contracts', message: `validated with openvibe-contracts ${contractsVersion}, outside ${manifest.compatibility.contracts}` });
            }
        } catch {
            errors.push({ path: '/compatibility/contracts', message: `not a semver range: ${manifest.compatibility.contracts}` });
        }
    }
    if ((manifest.resources.outboundHosts || []).length) {
        warnings.push({ path: '/resources/outboundHosts', message: 'outbound network access is reviewed before a mod is installed' });
    }
    return { valid: errors.length === 0, errors, warnings };
}

/** Ask the network registry whether each requested capability is registered there. */
async function checkRegistry(manifest, { network = process.env.OV_NETWORK_URL || 'https://openvibe.network', fetch } = {}) {
    const registry = createRegistryClient(createClient({ network, fetch }));
    const out = [];
    for (const id of manifest.permissions.capabilities) {
        const cap = await registry.capability(id);
        out.push({ id, registered: Boolean(cap), visibility: cap ? cap.visibility || null : null, status: cap ? cap.status || null : null });
    }
    return out;
}

async function main(argv = process.argv.slice(2)) {
    if (argv.includes('--new-id')) {
        console.log(contracts.ids.newId('mod'));
        return 0;
    }
    const file = argv.find((a) => !a.startsWith('--'));
    if (!file) { console.error('usage: node validate.js <manifest.json> [--registry] | --new-id'); return 2; }
    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) {
        console.error(`cannot read ${file}: ${err.message}`);
        return 2;
    }
    const result = validateManifest(manifest);
    for (const e of result.errors) console.log(`error   ${e.path}: ${e.message}`);
    for (const w of result.warnings) console.log(`warning ${w.path}: ${w.message}`);
    if (result.valid && argv.includes('--registry')) {
        try {
            for (const c of await checkRegistry(manifest)) {
                console.log(`registry ${c.id}: ${c.registered ? `${c.visibility}, ${c.status}` : 'not registered on this network'}`);
            }
        } catch (err) {
            console.log(`registry check failed: ${err.code || err.message}`);
        }
    }
    console.log(result.valid ? `${file}: valid mods.mod-manifest@1 (openvibe-contracts ${CONTRACTS_VERSION})` : `${file}: invalid`);
    return result.valid ? 0 : 1;
}

if (require.main === module) main().then((code) => { process.exitCode = code; });

module.exports = { validateManifest, checkRegistry, main, CONTRACTS_VERSION };
