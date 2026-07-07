// ── SHARED CODEC-NEGOTIATION HELPERS ───────────────────────────────────────
// Loaded via a <script> tag before host.js/viewer.js, same pattern as
// chat.js and peer-connection.js.
//
// host.js's preferVideoCodec(pc) and viewer.js's preferReceiverCodec(t, mime)
// are NOT literal duplicates — one iterates pc.getTransceivers() off a DOM
// select value, the other reorders one already-known transceiver against an
// explicit mime driven by the host's WebRTC offer — but both apply the same
// trick: force a specific codec (with H264 preferring the constrained-
// baseline `42e01f` profile, working around a Windows AMD/MediaFoundation
// decoder bug) to the front of the codec list, keeping any adjacent RTX
// companion codec paired with it (WebRTC requires RTX/RED to stay adjacent
// to their base codec). That shared trick — not the surrounding wrapper — is
// what's extracted here. See REFACTOR_PLAN.md Phase 5.3.

/**
 * Finds a codec matching `mimeOrMimes` in `codecs` and splices it (plus an
 * immediately-following RTX companion, if present) out of `codecs` in
 * place, returning the removed codec(s) in order. Returns `[]` if none of
 * the given mimes are present.
 *
 * `mimeOrMimes` may be a single mimeType or an array of acceptable
 * alternates searched in one pass (not one-at-a-time) — this matters for
 * host.js's H265 case, where the browser may label the codec `video/hevc`
 * or `video/h265`; searching in one pass picks whichever label appears
 * first in the reported capability list, matching the original single
 * `findIndex(... === a || ... === b)` behavior instead of always
 * preferring one label over the other.
 */
function extractPreferredCodec(codecs, mimeOrMimes) {
  const mimes = (Array.isArray(mimeOrMimes) ? mimeOrMimes : [mimeOrMimes]).map((m) => m.toLowerCase());

  let targetIdx = -1;
  if (mimes.includes('video/h264')) {
    targetIdx = codecs.findIndex(
      (c) => c.mimeType.toLowerCase() === 'video/h264' && c.sdpFmtpLine && c.sdpFmtpLine.includes('42e01f')
    );
  }
  if (targetIdx === -1) {
    targetIdx = codecs.findIndex((c) => mimes.includes(c.mimeType.toLowerCase()));
  }
  if (targetIdx === -1) return [];

  let count = 1;
  if (codecs[targetIdx + 1] && codecs[targetIdx + 1].mimeType.toLowerCase() === 'video/rtx') count = 2;
  return codecs.splice(targetIdx, count);
}

// ── HOST-ONLY: WebRTC quality tuning ───────────────────────────────────────
// Codec auto-benchmark, low-latency sender params, and congestion-driven
// bitrate adaptation. No viewer.js counterpart — moved here verbatim from
// host.js (not logic changes) since it's the same "WebRTC quality tuning"
// concern this module already owns.

const congestionControl = {
  enabled: true,
  minRttMs: 40,
  maxRttMs: 120,
  packetLossThreshold: 5,
  statsPollInterval: 2000, // FIX: Prevents the 0ms infinite loop!
  recoveryTimeout: 5000, // FIX: Prevents NaN math errors during bandwidth recovery
  lastAdjustment: {}, // FIX: Stores individual viewer states
};

async function monitorCongestion(pc, viewerId) {
  if (!congestionControl.enabled) return;

  const poll = async () => {
    try {
      // <--- OUTER TRY STARTS HERE
      const stats = await pc.getStats();
      let candidatePair = null;

      stats.forEach((report) => {
        if (report.type === 'candidate-pair' && report.state === 'succeeded') {
          if (!candidatePair || report.currentRoundTripTime > candidatePair.currentRoundTripTime) {
            candidatePair = report;
          }
        }
      });

      if (!candidatePair) return;

      const rttMs = Math.round(candidatePair.currentRoundTripTime * 1000);
      const packetLoss = candidatePair.availableOutgoingBitrate
        ? ((candidatePair.packetsLost || 0) / (candidatePair.packetsSent || 1)) * 100
        : 0;

      if (!congestionControl.baselineRtt && rttMs > 0) {
        congestionControl.baselineRtt = rttMs;
        log(`Congestion: Baseline RTT ${rttMs}ms`, 'ok');
      }

      const sender = pc.getSenders().find((s) => s.track?.kind === 'video');
      if (!sender) return;

      const params = sender.getParameters();
      const configuredBitrate = parseInt(document.getElementById('bitrateSelect')?.value, 10) || 0;
      const currentBitrate = params.encodings?.[0]?.maxBitrate || configuredBitrate;

      if (!congestionControl.lastAdjustment[viewerId]) {
        congestionControl.lastAdjustment[viewerId] = { bitrate: currentBitrate, time: 0, baselineRtt: 0 };
      }
      const lastAdj = congestionControl.lastAdjustment[viewerId];

      if (!lastAdj.baselineRtt && rttMs > 0) {
        lastAdj.baselineRtt = rttMs;
        log(`Congestion: Baseline RTT ${rttMs}ms`, 'ok');
      }

      const timeSinceLastAdj = Date.now() - lastAdj.time;
      const degPref = document.getElementById('degSelect')?.value || 'maintain-framerate';

      let shouldReduce = false;
      let reason = '';

      if (packetLoss > congestionControl.packetLossThreshold) {
        shouldReduce = true;
        reason = `high packet loss (${packetLoss.toFixed(1)}%)`;
      } else if (rttMs > congestionControl.maxRttMs) {
        shouldReduce = true;
        reason = `high RTT (${rttMs}ms > ${congestionControl.maxRttMs}ms)`;
      } else if (
        timeSinceLastAdj > congestionControl.recoveryTimeout &&
        currentBitrate < (configuredBitrate || lastAdj.bitrate) * 0.95 &&
        rttMs < congestionControl.minRttMs
      ) {
        const ceiling = configuredBitrate > 0 ? configuredBitrate : lastAdj.bitrate;
        const recovered = Math.min(ceiling, currentBitrate * 1.1);

        if (params.encodings?.length) {
          params.encodings[0].maxBitrate = Math.round(recovered);
          params.encodings[0].degradationPreference = degPref;
        }
        await sender.setParameters(params);

        if (
          typeof _wcEncoder !== 'undefined' &&
          _wcEncoder &&
          _wcEncoder.state !== 'closed' &&
          _wcEncoder._lastConfig
        ) {
          try {
            _wcEncoder._lastConfig.bitrate = Math.round(recovered);
            _wcEncoder.configure(_wcEncoder._lastConfig);
          } catch (e) {}
        }

        congestionControl.lastAdjustment[viewerId] = {
          bitrate: recovered,
          time: Date.now(),
          baselineRtt: lastAdj.baselineRtt,
        };
        log(
          I18N.t('Congestion: Bitrate recovered to ${Math.round(recovered/1000)}kbps for ${viewerId}')
            .replace('${Math.round(recovered/1000)}', Math.round(recovered / 1000))
            .replace('${viewerId}', viewerId),
          'ok'
        );
        return;
      }

      if (shouldReduce && timeSinceLastAdj > 2000) {
        const isCrisp = degPref === 'maintain-resolution';
        const reductionFactor = isCrisp ? 0.95 : 0.8;
        const minFloor = isCrisp ? 2500000 : 500000;
        const newBitrate = Math.round(currentBitrate * reductionFactor);

        try {
          // <--- INNER TRY (The INVALID_STATE fix)
          const freshParams = sender.getParameters();
          if (freshParams.encodings?.length) {
            freshParams.encodings[0].maxBitrate = Math.max(minFloor, newBitrate);
            freshParams.encodings[0].degradationPreference = degPref;
          }
          await sender.setParameters(freshParams);

          if (
            typeof _wcEncoder !== 'undefined' &&
            _wcEncoder &&
            _wcEncoder.state !== 'closed' &&
            _wcEncoder._lastConfig
          ) {
            try {
              _wcEncoder._lastConfig.bitrate = Math.max(minFloor, newBitrate);
              _wcEncoder.configure(_wcEncoder._lastConfig);
            } catch (e) {}
          }

          congestionControl.lastAdjustment[viewerId] = {
            bitrate: currentBitrate,
            time: Date.now(),
            baselineRtt: lastAdj.baselineRtt,
          };
          log(
            I18N.t('Congestion: Bitrate reduced to ${Math.round(newBitrate/1000)}kbps (${reason})')
              .replace('${Math.round(newBitrate/1000)}', Math.round(newBitrate / 1000))
              .replace('${reason}', reason),
            'warn'
          );
        } catch (e) {
          console.warn('[Congestion] Failed to apply bitrate reduction:', e.message);
        }
      }
    } catch (outerErr) {}
  };

  const interval = setInterval(async () => {
    if (!peerConnections[viewerId]) {
      clearInterval(interval);
      return;
    }
    await poll();
  }, congestionControl.statsPollInterval);
}
// ── CODEC AUTO-BENCHMARK ──────────────────────────────────────────────────────
// Tests each WebRTC codec the browser supports by:
// 1. Creating a loopback RTCPeerConnection pair
// 2. Streaming test_video.mp4 via a <video> element
// 3. Measuring received bitrate over 8 seconds per codec
// 4. Picking the winner and saving it to localStorage
async function runBenchmark(mode) {
  const btnSpeed = document.getElementById('codecBenchBtnSpeed');
  const btnQuality = document.getElementById('codecBenchBtnQuality');
  const activeBtn = mode === 'speed' ? btnSpeed : btnQuality;
  const inactiveBtn = mode === 'speed' ? btnQuality : btnSpeed;
  const statusEl = document.getElementById('codecBenchStatus');
  const logEl = document.getElementById('codecBenchLog');
  const fillEl = document.getElementById('codecBenchFill');
  const pctEl = document.getElementById('codecBenchPct');

  if (btnSpeed.dataset.running || btnQuality.dataset.running) return;
  activeBtn.dataset.running = '1';
  btnSpeed.disabled = true;
  btnQuality.disabled = true;

  const originalText = activeBtn.textContent;
  activeBtn.textContent = 'Running benchmark...';
  statusEl.style.display = 'block';
  logEl.innerHTML = '';
  fillEl.style.width = '0%';
  pctEl.textContent = '0%';

  function benchLog(msg, color) {
    const d = document.createElement('div');
    d.textContent = msg;
    if (color) d.style.color = color;
    logEl.appendChild(d);
    logEl.scrollTop = logEl.scrollHeight;
  }

  // Get all codecs the browser actually supports via WebRTC
  const caps = RTCRtpSender.getCapabilities?.('video');
  if (!caps) {
    benchLog('Browser does not support getCapabilities', 'var(--error)');
    btnSpeed.disabled = false;
    btnQuality.disabled = false;
    delete activeBtn.dataset.running;
    activeBtn.textContent = originalText;
    return;
  }

  // Map codec mime types to the codecSelect option values
  const CODEC_MAP = {
    'video/h264': 'H264',
    'video/hevc': 'H265',
    'video/vp8': 'VP8',
    'video/vp9': 'VP9',
    'video/av1': 'AV1',
  };

  // Deduplicate by family
  const seen = new Set();
  const toTest = [];
  for (const c of caps.codecs) {
    const key = c.mimeType.toLowerCase();
    const mapped = CODEC_MAP[key];
    if (mapped && !seen.has(mapped)) {
      seen.add(mapped);
      toTest.push({ mime: key, name: mapped, codec: c });
    }
  }

  benchLog(`Testing ${toTest.length} codec(s) — 8s each…`);

  // Set up test canvas to simulate video stream
  const testCanvas = document.createElement('canvas');
  testCanvas.width = 1280;
  testCanvas.height = 720;
  const testCtx = testCanvas.getContext('2d');
  testCtx.fillStyle = '#0f111a';
  testCtx.fillRect(0, 0, 1280, 720);
  // Draw a spinning block to force encoder motion
  let testAngle = 0;
  const testAnim = setInterval(() => {
    testCtx.fillStyle = '#0f111a';
    testCtx.fillRect(0, 0, 1280, 720);
    testCtx.save();
    testCtx.translate(640, 360);
    testCtx.rotate(testAngle);
    testCtx.fillStyle = '#8b5cf6';
    testCtx.fillRect(-200, -200, 400, 400);
    testCtx.restore();
    testAngle += 0.1;
  }, 33);

  const results = [];

  for (let i = 0; i < toTest.length; i++) {
    const { mime, name } = toTest[i];
    const pct = Math.round((i / toTest.length) * 100);
    fillEl.style.width = pct + '%';
    pctEl.textContent = pct + '%';

    benchLog(`Testing ${name}...`);
    let bitrate = 0;

    try {
      // Create a loopback PC pair
      const pc1 = new RTCPeerConnection();
      const pc2 = new RTCPeerConnection();
      pc1.onicecandidate = (e) => e.candidate && pc2.addIceCandidate(e.candidate).catch(() => {});
      pc2.onicecandidate = (e) => e.candidate && pc1.addIceCandidate(e.candidate).catch(() => {});

      // Add video track from the test canvas
      const stream = testCanvas.captureStream(30);
      if (!stream) throw new Error('captureStream not supported');
      const [track] = stream.getVideoTracks();
      if (!track) throw new Error('Video track not available yet');
      pc1.addTrack(track, stream);

      // Prefer the specific codec on pc1's sender
      const allCodecs = caps.codecs;
      const preferred = allCodecs.filter((c) => c.mimeType.toLowerCase() === mime);
      const rest = allCodecs.filter((c) => c.mimeType.toLowerCase() !== mime);
      if (preferred.length === 0) {
        benchLog(`  - ${name}: not in capabilities — skip`);
        pc1.close();
        pc2.close();
        continue;
      }
      pc1.getTransceivers().forEach((t) => {
        if (t.sender?.track?.kind === 'video') {
          try {
            t.setCodecPreferences([...preferred, ...rest]);
          } catch (_) {}
        }
      });

      const offer = await pc1.createOffer();
      await pc1.setLocalDescription(offer);
      await pc2.setRemoteDescription(offer);
      const answer = await pc2.createAnswer();
      await pc2.setLocalDescription(answer);
      await pc1.setRemoteDescription(answer);

      // Wait for connection
      await new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error('ICE timeout')), 5000);
        pc2.onconnectionstatechange = () => {
          if (pc2.connectionState === 'connected') {
            clearTimeout(t);
            res();
          }
          if (pc2.connectionState === 'failed') {
            clearTimeout(t);
            rej(new Error('ICE failed'));
          }
        };
      });

      // Wait for the codec to actually be negotiated and used
      await new Promise((r) => setTimeout(r, 1000));

      // Check what codec actually got selected (not just requested)
      let actualCodec = null;
      try {
        const stats = await pc2.getStats();
        stats.forEach((r) => {
          if (r.type === 'inbound-rtp' && r.kind === 'video' && r.codecId) {
            const codecStat = stats.get(r.codecId);
            if (codecStat) actualCodec = codecStat.mimeType;
          }
        });
      } catch (_) {}

      if (actualCodec && !actualCodec.toLowerCase().includes(mime.split('/')[1])) {
        benchLog(`  - ${name}: browser used ${actualCodec} instead — skip`);
        pc1.close();
        pc2.close();
        continue;
      }

      // Measure bitrate over 8 seconds
      let lastBytes = 0,
        lastTime = 0;
      const samples = [];
      for (let s = 0; s < 8; s++) {
        await new Promise((r) => setTimeout(r, 1000));
        try {
          const stats = await pc2.getStats();
          stats.forEach((r) => {
            if (r.type === 'inbound-rtp' && r.kind === 'video') {
              if (lastTime > 0) {
                const kbps = ((r.bytesReceived - lastBytes) * 8) / (r.timestamp - lastTime);
                if (kbps > 0) samples.push(kbps);
              }
              lastBytes = r.bytesReceived;
              lastTime = r.timestamp;
            }
          });
        } catch (_) {}
      }

      bitrate = samples.length ? Math.round(samples.reduce((a, b) => a + b, 0) / samples.length) : 0;
      pc1.close();
      pc2.close();
    } catch (err) {
      benchLog(`  - ${name}: ${err.message}`, 'var(--warn)');
      continue;
    }

    if (bitrate > 0) {
      benchLog(`  + ${name}: ${bitrate} kbps`, 'var(--accent)');
      results.push({ name, bitrate });
    } else {
      benchLog(`  - ${name}: no frames received`);
    }
  }

  clearInterval(testAnim);

  fillEl.style.width = '100%';
  pctEl.textContent = '100%';

  if (results.length === 0) {
    benchLog('No codec produced usable output. Check GPU/driver.', 'var(--error)');
  } else {
    if (mode === 'speed') {
      document.getElementById('resSelect').value = '720';
      document.getElementById('fpsSelect').value = '60';
      // Sort by bitrate descending — highest throughput = fastest codec
      results.sort((a, b) => b.bitrate - a.bitrate);
    } else {
      document.getElementById('resSelect').value = '1080';
      document.getElementById('fpsSelect').value = '60';
      // Best quality is typically AV1 > H265 > VP9 > H264 > VP8
      const qualityOrder = ['AV1', 'H265', 'VP9', 'H264', 'VP8'];
      results.sort((a, b) => {
        const idxA = qualityOrder.indexOf(a.name);
        const idxB = qualityOrder.indexOf(b.name);
        if (idxA === idxB) return b.bitrate - a.bitrate;
        return (idxA !== -1 ? idxA : 99) - (idxB !== -1 ? idxB : 99);
      });
    }

    applyBitrateToAll(); // Applies the new resolution and FPS

    const winner = results[0];
    benchLog(`Best: ${winner.name} @ ${winner.bitrate} kbps — applied!`, '#22c55e');
    document.getElementById('codecSelect').value = winner.name;
    localStorage.setItem('ns_codec', winner.name);
    // Reapply to live connections if any
    Object.values(peerConnections).forEach((pc) => {
      if (pc) preferVideoCodec(pc);
    });
  }

  btnSpeed.disabled = false;
  btnQuality.disabled = false;
  activeBtn.textContent = originalText;
  delete activeBtn.dataset.running;
}

async function setLowLatencyParams(pc) {
  const sender = pc.getSenders().find((s) => s.track?.kind === 'video');
  if (!sender) return;
  try {
    const params = sender.getParameters();
    const bitVal = parseInt(document.getElementById('bitrateSelect').value, 10);
    const _appFpsUnlock = typeof appConfig !== 'undefined' && appConfig.fpsUnlock;
    const fpsVal = _appFpsUnlock
      ? Math.max(parseInt(document.getElementById('fpsSelect')?.value) || 60, 120)
      : parseInt(document.getElementById('fpsSelect')?.value) || 60;

    if (params.encodings?.length) {
      if (bitVal > 0) {
        params.encodings[0].maxBitrate = bitVal;
      } else {
        delete params.encodings[0].maxBitrate;
      }
      params.encodings[0].maxFramerate = fpsVal;
      params.encodings[0].networkPriority = 'high';
      params.encodings[0].priority = 'high';

      const degPref = document.getElementById('degSelect')?.value || 'maintain-framerate';
      params.encodings[0].degradationPreference = degPref;
    }
    await sender.setParameters(params);
  } catch (e) {
    console.warn('[WebRTC] Failed to apply low latency params:', e.message);
  }
}

async function applyBitrateToAll() {
  for (const pc of Object.values(peerConnections)) {
    await setLowLatencyParams(pc);
  }
  const bitVal = parseInt(document.getElementById('bitrateSelect').value, 10);
  log(I18N.t('Stream bitrate changed to') + ' ' + (bitVal > 0 ? bitVal / 1000000 + ' Mbps' : 'Auto'), 'ok');
}

// ── VIEWER-ONLY: bandwidth/quality profiles ────────────────────────────────
// Auto/Low/High receive-side caps. No host.js counterpart — moved here
// verbatim from viewer.js (not a logic change) for the same reason as the
// host-only section above.

// ── BANDWIDTH / QUALITY PROFILES ─────────────────────────────────────────────
// Auto: unconstrained (let WebRTC CC do its job — best for most users)
// Low:  cap at 720p / 1.5 Mbps  (mobile data, bad Wi-Fi)
// High: cap at 4K  / 8 Mbps     (LAN / fibre, power users)
//
// Applied after setRemoteDescription so the transceiver already exists.
// Uses setParameters() on the video receiver if supported, otherwise falls
// back to SDP bandwidth annotation (b=AS). Silently no-ops if the host is
// running a strict single-encode pipeline that doesn't honour it.

const BW_PROFILES = {
  auto: { label: 'Auto', maxBitrate: null, maxHeight: null, scaleDown: 1 },
  low: { label: 'Low', maxBitrate: 1_500_000, maxHeight: 720, scaleDown: 2 },
  high: { label: 'High', maxBitrate: 8_000_000, maxHeight: 2160, scaleDown: 1 },
};

let _bwProfile = localStorage.getItem('ns_bw_profile') || 'auto';

function setBandwidthProfile(key) {
  if (!BW_PROFILES[key]) return;
  _bwProfile = key;
  localStorage.setItem('ns_bw_profile', key);
  // Update button states in nsBar
  document.querySelectorAll('[data-bw]').forEach((btn) => {
    btn.classList.toggle('ns-btn-active', btn.dataset.bw === key);
  });
  // Apply immediately if a PC exists
  if (pc) _applyBwProfile(pc);
  console.log('[BW] Profile set:', key);
}

async function _applyBwProfile(targetPc) {
  const profile = BW_PROFILES[_bwProfile];
  if (!targetPc) return;

  try {
    // 1. Try RTCRtpReceiver.setParameters() (Chrome 94+)
    const receivers = targetPc.getReceivers();
    for (const recv of receivers) {
      if (recv.track?.kind !== 'video') continue;
      const params = recv.getParameters?.();
      if (!params) continue;
      if (profile.maxBitrate) {
        // encodings on the receiver side control REMB/TMMBR feedback
        if (params.encodings?.length) {
          params.encodings[0].maxBitrate = profile.maxBitrate;
          if (profile.scaleDown > 1) params.encodings[0].scaleResolutionDownBy = profile.scaleDown;
        }
      } else {
        // Auto: clear constraints
        if (params.encodings?.length) {
          delete params.encodings[0].maxBitrate;
          params.encodings[0].scaleResolutionDownBy = 1;
        }
      }
      try {
        await recv.setParameters(params);
      } catch (_) {}
    }

    // 2. Also send a hint to the host via WS so it can optionally adjust its encoder
    if (ws && ws.readyState === 1) {
      ws.send(
        JSON.stringify({
          type: 'viewer-bw-hint',
          profile: _bwProfile,
          maxBitrate: profile.maxBitrate,
          maxHeight: profile.maxHeight,
        })
      );
    }
  } catch (e) {
    console.warn('[BW] Could not apply profile:', e);
  }
}
// ──────────────────────────────────────────────────────────────────────────────

// ── Test-only export shim ──────────────────────────────────────────────────
// `module` does not exist in the browser, so this block is inert there and
// changes no runtime behavior. See REFACTOR_PLAN.md Phase 0 / Phase 5.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    extractPreferredCodec,
    congestionControl,
    monitorCongestion,
    runBenchmark,
    setLowLatencyParams,
    applyBitrateToAll,
    BW_PROFILES,
    setBandwidthProfile,
    _applyBwProfile,
  };
}
