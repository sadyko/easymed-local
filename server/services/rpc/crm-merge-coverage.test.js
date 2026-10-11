// PUBLIC_API_V1 — ревью 8a, I6: СТРАЖ «СЛИЯНИЕ КАРТОЧЕК CRM ПЕРЕНОСИТ ВСЁ, ЧТО НА НИХ
// УКАЗЫВАЕТ». Каждый внешний ключ схемы на crm_requests либо переносится на
// оставшуюся карточку в crmMergeLeads (UPDATE <таблица> SET <колонка> = ...), либо
// названа здесь с причиной. Новая таблица со ссылкой на карточку (как
// api_requests, мигр. 245 — ON DELETE SET NULL тихо отрывал заявку партнёра)
// без переноса валит этот тест.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NOT_MOVED = new Map([
  ['crm_request_tags.request_id', 'метки сливаются объединением (INSERT OR IGNORE … SELECT), метки проигравших уходят каскадом'],
]);

test('каждый внешний ключ на crm_requests переносится слиянием карточек', () => {
  const db = openDb(':memory:');
  migrate(db);
  const src = fs.readFileSync(path.join(HERE, 'crm-merge.js'), 'utf8');
  const refs = [];
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()) {
    for (const fk of db.prepare(`PRAGMA foreign_key_list("${name}")`).all()) if (fk.table === 'crm_requests') refs.push(`${name}.${fk.from}`);
  }
  assert.ok(refs.includes('api_requests.crm_request_id') && refs.includes('crm_request_services.request_id'), JSON.stringify(refs));
  const missing = refs.filter((ref) => {
    if (NOT_MOVED.has(ref)) return false;
    const [table, col] = ref.split('.');
    return !new RegExp(String.raw`UPDATE\s+${table}\s+SET\s+${col}\s*=`).test(src);
  });
  assert.deepEqual(missing, [], 'слияние не переносит: ' + missing.join(', '));
  for (const ref of NOT_MOVED.keys()) assert.ok(refs.includes(ref), 'в списке исключений лишнее: ' + ref);
});
