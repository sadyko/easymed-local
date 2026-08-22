import fs from 'node:fs';
import path from 'node:path';
import { hasAnyRole } from '../roles.js';
import { getDataDir } from '../control/config.js';
import { nextRunAt, consentAppliesTo } from '../control/update-schedule.js';

// UPDATE_DELIVERY_V1 (docs/plans/2026-08-20-update-delivery.md, Task 4) — the
// three RPCs the approval screen (a later task) calls. Registered in
// control/gate.js: update_status is READ_ONLY, update_approve/update_cancel
// are ALWAYS_ALLOWED — see that file's own comment for why consent must
// survive a licence lapse.

export class RpcError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

function get(db, key) {
  return db.prepare('SELECT value FROM control_state WHERE key = ?').get(key)?.value ?? null;
}
function put(db, key, value) {
  db.prepare(`INSERT INTO control_state (key, value, updated_at)
              VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
              ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run(key, String(value));
}
function del(db, key) {
  db.prepare('DELETE FROM control_state WHERE key = ?').run(key);
}

function readJsonState(db, key) {
  const raw = get(db, key);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

function readScheduledAt(db) {
  const raw = get(db, 'update_scheduled_at');
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

// last_result comes straight off disk, never off a control_state copy — the
// file IS the single record of what happened (updater.js hands it to
// apply-update.ps1's own DI seam; checkin.js reads it, sends it, and renames
// it .sent). Preferring the not-yet-sent name means a result the vendor
// hasn't heard about YET still shows up here immediately, not only after the
// next successful check-in.
function readLastResult(dataDir) {
  for (const name of ['update-result.json', 'update-result.json.sent']) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dataDir, name), 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch { /* try the next name, or fall through to null */ }
  }
  return null;
}

/** Everything the approval screen needs, in one call. Never blocked by a licence lapse. */
export function updateStatus(db, args, user) {
  const offer = readJsonState(db, 'update_offer');
  const rawConsent = readJsonState(db, 'update_consent');
  // A consent naming a version the current offer has since moved past is not
  // "approved" for anything that exists right now — see consentAppliesTo's
  // own comment. The screen must show this offer as unapproved, not stale
  // approval details for a release nobody will ever run.
  const consent = consentAppliesTo(offer, rawConsent) ? rawConsent : null;
  const scheduledAt = consent ? readScheduledAt(db) : null;
  return {
    offer,
    approved: !!consent,
    hour: consent ? consent.hour : null,
    scheduled_at: scheduledAt ? scheduledAt.toISOString() : null,
    last_result: readLastResult(getDataDir()),
  };
}

/**
 * «Обновить сегодня ночью» (or tomorrow, or a picked hour) — approval and
 * timing are one action, one RPC. Records who and when: a consent record is
 * something that may be asked about later.
 */
export function updateApprove(db, args, user, { now = () => new Date() } = {}) {
  // ADMIN_DOCTOR_V1-class check, not `user.role === 'admin'` — a clinic
  // admin's primary role is not always 'admin' (extra_roles is exactly how
  // one account is both a doctor and an admin). This bug has shipped twice
  // in this project already; hasAnyRole is the fix every other RPC guard
  // here already uses.
  if (!hasAnyRole(user, ['admin'])) {
    throw new RpcError('Только администратор может утвердить обновление.', 403);
  }

  const offer = readJsonState(db, 'update_offer');
  if (!offer) throw new RpcError('Нет доступного обновления.', 400);

  // Number(null) and Number('') are both 0 — a missing hour must be refused,
  // not silently scheduled for midnight. Same guard as update-schedule.js's
  // own nextRunAt() (which this RPC calls right below), kept explicit here
  // too since this is the actual input boundary from the approval screen.
  const rawHour = args && args.hour;
  const hour = typeof rawHour === 'number'
    ? rawHour
    : (typeof rawHour === 'string' && rawHour.trim() !== '' ? Number(rawHour) : NaN);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new RpcError('Час должен быть целым числом от 0 до 23.', 400);
  }

  const nowDate = now();
  const scheduledAt = nextRunAt(hour, nowDate);

  // Consent NAMES A VERSION (offer.version, not "whatever comes next") — if
  // the control plane later replaces this offer, consentAppliesTo() is what
  // stops the old approval from silently carrying over to the new release;
  // see update-schedule.js and updater.js for both sides of that guarantee.
  put(db, 'update_consent', JSON.stringify({
    version: offer.version,
    approved_by: user?.id ?? null,
    approved_at: nowDate.toISOString(),
    hour,
  }));
  put(db, 'update_scheduled_at', scheduledAt.toISOString());

  return { ok: true, version: offer.version, hour, scheduled_at: scheduledAt.toISOString() };
}

/** Changeable and cancellable right up until it runs — clears the approval, not the offer itself. */
export function updateCancel(db, args, user) {
  if (!hasAnyRole(user, ['admin'])) {
    throw new RpcError('Только администратор может отменить обновление.', 403);
  }
  del(db, 'update_consent');
  del(db, 'update_scheduled_at');
  return { ok: true };
}
