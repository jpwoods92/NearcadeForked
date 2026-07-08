'use strict';
// Shared mutable runtime state for the Electron main process.
//
// electron-main.js used to hold all of this as top-level `let`s — fine when
// window creation, IPC handlers, and app-level listeners (second-instance,
// will-quit, the panic globalShortcut) all lived in one file, but splitting
// those into electron/window.js and electron/ipc/*.js needs a shared place
// for them to read/write instead of a closure none of them can reach into.
// Same pattern as app/src/scripts/server/state.js from Phase 3.

const runtime = {
  win: null,
  tray: null,
  serverPort: null,
  serverCore: null,
  settings: null,
  selectedSourceId: null,
};

module.exports = { runtime };
