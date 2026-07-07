const {
  app, powerSaveBlocker, globalShortcut,
} = require('electron');
const path = require('path');

const state = require('./electron/state.js');
const { flags, applyConfigOverrides } = require('./electron/cli-flags.js');
const { loadSettings, CONFIG_FILE } = require('./electron/settings.js');
const logger = require('./electron/logger.js');
const discordRpc = require('./electron/discord-rpc.js');
const updater = require('./electron/updater.js');
const { createWindow } = require('./electron/window.js');
const ipcModules = [
  require('./electron/ipc/session.js'),
  require('./electron/ipc/gamepad.js'),
  require('./electron/ipc/app-settings.js'),
  require('./electron/ipc/vps-config.js'),
  require('./electron/ipc/window-controls.js'),
  require('./electron/ipc/setup-runner.js'),
  require('./electron/ipc/clipboard.js'),
  require('./electron/ipc/app-info.js'),
  require('./electron/ipc/log-viewing.js'),
];

powerSaveBlocker.start('prevent-app-suspension');
process.env['ELECTRON_DISABLE_SECURITY_WARNINGS'] = 'true';

const gotTheLock = flags.isArcadeWorker ? true : app.requestSingleInstanceLock();

// ── DISCORD PROTOCOL REGISTRATION (Linux fix) ────────────────────────────────
// DiscordRPC.register() creates the ~/.local/share/applications/discord-<id>.desktop
// file that XDG uses to route "Ask to Join" deep links to our app.
// This MUST run at startup (not lazily) or the protocol handler never exists.
discordRpc.registerDiscordProtocol();
// ─────────────────────────────────────────────────────────────────────────────

logger.installSessionLogger();

// ── AUTOMATIC CONFIGURATION OVERRIDES ──
applyConfigOverrides(CONFIG_FILE);
// ──────────────────────────────────────────

if (!gotTheLock) {
  app.quit();
  process.exit(0);
}

process.on('uncaughtException', (e) => console.error('\n[electron] ⚠ Uncaught Exception:', e));
process.on('unhandledRejection', (e) => {
  if (!e?.message?.includes('could not be cloned') && !e?.message?.includes('no video stream')) {
    console.error('\n[electron] ⚠ Unhandled Rejection:', e);
  }
});

// ── REQ 3: Robust signal handlers ────────────────────────────────────────────
// Both branches below defer the actual pactl matching/purging to
// audio-routing.js's purgeStaleModules() — previously each reimplemented its
// own copy of the same "which modules are ours" logic (REFACTOR_PLAN.md
// Phase 8). Lazily required so this file doesn't pay for server.js's require
// graph unless a stale-module purge is actually needed.
function _electronSignalCleanup(signal) {
  console.log(`\n[electron] Received ${signal} — triggering cleanup...`);
  if (state.runtime.serverCore && state.runtime.serverCore.cleanup) {
    state.runtime.serverCore.cleanup(false);
  } else {
    require('./src/scripts/server/audio-routing.js').purgeStaleModules();
    process.exit(0);
  }
}
process.on('SIGINT', () => _electronSignalCleanup('SIGINT'));
process.on('SIGTERM', () => _electronSignalCleanup('SIGTERM'));

// ── REQ 3: Startup purge ─────────────────────────────────────────────────────
require('./src/scripts/server/audio-routing.js').purgeStaleModules();

if (process.platform === 'darwin') app.dock.setIcon(path.join(__dirname, '..', 'assets/NearsecTogetherLogo.png'));

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// ── WAYLAND & HARDWARE ENCODING OPTIMIZATIONS ──
if (flags.isArcadeWorker && process.platform === 'linux') {
  app.commandLine.appendSwitch('ozone-platform-hint', 'x11');
  app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer');
} else if (process.platform === 'linux') {
  const isGamescope = (process.env.XDG_CURRENT_DESKTOP || '').toLowerCase().includes('gamescope') ||
    (process.env.DESKTOP_SESSION || '').toLowerCase().includes('gamescope') ||
    process.env.SteamDeck === '1' ||
    process.env.SteamGamepadUI === '1';

  if (isGamescope) {
    // Force X11/XWayland under Gamescope to prevent Electron crashes with native Wayland
    app.commandLine.appendSwitch('ozone-platform-hint', 'x11');
    app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer,CanvasOopRasterization');
    // CRITICAL for SteamOS Game Mode: Steam's nested bwrap conflicts with Electron's sandbox
    app.commandLine.appendSwitch('no-sandbox');
    app.commandLine.appendSwitch('disable-gpu-sandbox');
  } else {
    // Force native Wayland with decorations on other Linux DEs
    app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
    app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer,WaylandWindowDecorations,VaapiVideoEncoder,VaapiVideoDecoder,CanvasOopRasterization');
  }

  // Unlock zero-copy DMA-BUF memory passing
  app.commandLine.appendSwitch('enable-zero-copy');
}

// ── GLOBAL PERFORMANCE FLAGS ──
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('disable-gpu-vsync');
app.commandLine.appendSwitch('disable-frame-rate-limit');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.commandLine.appendSwitch('force-color-profile', 'srgb');
app.commandLine.appendSwitch('force-high-performance-gpu');
app.commandLine.appendSwitch('disable-gpu-driver-bug-workarounds');
app.commandLine.appendSwitch('disable-rtc-smoothness-algorithm');
app.commandLine.appendSwitch('disable-hardware-cursors');

state.runtime.settings = loadSettings();

function registerIpcHandlers() {
  for (const mod of ipcModules) mod.register();
  discordRpc.register();
  updater.register();
}

app.whenReady().then(() => {
  registerIpcHandlers();
  createWindow();

  let isPanicActive = false;

  globalShortcut.register('CommandOrControl+Shift+Backspace', () => {
    isPanicActive = !isPanicActive;
    console.log(`\n[electron] PANIC MODE ${isPanicActive ? 'ACTIVATED' : 'DEACTIVATED'}`);
    if (state.runtime.serverCore && state.runtime.serverCore.toUinput) {
      state.runtime.serverCore.toUinput({ type: 'panic_toggle', enabled: isPanicActive });
    }
  });

  // Auto-updater logic
  updater.init();
});

app.on('will-quit', () => {
  if (app.isReady()) {
    globalShortcut.unregisterAll();
  }
  if (state.runtime.serverCore && state.runtime.serverCore.cleanup) state.runtime.serverCore.cleanup(true);
});

// FIX #18 + FIX #23: before-quit ensures tunnel PGID kill and virtual gamepad teardown
app.on('before-quit', () => {
  if (state.runtime.serverCore && state.runtime.serverCore.cleanup) state.runtime.serverCore.cleanup(true);
});

app.on('window-all-closed', () => app.quit());

app.on('second-instance', (_event, argv) => {
  const win = state.runtime.win;
  if (win) {
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.show();
    win.focus();
  }

  // ── Discord "Ask to Join" deep link handler (Linux) ──
  // When a friend clicks "Join" on Discord, it spawns a second instance of the app
  // with the joinSecret passed as a discord-<clientId>:// URI in argv.
  // We parse that URI here and navigate the window to the session.
  if (!win || !state.runtime.serverPort) return;
  const joinArg = argv.find(a => a.startsWith('discord-'));
  if (!joinArg) return;

  try {
    // The URI is: discord-<clientId>://discord/join?secret=<joinSecret>
    const url = new URL(joinArg);
    const secret = url.searchParams.get('secret');
    if (!secret || secret === 'none') return;

    console.log('[Discord] Ask-to-Join received, secret:', secret);

    // The joinSecret is either a P2P room code or a tunnel URL.
    // Tunnel URLs start with http(s)://; everything else is a P2P room code.
    // viewer.js expects P2P codes as: ?host=p2p://ROOMCODE
    const isUrl = secret.startsWith('http://') || secret.startsWith('https://');
    const viewerUrl = isUrl
      ? `http://localhost:${state.runtime.serverPort}/?client=1&compat=1&host=${encodeURIComponent(secret)}`
      : `http://localhost:${state.runtime.serverPort}/?client=1&compat=1&host=${encodeURIComponent('p2p://' + secret)}`;

    win.loadURL(viewerUrl);
  } catch (e) {
    console.error('[Discord] Failed to parse join URI:', e.message);
  }
});
