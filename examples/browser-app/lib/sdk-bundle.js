'use strict';
/**
 * Serve openvibe-sdk's browser-safe modules to a page with no build step.
 *
 * openvibe-sdk 0.2.2 is CommonJS, and its ESM entry points import CommonJS files, so a browser
 * cannot load it directly without a bundler. This file wraps the modules a sign-in page needs
 * (core, auth/browser, registry) and everything they require into one script that sets
 * `window.OpenVibeSDK = { core, auth, registry }`. It refuses anything that is not a relative
 * require inside the SDK (no `node:` modules, no packages), so server-only code can never slip in.
 *
 * If you use a bundler (esbuild, Vite, webpack), import 'openvibe-sdk/auth/browser' etc. instead.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ENTRIES = { core: 'src/core/index.js', auth: 'src/auth/browser.js', registry: 'src/registry.js' };
const REQUIRE_RE = /require\(\s*'([^']+)'\s*\)/g;

function buildSdkBundle(root = path.dirname(require.resolve('openvibe-sdk/package.json'))) {
    const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
    const modules = new Map();
    const visit = (id) => {
        if (modules.has(id)) return;
        const source = fs.readFileSync(path.join(root, id), 'utf8');
        modules.set(id, null);
        const deps = {};
        for (const [, spec] of source.matchAll(REQUIRE_RE)) {
            if (!spec.startsWith('.')) throw new Error(`${id} requires "${spec}": not browser-safe, refusing to bundle`);
            let dep = path.posix.normalize(path.posix.join(path.posix.dirname(id), spec));
            if (!dep.endsWith('.js')) dep += '.js';
            deps[spec] = dep;
            visit(dep);
        }
        if (/process\.env|client_secret/.test(source)) throw new Error(`${id} references server-only material`);
        modules.set(id, { source, deps });
    };
    for (const id of Object.values(ENTRIES)) visit(id);

    const defs = [...modules].map(([id, { source, deps }]) => `  ${JSON.stringify(id)}: [${JSON.stringify(deps)}, function (module, exports, require) {\n${source}\n}]`).join(',\n');
    const code = `/* openvibe-sdk ${version}: core, auth/browser, registry (MIT). Generated at serve time by examples/browser-app/lib/sdk-bundle.js. */
(function (global) {
  'use strict';
  var defs = {
${defs}
  };
  var cache = {};
  function load(id) {
    if (cache[id]) return cache[id].exports;
    var def = defs[id];
    if (!def) throw new Error('openvibe-sdk bundle: no module ' + id);
    var module = cache[id] = { exports: {} };
    def[1](module, module.exports, function (spec) { return load(def[0][spec]); });
    return module.exports;
  }
  global.OpenVibeSDK = { version: ${JSON.stringify(version)}, ${Object.entries(ENTRIES).map(([k, id]) => `${k}: load(${JSON.stringify(id)})`).join(', ')} };
})(typeof window !== 'undefined' ? window : globalThis);
`;
    return { code, version, etag: `"${crypto.createHash('sha256').update(code).digest('base64url').slice(0, 27)}"`, modules: [...modules.keys()] };
}

module.exports = { buildSdkBundle, ENTRIES };
