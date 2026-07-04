# Repository Architecture

This repository holds four independent projects that happen to share one git history. This doc states the boundary explicitly so it doesn't get blurred again — see `REFACTOR_PLAN.md` for the ongoing cleanup that established it.

## The four projects

| Directory | What it is | Package management |
|---|---|---|
| `app/` | The Electron desktop app: main process (`app/electron-main.js`), preloads, and all renderer/server source (`app/src/`) — the actual product. | Root `package.json` (`dependencies`/`devDependencies`). No `package.json` of its own; `app/` is a source directory, not an npm package. |
| `android/` | A Capacitor-generated native Android (Gradle) project. | Managed by Gradle/Capacitor tooling, not npm. The npm-side tooling that drives it (`@capacitor/*`, `capacitor.config.ts`, `bin/build-android.js`) lives at the repo root. |
| `website/` | Static marketing/arcade pages served by a Cloudflare Worker (`website/_worker.js`, `wrangler.jsonc`). | No `package.json` of its own. Deployed via the root's `wrangler` devDependency (`npm run deploy` / `npm run preview`). |
| `vps/` | A separate Rust signaling/router service. | Its own `Cargo.toml` — fully independent of npm. |

## Why `@capacitor/*` and `wrangler` are `optionalDependencies`

Nothing under `app/` or `bin/` ever `require()`s a Capacitor or Wrangler package — they're invoked purely as CLIs (`npx cap sync android`, `wrangler deploy`/`dev`). So they're declared as `optionalDependencies` in the root `package.json`: a plain `npm install` still installs everything (no behavior change for existing workflows), but anyone who only cares about the desktop app can run `npm install --omit=optional` (or `npm ci --omit=optional`, as CI now does for the lint/test and desktop-release jobs) and skip ~365 packages of Android/Cloudflare tooling entirely.

This is deliberately **not** npm workspaces. Workspaces exist to manage multiple *npm packages* sharing one lockfile — but `android/` and `website/` have no `package.json` of their own and don't need one (they're not npm-managed), so there's nothing genuine for a `workspaces` array to list. A directory-level split plus `optionalDependencies` gets the practical benefit (smaller installs, clear ownership) without inventing dependency-management structure that has no second member.

## Path structure inside `app/`

`app/` intentionally does **not** contain `config/`, `assets/`, `bin/`, or `package.json` — those stay at the true repo root because things *outside* the app reference them directly and moving them would only add indirection for no boundary benefit:

- `assets/` — embedded by root `README.md` for GitHub rendering, and by `package.json`'s electron-builder `icon` fields (which must be relative to `package.json`'s own location).
- `bin/` — setup scripts invoked by the root launcher scripts (`NearsecTogether.bat`/`.cmd`/`.command`/`.desktop`), which are OS-level shortcuts/launchers that must stay at a fixed root-relative path.
- `config/` — user-editable game/controller profiles, read by `app/` code via a `path.resolve(__dirname, '..', '..', '..')`-style walk back up to the true root (see `app/src/scripts/server.js`'s `projectRoot`, and `app/src/sidecar/input_backends/InputOrchestrator.js`).
- `package.json` — has to stay at root for `npm`/`npm ci`/CI to find it without extra flags.

If you add code under `app/` that needs to reach one of these, don't hardcode a `../../..`-style walk without checking how many `app/`-internal directory levels you're actually crossing — get it wrong and it silently resolves to the wrong place instead of erroring (this bit the initial move; see the Phase 2 entry in `REFACTOR_PLAN.md` for the specifics).
