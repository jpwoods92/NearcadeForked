// Shared stubs for loading NearsecTogether's browser-only scripts
// (src/scripts/host.js, viewer.js) under Node for characterization tests.
//
// These files are plain <script>-tag globals, not modules — they assume a
// full browser environment (Pusher, I18N, WebSocket, RTCRtpReceiver, DOM
// elements with specific ids) exists before they run. This helper builds the
// minimum stub surface + DOM fixture needed for each file to load top-to-
// bottom without throwing, without changing anything about the files under
// test. Vitest's `environment: 'jsdom'` (vitest.config.mjs) already provides
// global.document/window/location before this runs.

/** host.js calls `new Pusher(...)`, `.subscribe()`, `.bind()` at module top
 * level. Real Pusher is loaded from a CDN <script> tag in the app. */
function installPusherStub() {
  global.Pusher = function Pusher() {
    return {
      subscribe: () => ({ bind: () => {} }),
      connection: { bind: () => {} },
    };
  };
  global.Pusher.logToConsole = false;
}

/** host.js/viewer.js call I18N.t(msg) as a passthrough translation lookup. */
function installI18nStub() {
  global.I18N = { t: (msg) => msg };
}

/** viewer.js fetches TURN credentials at module top level; keep it off the network. */
function installFetchStub() {
  global.fetch = () => Promise.reject(new Error('network disabled in test'));
}

/** Minimal in-memory Storage polyfill. Neither Node's own experimental
 * `localStorage` global nor this jsdom/vitest combination reliably expose a
 * working Storage object, so we provide our own rather than depend on either. */
function makeMemoryStorage() {
  const data = new Map();
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
    clear: () => data.clear(),
  };
}

function installStorageStubs() {
  global.localStorage = makeMemoryStorage();
  global.sessionStorage = makeMemoryStorage();
}

/** host.js/viewer.js call chat.js's and webrtc/peer-connection.js's helpers
 * as plain globals — in the browser that works because all are non-module
 * <script> tags sharing one global scope (loaded before host.js/viewer.js).
 * Under Node's require(), each file gets its own module scope, so we load
 * them once and copy their exports onto Node's `global` to reproduce that
 * shared-global-script behavior. */
function installSharedScriptGlobals() {
  for (const modPath of [
    '../../src/scripts/signaling.js',
    '../../src/scripts/emoji-data.js',
    '../../src/scripts/chat.js',
    '../../src/scripts/webrtc/peer-connection.js',
    '../../src/scripts/webrtc/codec-negotiation.js',
    '../../src/scripts/ui/modals.js',
    '../../src/scripts/ui/roster.js',
    '../../src/scripts/audio-mixing.js',
    '../../src/scripts/stats-hud.js',
    '../../src/scripts/arcade-registration.js',
    '../../src/scripts/tunnel-modal.js',
    '../../src/scripts/vps-sfu.js',
    '../../src/scripts/capture.js',
    '../../src/scripts/webcodecs-encoder.js',
    '../../src/scripts/webcodecs-decoder.js',
    '../../src/scripts/input/gamepad.js',
    '../../src/scripts/p2p-viewer.js',
  ]) {
    delete require.cache[require.resolve(modPath)];
    Object.assign(global, require(modPath));
  }
}

const HOST_FIXTURE = `
  <div id="log"></div>
  <div id="lastLogLine"></div>
  <div id="chatLog"></div>
  <input id="chatMsg">
  <select id="codecSelect"><option value="H264" selected>H264</option></select>
`;

const VIEWER_FIXTURE = `
  <input id="nameInput">
  <div id="log"></div>
  <div id="lastLogLine"></div>
  <div id="chatLog"></div>
  <input id="chatMsg">
  <div id="statsHud"></div>
  <div id="netStatsOverlay" class="gone">
    <span id="nsPing"></span><span id="nsCodec"></span><span id="nsBitrate"></span>
    <span id="nsRes"></span><span id="nsFps"></span><span id="nsDecode"></span>
    <span id="nsLoss"></span><span id="nsJitter"></span>
  </div>
  <video id="video"></video>
  <canvas id="frameCanvas"></canvas>
`;

/** Requires src/scripts/host.js fresh, with stubs + fixture installed first. */
function loadHost() {
  installPusherStub();
  installI18nStub();
  installStorageStubs();
  // Fixture must exist before installSharedScriptGlobals() — some shared
  // scripts (e.g. stats-hud.js) capture `document.getElementById(...)`
  // results in a top-level `const`, same as they'd do in a real page where
  // the DOM is already parsed before any <script> tag runs.
  document.body.innerHTML = HOST_FIXTURE;
  installSharedScriptGlobals();
  delete require.cache[require.resolve('../../src/scripts/host.js')];
  return require('../../src/scripts/host.js');
}

/** Requires src/scripts/viewer.js fresh, with stubs + fixture installed first. */
function loadViewer() {
  installPusherStub();
  installI18nStub();
  installFetchStub();
  installStorageStubs();
  document.body.innerHTML = VIEWER_FIXTURE;
  installSharedScriptGlobals();
  delete require.cache[require.resolve('../../src/scripts/viewer.js')];
  return require('../../src/scripts/viewer.js');
}

module.exports = { loadHost, loadViewer, HOST_FIXTURE, VIEWER_FIXTURE, installStorageStubs };
