// RX_TEMPLATES_V1 (2026-10-02) — rx_my_drugs: «СВОИ» ПРЕПАРАТЫ ВРАЧА.
//
// Владелец: «we need to add in to a doctors cabinet the reciept saving option
// for the drugs» — и решение «Both»: шаблоны целого рецепта и подсказки своих
// препаратов при вводе названия. Источник подсказок номер один — препараты из
// рецептов, которые ЭТОТ врач уже сохранял (visit_services.notes →
// prescriptions), самые частые первыми, с дозой, частотой и длительностью.
// Отдельного экрана «избранного» нет: список складывается из работы врача.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { rxMyDrugs } from './rx.js';
import { getRpc } from './index.js';
import { isReadOnlyRpc } from '../control/gate.js';

function seed() {
  const db = openDb(':memory:');
  migrate(db);
  db.exec(`
    INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES
      (1, 'doc',   'x', 'Каримова Азиза', 'doctor', 1),
      (2, 'doc2',  'x', 'Юсупов Бахтиёр', 'doctor', 1),
      (3, 'admin', 'x', 'Администратор',  'admin',  1),
      (4, 'nurse', 'x', 'Медсестра',      'nurse',  0),
      (5, 'reg',   'x', 'Регистратура',   'registrar', 0);
    INSERT INTO patients (id, full_name) VALUES (1, 'Азизов Бахтиёр');
    INSERT INTO services (id, name, price) VALUES (1, 'Консультация терапевта', 100000);
    INSERT INTO visits (id, patient_id, visit_date) VALUES (1, 1, '2026-09-01T07:00:00Z');
  `);
  return db;
}
let vsId = 100;
function rx(db, doctorId, list, extra = {}) {
  const notes = typeof list === 'string' ? list
    : JSON.stringify({ __service_workspace_v1: 1, current: {}, history: [], prescriptions: list, ...extra });
  db.prepare("INSERT INTO visit_services (id, visit_id, service_id, doctor_id, quantity, unit_price, total, status, notes) VALUES (?, 1, 1, ?, 1, 100000, 100000, 'completed', ?)")
    .run(++vsId, doctorId, notes);
}
const doc = { id: 1, role: 'doctor', extra_roles: [] };

test('rx_my_drugs: только препараты из МОИХ рецептов, частые первыми, с дозой, частотой и длительностью последнего', () => {
  const db = seed();
  rx(db, 1, [{ name: 'Амоксициллин', dose: '250 мг', freq: '2 раза в день', dur: '5 дней' }]);
  rx(db, 1, [{ name: 'Парацетамол', dose: '500 мг', freq: 'при t > 38,5', dur: '' }]);
  rx(db, 1, [{ name: 'амоксициллин ', dose: '500 мг', freq: '3 раза в день', dur: '7 дней' }, { name: 'Лоратадин', dose: '10 мг' }]);
  rx(db, 1, [{ name: 'Амоксициллин', dose: '500 мг', freq: '3 раза в день', dur: '7 дней', notes: 'после еды' }]);
  rx(db, 2, [{ name: 'Цефтриаксон', dose: '1 г' }, { name: 'Цефтриаксон', dose: '1 г' }, { name: 'Цефтриаксон', dose: '1 г' }, { name: 'Цефтриаксон', dose: '1 г' }]);   // чужие
  const { rows } = rxMyDrugs(db, {}, doc);
  assert.deepEqual(rows.map((r) => r.name), ['Амоксициллин', 'Лоратадин', 'Парацетамол'],
    'не мои препараты в списке, или частые не первыми (при равенстве — по алфавиту)');
  const amox = rows[0];
  assert.equal(amox.count, 3, 'регистр и пробелы — один и тот же препарат');
  assert.deepEqual({ dose: amox.dose, freq: amox.freq, dur: amox.dur }, { dose: '500 мг', freq: '3 раза в день', dur: '7 дней' },
    'доза, частота и длительность — из последнего рецепта');
  assert.equal(rows.find((r) => r.name === 'Парацетамол').dur, '');
});

test('rx_my_drugs: сломанная запись, текст вместо JSON и пустые строки рецепта не валят список', () => {
  const db = seed();
  rx(db, 1, '{не json');
  rx(db, 1, 'Свободный текст лаборатории');
  rx(db, 1, [{ name: '' }, null, { dose: '1 мг' }, { name: 'Омепразол', dose: '20 мг' }]);
  rx(db, 1, JSON.stringify({ __service_workspace_v1: 1, prescriptions: 'не массив' }));
  const { rows } = rxMyDrugs(db, {}, doc);
  assert.deepEqual(rows.map((r) => r.name), ['Омепразол']);
});

test('rx_my_drugs: не больше 200 строк', () => {
  const db = seed();
  for (let i = 0; i < 25; i++) rx(db, 1, Array.from({ length: 10 }, (_, j) => ({ name: 'Препарат ' + (i * 10 + j), dose: '1' })));
  assert.equal(rxMyDrugs(db, {}, doc).rows.length, 200);
  assert.equal(rxMyDrugs(db, { limit: 20 }, doc).rows.length, 20, 'меньший предел экрана не соблюдён');
  assert.equal(rxMyDrugs(db, { limit: 5000 }, doc).rows.length, 200, 'предел экрана выше 200 принят');
});

test('rx_my_drugs: врач или администратор; медсестре и регистратуре — отказ', () => {
  const db = seed();
  rx(db, 3, [{ name: 'Ибупрофен', dose: '400 мг' }]);
  assert.deepEqual(rxMyDrugs(db, {}, { id: 3, role: 'admin', extra_roles: [] }).rows.map((r) => r.name), ['Ибупрофен'], 'администратор-врач — свои');
  for (const u of [{ id: 4, role: 'nurse' }, { id: 5, role: 'registrar' }]) {
    assert.throws(() => rxMyDrugs(db, {}, { ...u, extra_roles: [] }), (e) => e.status === 403, u.role + ' получил список');
  }
  // врач, у которого основная роль другая, но в карточке «Врач» (is_doctor)
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (6, 'nd', 'x', 'Врач-медсестра', 'nurse', 1)").run();
  assert.deepEqual(rxMyDrugs(db, {}, { id: 6, role: 'nurse', extra_roles: [] }).rows, []);
  assert.throws(() => rxMyDrugs(db, {}, null), (e) => e.status === 403);
});

test('rx_my_drugs зарегистрирован, только читает (READ_ONLY_RPCS) и отдаётся через карту RPC', () => {
  const db = seed();
  rx(db, 1, [{ name: 'Амоксициллин', dose: '500 мг' }]);
  assert.equal(typeof getRpc('rx_my_drugs'), 'function', 'нет в карте RPC — экран получит 501');
  assert.deepEqual(getRpc('rx_my_drugs')(db, {}, doc).rows.map((r) => r.name), ['Амоксициллин']);
  assert.equal(isReadOnlyRpc('rx_my_drugs'), true, 'клиника с просроченной лицензией не увидит подсказок');
});
