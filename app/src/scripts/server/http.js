'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { spawn } = require('child_process');
const crypto = require('crypto');
const si = require('systeminformation');

const state = require('./state.js');
const { projectRoot, loadConfig, saveConfig, readEnv } = require('./env.js');
const { shouldRequirePin } = require('./network-info.js');
const { initVirtualAudio, routeGameAudio } = require('./audio-routing.js');
const { startTunnelVps, startTunnel, PROVIDERS: TUNNEL_PROVIDERS, getProviderFn } = require('./tunnel.js');
const { arcadeSessions } = require('./arcade-signaling.js');
const inputDriver = require('../../sidecar/input_backends/InputOrchestrator.js');
const captureManager = require('../../sidecar/CaptureManager.js');
const launcherDetect = require('../../sidecar/launcher-detect.js');

// This file lives at app/src/scripts/server/http.js — one level deeper than
// the app/src/scripts/ that all these static-serving paths were originally
// written relative to.
const pagesDir = path.join(__dirname, '..', '..', 'pages');

/**
 * PUBLIC — Registers every Express route/middleware on `app`. Called once
 * from server.js's boot sequence, after `app`/`server`/`wss` are created.
 *
 * `deps.makePin` is passed in rather than required, matching ws.js's
 * attachWebSocketServer — server.js's own boot sequence also needs makePin()
 * for the initial PIN, so it stays defined there instead of creating a
 * circular require.
 */
function registerHttpRoutes(app, deps) {
  const { makePin } = deps;

  // ── Simple in-memory rate limiter (upstream v3.0.2) ──────────────────────
  const rateLimitStore = new Map();
  function rateLimit(key, maxRequests, windowMs) {
    const now = Date.now();
    let entry = rateLimitStore.get(key);
    if (!entry || now - entry.windowStart > windowMs) {
      entry = { count: 0, windowStart: now };
      rateLimitStore.set(key, entry);
    }
    entry.count++;
    return entry.count <= maxRequests;
  }
  setInterval(() => {
    const cutoff = Date.now() - 60000;
    for (const [key, entry] of rateLimitStore) {
      if (entry.windowStart < cutoff) rateLimitStore.delete(key);
    }
  }, 60000).unref();

  // Privileged endpoints (shell/file access) only answer the local machine.
  function isLocalRequest(req) {
    const remoteAddr = req.socket.remoteAddress || '';
    return remoteAddr === '127.0.0.1' || remoteAddr === '::1' || remoteAddr === '::ffff:127.0.0.1';
  }

  app.use((req, res, next) => {
    res.setHeader('Permissions-Policy', 'gamepad=*, display-capture=(self)');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, HEAD, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  app.use('/docs', express.static(path.join(__dirname, '..', '..', '..', '..', 'assets', 'locales', 'docs')));

  // ── Dynamic version.js — always reflects package.json ──────────────────
  app.get('/js/version.js', (req, res) => {
    res.type('application/javascript');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.send(
      `window.NEARSEC_VERSION = "${state.serverInfo.appVersion}";\nwindow.NEARSEC_COMMIT = "${state.serverInfo.commitHash}";\nconsole.log("[Nearcade] Version loaded:", window.NEARSEC_VERSION + (window.NEARSEC_COMMIT ? " ("+window.NEARSEC_COMMIT+")" : ""));`
    );
  });

  app.use(
    '/js',
    express.static(path.join(__dirname, '..'), {
      setHeaders: (res) => {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
      },
    })
  );
  app.use('/assets', express.static(path.join(__dirname, '..', '..', '..', '..', 'assets')));

  // FIX: Serve the favicon explicitly so the browser finds it
  app.get('/favicon.ico', (req, res) => res.sendFile('favicon.ico', { root: projectRoot }));

  app.get('/', (req, res) => {
    const indexPath = path.join(pagesDir, 'index.html');
    let html;
    try {
      html = fs.readFileSync(indexPath, 'utf8');
    } catch (_) {
      return res.sendFile('index.html', { root: pagesDir });
    }
    const sess = arcadeSessions.size > 0 ? [...arcadeSessions.values()][0] : null;

    // Grab the host name from the URL query, fallback to "A player"
    const hostName = req.query.host || 'A player';

    // Inject the host name dynamically into the Discord tags
    const ogTitle = sess ? sess.game : `${hostName} is looking to play!`;
    const ogDesc = sess
      ? `Join the live ${sess.game} session on Nearcade.`
      : `${hostName} is hosting a peer-to-peer gaming session on Nearcade.`;
    const ogImage = sess && sess.thumbnail ? sess.thumbnail : 'https://nearcade.cutefame.net/assets/NearcadeLogo.png';

    html = html
      .replace(/(<meta property="og:title"\s+content=")[^"]*"/, `$1${ogTitle}"`)
      .replace(/(<meta property="og:description"\s+content=")[^"]*"/, `$1${ogDesc}"`)
      .replace(/(<meta property="og:image"\s+content=")[^"]*"/, `$1${ogImage}"`);
    res.type('html').send(html);
  });
  app.get('/dashboard', (req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.sendFile('dashboard.html', { root: pagesDir });
  });
  app.get('/setup', (req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.sendFile('setup.html', { root: pagesDir });
  });
  app.get('/host', (req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.sendFile('host.html', { root: pagesDir });
  });

  app.get('/host-minimal', (req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.sendFile('host-minimal.html', { root: pagesDir });
  });
  app.get('/host-playground', (req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.sendFile('host-playground.html', { root: pagesDir });
  });
  app.get('/host-custom', (req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.sendFile('host-custom.html', { root: pagesDir });
  });
  app.get('/gamepad-popup.html', (req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.sendFile('gamepad-popup.html', { root: pagesDir });
  });
  app.use('/css', express.static(path.join(__dirname, '..', '..', 'css')));
  app.use('/pages', express.static(pagesDir));

  app.post('/api/save-custom-host', express.json({ limit: '10mb' }), (req, res) => {
    if (!isLocalRequest(req)) return res.status(403).json({ error: 'localhost only' });
    const htmlContent = req.body.html;
    if (typeof htmlContent !== 'string') return res.status(400).json({ error: 'Invalid content' });
    if (htmlContent.length > 10485760) return res.status(400).json({ error: 'Content too large' });
    try {
      fs.writeFileSync(path.join(pagesDir, 'host-custom.html'), htmlContent);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/info', (req, res) =>
    res.json({
      lanIP: state.serverInfo.lanIp,
      port: state.runtime.activePort,
      // The PIN is a secret — only the local host UI gets it.
      pin: isLocalRequest(req) ? state.session.pin : undefined,
      hasPin: !!state.session.pin,
      publicIP: state.serverInfo.publicIp || null,
      tunnelUrl: state.runtime.tunnelUrl || null,
      version: state.serverInfo.appVersion,
    })
  );
  app.post('/api/fe-log', express.json(), (req, res) => {
    const clientIp = req.socket.remoteAddress || 'unknown';
    if (!rateLimit('fe-log:' + clientIp, 30, 10000)) return res.status(429).json({ error: 'rate limited' });
    const { msg, src, line } = req.body || {};
    if (
      typeof msg !== 'string' ||
      typeof src !== 'string' ||
      (line !== undefined && typeof line !== 'string' && typeof line !== 'number')
    ) {
      return res.status(400).json({ error: 'invalid payload' });
    }
    console.error(`[renderer] ${msg.slice(0, 500)} @ ${src.slice(0, 200)}:${String(line).slice(0, 20)}`);
    res.json({ ok: true });
  });

  app.get('/api/pin-required', (req, res) => {
    const clientIp = req.headers['cf-connecting-ip'] || req.socket.remoteAddress || 'unknown';
    const hasTunnelHeader = !!req.headers['cf-connecting-ip'] || !!req.headers['x-forwarded-for'];
    res.json({ required: state.session.pinEnabled && shouldRequirePin(clientIp, hasTunnelHeader) });
  });
  app.get('/api/config', (req, res) => res.json(loadConfig()));
  app.post('/api/config', express.json(), (req, res) => {
    res.json(saveConfig(req.body || {}));
  });
  app.post('/api/system-chat', express.json(), (req, res) => {
    const msg = (req.body?.msg || '').trim();
    if (!msg) return res.status(400).json({ ok: false });
    const payload = JSON.stringify({ type: 'chat', from: 'Nearcade', msg });
    state.viewers.forEach((vws) => {
      if (vws && vws.readyState === 1) vws.send(payload);
    });
    if (state.runtime.hostWS && state.runtime.hostWS.readyState === 1) state.runtime.hostWS.send(payload);
    res.json({ ok: true });
  });

  app.post('/api/report', express.json(), (req, res) => {
    const clientIp = req.socket.remoteAddress || 'unknown';
    if (!rateLimit('report:' + clientIp, 5, 60000)) return res.status(429).json({ error: 'rate limited' });
    const { viewerId, reason, sessionId } = req.body || {};
    const anonHash = crypto.createHash('sha256').update(clientIp).digest('hex');
    const list = state.reports.get(anonHash) || [];
    list.push({
      timestamp: Date.now(),
      sessionId: sessionId || '?',
      viewerId: viewerId || null,
      reason: reason || 'unspecified',
    });
    if (list.length > 100) list.splice(0, list.length - 100);
    state.reports.set(anonHash, list);
    console.log(
      `[report] Session ${sessionId || '?'} reported from ${anonHash.slice(0, 8)} reason: ${reason || 'unspecified'} (${list.length} total reports for this IP)`
    );
    res.json({ ok: true });
  });

  app.post('/api/set-session-password', express.json(), (req, res) => {
    const newPass = (req.body?.password || '').trim();
    saveConfig({ persistentPassword: newPass });
    state.session.sessionPassword = newPass;
    state.session.pin = state.session.sessionPassword ? state.session.sessionPassword : makePin();
    console.log(`[host] Session password ${state.session.sessionPassword ? 'set' : 'cleared'}`);
    if (state.runtime.hostWS && state.runtime.hostWS.readyState === 1)
      state.runtime.hostWS.send(JSON.stringify({ type: 'regen-pin', pin: state.session.pin }));
    res.json({ ok: true, hasPassword: !!state.session.sessionPassword });
  });

  app.get('/api/session-password-status', (req, res) => {
    res.json({ hasPassword: !!state.session.sessionPassword });
  });

  app.get('/api/sysinfo', async (req, res) => {
    try {
      const [cpu, mem, net] = await Promise.all([si.currentLoad(), si.mem(), si.networkStats()]);
      const activeNet = net.find((n) => n.tx_sec > 0 || n.rx_sec > 0) || net[0];
      res.json({
        cpu: cpu.currentLoad.toFixed(1) + '%',
        ram:
          (mem.active / 1024 / 1024 / 1024).toFixed(1) + 'GB / ' + (mem.total / 1024 / 1024 / 1024).toFixed(1) + 'GB',
        netTx: activeNet ? (activeNet.tx_sec / 1024).toFixed(1) + ' KB/s' : '0 KB/s',
        netRx: activeNet ? (activeNet.rx_sec / 1024).toFixed(1) + ' KB/s' : '0 KB/s',
        latency: 'Local',
      });
    } catch (e) {
      res.json({ error: true });
    }
  });

  app.get('/api/turn', (req, res) => {
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
        urls: [process.env.METERED_TURN_URL, process.env.METERED_TURN_URL_SECURE || ''].filter(Boolean),
        username: process.env.METERED_TURN_USERNAME || 'openrelayproject',
        credential: process.env.METERED_TURN_CREDENTIAL || 'openrelayproject',
      });
    }

    // Return null if nothing is configured — clients will use their built-in STUN pool
    if (iceServers.length === 0) return res.json(null);
    res.json(iceServers.length === 1 ? iceServers[0] : iceServers);
  });

  // ── Game launcher & launcher detection ────────────────────────────────
  app.get('/games-picker.html', (req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.sendFile('games-picker.html', { root: pagesDir });
  });

  app.get('/api/launchers', (_req, res) => {
    res.json({ launchers: launcherDetect.detect() });
  });

  const gamesCache = { data: null, time: 0, TTL: 15000 };
  app.get('/api/games', (_req, res) => {
    if (gamesCache.data && Date.now() - gamesCache.time < gamesCache.TTL) {
      return res.json({ games: gamesCache.data });
    }
    try {
      const games = launcherDetect.detectGames();
      gamesCache.data = games;
      gamesCache.time = Date.now();
      res.json({ games });
    } catch (e) {
      console.error('[api/games] Error detecting games:', e.message);
      res.status(500).json({ error: e.message, games: [] });
    }
  });

  const gameArtCacheDir = path.join(os.homedir(), '.cache', 'Nearcade', 'game-art');
  app.get('/api/game-art/:appId', (req, res) => {
    const { appId } = req.params;
    if (!/^\d+$/.test(appId)) return res.status(400).end();
    fs.mkdirSync(gameArtCacheDir, { recursive: true });
    const cachePath = path.join(gameArtCacheDir, appId + '.jpg');
    if (fs.existsSync(cachePath)) {
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return res.sendFile(cachePath);
    }
    const urls = [
      `https://shared.steamstatic.com/store_item_assets/steam/apps/${appId}/header.jpg`,
      `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/header.jpg`,
      `https://steamcdn-a.akamaihd.net/steam/apps/${appId}/header.jpg`,
    ];
    let idx = 0;
    function tryFetch() {
      if (idx >= urls.length) return res.status(404).end();
      const url = urls[idx++];
      https
        .get(url, (resp) => {
          if (resp.statusCode !== 200) {
            resp.resume();
            return tryFetch();
          }
          const chunks = [];
          resp.on('data', (c) => chunks.push(c));
          resp.on('end', () => {
            const buf = Buffer.concat(chunks);
            fs.writeFileSync(cachePath, buf);
            res.setHeader('Cache-Control', 'public, max-age=86400');
            res.sendFile(cachePath);
          });
        })
        .on('error', tryFetch);
    }
    tryFetch();
  });

  app.post('/api/launch-game', express.json(), (req, res) => {
    const { launcher, gameId } = req.body || {};
    if (!launcher || !gameId) return res.status(400).json({ error: 'Missing launcher or gameId' });
    try {
      launcherDetect.launch(launcher, String(gameId));
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/status', (req, res) => {
    res.json({
      online: !!state.runtime.hostWS,
      streaming: state.session.hostStreaming,
      viewers: state.viewers.size,
      controllers: state.viewerHasController.size,
      tunnel: state.runtime.tunnelUrl,
      version: state.serverInfo.appVersion,
      uptime: process.uptime(),
    });
  });

  app.post('/api/create-virtual-audio', (req, res) => {
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

  app.get('/api/arcade/sessions', (req, res) => {
    res.json([...arcadeSessions.values()]);
  });
  app.post('/api/open-terminal', express.json(), (req, res) => {
    if (!isLocalRequest(req)) return res.status(403).json({ ok: false, reason: 'localhost only' });
    if (process.platform !== 'linux') return res.status(400).json({ ok: false, reason: 'Linux only' });
    const { cmd, name } = req.body || {};
    if (!cmd || typeof cmd !== 'string') return res.status(400).json({ ok: false });
    if (cmd.length > 2000) return res.status(400).json({ ok: false, reason: 'command too long' });
    // spawn() with an argv array (upstream v3.0.2): no shell string
    // interpolation, plus a character allowlist on what does reach bash -c.
    const title = String(name || 'Auto-Host')
      .replace(/[^a-zA-Z0-9 _-]/g, '')
      .slice(0, 100);
    const safeCmd = String(cmd).replace(/[^a-zA-Z0-9 _=\/.:@%~#+$(){}[\]!^,|-]/g, '');
    const terms = [
      { cmd: 'gnome-terminal', args: ['--title', title, '--', 'bash', '-c', `${safeCmd}; exec bash`] },
      { cmd: 'xterm', args: ['-title', title, '-e', 'bash', '-c', `${safeCmd}; exec bash`] },
      { cmd: 'konsole', args: ['--title', title, '-e', 'bash', '-c', `${safeCmd}; exec bash`] },
    ];
    let i = 0;
    (function t() {
      if (i >= terms.length) return res.json({ ok: false, reason: 'no terminal found' });
      const term = terms[i++];
      const proc = spawn(term.cmd, term.args, { stdio: 'ignore', detached: true });
      proc.on('error', () => t());
      proc.on('spawn', () => {
        proc.unref();
        res.json({ ok: true });
      });
    })();
  });

  let activeGameProc = null;

  app.post('/api/force-route', express.json(), (req, res) => {
    if (!isLocalRequest(req)) return res.status(403).json({ ok: false, reason: 'localhost only' });
    // NOTE: `pb` was already an undefined global reference before this file
    // was extracted from server.js — pre-existing bug (this handler has
    // presumably always thrown ReferenceError when hit), left exactly as-is
    // rather than "fixed" as part of a structural move.
    if (!pb) {
      console.warn('[Audio] PatchBay not ready.');
      return res.json({ success: false });
    }
    const targetProcess = req.body.processName || 'ALL_DESKTOP';
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

  app.post('/api/restart-game', express.json(), (req, res) => {
    if (!isLocalRequest(req)) return res.status(403).json({ ok: false, reason: 'localhost only' });
    if (activeGameProc) {
      try {
        process.kill(-activeGameProc.pid);
      } catch (e) {}
      try {
        activeGameProc.kill();
      } catch (e) {}
      activeGameProc = null;
    }

    if (req.body && req.body.command && req.body.command !== 'KILL_ONLY') {
      const parts = req.body.command.split(' ');
      const cmd = parts.shift();
      if (!cmd || typeof cmd !== 'string') return res.status(400).json({ ok: false, reason: 'invalid command' });

      // Launcher allowlist (upstream v3.0.2): this endpoint spawns arbitrary
      // processes — restrict to known game launchers/emulators.
      const ALLOWED_GAMES = [
        'steam',
        'Heroic',
        'lutris',
        'wine',
        'mangohud',
        'cs2',
        'xenia',
        'yuzu',
        'ryujinx',
        'pcsx2',
        'dolphin-emu',
        'rpcs3',
        'ppsspp',
        'duckstation',
        'melonds',
        'citra',
        'flycast',
        'redream',
        'ares',
        'bigpemu',
        'cemu',
        'mame',
        'scummvm',
        'vrchat',
        'firefox',
        'chromium',
        'google-chrome',
        'flatpak',
        '.exe',
        '.AppImage',
        'bash',
        'sh',
      ];
      const allowMatch = (c) => ALLOWED_GAMES.some((a) => c.includes(a) || c.endsWith(a));
      if (!allowMatch(cmd)) {
        console.warn(`[security] BLOCKED restart-game: "${cmd}" not in allowlist`);
        return res.status(403).json({ ok: false, reason: 'game not in allowlist' });
      }

      console.log('  \x1b[35m~\x1b[0m Launching game process:', req.body.command);

      // ── CRITICAL AUDIO ROUTING: Force game audio into the virtual sink ──
      const spawnEnv = Object.assign({}, process.env);
      spawnEnv.PULSE_SINK = 'NearsecAppAudio';

      // ── LIFECYCLE MONITORING: Do NOT detach. Monitor the game and crash if it dies. ──
      activeGameProc = spawn(cmd, parts, {
        stdio: 'ignore',
        env: spawnEnv,
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
          console.log('[server] Arcade Worker: Game terminated externally. Executing suicide protocol...');
          process.exit(0);
        }
      });
    }
    res.json({ success: true });
  });

  app.post('/api/start-tunnel', express.json(), async (req, res) => {
    if (state.runtime.activeTunnelProc) {
      console.log('  \x1b[33m~\x1b[0m Stopping existing tunnel process before switching...');
      try {
        state.runtime.activeTunnelProc.kill();
      } catch (e) {}
      state.runtime.activeTunnelProc = null;
    }
    state.runtime.tunnelUrl = null;

    const provider = (req.body && req.body.provider) || 'cloudflared';
    if (req.body && req.body.remember) saveConfig({ tunnelProvider: provider, neverAsk: true });

    res.json({ ok: true, starting: true });

    if (provider === 'p2p' || provider === 'vps-sfu' || provider === 'portforward') {
      return; // Handled entirely by the browser, no local Node tunnel needed
    }

    // CRITICAL FIX: Use readEnv to catch the host if the GUI fails to pass it!
    const resolvedVpsHost = req.body && req.body.vpsHost ? req.body.vpsHost.trim() : (readEnv('VPS_HOST') || '').trim();

    const fn = provider === 'vps' ? (p) => startTunnelVps(p, resolvedVpsHost) : getProviderFn(provider) || startTunnel;

    if (provider === 'vps' && resolvedVpsHost) {
      saveConfig({ vpsHost: resolvedVpsHost });
    }

    try {
      const tun = await fn(state.runtime.activePort);
      if (tun && tun.url) {
        state.runtime.tunnelUrl = tun.url;
        state.runtime.activeTunnelProc = tun.proc;
        const msg = JSON.stringify({ type: 'tunnel-url', url: state.runtime.tunnelUrl });
        if (state.runtime.hostWS && state.runtime.hostWS.readyState === 1) state.runtime.hostWS.send(msg);
      } else if (tun && tun.error === 'NOT_FOUND') {
        console.log(`  \x1b[31m~\x1b[0m Tunnel provider '${provider}' binary not found.`);
        if (state.runtime.hostWS && state.runtime.hostWS.readyState === 1)
          state.runtime.hostWS.send(JSON.stringify({ type: 'tunnel-not-found', provider: provider }));
      } else {
        console.log(`  \x1b[31m~\x1b[0m Tunnel provider '${provider}' failed.`);
        if (state.runtime.hostWS && state.runtime.hostWS.readyState === 1)
          state.runtime.hostWS.send(JSON.stringify({ type: 'tunnel-error', provider: provider }));
      }
    } catch (e) {
      console.log(`  \x1b[31m~\x1b[0m Tunnel error:`, e.message);
      if (state.runtime.hostWS && state.runtime.hostWS.readyState === 1)
        state.runtime.hostWS.send(JSON.stringify({ type: 'tunnel-error', provider: provider }));
    }
  });

  // Dashboard "Additional Tunnels" section: discoverable provider catalog with
  // live binary-found status, and a start endpoint scoped to that flow. Kept
  // separate from /api/start-tunnel above (the in-session host tunnel modal's
  // route, with its remember/vpsHost handling) rather than merged into it —
  // both now read from tunnel.js's single PROVIDERS/getProviderFn source.
  app.get('/api/tunnels/providers', async (_req, res) => {
    const results = await Promise.all(
      TUNNEL_PROVIDERS.map(async (p) => {
        let status;
        try {
          status = await p.detect();
        } catch (e) {
          status = { found: false, error: e.message };
        }
        return {
          id: p.id,
          name: p.name,
          type: p.type,
          pricing: p.pricing,
          difficulty: p.difficulty,
          description: p.description,
          tags: p.tags,
          requiresBinary: p.requiresBinary !== false,
          integrated: !!p.integrated,
          status,
        };
      })
    );
    res.json({ providers: results });
  });

  app.post('/api/tunnels/start', express.json(), async (req, res) => {
    const { provider } = req.body || {};
    if (!provider) return res.status(400).json({ error: 'provider required' });
    saveConfig({ tunnelProvider: provider });
    const fn = provider === 'vps' ? (p) => startTunnelVps(p, readEnv('VPS_HOST') || '') : getProviderFn(provider);
    if (!fn) return res.status(400).json({ success: false, error: 'Unknown provider: ' + provider });
    try {
      const result = await fn(state.runtime.activePort);
      if (result && result.url) {
        res.json({ success: true, url: result.url });
      } else if (result && result.error) {
        res.json({ success: false, error: result.error, details: result.details || '' });
      } else {
        res.json({ success: false, error: 'Tunnel failed to start', details: 'No URL returned' });
      }
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });
}

module.exports = { registerHttpRoutes };
