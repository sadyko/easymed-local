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
