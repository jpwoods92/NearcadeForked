'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');

const state = require('./state.js');
const { toUinput, normalizeGamepadMsg } = require('./input-bridge.js');
const { routeGameAudio, stopRouting } = require('./audio-routing.js');
const { loadConfig } = require('./env.js');
const { shouldRequirePin } = require('./network-info.js');
const {
  arcadeSessions, arcadeClients, nextArcadeHostId, broadcastToArcade, _arcadePost,
} = require('./arcade-signaling.js');
const inputDriver = require('../../sidecar/input_backends/InputOrchestrator.js');
const experimentalDriver = require('../../sidecar/input_backends/experimental/ExperimentalOrchestrator.js');
const { playSound: playSoundUtil } = require('../audio-util');

function hashIp(ip) { return crypto.createHash('sha256').update(ip).digest('hex'); }

/**
 * PUBLIC — Wires up the input driver's event bus to WebSocket clients, and
 * registers the wss "connection" handler for all /ws/* paths (host, viewer,
 * arcade, audio, input) plus the dead-connection heartbeat.
 *
 * `deps.sanitize`/`deps.makePin` are passed in rather than required, since
 * they're tiny utilities server.js's boot sequence also needs (for the
 * initial PIN) — keeping them defined in the entrypoint avoids a circular
 * require between it and this module.
 */
function attachWebSocketServer(wss, deps) {
  const { sanitize, makePin } = deps;

  // ── INPUT ORCHESTRATOR (Hybrid C++ / Python) ──
  const screenW = global.currentResW || 1920;
  const screenH = global.currentResH || 1080;

  // This will try C++ first, and automatically fall back to Python if the .node file is missing
  inputDriver.init(screenW, screenH);

  // Forward input driver errors (e.g. ViGEmBus missing on Windows) to the host UI
  inputDriver.events.on('input-error', (err) => {
    console.error('[InputOrchestrator] input-error:', err.message, '(code:', err.code + ')');
    if (state.runtime.hostWS && state.runtime.hostWS.readyState === 1) {
      state.runtime.hostWS.send(JSON.stringify({ type: 'input-error', message: err.message, code: err.code || '' }));
    }
  });
  inputDriver.events.on('input-ready', (info) => {
    console.log('[InputOrchestrator] input-ready:', info.message || '');
    if (state.runtime.hostWS && state.runtime.hostWS.readyState === 1) {
      state.runtime.hostWS.send(JSON.stringify({ type: 'input-ready', message: info.message || '' }));
    }
  });

  // ── C++ rumble callback — registered immediately after init so it fires
  // whether or not the Python sidecar is also running.
  // input-ready is a Python-only event so the old placement meant the callback
  // was never registered when the C++ bridge loaded successfully.
  if (inputDriver._bridge && inputDriver._bridge.setRumbleCallback) {
    inputDriver._bridge.setRumbleCallback((data) => {
      // getViewerForSlot returns the padId (e.g. "uuid_0"); strip the _N suffix
      // to get the bare viewer UUID that keys the viewers map.
      const padId = inputDriver.getViewerForSlot ? inputDriver.getViewerForSlot(data.slot) : null;
      const realId = padId ? padId.replace(/_\d+$/, '') : null;
      console.log(`[Rumble] C++ callback fired — slot=${data.slot} padId=${padId} viewer=${realId || 'unknown'} strong=${data.strong.toFixed(3)} weak=${data.weak.toFixed(3)}`);
      const rumbleMsg = JSON.stringify({
        type: 'rumble',
        strong: data.strong,
        weak: data.weak,
        duration: data.duration || 200,
      });
      if (realId) {
        const vws = state.viewers.get(realId);
        if (vws && vws.readyState === 1) {
          // Direct local WebSocket viewer
          vws.send(rumbleMsg);
          console.log(`[Rumble] Sent directly to viewer ${realId}`);
        } else if (vws === null) {
          // VPS viewer — no direct WS. Bounce via hostWS so host.js
          // can dispatch it over _vpsWs to the Rust router.
          if (state.runtime.hostWS && state.runtime.hostWS.readyState === 1) {
            state.runtime.hostWS.send(JSON.stringify({
              type: 'rumble',
              targetViewerId: realId,
              strong: data.strong,
              weak: data.weak,
              duration: data.duration || 200,
            }));
            console.log(`[Rumble] Bounced via hostWS to VPS viewer ${realId}`);
          } else {
            console.warn(`[Rumble] hostWS not open, cannot reach VPS viewer ${realId}`);
          }
        } else {
          console.warn(`[Rumble] Viewer ${realId} WebSocket not open (state: ${vws?.readyState})`);
        }
      } else {
        // Slot not yet resolved — broadcast to all viewers best-effort
        console.warn(`[Rumble] No viewer for slot ${data.slot} — broadcasting best-effort`);
        state.viewers.forEach((vws, vid) => {
          if (vws && vws.readyState === 1) try { vws.send(rumbleMsg); } catch (_) { }
          else if (vws === null && state.runtime.hostWS && state.runtime.hostWS.readyState === 1) {
            state.runtime.hostWS.send(JSON.stringify({ type: 'rumble', targetViewerId: vid, strong: data.strong, weak: data.weak, duration: data.duration || 200 }));
          }
        });
      }
    });
    console.log('[InputOrchestrator] C++ rumble callback registered.');
  }

  // ── Python sidecar rumble forwarding ─────────────────────────────────────────
  // When the Python backend detects an EV_FF/FF_RUMBLE event it emits 'rumble'
  // on the events bus. Route that to the specific viewer's WebSocket.
  inputDriver.events.on('rumble', (data) => {
    const rumbleMsg = JSON.stringify({
      type: 'rumble',
      strong: data.strong || 0,
      weak: data.weak || 0,
      duration: data.duration || 200,
    });
    if (data.viewerId) {
      const vws = state.viewers.get(data.viewerId);
      if (vws && vws.readyState === 1) vws.send(rumbleMsg);
    } else {
      // viewerId unknown — broadcast to all connected viewers (best-effort)
      state.viewers.forEach((vws) => {
        if (vws.readyState === 1) try { vws.send(rumbleMsg); } catch (_) { }
      });
    }
  });

  state.session.hostStreaming = false;
  const audioViewers = new Set();

  const JOIN_SOUND = __dirname.includes('app.asar')
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'assets', 'joinsound.wav')
    : path.join(__dirname, '../../../../assets/joinsound.wav');

  const LEAVE_SOUND = __dirname.includes('app.asar')
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'assets', 'leavesound.wav')
    : path.join(__dirname, '../../../../assets/leavesound.wav');

  function playSound(file) {
    if (!fs.existsSync(file)) return;
    playSoundUtil(file, (err) => {
      if (err) console.log("[audio] Could not play sound on " + process.platform + ":", err.message);
    });
  }
  function playJoinSound() {
    if (state.runtime.hostWS && state.runtime.hostWS.readyState === 1) {
      state.runtime.hostWS.send(JSON.stringify({ type: 'play-system-sound', action: 'join' }));
    }
  }
  function playLeaveSound() {
    if (state.runtime.hostWS && state.runtime.hostWS.readyState === 1) {
      state.runtime.hostWS.send(JSON.stringify({ type: 'play-system-sound', action: 'leave' }));
    }
  }

  function broadcast(data) {
    let sentToVps = false;
    state.viewers.forEach(vws => {
      if (vws && vws.readyState === 1) vws.send(data);
      else if (vws === null && !sentToVps && state.runtime.hostWS && state.runtime.hostWS.readyState === 1) {
        state.runtime.hostWS.send(JSON.stringify({ type: 'vps-broadcast', payload: data }));
        sentToVps = true;
      }
    });
  }

  function controllerViewerCount() {
    return state.viewerHasController.size;
  }

  function broadcastRoster() {
    const roster = [];
    roster.push({ id: 'host_0', name: 'Host', gp: false, kb: false, slot: 0, locked: true, inputMode: 'host' });
    let autoSlot = 1;
    state.viewers.forEach((vws, id) => {
      const pads = state.viewerGamepads.get(id) || new Set([0]);
      pads.forEach(padIdx => {
        const isExtra = padIdx > 0;
        const nameSuffix = isExtra ? ' ' + (padIdx + 1) : '';
        const rosterId = id + '_' + padIdx;
        const pBase = state.inputPerms.get(id) || {};
        const pPad = state.inputPerms.get(rosterId) || {};
        const p = { gp: true, kb: false, slot: null, locked: false, ...pBase, ...pPad };

        let mode = 'gamepad';
        if (!p.gp && p.kb) mode = 'kbm';
        else if (p.gp && p.kb) mode = 'kbm_emulated';
        else if (!p.gp && !p.kb) mode = 'disabled';

        roster.push({
          id: rosterId,
          name: (state.viewerNames.get(id) || id) + nameSuffix,
          gp: !!p.gp,
          kb: !!p.kb,
          slot: p.slot ?? autoSlot++,
          locked: !!p.locked,
          inputMode: mode
        });
      });
    });
    const count = controllerViewerCount();
    const msg = JSON.stringify({ type: "roster", viewers: roster, controllerCount: count });
    broadcast(msg);
    if (state.runtime.hostWS && state.runtime.hostWS.readyState === 1) state.runtime.hostWS.send(msg);
  }

  wss.on("connection", (ws, req) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    const url = new URL(req.url, "http://x");
    const wsPath = url.pathname;
    const pin = url.searchParams.get("pin") || "";

    // ── HOST ─────────────────────────────────────────────────────────────────
    if (wsPath === "/ws/host") {
      console.log("[host] connected");
      state.runtime.hostWS = ws;
      broadcast(JSON.stringify({ type: "host-connected" }));

      // Start audio routing as soon as the host session opens
      routeGameAudio(null);
      state.viewers.forEach((_, id) => state.runtime.hostWS.send(JSON.stringify({ type: "viewer-joined", viewerId: id, name: state.viewerNames.get(id) || id })));

      if (state.runtime.tunnelUrl) ws.send(JSON.stringify({ type: "tunnel-url", url: state.runtime.tunnelUrl }));

      ws.on("message", (raw, isBinary) => {
        if (isBinary) {
          // Tunnel WebCodecs binary frames from Host -> Node.js Server -> Viewers
          state.viewers.forEach(vws => {
            if (vws && vws.readyState === 1) vws.send(raw);
          });
          return;
        }

        try {
          let msg = JSON.parse(raw);

          if (msg.type === "webcodecs-config") {
            broadcast(raw);
            return;
          }

          // ── OS-LEVEL AUDIO FALLBACK COMMANDS ──
          if (msg.type === "start-audio-fallback") {
            if (state.runtime.audioProc) {
              state.runtime.audioProc.kill();
              state.runtime.audioProc = null;
            }
            console.log("  [host] Engaging Python OS-Level Audio Fallback...");
            const audioScript = path.join(__dirname, "..", "..", "sidecar", "audio_driver.py");

            // FIX: Added "-u" to bypass buffer lock, and "inherit" to expose Python crashes!
            const { spawn } = require('child_process');
            state.runtime.audioProc = spawn(process.platform === "win32" ? "python" : "python3", ["-u", audioScript], { stdio: ['ignore', 'pipe', 'inherit'] });

            state.runtime.audioProc.stdout.on('data', (chunk) => {
              state.viewers.forEach(v => {
                if (v.readyState === WebSocket.OPEN) v.send(chunk);
              });
            });
            return;
          }

          if (msg.type === "stop-audio-fallback") {
            if (state.runtime.audioProc) {
              state.runtime.audioProc.kill();
              state.runtime.audioProc = null;
            }
            return;
          }

          // ── STANDARD SIGNALING ──
          if ((msg.type === "offer" || msg.type === "ice-host") && msg._viewerId) {
            const vws = state.viewers.get(msg._viewerId);
            if (vws && vws.readyState === 1) {
              vws.send(JSON.stringify(msg));
            } else if (vws === null && state.runtime.hostWS && state.runtime.hostWS.readyState === 1) {
              state.runtime.hostWS.send(JSON.stringify(msg));
            }
            return;
          }

          // ── VOICE COMMANDS ────────────────────────────────────────────────
          // Individual viewer: relay to that specific viewer
          if (msg.type === "host-voice-cmd" && msg.targetViewerId) {
            const realId = msg.targetViewerId.split('_')[0];
            const targetWs = state.viewers.get(realId);
            if (targetWs && targetWs.readyState === 1) {
              targetWs.send(JSON.stringify(msg));
            } else if (targetWs === null && state.runtime.hostWS && state.runtime.hostWS.readyState === 1) {
              state.runtime.hostWS.send(JSON.stringify(msg));
            }
            return;
          }
          // Broadcast: relay mute/unmute to every connected viewer
          if (msg.type === "host-voice-broadcast" && msg.action) {
            state.viewers.forEach((vws, id) => {
              if (vws && vws.readyState === 1) {
                vws.send(JSON.stringify({ type: "host-voice-cmd", action: msg.action, targetViewerId: id }));
              } else if (vws === null && state.runtime.hostWS && state.runtime.hostWS.readyState === 1) {
                state.runtime.hostWS.send(JSON.stringify({ type: "host-voice-cmd", action: msg.action, targetViewerId: id }));
              }
            });
            return;
          }
          // ─────────────────────────────────────────────────────────────────

          if (msg.type === "kick-viewer") {
            const realId = msg.viewerId.split('_')[0];
            const targetWs = state.viewers.get(realId);

            state.viewers.delete(realId);
            state.viewerNames.delete(realId);
            state.inputPerms.delete(realId);

            if (targetWs) {
              try { targetWs.send(JSON.stringify({ type: "pin-rejected", reason: "kicked" })); } catch { }
              targetWs.close(4003, "KICKED");
              console.log(`[host] Kicked viewer ${realId}`);
            } else if (state.runtime.hostWS && state.runtime.hostWS.readyState === 1) {
              state.runtime.hostWS.send(JSON.stringify({ type: "pin-rejected", reason: "kicked", targetViewerId: realId }));
              console.log(`[host] Kicked VPS viewer ${realId}`);
            }

            broadcastRoster();
            return;
          }

          if (msg.type === "set-pin") { state.session.pinEnabled = !!msg.enabled; return; }

          if (msg.type === "set-input") {
            const cur = state.inputPerms.get(msg.viewerId) || { gp: true, kb: false, slot: null, mode: 'gamepad' };
            state.inputPerms.set(msg.viewerId, { ...cur, gp: !!msg.gp, kb: !!msg.kb });
            const realId = msg.viewerId.split('_')[0];
            const vws = state.viewers.get(realId);
            if (vws && vws.readyState === 1 && msg.viewerId.endsWith('_0')) {
              vws.send(JSON.stringify({ type: "input-state", gp: !!msg.gp, kb: !!msg.kb }));
            }
            broadcastRoster();
            return;
          }

          if (msg.type === "assign-slot") {
            const cur = state.inputPerms.get(msg.viewerId) || { gp: true, kb: false, slot: null };
            state.inputPerms.set(msg.viewerId, { ...cur, slot: msg.slot });
            const realId = msg.viewerId.split('_')[0];
            const vws = state.viewers.get(realId);
            if (vws && vws.readyState === 1 && msg.viewerId.endsWith('_0')) {
              vws.send(JSON.stringify({ type: "slot-assigned", slot: msg.slot }));
            }
            broadcastRoster();
            return;
          }

          if (msg.type === "chat") { broadcast(JSON.stringify(msg)); return; }

          // FIX 1: Catch the direct profile change from the UI and send to Python
          if (msg.type === "set-ctrl-type") {
            global.currentCtrlType = msg.ctrlType;
            toUinput(msg);
            return;
          }

          if (msg.type === "ctrl-settings") {
            toUinput({ type: 'set_force_xboxone', value: !!msg.forceXboxOne });
            toUinput({ type: 'set_enable_dualshock', value: !!msg.enableDualShock });
            toUinput({ type: 'set_enable_motion', value: !!msg.enableMotion });
            toUinput({ type: 'ctrl-settings-hybrid', enabled: !!msg.hybridInput });

            // Save global states
            global.currentCtrlType = msg.ctrlType || 'xbox360';
            global.hybridInputActive = msg.hybridInput;
            global.touchLayout = msg.touchLayout || 'default';
            global.enableMotion = !!msg.enableMotion;
            global.expDevices = msg.expDevices || [];

            // Update the orchestrator's global default FIRST (no viewerId = set global default),
            // then update each connected viewer's per-viewer entry.
            toUinput({ type: 'set-ctrl-type', viewerId: null, ctrlType: global.currentCtrlType });
            state.viewers.forEach((_, vid) => {
              toUinput({ type: 'set-ctrl-type', viewerId: vid, ctrlType: global.currentCtrlType });
            });

            // Broadcast to viewers so they update their touch layout
            broadcast(JSON.stringify({ type: 'ctrl-settings', touchLayout: global.touchLayout, enableMotion: global.enableMotion, expDevices: global.expDevices }));

            console.log("[host] ctrl-settings: forceXboxOne=%s enableDualShock=%s enableMotion=%s hybrid=%s ctrlType=%s touchLayout=%s",
              !!msg.forceXboxOne, !!msg.enableDualShock, !!msg.enableMotion, !!msg.hybridInput, global.currentCtrlType, global.touchLayout);
            return;
          }

          if (msg.type === "panic_toggle") {
            toUinput({ type: 'panic_toggle', enabled: !!msg.enabled });
            console.log("[host] KBM Panic Mode: %s", !!msg.enabled ? "ACTIVATED" : "Released");
            return;
          }

          // Auto-map: host notifies which window is focused → uinput picks preset from CSV
          if (msg.type === "window-focus") {
            toUinput({ type: "window-focus", title: msg.title });
            return;
          }
          if (msg.type === "set-input-mode") {
            const modeMap = {
              gamepad: { gp: true, kb: false },
              kbm: { gp: false, kb: true },
              kbm_emulated: { gp: true, kb: true },
              experimental: { gp: true, kb: true },
              disabled: { gp: false, kb: false }
            };
            const perms = modeMap[msg.mode] || { gp: true, kb: false };
            const cur = state.inputPerms.get(msg.viewerId) || { gp: true, kb: false, slot: null, mode: 'gamepad' };
            state.inputPerms.set(msg.viewerId, { ...cur, ...perms, mode: msg.mode });

            const realId = msg.viewerId.split('_')[0];
            const vws = state.viewers.get(realId);
            if (vws && vws.readyState === 1) {
              vws.send(JSON.stringify({ type: "input-state", gp: perms.gp, kb: perms.kb, mode: msg.mode }));
            } else if (vws === null && state.runtime.hostWS && state.runtime.hostWS.readyState === 1) {
              state.runtime.hostWS.send(JSON.stringify({ type: "input-state", gp: perms.gp, kb: perms.kb, mode: msg.mode, targetViewerId: realId }));
            }
            toUinput({ type: 'set-input-mode', viewerId: msg.viewerId, mode: msg.mode });
            broadcastRoster();
            return;
          }

          if (msg.type === "toggle-slot-lock") {
            const realId = msg.viewerId.split('_')[0];
            const cur = state.inputPerms.get(realId) || { gp: true, kb: false, slot: null };
            state.inputPerms.set(realId, { ...cur, locked: !!msg.locked });
            broadcastRoster();
            return;
          }

          if (msg.type === "regen-pin") {
            if (state.session.sessionPassword && arcadeSessions.size === 0) {
              console.log("[host] Ignoring regen-pin because persistent PIN is set.");
              return;
            }
            state.session.pin = makePin();
            console.log("[host] PIN regenerated: ****");
            if (state.runtime.hostWS && state.runtime.hostWS.readyState === 1) state.runtime.hostWS.send(JSON.stringify({ type: "regen-pin", pin: state.session.pin }));
            return;
          }

          if (msg.type === "arcade-session-start") {
            if (state.session.sessionPassword) {
              state.session.pin = makePin();
              if (state.runtime.hostWS && state.runtime.hostWS.readyState === 1) state.runtime.hostWS.send(JSON.stringify({ type: "regen-pin", pin: state.session.pin }));
            }

            const arcadeUrl = msg.tunnelUrl || state.runtime.tunnelUrl;
            if (!arcadeUrl) { /* error logic */ return; }

            const cfg = loadConfig(); // Fetch live config
            const sessionName = cfg.hostName || 'Host';
            const sessionId = 'ns-' + Date.now() + '-' + nextArcadeHostId();
            const session = {
              id: sessionId,
              game: msg.config?.title || 'Arcade Game',
              thumbnail: msg.config?.thumbnail || null,
              region: `${sessionName}'s Arcade`, // FIXED: Uses actual name for Rich Presence
              hasPin: !!msg.config?.requirePin,
              maxPlayers: parseInt(msg.config?.maxPlayers || 4),
              url: arcadeUrl,
              startedAt: Date.now(),
              isStreaming: true,
            };
            arcadeSessions.set(sessionId, session);
            console.log("[arcade] Session registered:", session.game, arcadeUrl);
            broadcastToArcade({ type: 'arcade-session-active', session });
            if (state.runtime.hostWS && state.runtime.hostWS.readyState === 1) state.runtime.hostWS.send(JSON.stringify({ type: 'arcade-session-active', session }));
            _arcadePost({ type: 'session-active', session });
            return;
          }

          if (msg.type === "arcade-session-stop") {
            if (state.session.sessionPassword) {
              state.session.pin = state.session.sessionPassword;
              if (state.runtime.hostWS && state.runtime.hostWS.readyState === 1) state.runtime.hostWS.send(JSON.stringify({ type: "regen-pin", pin: state.session.pin }));
            }
            for (const [id, s] of arcadeSessions) {
              arcadeSessions.delete(id);
              broadcastToArcade({ type: 'arcade-session-stopped', id });
              console.log("[arcade] Session stopped:", s.game);
              _arcadePost({ type: 'session-stopped', id });
            }
            return;
          }

          if (msg.type === "host-stream-ready") state.session.hostStreaming = true;
          if (msg.type === "host-stream-stopped") {
            state.session.hostStreaming = false;
            for (const [id, s] of arcadeSessions) {
              arcadeSessions.delete(id);
              broadcastToArcade({ type: 'arcade-session-stopped', id });
            }
            if (state.session.sessionPassword && state.session.pin !== state.session.sessionPassword) {
              state.session.pin = state.session.sessionPassword;
              if (state.runtime.hostWS && state.runtime.hostWS.readyState === 1) state.runtime.hostWS.send(JSON.stringify({ type: "regen-pin", pin: state.session.pin }));
            }
          }

          // ── VPS viewer registration ───────────────────────────────────────
          // When a viewer connects via the Rust SFU router, host.js forwards
          // synthetic join/leave messages so the server can manage the roster,
          // input permissions, and controller slots without a direct viewer WS.
          if (msg.type === 'vps-viewer-join') {
            const id = String(msg.viewerId || '').slice(0, 64);
            if (!id) return;
            if (!state.viewers.has(id)) {
              state.viewers.set(id, null);
              state.viewerNames.set(id, String(msg.name || id).slice(0, 48));
              const cfg = loadConfig();
              const defaultMode = cfg.defaultInputMode || 'gamepad';
              const padId = id + '_0';
              state.inputPerms.set(padId, {
                gp: defaultMode !== 'kbm',
                kb: defaultMode !== 'gamepad',
                slot: null,
                mode: defaultMode,
              });
              toUinput({ type: 'set-ctrl-type', viewerId: padId, ctrlType: global.currentCtrlType || 'xbox360' });
              if (state.runtime.hostWS && state.runtime.hostWS.readyState === 1) {
                state.runtime.hostWS.send(JSON.stringify({
                  type: 'viewer-joined',
                  viewerId: id,
                  name: state.viewerNames.get(id),
                  viewerRegion: msg.viewerRegion || null,
                  isDesktopApp: !!msg.isDesktopApp,
                }));
              }
              broadcastRoster();
              console.log('[VPS] Viewer joined:', id);
            }
            return;
          }

          if (msg.type === 'vps-viewer-leave') {
            const id = String(msg.viewerId || '').slice(0, 64);
            if (!id || !state.viewers.has(id)) return;
            state.viewers.delete(id);
            state.viewerNames.delete(id);
            const padId = id + '_0';
            toUinput({ type: 'flush_neutral', viewer_id: padId });
            toUinput({ type: 'disconnect_viewer', viewer_id: padId });
            state.inputPerms.delete(padId);
            if (state.runtime.hostWS && state.runtime.hostWS.readyState === 1) {
              state.runtime.hostWS.send(JSON.stringify({ type: 'viewer-left', viewerId: id }));
            }
            broadcastRoster();
            console.log('[VPS] Viewer left:', id);
            return;
          }

          // ── VPS viewer input ──────────────────────────────────────────────
          // Gamepad/KBM packets stamped with viewerId by host.js VPS bridge.
          // Route directly to the uinput driver — same path as local viewers.
          // IMPORTANT: viewerId here is the full Rust UUID (e.g. "f4a38b29-9dee-...")
          // inputPerms is keyed by "UUID_padIndex" — do NOT split on '_' or you lose the UUID.
          if ((msg.type === 'gamepad' || msg.type === 'keyboard' || msg.type === 'kbm' || msg.type === 'gpid') && msg.viewerId) {

            if (msg.type === 'gamepad') {
              // Add simple debug logging to see if VPS inputs even reach this point
              console.log(`[DEBUG VPS-GP] Arrived: viewerId=${msg.viewerId} pad_id=${msg.pad_id}`);
            }

            // Use the full UUID as canonical viewer id
            const id = String(msg.viewerId);
            const padIdx = (msg.type === 'gpid' ? (msg.padIndex || 0) : (msg.padIndex || 0));
            const padId = id + '_' + padIdx;

            if (msg.type === 'gpid') {
              const pads = state.viewerGamepads.get(id) || new Set();
              if (!pads.has(padIdx)) {
                pads.add(padIdx);
                state.viewerGamepads.set(id, pads);
                msg.pad_id = padId;
                msg.viewer_id = id;
                if (!state.inputPerms.has(padId)) state.inputPerms.set(padId, { gp: true, kb: false, slot: null, mode: 'gamepad' });
                if (state.runtime.hostWS && state.runtime.hostWS.readyState === 1) state.runtime.hostWS.send(JSON.stringify({ type: "viewer-gpid", viewerId: id, id: msg.id }));
                toUinput(msg);
                broadcastRoster();
              }
              return;
            }

            if (msg.type === 'keyboard') msg.type = 'kbm';

            // Always stamp with server-canonical padId so it matches inputPerms
            msg.pad_id = padId;
            msg.viewer_id = id;
            msg.viewerId = id;

            const perms = state.inputPerms.get(padId) || state.inputPerms.get(id + '_0') || { gp: true, kb: false };

            if (msg.type === 'kbm') {
              console.log(`[DEBUG KBM] (/ws/host) padId: ${padId}, perms: ${JSON.stringify(perms)}, Event: ${msg.event} ${msg.key}`);
            }

            if (msg.type === 'gamepad') {
              if (!perms.gp) {
                console.log(`[DEBUG VPS-GP] DROPPED: perms.gp is false for padId=${padId}. perms=`, perms);
                return;
              }
              const norm = normalizeGamepadMsg(msg);
              if (!norm) {
                console.log(`[DEBUG VPS-GP] DROPPED: normalizeGamepadMsg returned null`);
                return; // validator rejected it
              }
              inputDriver.send(norm);
              return;
            }
            if (msg.type === 'kbm' && !perms.kb) {
              console.log(`[DEBUG KBM] Dropped in /ws/host due to perms.kb=false`);
              return;
            }
            if (msg.type === 'kbm') console.log(`[DEBUG KBM] Sending to InputOrchestrator!`);
            inputDriver.send(msg);
            return;
          }

          const expTypes = ['tablet', 'vr', 'hotas', 'guitar', 'balanceboard', 'eyetracking', 'lightgun', 'adaptive', 'android', 'android-config', 'adaptive-config', 'config'];
          if (expTypes.includes(msg.type)) {
            experimentalDriver.send(msg);
            return;
          }

          broadcast(JSON.stringify(msg));

        } catch (err) {
          console.error("[host] Message parsing error:", err.message);
        }
      });

      ws.on("close", () => {
        console.log("[host] disconnected");
        state.runtime.hostWS = null;
        state.session.hostStreaming = false;
        for (const [id] of arcadeSessions) {
          arcadeSessions.delete(id);
          broadcastToArcade({ type: 'arcade-session-stopped', id });
        }
        broadcast(JSON.stringify({ type: "host-disconnected" }));
        // Stop routing daemon — no session active, audio should return to normal
        stopRouting();
      });

      // ── VIEWER ───────────────────────────────────────────────────────────────
    } else if (wsPath === "/ws/viewer") {
      const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
      const hasTunnelHeader = !!req.headers['x-forwarded-for'] || !!req.headers['cf-connecting-ip'];
      const requirePin = shouldRequirePin(clientIp, hasTunnelHeader);
      const anonHash = hashIp(clientIp);

      if (state.session.pinEnabled && requirePin) {
        const attempt = state.pinAttempts.get(anonHash) || { count: 0, lockedUntil: 0 };
        if (Date.now() < attempt.lockedUntil) {
          try { ws.send(JSON.stringify({ type: "pin-rejected", reason: "rate-limited" })); } catch { }
          ws.close(4001, "PIN_RATE_LIMITED");
          console.log(`[viewer] rejected — an anonymous user is rate-limited`);
          return;
        }
        if (pin !== state.session.pin) {
          attempt.count++;
          if (attempt.count >= 6) {
            attempt.lockedUntil = Date.now() + 2 * 60 * 1000;
            console.log(`[viewer] anonymous user locked out for 2 minutes (PIN brute-force)`);
          }
          state.pinAttempts.set(anonHash, attempt);
          try { ws.send(JSON.stringify({ type: "pin-rejected" })); } catch { }
          ws.close(4002, "PIN_REJECTED");
          console.log("[viewer] rejected — wrong PIN");
          return;
        }
        state.pinAttempts.delete(anonHash);
      } else {
        console.log(`[viewer] anonymous user (requirePin=${requirePin}) bypassing PIN check`);
      }

      // ── Session password check ────────────────────────────────────────────
      // Only run when there is NO active pin gate. When pinEnabled && requirePin
      // is true AND sessionPassword is set, PIN === sessionPassword, so the PIN
      // check above already validated the credential — checking again here causes
      // spurious session-password-required rejections for correctly authenticated viewers.
      if (state.session.sessionPassword && !(state.session.pinEnabled && requirePin)) {
        const provided = url.searchParams.get('password') || url.searchParams.get('pin') || '';
        if (provided !== state.session.sessionPassword) {
          try { ws.send(JSON.stringify({ type: 'session-password-required', reason: 'Session password incorrect.' })); } catch {}
          ws.close(4004, "SESSION_PASSWORD_REJECTED");
          console.log(`[viewer] rejected — wrong session password (non-PIN path) from ${clientIp}`);
          return;
        }
      }
      // ─────────────────────────────────────────────────────────────────────

      let id = "v" + (++state.runtime.vidCount);
      const defaultName = "Guest" + (1000 + Math.floor(Math.random() * 9000));

      // ── Arcade viewer cap ─────────────────────────────────────────────────
      // If an arcade session is active and has a maxPlayers limit, reject
      // viewers beyond that count before they are added to the viewers map.
      if (arcadeSessions.size > 0) {
        const sess = [...arcadeSessions.values()][0];
        if (sess && sess.maxPlayers && state.viewers.size >= sess.maxPlayers) {
          console.log(`[viewer] ${id} rejected — arcade session full (${state.viewers.size}/${sess.maxPlayers})`);
          ws.send(JSON.stringify({
            type: 'session-full',
            max: sess.maxPlayers,
            reason: `This session is full (${sess.maxPlayers} players max).`,
          }));
          ws.close();
          return;
        }
      }
      // ─────────────────────────────────────────────────────────────────────

      state.viewers.set(id, ws);
      state.viewerNames.set(id, defaultName);

      // FIX: Apply global hybrid state to new viewers joining
      const startKb = !!global.hybridInputActive;
      state.inputPerms.set(id + '_0', { gp: true, kb: startKb, slot: null });

      console.log("[viewer]", id, "(" + defaultName + ") joined (" + state.viewers.size + " total, " + controllerViewerCount() + " with controllers)");

      // Immediately tell Python to apply the correct profile to this new viewer
      toUinput({ type: 'set-ctrl-type', viewerId: id, ctrlType: global.currentCtrlType || 'xbox360' });

      // If hybrid is active, explicitly set the mode in Python rather than relying on the fallback.
      if (global.hybridInputActive) {
        toUinput({ type: 'set-input-mode', viewerId: id + '_0', mode: 'hybrid' });
      }

      ws.send(JSON.stringify({ type: "your-id", viewerId: id, name: defaultName }));
      ws.send(JSON.stringify({ type: "input-state", gp: true, kb: startKb, mode: startKb ? 'hybrid' : 'gamepad' }));

      // NOTE: viewer-joined is sent to the host inside the 'join' message handler below,
      // AFTER the viewer's chosen display name has arrived. This ensures the host dashboard
      // always shows the real name rather than the server-assigned Guest#### placeholder.

      ws.on("message", raw => {
        try {
          const msg = JSON.parse(raw);

          // ── NAME HANDSHAKE: viewer sends { type:'join', name, viewerId, pin } ──
          // This is the first message from the viewer after ws.onopen.
          // We update the name here, then fire viewer-joined to the host.
          if (msg.type === "join") {
            const joinName = sanitize(String(msg.name || '')).slice(0, 20) || defaultName;
            state.viewerNames.set(id, joinName);
            console.log("[viewer]", id, "name resolved to:", joinName);

            if (state.runtime.hostWS && state.runtime.hostWS.readyState === 1) {
              state.runtime.hostWS.send(JSON.stringify({
                type: "viewer-joined",
                viewerId: id,
                name: joinName,
                viewerRegion: msg.viewerRegion || null,
                isDesktopApp: !!msg.isDesktopApp
              }));
              // Include the saved host name so the viewer can display "HOST SESSION — Name"
              const hCfg = loadConfig();
              ws.send(JSON.stringify({ type: "host-connected", hostName: hCfg.hostName || 'Host' }));
              ws.send(JSON.stringify({
                type: "ctrl-settings",
                enableMotion: !!global.enableMotion,
                touchLayout: global.touchLayout || 'default',
                expDevices: global.expDevices || []
              }));
              if (state.session.hostStreaming) {
                ws.send(JSON.stringify({ type: "host-stream-ready" }));
              }
            }

            broadcastRoster();
            return;
          }

          // Inject viewer ID for answers AND mic renegotiation requests
          if (msg.type === "answer" || msg.type === "ice-viewer" || msg.type === "viewer-mic-ready") {
            msg._viewerId = id;
            if (state.runtime.hostWS && state.runtime.hostWS.readyState === 1) state.runtime.hostWS.send(JSON.stringify(msg));
            return;
          }

          if (msg.type === "host-not-streaming") {
            const vws = state.viewers.get(msg.viewerId);
            if (vws && vws.readyState === 1) vws.send(JSON.stringify(msg));
            return;
          }

          if (msg.type === "viewer-rejoin") {
            const claimedId = msg.viewerId;
            if (claimedId && state.viewers.has(claimedId)) {
              const tempId = id;
              state.viewers.set(claimedId, ws);
              state.viewers.delete(tempId);
              state.viewerNames.set(claimedId, state.viewerNames.get(tempId) || state.viewerNames.get(claimedId) || "Guest");
              state.viewerNames.delete(tempId);
              if (state.viewerHasController.has(tempId)) {
                state.viewerHasController.delete(tempId);
                state.viewerHasController.add(claimedId);
              }
              console.log("[viewer]", claimedId, "rejoined (slot reused, no duplicate)");
              id = claimedId;
              if (state.runtime.hostWS && state.runtime.hostWS.readyState === 1) {
                state.runtime.hostWS.send(JSON.stringify({ type: "viewer-left", viewerId: tempId }));
                state.runtime.hostWS.send(JSON.stringify({ type: "viewer-joined", viewerId: id, name: state.viewerNames.get(id) }));
              }
              ws.send(JSON.stringify({ type: "your-id", viewerId: id, name: state.viewerNames.get(id) }));
              broadcastRoster();
            }
            return;
          }

          if (msg.type === "request-offer") {
            if (state.runtime.hostWS && state.runtime.hostWS.readyState === 1)
              state.runtime.hostWS.send(JSON.stringify({ type: "viewer-joined", viewerId: id, name: state.viewerNames.get(id) || id }));
            return;
          }

          if (msg.type === "gpid") {
            const padIdx = msg.padIndex || 0;
            const pads = state.viewerGamepads.get(id) || new Set();
            if (pads.has(padIdx)) return;

            const hwKey = (msg.id || 'unknown') + ':' + padIdx;
            const staleViewerId = state.hwIdToViewer.get(hwKey);
            if (staleViewerId && staleViewerId !== id) {
              console.log("[viewer] evicting stale hw registration:", hwKey, "from", staleViewerId, "→", id);
              const stalePads = state.viewerGamepads.get(staleViewerId);
              if (stalePads) {
                stalePads.delete(padIdx);
                if (stalePads.size === 0) {
                  state.viewerGamepads.delete(staleViewerId);
                  state.viewerHasController.delete(staleViewerId);
                }
              }
              state.inputPerms.delete(staleViewerId + '_' + padIdx);
              toUinput({ type: 'disconnect_viewer', viewer_id: staleViewerId });
            }
            state.hwIdToViewer.set(hwKey, id);

            const totalPads = [...state.viewerGamepads.values()].reduce((sum, s) => sum + s.size, 0);
            if (totalPads >= 16) {
              console.log("[viewer] global slot cap (16) reached, ignoring from", id);
              return;
            }
            if ((state.viewerGamepads.get(id) || new Set()).size >= 4) {
              console.log("[viewer] per-viewer cap (4) reached for", id);
              return;
            }

            pads.add(padIdx);
            state.viewerGamepads.set(id, pads);
            msg.pad_id = id + '_' + padIdx;
            if (!state.inputPerms.has(msg.pad_id)) state.inputPerms.set(msg.pad_id, { gp: true, kb: false, slot: null });

            const isNewController = !state.viewerHasController.has(id);
            state.viewerHasController.add(id);
            if (isNewController) {
              playJoinSound();
              console.log("[viewer]", id, "controller detected — now counted (" + controllerViewerCount() + " with controllers)");
            }
            if (state.runtime.hostWS && state.runtime.hostWS.readyState === 1) state.runtime.hostWS.send(JSON.stringify({ type: "viewer-gpid", viewerId: id, id: msg.id }));
            toUinput(msg);
            broadcastRoster();
            return;
          }

          if (msg.type === "set-name") {
            const name = sanitize(String(msg.name || '')).slice(0, 20) || state.viewerNames.get(id);
            state.viewerNames.set(id, name);
            ws.send(JSON.stringify({ type: "name-confirmed", name }));
            if (state.runtime.hostWS && state.runtime.hostWS.readyState === 1) state.runtime.hostWS.send(JSON.stringify({ type: "viewer-renamed", viewerId: id, name }));
            broadcastRoster();
            return;
          }

          if (msg.type === "chat") {
            msg.msg = sanitize(msg.msg);
            msg.from = sanitize(state.viewerNames.get(id) || msg.from || 'Guest').slice(0, 20);
            broadcast(JSON.stringify(msg));
            if (state.runtime.hostWS && state.runtime.hostWS.readyState === 1) state.runtime.hostWS.send(JSON.stringify(msg));
            return;
          }

          if (msg.type === "touch-disconnect") {
            const padIdx = 99;
            const rosterId = id + '_' + padIdx;
            const pads = state.viewerGamepads.get(id);
            if (pads) pads.delete(padIdx);
            toUinput({ type: 'flush_neutral', viewer_id: rosterId });
            toUinput({ type: 'disconnect_viewer', viewer_id: rosterId });
            broadcastRoster();
            return;
          }

          if (msg.type === "gamepad" || msg.type === "keyboard") {
            if (msg.type === "keyboard") msg.type = "kbm";

            // ── PPS flood protection ──────────────────────────────────────────
            // Track packets per second per viewer. Drop the packet and kick the
            // viewer if they exceed 300 input messages per second.
            const _ppsNow = Date.now();
            if (!ws._ppsWindow || _ppsNow - ws._ppsWindow >= 1000) {
              ws._ppsWindow = _ppsNow;
              ws._ppsCount = 1;
            } else {
              ws._ppsCount = (ws._ppsCount || 0) + 1;
              if (ws._ppsCount > 300) {
                console.warn(`[PPS] Viewer ${id} exceeded 300 inputs/sec — disconnecting`);
                if (state.runtime.hostWS && state.runtime.hostWS.readyState === 1) {
                  state.runtime.hostWS.send(JSON.stringify({ type: 'viewer-flood-kick', viewerId: id }));
                }
                ws.close(1008, 'pps_flood');
                return;
              }
            }
            // ─────────────────────────────────────────────────────────────────
            const padIdx = msg.padIndex || 0;
            const rosterId = msg.type === "gamepad" ? id + '_' + padIdx : id + '_0';

            if (msg.type === "gamepad") {
              const pads = state.viewerGamepads.get(id) || new Set();
              if (!pads.has(padIdx)) {
                pads.add(padIdx);
                state.viewerGamepads.set(id, pads);
                if (!state.inputPerms.has(rosterId)) state.inputPerms.set(rosterId, { gp: true, kb: false, slot: null });
                const isNew = !state.viewerHasController.has(id);
                state.viewerHasController.add(id);
                if (isNew) {
                  playJoinSound();
                  console.log("[viewer]", id, "controller auto-detected from input");
                }
                broadcastRoster();
              }
            }

            const perms = state.inputPerms.get(id) || state.inputPerms.get(rosterId) || { gp: true, kb: false };

            if (msg.type === 'kbm') {
              console.log(`[DEBUG KBM] (app.ws) id: ${id}, rosterId: ${rosterId}, perms: ${JSON.stringify(perms)}, Event: ${msg.event} ${msg.key}`);
            }

            if (msg.type === "gamepad" && !perms.gp) return;
            if (msg.type === "kbm" && !perms.kb) {
              console.log(`[DEBUG KBM] Dropped in app.ws due to perms.kb=false`);
              return;
            }

            // If viewer's primary slot is kbm_emulated, suppress any extra gamepad devices
            // (e.g. touch padIndex:99) to prevent a second virtual gamepad appearing in the OS.
            // EXCEPTION: padIdx >= 100 are native XInput pads from read_gamepads.py via Electron IPC
            // and must always pass through regardless of the primary slot's input mode.
            if (msg.type === "gamepad" && padIdx !== 0 && padIdx < 100) {
              const primaryPerms = state.inputPerms.get(id + '_0') || {};
              const primaryMode = primaryPerms.gp && primaryPerms.kb ? 'kbm_emulated' : 'gamepad';
              if (primaryMode === 'kbm_emulated') return;
            }

            msg.pad_id = rosterId;
            const norm = normalizeGamepadMsg(msg);
            if (norm) toUinput(norm);
            return;
          }
        } catch { }
      });

      ws.on("close", () => {
        const hadController = state.viewerHasController.has(id);
        const wasActive = state.viewers.get(id) === ws;
        if (wasActive) {
          state.viewers.delete(id);
          state.viewerNames.delete(id);
          state.viewerGamepads.delete(id);
          state.viewerHasController.delete(id);
          for (const [hwKey, vid] of state.hwIdToViewer) {
            if (vid === id) state.hwIdToViewer.delete(hwKey);
          }
          if (hadController) {
            playLeaveSound();
            toUinput({ type: 'flush_neutral', viewer_id: id });
            toUinput({ type: 'disconnect_viewer', viewer_id: id });
          }
          broadcastRoster();
          if (state.runtime.hostWS && state.runtime.hostWS.readyState === 1) state.runtime.hostWS.send(JSON.stringify({ type: "viewer-left", viewerId: id, name: state.viewerNames.get(id) || id }));
        }
        console.log("[viewer]", id, "left (" + state.viewers.size + " total, " + controllerViewerCount() + " with controllers)");
      });

      // ── ARCADE CLIENTS ────────────────────────────────────────────────────────
    } else if (wsPath === "/ws/arcade") {
      arcadeClients.add(ws);
      ws.send(JSON.stringify({ type: 'arcade-sessions', sessions: [...arcadeSessions.values()] }));
      ws.on("message", raw => {
        try {
          const msg = JSON.parse(raw);
          if (msg.type === 'arcade-query') {
            ws.send(JSON.stringify({ type: 'arcade-sessions', sessions: [...arcadeSessions.values()] }));
          }
        } catch { }
      });
      ws.on("close", () => arcadeClients.delete(ws));

      // ── AUDIO ─────────────────────────────────────────────────────────────────
    } else if (wsPath === "/ws/audio-host") {
      ws.on("message", raw => { audioViewers.forEach(v => { if (v.readyState === 1) v.send(raw); }); });

    } else if (wsPath === "/ws/audio") {
      audioViewers.add(ws);
      ws.on("close", () => audioViewers.delete(ws));

      // ── DEDICATED INPUT CHANNEL ───────────────────────────────────────────────
    } else if (wsPath === "/ws/input") {
      let myId = null;
      ws.on("message", raw => {
        try {
          const msg = JSON.parse(raw);
          if (msg.type === "identify") { myId = msg.viewerId; console.log("[input] identified as", myId); return; }
          if (msg.type === "gpid") {
            if (state.runtime.hostWS && state.runtime.hostWS.readyState === 1) state.runtime.hostWS.send(JSON.stringify({ type: "viewer-gpid", viewerId: myId, id: msg.id }));
            return;
          }
          if (msg.type === "gamepad") {
            if (!myId) return;
            const perms = state.inputPerms.get(msg.pad_id) || state.inputPerms.get(myId + '_0') || { gp: true, kb: false };
            if (!perms.gp) return;
            toUinput(normalizeGamepadMsg(msg));
            return;
          }

          if (msg.type === "keyboard" || msg.type === "kbm") {
            console.log(`[DEBUG KBM] (/ws/input) received keyboard event:`, msg.event, msg.key);
            if (!myId) {
              console.log(`[DEBUG KBM] Dropped in /ws/input: myId is null`);
              return;
            }
            const perms = state.inputPerms.get(msg.pad_id) || state.inputPerms.get(myId + '_0') || { gp: true, kb: false };
            if (!perms.kb) {
              console.log(`[DEBUG KBM] Dropped in /ws/input: perms.kb=false for id ${myId}`);
              return;
            }
            console.log(`[DEBUG KBM] Sending to InputOrchestrator from /ws/input!`);
            toUinput(msg);
            return;
          }

          const expTypes = ['tablet', 'vr', 'hotas', 'guitar', 'balanceboard', 'eyetracking', 'lightgun', 'adaptive', 'android', 'android-config', 'adaptive-config', 'config'];
          if (expTypes.includes(msg.type)) {
            experimentalDriver.send(msg);
            return;
          }
        } catch (e) { console.error("[input] error:", e.message); }
      });
    }
  });

  // Heartbeat — reap dead WebSockets every 30 seconds
  const interval = setInterval(() => {
    wss.clients.forEach(ws => {
      if (ws.isAlive === false) return ws.terminate();
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000);
  wss.on('close', () => clearInterval(interval));
}

module.exports = { attachWebSocketServer };
