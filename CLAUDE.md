# NearsecTogether — module map & conventions

This file documents the module boundaries established during the
`REFACTOR_PLAN.md` refactor (Phases 3–8), so new code lands in the right
place instead of collapsing things back into monoliths. See
`REFACTOR_PLAN.md` for the full phase-by-phase history and rationale behind
specific decisions.

## Two different module systems in this repo

**`app/electron/`, `app/src/scripts/server/`, `app/src/sidecar/`** are real
CommonJS — `require()`/`module.exports`, each file has its own scope.

**`app/src/scripts/*.js`** (host.js, viewer.js, and their siblings like
chat.js, capture.js, tunnel-modal.js, etc.) are **not** modules — they're
loaded as plain `<script>` tags from `app/src/pages/*.html` and share one
global scope, same as if you'd pasted them all into one file in `<script>`
order. A function in `capture.js` can call a function defined in `host.js`
with no `require()` at all, because by the time it runs, both files have
already executed and populated the same global namespace. This is why these
files don't `require()` each other — don't add that, it won't do what you
expect (Node module resolution doesn't apply to a `<script src>` tag).

Two consequences:
- **Script tag order matters for anything that runs immediately at parse
  time** (top-level code, not inside a function body). A file loaded before
  another can't reference the second file's top-level `const`/`let` outside
  a function — it'll throw `ReferenceError`. Code inside function bodies is
  fine regardless of order, since it only runs later, after every script has
  loaded. If you add a new file, check whether it has any top-level
  (non-function-body) code that touches another file's globals — put it in
  the right script order, or move it inside a function.
- **`app/test/helpers/browser-shims.js`** reproduces this for Vitest:
  `installSharedScriptGlobals()` copies each shared script's
  `module.exports` onto Node's `global` before `require()`-ing host.js/
  viewer.js, in the same order the HTML pages load them. New shared script
  file → add it to that list.

## Shared mutable state in a real CommonJS split

When breaking up a real CommonJS file that has a lot of cross-cutting
mutable state (not the shared-global-script trick above — actual
`require()`'d modules), the pattern used twice in this repo is a single
`state.js` whose *properties* get reassigned, since plain `let` bindings
can't be shared by reference across separate `require()`'d files:

- `app/electron/state.js` — Electron main-process state (Phase 4).
- `app/src/sidecar/input_backends/state.js` — input pipeline state (Phase 8).

Read/write through `state.someField`, never destructure
(`const { someField } = require('./state.js')`) if that field ever gets
*reassigned* elsewhere (destructuring captures the value at import time, not
a live reference — Map/array mutations are fine either way since the
container reference itself doesn't change).

If a file needs a local variable that would collide with the state module's
own name (e.g. `input_backends/kbm-handler.js` uses a local `state` for
per-viewer KBM state), import the shared module under a different alias
(`sharedState`) rather than renaming the local variable — see that file for
the precedent.

## Where things live

| Concern | Location |
|---|---|
| Express/WS server, one file per concern | `app/src/scripts/server/*.js` |
| Electron main process | `app/electron-main.js` (composition root) + `app/electron/*.js`, `app/electron/ipc/*.js` |
| Host/viewer browser scripts | `app/src/scripts/*.js` (see shared-global-script note above) |
| Host-only UI/webrtc modules | `app/src/scripts/ui/*.js`, `app/src/scripts/webrtc/*.js` |
| Viewer-only input handling | `app/src/scripts/input/*.js` |
| CSS, split to mirror the JS modules above | `app/src/css/*.css` |
| Native/Python input bridge orchestration | `app/src/sidecar/input_backends/*.js` |
| Virtual audio (PulseAudio/PipeWire routing) | `app/src/scripts/server/audio-routing.js` (main thread) + `app/src/sidecar/audio_worker.js` (worker thread) + `app/src/sidecar/audio_blacklist_daemon.js` (ejection safety net) + `app/src/sidecar/audio-module-utils.js` (shared stale-module parsing, used by both threads) |
| HTML pages | `app/src/pages/*.html`, with deferred/modal content split into `app/src/pages/partials/*.html` and injected via a synchronous XHR fetch-and-inject (see `host-modals.html`/`dashboard-modals.html`) |

## Conventions

- **File size**: no hard limit, but if a new/edited file mixes more than one
  clearly separable concern and is pushing past ~400 lines, that's a signal
  to split it the way Phases 3–8 did — pull the separable piece into its own
  file rather than growing the existing one further. This is a PR-review
  convention, not a CI gate: several files in this repo are >400 lines
  *after* already being split, because the remaining size is one cohesive
  concern (e.g. `host.js`/`viewer.js`'s own bootstrap, `dashboard.js`'s
  single-page app logic) — don't split those further just to hit a number.
- **Lint**: `eslint.config.mjs` enforces `error` severity by default. A
  fixed, shrinking list (`legacyDebtFiles`) still has some rules downgraded
  to `warn` because they pre-date linting in this repo. New files are never
  added to that list — if you're touching one that's on it, cleaning up its
  warnings and removing it from the list is welcome but not required.
- **Tests**: `app/test/unit/*.test.js` (Vitest). When splitting a file,
  prefer writing tests for the new small module over trying to characterize
  the old giant one — see `input-bit-conversion.test.js`,
  `input-validation.test.js`, `input-slot-manager.test.js` for the pattern on
  a file that had zero prior coverage.
- **Formatting**: `npm run format` (prettier --check) is not yet a required
  CI step — most of the repo predates prettier and hasn't been reformatted.
  See `REFACTOR_PLAN.md` Phase 9 for the plan to do that as its own
  dedicated, no-behavior-change commit.
