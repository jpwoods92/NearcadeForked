'use strict';
const { BrowserWindow, Tray, Menu, nativeImage, shell, desktopCapturer, app } = require('electron');
const os = require('os');
const path = require('path');
const state = require('./state.js');
const { flags } = require('./cli-flags.js');
const { appendLog } = require('./logger.js');
const { saveSettings } = require('./settings.js');

// This module lives at app/electron/window.js — one level below the app/
// directory that electron-main.js used to sit in directly, and two levels
// below the repo root.
const isGamescopeEnv =
  (process.env.XDG_CURRENT_DESKTOP || '').toLowerCase().includes('gamescope') ||
  (process.env.DESKTOP_SESSION || '').toLowerCase().includes('gamescope') ||
  process.env.SteamDeck === '1' ||
  process.env.SteamGamepadUI === '1';

function startServer() {
  return new Promise((resolve) => {
    process.env.ELECTRON_MODE = '1';

    state.runtime.serverCore = require('../src/scripts/server.js');
    const _appLog = console.log.bind(console);

    // We must safely wrap whatever console.log server.js just created,
    // and restore IT, not the original Node.js one.
    const _serverLog = console.log;
    console.log = function (...args) {
      _serverLog(...args);
      const s = args.join(' ');
      const m = s.match(/Listening on port (\d+)/);
      if (m && !state.runtime.serverPort) {
        state.runtime.serverPort = parseInt(m[1]);
        console.log = _serverLog; // Restore the server.js scrubber
        resolve(state.runtime.serverPort);
      }
    };
    setTimeout(() => {
      if (!state.runtime.serverPort) {
        state.runtime.serverPort = 3000;
        console.log = _serverLog;
        resolve(3000);
      }
    }, 6000);
  });
}

async function createWindow() {
  const settings = state.runtime.settings;
  const port = await startServer();
  console.log('[electron] server ready on port', port);

  const win = new BrowserWindow({
    width: Math.max(settings.w, 600),
    height: Math.max(settings.h, 500),
    minWidth: 600,
    minHeight: 500,
    title: 'NearsecTogether',
    icon: path.join(__dirname, '..', '..', 'assets/NearsecTogetherLogo.png'),
    backgroundColor: '#111111',
    alwaysOnTop: settings.alwaysOnTop,
    show: isGamescopeEnv ? true : false,
    fullscreen: isGamescopeEnv ? true : false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '..', 'electron-preload.js'),
    },
    autoHideMenuBar: true,
  });
  state.runtime.win = win;

  if (!isGamescopeEnv) {
    win.once('ready-to-show', () => {
      if (!flags.isArcadeWorker) win.show();
    });
  }

  if (flags.isArcadeWorker) {
    function getCliArg(flag) {
      const idx = process.argv.indexOf(flag);
      return idx > -1 ? process.argv[idx + 1] : null;
    }
    const gameName = getCliArg('--game-name') || 'Arcade Game';
    const tunnelProv = getCliArg('--game-tunnel') || 'cloudflared';
    win.loadURL(
      `http://localhost:${port}/host?auto=1&title=${encodeURIComponent(gameName)}&tunnel=${encodeURIComponent(tunnelProv)}`
    );
  } else {
    win.loadURL(`http://localhost:${port}/dashboard?port=${port}`);
  }

  // Intercept frontend logs to save them to the session file (but DO NOT spam terminal)
  win.webContents.on('console-message', (event, level, message, line, sourceId) => {
    let prefix = '[FrontEnd]';
    if (level === 2) prefix = '[FrontEnd WARN]';
    if (level === 3) prefix = '[FrontEnd ERR]';
    appendLog(`${prefix} ${message}`);
  });

  win.webContents.on('did-fail-load', (e, code, desc) => {
    if (code === -3) return;
    console.error('[electron] failed to load:', code, desc);
    setTimeout(() => {
      if (flags.isArcadeWorker) win.loadURL(`http://localhost:${port}/host?auto=1`);
      else win.loadURL(`http://localhost:${port}/dashboard?port=${port}`);
    }, 1000);
  });

  // ── Dashboard Button Injection ──
  win.webContents.on('did-finish-load', () => {
    const currentURL = win.webContents.getURL();
    if (currentURL.includes('/old_host')) {
      win.webContents.executeJavaScript(`
      if (!document.getElementById('ns-dash-btn') && window.electronAPI) {
        const btn = document.createElement('button');
        btn.id = 'ns-dash-btn';
        btn.innerHTML = '← Dashboard';
        btn.style.cssText = 'position:fixed;bottom:24px;left:0;opacity:0.8;z-index:999999;padding:12px 20px;background:#141414;color:#aaa;border:1px solid #252525;border-left:none;border-radius:0 8px 8px 0;font-family:monospace;font-weight:bold;cursor:pointer;transition:all 0.2s;';
        btn.onmouseover = () => { btn.style.opacity='1'; btn.style.color='#c084fc'; btn.style.borderColor='#c084fc'; };
        btn.onmouseleave = () => { btn.style.opacity='0.8'; btn.style.color='#aaa'; btn.style.borderColor='#252525'; };
        btn.onclick = () => window.electronAPI.backToDashboard();
        document.body.appendChild(btn);
      }
      `);
    }
  });

  win.webContents.session.setPermissionCheckHandler(() => true);
  win.webContents.session.setPermissionRequestHandler((wc, permission, callback) => callback(true));

  // ── UNIFIED CAPTURE HANDLER (Fixes PipeWire Deadlocks & UI Freezes & Windows Bugs) ──
  win.webContents.session.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer
      .getSources({ types: ['screen', 'window'] })
      .then((sources) => {
        if (sources && sources.length > 0) {
          let chosenSource = sources[0]; // Default to screen
          if (state.runtime.selectedSourceId) {
            const match = sources.find((s) => s.id === state.runtime.selectedSourceId);
            if (match) chosenSource = match;
            state.runtime.selectedSourceId = null; // Consume the ID
          }

          // WINDOWS AUDIO FIX: 'loopback' enables capturing desktop audio
          if (process.platform === 'win32') callback({ video: chosenSource, audio: 'loopback' });
          else callback({ video: chosenSource });
        } else {
          console.log('[electron] Capture blocked or no sources found. Cancelling.');
          callback(); // Empty callback safely aborts without crashing PipeWire

          // ANTI-FREEZE INJECTION: Forcefully unlock the frontend UI buttons
          if (win && !win.isDestroyed()) {
            win.webContents
              .executeJavaScript(
                `
          if (typeof _elDisabled === 'function') {
            _elDisabled('btnStart', false);
            _elDisabled('btnSwitch', false);
            _elDisabled('btnStop', true);
            if (typeof setCapDot === 'function') setCapDot('');
          }
          `
              )
              .catch(() => {});
          }
        }
      })
      .catch((err) => {
        console.error('[electron] Capturer error:', err);
        callback(); // Empty callback safely aborts without crashing PipeWire

        // ANTI-FREEZE INJECTION: Forcefully unlock the frontend UI buttons
        if (win && !win.isDestroyed()) {
          win.webContents
            .executeJavaScript(
              `
        if (typeof _elDisabled === 'function') {
          _elDisabled('btnStart', false);
          _elDisabled('btnSwitch', false);
          _elDisabled('btnStop', true);
          if (typeof setCapDot === 'function') setCapDot('');
        }
        `
            )
            .catch(() => {});
        }
      });
  });

  win.on('resize', () => {
    const [w, h] = win.getSize();
    settings.w = w;
    settings.h = h;
    saveSettings(settings);
  });
  win.on('closed', () => {
    state.runtime.win = null;
  });

  // ── Tray ──
  let tray = null;
  if (!isGamescopeEnv) {
    // We only specify height so Electron maintains the natural aspect ratio of the logo
    const trayIcon = nativeImage
      .createFromPath(path.join(__dirname, '..', '..', 'assets/NearsecTogetherLogo.png'))
      .resize({ height: 22 });
    tray = new Tray(trayIcon);
    tray.setToolTip('NearsecTogether');
    tray.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: 'Show Dashboard',
          click: () => {
            if (state.runtime.win) {
              state.runtime.win.show();
              state.runtime.win.focus();
            } else createWindow();
          },
        },
        { type: 'separator' },
        {
          label: 'Quit',
          click: () => {
            app.isQuiting = true;
            app.quit();
          },
        },
      ])
    );
    tray.on('click', () => {
      if (state.runtime.win) {
        state.runtime.win.isVisible() ? state.runtime.win.hide() : state.runtime.win.show();
      }
    });
  }
  state.runtime.tray = tray;

  win.on('close', (e) => {
    if (!app.isQuiting) {
      if (isGamescopeEnv) {
        app.isQuiting = true;
        app.quit();
      } else {
        e.preventDefault();
        win.hide();
        if (tray && tray.displayBalloon)
          tray.displayBalloon({ title: 'NearsecTogether', content: 'Running in background.' });
      }
    }
  });

  try {
    os.setPriority(process.pid, os.constants.priority.PRIORITY_HIGH);
  } catch (_) {}

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('before-input-event', (event, input) => {
    if ((input.control && input.shift && input.key.toLowerCase() === 'i') || input.key === 'F12') {
      if (win.webContents.isDevToolsOpened()) win.webContents.closeDevTools();
      else win.webContents.openDevTools({ mode: 'detach' });
    }
  });

  win.webContents.on('media-started-playing', () => {
    win.focus();
    win.webContents.focus();
  });

  win.webContents.on('render-process-gone', (_event, details) => {
    console.warn('[electron] Renderer process gone:', details.reason);
    if (details.reason !== 'clean-exit' && state.runtime.serverCore && state.runtime.serverCore.cleanup) {
      state.runtime.serverCore.cleanup(true);
    }
  });
}

module.exports = { createWindow, isGamescopeEnv };
