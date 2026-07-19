'use strict';
// Forked child process that owns the capture_linux native addon (see
// capture-linux.cc's header comment for this addon's build/runtime caveats
// on this fork). Talks to its parent purely over process.send()/'message' —
// kept as a separate process so a DRM/mmap crash can't take down Electron's
// main process, matching the isolation input_backends' native addons use.
const path = require('path');
const fs = require('fs');

const FRAME_FILE = '/tmp/nearcade-drm-frame.raw';
let cap = null;

try {
  cap = require(path.join(__dirname, 'build/Release/capture_linux'));
} catch (e) {
  process.send({ type: 'error', message: 'Failed to load capture addon: ' + e.message });
  process.exit(1);
}

try {
  const result = cap.startCapture(0);
  if (!result) {
    process.send({ type: 'error', message: 'startCapture returned no result' });
    process.exit(1);
  }
  process.send({ type: 'ready', width: result.width, height: result.height });
} catch (e) {
  process.send({ type: 'error', message: e.message || String(e) });
  process.exit(1);
}

process.on('message', (msg) => {
  if (!cap) return;
  if (msg.type === 'get-frame') {
    try {
      const buf = cap.getFrame();
      if (buf && buf.byteLength > 0) {
        fs.writeFileSync(FRAME_FILE, buf);
        process.send({ type: 'frame', path: FRAME_FILE, size: buf.byteLength, reqId: msg.reqId });
      } else {
        process.send({ type: 'frame', data: null, reqId: msg.reqId });
      }
    } catch (e) {
      process.send({ type: 'frame', data: null, error: e.message, reqId: msg.reqId });
    }
  } else if (msg.type === 'stop') {
    try {
      cap.stopCapture();
    } catch {
      // Process is exiting either way — a native-side teardown error here isn't actionable.
    }
    try {
      fs.unlinkSync(FRAME_FILE);
    } catch {
      // Frame file may never have been written (e.g. capture failed immediately) — fine either way.
    }
    cap = null;
    process.exit(0);
  }
});
