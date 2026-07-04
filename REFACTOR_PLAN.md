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

- [ ] Add ESLint (flat config) + Prettier, scoped initially just to `src/scripts/`, `electron-*.js`. Don't fight existing style everywhere at once — start with `no-unused-vars`, `no-undef`, and formatting only.
- [ ] Add `.editorconfig` for consistent indentation across the JS/Python/C++/Rust files in the repo.
- [ ] Pick a lightweight test runner (`vitest` or `node:test` — no need for a heavy framework given current scope) and wire it into `npm test` alongside the existing `bin/verify.js` smoke test rather than replacing it.
- [ ] Write characterization tests for the highest-risk shared logic before extracting it: codec negotiation in `host.js`, chat functions, `pactl` audio routing. These tests exist to catch regressions during Phases 3–6, not for full coverage.
- [ ] Add CI workflow (or extend an existing one in `.github/workflows/`) to run lint + tests on PRs.

## Phase 1 — Cleanup / dead code (quick wins, no behavior risk)

- [ ] Delete `dist-android/` from git tracking, add it to `.gitignore`.
- [ ] Delete committed native build artifacts under `src/sidecar/input_backends/**/build/` and `experimental/steamvr_driver/build/`; gitignore build dirs.
- [ ] Delete `src/scripts/trystero-torrent.min.js` (0 bytes, unused).
- [ ] Delete stray `src/package-lock.json`.
- [ ] Resolve the `electron-main.js` / `.gitignore` inconsistency — either untrack-and-ignore intentionally or remove the stale gitignore entry. Confirm which is intended before acting.
- [ ] Replace `src/scripts/trystero-bundle.js` (hand-vendored, 3015 lines) with the actual `trystero` / `@trystero-p2p/core` npm dependency already in `package.json`. If a fork/patch was needed, document why in a comment at the import site instead of committing a full copy.
- [ ] Move `src/sidecar/input_backends/experimental/steamvr_driver` out of the main sidecar tree into a clearly-labeled `experimental/` top-level folder (or a separate branch) so it's not mixed with production-path code.

## Phase 2 — Establish workspace boundaries

- [ ] Decide on a workspace strategy (npm workspaces is the natural fit given everything is already Node-tooled except `vps/`). Recommend: `app/` (Electron + renderer), `android/` (Capacitor, mostly unchanged), `website/` (Cloudflare Worker, mostly unchanged), `vps/` (Rust, already isolated by Cargo).
- [ ] Split root `package.json` scripts/deps so Capacitor and Wrangler deps aren't installed for people just running the desktop app, and vice versa.
- [ ] Add a top-level `docs/ARCHITECTURE.md` (or promote `src/docs/ADVANCED_LOGIC.md`) that states these boundaries explicitly, so future contributors don't blur them again.
- [ ] This phase is mechanical (moving folders, updating import paths) — do it after Phase 1 so there's less to move.

## Phase 3 — Break up `server.js` (2431 lines → modules)

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

- [ ] `electron/window.js` — window/tray lifecycle (the current 565-line `createWindow` body).
- [ ] `electron/ipc/*.js` — split the 31 `ipcMain` handlers by domain (clipboard, VPS config, setup runner, log viewing, settings) instead of one flat list.
- [ ] `electron/updater.js` — auto-updater wiring.
- [ ] `electron/discord-rpc.js` — Discord RPC client setup/teardown.
- [ ] `electron/settings.js` — settings persistence + controller config loading.
- [ ] `electron-main.js` becomes the composition root: create window, register IPC modules, start updater/RPC.

## Phase 5 — Break up `host.js` (4457 lines) and `viewer.js` (2770 lines)

This is the biggest and riskiest phase — do it last, after Phases 0–4 give you tooling and a template for how to split a file.

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

- [ ] Split `src/css/host.css` (1318 lines) into component-scoped files (`modals.css`, `roster.css`, `stats-hud.css`, `chat.css`, base/layout) mirroring the JS module boundaries from Phase 5, so a given feature's CSS and JS live in parallel files.

## Phase 7 — HTML pages

- [ ] Audit `src/pages/index.html` (2128 lines), `host-minimal.html` (1505), `dashboard.html` (1474), `host-modals.html` (840) for inline `<script>`/`<style>` blocks; move logic into the `scripts/`/`css/` modules from Phases 5–6 so HTML files hold markup only.
- [ ] Confirm whether `host.html`, `host-custom.html`, `host-playground.html`, `host-minimal.html` are all still in active use — consolidate or delete variants that have drifted into redundancy, once it's clear which are load-bearing.

## Phase 8 — Sidecar dedup

- [ ] Point the 4 independent `pactl` implementations (`electron-main.js`, `server.js`, `src/sidecar/audio_worker.js`, `src/sidecar/audio_blacklist_daemon.js`) at the single `server/audio-routing.js` module from Phase 3, or a shared sidecar equivalent if some of these run in a different process context.
- [ ] Review `src/sidecar/InputOrchestrator.js` (764 lines) for the same multi-concern pattern as the main JS files; split if it mixes device detection, event translation, and platform dispatch.

## Phase 9 — Ongoing hygiene (after the above lands)

- [ ] Add a `CLAUDE.md` (or expand `README.md`) documenting the new module boundaries so contributors don't collapse them back into monoliths.
- [ ] Add a soft file-size guideline (e.g. "flag PRs that push a file past ~400 lines") enforced via a simple CI check or just PR review convention.
- [ ] Re-run the Phase 0 characterization tests after each phase to confirm no behavior drift; expand unit test coverage opportunistically as modules are extracted (test the new small module, not the old giant one).

---

### Suggested order of execution

Phase 0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9. Phases 0–2 are foundational and low-risk; 3–4 are medium (server/electron are more mechanical, well-bounded); 5 is the highest-risk and highest-payoff and should only start once the pattern is proven on smaller files.
