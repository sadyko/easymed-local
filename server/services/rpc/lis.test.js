import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { lisProfiles, lisMessageAttach, lisMessageDismiss } from './lis.js';

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

const LAB = { role: 'lab' };

test('лаборатория видит профили, регистратура — нет', () => {
  const db = fresh();
  assert.ok(lisProfiles(db, {}, LAB).length >= 4);
  assert.ok(lisProfiles(db, {}, { role: 'admin' }).length >= 4);
  assert.throws(() => lisProfiles(db, {}, { role: 'reception' }), /прав/);
  assert.throws(() => lisProfiles(db, {}, null), /прав/);
  db.close();
});

test('профиль отдаёт каналы — редактор панелей строит из них выпадающий список', () => {
  const db = fresh();
  const bc = lisProfiles(db, {}, LAB).find((p) => p.key === 'mindray-bc-5300');
  assert.equal(bc.channels.length, 27);
  assert.equal(bc.defaultPort, 2575);
  db.close();
});

test('разбор лотка требует номера и отказывает по несуществующему сообщению', () => {
  const db = fresh();
  assert.throws(() => lisMessageDismiss(db, {}, LAB), /номер/);
  assert.throws(() => lisMessageDismiss(db, { id: 999 }, LAB), /не найдено/);
  assert.throws(() => lisMessageAttach(db, { id: 1 }, LAB), /номер/);
  db.close();
});

test('привязка прогоняет ТОТ ЖЕ приём: неподтверждённое сопоставление так и не применяется', () => {
  const db = fresh();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (7,'lab','x','Л','lab')").run();
  db.prepare("INSERT INTO patients (id, full_name) VALUES (3,'Иванов')").run();
  db.prepare("INSERT INTO visits (id, patient_id, visit_date, status) VALUES (55,3,'2026-09-10T09:00:00Z','scheduled')").run();
  db.prepare("INSERT INTO services (id, name, is_lab) VALUES (9,'ОАК',1)").run();
  db.prepare("INSERT INTO visit_services (id, visit_id, service_id, status) VALUES (77,55,9,'in_progress')").run();
  db.prepare("INSERT INTO lab_devices (id, name, profile) VALUES (1,'Гем','mindray-bc-5300')").run();
  db.prepare("INSERT INTO lab_panels (id, name, service_id, device_id) VALUES (5,'ОАК',9,1)").run();
  // Сопоставление НЕ подтверждено — решение владельца D4 обязано устоять и на
  // ручной привязке, иначе лоток стал бы обходом собственного запрета.
  db.prepare(`INSERT INTO lab_panel_analytes (panel_id, code, name, unit, device_code, device_code_confirmed)
              VALUES (5,'WBC','Лейкоциты','10^9/л','WBC',0)`).run();

  const raw = [
    'MSH|^~\\&|BC-5300|Mindray|||20260910143943||ORU^R01|42|P|2.3.1',
    'OBR|1||LAB-999999|00001^Automated Count^99MRC',
    'OBX|1|NM|WBC^^99MRC||6.1|10*9/L|||||F',
  ].join('\r');
  db.prepare("INSERT INTO lab_device_messages (device_id, peer, raw, sample_id, status) VALUES (1,'127.0.0.1',?, 'LAB-999999','unmatched')").run(raw);

  const out = lisMessageAttach(db, { id: 1, visit_service_id: 77 }, LAB);
  assert.equal(out.ok, true, 'сообщение принято');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM lab_results WHERE visit_service_id = 77').get().c, 0,
    'неподтверждённое сопоставление не применяется даже при ручной привязке');
  assert.ok(db.prepare('SELECT resolved_at FROM lab_device_messages WHERE id = 1').get().resolved_at,
    'разобранная строка обязана перестать требовать внимания');
  db.close();
});

test('подтверждённое сопоставление применяется при ручной привязке', () => {
  const db = fresh();
  db.prepare("INSERT INTO patients (id, full_name) VALUES (3,'Иванов')").run();
  db.prepare("INSERT INTO visits (id, patient_id, visit_date, status) VALUES (55,3,'2026-09-10T09:00:00Z','scheduled')").run();
  db.prepare("INSERT INTO services (id, name, is_lab) VALUES (9,'ОАК',1)").run();
  db.prepare("INSERT INTO visit_services (id, visit_id, service_id, status) VALUES (77,55,9,'in_progress')").run();
  db.prepare("INSERT INTO lab_devices (id, name, profile) VALUES (1,'Гем','mindray-bc-5300')").run();
  db.prepare("INSERT INTO lab_panels (id, name, service_id, device_id) VALUES (5,'ОАК',9,1)").run();
  db.prepare(`INSERT INTO lab_panel_analytes (panel_id, code, name, unit, device_code, device_code_confirmed)
              VALUES (5,'WBC','Лейкоциты','10^9/л','WBC',1)`).run();

  const raw = [
    'MSH|^~\\&|BC-5300|Mindray|||20260910143943||ORU^R01|42|P|2.3.1',
    'OBR|1||LAB-999999|00001^Automated Count^99MRC',
    'OBX|1|NM|WBC^^99MRC||6.1|10*9/L|||||F',
  ].join('\r');
  db.prepare("INSERT INTO lab_device_messages (device_id, peer, raw, sample_id, status) VALUES (1,'127.0.0.1',?, 'LAB-999999','unmatched')").run(raw);

  lisMessageAttach(db, { id: 1, visit_service_id: 77 }, LAB);
  const rows = db.prepare('SELECT * FROM lab_results WHERE visit_service_id = 77').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].parameter, 'Лейкоциты');
  assert.equal(rows[0].source, 'analyzer');
  db.close();
});
