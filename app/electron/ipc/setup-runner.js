'use strict';
const { ipcMain } = require('electron');

// Fix: Listen for 'run-setup', matching what the dashboard actually sends
function register() {
  ipcMain.on('run-setup', (event) => {
    const { exec } = require('child_process');
    const path = require('path');
    const os = require('os');
    const fs = require('fs');

    if (os.platform() === 'win32') {
      // WINDOWS: Run the PowerShell setup script natively as Administrator
      // This module lives at app/electron/ipc/setup-runner.js — three levels
      // below the repo root these paths were originally written relative to.
      const scriptPath = path.join(__dirname, '..', '..', '..', 'bin', 'windows_setup.ps1');
      const psCommand = `Start-Process powershell -ArgumentList '-ExecutionPolicy Bypass -File ""${scriptPath}""' -Verb RunAs`;

      exec(`powershell -Command "${psCommand}"`, (error) => {
        if (error) {
          console.error('[Setup] Windows setup failed:', error.message);
          event.reply('setup-failed', error.message);
        } else {
          event.reply('setup-success');
        }
      });
    }
    else if (os.platform() === 'linux') {
      let scriptPath = path.join(__dirname, '..', '..', '..', 'bin', 'linux_setup.sh');
      let iconPath = path.join(__dirname, '..', '..', '..', 'assets', 'NearsecTogetherLogo.png');

      // If running from an AppImage or built executable, extraResources places 'bin' directly in resourcesPath
      if (__dirname.includes('app.asar')) {
        scriptPath = path.join(process.resourcesPath, 'bin', 'linux_setup.sh');
        iconPath = path.join(process.resourcesPath, 'app.asar.unpacked', 'assets', 'NearsecTogetherLogo.png');
      }

      try { fs.chmodSync(scriptPath, 0o755); } catch (e) { console.warn('[Setup] chmod:', e.message); }

      const wrapperPath = path.join(os.tmpdir(), 'nearsec_setup_wrapper.sh');
      const statusFile = path.join(os.tmpdir(), 'nearsec_setup_status');

      // Create a clean wrapper that forces the native password prompt and logs the exit code
      // We copy the script to /tmp first because root (sudo) cannot read FUSE mounts like AppImage's /tmp/.mount_*
      const wrapperContent = `#!/bin/bash\nclear\necho "Starting Nearsec Setup..."\ncp "${scriptPath}" /tmp/nearsec_setup.sh\ncp "${iconPath}" /tmp/NearsecTogetherLogo.png 2>/dev/null\nchmod +x /tmp/nearsec_setup.sh\nsudo bash /tmp/nearsec_setup.sh\nif [ $? -eq 0 ]; then echo "SUCCESS" > "${statusFile}"; else echo "FAIL" > "${statusFile}"; fi\necho ""\nread -p "Press Enter to close..."\n`;

      try {
        fs.writeFileSync(wrapperPath, wrapperContent, { mode: 0o755 });
        if (fs.existsSync(statusFile)) fs.unlinkSync(statusFile); // Clear old status
      } catch (e) {
        console.error('[Setup] Failed to write wrapper:', e);
        event.reply('setup-failed', e.message);
        return;
      }

      // x-terminal-emulator respects the OS's chosen default terminal.
      // The rest are strictly fallbacks for non-Debian distros.
      const command = `x-terminal-emulator -e "${wrapperPath}" || konsole -e "${wrapperPath}" || gnome-terminal -- "${wrapperPath}" || xterm -e "${wrapperPath}"`;

      exec(command, (error) => {
        // Read the status file to tell the UI if the drivers actually installed
        try {
          const status = fs.readFileSync(statusFile, 'utf8');
          if (status.includes('SUCCESS')) {
            event.reply('setup-success');
          } else {
            event.reply('setup-failed', 'Setup aborted or failed.');
          }
        } catch (e) {
          event.reply('setup-failed', 'Terminal closed early.');
        }
      });
    }
  });
}

module.exports = { register };
