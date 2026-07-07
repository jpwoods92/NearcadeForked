// Vitest `setupFiles` entry — runs once per test file, before that file's own
// module graph (including any static `import`s of src/scripts/**) is
// evaluated. Some src/scripts/ files (e.g. webrtc/codec-negotiation.js) read
// `localStorage` at module top level, not just inside functions, so a test
// file that imports them directly (rather than via browser-shims.js's
// loadHost()/loadViewer()) needs the stub installed before that import runs,
// not inside a beforeEach.
import { installStorageStubs } from './browser-shims.js';
installStorageStubs();
