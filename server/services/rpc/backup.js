import fs from 'node:fs';
import bcrypt from 'bcryptjs';
import { hasAnyRole } from '../roles.js';
import { getDataDir } from '../control/config.js';
import { listBackups, createBackup, requestRestore, requestFactoryReset } from '../backup.js';

// SYSTEM_SETTINGS_V1 — the settings screen's backup/restore/reset RPCs.
//
// All four are in control/gate.js ALWAYS_ALLOWED_RPCS: a licence lapse must
// never stand between a clinic and its own data. The protection lives HERE
// instead — admin role on everything, and the caller's own password re-proved
// on the two destructive calls: a session cookie can be borrowed from an
// unlocked PC at the front desk; the admin's password cannot.

export class RpcError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

// The restart seam. RPC handlers are invoked as (db, args, user) — no opts to
// inject through — so tests override at module level, the same pattern as
// enroll.js's __setPublicKeyForTests. A test that let the real process.exit
// fire would kill the test runner itself, which is why injecting a stub is
// non-negotiable, not a convenience.
let _exit = (code) => process.exit(code);
let _exitDelayMs = 500;
export function __setExitForTests(fn, delayMs = 0) {
  _exit = fn || ((code) => process.exit(code));
  _exitDelayMs = fn ? delayMs : 500;
}

// 500ms so the HTTP response reaches the browser before the process dies —
// exiting inside the handler would tear the socket down mid-reply and the UI
// would show a network error instead of its "restarting…" overlay. Exit code
// 75 is the launcher's restart convention (it relaunches the server; plain
// `npm start` just stops, which the restore modal warns about). unref'd so a
// process already shutting down for another reason is not held open for it.
function scheduleRestart() {
  setTimeout(() => _exit(75), _exitDelayMs).unref();
}

function requireAdmin(user) {
  // hasAnyRole, not user.role — the ADMIN_DOCTOR_V1 rule: a clinic admin
  // whose primary role is doctor must not be locked out of the one screen
  // that saves (or erases) the clinic's data.
  if (!hasAnyRole(user, ['admin'])) {
    throw new RpcError('Только администратор может управлять резервными копиями.', 403);
  }
}

function requirePassword(db, user, password) {
  // Same SELECT + compare as auth.js's changeOwnPassword — one implementation
  // idea, one wording. The is_active filter means a just-deactivated admin
  // with a still-open session cannot destroy data on the way out.
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ? AND is_active = 1').get(user?.id ?? -1);
  if (!row || !bcrypt.compareSync(String(password ?? ''), row.password_hash)) {
    throw new RpcError('Неверный пароль.', 403);
  }
}

/** The backups table on the settings screen, plus where they live and the room left. */
export function backupList(db, args, user) {
  requireAdmin(user);
  const dataDir = getDataDir();
  // Free space is a courtesy note, not a fact the feature depends on:
  // statfsSync exists on this Node/Windows combination (verified), but a
  // platform where it fails must degrade to "no note", never to a 500 on the
  // whole listing.
  let free = null;
  try {
    const s = fs.statfsSync(dataDir);
    free = Number(s.bavail) * Number(s.bsize);
  } catch { free = null; }
  return { backups: listBackups(dataDir), data_dir: dataDir, free_bytes: free };
}

/** «Создать копию сейчас». */
export async function backupCreate(db, args, user) {
  requireAdmin(user);
  return { ok: true, backup: await createBackup(db, getDataDir(), 'manual') };
}

/** Restore a listed backup: password re-check, marker, then restart via exit 75. */
export async function backupRestore(db, args, user) {
  requireAdmin(user);
  // Password BEFORE any disk work: a caller who cannot re-prove themselves
  // must not even cause a safety copy — no observable side effect at all.
  requirePassword(db, user, args.password);
  const r = await requestRestore(db, getDataDir(), typeof args.name === 'string' ? args.name : '');
  if (!r.ok) throw new RpcError('Такой резервной копии нет. Обновите список и попробуйте ещё раз.', 400);
  scheduleRestart();
  return { ok: true, restarting: true };
}

/** The danger zone. The client repeats the confirm-word check; this one is the real one. */
export async function factoryReset(db, args, user) {
  requireAdmin(user);
  // Exact match, server-side: the typed word is the proof the admin read the
  // modal rather than clicked through it, and a check that only lived in the
  // browser would be no check at all against curl.
  if (String(args.confirm ?? '') !== 'УДАЛИТЬ') {
    throw new RpcError('Подтверждение не совпадает: введите слово УДАЛИТЬ.', 400);
  }
  requirePassword(db, user, args.password);
  await requestFactoryReset(db, getDataDir(), { wipeBackups: !!args.wipe_backups });
  scheduleRestart();
  return { ok: true, restarting: true };
}
