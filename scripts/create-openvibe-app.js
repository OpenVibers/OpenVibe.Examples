#!/usr/bin/env node
'use strict';
/**
 * create-openvibe-app (roadmap WS-N task 6): start a new OpenVibe app from one of the tested examples.
 *
 *   npx --package=https://codeload.github.com/OpenVibers/OpenVibe.Examples/tar.gz/refs/tags/v0.3.0 \
 *       create-openvibe-app my-app --template web
 *   node scripts/create-openvibe-app.js my-app --template bot      (from a checkout)
 *
 * Templates are the examples in this repository, copied as they are tested in CI (smoke test
 * included), with the package renamed, a .gitignore added and the SDK and contracts pinned to the
 * tags the examples use. Nothing is downloaded and nothing is sent anywhere: the templates travel
 * inside this package. The target directory must not exist or must be empty.
 *
 *   --template <web|server|bot|mod>   default: asked on a terminal, else web
 *   --list                            the templates, then exit
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const ROOT = path.join(__dirname, '..');
const VERSION = require('../package.json').version;
const TEMPLATES = {
    web: { example: 'browser-app', what: 'a plain web page (no build step) that signs in with OpenVibe (PKCE) and calls a public API' },
    server: { example: 'node-server-app', what: 'a Node server with a client-credentials app token and registry discovery' },
    bot: { example: 'chat-bot', what: 'a chat bot that stays in its one configured room and always identifies as a bot' },
    mod: { example: 'mod-manifest', what: 'a mod manifest validated against the schema, the capability catalog and compatibility ranges' },
};
const SKIP = new Set(['node_modules', '.env', '.DS_Store']);

function usage(code = 0) {
    const lines = ['Usage: create-openvibe-app <directory> [--template web|server|bot|mod]', '', 'Templates:'];
    for (const [k, t] of Object.entries(TEMPLATES)) lines.push(`  ${k.padEnd(7)} ${t.what}`);
    (code ? console.error : console.log)(lines.join('\n'));
    process.exit(code);
}

function parse(argv) {
    const out = { dir: null, template: null };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--help' || a === '-h') usage(0);
        else if (a === '--list') usage(0);
        else if (a === '--template' || a === '-t') out.template = argv[++i];
        else if (a.startsWith('--template=')) out.template = a.slice(11);
        else if (a.startsWith('-')) { console.error(`Unknown option ${a}`); usage(2); }
        else if (!out.dir) out.dir = a;
        else { console.error(`Unexpected argument ${a}`); usage(2); }
    }
    return out;
}

/** A package name npm accepts, from the directory name. */
function packageName(dir) {
    const base = path.basename(path.resolve(dir)).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[._-]+|[-]+$/g, '');
    return base || 'openvibe-app';
}

function copyDir(from, to) {
    fs.mkdirSync(to, { recursive: true });
    for (const e of fs.readdirSync(from, { withFileTypes: true })) {
        if (SKIP.has(e.name)) continue;
        const s = path.join(from, e.name), d = path.join(to, e.name);
        if (e.isDirectory()) copyDir(s, d);
        else if (e.isFile()) fs.copyFileSync(s, d);
    }
}

async function ask() {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const keys = Object.keys(TEMPLATES);
    console.log('Which template?');
    keys.forEach((k, i) => console.log(`  ${i + 1}. ${k.padEnd(7)} ${TEMPLATES[k].what}`));
    const answer = await new Promise((r) => rl.question('Number or name [1]: ', r));
    rl.close();
    const t = answer.trim();
    if (!t) return keys[0];
    return TEMPLATES[t] ? t : keys[Number(t) - 1];
}

function create(dir, template) {
    const t = TEMPLATES[template];
    if (!t) throw new Error(`Unknown template "${template}" (${Object.keys(TEMPLATES).join(', ')})`);
    const target = path.resolve(dir);
    if (fs.existsSync(target) && fs.readdirSync(target).length) throw new Error(`${dir} exists and is not empty`);
    const src = path.join(ROOT, 'examples', t.example);
    copyDir(src, target);

    const name = packageName(dir);
    const pkgPath = path.join(target, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const next = { name, version: '0.1.0', private: true, description: pkg.description, ...pkg };
    next.name = name; next.version = '0.1.0';
    fs.writeFileSync(pkgPath, `${JSON.stringify(next, null, 2)}\n`);

    fs.writeFileSync(path.join(target, '.gitignore'), 'node_modules/\n.env\n');
    const readme = path.join(target, 'README.md');
    const body = fs.existsSync(readme) ? fs.readFileSync(readme, 'utf8').replace(/^# .*\n/, '') : '';
    fs.writeFileSync(readme, `# ${name}\n\nStarted with create-openvibe-app ${VERSION} from the \`${template}\` template (OpenVibe.Examples \`examples/${t.example}\`): ${t.what}.\n${body}`);
    return { target, name };
}

async function main() {
    const opts = parse(process.argv.slice(2));
    if (!opts.dir) usage(2);
    let template = opts.template;
    if (!template) template = process.stdin.isTTY && process.stdout.isTTY ? await ask() : 'web';
    const { target, name } = create(opts.dir, template);
    const rel = path.relative(process.cwd(), target) || '.';
    console.log(`\nCreated ${name} in ${rel} from the ${template} template.\n\nNext:\n  cd ${rel}\n  npm install\n  cp .env.example .env    # then fill in your app's values (never commit .env)\n  npm test                # the template's smoke test, no network needed\n  npm start\n\nCreate a project and an app at https://openvibe.codes, and read https://openvibe.codes/docs.`);
}

if (require.main === module) main().catch((err) => { console.error(err.message); process.exit(1); });

module.exports = { TEMPLATES, create, packageName };
