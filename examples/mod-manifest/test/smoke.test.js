'use strict';
/** Smoke test: the example manifest validates; each class of mistake is caught with its path. */
const assert = require('node:assert/strict');
const { createMockPlatform } = require('openvibe-sdk/testing');
const { validateManifest, checkRegistry, main } = require('../validate');
const example = require('../mod.json');

globalThis.fetch = () => { throw new Error('network access in a smoke test'); };

const clone = () => JSON.parse(JSON.stringify(example));
const paths = (r) => r.errors.map((e) => e.path);

(async () => {
    // The shipped example is valid, with no warnings.
    const ok = validateManifest(example);
    assert.deepEqual(ok, { valid: true, errors: [], warnings: [] });

    // Schema errors (openvibe-contracts): missing permissions, a two-segment capability id, a bad id.
    let m = clone(); delete m.permissions;
    assert.equal(validateManifest(m).valid, false);
    assert.ok(validateManifest(m).errors.some((e) => /permissions/.test(e.message)));
    m = clone(); m.permissions.capabilities = ['games.announce'];
    assert.deepEqual(paths(validateManifest(m)), ['/permissions/capabilities/0']);
    m = clone(); m.id = 'mod_not-a-ulid';
    assert.deepEqual(paths(validateManifest(m)), ['/id']);

    // Catalog errors: unknown, internal and first-party capabilities are never grantable to a mod.
    m = clone(); m.permissions.capabilities = ['games.world.announce', 'games.world.teleport', 'events.event.publish', 'games.mod.manage'];
    const cat = validateManifest(m);
    assert.deepEqual(paths(cat), ['/permissions/capabilities/1', '/permissions/capabilities/2', '/permissions/capabilities/3']);
    assert.match(cat.errors[0].message, /not in the openvibe-contracts/);
    assert.match(cat.errors[1].message, /is internal:/);
    assert.match(cat.errors[2].message, /first-party/);

    // A planned (not yet active) public capability is a warning, not an error.
    m = clone(); m.permissions.capabilities = ['network.project.manage'];
    const planned = validateManifest(m);
    assert.equal(planned.valid, true);
    assert.match(planned.warnings[0].message, /planned/);

    // Publisher must be a user or an app.
    m = clone(); m.publisher = { type: 'service', id: 'live' };
    assert.deepEqual(paths(validateManifest(m)), ['/publisher/type']);

    // Compatibility: the runtime major must be inside compatibility.runtime.
    m = clone(); m.runtime = 'games-content@2';
    assert.deepEqual(paths(validateManifest(m)), ['/compatibility/runtime']);
    m = clone(); m.compatibility.runtime = 'whenever';
    assert.deepEqual(paths(validateManifest(m)), ['/compatibility/runtime']);
    m = clone(); m.compatibility.contracts = '>=1.0.0';
    const future = validateManifest(m);
    assert.equal(future.valid, true);
    assert.match(future.warnings[0].message, /outside >=1\.0\.0/);

    // Outbound hosts are allowed but flagged for review.
    m = clone(); m.resources.outboundHosts = ['api.example.com'];
    assert.match(validateManifest(m).warnings[0].message, /reviewed/);

    // The optional registry check uses the public registry (no token); here, the SDK's mock.
    const platform = createMockPlatform({ capabilities: [{ id: 'games.world.announce', owner: 'games', visibility: 'public', status: 'active' }] });
    const reg = await checkRegistry(example, { fetch: platform.fetch });
    assert.deepEqual(reg, [
        { id: 'games.world.announce', registered: true, visibility: 'public', status: 'active' },
        { id: 'games.prop.place', registered: false, visibility: null, status: null },
    ]);
    assert.ok(platform.stats.requests.every((r) => !r.headers.authorization), 'the registry needs no credentials');

    // CLI exit codes.
    const out = console.log;
    const err = console.error;
    console.log = () => {};
    console.error = () => {};
    try {
        assert.equal(await main([require.resolve('../mod.json')]), 0);
        assert.equal(await main([]), 2);
        assert.equal(await main(['/nonexistent/mod.json']), 2);
    } finally { console.log = out; console.error = err; }

    console.log('mod-manifest: ok');
})().catch((err) => { console.error(err); process.exit(1); });
