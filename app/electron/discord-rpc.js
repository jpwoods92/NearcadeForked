'use strict';
const fs = require('fs');
const { ipcMain } = require('electron');
const { flags } = require('./cli-flags.js');
const { CONFIG_FILE } = require('./settings.js');
const { appendLog } = require('./logger.js');
const state = require('./state.js');

// ── DISCORD PROTOCOL REGISTRATION (Linux fix) ────────────────────────────────
// DiscordRPC.register() creates the ~/.local/share/applications/discord-<id>.desktop
// file that XDG uses to route "Ask to Join" deep links to our app.
// This MUST run at startup (not lazily) or the protocol handler never exists.
//
// Deliberately reads its own minimal config snapshot instead of going through
// electron/settings.js's loadSettings() — this runs before the rest of the
// boot sequence and historically used its own independent fallback client ID
// ('1241907722765324391', not DEFAULTS.discordClientId's
// '1522864642953711776'). Preserved verbatim rather than "fixed" here.
function registerDiscordProtocol() {
  try {
    const _earlySettings = (() => {
      try {
        return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      } catch {
        return {};
      }
    })();
    const _discordClientId = _earlySettings.discordClientId || '1241907722765324391';
    if (!flags.isArcadeWorker) require('discord-rpc').register(_discordClientId);
  } catch (_) {}
}

// ── Discord RPC client (activity updates) ──
let rpc = null;
let rpcReady = false;
let latestActivity = null;

function register() {
  const DiscordRPC = require('discord-rpc');

  ipcMain.on('discord-set-activity', (event, activity) => {
    const settings = state.runtime.settings;
    appendLog(`[Discord RPC] Requested activity: ${JSON.stringify(activity)}`);
    if (!settings.discordRPC) {
      appendLog('[Discord RPC] Aborted because settings.discordRPC is false');
      return;
    }
    latestActivity = activity;

    if (!rpc) {
      appendLog('[Discord RPC] Initializing new client...');
      DiscordRPC.register(settings.discordClientId);
      rpc = new DiscordRPC.Client({ transport: 'ipc' });

      rpc.on('ready', () => {
        appendLog('[Discord RPC] Client Ready');
        rpcReady = true;

        // Subscribe to unlock Invite buttons in Discord UI
        try {
          rpc.subscribe('ACTIVITY_JOIN', (args) => {
            appendLog(`[Discord RPC] Received ACTIVITY_JOIN: ${JSON.stringify(args)}`);
            // Here we could handle URL launches or IPC events if needed later
          });
          rpc.subscribe('ACTIVITY_JOIN_REQUEST', (args) => {
            appendLog(`[Discord RPC] Received ACTIVITY_JOIN_REQUEST: ${JSON.stringify(args)}`);
          });
          appendLog('[Discord RPC] Subscribed to JOIN events');
        } catch (e) {
          appendLog(`[Discord RPC] Subscribe error: ${e.message}`);
        }

        if (latestActivity) {
          rpc
            .setActivity(latestActivity)
            .then(() => appendLog('[Discord RPC] Activity successfully set!'))
            .catch((err) => appendLog(`[Discord RPC] setActivity failed: ${err.message}`));
        }
      });

      rpc.on('disconnected', () => {
        appendLog('[Discord RPC] Disconnected');
        rpcReady = false;
        rpc = null;
      });

      rpc.login({ clientId: settings.discordClientId }).catch((err) => {
        appendLog(`[Discord RPC] login failed: ${err.message}`);
        rpc = null;
        rpcReady = false;
      });
    } else if (rpcReady) {
      rpc
        .setActivity(latestActivity)
        .then(() => appendLog('[Discord RPC] Activity successfully updated!'))
        .catch((err) => appendLog(`[Discord RPC] updateActivity failed: ${err.message}`));
    } else {
      appendLog('[Discord RPC] Client exists but not ready yet. Caching activity.');
    }
  });

  ipcMain.on('discord-clear', () => {
    latestActivity = null;
    if (rpc && rpcReady) {
      rpc.clearActivity().catch(console.error);
    }
  });
}

module.exports = { registerDiscordProtocol, register };
