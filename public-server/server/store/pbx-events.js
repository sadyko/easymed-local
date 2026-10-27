// CALL_RING_V1 (2026-10-17) — события станции о живых звонках: приём по секрету
// адреса, хранение десять минут, выдача клинике длинным опросом.
//
// Публичный сервер здесь — почтовый ящик, не участник: он не знает, кто звонит
// (имя подбирает клиника), и не помнит дольше, чем нужно, чтобы клиника успела
// забрать. Секрет адреса хранится хешем (ring_hash у клиники), сравнение — без
// утечки по времени.
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { isoOf } from '../lib/time.js';

/** Десять минут: дольше событие о звонке — уже не новость, а строка журнала клиники. */
export const PBX_TTL_MS = 10 * 60_000;
/** Повтор того же события того же звонка за минуту (станция прислала дважды) — не вставляется. */
export const PBX_DUP_MS = 60_000;
/** Пустой курсор (клиника только что запустилась) — события не старше полутора минут: старые звонки не проигрываются заново. */
export const PBX_FRESH_MS = 90_000;
export const PBX_PAGE = 100;
/** Длинный опрос держится не дольше 20 секунд — меньше любого таймаута прокси. */
export const PBX_WAIT_MAX_SEC = 20;
const TOKEN_RE = /^[0-9a-f]{32}$/;
const DELIVERED = "('ring', 'answer', 'end')";

const bus = new EventEmitter();
bus.setMaxListeners(0);

/** Хеш секрета адреса; не 32 hex — '' (адреса нет). */
export function ringHashOf(token) {
  const t = String(token || '');
  return TOKEN_RE.test(t) ? crypto.createHash('sha256').update(t).digest('hex') : '';
}

/** Клиника по номеру и секрету адреса; чужой секрет, пустой хеш, нет клиники — null. */
export function clinicByRingToken(db, clinicId, token) {
  const h = ringHashOf(token);
  if (!h) return null;
  const row = db.prepare('SELECT clinic_id, ring_hash FROM clinics WHERE clinic_id = ?').get(String(clinicId || ''));
  if (!row || !row.ring_hash) return null;
  const a = Buffer.from(h);
  const b = Buffer.from(String(row.ring_hash));
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? { clinic_id: row.clinic_id } : null;
}

export function prunePbxEvents(db, now) {
  db.prepare('DELETE FROM pbx_events WHERE received_at < ?').run(isoOf(now - PBX_TTL_MS));
}

/**
 * Положить событие. keys — имена полей непонятного события (event 'unknown'):
 * клинике не выдаётся, но остаётся на десять минут для разбора схемы.
 * @returns {{id:number} | {dup:true}}
 */
export function insertPbxEvent(db, clinicId, ev, now, keys = []) {
  prunePbxEvents(db, now);
  const dup = db.prepare('SELECT 1 FROM pbx_events WHERE clinic_id = ? AND uuid = ? AND event = ? AND received_at >= ?')
    .get(clinicId, ev.uuid, ev.event, isoOf(now - PBX_DUP_MS));
  if (dup) return { dup: true };
  const r = db.prepare(`INSERT INTO pbx_events (clinic_id, uuid, event, direction, caller, callee, at, received_at, keys)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(clinicId, String(ev.uuid).slice(0, 80), ev.event, String(ev.direction || ''), String(ev.caller || ''), String(ev.callee || ''),
      String(ev.at || isoOf(now)), isoOf(now), JSON.stringify((keys || []).map(String).slice(0, 40)));
  bus.emit('pbx:' + clinicId);
  return { id: Number(r.lastInsertRowid) };
}

/** События клиники после курсора (номера); пустой курсор — свежие (не старше 90 с). 'unknown' не выдаётся. */
export function pbxEventsSince(db, clinicId, after, now) {
  prunePbxEvents(db, now);
  const a = String(after || '').trim();
  if (a) {
    return db.prepare(`SELECT id, uuid, event, direction, caller, callee, at FROM pbx_events
                        WHERE clinic_id = ? AND id > ? AND event IN ${DELIVERED} ORDER BY id LIMIT ?`).all(clinicId, Number(a) || 0, PBX_PAGE);
  }
  return db.prepare(`SELECT id, uuid, event, direction, caller, callee, at FROM pbx_events
                      WHERE clinic_id = ? AND received_at >= ? AND event IN ${DELIVERED} ORDER BY id LIMIT ?`).all(clinicId, isoOf(now - PBX_FRESH_MS), PBX_PAGE);
}

/** Ждать событие этой клиники до ms миллисекунд: true — пришло, false — тишина. */
export function waitForPbxEvent(clinicId, ms) {
  return new Promise((resolve) => {
    const key = 'pbx:' + clinicId;
    const done = () => { clearTimeout(t); resolve(true); };
    const t = setTimeout(() => { bus.off(key, done); resolve(false); }, Math.max(0, ms));
    if (t.unref) t.unref();
    bus.once(key, done);
  });
}
