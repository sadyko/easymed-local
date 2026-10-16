// PUBLIC_LICENCE_V1 — панель: «Online booking / API» клиники и срочный отзыв ключей.
//
// Маршруты регистрируются на ТОМ ЖЕ роутере, что admin.js (registerPublicApiRoutes),
// после его requireVendor; их таблица входит в ADMIN_ROUTE_TABLE — состязательный
// тест admin.test.js проверяет, что каждый отвечает 401 без входа.
//
//   POST   /clinics/:id/api                 {enabled}       — переключатель онлайн-записи
//   POST   /clinics/:id/api/accept-key      {fingerprint}   — принять новый ключ обмена (новый ПК)
//   POST   /clinics/:id/revocations         {kind, value, note} — заблокировать ключ
//   DELETE /clinics/:id/revocations/:rid                    — снять блокировку
//
// Ключ партнёра сюда не приходит: панель считает его SHA-256 в браузере
// (panel-logic.js sha256Hex) и шлёт отпечаток. Сам ключ, присланный по ошибке,
// отвергается и нигде не сохраняется и не пишется в журнал (решение владельца 5:
// наружу из клиники — только отпечатки ключей).
import { isEntitled } from '../services/checkin.js';
import {
  partnersSee, acceptPendingSyncKey, isRevoked, isoSeconds, SYNC_FP_RE, KEY_HASH_RE,
  syncKeyCandidates, replacedKeysSeen, keyCode, normaliseKeyCode, restoreUnblockedSyncKey, formerSyncKeys, formerKeysOf,
} from '../services/public-api.js';
import { KEY_RE } from '../../../public/js/shared/api-connections.js';

export const PUBLIC_API_ROUTE_TABLE = [
  { method: 'POST', path: '/clinics/:id/api' },
  { method: 'POST', path: '/clinics/:id/api/accept-key' },
  { method: 'POST', path: '/clinics/:id/revocations' },
  { method: 'DELETE', path: '/clinics/:id/revocations/:rid' },
];

export const SWITCH_NOTE = "Partners: within a minute (the public server's feed). The clinic's own exchange: from its next check-in (hourly).";
export const REVOKE_NOTE = 'Takes effect on the public server within a minute — even while the clinic is offline.';
const NOTE_MAX = 200;

const CLINIC_COLUMNS = `clinic_id, active, subscription, subscription_until, api_enabled, api_sync_key, api_sync_key_accepted_at,
  api_sync_key_seen, api_sync_key_seen_at, licence_issued_at, licence_valid_until, licence_subscription, licence_api_sync_key`;

/**
 * Блок «Online booking / API» для GET /clinics/:id и ответов этих маршрутов.
 * partners_see — то же правило, что решает список производителя (routes/public-feed.js).
 * candidates — новые ключи после последнего принятия: ни кода, ни ОТПЕЧАТКА
 * (первые 8 hex отпечатка — это и есть код; перепроверка 8c, F4) — только
 * непрозрачный id строки, по нему панель принимает и блокирует; код оператор
 * узнаёт от клиники и набирает сам. key_competing — их больше одного, принять
 * нельзя; replaced_seen — прежние ключи (их код известен — они были приняты),
 * которые снова сверялись. В revocations у ключа обмена нет value; code — только
 * у ключа, который был принятым (F5: код не принятого ни разу ключа не выдаётся).
 */
export function apiViewOf(db, c, now = new Date()) {
  const candidates = syncKeyCandidates(db, c);
  // Round 2 — including keys accepted before a re-enrolment (sync_keys_history).
  const everAccepted = formerSyncKeys(db, c.clinic_id);
  return {
    enabled: !!c.api_enabled,
    sync_key: c.api_sync_key || null,
    sync_key_code: c.api_sync_key ? keyCode(c.api_sync_key) : null,
    sync_key_accepted_at: c.api_sync_key_accepted_at || null,
    candidates: candidates.map(({ id, first_seen, last_seen, revoked, other_clinic }) => ({ id, first_seen, last_seen, revoked, other_clinic })),
    key_pending: candidates.some((k) => !k.revoked),
    key_competing: candidates.length > 1,
    replaced_seen: replacedKeysSeen(db, c).map(({ id, code, last_seen, replaced_at }) => ({ id, code, last_seen, replaced_at })),
    // Round 3 (R3-4) — the clinic's former keys (from the history), by history id, without fingerprints.
    former_keys: formerKeysOf(db, c).map(({ fp, ...f }) => f),
    seen_key_revoked: isRevoked(db, 'sync_key', c.api_sync_key_seen),
    partners_see: partnersSee(c, { entitled: isEntitled(c.subscription, c.subscription_until, now) }),
    licence: c.licence_issued_at ? {
      issued_at: c.licence_issued_at, valid_until: c.licence_valid_until,
      subscription: c.licence_subscription, api_sync_key: c.licence_api_sync_key,
    } : null,
    revocations: db.prepare(
      'SELECT id, kind, value, note, created_at, created_by FROM revocations WHERE clinic_id = ? AND removed_at IS NULL ORDER BY id DESC',
    ).all(c.clinic_id).map((r) => (r.kind === 'sync_key'
      ? { ...r, value: null, code: everAccepted.has(r.value) ? keyCode(r.value) : null }
      : { ...r, code: null })),
  };
}

/** Строка ключа этой клиники по непрозрачному id из панели (F4) — или null. */
function keyRowById(db, clinicId, id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return null;
  return db.prepare('SELECT fp FROM sync_keys_seen WHERE id = ? AND clinic_id = ?').get(n, clinicId) || null;
}

/** Строка истории принятых ключей этой клиники по id из панели (раунд 3, R3-4) — или null. */
function historyRowById(db, clinicId, id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return null;
  return db.prepare('SELECT fp FROM sync_keys_history WHERE id = ? AND clinic_id = ?').get(n, clinicId) || null;
}

const clinicOf = (db, id) => db.prepare(`SELECT ${CLINIC_COLUMNS} FROM clinics WHERE clinic_id = ?`).get(id);
const fail = (res, status, code, message) => res.status(status).json({ error: { code, message } });

/** @param {import('express').Router} r роутер admin.js, уже за requireVendor */
export function registerPublicApiRoutes(r, db) {
  r.post('/clinics/:id/api', (req, res) => {
    const c = clinicOf(db, req.params.id);
    if (!c) return fail(res, 404, 'not_found', 'Clinic not found.');
    const { enabled } = req.body || {};
    if (typeof enabled !== 'boolean') return fail(res, 400, 'bad_request', 'enabled must be true or false.');
    db.prepare('UPDATE clinics SET api_enabled = ? WHERE clinic_id = ?').run(enabled ? 1 : 0, c.clinic_id);
    return res.json({ ok: true, note: SWITCH_NOTE, api: apiViewOf(db, clinicOf(db, c.clinic_id)) });
  });

  r.post('/clinics/:id/api/accept-key', (req, res) => {
    const c = clinicOf(db, req.params.id);
    if (!c) return fail(res, 404, 'not_found', 'Clinic not found.');
    // The panel names the new key by its opaque id (F4 — it never learns the
    // fingerprint); API clients and tests may still name it by fingerprint.
    const body = req.body || {};
    let fingerprint = String(body.fingerprint || '');
    if (body.key_id !== undefined && body.key_id !== null) {
      const k = keyRowById(db, c.clinic_id, body.key_id);
      if (!k) return fail(res, 409, 'conflict', 'This key is no longer waiting for this clinic — reload the page and check again.');
      fingerprint = k.fp;
    }
    if (!SYNC_FP_RE.test(fingerprint)) return fail(res, 400, 'bad_request', 'Say which new key to accept (key_id from this page).');
    const code = body.code;
    if (!normaliseKeyCode(code)) {
      return fail(res, 400, 'bad_request', 'Type the key code the clinic reads out from Settings → API (8 characters, like ab12-cd34).');
    }
    const out = acceptPendingSyncKey(db, c.clinic_id, { fingerprint, code });
    if (out.error === 'not_pending') return fail(res, 409, 'conflict', 'No new key is waiting for this clinic.');
    if (out.error === 'competing') {
      return fail(res, 409, 'conflict', `${out.count} different new keys arrived from this clinic's install since its key was last accepted — possible copy of the clinic's data. Nothing can be accepted: re-enrol the clinic (a new enrollment code), then accept the key of the re-enrolled computer.`);
    }
    if (out.error === 'changed') return fail(res, 409, 'conflict', 'The clinic has sent another key since this page was loaded — reload the page and check again.');
    if (out.error === 'revoked') return fail(res, 409, 'conflict', 'This key is blocked. Unblock it first if it really is the clinic.');
    if (out.error === 'same_code') {
      return fail(res, 409, 'conflict', 'This is the code of the key the clinic already uses — the clinic has not changed computers. Do not accept; this new key may be a copy. Block it, and re-enrol the clinic if in doubt.');
    }
    if (out.error === 'code_mismatch') {
      return fail(res, 409, 'conflict', "The code the clinic read out does not match the new key. Do not accept it — ask them to read the key code from Settings → API again; if it still differs, the new key is not theirs.");
    }
    if (out.error === 'shared') {
      return fail(res, 409, 'conflict', `This key is already the accepted key of clinic ${out.clinicId} — one key belongs to one clinic. The clinic's computer must make its own key (re-enrol it).`);
    }
    if (out.error) return fail(res, 400, 'bad_request', 'Type the key code the clinic reads out from Settings → API (8 characters, like ab12-cd34).');
    return res.json({ ok: true, note: SWITCH_NOTE, api: apiViewOf(db, clinicOf(db, c.clinic_id)) });
  });

  r.post('/clinics/:id/revocations', (req, res) => {
    const c = clinicOf(db, req.params.id);
    if (!c) return fail(res, 404, 'not_found', 'Clinic not found.');
    const { kind, value, note, key_id: keyId, former_id: formerId } = req.body || {};
    if (kind !== 'partner_key' && kind !== 'sync_key') return fail(res, 400, 'bad_request', 'kind must be "partner_key" or "sync_key".');
    // F4 — «Block this key» on a new (or previously replaced) key sends its
    // opaque id; the fingerprint is looked up here, never sent to the page.
    // Round 3 (R3-4) — a former key (from the history: after a re-enrolment
    // it is nowhere else) is sent by its history id, a namespace of its own.
    let byId = null;
    if (kind === 'sync_key' && keyId !== undefined && keyId !== null) {
      byId = keyRowById(db, c.clinic_id, keyId);
      if (!byId) return fail(res, 400, 'bad_request', "This is not one of this clinic's API keys.");
    } else if (kind === 'sync_key' && formerId !== undefined && formerId !== null) {
      byId = historyRowById(db, c.clinic_id, formerId);
      if (!byId) return fail(res, 400, 'bad_request', "This is not one of this clinic's API keys.");
    }
    const raw = byId ? byId.fp : (typeof value === 'string' ? value.trim() : '');
    if (KEY_RE.test(raw)) {
      // The key itself, not its fingerprint. Refused, never stored, never echoed.
      return fail(res, 400, 'bad_request', 'Send the SHA-256 of the key, not the key itself — the panel computes it in your browser.');
    }
    const v = raw.toLowerCase();
    if (!(kind === 'partner_key' ? KEY_HASH_RE : SYNC_FP_RE).test(v)) {
      return fail(res, 400, 'bad_request', kind === 'partner_key'
        ? 'value must be the SHA-256 of the partner key (64 hex characters).'
        : 'value must be the sync key fingerprint (32 hex characters).');
    }
    // Step 8c review — a clinic's page blocks only that clinic's own keys: a
    // fingerprint this install never presented (a typo, another clinic's key)
    // is refused instead of silently cutting off some other clinic. Its own
    // keys include every key it ever had accepted (round 2: a computer
    // replaced before a re-enrolment, reported stolen afterwards).
    if (kind === 'sync_key' && !formerSyncKeys(db, c.clinic_id).has(v)
      && !db.prepare('SELECT 1 FROM sync_keys_seen WHERE clinic_id = ? AND fp = ?').get(c.clinic_id, v)) {
      return fail(res, 400, 'bad_request', "This is not one of this clinic's API keys.");
    }
    if (note !== undefined && note !== null && typeof note !== 'string') return fail(res, 400, 'bad_request', 'note must be text.');
    const text = typeof note === 'string' && note.trim() ? note.trim().slice(0, NOTE_MAX) : null;
    const existing = db.prepare('SELECT id FROM revocations WHERE kind = ? AND value = ? AND removed_at IS NULL').get(kind, v);
    if (existing) return res.json({ ok: true, already: true, id: existing.id, note: REVOKE_NOTE, api: apiViewOf(db, clinicOf(db, c.clinic_id)) });
    const id = db.transaction(() => {
      const info = db.prepare('INSERT INTO revocations (clinic_id, kind, value, note, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)')
        .run(c.clinic_id, kind, v, text, isoSeconds(), req.vendorUser.username);
      // The accepted sync key blocked — it leaves the next licence too; a new
      // key from the clinic then waits for "Accept new key".
      if (kind === 'sync_key' && c.api_sync_key === v) db.prepare('UPDATE clinics SET api_sync_key = NULL WHERE clinic_id = ?').run(c.clinic_id);
      return Number(info.lastInsertRowid);
    })();
    return res.status(201).json({ ok: true, id, note: REVOKE_NOTE, api: apiViewOf(db, clinicOf(db, c.clinic_id)) });
  });

  r.delete('/clinics/:id/revocations/:rid', (req, res) => {
    const c = clinicOf(db, req.params.id);
    if (!c) return fail(res, 404, 'not_found', 'Clinic not found.');
    const row = db.prepare('SELECT id, kind, value FROM revocations WHERE id = ? AND clinic_id = ? AND removed_at IS NULL').get(Number(req.params.rid) || 0, c.clinic_id);
    if (!row) return fail(res, 404, 'not_found', 'This block is not active for this clinic.');
    db.transaction(() => {
      db.prepare('UPDATE revocations SET removed_at = ?, removed_by = ? WHERE id = ?').run(isoSeconds(), req.vendorUser.username, row.id);
      // Re-check F2 — the clinic's accepted key, blocked by mistake, comes back accepted.
      if (row.kind === 'sync_key') restoreUnblockedSyncKey(db, c.clinic_id, row.value);
    })();
    return res.json({ ok: true, note: REVOKE_NOTE, api: apiViewOf(db, clinicOf(db, c.clinic_id)) });
  });
}
