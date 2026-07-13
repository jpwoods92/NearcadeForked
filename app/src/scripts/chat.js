// ── SHARED CHAT HELPERS ────────────────────────────────────────────────────
// Loaded via a <script> tag before host.js/viewer.js (both are plain global
// scripts, not ES modules — see p2p-signaler.js for the one exception) so
// these become ordinary globals exactly like the duplicated functions they
// replace. host.js/viewer.js each keep a thin appendChat()/sendChat()
// wrapper with their original call signature — see the bottom of each file.
//
// log() is deliberately NOT here despite both files having a function of
// that name: host.js's is a real DOM logger (#log/#lastLogLine), viewer.js's
// is a bare `console.log` passthrough. They're two unrelated functions that
// happen to share a name across pages that never load together, not
// duplicated logic — see REFACTOR_PLAN.md Phase 5.

/**
 * Appends one chat line to #chatLog. `dedupState`, if provided, is a mutable
 * `{ msg, time, windowMs }` box the caller owns across calls — passing one
 * suppresses an identical `isMe` message repeated within `windowMs` (this is
 * viewer.js's pre-existing behavior); passing `null`/`undefined` never
 * suppresses (host.js's pre-existing behavior). Not a new option added by
 * this refactor — the two files' prior behaviors, expressed without copying
 * the DOM-manipulation code twice.
 */
// Fingerprint dedup (upstream v3.0.2): with server-side no-echo plus local
// echo, the same line can still arrive twice through different paths — drop
// exact repeats landing within a short window regardless of sender flag.
let _lastChatFingerprint = '';
let _lastChatTimestamp = 0;
const CHAT_DEDUP_WINDOW_MS = 1200;

function chatAppendMessage(name, text, isMe, dedupState) {
  if (isMe && dedupState) {
    const now = Date.now();
    if (text === dedupState.msg && now - dedupState.time < dedupState.windowMs) return;
    dedupState.msg = text;
    dedupState.time = now;
  }
  const fingerprint = `${String(name).trim()}|${String(text).trim()}`;
  const fpNow = Date.now();
  if (fingerprint === _lastChatFingerprint && fpNow - _lastChatTimestamp < CHAT_DEDUP_WINDOW_MS) {
    return;
  }
  _lastChatFingerprint = fingerprint;
  _lastChatTimestamp = fpNow;

  const el = document.getElementById('chatLog');
  const d = document.createElement('div');
  d.className = 'cmsg';
  // textContent, not innerHTML (upstream v3.0.2): names/messages are
  // viewer-controlled and must never be parsed as markup.
  const nameSpan = document.createElement('span');
  nameSpan.className = 'cname' + (isMe ? ' me' : '');
  nameSpan.textContent = name;
  d.appendChild(nameSpan);
  d.appendChild(document.createTextNode(text));
  if (el) {
    el.appendChild(d);
    el.scrollTop = el.scrollHeight;
  }
}

/** Reads #chatMsg, sends it as `fromName` over `ws`, and echoes it locally. */
function chatSendMessage(ws, fromName, dedupState) {
  const inp = document.getElementById('chatMsg');
  const msg = inp.value.trim();
  if (!msg || !ws || ws.readyState !== 1) return;
  ws.send(JSON.stringify({ type: 'chat', from: fromName, msg }));
  chatAppendMessage(fromName, msg, true, dedupState);
  inp.value = '';
}

/** Sends a system/announcement chat line (not tied to the #chatMsg input). */
function chatSendSystemMessage(ws, fromName, text) {
  if (!ws || ws.readyState !== 1) return;
  ws.send(JSON.stringify({ type: 'chat', from: fromName, msg: text }));
  chatAppendMessage(fromName, text, false, null);
}

// ── Test-only export shim ──────────────────────────────────────────────────
// `module` does not exist in the browser, so this block is inert there and
// changes no runtime behavior. See REFACTOR_PLAN.md Phase 0 / Phase 5 and
// test/unit/chat.test.js.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { chatAppendMessage, chatSendMessage, chatSendSystemMessage };
}
