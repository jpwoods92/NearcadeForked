import js from '@eslint/js';
import globals from 'globals';
import prettier from 'eslint-config-prettier';

// Phase 0 of REFACTOR_PLAN.md: scoped deliberately to the files we're about to
// add tests around (src/scripts/, electron-*.js, src/sidecar/). Widen the
// `files` globs below as later refactor phases touch more of the tree.
//
// This is a legacy codebase with no prior linting, so a first `eslint .` run
// surfaced hundreds of pre-existing findings (unused vars, empty catch
// blocks, a few real no-undef typos). Failing CI on all of that immediately
// wasn't useful, so these rules were downgraded to 'warn' repo-wide at first.
//
// Phase 9 flipped this from an allow-list to a deny-list: the browser/ESM/
// node-context blocks below no longer reference legacyRuleOverrides at all,
// so any file NOT explicitly named in the legacyDebtFiles block just below
// gets full 'error' severity by default — including every new file added
// from here on. legacyDebtFiles is the shrinking list of pre-existing files
// that still have violations; as each gets cleaned up, remove it from that
// list rather than leaving the whole codebase downgraded.
const legacyRuleOverrides = {
  'no-unused-vars': 'warn',
  'no-undef': 'warn',
  'no-empty': 'warn',
  'no-fallthrough': 'warn',
  'no-useless-assignment': 'warn',
  'no-case-declarations': 'warn',
  'no-async-promise-executor': 'warn',
  'no-cond-assign': 'warn',
  'no-useless-escape': 'warn',
  'no-extra-boolean-cast': 'warn',
  // Phase 5's module extractions (app/src/scripts/*.js) moved some functions
  // that assign shared host.js state (e.g. capture.js's startCapture/
  // stopCapture assigning currentStream) into their own files, while the
  // `let` declaration stays in host.js as shared cross-file state. ESLint
  // analyzes each file in isolation, so it sees host.js's declaration with
  // no assignment anywhere in that same file and flags it — a false
  // positive from the single-file view, same class of issue as no-undef
  // above.
  'no-unassigned-vars': 'warn',
};

// Files still carrying at least one legacyRuleOverrides violation as of
// Phase 9 (REFACTOR_PLAN.md) — computed from a full `eslint . --format json`
// pass, not hand-picked. Remove a file from this list once it's clean; don't
// add new files to it.
const legacyDebtFiles = [
  'app/electron-viewer-preload.js',
  'app/electron/cli-flags.js',
  'app/electron/discord-rpc.js',
  'app/electron/ipc/app-info.js',
  'app/electron/ipc/clipboard.js',
  'app/electron/ipc/gamepad.js',
  'app/electron/ipc/setup-runner.js',
  'app/electron/logger.js',
  'app/electron/settings.js',
  'app/electron/window.js',
  'app/src/scripts/arcade-registration.js',
  'app/src/scripts/audio-mixing.js',
  'app/src/scripts/audio-util.js',
  'app/src/scripts/capture.js',
  'app/src/scripts/dashboard.js',
  'app/src/scripts/host-minimal-tunnel-commands.js',
  'app/src/scripts/host.js',
  'app/src/scripts/i18n.js',
  'app/src/scripts/input/gamepad.js',
  'app/src/scripts/p2p-viewer.js',
  'app/src/scripts/server.js',
  'app/src/scripts/server/arcade-signaling.js',
  'app/src/scripts/server/audio-routing.js',
  'app/src/scripts/server/env.js',
  'app/src/scripts/server/http.js',
  'app/src/scripts/server/tunnel.js',
  'app/src/scripts/server/ws.js',
  'app/src/scripts/stats-hud.js',
  'app/src/scripts/tunnel-modal.js',
  'app/src/scripts/ui/modals.js',
  'app/src/scripts/ui/roster.js',
  'app/src/scripts/viewer-page-bootstrap.js',
  'app/src/scripts/viewer.js',
  'app/src/scripts/vps-sfu.js',
  'app/src/scripts/webcodecs-decoder.js',
  'app/src/scripts/webcodecs-encoder.js',
  'app/src/scripts/webrtc/codec-negotiation.js',
  'app/src/sidecar/CaptureManager.js',
  'app/src/sidecar/arcade_heartbeat_worker.js',
  'app/src/sidecar/audio_worker.js',
  'app/src/sidecar/input_backends/InputOrchestrator.js',
  'app/src/sidecar/input_backends/backend-init.js',
  'app/src/sidecar/input_backends/validation.js',
  'bin/verify.js',
];

export default [
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'dist-android/**',
      'android/**',
      'website/**',
      'vps/**',
      'build/**',
      'app/src/scripts/trystero-bundle.js',
      'app/src/sidecar/**/build/**',
      'app/src/sidecar/**/experimental/**',
    ],
  },
  js.configs.recommended,
  {
    // Browser-context scripts, loaded via <script> tags from app/src/pages/*.html
    // — not modules, so functions/vars are intentionally global. `module`/
    // `require` are recognized too: host.js/viewer.js end with a guarded
    // `if (typeof module !== 'undefined') module.exports = {...}` shim purely
    // for Vitest (see app/test/helpers/browser-shims.js) — inert in the browser.
    files: ['app/src/scripts/host.js', 'app/src/scripts/viewer.js', 'app/src/scripts/chat.js', 'app/src/scripts/dashboard.js', 'app/src/scripts/client-only-mode.js', 'app/src/scripts/viewer-page-bootstrap.js', 'app/src/scripts/host-minimal-tunnel-commands.js', 'app/src/scripts/audio-mixing.js', 'app/src/scripts/stats-hud.js', 'app/src/scripts/arcade-registration.js', 'app/src/scripts/tunnel-modal.js', 'app/src/scripts/vps-sfu.js', 'app/src/scripts/capture.js', 'app/src/scripts/webcodecs-encoder.js', 'app/src/scripts/webcodecs-decoder.js', 'app/src/scripts/p2p-viewer.js', 'app/src/scripts/webrtc/**/*.js', 'app/src/scripts/ui/**/*.js', 'app/src/scripts/input/**/*.js', 'app/src/scripts/i18n.js', 'app/src/scripts/audio-util.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: { ...globals.browser, module: 'writable', require: 'readonly', exports: 'writable' },
    },
  },
  {
    // Loaded via <script type="module"> — real ESM, unlike the plain globals above.
    files: ['app/src/scripts/p2p-signaler.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser },
    },
  },
  {
    // Node-context: Electron main/preload, the Express/WS server, sidecar daemons.
    files: ['app/electron-*.js', 'app/electron/**/*.js', 'extract-text.js', 'app/src/scripts/server.js', 'app/src/scripts/server/**/*.js', 'app/src/sidecar/**/*.js', 'bin/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
  },
  {
    // Phase 9 deny-list — see legacyDebtFiles above. Applied after the
    // context blocks so it only downgrades severity for files still on the
    // list; every other file (including all new ones) stays at 'error'.
    files: legacyDebtFiles,
    rules: legacyRuleOverrides,
  },
  {
    // Vitest test files/helpers — run under Node but exercise a jsdom global
    // environment (document/window/etc.), so both global sets apply. Kept at
    // full 'error' severity since this is new code, not legacy debt.
    files: ['app/test/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
  },
  prettier,
];
