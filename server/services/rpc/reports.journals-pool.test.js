// JOURNALS_V1_SERVICE — массив service_ids доезжает до журнала и через пул
// потоков отчётов (V3120_PERF): вызов уходит в поток JSON-клоном, и массив
// обязан приехать массивом — как уже приезжает branch_ids.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { getRpc } from './index.js';
import { tmpDir, closeOnExit } from '../../test-helpers/tmpdir.js';
import { configureReportPool, shutdownReportPool, dispatchRpc, POOLED_RPCS } from '../report-pool.js';

const admin = { id: 9, role: 'admin', username: 'adm' };

test('пул потоков: массив service_ids доезжает до журнала, ответ — тот же, что без пула; отказ — тот же', async () => {
  const file = path.join(tmpDir('em-jpool-'), 'easymed.db');
  const db = closeOnExit(openDb(file));
  migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, role, full_name) VALUES (9, 'adm', 'x', 'admin', 'Админ')").run();
  db.prepare("INSERT INTO services (id, name, price) VALUES (1, 'УЗИ', 100000), (2, 'ЭКГ', 50000)").run();
  db.prepare("INSERT INTO patients (id, mrn, full_name) VALUES (1, 'P-1', 'Пациент Один')").run();
  db.prepare("INSERT INTO visits (id, patient_id, visit_date, status) VALUES (1, 1, '2026-03-10T07:00:00Z', 'arrived')").run();
  db.prepare(`INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total, status)
              VALUES (1, 1, 1, 100000, 100000, 'completed'), (1, 2, 1, 50000, 50000, 'completed')`).run();
  const args = { kind: 'service_journal', from: '2026-03-01', to: '2026-03-31', service_ids: [1] };
  const want = getRpc('run_report')(db, args, admin);
  assert.equal(want.rows.length, 1, 'журнал по одной услуге — одна строка');
  assert.ok(POOLED_RPCS.has('run_report'));
  assert.equal(configureReportPool({ db, dbFile: file }), true, 'пул не включился — база не в WAL?');
  try {
    assert.deepEqual(await dispatchRpc(db, 'run_report', getRpc('run_report'), args, admin), want);
    // JOURNALS_V1_ALL — пустой выбор — журнал по всем услугам, и через пул тот же ответ.
    const all = { ...args, service_ids: [] };
    const wantAll = getRpc('run_report')(db, all, admin);
    assert.equal(wantAll.rows.length, 2, 'ничего не выбрано — обе услуги');
    assert.deepEqual(await dispatchRpc(db, 'run_report', getRpc('run_report'), all, admin), wantAll);
    await assert.rejects(dispatchRpc(db, 'run_report', getRpc('run_report'), { ...args, service_ids: Array.from({ length: 2001 }, (_, i) => i + 1) }, admin),
      (e) => e.status === 400 && /не больше 2000/.test(e.message));
  } finally { await shutdownReportPool(); }
});
