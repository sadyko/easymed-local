// DOCTOR_LINES_SPECIALTY_V1 (владелец, 26.09) — «in the by-doctor report there
// should be the list of the services provided by the doctor one by one» и
// «another report by specialty: which services are provided by which specialty
// and amount».
//
// Проверяется на НАСТОЯЩИХ отчётах:
//   * «Детализация» (doctor_lines) — строка на каждую строку выплаты, из того же
//     источника, что выплата врачу: сумма долей врача = «По врачам» = «Зарплаты
//     врачей» = кабинет (doctor_pay_summary);
//   * фильтр врача (doctor_id) — у детализации и у «Врачей и услуг», в SQL;
//   * report_choices — список врачей для фильтра, за теми же воротами отчёта;
//   * «По специальностям» (by_specialty) — основная специальность исполнителя
//     через общий канонизатор (ЛОР и «Оториноларинголог (ЛОР)» — одна группа),
//     «Без врача (лаборатория и др.)», «Специальность не указана», подытоги
//     примечаниями, доля врачей в сумме = выплате.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { runReport, doctorPaySummary, reportChoices } from './reports.js';
import { RPC } from './index.js';
import { isReadOnlyRpc } from '../control/gate.js';
import { specialtyGroupName, canonicalSpecialty } from '../../../public/js/shared/specialty-list.js';

const admin = { id: 9, role: 'admin' };
const FROM = '2026-09-01';
const TO = '2026-09-30';
const DAY = '2026-09-10T09:00:00Z';

// Клиника:
//   1 «Сердцев» — Кардиолог, 30 % за приём;
//   2 «Ухов» — «ЛОР» (старое имя), 10 % по умолчанию, стационар 10 % за приём;
//   3 «Носов» — «Оториноларинголог (ЛОР)» (старое имя), 20 % по умолчанию;
//   4 «Безымянный» — специальности нет, 10 % по умолчанию;
//   9 администратор.
// Приём 100 000 (без налога), анализ крови 50 000 (лаборатория).
function clinic() {
  const db = openDb(':memory:');
  migrate(db);
  const u = db.prepare(`INSERT INTO users (id, username, password_hash, role, full_name, is_doctor, specialty,
                          service_rates, service_rate_default, inpatient_rates)
                        VALUES (?,?,?,?,?,?,?,?,?,?)`);
  u.run(1, 'serd', 'x', 'doctor', 'Сердцев С.', 1, 'Кардиолог', JSON.stringify([{ service_id: 1, pct: 30 }]), 0, '');
  u.run(2, 'uhov', 'x', 'doctor', 'Ухов У.', 1, 'ЛОР', '', 10, JSON.stringify([{ service_id: 1, pct: 10 }]));
  u.run(3, 'nosov', 'x', 'doctor', 'Носов Н.', 1, 'Оториноларинголог (ЛОР)', '', 20, '');
  u.run(4, 'bez', 'x', 'doctor', 'Безымянный Б.', 1, '', '', 10, '');
  u.run(9, 'adm', 'x', 'admin', 'Администратор', 0, '', '', 0, '');
  db.prepare("INSERT INTO patients (id, mrn, full_name) VALUES (1,'P-1','Азизов А.'), (2,'P-2','Каримова К.')").run();
  db.prepare("INSERT INTO services (id, name, price, tax_rate, type) VALUES (1,'Приём',100000,0,'consultation')").run();
  db.prepare("INSERT INTO services (id, name, price, tax_rate, type, is_lab) VALUES (2,'Анализ крови',50000,0,'lab',1)").run();
  db.prepare("INSERT INTO service_templates (id, name, service_ids, discount_percent) VALUES (1,'Пакет «Сердце»','[1]',20)").run();
  let seq = 0;
  const line = ({ doctor = 1, service = 1, status = 'completed', invoice = null, discount = 0, price = 100000,
                  patient = 1, pkg = null, at = DAY } = {}) => {
    const id = ++seq;
    db.prepare("INSERT INTO visits (id, patient_id, visit_date, status) VALUES (?,?,?,'scheduled')").run(id, patient, at);
    db.prepare(`INSERT INTO visit_services (id, visit_id, service_id, doctor_id, quantity, unit_price, total, status, package_id)
                VALUES (?,?,?,?,1,?,?,?,?)`).run(id, id, service, doctor, price, price, status, pkg);
    if (invoice) {
      const total = price - discount;
      db.prepare(`INSERT INTO invoices (id, invoice_number, visit_id, patient_id, subtotal, discount_amount, total_amount, paid_amount, status, created_at)
                  VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, 'INV-' + id, id, patient, price, discount, total, invoice === 'paid' ? total : 0, invoice, at);
      db.prepare(`INSERT INTO invoice_items (id, invoice_id, service_id, description, quantity, unit_price, total)
                  VALUES (?,?,?,'—',1,?,?)`).run(id, id, service, price, price);
      db.prepare('UPDATE visit_services SET invoice_item_id = ? WHERE id = ?').run(id, id);
    }
    return id;
  };
  line({ doctor: 1, invoice: 'paid' });                        // 30 000
  line({ doctor: 1 });                                         // без счёта: 30 000
  line({ doctor: 1, pkg: 1, patient: 2 });                     // пакет −20 %: 30 % от 80 000 = 24 000
  line({ doctor: 2, invoice: 'unpaid', discount: 10000 });     // 10 % от 90 000 = 9 000
  line({ doctor: 3, status: 'in_progress' });                  // 20 000
  line({ doctor: 4, patient: 2 });                             // 10 000
  line({ doctor: null, service: 2, status: 'resulted', invoice: 'paid', price: 50000 });   // без врача
  line({ doctor: 1, status: 'added' });                        // не выполнено — нигде
  // Стационар: исполнитель 2, приём выполнен, счёта нет → 10 % от 100 000.
  db.prepare("INSERT INTO admissions (id, admission_no, patient_id, doctor_id, status) VALUES (1,'A-1',1,2,'active')").run();
  db.prepare(`INSERT INTO admission_services (id, admission_id, service_id, doctor_id, performer_id, quantity, unit_price, total, status, billable, performed_at)
              VALUES (1,1,1,2,2,1,100000,100000,'added',1,'2026-09-11T09:00:00Z')`).run();
  return { db, line };
}

const run = (db, kind, extra = {}, user = admin) => runReport(db, { kind, from: FROM, to: TO, ...extra }, user);
const objects = (r) => r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c, row[i]])));
const sum = (list, col) => Math.round(list.reduce((n, o) => n + (Number(o[col]) || 0), 0) * 100) / 100;
const FEES = { 'Сердцев С.': 84000, 'Ухов У.': 19000, 'Носов Н.': 20000, 'Безымянный Б.': 10000 };

// ─── 1. ДЕТАЛИЗАЦИЯ ──────────────────────────────────────────────────────────

test('детализация: строка на каждую выполненную строку выплаты, с датой, пациентом, счётом и долей', () => {
  const { db } = clinic();
  const r = run(db, 'doctor_lines');
  assert.deepEqual(r.columns, ['Здание', 'Дата', 'Врач', 'Пациент', 'Карта', 'Услуга', 'Где', 'Кол-во',
    'Сумма после скидки', '№ счёта', 'Статус счёта', 'Оплачено (доля оплаты счёта)', 'Ставка', 'Доля врача']);
  const rows = objects(r);
  // 6 амбулаторных строк врачей + 1 стационарная; строка без врача и «добавленная» — нет.
  assert.equal(rows.length, 7);
  const paid = rows.find((o) => o['№ счёта'] === 'INV-1');
  assert.equal(paid['Дата'], '2026-09-10');
  assert.equal(paid['Врач'], 'Сердцев С.');
  assert.equal(paid['Пациент'], 'Азизов А.');
  assert.equal(paid['Карта'], 'P-1');
  assert.equal(paid['Услуга'], 'Приём');
  assert.equal(paid['Где'], 'Амбулатория');
  assert.equal(paid['Сумма после скидки'], 100000);
  assert.equal(paid['Статус счёта'], 'Оплачен');
  assert.equal(paid['Оплачено (доля оплаты счёта)'], 100000);
  assert.equal(paid['Ставка'], '30 %');
  assert.equal(paid['Доля врача'], 30000);
  // Строка без счёта: «Нет счёта», оплачено 0, доля есть.
  const unbilled = rows.filter((o) => o['Врач'] === 'Сердцев С.' && o['Статус счёта'] === 'Нет счёта');
  assert.equal(unbilled.length, 2);
  assert.ok(unbilled.every((o) => o['№ счёта'] === '' && o['Оплачено (доля оплаты счёта)'] === 0));
  // Пакет: сумма после скидки пакета и доля с неё.
  const pkg = unbilled.find((o) => o['Пациент'] === 'Каримова К.');
  assert.equal(pkg['Сумма после скидки'], 80000);
  assert.equal(pkg['Доля врача'], 24000);
  // Скидка счёта.
  const disc = rows.find((o) => o['№ счёта'] === 'INV-4');
  assert.equal(disc['Сумма после скидки'], 90000);
  assert.equal(disc['Статус счёта'], 'Не оплачен');
  assert.equal(disc['Ставка'], '10 %');
  assert.equal(disc['Доля врача'], 9000);
  // Стационар.
  const inp = rows.find((o) => o['Где'] === 'Стационар');
  assert.equal(inp['Врач'], 'Ухов У.');
  assert.equal(inp['Дата'], '2026-09-11');
  assert.equal(inp['Ставка'], '10 %');
  assert.equal(inp['Доля врача'], 10000);
});

test('детализация: ставка-фикс словами', () => {
  const { db } = clinic();
  db.prepare("UPDATE users SET service_rates = ? WHERE id = 3").run(JSON.stringify([{ service_id: 1, fix: 15000 }]));
  const row = objects(run(db, 'doctor_lines')).find((o) => o['Врач'] === 'Носов Н.');
  assert.equal(row['Ставка'], 'фикс 15 000');
  assert.equal(row['Доля врача'], 15000);
});

// ─── 2. РАВЕНСТВО ВЫПЛАТЕ ────────────────────────────────────────────────────

test('сумма долей по врачу в детализации = «По врачам» = «Зарплаты врачей» = кабинет', () => {
  const { db } = clinic();
  const lines = objects(run(db, 'doctor_lines'));
  const byDoctors = objects(run(db, 'by_doctors'));
  const salaries = objects(run(db, 'doctor_salaries'));
  for (const [name, fee] of Object.entries(FEES)) {
    const mine = lines.filter((o) => o['Врач'] === name);
    assert.equal(sum(mine, 'Доля врача'), fee, name + ': детализация');
    const bd = byDoctors.find((o) => o['Врач'] === name);
    assert.equal(bd['Доля за услуги'] + bd['Стационарная доля'], fee, name + ': «По врачам»');
    assert.equal(salaries.find((o) => o['Врач'] === name)['Итого к выплате'], fee, name + ': «Зарплаты врачей»');
    const id = db.prepare('SELECT id FROM users WHERE full_name = ?').get(name).id;
    const s = doctorPaySummary(db, { doctor_id: id, from: FROM, to: TO }, admin);
    assert.equal(s.outpatient.fee + s.inpatient.fee, fee, name + ': кабинет');
    // Количество строк — тоже то же.
    assert.equal(mine.length, s.lines.length, name + ': строк');
  }
});

// ─── 3. ФИЛЬТР ВРАЧА ─────────────────────────────────────────────────────────

test('фильтр врача: только его строки — в детализации и во «Врачах и услугах»', () => {
  const { db } = clinic();
  const lines = objects(run(db, 'doctor_lines', { doctor_id: 2 }));
  assert.equal(lines.length, 2);
  assert.ok(lines.every((o) => o['Врач'] === 'Ухов У.'));
  assert.equal(sum(lines, 'Доля врача'), 19000);
  const ds = objects(run(db, 'doctor_services', { doctor_id: '1' }));
  assert.ok(ds.length > 0 && ds.every((o) => o['Врач'] === 'Сердцев С.'));
  assert.equal(sum(ds, 'Доля врача'), 84000);
  // Пусто и «all» — без фильтра.
  assert.equal(objects(run(db, 'doctor_lines', { doctor_id: '' })).length, 7);
  assert.equal(objects(run(db, 'doctor_lines', { doctor_id: 'all' })).length, 7);
});

test('фильтр врача: мусор — 400, а не «все врачи»', () => {
  const { db } = clinic();
  for (const bad of ['abc', -1, 0, 1.5]) {
    assert.throws(() => run(db, 'doctor_lines', { doctor_id: bad }), (e) => e.status === 400, String(bad));
  }
});

test('report_choices: врачи для фильтра, за воротами группы отчёта; RPC зарегистрирован и только читает', () => {
  const { db } = clinic();
  const r = reportChoices(db, { kind: 'doctor_lines', arg: 'doctor_id' }, admin);
  const names = r.choices.map((c) => c[1]);
  assert.deepEqual(names, ['Безымянный Б.', 'Носов Н.', 'Сердцев С.', 'Ухов У.']);
  assert.equal(r.choices.find((c) => c[1] === 'Ухов У.')[0], '2');
  // Кто отчёт не видит — не видит и список.
  const nurse = { id: 50, role: 'nurse' };
  db.prepare("INSERT INTO users (id, username, password_hash, role, full_name) VALUES (50,'n','x','nurse','Сестра')").run();
  assert.throws(() => reportChoices(db, { kind: 'doctor_lines', arg: 'doctor_id' }, nurse));
  assert.throws(() => reportChoices(db, { kind: 'nope', arg: 'doctor_id' }, admin), (e) => e.status === 400);
  assert.throws(() => reportChoices(db, { kind: 'doctor_lines', arg: 'nope' }, admin), (e) => e.status === 400);
  assert.equal(typeof RPC.report_choices, 'function');
  assert.equal(isReadOnlyRpc('report_choices'), true);
});

// ─── 4. ПО СПЕЦИАЛЬНОСТЯМ ────────────────────────────────────────────────────

test('канонизатор специальностей общий: старые имена и регистр — одно имя', () => {
  assert.equal(canonicalSpecialty('ЛОР'), 'Отоларинголог (ЛОР)');
  assert.equal(specialtyGroupName('ЛОР'), 'Отоларинголог (ЛОР)');
  assert.equal(specialtyGroupName(' Оториноларинголог (ЛОР) '), 'Отоларинголог (ЛОР)');
  assert.equal(specialtyGroupName('кардиолог'), 'Кардиолог');
  assert.equal(specialtyGroupName('лор'), 'Отоларинголог (ЛОР)');
  assert.equal(specialtyGroupName('Мой особый'), 'Мой особый');
  assert.equal(specialtyGroupName(''), '');
  assert.equal(specialtyGroupName(null), '');
});

test('по специальностям: основная специальность исполнителя, ЛОР — одной группой, без врача и без специальности — отдельно', () => {
  const { db } = clinic();
  const r = run(db, 'by_specialty');
  assert.deepEqual(r.columns, ['Здание', 'Специальность', 'Услуга', 'Где', 'Кол-во', 'Пациентов',
    'Сумма после скидки', 'Оплачено (доля оплаты счёта)', 'Доля врача']);
  const rows = objects(r);
  const of = (spec) => rows.filter((o) => o['Специальность'] === spec);
  // Кардиолог: три приёма, два пациента, 100 000 + 100 000 + 80 000.
  const card = of('Кардиолог');
  assert.equal(card.length, 1);
  assert.equal(card[0]['Кол-во'], 3);
  assert.equal(card[0]['Пациентов'], 2);
  assert.equal(card[0]['Сумма после скидки'], 280000);
  assert.equal(card[0]['Оплачено (доля оплаты счёта)'], 100000);
  assert.equal(card[0]['Доля врача'], 84000);
  // ЛОР: Ухов («ЛОР») и Носов («Оториноларинголог (ЛОР)») — одна специальность.
  const lor = of('Отоларинголог (ЛОР)');
  const lorOut = lor.find((o) => o['Где'] === 'Амбулатория');
  const lorIn = lor.find((o) => o['Где'] === 'Стационар');
  assert.equal(lorOut['Кол-во'], 2);
  assert.equal(lorOut['Сумма после скидки'], 190000);
  assert.equal(lorOut['Доля врача'], 29000);
  assert.equal(lorIn['Доля врача'], 10000);
  assert.equal(of('ЛОР').length, 0);
  assert.equal(of('Оториноларинголог (ЛОР)').length, 0);
  // Без специальности и без врача.
  assert.equal(of('Специальность не указана')[0]['Доля врача'], 10000);
  const lab = of('Без врача (лаборатория и др.)');
  assert.equal(lab.length, 1);
  assert.equal(lab[0]['Услуга'], 'Анализ крови');
  assert.equal(lab[0]['Сумма после скидки'], 50000);
  assert.equal(lab[0]['Доля врача'], 0);
  // Порядок: специальности по алфавиту, затем «не указана», затем «без врача».
  const order = [...new Set(rows.map((o) => o['Специальность']))];
  assert.deepEqual(order, ['Кардиолог', 'Отоларинголог (ЛОР)', 'Специальность не указана', 'Без врача (лаборатория и др.)']);
});

test('по специальностям: итоги — примечаниями (не строками), доля врачей в сумме = выплате', () => {
  const { db } = clinic();
  const r = run(db, 'by_specialty');
  const rows = objects(r);
  // Ни одной строки-подытога: иначе «Итого» под таблицей посчитало бы дважды.
  assert.ok(!rows.some((o) => /^Итого/.test(String(o['Услуга'])) || /^Итого/.test(String(o['Специальность']))));
  const total = Object.values(FEES).reduce((a, b) => a + b, 0);
  assert.equal(sum(rows, 'Доля врача'), total);
  assert.equal(sum(rows, 'Сумма после скидки'), 280000 + 190000 + 100000 + 100000 + 50000);
  const byDoctors = objects(run(db, 'by_doctors'));
  assert.equal(sum(byDoctors, 'Доля за услуги') + sum(byDoctors, 'Стационарная доля'), total);
  const sub = r.notes.find((n) => n.startsWith('Итого — Отоларинголог (ЛОР):'));
  assert.ok(sub, 'нет подытога ЛОР: ' + r.notes.join(' | '));
  assert.match(sub, /3 услуги/);
  assert.match(sub, /290 000 сум/);
  assert.match(sub, /39 000 сум/);
  // Примечание: основная специальность и сколько врачей без неё.
  assert.ok(r.notes.some((n) => /основная/.test(n) && /первая/.test(n)), r.notes.join(' | '));
  assert.ok(r.notes.some((n) => /1 врача не указана специальность/.test(n) && /Безымянный Б\./.test(n)), r.notes.join(' | '));
  // Период — как у выплаты врачу.
  assert.ok(r.notes.some((n) => /Период — по дню приёма/.test(n)));
});

test('по специальностям — группа «По услугам»; детализация — «Оплата врачей»', async () => {
  const { REPORT_GROUP } = await import('../../../public/js/shared/permission-catalog.js');
  assert.equal(REPORT_GROUP.by_specialty, 'reports.services');
  assert.equal(REPORT_GROUP.doctor_lines, 'reports.doctor_pay');
});
