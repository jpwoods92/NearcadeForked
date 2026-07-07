// ── SCREEN/AUDIO CAPTURE (host.js only) ─────────────────────────────────────
// Loaded via a <script> tag before host.js, same pattern as the other
// scripts/**/*.js modules. getDisplayMedia/getUserMedia acquisition
// (startCapture), live resolution/fps swap without dropping peer connections
// (hotSwapCapture), and full teardown (stopCapture/_forceKillStream).
// See REFACTOR_PLAN.md Phase 5.9.

//  THE HOT SWAP ENGINE
async function hotSwapCapture() {
  if (!currentStream) return;
  log(I18N.t('Applying new stream resolution/FPS...'), 'warn');

  // Disable buttons during swap to prevent re-entry
  _elDisabled('codecSelect', true);
  _elDisabled('bitrateSelect', true);
  _elDisabled('resSelect', true);
  _elDisabled('fpsSelect', true);
  _elDisabled('degSelect', true);

  let timeout;
  try {
    // Set a 15-second timeout to prevent indefinite hanging
    timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Stream swap timeout - dialog might be stuck')), 15000)
    );

    // 1. Tell viewers to freeze their screen on the last frame
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'host-encoder-swap-start' }));
    }

    const _appFpsUnlock = typeof appConfig !== 'undefined' && appConfig.fpsUnlock;
    const fpsVal = _appFpsUnlock
      ? Math.max(parseInt(document.getElementById('fpsSelect')?.value) || 60, 120)
      : parseInt(document.getElementById('fpsSelect')?.value) || 60;
    const resVal = document.getElementById('resSelect')?.value || '1080p';

    // Strip artificial height constraints so the browser doesn't crop the screen
    let videoConstraints = { frameRate: { ideal: fpsVal } };

    // 2. Grab the new video track (with timeout protection)
    let newScreenStream;
    if (window._lastSourceId && window.electronAPI) {
      newScreenStream = await Promise.race([
        navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            mandatory: {
              chromeMediaSource: 'desktop',
              chromeMediaSourceId: window._lastSourceId,
              maxFrameRate: fpsVal,
            },
          },
        }),
        timeout,
      ]);
    } else {
      newScreenStream = await Promise.race([
        navigator.mediaDevices.getDisplayMedia({ video: videoConstraints, audio: false }),
        timeout,
      ]);
    }

    const newVideoTrack = newScreenStream.getVideoTracks()[0];
    newVideoTrack.contentHint = 'motion';

    // 3. Swap the track inside all active WebRTC peer connections (NO disconnects!)
    for (const viewerId in peerConnections) {
      const pc = peerConnections[viewerId];
      const sender = pc.getSenders().find((s) => s.track?.kind === 'video');
      if (sender) {
        await sender.replaceTrack(newVideoTrack);
        setLowLatencyParams(pc);
      }
    }

    // 4. Swap it out locally
    const oldVideoTrack = currentStream.getVideoTracks()[0];
    currentStream.removeTrack(oldVideoTrack);
    oldVideoTrack.stop();
    currentStream.addTrack(newVideoTrack);

    const prev = document.getElementById('preview');
    if (prev && !previewHidden) prev.srcObject = currentStream;

    log(I18N.t('Stream settings applied seamlessly!'), 'ok');
  } catch (err) {
    // Handle user cancel (NotAllowedError, AbortError) vs real errors
    if (err.name === 'NotAllowedError' || err.name === 'AbortError') {
      log(I18N.t('Stream settings change cancelled by user'), 'warn');
    } else if (err.message === 'Stream swap timeout - dialog might be stuck') {
      log(I18N.t('Stream swap operation timed out — try again'), 'err');
    } else {
      log(I18N.t('Failed to swap video track:') + ' ' + err.message, 'err');
    }
  } finally {
    // ALWAYS re-enable controls, no matter what happened
    _elDisabled('codecSelect', false);
    _elDisabled('bitrateSelect', false);
    _elDisabled('resSelect', false);
    _elDisabled('fpsSelect', false);
    _elDisabled('degSelect', false);
  }
}

async function startCapture() {
  streamActive = true;
  _updateDiscordRPC();
  // ── HANG PROTECTION: Forces hanging OS promises to reject after 20 seconds ──
  const withTimeout = (promise, ms, msg) =>
    Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(msg)), ms))]);

  _elDisabled('btnStart', true);
  _elDisabled('btnSwitch', true);

  // Teardown old streams BEFORE we start capturing.
  // _forceKillStream nulls each track individually — required on Windows so
  // Chromium releases the OS capture device handle before we re-acquire it.
  if (currentStream) {
    _forceKillStream(currentStream);
    stopAudioMeter();
    currentStream = null;
  }
  Object.values(peerConnections).forEach((pc) => pc.close());
  peerConnections = {};

  const isLinux = navigator.userAgent.includes('Linux') || navigator.platform.toLowerCase().includes('linux');
  const _appFpsUnlock = typeof appConfig !== 'undefined' && appConfig.fpsUnlock;
  const fpsVal = _appFpsUnlock
    ? Math.max(parseInt(document.getElementById('fpsSelect')?.value) || 60, 120)
    : parseInt(document.getElementById('fpsSelect')?.value) || 60;
  const resVal = document.getElementById('resSelect')?.value || '1080p';

  // Strip artificial height constraints. Requesting a resolution higher
  // than the native monitor causes the OS to crop/zoom the screen.
  // This forces pure, unscaled native hardware capture.
  let videoConstraints = { frameRate: { ideal: fpsVal } };

  try {
    let screenStream = null;
    videoConstraints.cursor = 'never';
    const displayMediaOptions = { video: videoConstraints };

    if (!isLinux && audioSettings.forceAudioEnabled) {
      displayMediaOptions.audio = true;
      displayMediaOptions.systemAudio = 'include';
    } else {
      displayMediaOptions.audio = false;
    }

    // ── 1. FFMPEG EXPERIMENTAL INTERCEPTOR ──
    // Ask the backend directly if FFmpeg is active, bypassing UI state
    /*
        let backendHasFfmpeg = false;
        try {
            const statusRes = await fetch('/api/capture/status').then(r => r.json());
            if (statusRes.active && statusRes.method === 'ffmpeg') backendHasFfmpeg = true;
        } catch (e) { }

        if (backendHasFfmpeg) {
            log('Routing capture through experimental FFmpeg pipeline...', 'warn');
            try {
                const ffmpegTrack = await startFFmpegCapture();
                screenStream = new MediaStream([ffmpegTrack]);
            } catch (e) {
                console.error('FFmpeg pipeline failed:', e);
                log('FFmpeg failed. Falling back to native Wayland portal.', 'err');
            }
        }
        */

    // ── 2. THE NATIVE WAYLAND BYPASS ──
    // Only trigger if FFmpeg was off or failed
    if (!screenStream && isLinux) {
      screenStream = await navigator.mediaDevices.getUserMedia({
        video: { mandatory: { chromeMediaSource: 'desktop', maxFrameRate: fpsVal } },
        audio: false,
      });
    }
    // ── 3. WINDOWS / MAC LOGIC ──
    else if (!screenStream && selectedSourceId && window.electronAPI) {
      try {
        window._lastSourceId = selectedSourceId;

        // Chromium on Windows requires a strictly prefixed source ID.
        // IDs without a prefix default to the primary monitor (entire screen).
        // Rule: if the raw ID contains digits only → window capture → 'window:ID:0'
        //       if it starts with 'screen:' already → leave it
        //       if it starts with 'window:' already → leave it
        //       anything else with no colon → assume window, add prefix
        if (!selectedSourceId.startsWith('window:') && !selectedSourceId.startsWith('screen:')) {
          // Raw numeric IDs (e.g. '123456789') are window handles on Windows
          const isNumeric = /^\d+$/.test(selectedSourceId);
          selectedSourceId = isNumeric ? `window:${selectedSourceId}:0` : `screen:${selectedSourceId}:0`;
        }
        // 1. Grab the Video specifically for the selected Window/Screen
        const vidStream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: selectedSourceId, maxFrameRate: fpsVal },
          },
        });
        log(I18N.t('Using selected source:') + ' ' + selectedSourceId, 'ok');

        // 2. Safely grab System Audio as a completely separate stream (if enabled)
        let tempAudioTrack = null;
        if (!isLinux && audioSettings.forceAudioEnabled) {
          try {
            const audStream = await navigator.mediaDevices.getUserMedia({
              audio: { mandatory: { chromeMediaSource: 'desktop' } },
              video: false,
            });
            tempAudioTrack = audStream.getAudioTracks()[0];
          } catch (audErr) {
            log(I18N.t('Could not attach system audio to window capture.'), 'warn');
          }
        }

        // 3. Stitch them together manually
        screenStream = new MediaStream([vidStream.getVideoTracks()[0]]);
        if (tempAudioTrack) screenStream.addTrack(tempAudioTrack);
      } catch (e) {
        log(I18N.t('Source selection failed, falling back to native picker:') + ' ' + e.message, 'warn');
        selectedSourceId = null;
        screenStream = await navigator.mediaDevices.getDisplayMedia(displayMediaOptions);
      }
    } else if (!screenStream) {
      // Ultimate fallback if no other method caught it
      screenStream = await navigator.mediaDevices.getDisplayMedia(displayMediaOptions);
    }

    if (selectedSourceId) activeSourceId = selectedSourceId;
    selectedSourceId = null;
    if (!screenStream) {
      console.error('[Capture] Aborting: No stream was returned (likely Windows audio restriction).');
      log('Capture failed: No stream returned. Try without system audio.', 'err');
      if (typeof setCapDot === 'function') setCapDot('err');
      _elDisabled('btnStart', false);
      _elDisabled('btnSwitch', true);
      _elDisabled('btnStop', true);
      return;
    }

    const vTrack = screenStream.getVideoTracks()[0];
    if (!vTrack || vTrack.readyState === 'ended') {
      throw new DOMException('Stream ended unexpectedly', 'AbortError');
    }

    const settings = vTrack.getSettings();
    const combined = new MediaStream();

    // ── PIPELINE SELECTION ────────────────────────────────────────────────
    // vTrack is ALWAYS added to combined so WebRTC viewers get a video track.
    // WebCodecs is only active when explicitly selected (wc=1 flag) OR
    // when VPS mode is active AND the pipeline select is set to webcodecs.
    // This preserves WebRTC as a functional fallback even in VPS mode.
    vTrack.contentHint = 'motion';
    combined.addTrack(vTrack);

    const urlParams = new URLSearchParams(window.location.search);
    const pipelineEl = document.getElementById('pipelineSelect');
    const pipelineVal = pipelineEl ? pipelineEl.value : 'native';
    const forceWc = urlParams.get('wc') === '1' || pipelineVal === 'webcodecs' || pipelineVal === 'custom_webcodecs';
    if (forceWc) {
      log('WebCodecs pipeline active.', 'ok');
      startWebCodecsNetworkPipeline(vTrack);
    }

    let aTrack = screenStream.getAudioTracks()[0] || null;

    if (isLinux) {
      try {
        try {
          const unlockStream = await navigator.mediaDevices.getUserMedia({ audio: true });
          unlockStream.getTracks().forEach((t) => t.stop());
        } catch (e) {
          log(I18N.t('Audio permission missing, loopback labels hidden'), 'warn');
        }

        const devices = await navigator.mediaDevices.enumerateDevices();
        const audioInputs = devices.filter((d) => d.kind === 'audioinput');

        const loopbackDevice = audioInputs.find(
          (d) =>
            d.label.includes('NearsecVirtualCapture') ||
            d.label.includes('NearsecVirtual') ||
            d.label.includes('Nearsec_App_Mic') ||
            d.label.includes('Nearsec_Virtual_Mic') ||
            d.label.includes('NearsecAppMic') ||
            d.label.includes('Nearsec_App_Audio') ||
            d.label.includes('NearsecAppAudio')
        );

        if (loopbackDevice) {
          const audioStream = await navigator.mediaDevices.getUserMedia({
            audio: {
              deviceId: { exact: loopbackDevice.deviceId },
              echoCancellation: false,
              noiseSuppression: false,
              autoGainControl: false,
              channelCount: 2,
            },
          });
          aTrack = audioStream.getAudioTracks()[0];
          if (aTrack) log(I18N.t('System audio captured'), 'ok');
        } else {
          const labels = audioInputs.map((d) => d.label || 'Hidden').join(', ');
          log(I18N.t('Virtual cable not found. Seen labels:') + ' ' + labels, 'warn');
        }
      } catch (audErr) {
        console.warn('Linux audio loopback initialization failed:', audErr);
      }
    }

    const disableFallback = true;

    if (aTrack) {
      combined.addTrack(aTrack);
      if (typeof attachDesktopGain === 'function') attachDesktopGain(combined);
      log(I18N.t('System Audio Track Found:') + ' ' + (aTrack.label || 'default'), 'ok');
      if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'stop-audio-fallback' }));
    } else {
      if (!disableFallback) {
        log(I18N.t('Browser capture failed. Engaging Python OS-level audio fallback...'), 'warn');
        if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'start-audio-fallback' }));
      } else {
        log(I18N.t('Browser capture failed. (Python Fallback disabled)'), 'err');
      }
    }

    if (appSettings.captureMic) {
      try {
        const micConstraints = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
        if (selectedMicDeviceId && selectedMicDeviceId !== 'default') {
          micConstraints.deviceId = { exact: selectedMicDeviceId };
        }
        const micStream = await navigator.mediaDevices.getUserMedia({ audio: micConstraints, video: false });
        const micTrack = micStream.getAudioTracks()[0];
        if (micTrack) {
          combined.addTrack(micTrack);
          log(I18N.t('Microphone added:') + ' ' + (micTrack.label || 'default'), 'ok');
        }
      } catch (e) {
        log(I18N.t('Mic capture failed:') + ' ' + e.message, 'warn');
      }
    }

    currentStream = combined;

    const cb = document.getElementById('codecBadge');
    if (cb) cb.textContent = document.getElementById('codecSelect').value;

    const prev = document.getElementById('preview');
    if (appSettings.hidePreviewOnStart) {
      previewHidden = true;
      prev.style.display = 'none';
      const btn = document.getElementById('btnPreviewToggle');
      if (btn) {
        btn.innerHTML = SVG_EYE_CLOSED;
        btn.style.color = 'var(--warn)';
      }
    } else {
      prev.srcObject = screenStream;
    }

    if (settings.width && settings.height) prev.style.aspectRatio = settings.width + '/' + settings.height;
    document.getElementById('prevOverlay').classList.add('hidden');

    const finalAudioTracks = currentStream.getAudioTracks();
    const ti = document.getElementById('trackInfo');
    if (ti) {
      ti.innerHTML =
        '<strong>' +
        (vTrack.label?.split('(')[0].trim() || 'Screen') +
        '</strong><br>' +
        settings.width +
        '×' +
        settings.height +
        ' @ ' +
        Math.round(settings.frameRate || 0) +
        'fps<br>' +
        (finalAudioTracks.length > 0
          ? 'Audio: active'
          : disableFallback && !aTrack
            ? 'No audio'
            : 'Audio: OS fallback');
    }

    const liveResEl = document.getElementById('liveResDisplay');
    const liveResText = document.getElementById('liveResText');
    function _updateRes() {
      if (!currentStream) {
        clearInterval(_resInterval);
        return;
      }
      const vt = currentStream.getVideoTracks()[0];
      if (!vt) return;
      const s = vt.getSettings();
      const label = s.width && s.height ? s.width + '×' + s.height + ' @ ' + Math.round(s.frameRate || 0) + ' fps' : '';
      if (label) {
        if (liveResText) liveResText.textContent = label;
        if (liveResEl) liveResEl.style.display = 'block';
        const alt = document.getElementById('trackInfoAlt');
        if (alt && !alt.innerHTML.includes('<strong>')) {
          alt.textContent = label;
        }
      }

      // WebRTC HW Encoding Diagnostics
      const pcList = Object.values(peerConnections);
      if (pcList.length > 0 && pcList[0]) {
        pcList[0]
          .getStats()
          .then((stats) => {
            let isHw = false;
            let hwStr = '';
            stats.forEach((report) => {
              if (report.type === 'outbound-rtp' && report.kind === 'video') {
                if (report.encoderImplementation) {
                  const impl = report.encoderImplementation.toLowerCase();
                  isHw = !impl.includes('libvpx') && !impl.includes('openh264') && !impl.includes('fallback');
                  hwStr = report.encoderImplementation;
                }
              }
            });
            const cb = document.getElementById('codecBadge');
            if (cb && hwStr) {
              cb.title = `Encoder: ${hwStr} (${isHw ? 'Hardware' : 'Software'})`;
              if (isHw) {
                cb.style.border = '1px solid var(--ok)';
                cb.style.color = 'var(--ok)';
              } else {
                cb.style.border = '';
                cb.style.color = '';
              }
            }
          })
          .catch(() => {});
      }
    }
    _updateRes();
    if (window._resInterval) clearInterval(window._resInterval);
    window._resInterval = setInterval(_updateRes, 2000);

    setCapDot('live');
    _startStatsHud();

    // Notify VPS viewers the stream is now active so they dismiss standby
    if (_vpsWs && _vpsAuthOk && _vpsWs.readyState === 1) {
      _vpsWs.send(JSON.stringify({ type: 'stream-active', pinRequired: pinEnabled }));
    }

    setTimeout(() => {
      const checkTrack = currentStream ? currentStream.getAudioTracks()[0] : null;
      if (checkTrack || (!aTrack && !disableFallback)) {
        setAudDot('live', 'Audio active');
        if (checkTrack) startAudioMeter(currentStream);
      } else {
        setAudDot('warn', 'No audio — Check source');
      }
    }, 500);

    ws.send(JSON.stringify({ type: 'host-stream-ready' }));
    sysChat(I18N.t('Stream started.'));
    [...knownViewers].forEach((id) => sendOfferToViewer(id));

    vTrack.onended = () => {
      log(I18N.t('Capture ended by OS'), 'warn');
      stopCapture();
    };
    _elDisabled('btnSwitch', false);
    _elDisabled('btnStop', false);
    _elDisabled('btnKbmPanic', false);
  } catch (err) {
    // UNFREEZE TRIGGER: Now runs cleanly whether by user abort or by our timeout
    const sysName = isLinux ? (window.electronAPI ? 'Wayland/PipeWire' : 'Linux Native') : 'Windows/Mac Desktop API';

    if (err.name === 'NotAllowedError' || err.name === 'AbortError') {
      log(`Screen capture cancelled by user [${sysName}]`, 'warn');
      setCapDot('');
    } else {
      log(`Capture failed [${sysName}]: ${err.message}`, 'err');
      setCapDot('err');
    }

    _elDisabled('btnStart', false);
    _elDisabled('btnSwitch', true);
    _elDisabled('btnStop', true);
  }
}

// ── Windows-safe aggressive stream teardown ───────────────────────────────────
// Chromium on Windows refuses to start a new getUserMedia capture if the
// previous MediaStreamTrack was not explicitly stopped AND nulled. A simple
// forEach(t.stop()) is not sufficient — we must null each track reference
// and then null currentStream itself so the GC can release the OS handle.
function _forceKillStream(stream) {
  if (!stream) return;
  try {
    const tracks = stream.getTracks();
    for (let i = 0; i < tracks.length; i++) {
      try {
        tracks[i].stop();
      } catch (_) {}
      tracks[i] = null;
    }
  } catch (_) {}
}

function stopCapture() {
  isArcade = false;
  if (currentStream) {
    _forceKillStream(currentStream);
    currentStream = null;
  }
  if (window._resInterval) {
    clearInterval(window._resInterval);
    window._resInterval = null;
  }
  _stopStatsHud();
  stopAudioMeter();

  // Notify VPS viewers the stream has stopped — triggers standby screen
  if (_vpsWs && _vpsAuthOk && _vpsWs.readyState === 1) {
    _vpsWs.send(JSON.stringify({ type: 'stream-idle', pinRequired: pinEnabled }));
  }

  disconnectVps();

  if (window._webcodecsReader) {
    window._webcodecsReader.cancel();
    window._webcodecsReader = null;
  }
  if (_wcEncoder && _wcEncoder.state !== 'closed') {
    try {
      _wcEncoder.close();
    } catch (_) {}
  }
  _wcEncoder = null;
  _wcForceKeyframe = false;
  const wcCanvas = document.getElementById('webcodecs-preview-canvas');
  if (wcCanvas) wcCanvas.remove();

  // Stop FFmpeg experimental pipeline if it was running
  // fetch(`/api/capture/stop`, { method: 'POST' }).catch(() => {});
  if (window._ffmpegHealthInterval) {
    clearInterval(window._ffmpegHealthInterval);
    window._ffmpegHealthInterval = null;
  }
  const prevEl = document.getElementById('preview');
  if (prevEl) prevEl.srcObject = null;
  _elClass('prevOverlay', 'hidden', false);
  setCapDot('');
  setAudDot('', 'No audio');
  _elText('trackInfo', '');
  // Reset Live Status
  const alt = document.getElementById('trackInfoAlt');
  if (alt) alt.textContent = 'No stream active';
  const liveResEl = document.getElementById('liveResDisplay');
  if (liveResEl) liveResEl.style.display = 'none';
  // Reset preview button to eye-open SVG
  previewHidden = false;
  const prevBtn = document.getElementById('btnPreviewToggle');
  if (prevBtn) {
    prevBtn.innerHTML = SVG_EYE_OPEN;
    prevBtn.style.color = '';
  }
  // Restore "Click Start" overlay text
  const overlaySpan = document.querySelector('#prevOverlay span');
  if (overlaySpan) overlaySpan.textContent = 'Click Start to begin sharing';
  _elDisabled('btnStart', false);
  _elDisabled('btnSwitch', true);
  _elDisabled('btnStop', true);
  _elDisabled('btnKbmPanic', true);
  kbmPanicActive = false;
  updateKbmPanicButton();
  Object.values(peerConnections).forEach((pc) => pc.close());
  peerConnections = {};
  streamActive = false;
  _updateDiscordRPC();

  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'host-stream-stopped' }));
  }

  if (arcadePingInterval) {
    clearInterval(arcadePingInterval);
    arcadePingInterval = null;
    arcadeChannel.trigger('client-session-stop', { id: hostSessionId });
    log(I18N.t('Arcade Mode: Session ended on Arcade'), 'warn');

    // Restore the Arcade button SVG icon
    const btnArcade = document.getElementById('btnArcade');
    if (btnArcade) {
      btnArcade.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>`;
    }
  }

  if (arcadeOverrodePin) {
    arcadeOverrodePin = false;
    pinEnabled = true;
    const btn = document.getElementById('pinToggle');
    if (btn) {
      btn.textContent = 'ON';
      btn.className = 'pin-toggle-btn on';
    }
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'set-pin', enabled: true }));
    log(I18N.t('PIN re-enabled after Arcade session'), 'ok');
  }

  // NEW: Unlock PIN UI when session ends (MOVED HERE SO IT ALWAYS RUNS)
  const pinSwitch = document.getElementById('arcadeRequirePin');
  const pinDisplay = document.getElementById('pinVal');

  if (pinSwitch) {
    pinSwitch.disabled = false;
    pinSwitch.title = '';
  }
  if (pinDisplay && pinDisplay.dataset.originalPin) {
    pinDisplay.textContent = pinDisplay.dataset.originalPin;
  }

  log(I18N.t('Capture stopped'));
  sysChat(I18N.t('Host stopped sharing.'));

  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('auto') === '1') {
    console.log('[Headless] Stream terminated. Executing suicide protocol to restart worker.');
    if (window.electronAPI && window.electronAPI.close) {
      window.electronAPI.close();
    }
  }
}

// ── Test-only export shim ──────────────────────────────────────────────────
// `module` does not exist in the browser, so this block is inert there and
// changes no runtime behavior. See REFACTOR_PLAN.md Phase 0 / Phase 5.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { hotSwapCapture, startCapture, _forceKillStream, stopCapture };
}
