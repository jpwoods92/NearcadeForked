const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const crypto = require('crypto');
require('dotenv').config();

// hashIp() now lives in ./server/ws.js (its only caller, /ws/viewer's PIN
// rate-limiting, moved there too). Same for the `os` module -- every
// os.* call that used to live here moved into env.js/network-info.js.
const state = require('./server/state.js');
const { attachWebSocketServer } = require('./server/ws.js');
const { registerHttpRoutes } = require('./server/http.js');
const serverEnv = require('./server/env.js');
const serverNetwork = require('./server/network-info.js');
// toUinput is re-exported below for electron-main.js; normalizeGamepadMsg
// isn't needed here anymore -- ws.js requires input-bridge.js directly.
const { toUinput } = require('./server/input-bridge.js');
const {
  startTunnelCloudflared,
  startTunnelVps,
  startTunnelPlayit,
  startTunnelLocalhostRun,
  startTunnelServeo,
  startTunnelZrok,
  startTunnel,
} = require('./server/tunnel.js');
// Only stopArcadeHeartbeatWorker is needed here (cleanup()) -- the rest of
// this module's exports moved into ws.js/http.js along with the routes and
// WS handlers that used them.
const { stopArcadeHeartbeatWorker } = require('./server/arcade-signaling.js');
const { wivrnEnsureRunning, wivrnShutdown } = require('./server/wivrn-lifecycle.js');

// --- STREAMER PRIVACY SCRUBBER ---
const _origLog = console.log;
console.log = function (...args) {
  let msg = args
    .map((a) => {
      if (typeof a === 'string') return a;
      try {
        return JSON.stringify(a, null, 2);
      } catch (_) {
        return String(a);
      }
    })
    .join(' ');

  // Blur IPv4 addresses (except localhost)
  msg = msg.replace(/\b(?!127\.0\.0\.1)(?:\d{1,3}\.){3}\d{1,3}\b/g, '***.***.***.***');

  // Blur Cloudflare tunnel URLs
  msg = msg.replace(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/g, 'https://********.trycloudflare.com');

  // Blur Zrok / Playit / localhost.run / serveo URLs
  msg = msg.replace(
    /https:\/\/[a-zA-Z0-9-]+\.(share\.zrok\.io|playit\.gg|lhr\.life|serveo\.net)/g,
    'https://********.$1'
  );

  // Blur VPS SSH strings
  msg = msg.replace(/([a-zA-Z0-9_-]+@\*\*\*\.\*\*\*\.\*\*\*\.\*\*\*)/g, '********@***.***.***.***');

  // Blur VPS Master Key (64-char hex)
  msg = msg.replace(/("?vpsMasterKey"?\s*:\s*['"]?)[a-fA-F0-9]{64}(['"]?)/g, '$1********$2');

  // Blur Session Password
  msg = msg.replace(/("?sessionPassword"?\s*:\s*['"]?)[^'"\s,]+(['"]?)/g, '$1********$2');

  // Blur global PIN. NOTE: before this file's state consolidation, `PIN` was
  // a `let` declared inside main() and unreachable from this module-level
  // scrubber — `typeof PIN !== 'undefined'` was always false, so this
  // redaction never actually fired. Routing through the shared `state`
  // module makes it reachable, so it now genuinely redacts the PIN from
  // logs — an accidental (and welcome) side effect of the refactor, not a
  // deliberate behavior change.
  if (typeof state.session.pin !== 'undefined' && state.session.pin) {
    msg = msg.replace(new RegExp(state.session.pin, 'g'), '****');
  }

  _origLog.call(console, msg);
};

const killPort = require('kill-port');
// activePort/hostWS/tunnelUrl/activeTunnelProc/audioProc/vidCount and the
// viewers/viewerNames/inputPerms/pinAttempts registries all live in
// ./server/state.js now (shared mutable state so ws.js/http.js can both
// reach them once those are extracted). uinputProc was dead code — declared
// but never read anywhere — so it's dropped rather than moved. sidecarPath
// and isPackaged (both `__dirname.includes('app.asar')` computations) were
// also unused here -- pre-existing dead code (isPackaged was actually used
// before the audio-routing.js extraction, which now computes its own copy
// locally instead of receiving it from server.js; sidecarPath was already
// dead before Phase 3 touched this file at all).

const inputDriver = require('../sidecar/input_backends/InputOrchestrator.js');
const experimentalDriver = require('../sidecar/input_backends/experimental/ExperimentalOrchestrator.js');
// Prevents cleanup() running twice (e.g. SIGINT fires then process.exit fires)
let _cleanupDone = false;

// Virtual audio worker management (spawn/init/route/destroy, all pactl/pw-cli
// shell-outs) lives in ./server/audio-routing.js now.
// routeGameAudio/stopRouting aren't needed here anymore -- http.js and ws.js
// each require audio-routing.js directly for those now.
const { initVirtualAudio, destroyVirtualAudio } = require('./server/audio-routing.js');

// Call it on boot
// ── Venmic must init BEFORE virtual audio so pb is ready when the sink
// appears in the PipeWire graph. initVirtualAudio() is async — we start it
// here but let venmic load synchronously first.

// Now create the sink — venmic is already listening to the PipeWire graph
initVirtualAudio();

// Pusher setup, the arcade heartbeat worker, and the arcade session registry
// all live in ./server/arcade-signaling.js now (it spawns the heartbeat
// worker on require(), same as this code used to run inline here).

// toUinput() and normalizeGamepadMsg() live in ./server/input-bridge.js now.

// Data dir, .env bootstrap/parsing, config symlink, and load/saveConfig all
// live in ./server/env.js now — it runs its setup on require(), same as this
// code used to run inline here.
// saveConfig isn't needed here anymore -- http.js requires env.js directly.
const { loadConfig, getAppVersionInfo } = serverEnv;
const { getLanIP, findFreePort, openBrowser, getPublicIP } = serverNetwork;

// Binary-path resolution and all tunnel provider functions live in
// ./server/tunnel.js now.
function sanitize(str) {
  return String(str)
    .replace(
      /[<>&"'`]/g,
      (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;', '`': '&#96;' })[c]
    )
    .slice(0, 300);
}
function makePin() {
  return String(crypto.randomInt(1000, 10000));
}

// arcadeSessions/arcadeClients/broadcastToArcade/isAllowedArcadeUrl all live
// in ./server/arcade-signaling.js now.

// loadConfig()/saveConfig() live in ./server/env.js now.

async function main() {
  // ── Platform Detection & Warnings ──────────────────────────────────────────
  console.log('');
  if (process.platform === 'win32') {
    console.log('============================================================');
    console.log('  WINDOWS - EXPERIMENTAL MODE');
    console.log('============================================================');
    console.log('  GAMEPAD:  Requires ViGEmBus driver');
    console.log('            https://github.com/nefarius/ViGEmBus/releases');
    console.log('  INPUT:    KBM (keyboard/mouse) working');
    console.log('  AUDIO:    No loopback capture available natively');
    console.log('  NOTES:    Process priority may be limited without admin');
    console.log('============================================================');
  } else if (process.platform === 'darwin') {
    console.log('============================================================');
    console.log('  macOS - EXPERIMENTAL MODE');
    console.log('============================================================');
    console.log('  GAMEPAD:  NOT SUPPORTED (no injection API on macOS)');
    console.log('  INPUT:    KBM only (keyboard/mouse via pyautogui)');
    console.log('  AUDIO:    Using afplay (native)');
    console.log('  SETUP:    pip3 install pyautogui');
    console.log('============================================================');
  } else if (process.platform === 'linux') {
    console.log('✓ Linux - Fully supported (stable)');
  }
  console.log('');

  state.runtime.activePort = await findFreePort(3000);
  state.serverInfo.lanIp = getLanIP();
  state.serverInfo.publicIp = await getPublicIP();
  const initialCfg = loadConfig();
  state.session.sessionPassword = initialCfg.persistentPassword || '';
  state.session.pin = state.session.sessionPassword ? state.session.sessionPassword : makePin();
  state.session.pinEnabled = true;

  console.log('\n  \x1b[1mNearcade\x1b[0m');
  console.log('  Host page : http://localhost:' + state.runtime.activePort + '/host');
  console.log('  LAN URL   : http://***.***.***.***:' + state.runtime.activePort + '/');
  if (state.serverInfo.publicIp)
    console.log('  Public IP : http://***.***.***.***:' + state.runtime.activePort + '/ (needs port forward)');
  console.log('  PIN       : \x1b[1;32m****\x1b[0m\n');

  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocket.Server({
    server,
    perMessageDeflate: false,
    // WebCodecs keyframes tunnel over this same signaling socket as a
    // TCP-only fallback when the WebRTC DataChannel can't be established
    // (see webcodecs-encoder.js broadcastToViewers) and are sent unchunked,
    // unlike the DataChannel path — a keyframe easily exceeds the old 1MB
    // cap at real streaming resolutions/bitrates. This is trusted local/
    // tunnel traffic, not attacker-facing, so size it generously instead.
    maxPayload: 16 * 1024 * 1024,
    verifyClient: (info, cb) => {
      const origin = info.origin || info.req.headers['origin'] || '';
      if (!origin || origin === 'null') {
        cb(true);
        return;
      }
      try {
        const u = new URL(origin);
        if (u.protocol === 'http:' || u.protocol === 'https:') {
          cb(true);
        } else {
          cb(false, 403, 'Origin not allowed');
        }
      } catch {
        cb(false, 403, 'Origin not allowed');
      }
    },
  });

  const _versionInfo = getAppVersionInfo();
  state.serverInfo.appVersion = _versionInfo.version;
  state.serverInfo.commitHash = _versionInfo.commit;

  // Every Express route/middleware (CORS headers, static file serving,
  // /api/* routes, /favicon.ico, host page routes) now lives in
  // ./server/http.js.
  registerHttpRoutes(app, { makePin });

  // Input driver wiring, rumble forwarding, and the whole wss.on("connection")
  // handler (host/viewer/arcade/audio/input WS paths) + heartbeat now live in
  // ./server/ws.js.
  attachWebSocketServer(wss, { sanitize, makePin });

  server.listen(state.runtime.activePort, async () => {
    console.log('Listening on port ' + state.runtime.activePort);
    if (!process.env.ELECTRON_MODE) openBrowser('http://localhost:' + state.runtime.activePort + '/host');

    const cfg = loadConfig();

    if (process.env.USE_VPS === 'true' && process.env.VPS_HOST) {
      console.log('  ~ Tunnel: VPS (from .env)');
      const tun = await startTunnelVps(state.runtime.activePort, process.env.VPS_HOST.trim());
      if (tun) {
        state.runtime.tunnelUrl = tun.url;
        state.runtime.activeTunnelProc = tun.proc;
        if (state.runtime.hostWS && state.runtime.hostWS.readyState === 1)
          state.runtime.hostWS.send(JSON.stringify({ type: 'tunnel-url', url: state.runtime.tunnelUrl }));
      } else {
        console.log(`  \x1b[31m~\x1b[0m VPS Tunnel failed to start on boot.`);
        if (state.runtime.hostWS && state.runtime.hostWS.readyState === 1)
          state.runtime.hostWS.send(JSON.stringify({ type: 'tunnel-error', provider: 'vps' }));
      }
    } else if (cfg.tunnelProvider === 'vps-sfu') {
      // VPS SFU mode — the host app manages its own WebSocket to the Rust router.
      // The local server must NOT start any tunnel process. The domain is defined
      // by the user's saved VPS URL, not by any local tunnel provider.
      console.log('  \x1b[36m~\x1b[0m Tunnel: VPS SFU mode (managed by host app — no local tunnel started)');
      // Do NOT modify tunnelProvider or neverAsk here.
    } else if (cfg.tunnelProvider === 'p2p') {
      console.log('  \x1b[36m~\x1b[0m Tunnel: P2P mode (managed by host app — no local tunnel started)');
    } else if (cfg.neverAsk && cfg.tunnelProvider === 'portforward') {
      console.log('  ~ Tunnel: port forward mode (saved).');
    } else if (cfg.neverAsk && cfg.tunnelProvider) {
      console.log("  ~ Tunnel: using saved provider '" + cfg.tunnelProvider + "'");

      const fn =
        {
          zrok: startTunnelZrok,
          cloudflared: startTunnelCloudflared,
          playit: startTunnelPlayit,
          localhostrun: startTunnelLocalhostRun,
          serveo: startTunnelServeo,
          vps: (p) => startTunnelVps(p, cfg.vpsHost || process.env.VPS_HOST || ''),
        }[cfg.tunnelProvider] || startTunnel;

      const tun = await fn(state.runtime.activePort);
      if (tun) {
        state.runtime.tunnelUrl = tun.url;
        state.runtime.activeTunnelProc = tun.proc;
        if (state.runtime.hostWS && state.runtime.hostWS.readyState === 1)
          state.runtime.hostWS.send(JSON.stringify({ type: 'tunnel-url', url: state.runtime.tunnelUrl }));
      } else {
        console.log(`  \x1b[31m~\x1b[0m Tunnel provider '${cfg.tunnelProvider}' failed to start on boot.`);
        if (state.runtime.hostWS && state.runtime.hostWS.readyState === 1)
          state.runtime.hostWS.send(JSON.stringify({ type: 'tunnel-error', provider: cfg.tunnelProvider }));
      }
    } else {
      console.log('  ~ Tunnel: waiting for host to choose provider...');
    }

    // Auto-start WiVRn server on boot (no-op if the binary isn't installed)
    console.log('[WiVRn] Auto-starting WiVRn server...');
    wivrnEnsureRunning().then((running) => {
      if (running) console.log('[WiVRn] WiVRn server ready');
    });

    // Periodically fetch the global ban list from the arcade directory
    if (cfg.modEndpoint) {
      const syncBans = async () => {
        try {
          const modCfg = loadConfig();
          if (!modCfg.modEndpoint || !modCfg.modSecret) return;
          let endpoint = modCfg.modEndpoint;
          if (!endpoint.startsWith('http://') && !endpoint.startsWith('https://')) endpoint = 'https://' + endpoint;
          const res = await fetch(endpoint, { headers: { Authorization: `Bearer ${modCfg.modSecret}` } });
          if (!res.ok) return;
          const list = await res.json();
          if (!Array.isArray(list)) return;
          state.bannedIps.clear();
          const now = Date.now();
          for (const ip of list) {
            const hash = crypto.createHash('sha256').update(ip).digest('hex');
            state.bannedIps.set(hash, { bannedAt: now, expiresAt: now + 86400000, reason: 'remote-ban' });
          }
          console.log(`[bans] Synced ${list.length} banned IP(s) from directory`);
        } catch (_) {
          /* directory unreachable — retry next interval */
        }
      };
      syncBans();
      setInterval(syncBans, 300000).unref(); // every 5 minutes
    }
  });
}

main();

function cleanup(isElectron = false) {
  if (_cleanupDone) return;
  _cleanupDone = true;

  console.log('\n[server] Shutting down — running cleanup...');
  console.debug('[server] Cleanup stack:', new Error().stack?.split('\n').slice(2).join('\n'));

  // ── Terminate worker threads gracefully ──────────────────────────────────
  // Audio worker teardown (postMessage 'destroy' + delayed terminate, plus
  // the pactl/pw-cli belt-and-braces cleanup below) lives in
  // ./server/audio-routing.js now.
  destroyVirtualAudio();

  // Arcade heartbeat worker: clean shutdown
  stopArcadeHeartbeatWorker();

  // Stop WiVRn (clears the inactivity timer too)
  wivrnShutdown();

  if (state.runtime.activeTunnelProc) {
    try {
      state.runtime.activeTunnelProc.kill();
    } catch (_) {}
  }
  if (state.runtime.activeTunnelProc) {
    try {
      state.runtime.activeTunnelProc.kill();
    } catch (_) {}
  }

  // Cleanly destroy the input driver (whether it's using C++ or Python)
  try {
    inputDriver.destroy();
    experimentalDriver.destroy();
  } catch (e) {
    console.error('[Server] Input driver cleanup error:', e);
  }

  if (state.runtime.audioProc) {
    try {
      state.runtime.audioProc.kill();
    } catch (_) {}
  }

  if (!isElectron) {
    killPort(state.runtime.activePort)
      .catch(() => {})
      .finally(() => process.exit(0));
  } else {
    killPort(state.runtime.activePort).catch(() => {});
  }
}

process.on('SIGINT', () => cleanup(false));
process.on('SIGTERM', () => cleanup(false));

process.on('uncaughtException', (err) => {
  console.error('[server] Uncaught exception during runtime:', err);
  cleanup(false);
});

module.exports = { cleanup, toUinput };
