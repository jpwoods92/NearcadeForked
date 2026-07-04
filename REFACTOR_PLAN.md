# Refactor Plan: Breaking Up the Monolith

Snapshot of the problem (as of 2026-07-04):

- One `package.json` at the root actually governs **four unrelated projects**: the Electron desktop app, a Capacitor Android app, a Rust VPS/signaling router (`vps/`), and a Cloudflare Worker website (`website/`).
- Core logic files have grown far past a maintainable size:
  - `src/scripts/host.js` — 4457 lines
  - `src/scripts/trystero-bundle.js` — 3015 lines (a **vendored copy of an npm package we already depend on**)
  - `src/scripts/viewer.js` — 2770 lines
  - `src/scripts/server.js` — 2431 lines
  - `electron-main.js` — 942 lines, single `createWindow()` spanning ~565 lines with 31 IPC handlers inline
  - `src/css/host.css` — 1318 lines, one stylesheet for the entire host UI
- Each of the above mixes multiple unrelated concerns in one file (see Phase 2/3/4 for specifics).
- Duplicated logic: chat functions (`appendChat`, `sendChat`, `log`, `sysChat`) copy-pasted between `host.js` and `viewer.js`; `pactl` audio-routing shell-outs reimplemented in 4 separate files.
- No lint/format config (no eslint, no prettier, no tsconfig), no unit test framework — only one hand-rolled smoke test (`bin/verify.js`).
- Dead weight: `dist-android/` (committed build output), `src/scripts/trystero-torrent.min.js` (0 bytes), a stray `src/package-lock.json`, committed native build artifacts under `src/sidecar/**/build/`, and `electron-main.js` is tracked despite being listed in `.gitignore`.

Goal: reduce these into small, single-responsibility modules with a safety net (lint + tests) so future changes don't keep making this worse — **without a big-bang rewrite**. This is a long-running production app (v3.0.1, has real users), so every phase should ship in small, independently-verifiable commits/PRs, refactor-only (no behavior changes) unless explicitly noted.

## Guiding rules for every phase

- [ ] One concern per PR. Never mix "extract module" with "fix bug" in the same commit.
- [ ] Refactor = identical behavior. Verify with `bin/verify.js` plus a manual smoke test (host a session, join as viewer, check chat/audio/gamepad) before and after each extraction.
- [ ] Prefer moving code verbatim into new files first, fixing style/duplication second. Don't rewrite logic while relocating it.
- [ ] Delete before you refactor: if Phase 1 removes dead code, later line counts and diffs are much cleaner.

---

## Phase 0 — Safety net (do this before touching any logic)

- [x] Add ESLint (flat config, `eslint.config.mjs`) + Prettier, scoped initially just to `src/scripts/`, `electron-*.js`, sidecar/bin. `no-unused-vars`/`no-undef`/etc. are downgraded to `warn` on existing files (hundreds of pre-existing findings — not fixed here, see individual phases) so CI can still gate genuinely new problems. `npm run lint` / `npm run format` (check) / `npm run format:write`.
- [x] Add `.editorconfig` for consistent indentation across the JS/Python/C++/Rust files in the repo.
- [x] Picked `vitest` (+ `jsdom` env, already a dependency) as the test runner. `npm test` now runs `npm run test:unit` (vitest) then `bin/verify.js`, so the existing smoke test is preserved, not replaced. `npm run test:unit:watch` for local iteration.
- [x] Wrote characterization tests (`test/unit/`) for the highest-risk shared logic: chat functions (`log`/`appendChat`/`sendChat` in both `host.js` and `viewer.js` — including the dedup behavior that already differs between the two copies), `preferVideoCodec` codec-sorting/H264-profile-fix/RTX-pairing logic in `host.js`, and the `pactl` output parsers (`parseSinkInputs`/`parseSinks`/`isBlacklisted`) in `audio_blacklist_daemon.js`. To make this possible without moving any logic yet, added a small inert `if (typeof module !== 'undefined') module.exports = {...}` shim at the end of `host.js`/`viewer.js` (no-op in the browser, since `module` doesn't exist there) and exported the three pure parser functions from `audio_blacklist_daemon.js`. See `test/helpers/browser-shims.js` for the jsdom/stub setup this required (Pusher, I18N, fetch, and localStorage all needed stubbing to load these files under Node). 22 tests passing.
- [x] Added `.github/workflows/ci.yml` running `npm run lint` + `npm run test:unit` on PRs and pushes to `main`. Deliberately does **not** run `bin/verify.js` in CI yet — it shells out to `pactl`/uinput/sidecar binaries that a bare `ubuntu-latest` runner doesn't have configured; wiring that up is future work, not part of this pass.

## Phase 1 — Cleanup / dead code (quick wins, no behavior risk)

- [x] Delete `dist-android/` from git tracking, add it to `.gitignore`.
- [x] Delete committed native build artifacts under `src/sidecar/input_backends/**/build/` and `experimental/steamvr_driver/build/`; gitignore build dirs. Turned out `build/Release/uinputBridge.node` (the compiled addon) wasn't disposable — it's referenced directly by electron-builder's `files`/`asarUnpack` config and there was no CI step regenerating it, so the checked-in binary *was* the release artifact. Rather than leave that gap, added `node-addon-api`/`node-gyp` as devDependencies, a `npm run build:uinput` script (`cd src/sidecar/input_backends && node-gyp rebuild`), and a "Build Linux uinput native addon" step in `.github/workflows/release.yml` (Linux-only, before packaging) so the binary is now built fresh instead of committed. `InputOrchestrator.js` already null-checks/falls back to the Python sidecar if the addon is missing, so local dev without running the build script still works. `experimental/steamvr_driver/build/` (CMake cache/intermediates, unreferenced by any packaging config) was just deleted outright.
- [x] Delete `src/scripts/trystero-torrent.min.js` (0 bytes, unused — confirmed zero references anywhere).
- [x] Delete stray `src/package-lock.json`.
- [x] Resolve the `electron-main.js` / `.gitignore` inconsistency — removed the stale `.gitignore` entry; it's the app's real entrypoint and was already tracked, so the ignore line was dead weight.
- [ ] **Deferred, not done in this pass.** Replace `src/scripts/trystero-bundle.js` (hand-vendored, 3015 lines) with the actual `trystero`/`@trystero-p2p/torrent` npm dependency. Investigated: `p2p-signaler.js` loads it as a real ES module (`<script type="module">`, no bundler in this repo), and `@trystero-p2p/torrent`'s own npm dist imports `@trystero-p2p/core` via a bare specifier a browser can't resolve without either a bundler or an import map — neither exists here yet. Fixing this properly means introducing real bundling infrastructure (e.g. esbuild) for the first time, and it's on the critical path of P2P viewer connections, so it's deferred to Phase 2 (where workspace/tooling boundaries are being established anyway) rather than rushed into a "quick wins" pass.
- [x] `src/sidecar/input_backends/experimental/` — re-scoped this item after inspection: it's not just `steamvr_driver`, the whole `experimental/` folder (several Python input backends + `ExperimentalOrchestrator.js`) is already actively `require()`'d by `server.js` and already lives under a clearly-named `experimental/` subdirectory. The actual problem (committed CMake build artifacts under `steamvr_driver/build/`) is fixed above; physically relocating the whole tree now would only mean editing `server.js`'s require path for no functional benefit, so left in place.

## Phase 2 — Establish workspace boundaries

- [x] Decided scope after investigation: `android/`, `website/`, `vps/` already have adequate physical separation (native Gradle project, static+Worker dir, separate Cargo project respectively — none has its own `package.json`, none needed to move). The actual work was moving the Electron+renderer source — `electron-main.js`, `electron-preload.js`, `electron-viewer-preload.js`, `src/` (all of it), and `test/` (moved alongside, since it tests `src/`) — into a new `app/` directory via `git mv` (preserves history). `config/`, `assets/`, `bin/`, `package.json`, and the root launcher scripts (`NearsecTogether.{bat,cmd,command,desktop}`) stay at the true repo root: they're referenced by things outside the app (README image embeds, OS-level desktop shortcuts, electron-builder config anchored to `package.json`'s location) and moving them would've meant touching those external references for no boundary-clarity benefit. Did **not** introduce actual npm `workspaces` mechanism — there's only one real npm-managed package (root); `android`/`website`/`vps` have no `package.json` of their own, so a `workspaces` array would have nothing genuine to list.
- [x] This move touched far more than folders — anything computing a "project root" via `__dirname` + `..` walks silently breaks when a new nesting level is inserted. Found and fixed by grepping for every multi-level `__dirname` pattern *before* moving anything: 12 sites in `electron-main.js` (config/assets/bin/package.json/commit.txt access — all needed one more `'..'`; `src/pages`, `src/docs`, and the preload path were correctly left alone since they move together with `src/`), 5 in `server.js` (`.env`, `assets`, the `projectRoot` used for `package.json`/`commit.txt`/`favicon.ico`), 2 in `InputOrchestrator.js` (`config/game_profiles.csv`, `config/kbm_bindings.json`). Also updated: `package.json` (`main`, `start`/`build:uinput` scripts, electron-builder `files`/`asarUnpack` globs), `bin/verify.js`, `bin/build-android.js`, `bin/start.cmd` (both Unix and Windows sections), `extract-text.js`, the flatpak manifest's launch command, `.gitignore`, `.gitmodules` (git auto-updated the submodule `path` on the directory move; manually renamed the submodule section header to match), and `eslint.config.mjs`/`vitest.config.mjs`/`.prettierignore` globs.
- [x] Verified rather than assumed: syntax-checked every touched file, full lint (0 errors) and unit test suite (22 passing) after the move, ran `bin/verify.js`'s real integration smoke test (boots the actual server — confirmed the config symlink lands at the true root's `config/`, not `app/config`), and did a full `electron-builder --linux --dir` packaging dry run (confirmed `app/electron-main.js` and the full `app/src` tree land correctly inside `app.asar`, and `uinputBridge.node` unpacks to the right path). Did **not** verify the Android (Gradle/Capacitor) or Cloudflare Worker pipelines end-to-end, or Windows/macOS packaging — only Linux electron-builder and the Node-level smoke test were actually runnable in this environment.
- [x] Split root `package.json` scripts/deps so Capacitor and Wrangler deps aren't installed for people just running the desktop app. Confirmed first that nothing under `app/` or `bin/` ever `require()`s `@capacitor/*` or `wrangler` (grepped — zero hits; both are only invoked as CLIs), so moved all of `@capacitor/android`, `@capacitor/assets`, `@capacitor/cli`, `@capacitor/core`, `@capacitor/filesystem`, `@capacitor/ios`, `wrangler` into a new `optionalDependencies` block instead of introducing real npm workspaces (no second `package.json` exists to justify that — see `docs/ARCHITECTURE.md`). Verified in an isolated scratch copy: `npm ci --omit=optional` installs 520 packages instead of 885, `@capacitor`/`wrangler` are absent, and `electron`/`eslint`/`vitest` are still present; re-ran lint/unit tests/the `bin/verify.js` smoke test against the real install afterward to confirm nothing broke. Also updated `.github/workflows/ci.yml` and the `release-desktop` job in `release.yml` to install with `--omit=optional` (neither needs Android/Cloudflare tooling); `release-android` keeps the full `npm ci`.
- [x] Added `docs/ARCHITECTURE.md` documenting the four-project boundary, why `@capacitor/*`/`wrangler` are optional deps instead of real workspaces, and why `config/`/`assets/`/`bin/`/`package.json` stay at the true root instead of moving into `app/`.
- [x] Replace the hand-vendored `app/src/scripts/trystero-bundle.js` provenance with a reproducible build step:
  - [x] Added `esbuild` as a devDependency.
  - [x] Added `bin/build-trystero.js` (`npm run build:trystero`) — bundles `node_modules/@trystero-p2p/torrent/dist/index.mjs` (which pulls in `@trystero-p2p/core` via a bare specifier the browser can't resolve unbundled) into one browser-consumable ESM file at `app/src/scripts/trystero-bundle.js`, with a generated-file banner.
  - [x] Diffed the generated output against the previously hand-vendored file before touching anything real: **byte-for-byte identical** (3015 lines, same export list — `defaultRelayUrls`, `getRelaySockets`, `joinRoom`, `pauseRelayReconnection`, `resumeRelayReconnection`, `selfId`). This means the actual risk here was much lower than expected going in — the file's *content* isn't changing at all, only how it's produced (a script instead of an untracked manual copy). No change needed to `p2p-signaler.js`'s import — same filename, same export surface.
  - [x] Verified: full lint/unit test suite still passes, `bin/verify.js` integration smoke test still passes, and a direct Node import of the regenerated file confirms every export (`joinRoom` etc.) has the expected type/shape.
  - [ ] **Still not done, and can't be done from here**: a live manual host/viewer P2P connection test. Since the bundle content is unchanged today, there's no reason to expect this to behave differently — but that guarantee only holds until `@trystero-p2p/torrent`/`core` next get updated and `build:trystero` is re-run against a newer version, at which point the *regenerated* output (not this one) needs the same live-connection sanity check before shipping. Recommend a quick host-a-session/join-as-viewer check now anyway, since it's cheap and this is exactly the kind of thing that's much cheaper to verify than to debug after a release.

## Phase 3 — Break up `server.js` (2431 lines → modules)

Note: as of Phase 2, this file lives at `app/src/scripts/server.js` (module paths below are relative to that directory).

Split by the ~6 distinct concerns identified:
- [ ] `server/http.js` — Express app setup, routes, static serving.
- [ ] `server/ws.js` — WebSocket connection handling.
- [ ] `server/audio-routing.js` — PipeWire/PulseAudio (`pactl`) shell-outs. **This becomes the single source of truth** for audio routing — Phase 9 will point the other 3 duplicated implementations at this module instead of reimplementing it.
- [ ] `server/arcade-signaling.js` — Pusher-based arcade signaling.
- [ ] `server/input-bridge.js` — gamepad/input message normalization and forwarding to the Python sidecar.
- [ ] `server/network-info.js` — LAN IP, Tailscale IP, public IP, free-port scanning.
- [ ] `server/env.js` — `.env`/data-dir management, binary path resolution.
- [ ] `server.js` becomes a thin entrypoint that wires these modules together.

## Phase 4 — Break up `electron-main.js` (942 lines → modules)

Note: as of Phase 2, this file lives at `app/electron-main.js`.

- [ ] `electron/window.js` — window/tray lifecycle (the current 565-line `createWindow` body).
- [ ] `electron/ipc/*.js` — split the 31 `ipcMain` handlers by domain (clipboard, VPS config, setup runner, log viewing, settings) instead of one flat list.
- [ ] `electron/updater.js` — auto-updater wiring.
- [ ] `electron/discord-rpc.js` — Discord RPC client setup/teardown.
- [ ] `electron/settings.js` — settings persistence + controller config loading.
- [ ] `electron-main.js` becomes the composition root: create window, register IPC modules, start updater/RPC.

## Phase 5 — Break up `host.js` (4457 lines) and `viewer.js` (2770 lines)

This is the biggest and riskiest phase — do it last, after Phases 0–4 give you tooling and a template for how to split a file. As of Phase 2, both files live at `app/src/scripts/` (module paths below are relative to that directory).

- [ ] Extract shared `scripts/chat.js` (`appendChat`, `sendChat`, `log`, `sysChat`) — used by both `host.js` and `viewer.js`, currently duplicated. Do this first; it's the clearest, lowest-risk win and validates the extraction pattern for the rest of the phase.
- [ ] Extract `scripts/webrtc/peer-connection.js` — connection setup/teardown, shared shape between host and viewer.
- [ ] Extract `scripts/webrtc/codec-negotiation.js` — codec preference + congestion/bitrate benchmarking logic from `host.js` (check for a divergent viewer-side counterpart before merging).
- [ ] Extract `scripts/ui/modals.js` and `scripts/ui/roster.js` — modal handling, drag-drop roster UI from `host.js`.
- [ ] Extract `scripts/audio-mixing.js` — gain/mixing logic from `host.js`.
- [ ] Extract `scripts/stats-hud.js` — stats HUD rendering.
- [ ] Extract `scripts/arcade-registration.js` — Pusher-based arcade registration (shared shape with `server/arcade-signaling.js` from Phase 3 — check whether client and server sides can share message-shape constants).
- [ ] Extract `scripts/tunnel-modal.js` — cloudflared tunnel modal flow.
- [ ] Repeat equivalent extraction for `viewer.js`'s ~97 top-level functions, reusing the shared modules built above rather than re-splitting duplicate logic.
- [ ] After extraction, `host.js` and `viewer.js` should mainly be composition/bootstrap code wiring the extracted modules to the DOM.

## Phase 6 — CSS

- [ ] Split `app/src/css/host.css` (1318 lines) into component-scoped files (`modals.css`, `roster.css`, `stats-hud.css`, `chat.css`, base/layout) mirroring the JS module boundaries from Phase 5, so a given feature's CSS and JS live in parallel files.

## Phase 7 — HTML pages

- [ ] Audit `app/src/pages/index.html` (2128 lines), `host-minimal.html` (1505), `dashboard.html` (1474), `host-modals.html` (840) for inline `<script>`/`<style>` blocks; move logic into the `scripts/`/`css/` modules from Phases 5–6 so HTML files hold markup only.
- [ ] Confirm whether `host.html`, `host-custom.html`, `host-playground.html`, `host-minimal.html` are all still in active use — consolidate or delete variants that have drifted into redundancy, once it's clear which are load-bearing.

## Phase 8 — Sidecar dedup

- [ ] Point the 4 independent `pactl` implementations (`app/electron-main.js`, `app/src/scripts/server.js`, `app/src/sidecar/audio_worker.js`, `app/src/sidecar/audio_blacklist_daemon.js`) at the single `server/audio-routing.js` module from Phase 3, or a shared sidecar equivalent if some of these run in a different process context.
- [ ] Review `app/src/sidecar/input_backends/InputOrchestrator.js` (764 lines) for the same multi-concern pattern as the main JS files; split if it mixes device detection, event translation, and platform dispatch.

## Phase 9 — Ongoing hygiene (after the above lands)

- [ ] Add a `CLAUDE.md` (or expand `README.md`) documenting the new module boundaries so contributors don't collapse them back into monoliths.
- [ ] Add a soft file-size guideline (e.g. "flag PRs that push a file past ~400 lines") enforced via a simple CI check or just PR review convention.
- [ ] Re-run the Phase 0 characterization tests after each phase to confirm no behavior drift; expand unit test coverage opportunistically as modules are extracted (test the new small module, not the old giant one).
- [ ] Close out the Phase 0 lint/format debt deliberately deferred at the start: once the extracted modules from Phases 3–8 are small and settled, remove the `legacyRuleOverrides` block in `eslint.config.mjs` (`no-unused-vars`/`no-undef`/`no-empty`/`no-fallthrough`/`no-useless-assignment`/`no-case-declarations`/`no-async-promise-executor`/`no-cond-assign`/`no-useless-escape`/`no-extra-boolean-cast` are all currently downgraded to `warn` repo-wide) — file-by-file as each is refactored and its warnings cleaned up is easier than one big-bang pass. Then run `npm run format:write` once (a large, refactor-only, no-behavior-change commit on its own) and add `npm run format` as a required CI step in `.github/workflows/ci.yml` alongside `lint`/`test:unit`. Doing this now, before the file splits, would just mean re-diffing everything again later.

---

### Suggested order of execution

Phase 0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9. Phases 0–2 are foundational and low-risk; 3–4 are medium (server/electron are more mechanical, well-bounded); 5 is the highest-risk and highest-payoff and should only start once the pattern is proven on smaller files.
