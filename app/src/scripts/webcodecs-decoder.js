// ── WEBCODECS DECODER (viewer.js only) ──────────────────────────────────────
// Loaded via a <script> tag before viewer.js, same pattern as the other
// scripts/**/*.js modules. VideoDecoder + canvas/WebGL rendering
// (initWebCodecsViewer/_setupWebGL) plus the non-WebCodecs raw-frame canvas
// fallback (startFrameProcessor).
//
// State this reads/writes (wcDecoder/wcCanvas/wcCtx/wcGlTexture/
// USE_WEBCODECS/CUSTOM_WEBCODECS, and video/frameCanvas/frameCtx/
// processorRunning) stayed in viewer.js — it's also read/written by
// connect()'s WS message handler and several bootstrap listeners, so it's
// shared infrastructure like ws/pc, not this module's own state. See
// REFACTOR_PLAN.md Phase 5.10.

function _setupWebGL(gl) {
  const vs = gl.createShader(gl.VERTEX_SHADER);
  gl.shaderSource(vs, 'attribute vec2 p; attribute vec2 t; varying vec2 v; void main(){gl_Position=vec4(p,0,1);v=t;}');
  gl.compileShader(vs);
  const fs = gl.createShader(gl.FRAGMENT_SHADER);
  gl.shaderSource(
    fs,
    'precision mediump float; uniform sampler2D s; varying vec2 v; void main(){gl_FragColor=texture2D(s,v);}'
  );
  gl.compileShader(fs);
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.useProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 0, 1, 1, -1, 1, 1, -1, 1, 0, 0, 1, 1, 1, 0]),
    gl.STATIC_DRAW
  );
  const pLoc = gl.getAttribLocation(prog, 'p'),
    tLoc = gl.getAttribLocation(prog, 't');
  gl.enableVertexAttribArray(pLoc);
  gl.enableVertexAttribArray(tLoc);
  gl.vertexAttribPointer(pLoc, 2, gl.FLOAT, false, 16, 0);
  gl.vertexAttribPointer(tLoc, 2, gl.FLOAT, false, 16, 8);
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  return tex;
}

function startFrameProcessor(track) {
  if (!window.MediaStreamTrackProcessor) {
    if (!video.srcObject) video.srcObject = new MediaStream();
    video.srcObject.addTrack(track);
    video.onplaying = () => {
      showOverlay(false);
      setStatus('Live', true);
      document.getElementById('spinner').style.display = 'none';
      document.getElementById('gpPrompt').classList.add('gone');
      document.getElementById('kbmHint').style.display = 'inline';
      const overlay = document.getElementById('overlay');
      if (overlay) overlay.style.backgroundColor = '';
      if (typeof _swapOverlayEl !== 'undefined' && _swapOverlayEl) _swapOverlayEl.style.display = 'none';
    };
    return;
  }
  processorRunning = true;
  frameCanvas.style.display = 'block';
  video.style.opacity = '0';
  video.style.position = 'absolute';
  video.style.pointerEvents = 'none';
  const processor = new MediaStreamTrackProcessor({ track });
  const reader = processor.readable.getReader();
  let pending = null,
    firstFrame = true;
  (async () => {
    while (processorRunning) {
      let result;
      try {
        result = await reader.read();
      } catch {
        break;
      }
      if (result.done) break;
      if (pending) pending.close();
      pending = result.value;
    }
  })();
  (function renderLoop() {
    if (!processorRunning) return;
    requestAnimationFrame(renderLoop);
    if (!pending) return;
    if (frameCanvas.width !== pending.displayWidth || frameCanvas.height !== pending.displayHeight) {
      frameCanvas.width = pending.displayWidth;
      frameCanvas.height = pending.displayHeight;
    }
    frameCtx.drawImage(pending, 0, 0);
    pending.close();
    pending = null;
    if (firstFrame) {
      firstFrame = false;
      showOverlay(false);
      setStatus('Live', true);
      document.getElementById('spinner').style.display = 'none';
      document.getElementById('gpPrompt').classList.add('gone');
      document.getElementById('kbmHint').style.display = 'inline';
      const overlay = document.getElementById('overlay');
      if (overlay) overlay.style.backgroundColor = '';
      if (typeof _swapOverlayEl !== 'undefined' && _swapOverlayEl) _swapOverlayEl.style.display = 'none';
    }
  })();
  track.addEventListener('ended', () => {
    processorRunning = false;
    frameCanvas.style.display = 'none';
    video.style.opacity = '1';
    video.style.position = 'static';
    video.style.pointerEvents = 'auto';
  });
}

function initWebCodecsViewer(config) {
  console.log('[WebCodecs] Received Host Configuration:', config);

  // Cache for recoverWebCodecsDecoder() (viewer.js) so a fatal decoder error
  // can rebuild immediately instead of stalling on a host config round trip.
  window._wcLastConfigMsg = config;

  const videoEl = document.getElementById('video');
  if (videoEl) videoEl.style.display = 'none';
  const frameCanvas = document.getElementById('frameCanvas');
  if (frameCanvas) frameCanvas.style.display = 'none';

  if (typeof showOverlay === 'function') showOverlay(false);
  const spinner = document.getElementById('spinner');
  if (spinner) spinner.style.display = 'none';

  if (!wcCanvas) {
    wcCanvas = document.createElement('canvas');
    wcCanvas.id = 'webcodecs-canvas';
    // Add CSS so the stream scales to fit the viewport instead of overflowing
    wcCanvas.style.cssText =
      'width: 100%; height: 100%; max-width: 100vw; max-height: 100vh; object-fit: contain; position: absolute; top: 0; left: 0; z-index: 10; display: block; overflow: hidden;';
    document.getElementById('video-container')?.appendChild(wcCanvas) ?? document.body.appendChild(wcCanvas);

    if (CUSTOM_WEBCODECS) {
      wcCtx = wcCanvas.getContext('webgl2', {
        alpha: false,
        antialias: false,
        depth: false,
        preserveDrawingBuffer: true,
      });
      if (!wcCtx)
        wcCtx = wcCanvas.getContext('webgl', {
          alpha: false,
          antialias: false,
          depth: false,
          preserveDrawingBuffer: true,
        });
    } else {
      wcCtx = null;
    }

    if (wcCtx) {
      wcGlTexture = _setupWebGL(wcCtx);
    } else {
      wcCtx = wcCanvas.getContext('2d', { alpha: false });
      wcGlTexture = null;
    }

    // Ensure KBM pointer lock works on the experimental WebCodecs canvas
    if (typeof requestPointerLock === 'function') {
      wcCanvas.addEventListener('click', requestPointerLock);
    }

    wcCanvas.style.display = 'block';
  } else {
    wcCanvas.style.display = 'block';
  }

  if (window._wcResizeHandler) {
    window.removeEventListener('resize', window._wcResizeHandler);
  }

  // JS Containment rule to forcefully prevent 4K frame overflows
  window._wcResizeHandler = () => {
    if (wcCanvas) {
      wcCanvas.style.maxWidth = window.innerWidth + 'px';
      wcCanvas.style.maxHeight = window.innerHeight + 'px';
    }
  };
  window.addEventListener('resize', window._wcResizeHandler);
  window._wcResizeHandler();

  if (!wcCtx) {
    if (CUSTOM_WEBCODECS) {
      wcCtx = wcCanvas.getContext('webgl2', {
        alpha: false,
        antialias: false,
        depth: false,
        preserveDrawingBuffer: true,
      });
      if (!wcCtx)
        wcCtx = wcCanvas.getContext('webgl', {
          alpha: false,
          antialias: false,
          depth: false,
          preserveDrawingBuffer: true,
        });
    }
    if (wcCtx) {
      wcGlTexture = _setupWebGL(wcCtx);
    } else {
      wcCtx = wcCanvas.getContext('2d', { alpha: false });
      wcGlTexture = null;
    }
  }

  // Clean up any existing decoder before creating a new one.
  // Leaving the old instance open causes "Decoder already closed" exceptions
  // and zombie contexts when the host restarts their stream.
  if (wcDecoder) {
    try {
      if (wcDecoder.state !== 'closed') wcDecoder.close();
    } catch (_) {}
    wcDecoder = null;
  }

  // Reset the global keyframe gate so the new decoder waits for a clean
  // keyframe before attempting to decode any delta frames.
  window.nsWaitKey = true;

  let _wcFirstFrame = true;

  wcDecoder = new VideoDecoder({
    output: (frame) => {
      // BUG 2/5 FIX: Use hardware codedWidth, and re-acquire the context after resize!
      if (wcCanvas.width !== frame.codedWidth || wcCanvas.height !== frame.codedHeight) {
        wcCanvas.width = frame.codedWidth;
        wcCanvas.height = frame.codedHeight;
        if (wcCtx && wcGlTexture) wcCtx.viewport(0, 0, wcCanvas.width, wcCanvas.height);
      }
      if (wcCtx && wcGlTexture) {
        wcCtx.activeTexture(wcCtx.TEXTURE0);
        wcCtx.bindTexture(wcCtx.TEXTURE_2D, wcGlTexture);
        wcCtx.texImage2D(wcCtx.TEXTURE_2D, 0, wcCtx.RGBA, wcCtx.RGBA, wcCtx.UNSIGNED_BYTE, frame);
        wcCtx.drawArrays(wcCtx.TRIANGLE_STRIP, 0, 4);
      } else if (wcCtx) {
        wcCtx.drawImage(frame, 0, 0, wcCanvas.width, wcCanvas.height);
      }
      frame.close();

      if (_wcFirstFrame) {
        _wcFirstFrame = false;
        if (typeof showOverlay === 'function') showOverlay(false);
        if (typeof setStatus === 'function') setStatus('Live', true);
        if (spinner) spinner.style.display = 'none';
        if (typeof _swapOverlayEl !== 'undefined' && _swapOverlayEl) {
          _swapOverlayEl.style.display = 'none';
        }
        const overlay = document.getElementById('overlay');
        if (overlay) overlay.style.backgroundColor = '';
      }
    },
    error: (e) => {
      console.error('[WebCodecs] Decoder Error:', e);
      recoverWebCodecsDecoder();
    },
  });

  const decoderConfig = {
    codec: config.codec,
    codedWidth: config.codedWidth,
    codedHeight: config.codedHeight,
    optimizeForLatency: true,
  };

  if (config.description) decoderConfig.description = new Uint8Array(config.description);
  try {
    wcDecoder.configure(decoderConfig);
  } catch (_) {
    delete decoderConfig.optimizeForLatency;
    wcDecoder.configure(decoderConfig);
  }
  // The exact config that stuck — used by recoverWebCodecsDecoder()'s cheap
  // reset-in-place path.
  window._wcActiveDecoderConfig = decoderConfig;
  console.log('[WebCodecs] Hardware Decoder Ready!');
}

// ── Test-only export shim ──────────────────────────────────────────────────
// `module` does not exist in the browser, so this block is inert there and
// changes no runtime behavior. See REFACTOR_PLAN.md Phase 0 / Phase 5.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { _setupWebGL, startFrameProcessor, initWebCodecsViewer };
}
