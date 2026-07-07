'use strict';
const fs = require('fs');
const path = require('path');
const state = require('./state.js');

// Loads game-controller-profile CSV + KBM-binding JSON overrides from disk.
// Extracted verbatim from InputOrchestrator.js — REFACTOR_PLAN.md Phase 8.
function _loadProfiles() {
    try {
        const pth = path.join(__dirname, '..', '..', '..', '..', 'config', 'game_profiles.csv');
        if (fs.existsSync(pth)) {
            const lines = fs.readFileSync(pth, 'utf8').split('\n');
            lines.forEach(line => {
                const [title, ctrl, kbm, hybrid] = line.split(',').map(s => s?.trim());
                if (title && ctrl) state.gameProfiles[title.toLowerCase()] = { ctrl, kbm, hybrid: hybrid === 'true' };
            });
            console.log(`[input] CSV database loaded ${Object.keys(state.gameProfiles).length} profiles.`);
        }
    } catch (e) { console.warn('[input] Failed to load CSV:', e.message); }

    try {
        const pth = path.join(__dirname, '..', '..', '..', '..', 'config', 'kbm_bindings.json');
        if (fs.existsSync(pth)) {
            state.kbmBindings = JSON.parse(fs.readFileSync(pth, 'utf8'));
            console.log('[input] JSON KBM fallback loaded.');
        }
    } catch (e) { console.warn('[input] Failed to load KBM JSON:', e.message); }
}

module.exports = { _loadProfiles };
