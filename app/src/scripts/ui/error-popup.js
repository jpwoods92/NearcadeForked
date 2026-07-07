// ── SHARED ERROR/WARNING POPUP ──────────────────────────────────────────────
// Loaded via a <script> tag on pages with a #ns-error-popup element
// (dashboard.html, index.html). Extracted from two near-identical inline
// <script> blocks per REFACTOR_PLAN.md Phase 7 — dashboard.html had the same
// showError() definition and onAppError listener, just split across two
// separate <script> blocks elsewhere in the page.
window.showError = function(msg, severity = 'red') {
  const popup = document.getElementById('ns-error-popup');
  const text = document.getElementById('ns-error-text');
  if (!popup || !text) return;

  popup.style.background = severity === 'yellow' ? '#f59e0b' : '#d32f2f';
  popup.style.color = severity === 'yellow' ? '#000' : '#fff';
  text.innerText = msg;
  popup.style.display = 'flex';

  // Auto-hide warnings after 10s, keep reds until closed
  if (severity === 'yellow') {
    setTimeout(() => { popup.style.display = 'none'; }, 10000);
  }
};

if (window.electronAPI && window.electronAPI.onAppError) {
  window.electronAPI.onAppError((msg, severity) => {
    if (window.showError) window.showError(msg, severity);
  });
}
