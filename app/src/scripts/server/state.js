'use strict';
// Shared mutable runtime state for the Express/WebSocket server.
//
// Historically this all lived as module-level `let`s in server.js or as
// local variables inside its giant `main()` — fine when everything was one
// file, but both the HTTP routes and the WebSocket handlers read and mutate
// most of it, so splitting those into server/http.js and server/ws.js needs
// a shared place for it to live instead of a closure neither file can reach
// into. Plain mutable objects/collections, not a state-management library —
// this is glue state for a signaling server, not application UI state.
//
// Primitives (numbers/strings/booleans) are grouped into small objects
// (`session`, `runtime`, `serverInfo`) rather than exported individually,
// since a bare exported `let` wouldn't give other modules a live binding in
// CommonJS — `state.session.pin = x` works everywhere, `let pin` reassigned
// in one file would not be visible in another.

// ── Server boot info — set once in server.js's boot sequence, read-only after ──
const serverInfo = {
  lanIp: null,
  publicIp: null,
  appVersion: null,
  commitHash: null,
};

// ── Session / auth state ──
const session = {
  pin: null,
  sessionPassword: '',
  pinEnabled: true,
  hostStreaming: false,
};

// ── Runtime handles ──
const runtime = {
  activePort: 3000,
  hostWS: null,
  tunnelUrl: null,
  activeTunnelProc: null,
  audioProc: null,
  vidCount: 0,
};

// ── Viewer/session registries — Maps/Sets are shared mutable references,
// no wrapper needed (same pattern arcadeSessions/arcadeClients already use
// in server/arcade-signaling.js). ──
const viewers = new Map();
const viewerNames = new Map();
const inputPerms = new Map();
const pinAttempts = new Map();
const viewerGamepads = new Map();
const viewerHasController = new Set();
const hwIdToViewer = new Map();

module.exports = {
  serverInfo,
  session,
  runtime,
  viewers,
  viewerNames,
  inputPerms,
  pinAttempts,
  viewerGamepads,
  viewerHasController,
  hwIdToViewer,
};
