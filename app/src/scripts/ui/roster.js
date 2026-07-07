// ── HOST VIEWER ROSTER ──────────────────────────────────────────────────────
// Loaded via a <script> tag before host.js (after ui/modals.js, since
// switchSettingsTab() in modals.js calls _refreshViewerPanel() defined here).
// host.js-only (no viewer.js counterpart) — moved here verbatim, not a logic
// change. Cross-references (ws/log/I18N/viewerAudioStates/vrActiveViewers/
// _viewerRegions/showSettingsModal/_updateDiscordRPC/saveSetting state and
// functions) resolve from host.js's own globals at call time, same mechanism
// as scripts/webrtc/*.js and scripts/ui/modals.js — see REFACTOR_PLAN.md
// Phase 5.4.

const savedViewerModes = JSON.parse(localStorage.getItem('ns_saved_modes') || '{}');

// ── VIEWER AUDIO STATES ───────────────────────────────────────────────────────
// State 0: Normal 100%   — volume 1.0, muted false
// State 1: Quiet  50%    — volume 0.5, muted false
// State 2: Local  mute   — muted true locally, viewer still transmits
// State 3: Global mute   — muted locally + WS command stops viewer transmission

let _globalMicKillActive = false;

// Inline SVG builders — no external mic icon file needed
function _micSvg(state) {
    const icon  = state >= 2 ? 'mic-off' : 'mic';
    const style = state === 1 ? 'filter:sepia(1) saturate(4) hue-rotate(10deg);'
    : state >= 2  ? 'filter:invert(0.4) sepia(1) saturate(6) hue-rotate(-20deg);'
    : 'filter:invert(0.75);';
    return `<img src="/assets/icons/${icon}.svg" style="width:14px;height:14px;flex-shrink:0;display:block;${style}" alt="">`;
}

const _micTitles = [
    'Mic Normal (100%)',
    'Mic Quiet (50%)',
    'Locally Muted',
'Globally Muted',
];

function renderRoster(list) {
    const c = document.getElementById('roster');
    const o = document.getElementById('rosterEmpty');
    const overlayC = document.getElementById('rosterOverlayList');
    const overlayO = document.getElementById('rosterOverlayEmpty');

    if (!c || !o) return;
    
    const controllers = list;

    const listStr = JSON.stringify(controllers);
    if (c.dataset.lastList === listStr) return;
    
    // Prevent wiping the DOM if the user is currently interacting with a dropdown
    if (document.activeElement && document.activeElement.tagName === 'SELECT') {
        return;
    }
    
    c.dataset.lastList = listStr;

    if (controllers.length === 0) {
        c.innerHTML = '';
        o.style.display = 'block';
        if (overlayC) overlayC.innerHTML = '';
        if (overlayO) overlayO.style.display = 'block';
        return;
    }
    o.style.display = 'none';
    c.innerHTML = '';
    if (overlayO) overlayO.style.display = 'none';
    if (overlayC) overlayC.innerHTML = '';

    controllers.forEach((v, index) => {
        const r = document.createElement('div');
        r.className = 'rcard';
        r.draggable = !v.locked;
        r.dataset.id = v.id;
        if (v.locked) r.style.opacity = '0.7';

        let currentMode = v.inputMode || 'gamepad';
        const isGuest = v.name.startsWith('Guest');

        if (!isGuest && v.id !== 'host_0' && savedViewerModes[v.name] && currentMode !== savedViewerModes[v.name]) {
            currentMode = savedViewerModes[v.name];
            changeInputMode(v.id, currentMode, v.name);
        }
        
        let displayName = v.name;
        if (vrActiveViewers.has(v.id.split('_')[0])) {
            displayName += ' <span style="color:var(--accent);font-size:10px;">(VR)</span>';
        }

        let iconSrc = '/assets/icons/gamepad.svg';
        if (currentMode === 'disabled') iconSrc = '/assets/icons/circle-off.svg';
        if (currentMode === 'kbm') iconSrc = '/assets/icons/keyboard.svg';
        if (currentMode === 'kbm_emulated') iconSrc = '/assets/icons/arrow-up-from-line.svg';
        if (currentMode === 'experimental') iconSrc = '/assets/icons/plug.svg';

        if (!viewerAudioStates[v.id]) viewerAudioStates[v.id] = { vol: 100, state: 0 };
        const audState = _globalMicKillActive ? 3 : viewerAudioStates[v.id].state;
        const micSvg   = _micSvg(audState);
        const micTitle = _micTitles[audState];

        r.innerHTML = `
        <div class="rnum">${index + 1}</div>
        <div style="flex:1; overflow:hidden;">
        <div class="rname">${_viewerRegions[v.id] ? `<span class="fi fi-${_viewerRegions[v.id]}"></span> ` : ''}${displayName}</div>
        <div style="display:flex; align-items:center; gap:6px; margin-top:4px;">
        <img src="${iconSrc}" style="width:14px;height:14px;filter:invert(0.8);" id="icon-${v.id}" />
        ${v.id === 'host_0' ? `<span style="font-size:9px;color:var(--muted);">Host</span>` : `
        <select class="form-select" style="padding:2px 4px;font-size:9px;width:auto;"
        onchange="changeInputMode('${v.id}', this.value, '${v.name.replace(/'/g, "\\'")}'); this.blur();">
        <option value="gamepad"       ${currentMode === 'gamepad'       ? 'selected' : ''}>Gamepad</option>
        <option value="kbm"           ${currentMode === 'kbm'           ? 'selected' : ''}>Raw KBM</option>
        <option value="kbm_emulated"  ${currentMode === 'kbm_emulated'  ? 'selected' : ''}>Emulated KBM</option>
        <option value="experimental"  ${currentMode === 'experimental'  ? 'selected' : ''}>Experimental Hardware</option>
        <option value="disabled"      ${currentMode === 'disabled'      ? 'selected' : ''}>Disabled</option>
        </select>
        `}
        ${v.id === 'host_0' ? '' : `
        <div style="width:1px;height:12px;background:var(--border2);margin:0 2px;"></div>
        <button onclick="cycleViewerMic('${v.id}')" title="${micTitle}"
        id="mic-btn-${v.id}"
        style="background:none;border:none;cursor:pointer;display:flex;align-items:center;padding:2px;${_globalMicKillActive ? 'opacity:0.4;pointer-events:none;' : ''}">
        ${micSvg}
        </button>
        <input type="range" min="0" max="100" value="${viewerAudioStates[v.id].vol}"
        oninput="setViewerVolume('${v.id}', this.value)"
        style="width:38px;accent-color:var(--accent);height:3px;" title="Viewer voice volume">
        `}
        </div>
        </div>
        <div class="rstat">${v.slot !== null ? '(Assigned)' : ''}</div>
        <button class="rlock" onclick="toggleSlotLock('${v.id}', ${!v.locked})" title="Lock slot"
        style="background:none;border:none;cursor:pointer;padding:0 4px;width:20px;height:20px;display:flex;align-items:center;">
        <img src="/assets/icons/${v.locked ? 'lock' : 'lock-open'}.svg" style="width:14px;height:14px;${v.locked ? 'filter:invert(0.8) sepia(1) saturate(5) hue-rotate(350deg);' : 'filter:invert(0.5);'}" />
        </button>
        ${v.id === 'host_0' ? '' : `<button class="rkick" onclick="kickViewer('${v.id}')" title="Kick Viewer">×</button>`}
        `;
        c.appendChild(r);

        if (overlayC && index < 4) {
            const r2 = document.createElement('div');
            r2.className = r.className;
            r2.draggable = r.draggable;
            r2.dataset.id = r.dataset.id;
            r2.style.cssText = r.style.cssText;
            r2.innerHTML = r.innerHTML
                .replace(`id="icon-${v.id}"`, `id="overlay-icon-${v.id}"`)
                .replace(`id="mic-btn-${v.id}"`, `id="overlay-mic-btn-${v.id}"`);
            overlayC.appendChild(r2);
        }
    });
    attachDragDrop(c);
    if (overlayC) attachDragDrop(overlayC);
}

// ── 4-STATE MIC CYCLE ─────────────────────────────────────────────────────────
function cycleViewerMic(viewerId) {
    if (_globalMicKillActive) return; // master kill overrides individual buttons

    const s = viewerAudioStates[viewerId] || (viewerAudioStates[viewerId] = { vol: 100, state: 0 });
    const prev = s.state;
    s.state = (s.state + 1) % 4;

    const audioEl = document.getElementById('remote-audio-' + viewerId);

    switch (s.state) {
        case 0: // Normal — restore everything
            if (audioEl) { audioEl.volume = s.vol / 100; audioEl.muted = false; }
            // If coming from state 3 (global mute), tell viewer to resume transmitting
            if (prev === 3 && ws && ws.readyState === 1) {
                ws.send(JSON.stringify({ type: 'host-voice-cmd', targetViewerId: viewerId, action: 'unmute' }));
            }
            break;
        case 1: // Quiet 50%
            if (audioEl) { audioEl.volume = 0.5; audioEl.muted = false; }
            break;
        case 2: // Local mute — host can't hear, viewer still transmits
            if (audioEl) audioEl.muted = true;
            break;
        case 3: // Global mute — stop viewer transmitting entirely
            if (audioEl) audioEl.muted = true;
            if (ws && ws.readyState === 1) {
                ws.send(JSON.stringify({ type: 'host-voice-cmd', targetViewerId: viewerId, action: 'mute' }));
            }
            break;
    }

    // Update just the mic button in-place without re-rendering the whole roster
    const btn = document.getElementById('mic-btn-' + viewerId);
    if (btn) {
        btn.innerHTML = _micSvg(s.state);
        btn.title     = _micTitles[s.state];
    }
    const overlayBtn = document.getElementById('overlay-mic-btn-' + viewerId);
    if (overlayBtn) {
        overlayBtn.innerHTML = _micSvg(s.state);
        overlayBtn.title     = _micTitles[s.state];
    }
}

// ── VIEWER VOICE VOLUME ───────────────────────────────────────────────────────
function setViewerVolume(viewerId, vol) {
    if (!viewerAudioStates[viewerId]) viewerAudioStates[viewerId] = { vol: 100, state: 0 };
    viewerAudioStates[viewerId].vol = parseInt(vol, 10);
    const audioEl = document.getElementById('remote-audio-' + viewerId);
    // Only apply volume if not muted (states 2 & 3)
    if (audioEl && viewerAudioStates[viewerId].state < 2) {
        audioEl.volume = vol / 100;
    }
}

// ── GLOBAL MIC KILL-SWITCH ────────────────────────────────────────────────────
function toggleGlobalMicKill() {
    _globalMicKillActive = !_globalMicKillActive;

    // Mute/unmute every remote audio element
    document.querySelectorAll('[id^="remote-audio-"]').forEach(el => {
        el.muted = _globalMicKillActive;
    });

    // Broadcast to all viewers
    if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({
            type:   'host-voice-broadcast',
            action: _globalMicKillActive ? 'mute' : 'unmute',
        }));
    }

    log(
        _globalMicKillActive
        ? 'Global mic kill: all viewer mics disabled'
        : 'Global mic kill lifted: viewer mics restored',
        _globalMicKillActive ? 'warn' : 'ok'
    );

    // Visual update
    const btn = document.getElementById('btnMasterMic');
    if (btn) {
        btn.classList.toggle('master-mic-kill', _globalMicKillActive);
        btn.title = _globalMicKillActive ? 'All Viewer Mics Killed (click to restore)' : 'Mute All Viewer Mics';
    }

    // Re-render roster so per-viewer buttons show disabled state
    if (typeof _lastRosterList !== 'undefined') renderRoster(_lastRosterList);
}

// Cache last roster so toggleGlobalMicKill can re-render without a server round-trip
let _lastRosterList = [];

function changeInputMode(viewerId, newMode, viewerName) {
    if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'set-input-mode', viewerId: viewerId, mode: newMode }));
        log(I18N.t('Input mode for viewer ${viewerId} set to ${newMode}').replace('${viewerId}', viewerId).replace('${newMode}', newMode), 'ok');
        if (viewerName && !viewerName.startsWith('Guest')) {
            savedViewerModes[viewerName] = newMode;
            localStorage.setItem('ns_saved_modes', JSON.stringify(savedViewerModes));
        }
    }
}

let draggedItem = null;
function attachDragDrop(container) {
    const items = container.querySelectorAll('.rcard');
    items.forEach(item => {
        item.addEventListener('dragstart', (e) => {
            draggedItem = item;
            setTimeout(() => item.classList.add('dragging'), 0);
        });
        item.addEventListener('dragend', () => {
            if (draggedItem) draggedItem.classList.remove('dragging');
            draggedItem = null;
            items.forEach(i => i.classList.remove('drag-over'));
        });
        item.addEventListener('dragover', (e) => {
            e.preventDefault();
            if (item !== draggedItem) item.classList.add('drag-over');
        });
            item.addEventListener('dragleave', () => {
                item.classList.remove('drag-over');
            });
            item.addEventListener('drop', (e) => {
                e.preventDefault();
                item.classList.remove('drag-over');
                if (item !== draggedItem && draggedItem) {
                    const all = Array.from(container.querySelectorAll('.rcard'));
                    if (all.indexOf(draggedItem) < all.indexOf(item)) item.after(draggedItem);
                    else item.before(draggedItem);
                    updateSlotsAfterDrop(container);
                }
            });
    });
}

function updateSlotsAfterDrop(container) {
    Array.from(container.querySelectorAll('.rcard')).forEach((item, index) => {
        if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'assign-slot', viewerId: item.dataset.id, slot: index }));
    });
}

function kickViewer(id) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'kick-viewer', viewerId: id }));
}

function toggleSlotLock(rosterId, newLockState) {
    if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'toggle-slot-lock', viewerId: rosterId, locked: newLockState }));
        log(`Slot lock for ${rosterId} set to ${newLockState ? 'LOCKED' : 'UNLOCKED'}`, 'ok');
    }
}

// ── Viewer Panel ──────────────────────────────────────────────────────────────
const _viewerInputRevoked = new Set();

// Viewer panel is now the "Viewers" tab inside settingsModal — no floating sidebar.
function toggleViewerPanel() {
    showSettingsModal('viewers');
}

function _refreshViewerPanel() {
    _updateDiscordRPC();
    const list = document.getElementById('viewerPanelList');
    if (!list) return;
    // Rebuild from roster data exposed by host.js
    list.innerHTML = '';
    const viewers = typeof window._rosterData !== 'undefined' ? window._rosterData : [];
    if (!viewers.length) {
        list.innerHTML = '<div style="font-size:10px;color:var(--muted2);padding:12px;text-align:center;">No viewers connected</div>';
        return;
    }
    viewers.forEach(v => {
        if (v.id === 'host_0') return;
        const revoked = _viewerInputRevoked.has(v.id);
        const card = document.createElement('div');
        card.className = 'viewer-panel-card' + (revoked ? ' revoked' : '');
        card.dataset.viewerId = v.id;
        card.innerHTML = `
            <div class="vpc-name">${v.name || v.id}</div>
            <div class="vpc-profile">${v.inputMode || 'gamepad'} · slot ${v.slot !== undefined ? v.slot : '?'}</div>
            <div class="vpc-row">
                <span style="font-size:9px;color:${revoked ? 'var(--danger)' : 'var(--green)'};">${revoked ? 'INPUT REVOKED' : 'Input Active'}</span>
                <button class="vpc-revoke-btn${revoked ? ' revoked' : ''}" onclick="toggleViewerInputPerm('${v.id}', this)">${revoked ? 'Restore' : 'Revoke'}</button>
            </div>`;
        list.appendChild(card);
    });
}

function toggleViewerInputPerm(viewerId, btn) {
    const revoked = !_viewerInputRevoked.has(viewerId);
    if (revoked) _viewerInputRevoked.add(viewerId);
    else _viewerInputRevoked.delete(viewerId);

    const port = new URLSearchParams(location.search).get('port') || location.port || 3000;
    fetch(`http://localhost:${port}/api/viewer-input-perm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ viewerId: viewerId.replace(/_0$/, ''), revoked })
    }).catch(() => {});

    _refreshViewerPanel();
}

// ── Test-only export shim ──────────────────────────────────────────────────
// `module` does not exist in the browser, so this block is inert there and
// changes no runtime behavior. See REFACTOR_PLAN.md Phase 0 / Phase 5.
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        renderRoster, cycleViewerMic, setViewerVolume, toggleGlobalMicKill, changeInputMode,
        attachDragDrop, updateSlotsAfterDrop, kickViewer, toggleSlotLock,
        toggleViewerPanel, _refreshViewerPanel, toggleViewerInputPerm,
    };
}
