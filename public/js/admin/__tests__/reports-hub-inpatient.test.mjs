// INPATIENT_SHARE_V1 — карточка «Стационар: доля врачей» в «Отчётах».
//
// Карточка — это договор двух сторон: браузер зовёт run_report с kind из
// определения, сервер обязан такой kind знать. Разъехались — карточка
// открывается и молча показывает «unknown report kind». Поэтому проверяется
// и определение, и то, что сервер отвечает на этот kind колонками отчёта.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ICON_MAP } from '../icon-map.js';
import { openDb } from '../../../../server/db/connection.js';
import { migrate } from '../../../../server/db/migrate.js';
import { runReport } from '../../../../server/services/rpc/reports.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const hub = fs.readFileSync(path.join(ROOT, 'public', 'js', 'admin', 'views', 'reports-hub.js'), 'utf8');

test('карточка стационарной доли объявлена обычным табличным отчётом', () => {
  const i = hub.indexOf("kind:  'inpatient_share'");
  assert.ok(i > -1, 'карточка должна быть в REPORT_DEFS');
  const def = hub.slice(i, hub.indexOf('},', i));
  assert.match(def, /title:\s*'Стационар: доля врачей'/);
  assert.match(def, /icon:\s*'Bed'/);
  assert.ok(ICON_MAP.Bed, 'значок Bed есть в карте значков');
  // Табличный отчёт: ни своего RPC, ни режима графиков — общий run_report и Excel.
  assert.doesNotMatch(def, /rpc:|mode:/);
});

test('сервер знает этот kind и отдаёт колонки отчёта', () => {
  const db = openDb(':memory:');
  migrate(db);
  try {
    const r = runReport(db, { kind: 'inpatient_share', from: '2026-01-01', to: '2026-01-31' }, { id: 1, role: 'admin' });
    assert.equal(r.columns[0], 'Здание');
    for (const c of ['№ госпитализации', 'Врач', 'Чей врач', 'Ставка, %', 'Начислено врачу']) {
      assert.ok(r.columns.includes(c), 'нет колонки «' + c + '»');
    }
    assert.deepEqual(r.rows, []);
  } finally { db.close(); }
});
