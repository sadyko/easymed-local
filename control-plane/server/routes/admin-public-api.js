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
  partnersSee, syncKeyPending, acceptPendingSyncKey, isRevoked, isoSeconds, SYNC_FP_RE, KEY_HASH_RE,
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
 */
export function apiViewOf(db, c, now = new Date()) {
  return {
    enabled: !!c.api_enabled,
    sync_key: c.api_sync_key || null,
    sync_key_accepted_at: c.api_sync_key_accepted_at || null,
    sync_key_seen: c.api_sync_key_seen || null,
    sync_key_seen_at: c.api_sync_key_seen_at || null,
    key_pending: syncKeyPending(db, c),
    seen_key_revoked: isRevoked(db, 'sync_key', c.api_sync_key_seen),
    partners_see: partnersSee(c, { entitled: isEntitled(c.subscription, c.subscription_until, now) }),
    licence: c.licence_issued_at ? {
      issued_at: c.licence_issued_at, valid_until: c.licence_valid_until,
      subscription: c.licence_subscription, api_sync_key: c.licence_api_sync_key,
    } : null,
    revocations: db.prepare(
      'SELECT id, kind, value, note, created_at, created_by FROM revocations WHERE clinic_id = ? AND removed_at IS NULL ORDER BY id DESC',
    ).all(c.clinic_id),
  };
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
    const fingerprint = String((req.body && req.body.fingerprint) || '');
    if (!SYNC_FP_RE.test(fingerprint)) return fail(res, 400, 'bad_request', 'fingerprint must be the 32-character key fingerprint shown on this page.');
    const out = acceptPendingSyncKey(db, c.clinic_id, fingerprint);
    if (out.error === 'not_pending') return fail(res, 409, 'conflict', 'No new key is waiting for this clinic.');
    if (out.error === 'changed') return fail(res, 409, 'conflict', 'The clinic has sent another key since this page was loaded — reload the page and check again.');
    if (out.error === 'revoked') return fail(res, 409, 'conflict', 'This key is blocked. Unblock it first if it really is the clinic.');
    return res.json({ ok: true, note: SWITCH_NOTE, api: apiViewOf(db, clinicOf(db, c.clinic_id)) });
  });

  r.post('/clinics/:id/revocations', (req, res) => {
    const c = clinicOf(db, req.params.id);
    if (!c) return fail(res, 404, 'not_found', 'Clinic not found.');
    const { kind, value, note } = req.body || {};
    if (kind !== 'partner_key' && kind !== 'sync_key') return fail(res, 400, 'bad_request', 'kind must be "partner_key" or "sync_key".');
    const raw = typeof value === 'string' ? value.trim() : '';
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
    const row = db.prepare('SELECT id FROM revocations WHERE id = ? AND clinic_id = ? AND removed_at IS NULL').get(Number(req.params.rid) || 0, c.clinic_id);
    if (!row) return fail(res, 404, 'not_found', 'This block is not active for this clinic.');
    db.prepare('UPDATE revocations SET removed_at = ?, removed_by = ? WHERE id = ?').run(isoSeconds(), req.vendorUser.username, row.id);
    return res.json({ ok: true, note: REVOKE_NOTE, api: apiViewOf(db, clinicOf(db, c.clinic_id)) });
  });
}
