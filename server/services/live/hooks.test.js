// LIVE_REFRESH_V1 (3.22.0, владелец 2026-11-08) — записи МИМО /api/db и RPC тоже будят
// экраны: приём из другого здания (обмен филиалов) и результат анализатора (LIS).
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { createLiveBus } from './bus.js';
import { applyBatch } from '../branch-sync/records.js';
import { receiveMessage } from '../../lis/receive.js';

function fresh(t) {
  const db = openDb(':memory:');
  migrate(db);
  t.after(() => db.close());
  return db;
}

test('обмен филиалов: принятая порция — событие с её таблицами (и с ненаблюдаемыми — их называет приём)', (t) => {
  const db = fresh(t);
  db.prepare('DELETE FROM sync_journal').run();
  const bus = createLiveBus(db, { coalesceMs: 10_000 });
  const stamp = Math.floor(Date.now() - 3600000).toString(16).padStart(12, '0') + '-0000-C';
  const stats = applyBatch(db, [{ tbl: 'patients', uid: 'live1', op: 'put', stamp, data: { full_name: 'Приезжий', phone: '+998900000001' }, refs: {}, origin: 'C' }], { self: 'B' });
  assert.equal(stats.applied, 1);
  const ev = bus.flush();
  assert.ok(ev, 'событие есть');
  assert.ok(ev.tables.includes('patients'), 'patients не наблюдается триггерами — его назвал сам приём: ' + JSON.stringify(ev));
  assert.ok(!JSON.stringify(ev).includes('Приезжий'), 'данных строки в событии нет');
});

test('обмен филиалов: пустая или повторная порция — событий нет', (t) => {
  const db = fresh(t);
  const bus = createLiveBus(db, { coalesceMs: 10_000 });
  applyBatch(db, [], { self: 'B' });
  assert.equal(bus.flush(), null);
});

test('анализатор: результат, легший в бланк, — событие lab_results от самого приёма (receive.js), без перехвата базой', (t) => {
  const db = fresh(t);
  db.prepare("INSERT INTO patients (id, full_name) VALUES (3,'Пациент Анализа')").run();
  db.prepare("INSERT INTO visits (id, patient_id, visit_date, status) VALUES (55,3,'2026-10-01T09:00:00Z','scheduled')").run();
  db.prepare("INSERT INTO services (id, name, is_lab) VALUES (9,'Общий анализ крови',1)").run();
  db.prepare("INSERT INTO visit_services (id, visit_id, service_id, status) VALUES (1,55,9,'in_progress')").run();
  db.prepare("INSERT INTO lab_devices (id, name, profile, transport, port) VALUES (1,'Гематология','mindray-bc-5300','mllp',2575)").run();
  db.prepare("INSERT INTO lab_panels (id, name, service_id, device_id) VALUES (5,'ОАК',9,1)").run();
  db.prepare(`INSERT INTO lab_panel_analytes (panel_id, code, name, unit, sort_order, device_code, device_code_confirmed)
              VALUES (5,'WBC','Лейкоциты','10^9/л',1,'WBC',1)`).run();
  // Ревью L6 — без перехвата базой (watch: []): событие может дать только явный вызов
  // liveBump в server/lis/receive.js. Уберут его — тест краснеет (с перехватом
  // lab_results поймали бы триггеры, и пропажа вызова прошла бы незамеченной).
  const bus = createLiveBus(db, { coalesceMs: 10_000, watch: [] });
  assert.equal(bus.capture, false, 'перехват выключен — проверяется сам вызов в receive.js');
  const oru = [
    'MSH|^~\\&|BC-5300|Mindray|||20260910143943||ORU^R01|42|P|2.3.1',
    'OBR|1||LAB-000001|00001^Automated Count^99MRC',
    'OBX|1|NM|WBC^^99MRC||6.1|10*9/L|||||F',
  ].join('\r');
  const out = receiveMessage(db, oru, { peer: '10.0.0.9', deviceId: 1 });
  assert.equal(out.code, 'AA');
  assert.ok(db.prepare('SELECT COUNT(*) AS n FROM lab_results WHERE visit_service_id = 1').get().n > 0, 'результат лёг');
  const ev = bus.flush();
  assert.ok(ev && ev.tables.includes('lab_results'), JSON.stringify(ev));
  assert.ok(!JSON.stringify(ev).includes('6.1'), 'значения результата в событии нет');
});
