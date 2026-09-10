// LIS_INGEST_V1 — лоток входящих сообщений.
//
// Инвариант 2: каждое сообщение, дошедшее до порта, сохраняется сырым, чем бы
// дело ни кончилось. Смазанный штрихкод обязан стоить клика, а не повторного
// забора крови у пациента.
//
// Таблица закрыта на запись из браузера (реестр схемы): её строки —
// свидетельство о том, что пришло по проводу, и правка их из интерфейса
// превратила бы журнал в пересказ.

export function recordMessage(db, { deviceId = null, peer = '', raw, sampleId = '', visitServiceId = null, status, detail = '' }) {
  return db.prepare(`INSERT INTO lab_device_messages
      (device_id, peer, raw, sample_id, visit_service_id, status, detail)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(deviceId, peer, String(raw == null ? '' : raw), sampleId, visitServiceId, status, detail).lastInsertRowid;
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
