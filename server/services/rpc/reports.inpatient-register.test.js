// JOURNALS_V1_REGISTER — «Реестр стационарных пациентов» (run_report kind
// 'inpatient_register'): строка на госпитализацию с поступлением в периоде.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { runReport, __setReportsPushDown } from './reports.js';
import { admissionsRegister } from './admissions-register.js';

const admin = { id: 9, role: 'admin' };
const MARCH = { from: '2026-03-01', to: '2026-03-31' };
const at = (day) => day + 'T07:00:00Z';   // 07:00 UTC — тот же местный день при поясе от −6 до +16
const objectsOf = (r) => r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c, row[i]])));
const register = (db, extra = {}) => runReport(db, { kind: 'inpatient_register', ...MARCH, ...extra }, admin);

function clinic() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, role, full_name, is_doctor) VALUES (5, 'att', 'x', 'doctor', 'Лечащий Л.Л.', 1), (9, 'adm', 'x', 'admin', 'Админ', 0)").run();
  // Отделы 1–6 заводят миграции (1 — «Стационар»): свой — под номером 11.
  db.prepare("INSERT INTO departments (id, name, kind) VALUES (11, 'Терапия', 'inpatient')").run();
  db.prepare("INSERT INTO wards (id, name, department_id, ward_class) VALUES (1, 'Палата 1', 11, 'lux'), (2, 'Палата 2', 11, NULL)").run();
  db.prepare("INSERT INTO beds (id, code, ward_id) VALUES (1, '1-1', 1), (2, '2-1', 2)").run();
  const pt = db.prepare(`INSERT INTO patients (id, mrn, full_name, date_of_birth, phone, country, region, district, address, passport_number, national_id)
                         VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  pt.run(1, 'P-1', 'Каримов Темур', '1971-07-03', '+998901112233', 'Узбекистан', 'Ташкент', 'Юнусабад', 'ул. Навои, 5', 'AA1234567', '');
  pt.run(2, 'P-2', 'Юлдашева Мадина', '1985-03-30', '+998907776655', 'Узбекистан', 'Самарканд', '', 'ул. Регистан, 1', '', '31234567890123');
  pt.run(3, 'P-3', 'Заявкин Зиёд', null, '', '', '', '', '', '', '');
  const adm = db.prepare(`INSERT INTO admissions (id, admission_no, patient_id, bed_id, ward_id, attending_doctor_id, status, admitted_at, discharged_at, department)
                          VALUES (?,?,?,?,?,?,?,?,?,?)`);
  adm.run(1, 'ИБ-101', 1, 1, 1, 5, 'discharged', at('2026-03-10'), at('2026-03-14'), '');
  adm.run(2, '', 2, 2, 2, null, 'active', at('2026-03-12'), null, 'Кардиология');
  adm.run(3, 'ИБ-103', 3, null, null, null, 'ordered', at('2026-03-11'), null, '');      // заявка — не в реестре
  adm.run(4, 'ИБ-099', 1, 1, 1, 5, 'discharged', at('2026-02-20'), at('2026-02-25'), '');   // вне периода
  adm.run(5, 'ИБ-104', 2, 2, 2, null, 'cancelled', at('2026-03-13'), null, '');   // отменена
  const inv = db.prepare('INSERT INTO invoices (id, invoice_number, admission_id, patient_id, total_amount, paid_amount, status) VALUES (?,?,?,?,?,?,?)');
  inv.run(10, 'INV-10', 1, 1, 900000, 390000, 'partial');
  inv.run(11, 'INV-11', 1, 1, 777000, 777000, 'void');
  inv.run(12, 'INV-12', 1, 1, 300000, 300000, 'refunded');
  const pay = db.prepare('INSERT INTO payments (invoice_id, amount, method, paid_at) VALUES (?,?,?,?)');
  pay.run(10, 150000, 'cash', at('2026-03-12'));
  pay.run(10, 250000, 'card', at('2026-03-15'));   // последняя оплата
  pay.run(10, -10000, 'cash', at('2026-03-16'));   // возврат — не оплата
  pay.run(11, 777000, 'cash', at('2026-03-18'));   // отменённый счёт
  return db;
}

test('строки: поступившие в периоде, без заявок и отменённых; по дате поступления, затем ИБ №', () => {
  const db = clinic();
  try {
    const r = register(db);
    assert.deepEqual(r.columns, ['ИБ №', 'ФИО', 'Год рождения', 'Отделение', 'Дата рег', 'Дата выписки', 'ФИО ЛВ', 'Сумма оплаты',
      'Тип палаты', 'Дата оплаты', 'Страна', 'Регион', 'Адрес', 'Паспорт', 'Телефон']);
    assert.deepEqual(objectsOf(r).map((o) => o['ИБ №']), ['ИБ-101', '#2']);
    assert.deepEqual(objectsOf(register(db, { from: '2026-03-12', to: '2026-03-12' })).map((o) => o['ИБ №']), ['#2'], 'период — по местному дню поступления');
  } finally { db.close(); }
});

test('колонки строки: оплата без отменённых и возвращённых, день последней оплаты, класс палаты, паспорт, адрес', () => {
  const db = clinic();
  try {
    const [a, b] = objectsOf(register(db));
    assert.deepEqual(a, {
      'ИБ №': 'ИБ-101', 'ФИО': 'Каримов Темур', 'Год рождения': '1971', 'Отделение': 'Терапия',
      'Дата рег': '2026-03-10', 'Дата выписки': '2026-03-14', 'ФИО ЛВ': 'Лечащий Л.Л.', 'Сумма оплаты': 390000,
      'Тип палаты': 'Люкс', 'Дата оплаты': '2026-03-15', 'Страна': 'Узбекистан', 'Регион': 'Ташкент',
      'Адрес': 'Юнусабад, ул. Навои, 5', 'Паспорт': 'AA1234567', 'Телефон': '+998901112233',
    });
    assert.deepEqual(b, {
      'ИБ №': '#2', 'ФИО': 'Юлдашева Мадина', 'Год рождения': '1985', 'Отделение': 'Кардиология',
      'Дата рег': '2026-03-12', 'Дата выписки': '', 'ФИО ЛВ': '', 'Сумма оплаты': 0,
      'Тип палаты': '', 'Дата оплаты': '', 'Страна': 'Узбекистан', 'Регион': 'Самарканд',
      'Адрес': 'ул. Регистан, 1', 'Паспорт': '31234567890123', 'Телефон': '+998907776655',
    });
    const tab = admissionsRegister(db, {}, admin).rows.find((x) => x.id === 1);
    assert.equal(tab.paid_total, a['Сумма оплаты'], 'вкладка «Госпитализации» и реестр считают оплату по-разному');
  } finally { db.close(); }
});

test('итог — только «Сумма оплаты»; здания — только соседнее — пусто; период по индексу — те же строки', () => {
  const db = clinic();
  try {
    const r = register(db);
    assert.deepEqual(r.summable_columns, ['Сумма оплаты']);
    assert.equal(r.total_label, 'Сумма оплаты');
    assert.equal(r.notes.length, 2);
    assert.deepEqual(register(db, { buildings: ['B'] }).rows, [], 'стационар соседнего здания здесь не живёт');
    __setReportsPushDown(false);
    try { assert.deepEqual(register(db).rows, r.rows); } finally { __setReportsPushDown(true); }
  } finally { db.close(); }
});
