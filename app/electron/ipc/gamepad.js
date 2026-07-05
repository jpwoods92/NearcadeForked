'use strict';
const path = require('path');
const fs = require('fs');
const { ipcMain } = require('electron');

let gamepadProc = null;

function register() {
  ipcMain.on('start-native-gamepad', (event) => {
    if (gamepadProc) return;
    const { spawn } = require('child_process');
    // This module lives at app/electron/ipc/gamepad.js — two levels below
    // the app/ dir that these paths were originally written relative to.
    let basePath = path.join(__dirname, '..', '..');
    if (basePath.includes('app.asar')) {
      basePath = basePath.replace('app.asar', 'app.asar.unpacked');
    }
    const pyScript = path.join(basePath, 'src', 'sidecar', 'input_backends', 'read_gamepads.py');
    const pyExec = process.platform === 'win32' ? path.join(basePath, '..', 'bin', 'python', 'python.exe') : 'python3';

    // Fallback to system python on windows if bin/python doesn't exist
    const actualExec = (process.platform === 'win32' && !fs.existsSync(pyExec)) ? 'python' : pyExec;

    gamepadProc = spawn(actualExec, [pyScript]);
    gamepadProc.stdout.on('data', (data) => {
      const lines = data.toString().split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line.trim());
          event.reply('native-gamepad-event', msg);
        } catch (_) { }
      }
    });
    gamepadProc.stderr.on('data', d => console.error('[native-gamepad]', d.toString().trim()));
    gamepadProc.on('close', () => { gamepadProc = null; });
  });

  ipcMain.on('native-gamepad-rumble', (event, data) => {
    if (gamepadProc && gamepadProc.stdin && !gamepadProc.stdin.destroyed) {
      try {
        gamepadProc.stdin.write(JSON.stringify({ type: 'rumble', ...data }) + '\n');
      } catch (err) {
        console.error('[native-gamepad] Failed to write rumble data:', err.message);
      }
    }
  });
}

module.exports = { register };
