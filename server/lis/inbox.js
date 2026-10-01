// LIS_INGEST_V1 — лоток входящих сообщений.
//
// Инвариант 2: каждое сообщение, дошедшее до порта, сохраняется сырым, чем бы
// дело ни кончилось. Смазанный штрихкод обязан стоить клика, а не повторного
// забора крови у пациента.
//
// Таблица закрыта на запись из браузера (реестр схемы): её строки —
// свидетельство о том, что пришло по проводу, и правка их из интерфейса
// превратила бы журнал в пересказ.

/**
 * LIS_DISCOVERY_FIX_V1 (ревью 2026-09-29) — начало строки лотка у переросшего
 * сообщения («сообщение больше 4 МБ — не принято; в лотке только его начало»,
 * index.js). В лотке от такого сообщения только первые 64 КБ, и привязать его
 * к заказу нельзя: в бланк легло бы обрезанное число (PLT «25» вместо 250).
 * По этому началу привязка (rpc/lis.js) его и узнаёт — поэтому оно одно на оба
 * места.
 */
export const OVERSIZE_DETAIL_PREFIX = 'сообщение больше ';

/**
 * LIS_REAL_ANALYZERS_V1_SERIES — начало строки лотка у сообщения серии, которое
 * ждёт остальные строки бланка (прибор шлёт по тесту в сообщении, BS-200 и
 * A1000; ingest.js, match.js planSeries). Это настоящая строка unmapped: экран
 * лишь не считает её бедой первые 60 минут (группа «Идёт приём»), а дошедшая
 * серия переводит её в applied. По этому началу её узнают и приём (перевод), и
 * экран — экран держит копию строки, и тест сверяет обе.
 */
export const SERIES_PENDING_PREFIX = 'серия: ждём остальные строки — ';

/**
 * LIS_REAL_ANALYZERS_V1_SERVICE — kind: вид сообщения (мигр. 233: result, qc,
 * calibration, query); resolved: строка разрешена сразу — служебное сообщение
 * хранится целиком (инвариант 2), но в лоток не попадает: экран берёт только
 * строки без resolved_at.
 */
export function recordMessage(db, { deviceId = null, peer = '', raw, sampleId = '', visitServiceId = null, status, detail = '', kind = 'result', resolved = false }) {
  return db.prepare(`INSERT INTO lab_device_messages
      (device_id, peer, raw, sample_id, visit_service_id, status, detail, kind, resolved_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? THEN strftime('%Y-%m-%dT%H:%M:%SZ','now') END)`)
    .run(deviceId, peer, String(raw == null ? '' : raw), sampleId, visitServiceId, status, detail, kind, resolved ? 1 : 0).lastInsertRowid;
}

/**
 * «Прибор на связи». Без этой отметки экран «Анализаторы» не отличит
 * работающий прибор от молчащего со вторника — а именно молчание и есть тот
 * отказ, который иначе длится неделю.
 */
export function touchDevice(db, deviceId) {
  if (!deviceId) return;
  db.prepare("UPDATE lab_devices SET last_seen_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?").run(deviceId);
}

export function resolveMessage(db, id) {
  db.prepare("UPDATE lab_device_messages SET resolved_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?").run(id);
}
