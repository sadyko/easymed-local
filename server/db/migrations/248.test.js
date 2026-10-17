// CRM_ONE_WAY_V1 (мигр. 248, ревью r4) — только ADD COLUMN в crm_request_services: released_held
// (O5 — отпущенная строка держала визит без строки визита) и legacy_copy (O8 — отметка копии
// прежнего зеркала). Обе по умолчанию 0 у новых и прежних строк; запись двери /api/db их не знает.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { REGISTRY } from '../schema-registry.js';

test('мигр. 248: released_held и legacy_copy — 0 по умолчанию; дверь /api/db их не пишет и не читает', () => {
  const db = openDb(':memory:');
  migrate(db);
  const cols = new Map(db.prepare('PRAGMA table_info(crm_request_services)').all().map((c) => [c.name, c]));
  for (const name of ['released_held', 'legacy_copy']) {
    assert.ok(cols.has(name), 'нет колонки ' + name);
    assert.equal(cols.get(name).notnull, 1);
    assert.equal(String(cols.get(name).dflt_value), '0');
  }
  const t = REGISTRY.crm_request_services;
  const listed = JSON.stringify([t.read, t.write.insert, t.write.update, t.filters]);
  assert.doesNotMatch(listed, /released_held|legacy_copy/, 'колонки сервера открыты двери /api/db');
});
