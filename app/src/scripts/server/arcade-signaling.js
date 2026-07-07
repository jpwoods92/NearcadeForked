'use strict';
const path = require('path');
const { Worker } = require('worker_threads');
const PusherRaw = require('pusher-js');

// ── Bulletproof Electron/Node Module Extractor ──
let Pusher;
if (typeof PusherRaw === 'function') {
  Pusher = PusherRaw;
} else if (PusherRaw && typeof PusherRaw.Pusher === 'function') {
  Pusher = PusherRaw.Pusher;
} else if (PusherRaw && typeof PusherRaw.default === 'function') {
  Pusher = PusherRaw.default;
} else {
  console.error('PUSHER DIAGNOSTIC:', PusherRaw);
  Pusher = class DummyPusher {
    subscribe() {
      return { trigger: () => {} };
    }
  };
}

// This app key/cluster/authEndpoint and the 'private-arcade-global' channel
// name are also hardcoded client-side in app/src/scripts/arcade-registration.js
// — there's no shared-constants module linking them today since one runs in
// Node and the other in the browser with no bundler between them. Keep both
// in sync by hand if either changes. See REFACTOR_PLAN.md Phase 5.7.
const pusher = new Pusher('a93f5405058cd9fc7967', {
  cluster: 'us2',
  authEndpoint: 'https://nearsec.cutefame.net/api/pusher-auth',
});

const globalArcadeChannel = pusher.subscribe('private-arcade-global');

// ── Arcade Heartbeat Worker ───────────────────────────────────────────────────
// All arcadePingInterval / Pusher sync loops run in a dedicated thread so they
// can never delay the signaling event loop, even under heavy load.
let _arcadeWorker = null;

function spawnArcadeHeartbeatWorker() {
  _arcadeWorker = new Worker(path.join(__dirname, '..', '..', 'sidecar', 'arcade_heartbeat_worker.js'), {
    workerData: { syncIntervalMs: 30_000, pingIntervalMs: 25_000 },
  });

  _arcadeWorker.on('message', (msg) => {
    switch (msg.type) {
      case 'log':
        console.log(msg.message);
        break;
      case 'error':
        console.error(msg.message);
        break;

      // Worker asks main thread to fire the Pusher trigger
      // (pusher-js channels must live on the thread that owns the WebSocket)
      case 'pusher-trigger':
        try {
          if (typeof globalArcadeChannel !== 'undefined') {
            globalArcadeChannel.trigger(msg.event, msg.data);
          }
        } catch (e) {
          console.warn('[arcade_heartbeat] Pusher trigger failed:', e.message);
        }
        break;
    }
  });

  _arcadeWorker.on('error', (e) => console.error('[arcade_heartbeat] Runtime error:', e.message));
  _arcadeWorker.on('exit', (code) => {
    if (code !== 0) console.warn(`[arcade_heartbeat] Exited with code ${code}`);
    _arcadeWorker = null;
  });
}

// Helper — post to arcade worker only when it's alive
function _arcadePost(msg) {
  if (_arcadeWorker) _arcadeWorker.postMessage(msg);
}

// PUBLIC — clean shutdown for cleanup() to call instead of reaching into
// the worker reference directly (it's private to this module now).
function stopArcadeHeartbeatWorker() {
  if (_arcadeWorker) {
    try {
      _arcadeWorker.postMessage({ type: 'stop' });
    } catch (_) {}
    setTimeout(() => {
      try {
        _arcadeWorker && _arcadeWorker.terminate();
      } catch (_) {}
    }, 500);
  }
}

// Boot the worker immediately (it idles quietly until a session goes active)
spawnArcadeHeartbeatWorker();

// ── Arcade session registry ───────────────────────────────────────────────────
const arcadeSessions = new Map();
const arcadeClients = new Set();
let arcadeHostId = 0;
function nextArcadeHostId() {
  return ++arcadeHostId;
}

const ARCADE_ALLOWED_DOMAINS = ['trycloudflare.com', 'zrok.io', 'localhost.run', 'serveo.net'];
function isAllowedArcadeUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== 'https:') return false;
    return ARCADE_ALLOWED_DOMAINS.some((d) => u.hostname === d || u.hostname.endsWith('.' + d));
  } catch {
    return false;
  }
}
function broadcastToArcade(msg) {
  const data = JSON.stringify(msg);
  arcadeClients.forEach((c) => {
    if (c.readyState === 1) c.send(data);
  });
}

module.exports = {
  arcadeSessions,
  arcadeClients,
  nextArcadeHostId,
  ARCADE_ALLOWED_DOMAINS,
  isAllowedArcadeUrl,
  broadcastToArcade,
  _arcadePost,
  stopArcadeHeartbeatWorker,
};
