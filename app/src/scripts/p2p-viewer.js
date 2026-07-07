// ── VIEWER-SIDE P2P (TRYSTERO) CONNECTION ──────────────────────────────────
// Loaded via a <script> tag before viewer.js, same pattern as the other
// scripts/**/*.js modules.
//
// Builds a WebSocket-shaped object that routes through window.P2PManager
// (wired up by the ESM p2p-signaler.js) instead of a real WebSocket, so
// connect()'s ws.onopen/ws.onmessage handlers work unmodified regardless of
// which transport is actually in use.
//
// Extracted from connect() per REFACTOR_PLAN.md Phase 5.11 — the one
// clearly-separable sub-piece of viewer.js's WS-signaling spine (the plan's
// own guidance was to only carve pieces out of connect()/connectWS() if a
// clean boundary exists; this one does — it only reads setStatus/showOverlay
// and returns a self-contained object, no other shared state).
function createP2PConnection(roomCode) {
    console.log('[P2P] Initializing serverless connection to room:', roomCode);

    if (typeof setStatus === 'function') setStatus('Discovering host via P2P network...');
    if (document.getElementById('spinner')) document.getElementById('spinner').style.display = 'block';
    if (typeof showOverlay === 'function') showOverlay(true);

    // Provide progressive feedback for long P2P discovery times
    window._p2pProgression1 = setTimeout(() => {
        const current = document.getElementById('status')?.innerText || '';
        if (current.includes('Discovering') && typeof setStatus === 'function') {
            setStatus('Scanning trackers for host session...');
        }
    }, 7000);
    window._p2pProgression2 = setTimeout(() => {
        const current = document.getElementById('status')?.innerText || '';
        if (current.includes('Scanning') && typeof setStatus === 'function') {
            setStatus('Still searching, please wait...');
        }
    }, 14000);

    // Emulate WebSocket interface for P2PManager
    const fakeWs = {
        readyState: 1,
        send: (data) => {
            const msgStr = typeof data === 'string' ? data : new TextDecoder().decode(data);
            let msg;
            try { msg = JSON.parse(msgStr); } catch { return; }

            // Route join, candidate, answer, etc via Trystero
            if (window.P2PManager) {
                window.P2PManager.sendToHost(msg);
            }
        },
        close: function(code = 1000, reason = '') {
            console.log(`[P2P] Disconnecting from room (${code})`);
            if (window.P2PManager && window.P2PManager.room) {
                try { window.P2PManager.room.leave(); } catch (e) { }
            }
            if (typeof this.onclose === 'function') {
                this.onclose({ code, reason });
            }
        }
    };

    if (window.P2PManager) {
        window.P2PManager.initViewer(roomCode, (msg) => {
            if (typeof fakeWs.onmessage === 'function') {
                fakeWs.onmessage({ data: JSON.stringify(msg) });
            }
        }, () => {
            clearTimeout(window._p2pProgression1);
            clearTimeout(window._p2pProgression2);
            if (typeof setStatus === 'function') setStatus('Host found, negotiating P2P connection...');
            if (typeof fakeWs.onopen === 'function') fakeWs.onopen();
        });
    }

    return fakeWs;
}

// ── Test-only export shim ──────────────────────────────────────────────────
// `module` does not exist in the browser, so this block is inert there and
// changes no runtime behavior. See REFACTOR_PLAN.md Phase 0 / Phase 5.
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { createP2PConnection };
}
