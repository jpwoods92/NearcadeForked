import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['app/test/**/*.test.js'],
    setupFiles: ['./app/test/helpers/vitest-setup.js'],
  },
});

// Note: jsdom logs "Not implemented: HTMLCanvasElement's getContext()" to its
// internal virtual console (bypassing Vitest's console capture) once per
// viewer.js load, since the optional `canvas` npm package isn't installed.
// viewer.js already null-checks the returned context, so this is harmless
// noise in test output, not a failure.
