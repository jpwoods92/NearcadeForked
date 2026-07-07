import js from '@eslint/js';
import globals from 'globals';
import prettier from 'eslint-config-prettier';

// Phase 0 of REFACTOR_PLAN.md: scoped deliberately to the files we're about to
// add tests around (src/scripts/, electron-*.js, src/sidecar/). Widen the
// `files` globs below as later refactor phases touch more of the tree.
//
// This is a legacy codebase with no prior linting, so a first `eslint .` run
// surfaces hundreds of pre-existing findings (unused vars, empty catch
// blocks, a few real no-undef typos). Failing CI on all of that immediately
// isn't useful — these rules are downgraded to 'warn' on existing source so
// CI can still gate genuinely new problems. Ratchet individual rules back to
// 'error' file-by-file as each area gets cleaned up in later refactor phases
// (see REFACTOR_PLAN.md), rather than fixing everything at once here.
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
    rules: legacyRuleOverrides,
  },
  {
    // Loaded via <script type="module"> — real ESM, unlike the plain globals above.
    files: ['app/src/scripts/p2p-signaler.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser },
    },
    rules: legacyRuleOverrides,
  },
  {
    // Node-context: Electron main/preload, the Express/WS server, sidecar daemons.
    files: ['app/electron-*.js', 'app/electron/**/*.js', 'extract-text.js', 'app/src/scripts/server.js', 'app/src/scripts/server/**/*.js', 'app/src/sidecar/**/*.js', 'bin/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
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
