'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ipcMain } = require('electron');
const { flags } = require('./cli-flags.js');
const { CONFIG_FILE } = require('./settings.js');
const { appendLog } = require('./logger.js');
const state = require('./state.js');

// ── DISCORD PROTOCOL REGISTRATION (Linux fix) ────────────────────────────────
// Creates the ~/.local/share/applications/discord-<id>.desktop file that XDG
// uses to route "Ask to Join" deep links to our app, and registers the
// x-scheme-handler in mimeapps.list. Upstream v3.0.2 replaced discord-rpc's
// register() (which silently no-ops when Discord's own desktop integration
// files are missing) with this manual implementation.
// MUST run at startup (not lazily) or the protocol handler never exists.
function _writeProtocolFiles(clientId) {
  const protocol = 'discord-' + clientId;
  const home = os.homedir();
  const appsDir = path.join(home, '.local', 'share', 'applications');
  const desktopFile = path.join(appsDir, protocol + '.desktop');
  const mimeType = 'x-scheme-handler/' + protocol;

  const args = process.argv.slice(1).join(' ');
  const execLine = process.execPath + ' ' + args + ' %u';

  if (!fs.existsSync(appsDir)) fs.mkdirSync(appsDir, { recursive: true });

  fs.writeFileSync(
    desktopFile,
    [
      '[Desktop Entry]',
      'Type=Application',
      'Name=Nearcade (Discord Join)',
      'Exec=' + execLine,
      'MimeType=' + mimeType + ';',
      'StartupNotify=true',
      'Categories=Network;',
      'NoDisplay=true',
    ].join('\n'),
    'utf-8'
  );

  const mimeAppsPath = path.join(home, '.config', 'mimeapps.list');
  let mimeContent = '';
  if (fs.existsSync(mimeAppsPath)) {
    mimeContent = fs
      .readFileSync(mimeAppsPath, 'latin1')
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .filter((l) => {
        if (l.startsWith(mimeType + '=')) return false;
        if (l.includes(mimeType) && !l.startsWith('[') && !l.startsWith('#')) return false;
        return true;
      })
      .join('\n');
  }

  const marker = '[Default Applications]';
  const newLine = mimeType + '=' + protocol + '.desktop';
  if (mimeContent.includes(marker)) {
    mimeContent = mimeContent.replace(marker, marker + '\n' + newLine);
  } else {
    mimeContent += (mimeContent ? '\n' : '') + marker + '\n' + newLine + '\n';
  }

  fs.writeFileSync(mimeAppsPath, mimeContent, 'utf-8');
  console.log('[Discord] Protocol ' + protocol + ' registered (desktop file + mimeapps.list)');
}

function registerDiscordProtocol() {
  try {
    const _earlySettings = (() => {
      try {
        return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      } catch {
        return {};
      }
    })();
    const _discordClientId = _earlySettings.discordClientId || '1522864642953711776';
    if (!flags.isArcadeWorker && process.platform === 'linux') _writeProtocolFiles(_discordClientId);
  } catch (e) {
    console.log('[Discord] Protocol registration failed:', e.message);
  }
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
