# Achievements and a leaderboard for your game

[OpenVibe.Play](https://play.openvibe.network) keeps the record of what players did in any game: achievements (secret
ones too), leaderboards (best score or total, this week and all time) and cloud saves, with one OpenVibe account for
every player. This example is your game's server: it registers a title, posts a round, unlocks an achievement, reads
the public board and, unless told to keep it, deletes the title again.

```bash
node --env-file=.env scores.js
# registered sandbox-gem-run-3f9a1c (sandbox: unlisted, guests only)
# scores: recorded 1; the same round again recorded 0
# unlocked: first-gem
#   #1 Example player 1200
# deleted the title
```

## What it proves

- **Any developer can start today, from a sandbox app.**
  - A sandbox app in your project gets `play.title.manage` and `play.result.write` without waiting for anyone.
  - It registers up to 3 titles whose ids start with `sandbox-`.
  - Those titles are never listed, counted or indexed. Their players are guests only, so nobody's record changes.
  - When your game is ready, staff turn production on for the project, and its production app registers the real name.
- **One token, refreshed for you.** `createServiceTokenClient` asks Network for an app token for audience `openvibe.play`
  with exactly the two capabilities, caches it and gets a new one before it expires.
- **Writes are safe to retry.** A round's scores carry a `ref`: posting the same round again records nothing. An unlock
  answers only the achievements that were new.
- **Boards are public.** `boards.get()` sends no token: any page can show rank, name and score (never a player id).
- **Clean up.** `titles.remove()` deletes a sandbox title with everything in it. A production title is never deleted:
  what players earned stays on their profiles.

## Files

| File | What |
|---|---|
| `scores.js` | `loadConfig()`, `createGame()`, `playRound()`, `DEFINITION`, CLI (`--keep`) |
| `test/smoke.test.js` | the whole round against a stand-in for Network's token endpoint and Play's API |

## Run the smoke test

```bash
npm test
```

The test hands the SDK a `fetch` that answers like Network's `/oauth/token` and Play's API (`server/http/api.js` on
OpenVibe.Play's main, with the sandbox rules of Play#41 and #42). It checks:
- the token asked for (`openvibe.play`, the two capabilities);
- a sandbox title registered;
- the same round posted twice and counted once;
- the unlock;
- the public board read without a token;
- the title deleted, and kept with `--keep`;
- a real name from a sandbox app refused with `play.sandbox_title`.

Nothing reaches the network.

## Run it against the real platform

1. Sign in on [OpenVibe Services](https://openvibe.services/projects) and make a project. New projects are
   sandbox-only.
2. Add a confidential **sandbox** app and request `play.title.manage` and `play.result.write`. The owner's requests
   are approved at once.
3. Put its client id and secret in `.env` (see `.env.example`), then:

```bash
npm install
node --env-file=.env scores.js --keep      # then open https://play.openvibe.network/t/<the id it printed>
```

Run it without `--keep` (or with the same `OV_PLAY_TITLE`) to delete the title again. In production a player is a
person's `usr_…` id, which your game learns when they sign in with OpenVibe (see [oauth-app](../oauth-app)). A guest
plays at once as `guest:<opaque>`, and `players.adopt()` moves their progress to their account when they sign in.
