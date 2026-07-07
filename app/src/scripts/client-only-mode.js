// Loaded first thing from index.html's <head>, before any other script —
// must run before viewer.js/UI code checks window.IS_CLIENT_ONLY. Extracted
// verbatim from an inline <script> block per REFACTOR_PLAN.md Phase 7.
// ── CLIENT-ONLY BUILD FLAG ────────────────────────────────────────────────────
// Set window.IS_CLIENT_ONLY = true before this script, or add ?client=1 to URL,
// to strip all host-specific UI. Used for the Capacitor mobile/TV build.
window.IS_CLIENT_ONLY = window.IS_CLIENT_ONLY || new URLSearchParams(location.search).get('client') === '1' || false;

if (window.IS_CLIENT_ONLY) {
  document.addEventListener('DOMContentLoaded', () => {
    // Hide everything marked host-only
    document.querySelectorAll('.host-only').forEach((el) => (el.style.display = 'none'));
    // Show client-only specific buttons
    document.querySelectorAll('.client-only-btn').forEach((el) => (el.style.display = 'block'));
    // In client mode: the nsBar never shows host-specific sections
    // The connect flow goes straight to the direct link or arcade
    document.body.classList.add('client-only');
    console.log('[Build] Client-only mode active — host UI hidden');

    initArcadeUI();
  });
}

function initArcadeUI() {
  if (new URLSearchParams(location.search).get('arcade') === '1') {
    const touchRight = document.querySelector('.controls-right');
    if (touchRight) touchRight.style.display = 'none';
  }
}
