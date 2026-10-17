// CRM_ONE_WAY_V1 (2026-10-17) — повтор ревью «r5/zz-r5-o8-all.test.js» (scratchpad crm-link-review), перенесён в клон:
// O8 на каждой настоящей старой базе ревью (r4/olddb — c20fb960^, r4/v316db — v3.16.0). Миграции (246, 248) и
// исправление: ни одна строка карточки не удалена, каждая изменённая — в журнале, строки визитов, счета и платежи
// побайтно те же, колонки 248 — 0, второй запуск ничего не делает.
// Базы в репозиторий не входят: каталог одного набора задаёт CRM_O8_OLD_DB (old-A.db … old-D.db); нет каталога или
// файла — тест пропускается с причиной. Каждая база копируется во временный каталог (em-o8-*).
//   CRM_O8_OLD_DB=…/r4/olddb  node --test server/routes/crm-one-way-r5-o8-all.test.js
//   CRM_O8_OLD_DB=…/r4/v316db node --test server/routes/crm-one-way-r5-o8-all.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { crmOneWayRepair } from '../services/crm/one-way-repair.js';
import { crmUnifyRepair } from '../services/crm/unify-repair.js';

const OLD = process.env.CRM_O8_OLD_DB || '';
const snap = (db, sql) => db.prepare(sql).all().map((r) => ({ ...r }));
const missing = (name) => (!OLD ? 'CRM_O8_OLD_DB не задан (каталог старых баз ревью r4)'
  : (fs.existsSync(path.join(OLD, name + '.db')) ? false : `нет ${name}.db в ${OLD}`));

for (const name of ['old-A', 'old-B', 'old-C', 'old-D']) {
  test(`CRM_ONE_WAY_V1 (повтор r5, O8-ALL ${name}): ничего не удалено, каждая правка в журнале, деньги не тронуты, колонки 248`, { skip: missing(name) }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-o8-'));
    const file = path.join(dir, name + '.db');
    fs.copyFileSync(path.join(OLD, name + '.db'), file);
    const db = openDb(file);
    try {
      const pre = snap(db, 'SELECT * FROM crm_request_services ORDER BY id');
      migrate(db);
      const cols = db.prepare('PRAGMA table_info(crm_request_services)').all().map((c) => c.name);
      assert.ok(['released_from_visit_id', 'released_vs_id', 'released_held', 'legacy_copy'].every((c) => cols.includes(c)));
      assert.ok(db.prepare('SELECT 1 FROM crm_one_way_repair WHERE id = 1 AND done_at IS NULL').get(), 'отметка исправления');
      try { crmUnifyRepair(db); } catch { /* как server/index.js */ }
      const before = snap(db, 'SELECT * FROM crm_request_services ORDER BY id');
      assert.equal(before.length, pre.length);
      assert.ok(before.every((r) => r.released_held === 0 && r.legacy_copy === 0));
      const vs0 = snap(db, 'SELECT * FROM visit_services ORDER BY id');
      const inv0 = snap(db, 'SELECT * FROM invoices ORDER BY id');
      const pay0 = snap(db, 'SELECT * FROM payments ORDER BY id');
      const out = crmOneWayRepair(db);
      assert.equal(out.failed, false);
      const after = snap(db, 'SELECT * FROM crm_request_services ORDER BY id');
      assert.deepEqual(after.map((r) => r.id), before.map((r) => r.id), 'строка карточки удалена');
      const logged = new Set(db.prepare('SELECT line_id FROM crm_one_way_repair_log').all().map((r) => r.line_id));
      const changed = after.filter((r, i) => JSON.stringify(r) !== JSON.stringify(before[i])).map((r) => r.id);
      console.log(`O8-ALL ${path.basename(OLD)}/${name}:`, JSON.stringify(out.counts), 'changed', JSON.stringify(changed), 'logged', JSON.stringify([...logged]));
      for (const id of changed) assert.ok(logged.has(id), 'изменённая строка ' + id + ' не в журнале');
      assert.deepEqual(snap(db, 'SELECT * FROM visit_services ORDER BY id'), vs0);
      assert.deepEqual(snap(db, 'SELECT * FROM invoices ORDER BY id'), inv0);
      assert.deepEqual(snap(db, 'SELECT * FROM payments ORDER BY id'), pay0);
      assert.equal(crmOneWayRepair(db).skipped, true, 'второй запуск');
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
