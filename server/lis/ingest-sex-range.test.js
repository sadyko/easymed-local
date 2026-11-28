// LAB_FLAG_SEX_RANGE_V1 (владелец 2026-11-27) — ферритин 7.54 при женской норме
// 13–147 стоял «Норма». У ферритина (и гормонов) клиника заводит ТОЛЬКО нормы
// женщин/мужчин; общий ref_low/ref_high пуст, и приём прибора флаг не ставил.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { ingestMessage, sexRange } from './ingest.js';

const MSG = (obx) => [
  'MSH|^~\\&|BC-5300|Mindray|||20260910143943||ORU^R01|42|P|2.3.1',
  'OBR|1||LAB-000123|00001^Automated Count^99MRC',
  obx,
].join('\r');
const OBX = (value) => `OBX|1|NM|FER^^99MRC||${value}|ng/mL|||||F`;

function fresh(gender) {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare('INSERT INTO patients (id, full_name, gender) VALUES (3, ?, ?)').run('Пациент', gender);
  db.prepare("INSERT INTO visits (id, patient_id, visit_date, status) VALUES (55,3,'2026-09-10T09:00:00Z','scheduled')").run();
  db.prepare("INSERT INTO services (id, name, is_lab) VALUES (9,'Ферритин Ихла',1)").run();
  db.prepare("INSERT INTO visit_services (id, visit_id, service_id, status) VALUES (123,55,9,'in_progress')").run();
  db.prepare("INSERT INTO lab_devices (id, name, profile, transport, port) VALUES (1,'Прибор','mindray-bc-5300','mllp',2575)").run();
  db.prepare("INSERT INTO lab_panels (id, name, service_id, device_id) VALUES (5,'Ферритин',9,1)").run();
  db.prepare(`INSERT INTO lab_panel_analytes (panel_id, code, name, unit, sort_order, device_code, device_code_confirmed,
                ref_low, ref_high, ref_low_f, ref_high_f, ref_low_m, ref_high_m)
              VALUES (5,'FER','Ферритин','ng/mL',1,'FER',1, NULL, NULL, 13, 147, 30, 400)`).run();
  return db;
}
const row = (db) => db.prepare('SELECT * FROM lab_results WHERE visit_service_id = 123').get();

test('женщина, только женская норма: 7.54 при 13–147 — «Ниже», границы строки — женские', () => {
  const db = fresh('female');
  ingestMessage(db, MSG(OBX('7.54')), '127.0.0.1');
  const r = row(db);
  assert.equal(r.flag, 'low');
  assert.equal(r.ref_low, 13);
  assert.equal(r.ref_high, 147);
  assert.equal(r.reference_range, '13-147');
  db.close();
});

test('мужчина: то же число по мужской норме 30–400 — тоже «Ниже»; 50 — «Норма»', () => {
  let db = fresh('male');
  ingestMessage(db, MSG(OBX('20')), '127.0.0.1');
  assert.equal(row(db).flag, 'low');
  db.close();
  db = fresh('male');
  ingestMessage(db, MSG(OBX('50')), '127.0.0.1');
  assert.equal(row(db).flag, 'normal');
  db.close();
});

test('sexRange: своя норма пола, иначе общая; пол не указан — общая', () => {
  const a = { ref_low: 1, ref_high: 2, ref_low_f: 13, ref_high_f: 147, ref_low_m: null, ref_high_m: null };
  assert.deepEqual(sexRange(a, 'female'), { ref_low: 13, ref_high: 147 });
  assert.deepEqual(sexRange(a, 'male'), { ref_low: 1, ref_high: 2 }, 'мужской нормы нет — общая');
  assert.deepEqual(sexRange(a, ''), { ref_low: 1, ref_high: 2 });
  assert.deepEqual(sexRange(a, 'FEMALE'), { ref_low: 13, ref_high: 147 });
});
