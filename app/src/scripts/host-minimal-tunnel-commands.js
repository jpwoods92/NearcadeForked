// ── HOST-MINIMAL: PLATFORM-SPECIFIC TUNNEL INSTALL COMMANDS ────────────────
// Loaded via a <script> tag from host-minimal.html only — not shared with
// host.html/host-custom.html/host-playground.html, which don't have this
// Windows/Mac command-swap behavior. Extracted verbatim from an inline
// <script> block per REFACTOR_PLAN.md Phase 7.
(function patchTunnelCommandsForPlatform() {
  const ua = navigator.userAgent;
  const isWin = ua.includes('Win');
  const isMac = ua.includes('Mac') && !ua.includes('Windows');
  if (!isWin && !isMac) return; // Linux: keep the existing commands as-is

  // ── Platform-specific commands per provider ──────────────────────────────
  // Each entry: { cmd (shown + copied), comment (dimmed hint line) }
  const CMDS = {
    cloudflared: {
      win: {
        cmd: 'winget install Cloudflare.cloudflared',
        comment: '# Or: github.com/cloudflare/cloudflared/releases  (Windows installer)',
      },
      mac: {
        cmd: 'brew install cloudflare/cloudflare/cloudflared',
        comment: '# Requires Homebrew — brew.sh',
      },
    },
    zrok: {
      win: {
        cmd: 'https://github.com/openziti/zrok/releases',
        comment: '# Download the Windows zip, extract, add to PATH, then: zrok enable [token]',
      },
      mac: {
        cmd: 'brew install openziti/homebrew-openziti/zrok',
        comment: '# Then: zrok enable [token]',
      },
    },
    localhostrun: {
      win: {
        cmd: 'ssh -R 80:localhost:3000 nokey@localhost.run',
        comment: '# OpenSSH is built into Windows 10+ — no install needed',
      },
      mac: {
        cmd: 'ssh -R 80:localhost:3000 nokey@localhost.run',
        comment: '# SSH is built into macOS — no install needed',
      },
    },
    playit: {
      win: {
        cmd: 'https://playit.gg/download',
        comment: '# Download the Windows installer from playit.gg',
      },
      mac: {
        cmd: 'https://playit.gg/download',
        comment: '# Download the macOS version from playit.gg',
      },
    },
    // VPS and portforward cards have no install commands — skip
  };

  const platform = isWin ? 'win' : 'mac';

  function applyPlatformCmds() {
    document.querySelectorAll('.provider-card').forEach(function (card) {
      const radio = card.querySelector('input[type=radio]');
      if (!radio) return;
      const provider = radio.value;
      const info = CMDS[provider] && CMDS[provider][platform];
      if (!info) return;

      const installDiv = card.querySelector('.prov-install');
      if (!installDiv) return;

      // Update displayed command text
      const cmdSpan = installDiv.querySelector('.cmd');
      if (cmdSpan) cmdSpan.textContent = info.cmd;

      // Update or inject comment line
      let commentSpan = installDiv.querySelector('.comment');
      if (!commentSpan) {
        commentSpan = document.createElement('span');
        commentSpan.className = 'comment';
        commentSpan.style.display = 'block';
        commentSpan.style.marginTop = '4px';
        installDiv.appendChild(commentSpan);
      }
      commentSpan.textContent = info.comment;

      // Re-wire the copy button to copy the platform command
      const copyBtn = installDiv.querySelector('.copy-btn');
      if (copyBtn) {
        // Replace onclick entirely so it uses the right cmd string
        copyBtn.onclick = function (e) {
          copyCmd(e, info.cmd);
        };
      }
    });
  }

  // Run once on DOM ready (covers initial page load)
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', applyPlatformCmds);
  } else {
    applyPlatformCmds();
  }

  // Also run whenever the tunnel modal is opened (cards are already in DOM,
  // but this re-applies after any dynamic OS-hint injection in showTunnelModal)
  const _origShow = window.showTunnelModal;
  window.showTunnelModal = function () {
    _origShow && _origShow.apply(this, arguments);
    // Small delay lets showTunnelModal finish adding its dynamic OS hints first
    setTimeout(applyPlatformCmds, 0);
  };
})();
