// ── GAMEPAD / INPUT (viewer.js only) ────────────────────────────────────────
// Loaded via a <script> tag before viewer.js, same pattern as the other
// scripts/**/*.js modules. The single largest undocumented concern in
// viewer.js, not named anywhere in the original Phase 5 checklist: keyboard/
// mouse/stylus dispatch, touch + dual-joystick controls, WebHID gyro,
// per-gamepad calibration, eye-tracking mode, the core pollGamepad()
// per-tick dispatcher, and WebXR (VR) controller input polling.
//
// Physically three non-contiguous ranges in the original file — the main
// keymap-through-pollGamepad block, the small calibration-saver message
// listener, and the WebXR section — reassembled here as one module, same
// mechanical `sed`-range relocation discipline as the rest of Phase 5.
// See REFACTOR_PLAN.md Phase 5.10.

// ── INPUT ─────────────────────────────────────────────────────────────────────
const keyMap = {
  KeyW: 'KEY_W',
  KeyA: 'KEY_A',
  KeyS: 'KEY_S',
  KeyD: 'KEY_D',
  ArrowUp: 'KEY_UP',
  ArrowDown: 'KEY_DOWN',
  ArrowLeft: 'KEY_LEFT',
  ArrowRight: 'KEY_RIGHT',
  Space: 'KEY_SPACE',
  Enter: 'KEY_ENTER',
  Escape: 'KEY_ESC',
  ShiftLeft: 'KEY_LEFTSHIFT',
  ControlLeft: 'KEY_LEFTCTRL',
  Tab: 'KEY_TAB',
  KeyQ: 'KEY_Q',
  KeyE: 'KEY_E',
  KeyR: 'KEY_R',
  KeyF: 'KEY_F',
  KeyC: 'KEY_C',
  KeyZ: 'KEY_Z',
  KeyX: 'KEY_X',
  KeyV: 'KEY_V',
  KeyB: 'KEY_B',
  Digit1: 'KEY_1',
  Digit2: 'KEY_2',
  // ── NEW FULL ALPHABET & NUMBERS ──
  KeyT: 'KEY_T',
  KeyY: 'KEY_Y',
  KeyU: 'KEY_U',
  KeyI: 'KEY_I',
  KeyO: 'KEY_O',
  KeyP: 'KEY_P',
  KeyG: 'KEY_G',
  KeyH: 'KEY_H',
  KeyJ: 'KEY_J',
  KeyK: 'KEY_K',
  KeyL: 'KEY_L',
  KeyM: 'KEY_M',
  KeyN: 'KEY_N',
  Digit3: 'KEY_3',
  Digit4: 'KEY_4',
  Digit5: 'KEY_5',
  Digit6: 'KEY_6',
  Digit7: 'KEY_7',
  Digit8: 'KEY_8',
  Digit9: 'KEY_9',
  Digit0: 'KEY_0',
  Minus: 'KEY_MINUS',
  Equal: 'KEY_EQUAL',
  Backspace: 'KEY_BACKSPACE',
  BracketLeft: 'KEY_LEFTBRACE',
  BracketRight: 'KEY_RIGHTBRACE',
  Backslash: 'KEY_BACKSLASH',
  Semicolon: 'KEY_SEMICOLON',
  Quote: 'KEY_APOSTROPHE',
  Comma: 'KEY_COMMA',
  Period: 'KEY_DOT',
  Slash: 'KEY_SLASH',
  AltLeft: 'KEY_LEFTALT',
  Capslock: 'KEY_CAPSLOCK',
};
const mouseMap = { 0: 'BTN_LEFT', 1: 'BTN_MIDDLE', 2: 'BTN_RIGHT' };

// ── Fast-Lane Input Dispatcher ────────────────────────────────────────────────
// Tries WebRTC DataChannel first (zero-latency), falls back to inputWs, then ws.
// Every object message gets a latency stamp: _lt (viewer clock, ms) and _lp
// (which transport actually carried it) — the server diffs _lt against its
// clock-sync offset to log one-way input latency per transport. See
// server/input-latency-log.js for the sync protocol.
function sendInputData(data) {
  const stampable = typeof data !== 'string';
  const ser = (lp) => {
    if (!stampable) return data;
    data._lt = Date.now();
    data._lp = lp;
    return JSON.stringify(data);
  };

  // 1. WebTransport Unreliable Datagrams (VPS Fast Lane)
  if (window.wtInputWriter) {
    try {
      window.wtInputWriter.write(new TextEncoder().encode(ser('wt')));
      return;
    } catch (_) {}
  }

  // 2. WebRTC DataChannel (P2P Fast Lane)
  if (window._fastLaneChannel && window._fastLaneChannel.readyState === 'open') {
    try {
      window._fastLaneChannel.send(ser('dc'));
      return;
    } catch (_) {}
  }
  if (inputWs && inputWs.readyState === 1) {
    inputWs.send(ser('wsi'));
    return;
  }
  if (ws && ws.readyState === 1) {
    ws.send(ser('ws'));
  }
}

function sendKbm(data) {
  if (document.pointerLockElement) {
    data.type = 'keyboard';
    data.viewerId = myId;
    data.pad_id = myId + '_0';
    sendInputData(data);
  }
}
function requestPointerLock() {
  if (!kbEnabled) return;
  if (!document.pointerLockElement) {
    const c = document.getElementById('video-container') || document.body;
    // FIX: Make it safe for Firefox (which doesn't return a Promise)
    const promise = c.requestPointerLock();
    if (promise && typeof promise.catch === 'function') {
      promise.catch(() => {});
    }
  }
}

document.addEventListener('click', (e) => {
  if (
    e.target === frameCanvas ||
    e.target === video ||
    e.target.id === 'webcodecs-canvas' || // Add this check!
    e.target.closest('#video-container')
  ) {
    requestPointerLock();
  }
});
document.addEventListener('click', (e) => {
  if (e.target === frameCanvas || e.target === video || (typeof wcCanvas !== 'undefined' && e.target === wcCanvas))
    requestPointerLock();
});
document.addEventListener('keydown', (e) => {
  if (!document.pointerLockElement) return;
  if (keyMap[e.code]) {
    e.preventDefault();
    sendKbm({ event: 'keydown', key: keyMap[e.code] });
  }
});
document.addEventListener('keyup', (e) => {
  if (!document.pointerLockElement) return;
  if (keyMap[e.code]) {
    e.preventDefault();
    sendKbm({ event: 'keyup', key: keyMap[e.code] });
  }
});
document.addEventListener('mousemove', (e) => {
  if (!document.pointerLockElement) return;
  sendKbm({ event: 'mousemove', dx: e.movementX, dy: e.movementY });
});
document.addEventListener('mousedown', (e) => {
  if (!document.pointerLockElement) return;
  if (mouseMap[e.button]) sendKbm({ event: 'keydown', key: mouseMap[e.button] });
});
document.addEventListener('mouseup', (e) => {
  if (!document.pointerLockElement) return;
  if (mouseMap[e.button]) sendKbm({ event: 'keyup', key: mouseMap[e.button] });
});

// ── EXPERIMENTAL TABLET SUPPORT ───────────────────────────────────────────────
function handleTabletEvent(e) {
  if (e.pointerType !== 'pen') return;

  let targetEl =
    typeof wcCanvas !== 'undefined' && wcCanvas.style.display !== 'none'
      ? wcCanvas
      : typeof video !== 'undefined' && video.style.display !== 'none'
        ? video
        : typeof frameCanvas !== 'undefined'
          ? frameCanvas
          : null;

  if (!targetEl) return;
  const bounds = targetEl.getBoundingClientRect();

  // Normalize coordinates (0.0 to 1.0) relative to the video frame
  const nx = (e.clientX - bounds.left) / bounds.width;
  const ny = (e.clientY - bounds.top) / bounds.height;

  // Clamp so the pen doesn't draw way off screen
  if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return;

  e.preventDefault(); // Stop standard mouse click emulation
  sendInputData(
    JSON.stringify({
      type: 'tablet',
      x: nx,
      y: ny,
      pressure: e.pressure,
      tiltX: e.tiltX || 0,
      tiltY: e.tiltY || 0,
    })
  );
}
// Use passive: false so we can e.preventDefault() to stop normal mouse panning
document.addEventListener('pointerdown', handleTabletEvent, { passive: false });
document.addEventListener('pointermove', handleTabletEvent, { passive: false });
document.addEventListener('pointerup', handleTabletEvent, { passive: false });

// ── TOUCH ─────────────────────────────────────────────────────────────────────
let touchMode = false,
  useGyro = false;
const touchState = {
  axes: [0, 0, 0, 0],
  buttons: new Array(17).fill(0).map(() => ({ pressed: false, value: 0 })),
};

function toggleTouch() {
  touchMode = !touchMode;
  document.getElementById('touchUI').classList.toggle('gone', !touchMode);
  const btn = document.getElementById('touchToggleBtn');
  if (btn) {
    btn.classList.toggle('ns-btn-active', touchMode);
    btn.textContent = touchMode ? 'Touch UI: ON' : 'Touch UI: OFF';
  }
  document.getElementById('nsBar').classList.remove('open');
}

const isMobileDevice = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
if (isMobileDevice) {
  touchMode = true;
  document.addEventListener('DOMContentLoaded', () => {
    const tUI = document.getElementById('touchUI');
    const tBtn = document.getElementById('touchToggleBtn');
    if (tUI) tUI.classList.remove('gone');
    if (tBtn) {
      tBtn.classList.add('ns-btn-active');
      tBtn.textContent = 'Touch UI: ON';
    }
  });
}

async function toggleGyro() {
  if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
    try {
      const s = await DeviceOrientationEvent.requestPermission();
      if (s === 'granted') useGyro = !useGyro;
    } catch (e) {}
  } else {
    useGyro = !useGyro;
  }
  const btn = document.getElementById('gyroToggleBtn');
  if (btn) {
    btn.textContent = 'Aim Gyro: ' + (useGyro ? 'ON' : 'OFF');
    btn.classList.toggle('ns-btn-active', useGyro);
  }
  if (!useGyro) {
    touchState.axes[2] = 0;
    touchState.axes[3] = 0;
  }
}

window.addEventListener('deviceorientation', (e) => {
  if (!useGyro || !touchMode) return;
  touchState.axes[2] = Math.max(-1, Math.min(1, e.gamma / 45.0));
  touchState.axes[3] = Math.max(-1, Math.min(1, (e.beta - 45) / 45.0));
});

document.querySelectorAll('[data-btn]').forEach((el) => {
  el.addEventListener(
    'touchstart',
    (e) => {
      e.preventDefault();
      touchState.buttons[el.dataset.btn].pressed = true;
      touchState.buttons[el.dataset.btn].value = 1;
      el.style.transform = 'scale(0.92)';
      el.style.backgroundColor = 'rgba(139, 92, 246, 0.4)';
    },
    { passive: false }
  );

  const release = (e) => {
    e.preventDefault();
    touchState.buttons[el.dataset.btn].pressed = false;
    touchState.buttons[el.dataset.btn].value = 0;
    el.style.transform = '';
    el.style.backgroundColor = '';
  };

  el.addEventListener('touchend', release, { passive: false });
  el.addEventListener('touchcancel', release, { passive: false });
});

const jBase = document.getElementById('jBase');
const jStick = document.getElementById('jStick');
let jBaseRect = null;
function updateStick(touch) {
  if (!jBaseRect) return;
  const cx = jBaseRect.left + jBaseRect.width / 2,
    cy = jBaseRect.top + jBaseRect.height / 2,
    max = jBaseRect.width / 2;
  let dx = touch.clientX - cx,
    dy = touch.clientY - cy;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist > max) {
    dx = (dx / dist) * max;
    dy = (dy / dist) * max;
  }
  jStick.style.transform = `translate(${dx}px,${dy}px)`;
  touchState.axes[0] = dx / max;
  touchState.axes[1] = dy / max;
}
if (jBase) {
  jBase.addEventListener(
    'touchstart',
    (e) => {
      e.preventDefault();
      jBaseRect = jBase.getBoundingClientRect();
      updateStick(e.touches[0]);
    },
    { passive: false }
  );
  jBase.addEventListener(
    'touchmove',
    (e) => {
      e.preventDefault();
      updateStick(e.touches[0]);
    },
    { passive: false }
  );
  jBase.addEventListener(
    'touchend',
    (e) => {
      e.preventDefault();
      jStick.style.transform = 'translate(0px,0px)';
      touchState.axes[0] = 0;
      touchState.axes[1] = 0;
    },
    { passive: false }
  );
}

const jBaseRight = document.getElementById('jBaseRight');
const jStickRight = document.getElementById('jStickRight');
let jBaseRightRect = null;
function updateStickRight(touch) {
  if (!jBaseRightRect) return;
  const cx = jBaseRightRect.left + jBaseRightRect.width / 2,
    cy = jBaseRightRect.top + jBaseRightRect.height / 2,
    max = jBaseRightRect.width / 2;
  let dx = touch.clientX - cx,
    dy = touch.clientY - cy;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist > max) {
    dx = (dx / dist) * max;
    dy = (dy / dist) * max;
  }
  jStickRight.style.transform = `translate(${dx}px,${dy}px)`;
  touchState.axes[2] = dx / max;
  touchState.axes[3] = dy / max;
}
if (jBaseRight) {
  jBaseRight.addEventListener(
    'touchstart',
    (e) => {
      e.preventDefault();
      jBaseRightRect = jBaseRight.getBoundingClientRect();
      updateStickRight(e.touches[0]);
    },
    { passive: false }
  );
  jBaseRight.addEventListener(
    'touchmove',
    (e) => {
      e.preventDefault();
      updateStickRight(e.touches[0]);
    },
    { passive: false }
  );
  jBaseRight.addEventListener(
    'touchend',
    (e) => {
      e.preventDefault();
      jStickRight.style.transform = 'translate(0px,0px)';
      touchState.axes[2] = 0;
      touchState.axes[3] = 0;
    },
    { passive: false }
  );
}

// Removed redundant dpad-btn listener block since it's handled by data-btn above

// ── HID GYRO ──────────────────────────────────────────────────────────────────
let hidDevice = null,
  hostMotionEnabled = false,
  hidGyroX = 0,
  hidGyroY = 0;
async function requestHID() {
  if (!('hid' in navigator)) {
    alert('WebHID not supported. Use Chrome/Edge.');
    return;
  }
  try {
    const devices = await navigator.hid.requestDevice({ filters: [{ vendorId: 0x054c }, { vendorId: 0x057e }] });
    if (devices.length > 0) {
      hidDevice = devices[0];
      await hidDevice.open();
      hidDevice.addEventListener('inputreport', handleHIDReport);
      const btn = document.getElementById('hidBtn');
      if (btn) {
        btn.classList.add('ns-btn-active');
        btn.textContent = 'Gyro HID: ON';
      }
    }
  } catch (err) {
    console.error('HID failed:', err);
  }
}
function handleHIDReport(event) {
  const { data, reportId } = event;
  const vid = hidDevice.vendorId;
  if (vid === 0x054c) {
    const isDualSense = hidDevice.productName.toLowerCase().includes('dualsense') || hidDevice.productId === 0x0ce6;
    let off = 0;
    if (reportId === 0x01) off = isDualSense ? 16 : 13;
    else if (reportId === 0x11 || reportId === 0x31) off = isDualSense ? 15 : 14;
    else return;
    if (data.byteLength < off + 4) return;
    hidGyroX = data.getInt16(off + 2, true) / 15000.0;
    hidGyroY = data.getInt16(off, true) / 15000.0;
  } else if (vid === 0x057e) {
    if (reportId !== 0x30 || data.byteLength < 25) return;
    hidGyroX = data.getInt16(21, true) / 30000.0;
    hidGyroY = data.getInt16(19, true) / 30000.0;
  }
}

// ── CALIBRATION ───────────────────────────────────────────────────────────────
const calibMaps = {};
(function loadSavedCalibMaps() {
  const PREFIX = 'nearsec_map_';
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(PREFIX)) {
      try {
        calibMaps[k.slice(PREFIX.length)] = JSON.parse(localStorage.getItem(k));
      } catch {}
    }
  }
})();
window.addEventListener('message', (e) => {
  if (e.data?.type === 'NEARSEC_CONFIG_UPDATE' && e.data.hardwareId) calibMaps[e.data.hardwareId] = e.data.map;
  if (e.data?.type === 'NEARSEC_SMART_DB' && e.data.db) {
    smartDb = e.data.db;
    window.smartDb = smartDb;
  }
  if (e.data?.type === 'NEARSEC_DEADZONE') {
    gpDeadzones[e.data.index] = e.data.value;
  }
});

function getSafeGamepadId(gp) {
  return gp.id.replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 60);
}

function lookupCalibMap(gp) {
  const safeId = getSafeGamepadId(gp);
  if (calibMaps[safeId]) return calibMaps[safeId];
  if (smartDb[gp.id]) return smartDb[gp.id];
  if (smartDb[safeId]) return smartDb[safeId];
  for (const [key, map] of Object.entries(smartDb)) {
    const keyPrefix = key.split('(')[0].trim().toLowerCase();
    const idPrefix = gp.id.split('(')[0].trim().toLowerCase();
    if (keyPrefix && idPrefix && (gp.id.includes(key) || key.includes(gp.id) || keyPrefix === idPrefix)) return map;
  }
  return null;
}

function applyCalibration(gp, state) {
  const safeId = getSafeGamepadId(gp);
  const m = lookupCalibMap(gp);
  if (!m) return;
  calibMaps[safeId] = m;
  const readStick = (mp) => {
    if (mp == null) return null;
    if (typeof mp === 'number') return gp.axes[mp] || 0;
    if (mp.type === 'btn') {
      const v = gp.buttons[mp.idx]?.value || 0;
      return (v - 0.5) * 2; // Remap 0.0-1.0 to -1.0-1.0 (center is 0.5)
    }
    return gp.axes[mp.idx] || 0;
  };
  const rx = readStick(m.rsx);
  const ry = readStick(m.rsy);
  if (rx !== null) state.axes[2] = Math.round(rx * 32767);
  if (ry !== null) state.axes[3] = Math.round(ry * 32767);
  function readTrigger(mp) {
    if (!mp) return 0;
    if (mp.type === 'btn') return Math.round((gp.buttons[mp.idx]?.value || 0) * 255);
    const raw = gp.axes[mp.idx] ?? -1;
    const norm = Math.max(0, (raw + 1) / 2);
    return norm < 0.05 ? 0 : Math.round(norm * 255);
  }
  const lt = readTrigger(m.lt),
    rt = readTrigger(m.rt);
  if (lt > 0 || m.lt) state.buttons[6] = { pressed: lt > 10, value: lt };
  if (rt > 0 || m.rt) state.buttons[7] = { pressed: rt > 10, value: rt };
}

// ── GAMEPAD POLLING ───────────────────────────────────────────────────────────
let gpPolling = false,
  lastGpSend = {},
  lastGpStr = {};
let gpCache = {},
  gpStateObj = {};
let gpDeadzones = {};
let sentGpid = new Set();

function activateGamepad() {
  if (gpPolling) return;
  gpPolling = true;
  const pmt = document.getElementById('gpPrompt');
  if (pmt) {
    pmt.classList.add('active');
    pmt.textContent = 'Grab A Gamepad!';
  }
  // 1ms interval (1000 Hz) for maximum competitive precision / lowest input latency
  setInterval(pollGamepad, 1);
}

let knownNativePads = [];
if (window.electronAPI && window.electronAPI.onNativeGamepadEvent) {
  window.electronAPI.onNativeGamepadEvent((msg) => {
    if (!gpPolling) activateGamepad();
    if (msg.type === 'gamepad_connected') {
      document.getElementById('gpPrompt')?.classList.add('gone');
      const pInfo = {
        padIndex: msg.index + 100,
        id: msg.id || 'Native Controller',
        name: msg.name || 'Native Controller',
      };
      knownNativePads.push(pInfo);
      if (ws?.readyState === 1) {
        ws.send(JSON.stringify(Object.assign({ type: 'gpid' }, pInfo)));
      }
      maybeShowControllerGuide();
    } else if (msg.type === 'gamepad_state') {
      const vIndex = msg.index + 100;
      const state = {
        type: 'gamepad',
        viewerId: myId,
        pad_id: myId + '_' + vIndex,
        padIndex: vIndex,
        axes: msg.state.axes,
        buttons: msg.state.buttons,
      };
      const str = JSON.stringify(state);
      const now = Date.now();
      const forceHb = now - (lastGpSend[vIndex] || 0) > 100;
      if (str !== lastGpStr[vIndex] || forceHb) {
        lastGpStr[vIndex] = str;
        lastGpSend[vIndex] = now;
        sendInputData(str);
      }
    }
  });
  window.electronAPI.startNativeGamepadCapture();
}

window.currentInputMode = 'gamepad';
let eyeTrackerCam = null;
let eyeTrackerFaceMesh = null;

window.updateInputMode = function (val) {
  window.currentInputMode = val;
  console.log('[InputMode] Switched to:', val);

  if (val === 'eyetracking') {
    startEyeTracking();
  } else {
    stopEyeTracking();
  }
};

function startEyeTracking() {
  if (eyeTrackerCam) return;
  console.log('[EyeTrack] Starting MediaPipe FaceMesh...');

  const videoElement = document.createElement('video');
  videoElement.style.display = 'none';
  videoElement.setAttribute('autoplay', '');
  videoElement.setAttribute('playsinline', '');
  document.body.appendChild(videoElement);

  if (typeof FaceMesh === 'undefined') {
    alert('FaceMesh library is not loaded. Ensure you have an internet connection.');
    return;
  }

  eyeTrackerFaceMesh = new FaceMesh({
    locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`,
  });

  eyeTrackerFaceMesh.setOptions({
    maxNumFaces: 1,
    refineLandmarks: false,
    minDetectionConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });

  eyeTrackerFaceMesh.onResults(onFaceMeshResults);

  eyeTrackerCam = new Camera(videoElement, {
    onFrame: async () => {
      if (eyeTrackerFaceMesh) {
        await eyeTrackerFaceMesh.send({ image: videoElement });
      }
    },
    width: 640,
    height: 480,
  });
  eyeTrackerCam.start();
  eyeTrackerCam.videoElement = videoElement;
}

function stopEyeTracking() {
  if (eyeTrackerCam) {
    console.log('[EyeTrack] Stopping MediaPipe FaceMesh...');
    eyeTrackerCam.stop();
    if (eyeTrackerCam.videoElement) {
      eyeTrackerCam.videoElement.srcObject?.getTracks().forEach((t) => t.stop());
      eyeTrackerCam.videoElement.remove();
    }
    eyeTrackerCam = null;
  }
  if (eyeTrackerFaceMesh) {
    eyeTrackerFaceMesh.close();
    eyeTrackerFaceMesh = null;
  }
}

function onFaceMeshResults(results) {
  if (!results.multiFaceLandmarks || results.multiFaceLandmarks.length === 0) return;

  const landmarks = results.multiFaceLandmarks[0];
  const nose = landmarks[1];
  const leftEye = landmarks[33];
  const rightEye = landmarks[263];
  const chin = landmarks[152];

  const px = (nose.x - 0.5) * 200;
  const py = (nose.y - 0.5) * 200;
  const pz = nose.z * -1000;

  const yaw = Math.atan2(rightEye.z - leftEye.z, rightEye.x - leftEye.x) * (180 / Math.PI);
  const pitch = Math.atan2(chin.z - nose.z, chin.y - nose.y) * (180 / Math.PI) - 15;
  const roll = Math.atan2(rightEye.y - leftEye.y, rightEye.x - leftEye.x) * (180 / Math.PI);

  const eyeState = {
    type: 'eyetracking',
    viewerId: myId,
    x: px,
    y: py,
    z: pz,
    yaw: yaw,
    pitch: pitch,
    roll: roll,
  };

  sendInputData(JSON.stringify(eyeState));
}

function pollGamepad() {
  if (!gpPolling) return;
  let pads = navigator.getGamepads ? navigator.getGamepads() : [];

  // If native Python backends are supplying inputs, ignore browser Gamepad API to prevent ghost inputs
  if (knownNativePads.length > 0) pads = [];

  const now = Date.now();

  // 1. Find the best device (Standard Gamepad > Any Gamepad > Touch)
  let bestGp = null;
  let isTouch = false;
  for (const gp of pads) {
    if (!gp || !gp.connected) continue;
    if (gp.mapping === 'standard') {
      bestGp = gp;
      break;
    }
    if (!bestGp) bestGp = gp;
  }
  if (!bestGp && touchMode) isTouch = true;

  if (!bestGp && !isTouch) return; // No inputs available

  const vIndex = 0; // Force ALL inputs from this viewer to slot 0

  // 2. Announce GPID if changed
  let activeId = isTouch ? 'virtual-touch' : bestGp.id;
  let activeName = isTouch
    ? 'Mobile Touch Controls'
    : bestGp.id
        .replace(/^[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-/, '')
        .replace(/\(.*?\)/g, '')
        .replace(/[^a-zA-Z0-9 -]/g, '')
        .trim() || 'Standard Controller';

  if (gpStateObj.lastActiveId !== activeId) {
    gpStateObj.lastActiveId = activeId;
    if (ws?.readyState === 1)
      ws.send(JSON.stringify({ type: 'gpid', padIndex: vIndex, id: activeId, name: activeName }));
  }

  let cache = gpCache[vIndex];
  let state = gpStateObj[vIndex];
  if (!cache) {
    cache = { axes: new Int32Array(4), btns: new Int32Array(16) };
    gpCache[vIndex] = cache;
    state = {
      type: 'gamepad',
      viewerId: myId,
      pad_id: myId + '_' + vIndex,
      padIndex: vIndex,
      axes: [0, 0, 0, 0],
      buttons: Array.from({ length: 16 }, () => ({ pressed: false, value: 0 })),
    };
    gpStateObj[vIndex] = state;
  }
  state.viewerId = myId;
  state.pad_id = myId + '_' + vIndex;

  let changed = false;

  if (!isTouch && bestGp) {
    let dz = gpDeadzones[bestGp.index] !== undefined ? gpDeadzones[bestGp.index] : 0.05;
    for (let i = 0; i < 4; i++) {
      let val = bestGp.axes[i] || 0;
      if (Math.abs(val) < dz) val = 0;
      else val = Math.sign(val) * ((Math.abs(val) - dz) / (1 - dz));

      let finalVal = Math.round(val * 32767);
      // Micro-jitter filter: ignore axis changes smaller than 32/32767 (~0.09%)
      // This is sub-pixel level, preserving exact angles for Smash Bros while stopping resting tremor spam.
      if (Math.abs(cache.axes[i] - finalVal) > 32) {
        changed = true;
        cache.axes[i] = finalVal;
      }
      state.axes[i] = cache.axes[i];
    }
    for (let i = 0; i < 16; i++) {
      const b = bestGp.buttons[i];
      const v = Math.round((b?.value || 0) * 255);
      state.buttons[i].value = v;
      state.buttons[i].pressed = b?.pressed || false;
      if (cache.btns[i] !== v) {
        changed = true;
        cache.btns[i] = v;
      }
    }
    applyCalibration(bestGp, state);
  } else if (isTouch) {
    for (let i = 0; i < 4; i++) {
      state.axes[i] = Math.round((touchState.axes[i] || 0) * 32767);
      if (cache.axes[i] !== state.axes[i]) {
        changed = true;
        cache.axes[i] = state.axes[i];
      }
    }
    for (let i = 0; i < 16; i++) {
      const b = touchState.buttons[i];
      const v = Math.round((b?.value || 0) * 255);
      state.buttons[i].value = v;
      state.buttons[i].pressed = b?.pressed || false;
      if (cache.btns[i] !== v) {
        changed = true;
        cache.btns[i] = v;
      }
    }
  }

  if (hidDevice && hostMotionEnabled) {
    state.axes[2] = Math.max(-32767, Math.min(32767, state.axes[2] + Math.round(hidGyroX * 32767)));
    state.axes[3] = Math.max(-32767, Math.min(32767, state.axes[3] + Math.round(hidGyroY * 32767)));
    changed = true; // Gyro is continuously sending
  }

  if (window.currentInputMode === 'guitar') {
    const guitarState = {
      type: 'guitar',
      viewerId: myId,
      pad_id: myId + '_' + vIndex,
      frets: [
        state.buttons[0].pressed ? 1 : 0,
        state.buttons[1].pressed ? 1 : 0,
        state.buttons[3].pressed ? 1 : 0,
        state.buttons[2].pressed ? 1 : 0,
        state.buttons[4].pressed ? 1 : 0,
      ],
      strum:
        state.buttons[12].pressed || state.axes[1] < -16000
          ? 1
          : state.buttons[13].pressed || state.axes[1] > 16000
            ? -1
            : 0,
      whammy: 0,
      star: state.buttons[5].pressed ? 1 : 0,
      start: state.buttons[9].pressed ? 1 : 0,
      select: state.buttons[8].pressed ? 1 : 0,
    };

    if (state.buttons[6].value > 0) {
      guitarState.whammy = state.buttons[6].value / 255.0;
    } else if (state.buttons[7].value > 0) {
      guitarState.whammy = state.buttons[7].value / 255.0;
    } else if (Math.abs(state.axes[2]) > 4000) {
      guitarState.whammy = (state.axes[2] + 32767) / 65534.0;
    } else if (Math.abs(state.axes[3]) > 4000) {
      guitarState.whammy = (state.axes[3] + 32767) / 65534.0;
    }

    const forceHb = now - (lastGpSend[vIndex] || 0) > 100;
    if (changed || forceHb) {
      lastGpSend[vIndex] = now;
      sendInputData(JSON.stringify(guitarState));
    }
    return;
  }

  if (window.currentInputMode === 'hotas') {
    const hotasState = {
      type: 'hotas',
      viewerId: myId,
      pad_id: myId + '_' + vIndex,
      axes: state.axes.map((a) => Math.max(-1.0, Math.min(1.0, a / 32767.0))),
      buttons: state.buttons.map((b) => (b.pressed || b.value > 127 ? 1 : 0)),
      hatX: state.buttons[15]?.pressed ? 1 : state.buttons[14]?.pressed ? -1 : 0,
      hatY: state.buttons[13]?.pressed ? 1 : state.buttons[12]?.pressed ? -1 : 0,
    };
    const forceHb = now - (lastGpSend[vIndex] || 0) > 100;
    if (changed || forceHb) {
      lastGpSend[vIndex] = now;
      sendInputData(JSON.stringify(hotasState));
    }
    return;
  }

  const forceHb = now - (lastGpSend[vIndex] || 0) > 100;
  if (changed || forceHb) {
    lastGpSend[vIndex] = now;
    sendInputData(JSON.stringify(state));
  }
}

['click', 'touchstart', 'keydown'].forEach((ev) =>
  document.addEventListener(
    ev,
    () => {
      if (!gpPolling) activateGamepad();
    },
    { once: true, passive: true }
  )
);
window.addEventListener('gamepadconnected', (e) => {
  if (!gpPolling) activateGamepad();
  document.getElementById('gpPrompt')?.classList.add('gone');
  maybeShowControllerGuide();
});

// ── GAMEPAD CALIBRATION SAVER ──
window.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SAVE_CONTROLLER_CALIB') {
    const { hardwareId, map } = e.data;
    localStorage.setItem('nearsec_map_' + hardwareId, JSON.stringify(map));
    if (window.electronAPI && window.electronAPI.saveSettings) {
      window.electronAPI.saveSettings({ [`calib_${hardwareId}`]: map });
      console.log('[Input] Saved calibration to disk for:', hardwareId);
    }
  }
});

// ── WEBXR (VR) INPUT POLLING ──────────────────────────────────────────────────
let xrSession = null;
let xrRefSpace = null;
let lastVrSend = 0;

function maybeShowVRButton() {
  if (!window.hostAllowVR || !navigator.xr) {
    const btn = document.getElementById('btnEnterVR');
    if (btn) btn.style.display = 'none';
    return;
  }

  navigator.xr.isSessionSupported('immersive-vr').then((supported) => {
    if (!supported) return;

    let btn = document.getElementById('btnEnterVR');
    if (!btn) {
      btn = document.createElement('button');
      btn.id = 'btnEnterVR';
      btn.textContent = 'Enter VR Mode';
      btn.style.cssText =
        'position:fixed; bottom:20px; right:20px; z-index:9999; padding:12px 24px; font-weight:bold; background:var(--accent); color:#000; border:none; border-radius:8px; cursor:pointer; box-shadow:0 4px 15px rgba(192,132,252,0.4); font-family:sans-serif;';
      btn.onclick = startVRSession;
      document.body.appendChild(btn);
    }
    btn.style.display = 'block';
  });
}

function startVRSession() {
  if (!navigator.xr) return;
  navigator.xr
    .requestSession('immersive-vr')
    .then((session) => {
      xrSession = session;
      const btn = document.getElementById('btnEnterVR');
      if (btn) btn.style.display = 'none';

      if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'viewer-vr-active', viewerId: myId }));

      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl', { xrCompatible: true });
      session.updateRenderState({ baseLayer: new XRWebGLLayer(session, gl) });

      session.requestReferenceSpace('local').then((refSpace) => {
        xrRefSpace = refSpace;
        session.requestAnimationFrame(onXRFrame);
      });

      session.addEventListener('end', () => {
        xrSession = null;
        if (window.hostAllowVR) maybeShowVRButton();
      });
    })
    .catch((err) => {
      console.error('[WebXR] Failed to start session:', err);
      alert('Failed to enter VR: ' + err.message);
    });
}

function onXRFrame(time, frame) {
  if (!xrSession) return;
  xrSession.requestAnimationFrame(onXRFrame);

  const now = Date.now();
  if (now - lastVrSend < 16) return;

  const pose = frame.getViewerPose(xrRefSpace);
  if (!pose) return;

  let changed = false;
  const vrState = {
    type: 'vr',
    viewerId: myId,
    head: null,
  };

  const hmdPos = pose.transform.position;
  const hmdOri = pose.transform.orientation;
  vrState.head = {
    px: hmdPos.x,
    py: hmdPos.y,
    pz: hmdPos.z,
    qw: hmdOri.w,
    qx: hmdOri.x,
    qy: hmdOri.y,
    qz: hmdOri.z,
  };
  changed = true;

  for (const source of xrSession.inputSources) {
    if (!source.gripSpace || (source.handedness !== 'left' && source.handedness !== 'right')) continue;
    const cp = frame.getPose(source.gripSpace, xrRefSpace);
    if (cp) {
      let trigger = 0,
        grip = 0,
        buttons = 0,
        ax = 0,
        ay = 0;
      const gp = source.gamepad;
      if (gp) {
        if (gp.buttons.length > 0) trigger = gp.buttons[0].value;
        if (gp.buttons.length > 1) grip = gp.buttons[1].value;

        // Construct a 4-bit mask for the VR backend:
        // bit0 = A/X (button 4), bit1 = B/Y (button 5)
        // bit2 = menu (button 6?), bit3 = thumbstick click (button 3)
        if (gp.buttons.length > 4 && gp.buttons[4].pressed) buttons |= 1;
        if (gp.buttons.length > 5 && gp.buttons[5].pressed) buttons |= 2;
        if (gp.buttons.length > 3 && gp.buttons[3].pressed) buttons |= 8;
        // Just as a generic mapping for whatever WebXR defines as menu
        if (gp.buttons.length > 6 && gp.buttons[6].pressed) buttons |= 4;

        if (gp.axes.length >= 4) {
          ax = gp.axes[2];
          ay = gp.axes[3];
        } else if (gp.axes.length >= 2) {
          ax = gp.axes[0];
          ay = gp.axes[1];
        }
      }

      vrState[source.handedness] = {
        px: cp.transform.position.x,
        py: cp.transform.position.y,
        pz: cp.transform.position.z,
        qw: cp.transform.orientation.w,
        qx: cp.transform.orientation.x,
        qy: cp.transform.orientation.y,
        qz: cp.transform.orientation.z,
        trigger,
        grip,
        buttons,
        ax,
        ay,
      };
    }
  }

  if (changed) {
    lastVrSend = now;
    sendInputData(JSON.stringify(vrState));
  }
}

// ── Test-only export shim ──────────────────────────────────────────────────
// `module` does not exist in the browser, so this block is inert there and
// changes no runtime behavior. See REFACTOR_PLAN.md Phase 0 / Phase 5.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    sendInputData,
    sendKbm,
    requestPointerLock,
    handleTabletEvent,
    toggleTouch,
    toggleGyro,
    requestHID,
    handleHIDReport,
    getSafeGamepadId,
    lookupCalibMap,
    applyCalibration,
    activateGamepad,
    startEyeTracking,
    stopEyeTracking,
    onFaceMeshResults,
    pollGamepad,
    maybeShowVRButton,
    startVRSession,
    onXRFrame,
  };
}
