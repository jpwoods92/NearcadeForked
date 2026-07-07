// ── HOST MODAL CHROME ──────────────────────────────────────────────────────
// Loaded via a <script> tag before host.js, same pattern as chat.js/webrtc/*.
// host.js-only (no viewer.js counterpart) — moved here verbatim, not a logic
// change. Cross-references (selectedSourceId/arcadeConfig/appSettings state,
// startCapture/applyCtrlSettingsUI/enumerateAudioDevices*/_refreshViewerPanel
// functions) resolve from host.js's own globals at call time, same mechanism
// as scripts/webrtc/*.js — see REFACTOR_PLAN.md Phase 5.4.
//
// Arcade modal registration logic (startArcadeSession, _doArcadeRegister,
// arcadeConfig) stays in host.js — deferred to Phase 5.7's arcade-registration
// module. Only the open/close chrome (showArcadeModal/closeArcadeModal) moved
// here. Same split for the settings modal's "Viewers" tab refresh
// (_refreshViewerPanel) — that's roster.js's (Phase 5.4b), called from here.

function closeAllModals() {
    document.querySelectorAll(".modal-bg").forEach(m => m.classList.add("gone"));
}

async function showSourceSelectionModal() {
    closeAllModals();
    // CRITICAL FIX: Bypass custom modal on Linux and macOS.
    // Electron's desktopCapturer.getSources() triggers a video-only xdg-desktop-portal
    // on Wayland, which hides the "Share Audio" checkbox. On macOS, bypassing allows the native SCK picker.
    const ua = navigator.userAgent.toLowerCase();
    const isLinux = ua.includes('linux');
    const isMac = ua.includes('mac os x');

    // Only show modal if electronAPI is available AND we are not on Linux or macOS
    if (!window.electronAPI || !window.electronAPI.getWindowSources || isLinux || isMac) {
        if (isLinux || isMac) log(I18N.t('Platform detected: Delegating to native portal/picker for audio support'), 'ok');
        else log(I18N.t('Source selection not available on this platform'), 'warn');

        startCapture();
        return;
    }

    // Show modal immediately while sources load
    document.getElementById('sourceModal').classList.remove('gone');
    await _populateSourceGrid();
}

async function refreshSourceModal() {
    await _populateSourceGrid();
}

async function _populateSourceGrid() {
    const sourceGrid   = document.getElementById('sourceGrid');
    const noSources    = document.getElementById('sourceNoSources');
    const confirmBtn   = document.getElementById('confirmSourceBtn');

    sourceGrid.innerHTML = '<div style="padding:20px;text-align:center;color:var(--muted);font-size:11px;">Scanning sources…</div>';
    if (noSources) noSources.style.display = 'none';
    if (confirmBtn) confirmBtn.disabled = true;
    selectedSourceId = null;

    try {
        // Request both windows AND screens from Electron
        const sources = await window.electronAPI.getWindowSources({
            types: ['window', 'screen'],
            thumbnailSize: { width: 320, height: 180 },
            fetchWindowIcons: true
        });

        sourceGrid.innerHTML = '';

        if (!sources || sources.length === 0) {
            if (noSources) noSources.style.display = 'flex';
            log(I18N.t('No capture sources found — try clicking Refresh or opening a window'), 'warn');
            return;
        }

        sources.forEach((source, idx) => {
            const card = document.createElement('div');
            card.className = 'source-card';
            card.id = 'source-' + idx;
            card.onclick = () => selectSource(idx, source.id);

            const thumbnail = source.thumbnail || '';
            const imgHtml = thumbnail
            ? `<img src="${thumbnail}" class="source-thumbnail" alt="${source.name}">`
            : '<div class="source-thumbnail" style="background:#2a2a2a;display:flex;align-items:center;justify-content:center;color:#666;font-size:10px;">No Preview</div>';

            const sourceType = source.isScreen ? '🖥 Screen' : ' Window';
            card.innerHTML = `${imgHtml}
            <div class="source-name">${source.name}</div>
            <div class="source-type">${sourceType}</div>`;

            sourceGrid.appendChild(card);
        });

        log(I18N.t('Found ${sources.length} capture source(s)').replace('${sources.length}', sources.length), 'ok');
    } catch (e) {
        log(I18N.t('Error loading sources:') + ' ' + e.message, 'err');
        sourceGrid.innerHTML = '';
        if (noSources) {
            noSources.style.display = 'flex';
            const detail = noSources.querySelector('div:last-child');
            if (detail) detail.textContent = 'Error: ' + e.message + ' — try Refresh.';
        }
    }
}

function selectSource(idx, sourceId) {
    document.querySelectorAll('.source-card').forEach(card => {
        card.style.borderColor = '';
        card.style.background = '';
    });

    const selectedCard = document.getElementById('source-' + idx);
    selectedCard.style.borderColor = 'var(--ok)';
    selectedCard.style.background = 'rgba(100, 200, 100, 0.1)';

    selectedSourceId = sourceId;
    document.getElementById('confirmSourceBtn').disabled = false;
}

function closeSourceModal() {
    document.getElementById('sourceModal').classList.add('gone');
    selectedSourceId = null;
    // FREEZE FIX: Re-enable the Start button whenever the user dismisses without
    // confirming. Without this, the button stays disabled after cancellation because
    // startCapture() was never called (or is still awaiting getUserMedia).
    _elDisabled('btnStart', false);
    _elDisabled('btnSwitch', true);
    _elDisabled('btnStop', true);
    if (typeof setCapDot === 'function') setCapDot('');
}

async function confirmSource() {
    closeSourceModal();
    await startCapture();
}

function showCtrlModal() {
    // Legacy shim — opens the unified settings modal on the Input tab
    showSettingsModal('input');
}

function closeCtrlModal() {
    closeSettingsModal();
}

// ── Unified Settings Modal ─────────────────────────────────────────────────────
function showSettingsModal(tab) {
    closeAllModals();
    applyCtrlSettingsUI();
    _syncSmMicRow();
    enumerateAudioDevicesSM();
    const abSel = document.getElementById('audioBackendSelect');
    if (abSel) abSel.value = localStorage.getItem('ns_audio_backend') || 'auto';
    switchSettingsTab(tab || 'video');
    document.getElementById('settingsModal').classList.remove('gone');
}

function closeSettingsModal() {
    document.getElementById('settingsModal').classList.add('gone');
}

function switchSettingsTab(tab) {
    ['video', 'audio', 'input', 'viewers'].forEach(t => {
        const btn  = document.getElementById('stab-' + t);
        const body = document.getElementById('stabContent-' + t);
        if (btn)  btn.classList.toggle('active', t === tab);
        if (body) body.style.display = t === tab ? '' : 'none';
    });
    if (tab === 'viewers') _refreshViewerPanel();
}

function showArcadeModal(skipRules = false) {
    closeAllModals();
    if (!skipRules && localStorage.getItem('ns_arcade_rules_accepted') !== 'true') {
        document.getElementById('arcadeRulesModal').classList.remove('gone');
        return;
    }
    document.getElementById('arcadeGameTitle').value = arcadeConfig.title;
    document.getElementById('arcadeGameDesc').value = arcadeConfig.desc;
    document.getElementById('arcadeMaxPlayers').value = arcadeConfig.maxPlayers;
    document.getElementById('arcadeRequirePin').checked = arcadeConfig.requirePin;
    document.getElementById('arcadeModal').classList.remove('gone');
}

function closeArcadeModal() {
    document.getElementById('arcadeModal').classList.add('gone');
}

function showAppSettings() {
    closeAllModals();
    applyAppSettingsUI();
    enumerateAudioDevices();
    document.getElementById('appSettingsModal').classList.remove('gone');
}
function closeAppSettings() {
    document.getElementById('appSettingsModal').classList.add('gone');
}

function applyAppSettingsUI() {
    const pairs = [
        ['tray',              'settingTrackTray',        'settingRowTray'],
        ['alwaysOnTop',       'settingTrackAlwaysOnTop', 'settingRowAlwaysOnTop'],
        ['hidePreviewOnStart','settingTrackHidePreview', 'settingRowHidePreview'],
        ['captureMic',        'settingTrackMic',         'settingRowMic'],
    ];
    pairs.forEach(([key, trackId, rowId]) => {
        const track = document.getElementById(trackId);
        const row   = document.getElementById(rowId);
        if (track) track.classList.toggle('on', !!appSettings[key]);
        if (row)   row.classList.toggle('active', !!appSettings[key]);
    });
        const micRow = document.getElementById('micDeviceRow');
        if (micRow) micRow.style.display = appSettings.captureMic ? 'block' : 'none';
}

function toggleAppSetting(key) {
    appSettings[key] = !appSettings[key];
    localStorage.setItem('ns_app_' + key, appSettings[key]);
    applyAppSettingsUI();

    if (key === 'alwaysOnTop' && window.electronAPI?.toggleAlwaysOnTop) {
        window.electronAPI.toggleAlwaysOnTop();
    }
    log(I18N.t('Setting') + ' ' + key + ' = ' + appSettings[key], 'ok');
}

// ── Test-only export shim ──────────────────────────────────────────────────
// `module` does not exist in the browser, so this block is inert there and
// changes no runtime behavior. See REFACTOR_PLAN.md Phase 0 / Phase 5.
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        closeAllModals,
        showSourceSelectionModal, refreshSourceModal, selectSource, closeSourceModal, confirmSource, _populateSourceGrid,
        showCtrlModal, closeCtrlModal, showSettingsModal, closeSettingsModal, switchSettingsTab,
        showArcadeModal, closeArcadeModal,
        showAppSettings, closeAppSettings, applyAppSettingsUI, toggleAppSetting,
    };
}
