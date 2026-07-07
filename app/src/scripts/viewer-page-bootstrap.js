// ── VIEWER PAGE POST-LOAD PATCHES ───────────────────────────────────────────
// Loaded via a <script> tag from index.html, right after viewer.js — page
// wiring that assumes viewer.js's globals/DOM already exist (top-bar
// auto-hide, bandwidth-profile button restore, nsBar swipe/hover handling).
// Extracted verbatim from an inline <script> block per REFACTOR_PLAN.md Phase 7.
    // ── showOverlay patch: switch status pill to LIVE when stream starts ──
    // viewer.js defines showOverlay as a plain function; we wrap it here.
    // Restore saved bandwidth profile button state
    (function restoreBwProfile() {
      const saved = localStorage.getItem('ns_bw_profile') || 'auto';
      document.querySelectorAll('[data-bw]').forEach(btn => {
        btn.classList.toggle('ns-btn-active', btn.dataset.bw === saved);
      });
    })();

    // ── Top Bar Auto-Hide & Mouse Tracking Logic ──
    let _topBarTimer = null;
    let _lastMouseY = 0;

    function showTopBar(duration = 3000) {
      const tb = document.getElementById('topbar');
      if (!tb) return;
      tb.classList.add('visible');
      clearTimeout(_topBarTimer);
      _topBarTimer = setTimeout(() => {
        tb.classList.remove('visible');
      }, duration);
    }

    document.addEventListener('mousemove', e => {
      // Calculate vertical movement (negative means moving upwards)
      const dy = e.clientY - _lastMouseY;

      // Show if moving cursor upwards or if cursor is near the top edge
      if (dy < -2 || e.clientY < 60) {
        showTopBar(3000);
      }
      
      // Desktop mouse-to-right-edge to open nsBar
      if (e.clientX >= window.innerWidth - 10) {
        const nsBar = document.getElementById('nsBar');
        if (nsBar && nsBar.style.display !== 'none') {
          nsBar.classList.add('open');
          if (typeof resetNsBarTimeout === 'function') resetNsBarTimeout();
        }
      }
      
      _lastMouseY = e.clientY;
    }, { passive: true });

    document.addEventListener('touchstart', e => {
      // Show on mobile if tapping near the top of the screen
      if (e.touches[0].clientY < 80) showTopBar(3000);
    }, { passive: true });

    // ── showOverlay patch: switch status pill to LIVE when stream starts ──
    (function patchShowOverlay() {
      const orig = window.showOverlay;
      if (typeof orig !== 'function') return;
      window.showOverlay = function (v) {
        orig(v);
        if (!v) {
          const imm = document.getElementById('immersiveBtn');
          const pill = document.getElementById('statusPill');
          const dot = document.getElementById('liveDot');
          if (imm) imm.classList.add('gone');
          if (pill) pill.classList.add('hud-live');
          if (dot) dot.style.display = 'inline-block';

          // Trigger the 10-second initial display when stream connects!
          showTopBar(10000);
        }
      };
    })();

    // ── Chat open/close helpers ──
    function closeChatPanel() {
      document.getElementById('chatPanel').classList.remove('open');
      document.getElementById('chatBackdrop').classList.remove('open');
      // Reset badge
      const badge = document.getElementById('chatBadge');
      if (badge) { badge.style.display = 'none'; badge.textContent = ''; }
      _chatUnread = 0;
    }

    // Override toggleChat from viewer.js to also manage backdrop + badge reset
    const _origToggleChat = window.toggleChat;
    window.toggleChat = function () {
      const panel = document.getElementById('chatPanel');
      const backdrop = document.getElementById('chatBackdrop');
      const isOpen = panel.classList.contains('open');
      if (isOpen) {
        closeChatPanel();
      } else {
        panel.classList.add('open');
        backdrop.classList.add('open');
        // Reset badge when chat is opened
        const badge = document.getElementById('chatBadge');
        if (badge) { badge.style.display = 'none'; badge.textContent = ''; }
        _chatUnread = 0;
        document.getElementById('nsBar').classList.remove('open');
        // Close audio panel if open
        document.getElementById('audioPanel').classList.remove('open');
        document.getElementById('audioBtn').classList.remove('open');
        // Focus input
        setTimeout(() => document.getElementById('chatMsg')?.focus(), 80);
      }
    };

    // ── Chat Unread Badge & Toast Notification Logic ──
    let _chatUnread = 0;
    let _lastToastTime = 0;
    let _toastTimeout = null;

    const _origAppendChat = window.appendChat;
    window.appendChat = function (name, text, isMe) {
      // 1. Actually add the message to the log
      if (typeof _origAppendChat === 'function') _origAppendChat(name, text, isMe);

      // 2. Check if the chat panel is currently closed
      const panel = document.getElementById('chatPanel');
      const isClosed = panel && !panel.classList.contains('open');

      if (isClosed) {
        // Update the red unread badge
        _chatUnread++;
        const badge = document.getElementById('chatBadge');
        if (badge) {
          badge.style.display = 'flex';
          badge.textContent = _chatUnread > 9 ? '9+' : String(_chatUnread);
        }

        // 3. TOAST POPUP LOGIC (With Anti-Spam Cooldown)
        const now = Date.now();
        // Only pop up if it's NOT you, and it has been at least 2.5 seconds since the last popup
        if (!isMe && (now - _lastToastTime > 2500)) {
          _lastToastTime = now;
          const toast = document.getElementById('chatToast');
          const toastName = document.getElementById('chatToastName');
          const toastMsg = document.getElementById('chatToastMsg');

          if (toast && toastName && toastMsg) {
            toastName.textContent = name;
            toastMsg.textContent = text;

            toast.classList.add('show');

            // Clear any existing hide timer, and hide this one after 3 seconds
            if (_toastTimeout) clearTimeout(_toastTimeout);
            _toastTimeout = setTimeout(() => {
              toast.classList.remove('show');
            }, 3000);
          }
        }
      }
    };

    // ── Click outside: close nsBar, chatPanel, audioPanel ──
    const nsBar = document.getElementById('nsBar');
    document.addEventListener('click', e => {
      // Close nsBar if click is outside it
      if (nsBar && !nsBar.contains(e.target)) {
        nsBar.classList.remove('open');
      }

      // Close audioPanel if click is outside the panel AND outside the sidebar
      const audioPanel = document.getElementById('audioPanel');
      if (audioPanel && !audioPanel.contains(e.target) && (!nsBar || !nsBar.contains(e.target))) {
        audioPanel.classList.remove('open');
      }
    });

    let _nsBarTimeout = null;
    function resetNsBarTimeout() {
      clearTimeout(_nsBarTimeout);
      if (nsBar && nsBar.classList.contains('open')) {
        _nsBarTimeout = setTimeout(() => {
          nsBar.classList.remove('open');
        }, 4000);
      }
    }

    if (nsBar) {
      nsBar.addEventListener('touchstart', resetNsBarTimeout, { passive: true });
      nsBar.addEventListener('scroll', resetNsBarTimeout, { passive: true });
    }

    // ── Touch swipe-from-right to open nsBar ──
    let _touchStartX = 0;
    document.addEventListener('touchstart', e => {
      _touchStartX = e.touches[0].clientX;
      
      // Close nsBar if tap is outside it on mobile
      if (nsBar && nsBar.classList.contains('open') && !nsBar.contains(e.target)) {
        nsBar.classList.remove('open');
        clearTimeout(_nsBarTimeout);
      }
    }, { passive: true });
    document.addEventListener('touchend', e => {
      const dx = e.changedTouches[0].clientX - _touchStartX;
      
      // Swipe left from right edge to open
      if (_touchStartX > window.innerWidth - 44 && dx < -20) {
        nsBar.classList.add('open');
        resetNsBarTimeout();
      }
      
      // Swipe right to forcefully close
      if (nsBar && nsBar.classList.contains('open') && dx > 40) {
        nsBar.classList.remove('open');
        clearTimeout(_nsBarTimeout);
      }
    }, { passive: true });
