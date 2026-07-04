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
      'src/scripts/trystero-bundle.js',
      'src/scripts/trystero-torrent.min.js',
      'src/sidecar/**/build/**',
      'src/sidecar/**/experimental/**',
    ],
  },
  js.configs.recommended,
  {
    // Browser-context scripts, loaded via <script> tags from src/pages/*.html
    // — not modules, so functions/vars are intentionally global. `module`/
    // `require` are recognized too: host.js/viewer.js end with a guarded
    // `if (typeof module !== 'undefined') module.exports = {...}` shim purely
    // for Vitest (see test/helpers/browser-shims.js) — inert in the browser.
    files: ['src/scripts/host.js', 'src/scripts/viewer.js', 'src/scripts/i18n.js', 'src/scripts/audio-util.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: { ...globals.browser, module: 'writable', require: 'readonly', exports: 'writable' },
    },
    rules: legacyRuleOverrides,
  },
  {
    // Loaded via <script type="module"> — real ESM, unlike the plain globals above.
    files: ['src/scripts/p2p-signaler.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser },
    },
    rules: legacyRuleOverrides,
  },
  {
    // Node-context: Electron main/preload, the Express/WS server, sidecar daemons.
    files: ['electron-*.js', 'extract-text.js', 'src/scripts/server.js', 'src/sidecar/**/*.js', 'bin/**/*.js'],
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
    files: ['test/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
  },
  prettier,
];
