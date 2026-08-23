import fs from 'node:fs';
import path from 'node:path';
import { controlState } from '../control/state.js';
import { currentChallenge, redeem } from '../control/unlock.js';
import { enrollWithCode } from '../control/enroll.js';
import { getDataDir } from '../control/config.js';
import { hasAnyRole } from '../roles.js';

// LICENCE_CORE_V1 — the three RPCs that must work while locked.
//
// They are whitelisted in control/gate.js ALWAYS_ALLOWED_RPCS. Without them a
// clinic that wants to pay has no way to say so, which is also why login itself
// stays open when the licence lapses.

export class RpcError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

// The keys a licence may grant. Kept here rather than derived from whatever the
// licence happens to contain, so a typo in a request is caught and so the vendor
// panel and the app share one vocabulary. Extend deliberately, in step with the
// panel.
// TELEPHONY_V1 — 'callcenter' unlocks Настройки → «Телефония» (and later the
// call-center screen rewrite); added here so the locked-tile's «Подключить
// модуль» request validates instead of 400ing.
export const SELLABLE_MODULES = new Set(['crm', 'telegram', 'marketing', 'callcenter']);

/** Everything the lock screen and the banners need. Never blocked. */
export function licenceStatus(db, args, user) {
  const s = controlState(db, getDataDir());
  return {
    state: s.state,
    locked: s.locked,
    reason: s.reason,
    days_left: s.daysLeft,
    modules: s.modules,
    clinic_name: s.clinicName,
    // SYSTEM_SETTINGS_V1 — the subscription card's extra facts. clinic_id and
    // valid_until ride along from controlState (valid_until is the EFFECTIVE
    // expiry — see state.js's shape() for why it is not the raw licence
    // field); last_checkin is a read of the control_state record checkin.js
    // already writes after every successful call home — no new storage.
    clinic_id: s.clinicId,
    valid_until: s.validUntil,
    last_checkin: db.prepare("SELECT value FROM control_state WHERE key = 'last_checkin_at'").get()?.value ?? null,
    clock_anomaly: s.clockAnomaly,
    // Shown on the lock screen for the telephone call, so it must be available
    // even with no control.json at all (an unenrolled install: reason
    // 'not_enrolled') — currentChallenge() only touches control_state, which
    // migrate() always creates, so this never depends on identity being known.
    challenge: s.locked ? currentChallenge(db) : null,
  };
}

/** Redeem a code read out by the vendor over the telephone. */
export function licenceUnlock(db, args, user) {
  // ADMIN_DOCTOR_V1-class check: a clinic admin's PRIMARY role is not always
  // 'admin' (extra_roles exists precisely because one account can be a doctor
  // AND an admin). Testing user.role directly would lock that admin out of the
  // one screen that lets them fix a lapsed licence — hasAnyRole is the same
  // fix already applied across every other RPC guard in this codebase.
  if (!hasAnyRole(user, ['admin'])) throw new RpcError('Только администратор может активировать.', 403);

  let identity = null;
  try { identity = JSON.parse(fs.readFileSync(path.join(getDataDir(), 'control.json'), 'utf8')); } catch {}
  if (!identity?.clinic_id) throw new RpcError('Эта установка не привязана к клинике.', 400);

  const r = redeem(db, {
    code: args.code,
    clinicId: identity.clinic_id,
    secret: identity.unlock_secret,
  });

  if (!r.ok) {
    throw new RpcError(
      r.reason === 'too_many_attempts'
        ? 'Слишком много попыток. Попробуйте позже.'
        : 'Код неверный. Проверьте и введите ещё раз.',
      400,
    );
  }
  return { ok: true, until: r.until };
}

// ENROLLMENT_SCREEN_V1 — the fixed reason vocabulary control/enroll.js returns,
// mapped onto the sentences the activation screen shows verbatim (the screen
// displays e.message as-is, same as licence_unlock's errors above). Reasons the
// clinic cannot act on differently (a vendor 500, a garbage response, a failed
// disk write) share ONE retryable sentence on purpose — three scary variants
// would not change what the admin should do next.
const ENROLL_MESSAGES = {
  empty_code:        'Код неверный. Проверьте и введите ещё раз.',
  invalid_code:      'Код неверный. Проверьте и введите ещё раз.',
  too_many_attempts: 'Слишком много попыток. Попробуйте позже.',
  offline:           'Нет связи с Easy-Med. Проверьте интернет и попробуйте ещё раз.',
  already_enrolled:  'Эта установка уже привязана к клинике.',
};
const ENROLL_DEFAULT = 'Не удалось активировать. Попробуйте ещё раз или обратитесь к менеджеру Easy-Med.';

/**
 * Redeem the EM- enrollment code typed on the first-run activation screen.
 * The transport (network, Ed25519 verification, atomic file writes) lives in
 * control/enroll.js; this adapter only gates and translates. enrollImpl is a
 * test seam — the RPC signature is (db, args, user), so the transport cannot
 * be injected any other way (same reasoning as control/config.js's seams).
 */
export async function licenceEnroll(db, args, user, { enrollImpl = enrollWithCode } = {}) {
  // Same gate and same wording as licenceUnlock above, for the same reason:
  // the admin fixing a locked install may be a doctor whose EXTRA role is
  // admin, and a non-admin must see WHY they cannot activate.
  if (!hasAnyRole(user, ['admin'])) throw new RpcError('Только администратор может активировать.', 403);

  const r = await enrollImpl(getDataDir(), args.code);
  if (!r.ok) throw new RpcError(ENROLL_MESSAGES[r.reason] || ENROLL_DEFAULT, 400);
  return { ok: true, clinic_id: r.clinic_id, clinic_name: r.clinic_name };
}

/** «Подключить модуль» from the locked-module screen. */
export function moduleRequest(db, args, user) {
  // English, like the other "this can only happen from a bad API call, never
  // from the real UI" validation errors in this codebase (see
  // catalog.js/accommodation.js's "must be a positive integer" messages) — the
  // locked-module screen only ever sends a key from SELLABLE_MODULES, so this
  // is a contract violation, not something a clinic user can trigger by
  // clicking around.
  const key = String(args.module_key || '');
  if (!SELLABLE_MODULES.has(key)) throw new RpcError('Unknown module: ' + (key || '(missing)'), 400);

  // SELECT-then-INSERT looks racy, but better-sqlite3 is synchronous and this
  // process holds the only connection that writes module_requests: there is no
  // await between the SELECT and the INSERT for another call to interleave
  // into, in this process or (WAL, one writer) any other. The partial unique
  // index (module_requests_open_uniq) is the backstop for that reasoning being
  // wrong someday, not the primary defence — see the test that drives the
  // INSERT into the constraint directly and checks the caller still gets a
  // clean {ok:true, already:true} instead of a 500.
  const open = db.prepare('SELECT * FROM module_requests WHERE module_key = ? AND sent_at IS NULL').get(key);
  if (open) return { ok: true, already: true, requested_at: open.requested_at };

  try {
    db.prepare('INSERT INTO module_requests (module_key, requested_by) VALUES (?, ?)')
      .run(key, user?.id ?? null);
  } catch (e) {
    // Belt-and-braces for the race the comment above argues can't happen here:
    // if it ever does (or the reasoning above turns out wrong on some future
    // multi-connection deployment), the clinic still sees the same "already
    // requested" answer instead of a 500 on its own escape hatch.
    //
    // Narrowed to the SPECIFIC unique index (module_requests_open_uniq), not
    // any SQLITE_CONSTRAINT: requested_by is also a FK to users(id), and a
    // broad /SQLITE_CONSTRAINT/ match would silently relabel a real foreign-key
    // failure (e.g. a deleted/bogus user id reaching here) as "already
    // requested" — masking a genuine bug behind a happy-looking response
    // instead of surfacing it as the 500 it actually is. Found by writing the
    // test for this exact path: a bare SQLITE_CONSTRAINT match let a FK error
    // sail through as {ok:true, already:true, requested_at:null} with no row
    // ever inserted.
    if (e.code !== 'SQLITE_CONSTRAINT_UNIQUE') throw e;
    const row = db.prepare('SELECT * FROM module_requests WHERE module_key = ? AND sent_at IS NULL').get(key);
    return { ok: true, already: true, requested_at: row?.requested_at ?? null };
  }
  const row = db.prepare('SELECT * FROM module_requests WHERE module_key = ? AND sent_at IS NULL').get(key);
  return { ok: true, already: false, requested_at: row.requested_at };
}
