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

// Platform badge icons for chatAppendMessage's `platform` param — same
// shapes upstream uses, keyed by the string detectViewerPlatform() (viewer.js)
// returns.
function platIcon(name) {
  const map = {
    Mobile:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><rect x="5" y="2" width="14" height="20" rx="2"/><path d="M12 18h.01"/></svg>',
    'Steam Deck':
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><path d="M17.32 5H6.68a4 4 0 0 0-3.978 3.59c-.006.052-.01.101-.017.152L2 17a1 1 0 0 0 1 1h2.128a1 1 0 0 0 .958-.71l.635-2.115C7.14 14.155 8.13 13.5 9.25 13.5h5.5c1.12 0 2.11.655 2.529 1.675l.635 2.115a1 1 0 0 0 .958.71H21a1 1 0 0 0 1-1l-.685-8.258A4 4 0 0 0 17.32 5z"/></svg>',
    Windows:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>',
    macOS:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>',
    Linux:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>',
    PC: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>',
  };
  return map[name] || '';
}

function chatAppendMessage(name, text, isMe, dedupState, platform, color, isHost) {
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
  // `myName` only exists on the viewer page (viewer.js) — the host never
  // needs to check whether it mentioned itself. It's a cross-file `let`
  // (not attachable to `window`), so ESLint can't see the shared-script
  // global it becomes at runtime — see CLAUDE.md's shared-global-script
  // convention and the same pattern already used for `_wcEncoder`/`micEnabled`.
  if (
    !isMe &&
    typeof myName !== 'undefined' &&
    // eslint-disable-next-line no-undef -- myName: cross-file global, see comment above
    myName &&
    // eslint-disable-next-line no-undef -- myName: cross-file global, see comment above
    new RegExp('@' + myName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(text)
  ) {
    d.classList.add('cmsg-mentioned');
  }
  // textContent, not innerHTML (upstream v3.0.2): names/messages are
  // viewer-controlled and must never be parsed as markup.
  const nameSpan = document.createElement('span');
  nameSpan.className = 'cname' + (isMe ? ' me' : '');
  // Trailing space only when a badge follows, to give it visual separation —
  // otherwise keep the exact "name, no space" text every existing chat
  // message (host.js's own messages, pre-Phase-9 viewer messages) relies on.
  nameSpan.textContent = platform || (!isMe && isHost) ? name + ' ' : name;
  if (color) nameSpan.style.color = color;
  if (platform) {
    const platBadge = document.createElement('span');
    platBadge.className = 'plat-badge';
    platBadge.innerHTML = platIcon(platform) || platform;
    nameSpan.appendChild(platBadge);
  }
  if (!isMe && isHost) {
    const hostBadge = document.createElement('span');
    hostBadge.className = 'plat-badge host-badge';
    hostBadge.textContent = 'HOST';
    nameSpan.appendChild(hostBadge);
  }
  d.appendChild(nameSpan);
  d.appendChild(document.createTextNode(text));
  if (el) {
    el.appendChild(d);
    el.scrollTop = el.scrollHeight;
  }
}

// ── EMOJI PICKER ────────────────────────────────────────────────────────────
// Shared between host.js (.chat-input-row) and viewer.js (#chatInput) — the
// two pages use different container markup for the same chat input, so this
// tries both rather than needing two near-duplicate copies of this function.
const _EMOJI_CATS = (window.EMOJI_DATA || []).length ? window.EMOJI_DATA : [];
function injectEmojiPicker() {
  const chatRow = document.querySelector('.chat-input-row') || document.getElementById('chatInput');
  if (!chatRow || document.getElementById('emojiPicker') || !_EMOJI_CATS.length) return;
  const style = document.createElement('style');
  style.textContent =
    '#emojiPicker{display:none}#emojiPicker.show{display:flex;flex-direction:column}#emojiPicker .picker-body{flex:1;overflow-y:auto;overflow-x:hidden;scrollbar-width:none;-ms-overflow-style:none}#emojiPicker .picker-body::-webkit-scrollbar{display:none}#emojiPicker .cat-tabs{display:flex;gap:2px;padding:4px 2px 2px;flex-shrink:0;border-top:1px solid var(--border);overflow-x:auto;overflow-y:hidden;scrollbar-width:none;-ms-overflow-style:none}#emojiPicker .cat-tabs::-webkit-scrollbar{display:none}#emojiPicker .cat-tab{background:none;border:none;cursor:pointer;font-size:14px;padding:2px 4px;border-radius:4px;line-height:1;flex-shrink:0;opacity:0.4;transition:opacity 0.15s;display:flex;align-items:center}#emojiPicker .cat-tab.active{opacity:1;background:var(--accent-dim)}#emojiPicker .cat-tab:hover{opacity:0.8}#emojiPicker .cat-page{display:none;flex-wrap:wrap;gap:2px;padding:4px 2px}#emojiPicker .cat-page.active{display:flex}#emojiPicker button:not(.cat-tab){background:none;border:none;cursor:pointer;font-size:20px;padding:2px 4px;border-radius:4px;line-height:1}#emojiPicker button:not(.cat-tab):hover{background:var(--accent-dim);transform:scale(1.15)}';
  document.head.appendChild(style);
  const pickerBtn = document.createElement('button');
  pickerBtn.id = 'emojiPickerBtn';
  const faceEmojis = (_EMOJI_CATS[0] && _EMOJI_CATS[0].items) || ['😀'];
  pickerBtn.textContent = faceEmojis[Math.floor(Math.random() * faceEmojis.length)];
  pickerBtn.type = 'button';
  pickerBtn.style.cssText =
    'background:none;border:none;cursor:pointer;font-size:18px;padding:4px 6px;line-height:1;opacity:0.5;transition:opacity 0.15s';
  pickerBtn.title = 'Insert emoji';
  pickerBtn.onmouseenter = () => (pickerBtn.style.opacity = '1');
  pickerBtn.onmouseleave = () => {
    if (!picker.classList.contains('show')) pickerBtn.style.opacity = '0.5';
  };
  const picker = document.createElement('div');
  picker.id = 'emojiPicker';
  picker.style.cssText =
    'position:absolute;bottom:100%;left:0;background:var(--surface);border:1px solid var(--border);border-radius:8px;width:300px;max-height:260px;z-index:9999';
  const bodyDiv = document.createElement('div');
  bodyDiv.className = 'picker-body';
  picker.appendChild(bodyDiv);
  const tabsDiv = document.createElement('div');
  tabsDiv.className = 'cat-tabs';
  picker.appendChild(tabsDiv);
  _EMOJI_CATS.forEach((cat, ci) => {
    const tab = document.createElement('button');
    tab.className = 'cat-tab' + (ci === 0 ? ' active' : '');
    tab.textContent = cat.label;
    tab.type = 'button';
    tab.title = cat.name;
    const page = document.createElement('div');
    page.className = 'cat-page' + (ci === 0 ? ' active' : '');
    cat.items.forEach((e) => {
      const btn = document.createElement('button');
      btn.textContent = e;
      btn.type = 'button';
      btn.onclick = () => {
        const inp = document.getElementById('chatMsg');
        if (inp) {
          inp.value += e;
          inp.focus();
        }
        picker.className = 'show';
      };
      page.appendChild(btn);
    });
    tab.onclick = () => {
      tabsDiv.querySelectorAll('.cat-tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      bodyDiv.querySelectorAll('.cat-page').forEach((p) => p.classList.remove('active'));
      page.classList.add('active');
    };
    tabsDiv.appendChild(tab);
    bodyDiv.appendChild(page);
  });
  pickerBtn.onclick = () => {
    const isOpen = picker.classList.contains('show');
    picker.className = isOpen ? '' : 'show';
  };
  document.addEventListener('click', (ev) => {
    if (!picker.contains(ev.target) && ev.target !== pickerBtn) picker.className = '';
  });
  const wrapper = document.createElement('div');
  wrapper.style.cssText = 'position:relative;display:inline-flex';
  wrapper.appendChild(pickerBtn);
  wrapper.appendChild(picker);
  chatRow.insertBefore(wrapper, chatRow.firstChild);
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', injectEmojiPicker);
} else {
  injectEmojiPicker();
}

/** Reads #chatMsg, sends it as `fromName` over `ws`, and echoes it locally.
 * `platform`/`color`, if given, ride along in the wire message and the local
 * echo — see chatAppendMessage()'s matching params. */
function chatSendMessage(ws, fromName, dedupState, platform, color) {
  const inp = document.getElementById('chatMsg');
  const msg = inp.value.trim();
  if (!msg || !ws || ws.readyState !== 1) return;
  const payload = { type: 'chat', from: fromName, msg };
  if (platform) payload.platform = platform;
  if (color) payload.color = color;
  ws.send(JSON.stringify(payload));
  chatAppendMessage(fromName, msg, true, dedupState, platform, color);
  _chatHistory.push(msg);
  _chatHistoryIndex = _chatHistory.length;
  inp.value = '';
}

// ── CHAT HISTORY (up/down arrow recall, shell-style) ───────────────────────
// Shared across host.js/viewer.js since #chatMsg/#chatLog have the same ids
// on both pages and neither page loads the other.
const _chatHistory = [];
let _chatHistoryIndex = -1;
document.addEventListener('keydown', (e) => {
  if (e.target.id !== 'chatMsg') return;
  // The @-mention dropdown (viewer.js only) owns Up/Down/Enter/Tab/Escape
  // while it's open — its own keydown listener handles those and this one
  // must not also move history underneath it.
  const mentionDD = document.getElementById('mentionDD');
  if (mentionDD && mentionDD.style.display !== 'none') return;
  const inp = e.target;
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (_chatHistory.length === 0) return;
    _chatHistoryIndex = Math.max(0, _chatHistoryIndex - 1);
    inp.value = _chatHistory[_chatHistoryIndex];
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    _chatHistoryIndex = Math.min(_chatHistory.length, _chatHistoryIndex + 1);
    inp.value = _chatHistoryIndex < _chatHistory.length ? _chatHistory[_chatHistoryIndex] : '';
  }
});

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
  module.exports = { chatAppendMessage, chatSendMessage, chatSendSystemMessage, platIcon, injectEmojiPicker };
}
