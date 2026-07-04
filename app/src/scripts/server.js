const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const crypto = require('crypto');
require('dotenv').config();
const si = require('systeminformation');

// hashIp() now lives in ./server/ws.js (its only caller, /ws/viewer's PIN
// rate-limiting, moved there too).
const os = require("os");
const state = require('./server/state.js');
const { attachWebSocketServer } = require('./server/ws.js');
const serverEnv = require('./server/env.js');
const serverNetwork = require('./server/network-info.js');
const { toUinput, normalizeGamepadMsg } = require('./server/input-bridge.js');
const {
  startTunnelCloudflared, startTunnelVps, startTunnelPlayit,
  startTunnelLocalhostRun, startTunnelServeo, startTunnelZrok, startTunnel,
} = require('./server/tunnel.js');
const {
  arcadeSessions, arcadeClients, nextArcadeHostId, broadcastToArcade,
  _arcadePost, stopArcadeHeartbeatWorker,
} = require('./server/arcade-signaling.js');

// --- STREAMER PRIVACY SCRUBBER ---
const _origLog = console.log;
console.log = function (...args) {
  let msg = args.map(a => {
    if (typeof a === 'string') return a;
    try { return JSON.stringify(a, null, 2); } catch (_) { return String(a); }
  }).join(' ');
  
  // Blur IPv4 addresses (except localhost)
  msg = msg.replace(/\b(?!127\.0\.0\.1)(?:\d{1,3}\.){3}\d{1,3}\b/g, '***.***.***.***');
  
  // Blur Cloudflare tunnel URLs
  msg = msg.replace(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/g, 'https://********.trycloudflare.com');
  
  // Blur Zrok / Playit / localhost.run / serveo URLs
  msg = msg.replace(/https:\/\/[a-zA-Z0-9-]+\.(share\.zrok\.io|playit\.gg|lhr\.life|serveo\.net)/g, 'https://********.$1');
  
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

const fs = require("fs");
const path = require('path');
const sidecarPath = __dirname.includes('app.asar')
  ? path.join(process.resourcesPath, 'app.asar.unpacked', 'src', 'sidecar', 'input_driver.py')
  : path.join(__dirname, "..", "sidecar", "input_driver.py");
const { exec, spawn } = require("child_process");
const which = require("which");
const killPort = require("kill-port");
const captureManager = require('../sidecar/CaptureManager.js');
// activePort/hostWS/tunnelUrl/activeTunnelProc/audioProc/vidCount and the
// viewers/viewerNames/inputPerms/pinAttempts registries all live in
// ./server/state.js now (shared mutable state so ws.js/http.js can both
// reach them once those are extracted). uinputProc was dead code — declared
// but never read anywhere — so it's dropped rather than moved.

const isPackaged = __dirname.includes('app.asar');
const inputDriver = require('../sidecar/input_backends/InputOrchestrator.js');
const experimentalDriver = require('../sidecar/input_backends/experimental/ExperimentalOrchestrator.js');
// Prevents cleanup() running twice (e.g. SIGINT fires then process.exit fires)
let _cleanupDone = false;

// Virtual audio worker management (spawn/init/route/destroy, all pactl/pw-cli
// shell-outs) lives in ./server/audio-routing.js now.
const { initVirtualAudio, routeGameAudio, stopRouting, destroyVirtualAudio } = require('./server/audio-routing.js');

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
const { projectRoot, dataDir, loadConfig, saveConfig, readEnv, getAppVersionInfo } = serverEnv;
const { getLanIP, shouldRequirePin, getTailscaleIP, findFreePort, openBrowser, getPublicIP } = serverNetwork;

// Binary-path resolution and all tunnel provider functions live in
// ./server/tunnel.js now.
function sanitize(str) {
  return String(str).replace(/[<>&"']/g, c =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c])).slice(0, 300);
}
function makePin() { 
  return String(crypto.randomInt(1000, 10000));
}

// arcadeSessions/arcadeClients/broadcastToArcade/isAllowedArcadeUrl all live
// in ./server/arcade-signaling.js now.

// loadConfig()/saveConfig() live in ./server/env.js now.

async function main() {
  // ── Platform Detection & Warnings ──────────────────────────────────────────
  console.log("");
  if (process.platform === 'win32') {
    console.log("============================================================");
    console.log("  WINDOWS - EXPERIMENTAL MODE");
    console.log("============================================================");
    console.log("  GAMEPAD:  Requires ViGEmBus driver");
    console.log("            https://github.com/nefarius/ViGEmBus/releases");
    console.log("  INPUT:    KBM (keyboard/mouse) working");
    console.log("  AUDIO:    No loopback capture available natively");
    console.log("  NOTES:    Process priority may be limited without admin");
    console.log("============================================================");
  } else if (process.platform === 'darwin') {
    console.log("============================================================");
    console.log("  macOS - EXPERIMENTAL MODE");
    console.log("============================================================");
    console.log("  GAMEPAD:  NOT SUPPORTED (no injection API on macOS)");
    console.log("  INPUT:    KBM only (keyboard/mouse via pyautogui)");
    console.log("  AUDIO:    Using afplay (native)");
    console.log("  SETUP:    pip3 install pyautogui");
    console.log("============================================================");
  } else if (process.platform === 'linux') {
    console.log("✓ Linux - Fully supported (stable)");
  }
  console.log("");

  state.runtime.activePort = await findFreePort(3000);
  state.serverInfo.lanIp = getLanIP();
  state.serverInfo.publicIp = await getPublicIP();
  const initialCfg = loadConfig();
  state.session.sessionPassword = initialCfg.persistentPassword || '';
  state.session.pin = state.session.sessionPassword ? state.session.sessionPassword : makePin();
  state.session.pinEnabled = true;

  console.log("\n  \x1b[1mNearsecTogether\x1b[0m");
  console.log("  Host page : http://localhost:" + state.runtime.activePort + "/host");
  console.log("  LAN URL   : http://***.***.***.***:" + state.runtime.activePort + "/");
  if (state.serverInfo.publicIp) console.log("  Public IP : http://***.***.***.***:" + state.runtime.activePort + "/ (needs port forward)");
  console.log("  PIN       : \x1b[1;32m****\x1b[0m\n");

  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocket.Server({ server, perMessageDeflate: false });

  app.use((req, res, next) => {
    res.setHeader("Permissions-Policy", "gamepad=*, display-capture=(self)");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, HEAD, OPTIONS");
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  const _versionInfo = getAppVersionInfo();
  state.serverInfo.appVersion = _versionInfo.version;
  state.serverInfo.commitHash = _versionInfo.commit;
  app.use('/docs', express.static(path.join(__dirname, '..', '..', '..', 'assets', 'locales', 'docs')));

  // ── Dynamic version.js — always reflects package.json ──────────────────
  app.get('/js/version.js', (req, res) => {
    res.type('application/javascript');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.send(`window.NEARSEC_VERSION = "${state.serverInfo.appVersion}";\nwindow.NEARSEC_COMMIT = "${state.serverInfo.commitHash}";\nconsole.log("[Nearsec] Version loaded:", window.NEARSEC_VERSION, window.NEARSEC_COMMIT ? "("+window.NEARSEC_COMMIT+")" : "");`);
  });

  app.use("/js", express.static(path.join(__dirname, "..", "..", "src", "scripts"), { setHeaders: (res) => { res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate'); res.setHeader('Pragma', 'no-cache'); res.setHeader('Expires', '0'); } }));
  app.use("/assets", express.static(path.join(__dirname, "..", "..", "..", "assets")));

  const pagesDir = path.join(__dirname, "..", "..", "src/pages");

  // FIX: Serve the favicon explicitly so the browser finds it
  app.get("/favicon.ico", (req, res) => res.sendFile(path.join(projectRoot, "favicon.ico")));

  app.get("/", (req, res) => {
    const indexPath = path.join(pagesDir, "index.html");
    let html;
    try { html = fs.readFileSync(indexPath, "utf8"); } catch (_) { return res.sendFile(indexPath); }
    const sess = arcadeSessions.size > 0 ? [...arcadeSessions.values()][0] : null;

    // Grab the host name from the URL query, fallback to "A player"
    const hostName = req.query.host || "A player";

    // Inject the host name dynamically into the Discord tags
    const ogTitle = sess ? sess.game : `${hostName} is looking to play!`;
    const ogDesc = sess ? `Join the live ${sess.game} session on Nearsec.` : `${hostName} is hosting a peer-to-peer gaming session on Nearsec.`;
    const ogImage = (sess && sess.thumbnail) ? sess.thumbnail : "https://nearsec.cutefame.net/assets/NearsecTogetherLogo.png";

    html = html
      .replace(/(<meta property="og:title"\s+content=")[^"]*"/, `$1${ogTitle}"`)
      .replace(/(<meta property="og:description"\s+content=")[^"]*"/, `$1${ogDesc}"`)
      .replace(/(<meta property="og:image"\s+content=")[^"]*"/, `$1${ogImage}"`);
    res.type("html").send(html);
  });
  app.get("/dashboard", (req, res) => { res.setHeader('Content-Type', 'text/html'); res.sendFile(path.join(pagesDir, "dashboard.html")); });
  app.get("/host", (req, res) => { res.setHeader('Content-Type', 'text/html'); res.sendFile(path.join(pagesDir, "host.html")); });

  app.get("/host-minimal", (req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.sendFile(path.join(pagesDir, "host-minimal.html"));
  });
  app.get("/host-playground", (req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.sendFile(path.join(pagesDir, "host-playground.html"));
  });
  app.get("/host-custom", (req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.sendFile(path.join(pagesDir, "host-custom.html"));
  });
  app.get("/gamepad-popup.html", (req, res) => { res.setHeader('Content-Type', 'text/html'); res.sendFile(path.join(pagesDir, "gamepad-popup.html")); });
  app.use('/css', express.static(path.join(__dirname, '..', 'css')));
  app.use('/pages', express.static(path.join(__dirname, '..', 'pages')));
  
  app.post("/api/save-custom-host", express.json({limit: '10mb'}), (req, res) => {
    const htmlContent = req.body.html;
    if (typeof htmlContent !== 'string') return res.status(400).json({error: 'Invalid content'});
    try {
      fs.writeFileSync(path.join(pagesDir, "host-custom.html"), htmlContent);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/info", (req, res) => res.json({ lanIP: state.serverInfo.lanIp, port: state.runtime.activePort, pin: state.session.pin, publicIP: state.serverInfo.publicIp || null, tunnelUrl: state.runtime.tunnelUrl || null, version: state.serverInfo.appVersion }));
  app.post("/api/fe-log", express.json(), (req, res) => {
    const { msg, src, line } = req.body || {};
    console.error(`[renderer] ${msg} @ ${src}:${line}`);
    res.json({ ok: true });
  });

  app.get("/api/pin-required", (req, res) => {
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    const hasTunnelHeader = !!req.headers['x-forwarded-for'] || !!req.headers['cf-connecting-ip'];
    res.json({ required: state.session.pinEnabled && shouldRequirePin(clientIp, hasTunnelHeader) });
  });
  app.get("/api/config", (req, res) => res.json(loadConfig()));
  app.post("/api/config", express.json(), (req, res) => { res.json(saveConfig(req.body || {})); });

  app.post('/api/set-session-password', express.json(), (req, res) => {
    const newPass = (req.body?.password || '').trim();
    saveConfig({ persistentPassword: newPass });
    state.session.sessionPassword = newPass;
    state.session.pin = state.session.sessionPassword ? state.session.sessionPassword : makePin();
    console.log(`[host] Session password ${state.session.sessionPassword ? 'set' : 'cleared'}`);
    if (state.runtime.hostWS && state.runtime.hostWS.readyState === 1) state.runtime.hostWS.send(JSON.stringify({ type: "regen-pin", pin: state.session.pin }));
    res.json({ ok: true, hasPassword: !!state.session.sessionPassword });
  });

  app.get('/api/session-password-status', (req, res) => {
    res.json({ hasPassword: !!state.session.sessionPassword, password: state.session.sessionPassword });
  });

  app.get("/api/sysinfo", async (req, res) => {
    try {
      const [cpu, mem, net] = await Promise.all([
        si.currentLoad(),
        si.mem(),
        si.networkStats()
      ]);
      const activeNet = net.find(n => n.tx_sec > 0 || n.rx_sec > 0) || net[0];
      res.json({
        cpu: cpu.currentLoad.toFixed(1) + '%',
        ram: (mem.active / 1024 / 1024 / 1024).toFixed(1) + 'GB / ' + (mem.total / 1024 / 1024 / 1024).toFixed(1) + 'GB',
        netTx: activeNet ? (activeNet.tx_sec / 1024).toFixed(1) + ' KB/s' : '0 KB/s',
        netRx: activeNet ? (activeNet.rx_sec / 1024).toFixed(1) + ' KB/s' : '0 KB/s',
        latency: 'Local'
      });
    } catch (e) {
      res.json({ error: true });
    }
  });

  app.get("/api/turn", (req, res) => {
    const iceServers = [];

    // ── Custom STUN server (optional) ───────────────────────────────────────
    if (process.env.STUN_URL) {
      iceServers.push({ urls: process.env.STUN_URL });
    }

    // ── Custom TURN server (optional) ───────────────────────────────────────
    if (process.env.TURN_URL) {
      const entry = { urls: [] };
      entry.urls.push(process.env.TURN_URL);
      if (process.env.TURN_URL_TLS) entry.urls.push(process.env.TURN_URL_TLS);
      if (process.env.TURN_USERNAME) entry.username = process.env.TURN_USERNAME;
      if (process.env.TURN_CREDENTIAL) entry.credential = process.env.TURN_CREDENTIAL;
      iceServers.push(entry);
    }

    // ── Legacy Metered.ca env vars (backward compat) ────────────────────────
    if (!process.env.TURN_URL && process.env.METERED_TURN_URL) {
      iceServers.push({
        urls: [
          process.env.METERED_TURN_URL,
          process.env.METERED_TURN_URL_SECURE || ''
        ].filter(Boolean),
        username: process.env.METERED_TURN_USERNAME || 'openrelayproject',
        credential: process.env.METERED_TURN_CREDENTIAL || 'openrelayproject'
      });
    }

    // Return null if nothing is configured — clients will use their built-in STUN pool
    if (iceServers.length === 0) return res.json(null);
    res.json(iceServers.length === 1 ? iceServers[0] : iceServers);
  });

  app.get("/api/status", (req, res) => {
    res.json({
      online: !!state.runtime.hostWS,
      streaming: state.session.hostStreaming,
      viewers: state.viewers.size,
      controllers: state.viewerHasController.size,
      tunnel: state.runtime.tunnelUrl,
      version: state.serverInfo.appVersion,
      uptime: process.uptime()
    });
  });

  app.post("/api/create-virtual-audio", (req, res) => {
    initVirtualAudio((success, error) => {
      res.json({ success, error: error || null });
    });
  });

  // ── Input Visualizer — SSE stream of parsed driver packets ────────────────
  app.get('/api/input-visualizer', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const onPacket = (data) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };
    inputDriver.events.on('input-packet', onPacket);

    req.on('close', () => {
      inputDriver.events.off('input-packet', onPacket);
    });
  });

  // ── Viewer Input Permission — revoke / restore ────────────────────────────
  app.post('/api/viewer-input-perm', express.json(), (req, res) => {
    const { viewerId, revoked } = req.body || {};
    if (!viewerId) return res.status(400).json({ ok: false, reason: 'missing viewerId' });
    const padId = viewerId + '_0';
    const cur = state.inputPerms.get(padId) || { gp: true, kb: false, slot: null };
    const updated = { ...cur, gp: !revoked, kb: revoked ? false : cur.kb, revokedByHost: !!revoked };
    state.inputPerms.set(padId, updated);
    // Flush neutral state so the game doesn't see a stuck button
    if (revoked) {
      inputDriver.send({ type: 'flush_neutral', viewer_id: padId });
    }
    // Notify host WS client so the viewer panel updates live
    if (typeof state.runtime.hostWS !== 'undefined' && state.runtime.hostWS && state.runtime.hostWS.readyState === 1) {
      state.runtime.hostWS.send(JSON.stringify({ type: 'input-perm-changed', viewerId, revoked: !!revoked }));
    }
    res.json({ ok: true, viewerId, revoked: !!revoked });
  });

  app.get("/api/arcade/sessions", (req, res) => {
    res.json([...arcadeSessions.values()]);
  });
  app.post("/api/open-terminal", express.json(), (req, res) => {
    if (process.platform !== "linux") return res.status(400).json({ ok: false, reason: "Linux only" });
    const { cmd, name } = req.body || {};
    if (!cmd) return res.status(400).json({ ok: false });
    const title = (name || "Auto-Host").replace(/"/g, "'");
    const terms = [`gnome-terminal --title="${title}" -- bash -c "${cmd}; exec bash"`, `xterm -title "${title}" -e bash -c "${cmd}; exec bash"`, `konsole --title "${title}" -e bash -c "${cmd}; exec bash"`];
    const { exec: _exec } = require("child_process");
    let i = 0; (function t() { if (i >= terms.length) return res.json({ ok: false, reason: "no terminal found" }); _exec(terms[i++], err => { if (err) t(); else res.json({ ok: true }); }); })();
  });

  let activeGameProc = null;

  app.post("/api/force-route", express.json(), (req, res) => {
    if (!pb) {
      console.warn("[Audio] PatchBay not ready.");
      return res.json({ success: false });
    }
    const targetProcess = req.body.processName || "ALL_DESKTOP";
    console.log(`[Audio] Engaging auto-router: ${targetProcess}`);
    routeGameAudio(targetProcess);
    res.json({ success: true });
  });

  // ── Unified Capture Manager API ───────────────────────────────────────────
  app.get('/api/capture/status', (req, res) => {
    res.json(captureManager.getStatus());
  });

  app.post('/api/capture/start', express.json(), async (req, res) => {
    const { method, options } = req.body || {};
    if (!method) return res.status(400).json({ ok: false, reason: 'method is required (webcodecs | ffmpeg | webrtc)' });
    try {
      const result = await captureManager.start(method, options || {});
      res.json({ ok: true, ...result });
    } catch (e) {
      console.error('[capture] start failed:', e.message);
      res.status(500).json({ ok: false, reason: e.message });
    }
  });

  app.post('/api/capture/stop', async (req, res) => {
    try {
      await captureManager.stop();
      res.json({ ok: true });
    } catch (e) {
      console.error('[capture] stop failed:', e.message);
      res.status(500).json({ ok: false, reason: e.message });
    }
  });

  app.post("/api/restart-game", express.json(), (req, res) => {
    if (activeGameProc) {
      try { process.kill(-activeGameProc.pid); } catch (e) { }
      try { activeGameProc.kill(); } catch (e) { }
      activeGameProc = null;
    }

    if (req.body && req.body.command && req.body.command !== 'KILL_ONLY') {
      const parts = req.body.command.split(' ');
      const cmd = parts.shift();
      console.log("  \x1b[35m~\x1b[0m Launching game process:", req.body.command);

      // ── CRITICAL AUDIO ROUTING: Force game audio into the virtual sink ──
      const spawnEnv = Object.assign({}, process.env);
      spawnEnv.PULSE_SINK = "NearsecAppAudio";

      // ── LIFECYCLE MONITORING: Do NOT detach. Monitor the game and crash if it dies. ──
      activeGameProc = spawn(cmd, parts, {
        stdio: 'ignore',
        env: spawnEnv
      });

      // Extract the binary name to look for in PipeWire
      // (If launching via Steam, you might need to hardcode specific names here based on the command)
      let binaryName = cmd;
      if (req.body.command.includes('cs2')) binaryName = 'cs2';

      // Wait 4 seconds for the game window and audio engine to open, then route it
      setTimeout(() => {
        routeGameAudio(binaryName);
      }, 4000);

      activeGameProc.on('exit', (code) => {
        console.log(`[server] Game process exited with code ${code}.`);
        activeGameProc = null;
        if (process.argv.includes('--arcade-worker')) {
          console.log("[server] Arcade Worker: Game terminated externally. Executing suicide protocol...");
          process.exit(0);
        }
      });
    }
    res.json({ success: true });
  });

  app.post("/api/start-tunnel", express.json(), async (req, res) => {

    if (state.runtime.activeTunnelProc) {
      console.log("  \x1b[33m~\x1b[0m Stopping existing tunnel process before switching...");
      try { state.runtime.activeTunnelProc.kill(); } catch (e) { }
      state.runtime.activeTunnelProc = null;
    }
    state.runtime.tunnelUrl = null;

    const provider = (req.body && req.body.provider) || "cloudflared";
    if (req.body && req.body.remember) saveConfig({ tunnelProvider: provider, neverAsk: true });

    res.json({ ok: true, starting: true });

    if (provider === 'p2p' || provider === 'vps-sfu' || provider === 'portforward') {
      return; // Handled entirely by the browser, no local Node tunnel needed
    }

    // CRITICAL FIX: Use readEnv to catch the host if the GUI fails to pass it!
    const resolvedVpsHost = (req.body && req.body.vpsHost)
      ? req.body.vpsHost.trim()
      : (readEnv('VPS_HOST') || '').trim();

    const fn = {
      zrok: startTunnelZrok,
      cloudflared: startTunnelCloudflared,
      playit: startTunnelPlayit,
      localhostrun: startTunnelLocalhostRun,
      serveo: startTunnelServeo,
      vps: (p) => startTunnelVps(p, resolvedVpsHost),
      portforward: async () => null
    }[provider] || startTunnel;

    if (provider === 'vps' && resolvedVpsHost) {
      saveConfig({ vpsHost: resolvedVpsHost });
    }

    try {
      const tun = await fn(state.runtime.activePort);
      if (tun && tun.url) {
        state.runtime.tunnelUrl = tun.url;
        state.runtime.activeTunnelProc = tun.proc;
        const msg = JSON.stringify({ type: "tunnel-url", url: state.runtime.tunnelUrl });
        if (state.runtime.hostWS && state.runtime.hostWS.readyState === 1) state.runtime.hostWS.send(msg);
      } else if (tun && tun.error === 'NOT_FOUND') {
        console.log(`  \x1b[31m~\x1b[0m Tunnel provider '${provider}' binary not found.`);
        if (state.runtime.hostWS && state.runtime.hostWS.readyState === 1) state.runtime.hostWS.send(JSON.stringify({ type: "tunnel-not-found", provider: provider }));
      } else {
        console.log(`  \x1b[31m~\x1b[0m Tunnel provider '${provider}' failed.`);
        if (state.runtime.hostWS && state.runtime.hostWS.readyState === 1) state.runtime.hostWS.send(JSON.stringify({ type: "tunnel-error", provider: provider }));
      }
    } catch (e) {
      console.log(`  \x1b[31m~\x1b[0m Tunnel error:`, e.message);
      if (state.runtime.hostWS && state.runtime.hostWS.readyState === 1) state.runtime.hostWS.send(JSON.stringify({ type: "tunnel-error", provider: provider }));
    }
  });

  // Input driver wiring, rumble forwarding, and the whole wss.on("connection")
  // handler (host/viewer/arcade/audio/input WS paths) + heartbeat now live in
  // ./server/ws.js.
  attachWebSocketServer(wss, { sanitize, makePin });

  server.listen(state.runtime.activePort, async () => {
    console.log("Listening on port " + state.runtime.activePort);
    if (!process.env.ELECTRON_MODE) openBrowser("http://localhost:" + state.runtime.activePort + "/host");

    const cfg = loadConfig();

    if (process.env.USE_VPS === 'true' && process.env.VPS_HOST) {
      console.log("  ~ Tunnel: VPS (from .env)");
      const tun = await startTunnelVps(state.runtime.activePort, process.env.VPS_HOST.trim());
      if (tun) {
        state.runtime.tunnelUrl = tun.url;
        state.runtime.activeTunnelProc = tun.proc;
        if (state.runtime.hostWS && state.runtime.hostWS.readyState === 1) state.runtime.hostWS.send(JSON.stringify({ type: "tunnel-url", url: state.runtime.tunnelUrl }));
      } else {
        console.log(`  \x1b[31m~\x1b[0m VPS Tunnel failed to start on boot.`);
        if (state.runtime.hostWS && state.runtime.hostWS.readyState === 1) state.runtime.hostWS.send(JSON.stringify({ type: "tunnel-error", provider: 'vps' }));
      }
    } else if (cfg.tunnelProvider === 'vps-sfu') {
      // VPS SFU mode — the host app manages its own WebSocket to the Rust router.
      // The local server must NOT start any tunnel process. The domain is defined
      // by the user's saved VPS URL, not by any local tunnel provider.
      console.log("  \x1b[36m~\x1b[0m Tunnel: VPS SFU mode (managed by host app — no local tunnel started)");
      // Do NOT modify tunnelProvider or neverAsk here.
    } else if (cfg.tunnelProvider === 'p2p') {
      console.log("  \x1b[36m~\x1b[0m Tunnel: P2P mode (managed by host app — no local tunnel started)");
    } else if (cfg.neverAsk && cfg.tunnelProvider === 'portforward') {
      console.log("  ~ Tunnel: port forward mode (saved).");
    } else if (cfg.neverAsk && cfg.tunnelProvider) {
      console.log("  ~ Tunnel: using saved provider '" + cfg.tunnelProvider + "'");

      const fn = {
        zrok: startTunnelZrok,
        cloudflared: startTunnelCloudflared,
        playit: startTunnelPlayit,
        localhostrun: startTunnelLocalhostRun,
        serveo: startTunnelServeo,
        vps: (p) => startTunnelVps(p, cfg.vpsHost || process.env.VPS_HOST || '')
      }[cfg.tunnelProvider] || startTunnel;

      const tun = await fn(state.runtime.activePort);
      if (tun) {
        state.runtime.tunnelUrl = tun.url;
        state.runtime.activeTunnelProc = tun.proc;
        if (state.runtime.hostWS && state.runtime.hostWS.readyState === 1) state.runtime.hostWS.send(JSON.stringify({ type: "tunnel-url", url: state.runtime.tunnelUrl }));
      } else {
        console.log(`  \x1b[31m~\x1b[0m Tunnel provider '${cfg.tunnelProvider}' failed to start on boot.`);
        if (state.runtime.hostWS && state.runtime.hostWS.readyState === 1) state.runtime.hostWS.send(JSON.stringify({ type: "tunnel-error", provider: cfg.tunnelProvider }));
      }
    } else {
      console.log("  ~ Tunnel: waiting for host to choose provider...");
    }
  });
}

main();


function cleanup(isElectron = false) {
  if (_cleanupDone) return;
  _cleanupDone = true;

  console.log('\n[server] Shutting down — running cleanup...');
  console.log(new Error('Cleanup Trace').stack);

  // ── Terminate worker threads gracefully ──────────────────────────────────
  // Audio worker teardown (postMessage 'destroy' + delayed terminate, plus
  // the pactl/pw-cli belt-and-braces cleanup below) lives in
  // ./server/audio-routing.js now.
  destroyVirtualAudio();

  // Arcade heartbeat worker: clean shutdown
  stopArcadeHeartbeatWorker();

  if (state.runtime.activeTunnelProc) { try { state.runtime.activeTunnelProc.kill(); } catch (_) { } }
  if (state.runtime.activeTunnelProc) { try { state.runtime.activeTunnelProc.kill(); } catch (_) { } }

  // Cleanly destroy the input driver (whether it's using C++ or Python)
  try {
    inputDriver.destroy();
    experimentalDriver.destroy();
  } catch (e) {
    console.error("[Server] Input driver cleanup error:", e);
  }

  if (state.runtime.audioProc) { try { state.runtime.audioProc.kill(); } catch (_) { } }

  if (!isElectron) {
    killPort(state.runtime.activePort).catch(() => { }).finally(() => process.exit(0));
  } else {
    killPort(state.runtime.activePort).catch(() => { });
  }
}

process.on('SIGINT', () => cleanup(false));
process.on('SIGTERM', () => cleanup(false));

process.on('uncaughtException', (err) => {
  console.error('[server] Uncaught exception during runtime:', err);
  cleanup(false);
});

module.exports = { cleanup, toUinput };
