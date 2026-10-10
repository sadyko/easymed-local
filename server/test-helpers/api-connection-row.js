// CLINIC_API_STEP7_V1 — строка подключения API для тестов ЧУЖИХ правил (миграция,
// CRM, адрес для партнёров): ключ и секрет — заглушки с TESTONLY, мимо
// secret-box. Свой источник CRM, если подключение им владеет, заводится тут же.
import { randomBytes } from 'node:crypto';

export function insertConnectionRow(db, over = {}) {
  const row = {
    kind: 'partner', name: 'med24.uz', crm_source_key: 'api_med24_uz', owns_source: 1, active: 1,
    key_hash: randomBytes(32).toString('hex'), key_sealed: 'v1.TESTONLY.TESTONLY', key_tail: 'TEST',
    secret_sealed: 'v1.TESTONLY.TESTONLY', secret_tail: 'TEST',
    ...over,
  };
  if (row.owns_source && !db.prepare('SELECT 1 FROM crm_sources WHERE key = ?').get(row.crm_source_key)) {
    db.prepare('INSERT INTO crm_sources (key, label, position, is_active) VALUES (?, ?, 90, 1)').run(row.crm_source_key, row.name || 'x');
  }
  const cols = Object.keys(row);
  return Number(db.prepare(`INSERT INTO api_connections (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .run(...cols.map((c) => row[c])).lastInsertRowid);
}
