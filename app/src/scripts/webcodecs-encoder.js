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

      broadcastToViewers(payload.buffer);
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
  const _wcCodecStr = _wcCodecMap[_wcCodecSel] || 'vp8';
  const wcConfig = {
    codec: _wcCodecStr,
    width: exactWidth,
    height: exactHeight,
    bitrate: 8000000,
    framerate: Math.round(settings.frameRate || 60),
    hardwareAcceleration: 'no-preference',
    latencyMode: 'realtime',
  };
  encoder.configure(wcConfig);
  encoder._lastConfig = wcConfig;
  console.log(`[WebCodecs] Encoder configured with codec: ${_wcCodecStr} (from UI: ${_wcCodecSel})`);

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

        if (encoder.encodeQueueSize > 2) {
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
}

function broadcastToViewers(data) {
  if (typeof peerConnections === 'undefined') return;

  // If VPS mode is active and authenticated, send to VPS instead of individual DataChannels
  if (_vpsWs && _vpsAuthOk && _vpsWs.readyState === 1) {
    try {
      _vpsWs.send(data);
    } catch (e) {
      console.warn('[VPS] Send failed, falling back to P2P:', e.message);
      _broadcastP2P(data);
    }
    return;
  }

  // Tunnel fallback: Send WebCodecs stream over standard signaling WS to the local Node.js server
  // This allows video to work perfectly over TCP-only tunnels like Zrok or Ngrok where WebRTC UDP fails.
  if (ws && ws.readyState === 1) {
    try {
      ws.send(data);
    } catch (_) {}
  }

  _broadcastP2P(data);
}

function _broadcastP2P(data) {
  Object.values(peerConnections).forEach((pc) => {
    const channel = pc.wcChannel;
    if (channel && channel.readyState === 'open') {
      try {
        channel.send(data);
      } catch (_) {}
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
  };
}
