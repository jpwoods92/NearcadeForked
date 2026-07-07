'use strict';
const fs = require('fs');

// ── CRITICAL FIX: Detect Arcade Worker immediately ──
const flags = {
  isArcadeWorker: process.argv.includes('--arcade-worker'),
  isFFmpegExperimental: process.argv.includes('--ffmpeg-experimental'),
  isWebCodecs: process.argv.includes('--webcodecs'),
  isFFmpegCapture: process.argv.includes('--ffmpeg'),
};

/**
 * Applies the user's saved capture-method preference on top of the CLI-flag
 * defaults above, unless CLI args are already forcing a specific mode.
 * Called once from electron-main.js's boot sequence, after the session
 * logger is installed, so these console.log calls land in latest.log like
 * they did when this logic lived inline.
 */
function applyConfigOverrides(configFile) {
  try {
    if (fs.existsSync(configFile)) {
      const parsedConfig = JSON.parse(fs.readFileSync(configFile, 'utf8'));

      if (
        !process.argv.includes('--webcodecs') &&
        !process.argv.includes('--ffmpeg') &&
        !process.argv.includes('--webrtc')
      ) {
        if (parsedConfig.captureMethod === 'webcodecs') flags.isWebCodecs = true;
        if (parsedConfig.captureMethod === 'ffmpeg') flags.isFFmpegCapture = true;
        console.log(`[Main] Loaded capture method from config: ${parsedConfig.captureMethod || 'native'}`);
      } else {
        console.log(`[Main] Capture method forced by CLI arguments.`);
      }
    }
  } catch (err) {
    console.warn('[Main] Could not read nearsectogether.config.json, falling back to defaults.');
  }
}

module.exports = { flags, applyConfigOverrides };
