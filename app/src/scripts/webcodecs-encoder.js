// ── WEBCODECS ENCODER (host.js only) ────────────────────────────────────────
// Loaded via a <script> tag before host.js, same pattern as the other
// scripts/**/*.js modules. The live WebCodecs pipeline: encodes the capture
// track directly (bypassing WebRTC's own encoder) and pushes chunks to
// viewers over the VPS SFU / tunnel WS / per-viewer datachannel.
//
// _lastWcConfig/_wcEncoder/_wcForceKeyframe (read/written here) live in
// host.js — shared with capture.js's stopCapture() teardown and host.js's
// own sendOfferToViewer() wiring, so they didn't move here. See
// REFACTOR_PLAN.md Phase 5.9.
//
// ── Likely-dead code, relocated but NOT deleted ────────────────────────────
// startWebCodecsPipeline() has zero call sites anywhere in the codebase.
// startFFmpegCapture()'s only call site is inside a commented-out block in
// capture.js's startCapture(). Both look like superseded/abandoned encoder
// variants — startWebCodecsNetworkPipeline() below is the pipeline actually
// wired up and used. Static analysis is as far as this environment can
// verify (no display/real capture devices available here) — REFACTOR_PLAN.md
// Phase 5.9 explicitly calls for a real capture test before deleting these,
// not a static-analysis-only judgment call. Left in place, clearly flagged,
// for whoever can run that test next.

async function startWebCodecsPipeline(videoTrack, dataChannel) {
  console.log('Initializing WebCodecs VideoEncoder...');

  // 1. Configure the Bare-Metal Hardware Encoder
  const encoder = new VideoEncoder({
    output: (chunk, metadata) => {
      // This callback fires the exact millisecond the GPU finishes encoding a frame.
      // We immediately hurl the raw bytes over the network.
      const buffer = new ArrayBuffer(chunk.byteLength);
      chunk.copyTo(buffer);

      // Send chunk data & type (keyframe vs delta frame)
      const payload = JSON.stringify({
        type: chunk.type,
        timestamp: chunk.timestamp,
        data: Array.from(new Uint8Array(buffer)), // Serialize for transport
      });

      if (dataChannel.readyState === 'open') {
        dataChannel.send(payload);
      }
    },
    error: (err) => {
      console.error('WebCodecs Encoding Error:', err);
    },
  });

  // 2. Enforce ultra-low latency hardware parameters
  encoder.configure({
    codec: 'avc1.42002A', // H.264 Baseline Profile (Fastest decode)
    width: 1920,
    height: 1080,
    bitrate: 8000000, // 8 Mbps
    framerate: 60,
    hardwareAcceleration: 'prefer-hardware',
    latencyMode: 'realtime', // Throws away jitter buffers!
  });

  // 3. Rip the raw frames directly from the PipeWire video track
  const processor = new MediaStreamTrackProcessor({ track: videoTrack });
  const reader = processor.readable.getReader();

  // 4. The Encoding Loop
  async function processFrames() {
    while (true) {
      const { done, value: frame } = await reader.read();
      if (done) break;

      // Feed the raw frame to the GPU, then instantly garbage collect it
      // to prevent memory leaks.
      encoder.encode(frame);
      frame.close();
    }
  }

  // Start the loop
  processFrames();
  console.log('WebCodecs Pipeline is now pushing raw frames.');
}

async function startFFmpegCapture() {
  return new Promise(async (resolve, reject) => {
    try {
      // 1. Tell the backend to spin up the FFmpeg hardware encoder
      const capRes = await fetch('/api/capture/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: 'ffmpeg' }),
      });
      const capData = await capRes.json();
      if (!capData.ok || !capData.port) {
        return reject(new Error('Failed to start FFmpeg capture on backend'));
      }

      // Clean up any old instances
      let oldVideo = document.getElementById('ffmpeg-hidden-video');
      if (oldVideo) oldVideo.remove();

      // 2. Create an invisible video element to decode the stream natively
      // (It MUST be attached to the DOM for captureStream to work in Electron)
      const video = document.createElement('video');
      video.id = 'ffmpeg-hidden-video';
      video.autoplay = true;
      video.muted = true;
      video.style.position = 'fixed';
      video.style.top = '-9999px';
      video.style.opacity = '0';
      document.body.appendChild(video);

      const ms = new MediaSource();
      video.src = URL.createObjectURL(ms);

      ms.addEventListener('sourceopen', async () => {
        const sourceBuffer = ms.addSourceBuffer('video/mp4; codecs="avc1.64002a"');

        // 3. Connect to our new dedicated FFmpeg HTTP stream port
        const response = await fetch(`http://127.0.0.1:${capData.port}/`);
        const reader = response.body.getReader();

        const pushChunk = async () => {
          if (sourceBuffer.updating) {
            setTimeout(pushChunk, 10);
            return;
          }
          try {
            const { value, done } = await reader.read();
            if (done) return;
            sourceBuffer.appendBuffer(value);
          } catch (err) {
            console.error('Stream read error', err);
          }
        };

        sourceBuffer.addEventListener('updateend', pushChunk);
        pushChunk(); // Kick off the loop

        video.onplaying = () => {
          log('FFmpeg Fragmented MP4 stream hooked successfully!', 'ok');
          // Extract the raw WebRTC track!
          resolve(video.captureStream(60).getVideoTracks()[0]);
        };
      });

      video.onerror = () => reject(new Error('Video decode error'));
    } catch (err) {
      reject(err);
    }
  });
}

async function startWebCodecsNetworkPipeline(videoTrack) {
  console.log('[WebCodecs] Initializing Network Pipeline...');
  if (typeof sysChat === 'function') sysChat('WebCodecs Network Pipeline Armed');

  _lastWcConfig = null;
  _wcForceKeyframe = false;

  // Grab the exact hardware resolution from the native capture track
  const settings = videoTrack.getSettings();
  const exactWidth = (settings.width || 1920) & ~1;
  const exactHeight = (settings.height || 1080) & ~1;

  const encoder = new VideoEncoder({
    output: (chunk, metadata) => {
      if (metadata.decoderConfig) {
        _lastWcConfig = JSON.stringify({
          type: 'webcodecs-config',
          codec: metadata.decoderConfig.codec,
          codedWidth: metadata.decoderConfig.codedWidth || exactWidth,
          codedHeight: metadata.decoderConfig.codedHeight || exactHeight,
          // The viewer sizes its decode-stall guard from this (host UI
          // allows 15-140fps, so frame-count thresholds can't be fixed).
          framerate: _wcFps,
          description: metadata.decoderConfig.description
            ? Array.from(new Uint8Array(metadata.decoderConfig.description))
            : null,
        });
        broadcastToViewers(_lastWcConfig);
      }

      const payload = new Uint8Array(1 + 8 + chunk.byteLength);
      payload[0] = chunk.type === 'key' ? 1 : 0;
      new DataView(payload.buffer).setFloat64(1, chunk.timestamp, true);
      chunk.copyTo(payload.subarray(9));

      broadcastToViewers(payload.buffer, chunk.type === 'key');
    },
    error: (e) => console.error('[WebCodecs] Encoder Error:', e),
  });
  _wcEncoder = encoder;

  // Derive codec string from the host's UI selection so AV1/VP9/H264 are honored.
  // WebCodecs codec strings differ from WebRTC mimeTypes — map them explicitly.
  let _wcCodecSel = (document.getElementById('codecSelect')?.value || 'VP8').toUpperCase();

  // FIX: Linux VaapiVideoEncoder fails to emit mandatory AVCC extradata (description) for H264.
  // Windows VideoDecoder completely crashes/blacks out if description is missing.
  // Force fallback to VP9 on Linux to bypass the H264 hardware encoder bug in WebCodecs.
  if (_wcCodecSel === 'H264' && navigator.userAgent.toLowerCase().includes('linux')) {
    console.warn('[WebCodecs] Linux H264 hardware encoding is broken (missing AVCC). Forcing VP9 fallback.');
    _wcCodecSel = 'VP9';
  }

  const _wcCodecMap = {
    AV1: 'av01.0.04M.08',
    VP9: 'vp09.00.10.08',
    VP8: 'vp8',
    H264: 'avc1.42002A',
    H265: 'hvc1.1.6.L93.B0',
  };
  // Ceiling comes from the host's bitrate select (raw bps, 0 = Auto) so the
  // WebCodecs path honors the same UI setting the WebRTC path does.
  const _bitSel = parseInt(document.getElementById('bitrateSelect')?.value, 10);
  const _wcMaxBitrate = _bitSel > 0 ? _bitSel : 8000000;

  // Actual capture frame rate — the UI allows 15-140fps, so every
  // frame-count threshold below derives from this rather than assuming 60.
  const _wcFps = Math.round(settings.frameRate || 60);

  const _wcCodecStr = _wcCodecMap[_wcCodecSel] || 'vp8';
  const wcConfig = {
    codec: _wcCodecStr,
    width: exactWidth,
    height: exactHeight,
    bitrate: _wcMaxBitrate,
    framerate: _wcFps,
    hardwareAcceleration: 'prefer-hardware',
    latencyMode: 'realtime',
  };
  // Software fallback: 'prefer-hardware' hard-fails where no HW encoder
  // exists, so probe first and drop to 'no-preference' (the old behavior).
  try {
    const support = await VideoEncoder.isConfigSupported(wcConfig);
    if (!support || !support.supported) wcConfig.hardwareAcceleration = 'no-preference';
  } catch (_) {
    wcConfig.hardwareAcceleration = 'no-preference';
  }
  encoder.configure(wcConfig);
  encoder._lastConfig = wcConfig;
  console.log(
    `[WebCodecs] Encoder configured with codec: ${_wcCodecStr} (from UI: ${_wcCodecSel}, hw: ${wcConfig.hardwareAcceleration})`
  );
  // Surface the negotiated mode in the host UI: 'no-preference' on AV1/VP9
  // at high fps almost always means software encode, which is the usual
  // culprit when the encoder itself can't keep up.
  if (typeof log === 'function') {
    const hwLabel = wcConfig.hardwareAcceleration === 'prefer-hardware' ? 'hardware' : 'software/auto';
    log(
      `WebCodecs encoder: ${_wcCodecStr} @ ${_wcFps}fps, max ${(_wcMaxBitrate / 1e6).toFixed(0)} Mbps (${hwLabel})`,
      'ok'
    );
  }

  // ~50ms of encode pipeline depth regardless of frame rate: 2 frames at
  // 15fps, 3 at 60, 7 at 140. Deeper absorbs bursts better; shallower keeps
  // latency down.
  const _wcEncQueueMax = Math.max(2, Math.round(_wcFps * 0.05));

  const processor = new MediaStreamTrackProcessor({ track: videoTrack });
  const reader = processor.readable.getReader();
  window._webcodecsReader = reader;

  async function processFrames() {
    try {
      while (true) {
        const { done, value: frame } = await reader.read();
        if (done) break;

        if (encoder.state === 'closed') {
          frame.close();
          continue;
        }

        // FIX: Dynamic Resolution Handling
        // Capture cards and emulators (e.g., Smash Ultimate) frequently resize frames.
        // If the encoder isn't reconfigured, it throws an error and permanently dies, causing a black screen.
        const fW = (frame.displayWidth || frame.codedWidth) & ~1;
        const fH = (frame.displayHeight || frame.codedHeight) & ~1;
        if (fW > 0 && fH > 0 && (fW !== encoder._lastConfig.width || fH !== encoder._lastConfig.height)) {
          console.log(
            `[WebCodecs] Resolution changed: ${encoder._lastConfig.width}x${encoder._lastConfig.height} -> ${fW}x${fH}`
          );
          encoder._lastConfig.width = fW;
          encoder._lastConfig.height = fH;
          try {
            encoder.configure(encoder._lastConfig);
          } catch (e) {
            console.error(e);
          }
          _wcForceKeyframe = true;
        }

        if (encoder.encodeQueueSize > _wcEncQueueMax) {
          // Encoder can't keep up (CPU-bound). Dropping an unencoded frame is
          // safe (no reference chain break), but count it separately — the
          // bitrate controller backs off and the operator gets a distinct
          // warning, since the real fix for CPU overload is lower
          // fps/resolution or another codec, not just less bitrate.
          _wcEncDropsThisTick++;
          frame.close();
        } else {
          const keyFrame = _wcForceKeyframe;
          if (keyFrame) _wcForceKeyframe = false;
          try {
            encoder.encode(frame, { keyFrame });
          } catch (e) {
            console.error('[WebCodecs] Encode frame error:', e);
          }
          frame.close();
        }
      }
    } catch (e) {
      console.log('[WebCodecs] Stream loop terminated.');
    }
  }
  processFrames();

  const _kfInterval = setInterval(() => {
    if (!_wcEncoder || _wcEncoder.state !== 'configured') {
      clearInterval(_kfInterval);
      return;
    }
    _wcForceKeyframe = true;
  }, 2000);

  // ── ADAPTIVE BITRATE ──────────────────────────────────────────────────────
  // The DataChannel/WS transports have no congestion control of their own
  // (unlike WebRTC's RTP path). Two signals, sampled every second:
  //   - transport bufferedAmount climbing = congestion building (early — no
  //     frames have been dropped yet, so reacting here is invisible)
  //   - gated/dropped frames = congestion already biting (late — the viewer
  //     saw a freeze)
  // Cut 30% on either. Probe +10% only after 5 clean seconds AND a
  // near-empty buffer, so probing backs off before it ever causes a visible
  // drop. Reconfigures are spaced ≥2s apart to avoid encoder churn.
  // Encoder-queue drops (CPU overload) also cut bitrate, but get their own
  // operator warning since the real fix there is lower fps/res or a
  // different codec.
  _wcSendDropsThisTick = 0;
  _wcEncDropsThisTick = 0;
  let _wcCleanTicks = 0;
  let _wcLastReconfigTs = 0;
  let _wcLastCongestionLogTs = 0;
  const _abrInterval = setInterval(() => {
    if (!_wcEncoder || _wcEncoder.state !== 'configured') {
      clearInterval(_abrInterval);
      return;
    }
    const sendDrops = _wcSendDropsThisTick;
    const encDrops = _wcEncDropsThisTick;
    _wcSendDropsThisTick = 0;
    _wcEncDropsThisTick = 0;
    const buffered = _wcMaxBufferedAmount();
    const congested = sendDrops > 0 || buffered > _WC_BUFFER_LIMIT / 2;
    const now = Date.now();

    let next = encoder._lastConfig.bitrate;
    if (congested || encDrops > 0) {
      _wcCleanTicks = 0;
      next = Math.max(1000000, Math.round(next * 0.7));
    } else if (++_wcCleanTicks >= 5 && next < _wcMaxBitrate && buffered < _WC_BUFFER_LIMIT / 16) {
      _wcCleanTicks = 0;
      next = Math.min(_wcMaxBitrate, Math.round(next * 1.1));
    }

    if (now - _wcLastCongestionLogTs > 10000) {
      if (encDrops > 0) {
        _wcLastCongestionLogTs = now;
        const m = `WebCodecs: encoder overloaded (${encDrops} frames/s dropped pre-encode) — CPU-bound, consider lower fps/resolution or another codec`;
        console.warn('[WebCodecs] ' + m);
        if (typeof log === 'function') log(m, 'warn');
      } else if (congested) {
        _wcLastCongestionLogTs = now;
        const m = `WebCodecs: link congested (${(buffered / 1024) | 0} KB buffered, ${sendDrops} drops/s) — bitrate → ${(next / 1e6).toFixed(1)} Mbps`;
        console.warn('[WebCodecs] ' + m);
        if (typeof log === 'function') log(m, 'warn');
      }
    }

    if (next !== encoder._lastConfig.bitrate && now - _wcLastReconfigTs >= 2000) {
      _wcLastReconfigTs = now;
      encoder._lastConfig.bitrate = next;
      try {
        encoder.configure(encoder._lastConfig);
        console.log(`[WebCodecs] Adaptive bitrate → ${(next / 1e6).toFixed(1)} Mbps`);
      } catch (e) {
        console.error('[WebCodecs] Bitrate reconfigure failed:', e);
      }
    }
  }, 1000);
}

// Worst per-transport backlog across everything video currently flows over —
// the bitrate controller's early congestion signal.
function _wcMaxBufferedAmount() {
  let max = 0;
  if (typeof _vpsWs !== 'undefined' && _vpsWs && _vpsWs.readyState === 1) {
    max = Math.max(max, _vpsWs.bufferedAmount || 0);
  }
  if (typeof ws !== 'undefined' && ws && ws.readyState === 1) {
    max = Math.max(max, ws.bufferedAmount || 0);
  }
  if (typeof peerConnections !== 'undefined') {
    for (const pc of Object.values(peerConnections)) {
      const ch = pc.wcChannel;
      if (ch && ch.readyState === 'open') max = Math.max(max, ch.bufferedAmount || 0);
    }
  }
  return max;
}

// ── SEND GATE (backpressure) ────────────────────────────────────────────────
// WebSockets and DataChannels buffer unboundedly; without checking
// bufferedAmount a congested link accumulates seconds of latency and then
// throws on send (silently losing whichever frame — often the keyframe).
// 512 KB is ~0.5s of video at the 8 Mbps ceiling: deep enough to absorb a
// burst keyframe, shallow enough to drop instead of building latency.
//
// Dropping a frame breaks the decode reference chain for that transport, so
// after any drop, deltas keep being dropped (_wcNeedsKey) until the next
// keyframe goes through — undecodable deltas would only waste bandwidth and
// trigger decoder-recovery round trips on the viewer.
const _WC_BUFFER_LIMIT = 512 * 1024;
let _wcSendDropsThisTick = 0;
let _wcEncDropsThisTick = 0;

// SCTP rejects messages larger than the REMOTE peer's advertised
// maxMessageSize — ~1GB on Firefox but 256KB on Chrome and 64KB on Safari.
// A keyframe at streaming bitrates easily exceeds both small limits, so
// sending frames as single messages makes send() throw on every keyframe
// for those browsers = permanently gated channel = audio but no video.
// Split anything bigger than 60KB (under every browser's floor) into tagged
// fragments; the channel is reliable+ordered so reassembly is trivial.
// Wire tags: byte0 2 = fragment, 3 = final fragment (0/1 = whole frame,
// unchanged legacy format). DC-only — the WS paths are TCP and unaffected.
const _WC_DC_CHUNK = 60 * 1024;

function _wcSendFragmented(channel, data) {
  const bytes = new Uint8Array(data);
  if (bytes.byteLength <= _WC_DC_CHUNK) {
    channel.send(data);
    return;
  }
  for (let off = 0; off < bytes.byteLength; off += _WC_DC_CHUNK) {
    const end = Math.min(off + _WC_DC_CHUNK, bytes.byteLength);
    const frag = new Uint8Array(1 + (end - off));
    frag[0] = end >= bytes.byteLength ? 3 : 2;
    frag.set(bytes.subarray(off, end), 1);
    channel.send(frag.buffer);
  }
}

function _wcGatedSend(transport, data, isKey, isDataChannel) {
  // Config strings are tiny and mandatory for decoder bootstrap — never gate.
  if (typeof data === 'string') {
    try {
      transport.send(data);
    } catch (_) {}
    return;
  }
  if (transport._wcNeedsKey && !isKey) {
    _wcSendDropsThisTick++;
    // The resync keyframe is deferred until the backlog has actually
    // drained — forcing one the instant the gate arms just wastes it into a
    // still-full buffer (at 120fps it's produced ~8ms later), leaving the
    // viewer frozen until the next 2s interval keyframe.
    if (transport.bufferedAmount < _WC_BUFFER_LIMIT / 4) _wcForceKeyframe = true;
    return;
  }
  if (transport.bufferedAmount > _WC_BUFFER_LIMIT) {
    transport._wcNeedsKey = true;
    _wcSendDropsThisTick++;
    return;
  }
  try {
    if (isDataChannel) {
      _wcSendFragmented(transport, data);
    } else {
      transport.send(data);
    }
    if (isKey) transport._wcNeedsKey = false;
  } catch (_) {
    transport._wcNeedsKey = true;
    _wcSendDropsThisTick++;
  }
}

function broadcastToViewers(data, isKey) {
  if (typeof peerConnections === 'undefined') return;

  // If VPS mode is active and authenticated, send to VPS instead of individual
  // DataChannels. (No P2P fallback on failure: VPS-mode viewers ignore
  // DataChannel video anyway, so resending there was dead weight — the viewer
  // keyframe-request path handles recovery.)
  if (_vpsWs && _vpsAuthOk && _vpsWs.readyState === 1) {
    _wcGatedSend(_vpsWs, data, isKey);
    return;
  }

  // Tunnel fallback: Send WebCodecs stream over standard signaling WS to the local Node.js server
  // This allows video to work perfectly over TCP-only tunnels like Zrok or Ngrok where WebRTC UDP fails.
  // Viewers with a working DataChannel ignore this WS copy (see viewer.js).
  if (ws && ws.readyState === 1) {
    _wcGatedSend(ws, data, isKey);
  }

  _broadcastP2P(data, isKey);
}

function _broadcastP2P(data, isKey) {
  Object.values(peerConnections).forEach((pc) => {
    const channel = pc.wcChannel;
    if (channel && channel.readyState === 'open') {
      _wcGatedSend(channel, data, isKey, true);
    }
  });
}

// ── Test-only export shim ──────────────────────────────────────────────────
// `module` does not exist in the browser, so this block is inert there and
// changes no runtime behavior. See REFACTOR_PLAN.md Phase 0 / Phase 5.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    startWebCodecsPipeline,
    startFFmpegCapture,
    startWebCodecsNetworkPipeline,
    broadcastToViewers,
    _broadcastP2P,
    _wcGatedSend,
    _wcSendFragmented,
  };
}
