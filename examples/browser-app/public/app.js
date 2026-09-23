/* OpenVibe browser app example: sign in with PKCE, then read the public registry.
 * Plain browser JavaScript, no framework and no build step. window.OpenVibeSDK comes from
 * /sdk/openvibe-sdk.js (openvibe-sdk's core, auth/browser and registry modules). DOM nodes are
 * built with textContent, never innerHTML. */
(function () {
    'use strict';
    var sdk = window.OpenVibeSDK;
    var PKCE_KEY = 'ov_example_pkce';
    var $ = function (id) { return document.getElementById(id); };

    function showError(err) {
        var el = $('auth-error');
        el.textContent = 'Sign-in failed: ' + ((err && (err.code || err.message)) || 'unknown error');
        el.hidden = false;
    }

    function getJson(url, init) {
        return fetch(url, Object.assign({ credentials: 'same-origin', headers: { Accept: 'application/json' } }, init || {}))
            .then(function (res) { return res.json().then(function (body) { return { status: res.status, body: body }; }); });
    }

    /** Back from Network on /callback: check state, hand code + verifier to this app's server. */
    function finishSignIn() {
        var href = location.href;
        var saved = null;
        try { saved = JSON.parse(sessionStorage.getItem(PKCE_KEY) || 'null'); } catch (e) { saved = null; }
        sessionStorage.removeItem(PKCE_KEY);
        history.replaceState(null, '', '/');
        var callback;
        try {
            if (!saved) throw { code: 'oauth.no_pending_sign_in' };
            callback = sdk.auth.readCallback(href, { expectedState: saved.state });
        } catch (err) { showError(err); return Promise.resolve(); }
        return getJson('/auth/exchange', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ code: callback.code, codeVerifier: saved.codeVerifier }),
        }).then(function (r) { if (r.status !== 200) showError({ code: r.body.error }); });
    }

    function startSignIn(config) {
        return sdk.auth.startAuthorization({ network: config.network, clientId: config.clientId, redirectUri: config.redirectUri, scope: config.scope })
            .then(function (a) {
                sessionStorage.setItem(PKCE_KEY, JSON.stringify({ state: a.state, codeVerifier: a.codeVerifier }));
                location.assign(a.url);
            });
    }

    function showSession() {
        return getJson('/api/session').then(function (r) {
            var signedIn = r.status === 200;
            $('who').textContent = signedIn
                ? 'Signed in with OpenVibe as ' + r.body.subject + '. This app may: ' + (r.body.capabilities.join(', ') || 'nothing') + '.'
                : 'Not signed in.';
            $('sign-in').hidden = signedIn;
            $('sign-out').hidden = !signedIn;
        });
    }

    function renderServices(services, via) {
        var list = $('services');
        list.textContent = '';
        services.forEach(function (s) {
            var li = document.createElement('li');
            var name = document.createElement('code');
            name.textContent = s.id;
            li.appendChild(name);
            li.appendChild(document.createTextNode(' ' + s.status + (s.publicOrigin ? ' - ' + s.publicOrigin : '')));
            list.appendChild(li);
        });
        $('registry-status').textContent = services.length + ' services, ' + via + '.';
    }

    /** A public API straight from the browser: no token, no cookie. */
    function loadRegistry(config) {
        var client = sdk.core.createClient({ network: config.network, retries: 1 });
        return sdk.registry.createRegistryClient(client).services()
            .then(function (services) { renderServices(services, 'read by this page from ' + config.network); })
            .catch(function () {
                // The browser refused the cross-origin call (CORS). Read it through this app's server.
                return getJson('/api/registry/services').then(function (r) {
                    if (r.status !== 200) throw new Error(r.body.error);
                    renderServices(r.body.services, 'read through this app\'s server (the registry does not allow this origin from a browser yet)');
                });
            })
            .catch(function (err) { $('registry-status').textContent = 'Could not read the registry: ' + (err.code || err.message); });
    }

    getJson('/config.json').then(function (r) {
        var config = r.body;
        $('sign-in').addEventListener('click', function () { startSignIn(config).catch(showError); });
        $('sign-out').addEventListener('click', function () {
            getJson('/auth/logout', { method: 'POST' }).then(showSession);
        });
        var done = location.pathname === new URL(config.redirectUri).pathname ? finishSignIn() : Promise.resolve();
        return done.then(showSession).then(function () { return loadRegistry(config); });
    });
}());
