'use strict';
const path = require('path');
const fs = require('fs');
const { fork } = require('child_process');
const { ipcMain } = require('electron');

// DRM/KMS native capture addon (Wayland silent capture, bypassing
// xdg-desktop-portal) — see app/src/sidecar/capture/capture-linux.cc's
// header comment for this addon's build/runtime status on this fork.
// Runs in a forked child process (drm-worker.js) so a DRM/mmap crash can't
// take down the Electron main process, matching the isolation
// input_backends' native addons use.
//
// Ported from upstream (src/main/ipc.js's DRM capture section). Not called
// from anywhere yet — host.js's auto-capture-on-Wayland path would need to
// try window.electronAPI.drmCaptureStart() before falling back to the
// portal, matching upstream, but that's additional wiring beyond this IPC
// layer; see REFACTOR_PLAN.md-adjacent plan notes for why it's deferred.
function register() {
  let drmChild = null;
  let drmReady = false;
  let drmDims = null;
  let drmReqId = 0;
  const drmPending = new Map();

  function _drmSpawnWorker() {
    return new Promise((resolve, reject) => {
      const workerPath = path.join(__dirname, '..', '..', 'src', 'sidecar', 'capture', 'drm-worker.js');
      let child;
      try {
        child = fork(workerPath, [], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'], silent: true });
      } catch (e) {
        reject(new Error('Failed to spawn DRM worker: ' + e.message));
        return;
      }
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error('DRM worker timed out'));
      }, 8000);
      child.on('message', (msg) => {
        if (msg.type === 'ready') {
          clearTimeout(timeout);
          drmChild = child;
          drmReady = true;
          drmDims = msg;
          resolve({ width: msg.width, height: msg.height });
        } else if (msg.type === 'error') {
          clearTimeout(timeout);
          child.kill();
          reject(new Error(msg.message || 'DRM worker error'));
        } else if (msg.reqId !== undefined && drmPending.has(msg.reqId)) {
          const { resolve: r, timeout: t } = drmPending.get(msg.reqId);
          drmPending.delete(msg.reqId);
          clearTimeout(t);
          r(msg);
        }
      });
      child.on('exit', (code) => {
        clearTimeout(timeout);
        drmReady = false;
        drmChild = null;
        // Reject all pending requests
        for (const [, p] of drmPending) {
          clearTimeout(p.timeout);
          p.resolve({ type: 'error', error: 'DRM worker exited' });
        }
        drmPending.clear();
        if (!drmReady) reject(new Error('DRM worker exited with code ' + code));
      });
      child.on('error', (err) => {
        clearTimeout(timeout);
        drmReady = false;
        drmChild = null;
        for (const [, p] of drmPending) {
          clearTimeout(p.timeout);
          p.resolve({ type: 'error', error: err.message });
        }
        drmPending.clear();
        reject(new Error('DRM worker error: ' + err.message));
      });
    });
  }

  ipcMain.handle('drm-capture-start', async () => {
    if (drmChild && drmReady && drmDims) return { width: drmDims.width, height: drmDims.height };
    try {
      return await _drmSpawnWorker();
    } catch (e) {
      console.error('[drm] Worker failed:', e.message);
      throw e;
    }
  });

  ipcMain.handle('drm-capture-get-frame', async () => {
    if (!drmChild || !drmReady) throw new Error('DRM capture not started');
    const reqId = ++drmReqId;
    const msg = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        drmPending.delete(reqId);
        reject(new Error('DRM get-frame timed out'));
      }, 5000);
      drmPending.set(reqId, { resolve, timeout });
      drmChild.send({ type: 'get-frame', reqId });
    });
    if (msg.type === 'frame' && msg.path) {
      // Frame data written to shared temp file by worker
      const buf = fs.readFileSync(msg.path);
      if (buf.byteLength !== msg.size) throw new Error('DRM frame size mismatch');
      return buf;
    }
    if (msg.type === 'frame') return msg.data || null;
    throw new Error(msg.error || 'DRM get-frame failed');
  });

  ipcMain.handle('drm-capture-stop', async () => {
    if (drmChild) {
      try {
        drmChild.send({ type: 'stop' });
      } catch (e) {
        console.warn('[drm] stop message failed, killing worker directly:', e.message);
      }
      const child = drmChild;
      setTimeout(() => {
        if (child) child.kill();
      }, 1000);
    }
    drmChild = null;
    drmReady = false;
    drmDims = null;
  });
}

module.exports = { register };
