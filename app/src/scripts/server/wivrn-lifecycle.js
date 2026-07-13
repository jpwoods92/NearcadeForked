'use strict';
// ── WiVRn LIFECYCLE (upstream v3.0.2) ────────────────────────────────────────
// Supervision for the WiVRn VR streaming server: on-demand start when a
// viewer enters VR mode, and auto-shutdown after 10s without VR tracking
// data. The D-Bus/process plumbing lives in sidecar/wivrn-integration.js;
// this module just owns the activity timer, mirroring the pattern of the
// other server/* lifecycle helpers.

const wivrnInt = require('../../sidecar/wivrn-integration.js');

const WIVRN_VR_TIMEOUT_MS = 10000;
let _vrActivityTimer = null;

/** Reset the inactivity timer — call on every incoming VR tracking packet. */
function wivrnBumpVrActivity() {
  if (_vrActivityTimer) clearTimeout(_vrActivityTimer);
  _vrActivityTimer = setTimeout(() => {
    console.log('[WiVRn] No VR data for 10s — shutting down WiVRn');
    wivrnInt.stopServer();
  }, WIVRN_VR_TIMEOUT_MS);
  _vrActivityTimer.unref?.();
}

async function wivrnEnsureRunning() {
  if (wivrnInt._isServerOnBus()) return true;
  const result = await wivrnInt.startServer();
  if (!result.ok) {
    console.log('[WiVRn] Failed to start:', result.message);
    return false;
  }
  console.log('[WiVRn] Server started on D-Bus');
  return true;
}

/** Shutdown hook for server.js cleanup(). */
function wivrnShutdown() {
  if (_vrActivityTimer) clearTimeout(_vrActivityTimer);
  try {
    wivrnInt.stopServer();
  } catch {
    /* already down */
  }
}

module.exports = { wivrnBumpVrActivity, wivrnEnsureRunning, wivrnShutdown, wivrnInt };
