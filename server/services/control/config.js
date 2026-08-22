import path from 'node:path';

// LICENCE_CORE_V1 — where control.json and licence.dat live.
//
// This exists because of a signature mismatch that is easy to miss: RPC handlers
// are invoked as (db, args, user) by services/rpc/index.js. They never see `req`,
// so req.control and any per-request data directory are unreachable from inside
// an RPC. Rather than widen that signature across eighty-two handlers, the path
// is resolved once when the app is created and read from here.

let _dataDir = null;

export function setDataDir(dir) { _dataDir = dir; }

export function getDataDir() {
  return _dataDir || path.join(process.cwd(), 'data');
}

// UPDATE_DELIVERY_V1 — same DI seam as getDataDir() above, same reason: RPC
// handlers are invoked as (db, args, user) with no `req`, so update_status
// (server/services/rpc/updates.js) has no way to see the version
// server/index.js computed from package.json at boot. Importing
// server/index.js directly from there would also be circular — index.js
// imports app.js, which imports routes/rpc.js, which imports
// services/rpc/index.js (the RPC registry), which imports updates.js — so
// index.js sets this once at load instead, exactly the way it already calls
// setDataDir(DATA_DIR) a few lines above its own APP_VERSION constant.
let _appVersion = null;

export function setAppVersion(v) { _appVersion = v || null; }

export function getAppVersion() {
  return _appVersion || '0.0.0';
}
