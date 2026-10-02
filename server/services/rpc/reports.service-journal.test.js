// JOURNALS_V1_SERVICE — «Журнал услуг» (run_report kind 'service_journal').
//
// Владелец (02.10): журнал не «по услугам», а один — услуги выбирают из
// списка, тип — стационар или амбулатория. Строка — одна оказанная выбранная
// услуга. Проверяется на настоящем runReport, а не на выражениях SQL.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { runReport, __setReportsPushDown } from './reports.js';

const admin = { id: 9, role: 'admin' };
const MARCH = { from: '2026-03-01', to: '2026-03-31' };
const SVC = { usgAbd: 1, usgKid: 2, ecg: 3, consult: 4 };
const at = (day) => day + 'T07:00:00Z';   // 07:00 UTC — тот же местный день при поясе от −6 до +16
const objectsOf = (r) => r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c, row[i]])));
const col = (r, name) => objectsOf(r).map((o) => o[name]);
const journal = (db, extra = {}) => runReport(db, { kind: 'service_journal', ...MARCH, service_ids: [SVC.usgAbd, SVC.usgKid, SVC.ecg], ...extra }, admin);

// Клиника: УЗИст (1) делает УЗИ и ЭКГ; терапевт (2) рекомендует; лечащий (3)
// ведёт стационар; кардиолог (4) направляет своим источником (миграция 122:
// у каждого врача свой источник). Пациенты: Азизов (лежал 10–12.03), Бекова,
// Валиев (лежит с 20.03), Гулямова (только заявка на госпитализацию).
function clinic() {
  const db = openDb(':memory:');
  migrate(db);
  const u = db.prepare('INSERT INTO users (id, username, password_hash, role, full_name, is_doctor) VALUES (?,?,?,?,?,?)');
  u.run(1, 'usg', 'x', 'doctor', 'УЗИст У.У.', 1);
  u.run(2, 'ther', 'x', 'doctor', 'Терапевт Т.Т.', 1);
  u.run(3, 'att', 'x', 'doctor', 'Лечащий Л.Л.', 1);
  u.run(4, 'card', 'x', 'doctor', 'Кардиолог К.К.', 1);
  u.run(9, 'adm', 'x', 'admin', 'Админ', 0);
  const s = db.prepare('INSERT INTO services (id, name, price) VALUES (?,?,?)');
  s.run(SVC.usgAbd, 'УЗИ брюшной полости', 150000);
  s.run(SVC.usgKid, 'УЗИ почек', 120000);
  s.run(SVC.ecg, 'ЭКГ', 60000);
  s.run(SVC.consult, 'Приём терапевта', 100000);
  const p = db.prepare('INSERT INTO patients (id, mrn, full_name, gender, date_of_birth) VALUES (?,?,?,?,?)');
  p.run(1, 'P-1', 'Азизов Бахтиёр', 'male', '1980-05-01');
  p.run(2, 'P-2', 'Бекова Дилноза', 'female', '1992-11-20');
  p.run(3, 'P-3', 'Валиев Сардор', 'male', null);
  p.run(4, 'P-4', 'Гулямова Нигора', 'other', '1975-02-14');
  db.prepare("INSERT INTO referral_sources (id, name) VALUES (50, 'Клиника «Шифо»')").run();
  const cardSrc = db.prepare('SELECT id FROM referral_sources WHERE doctor_id = 4').get().id;
  const a = db.prepare(`INSERT INTO admissions (id, admission_no, patient_id, attending_doctor_id, status, admitted_at, discharged_at, admission_diagnosis)
                        VALUES (?,?,?,?,?,?,?,?)`);
  a.run(1, 'ИБ-7', 1, 3, 'discharged', at('2026-03-10'), at('2026-03-12'), 'K35.8 — Острый аппендицит');
  a.run(2, 'ИБ-8', 3, null, 'active', at('2026-03-20'), null, '');
  a.run(3, 'ИБ-9', 4, null, 'ordered', at('2026-03-01'), null, '');     // заявка: пациент ещё не лежит
  a.run(4, 'ИБ-6', 2, null, 'cancelled', at('2026-03-01'), null, '');   // отменена
  const r = db.prepare('INSERT INTO admission_reviews (admission_id, kind, diagnosis, published_at) VALUES (?,?,?,?)');
  r.run(2, 'primary', 'J18 — Пневмония', at('2026-03-21'));
  r.run(2, 'round', 'I10 — Гипертензия', at('2026-03-22'));
  r.run(2, 'round', 'Черновик осмотра', null);   // не опубликован
  const v = db.prepare('INSERT INTO visits (id, patient_id, visit_date, status, referral_source_id) VALUES (?,?,?,?,?)');
  const vs = db.prepare('INSERT INTO visit_services (id, visit_id, service_id, doctor_id, quantity, unit_price, total, status) VALUES (?,?,?,?,1,0,0,?)');
  v.run(1, 1, at('2026-03-09'), 'arrived', null);   vs.run(1, 1, SVC.usgAbd, 1, 'completed');    // до поступления — амбулатория
  v.run(2, 1, at('2026-03-10'), 'arrived', null);   vs.run(2, 2, SVC.usgAbd, 1, 'queued');       // день поступления — стационар
  v.run(3, 1, at('2026-03-12'), 'arrived', null);   vs.run(3, 3, SVC.ecg, 1, 'completed');       // день выписки — стационар
  v.run(4, 1, at('2026-03-13'), 'arrived', null);   vs.run(4, 4, SVC.usgAbd, 1, 'completed');    // после выписки — амбулатория
  v.run(5, 2, at('2026-03-15'), 'arrived', 50);
  vs.run(5, 5, SVC.usgKid, 1, 'added');         // не оплачено
  vs.run(6, 5, SVC.usgKid, 1, 'cancelled');     // отменено
  vs.run(7, 5, SVC.usgKid, 1, 'in_progress');   // прошло кассу
  v.run(6, 3, at('2026-03-25'), 'arrived', null);   vs.run(8, 6, SVC.usgAbd, 1, 'completed');    // незакрытый случай — стационар
  v.run(7, 4, at('2026-03-05'), 'arrived', cardSrc); vs.run(9, 7, SVC.ecg, 1, 'collected');      // заявка — не госпитализация
  v.run(8, 2, at('2026-03-02'), 'arrived', null);   vs.run(10, 8, SVC.usgAbd, 1, 'completed');   // отменённая госпитализация не в счёт
  v.run(9, 1, at('2026-03-09'), 'arrived', null);   vs.run(11, 9, SVC.consult, 2, 'completed');  // услуга не выбрана
  v.run(10, 2, at('2026-03-16'), 'arrived', null);  vs.run(12, 10, SVC.usgAbd, 1, 'completed');  // счёт возвращён
  v.run(11, 2, at('2026-03-17'), 'cancelled', null); vs.run(13, 11, SVC.usgAbd, 1, 'queued');    // визит отменён
  db.prepare("INSERT INTO invoices (id, invoice_number, patient_id, visit_id, total_amount, paid_amount, status) VALUES (70, 'INV-70', 2, 10, 150000, 0, 'refunded')").run();
  db.prepare("INSERT INTO invoice_items (id, invoice_id, service_id, description, quantity, unit_price, total) VALUES (70, 70, 1, 'УЗИ брюшной полости', 1, 150000, 150000)").run();
  db.prepare('UPDATE visit_services SET invoice_item_id = 70 WHERE id = 12').run();
  const as = db.prepare(`INSERT INTO admission_services (id, admission_id, service_id, doctor_id, performer_id, quantity, unit_price, total, billable, notes, performed_at, created_at)
                         VALUES (?,?,?,?,?,1,0,0,?,?,?,?)`);
  as.run(1, 1, SVC.usgAbd, 3, 1, 1, null, at('2026-03-11'), at('2026-03-10'));    // строка случая — всегда стационар
  as.run(2, 1, SVC.usgAbd, 3, 1, 1, null, at('2026-03-10'), at('2026-03-10'));    // та же работа, что визит 2 — один раз
  as.run(3, 2, SVC.ecg, 3, null, 1, null, null, at('2026-03-21'));                // не отмечена «Выполнено» — день начисления
  as.run(4, 1, SVC.usgAbd, 3, 1, 0, null, at('2026-03-11'), at('2026-03-11'));    // «в учёт расходов» — не пациенту
  return db;
}

test('строки: оплаченные визиты и строки акта; неоплаченное, отменённое, возвращённое и чужие услуги — нет', () => {
  const db = clinic();
  try {
    const r = journal(db);
    assert.deepEqual(r.columns, ['№', 'Ич. рақам (Пор. № пациента)', 'ФИО', 'Пол', 'Год рождения', 'ИБ №', 'Кто направил',
      'Диагноз при направлении', 'Дата', 'Услуга', 'Заключение', 'Врач', 'Лечащий врач']);
    assert.deepEqual(col(r, 'Дата'), ['2026-03-02', '2026-03-05', '2026-03-09', '2026-03-10', '2026-03-11', '2026-03-12',
      '2026-03-13', '2026-03-15', '2026-03-21', '2026-03-25']);
    assert.deepEqual(col(r, 'ФИО'), ['Бекова Дилноза', 'Гулямова Нигора', 'Азизов Бахтиёр', 'Азизов Бахтиёр', 'Азизов Бахтиёр',
      'Азизов Бахтиёр', 'Азизов Бахтиёр', 'Бекова Дилноза', 'Валиев Сардор', 'Валиев Сардор']);
    assert.deepEqual(col(r, 'Услуга'), ['УЗИ брюшной полости', 'ЭКГ', 'УЗИ брюшной полости', 'УЗИ брюшной полости', 'УЗИ брюшной полости',
      'ЭКГ', 'УЗИ брюшной полости', 'УЗИ почек', 'ЭКГ', 'УЗИ брюшной полости']);
    assert.deepEqual(col(r, '№'), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  } finally { db.close(); }
});

test('стационар — по дню госпитализации (день поступления, день выписки, незакрытый случай); заявка и отмена — не стационар', () => {
  const db = clinic();
  try {
    const r = journal(db);
    assert.deepEqual(col(r, 'ИБ №'), ['', '', '', 'ИБ-7', 'ИБ-7', 'ИБ-7', '', '', 'ИБ-8', 'ИБ-8']);
    assert.deepEqual(col(r, 'Лечащий врач'), ['', '', '', 'Лечащий Л.Л.', 'Лечащий Л.Л.', 'Лечащий Л.Л.', '', '', '', '']);
    assert.deepEqual(col(r, 'Врач'), ['УЗИст У.У.', 'УЗИст У.У.', 'УЗИст У.У.', 'УЗИст У.У.', 'УЗИст У.У.', 'УЗИст У.У.',
      'УЗИст У.У.', 'УЗИст У.У.', 'Лечащий Л.Л.', 'УЗИст У.У.'], 'у строки акта без исполнителя — назначивший');
  } finally { db.close(); }
});

test('Ич. рақам: у одного пациента один номер, номера по первому появлению; пол словом и год рождения', () => {
  const db = clinic();
  try {
    const r = journal(db);
    assert.deepEqual(col(r, 'Ич. рақам (Пор. № пациента)'), [1, 2, 3, 3, 3, 3, 3, 1, 4, 4]);
    assert.deepEqual(col(r, 'Пол'), ['Жен.', '', 'Муж.', 'Муж.', 'Муж.', 'Муж.', 'Муж.', 'Жен.', 'Муж.', 'Муж.']);
    assert.deepEqual(col(r, 'Год рождения'), ['1992', '1975', '1980', '1980', '1980', '1980', '1980', '1992', '', '']);
  } finally { db.close(); }
});

test('тип: «Стационар» и «Амбулатория» делят журнал; у амбулатории нет «ИБ №» и «Лечащий врач»', () => {
  const db = clinic();
  try {
    const inp = journal(db, { kind_of_care: 'inpatient' });
    assert.deepEqual(col(inp, 'Дата'), ['2026-03-10', '2026-03-11', '2026-03-12', '2026-03-21', '2026-03-25']);
    assert.deepEqual(col(inp, 'Ич. рақам (Пор. № пациента)'), [1, 1, 1, 2, 2], 'номер — по строкам этого журнала');
    const out = journal(db, { kind_of_care: 'outpatient' });
    assert.ok(!out.columns.includes('ИБ №') && !out.columns.includes('Лечащий врач'));
    assert.equal(out.columns.length, 11);
    assert.deepEqual(col(out, 'Дата'), ['2026-03-02', '2026-03-05', '2026-03-09', '2026-03-13', '2026-03-15']);
  } finally { db.close(); }
});

test('кто направил (без рекомендаций): стационар — лечащий или «Стационар», источник визита, иначе «сам»; диагноз стационара', () => {
  const db = clinic();
  try {
    const r = journal(db);
    assert.deepEqual(col(r, 'Кто направил'), ['сам', 'Кардиолог К.К.', 'сам', 'Лечащий Л.Л.', 'Лечащий Л.Л.', 'Лечащий Л.Л.',
      'сам', 'Клиника «Шифо»', 'Стационар', 'Стационар']);
    const dx = col(r, 'Диагноз при направлении');
    assert.deepEqual([dx[3], dx[4], dx[5]], ['K35.8 — Острый аппендицит', 'K35.8 — Острый аппендицит', 'K35.8 — Острый аппендицит']);
    assert.deepEqual([dx[8], dx[9]], ['I10 — Гипертензия', 'I10 — Гипертензия'], 'последний опубликованный осмотр, черновик — нет');
  } finally { db.close(); }
});

test('service_ids: пусто или мусор — отказ с подсказкой; больше 2000 — отказ; неизвестный id — без строк; неверный тип — отказ', () => {
  const db = clinic();
  try {
    const run = (extra) => runReport(db, { kind: 'service_journal', ...MARCH, ...extra }, admin);
    for (const bad of [undefined, [], 'abc', [null, 'x', -1, 0, 1.5, {}]]) {
      assert.throws(() => run({ service_ids: bad }), (e) => e.status === 400 && /Выберите услуги/.test(e.message), JSON.stringify(bad));
    }
    assert.throws(() => run({ service_ids: Array.from({ length: 2001 }, (_, i) => i + 1) }),
      (e) => e.status === 400 && /не больше 2000/.test(e.message) && e.template && e.params.max === '2000');
    const r = run({ service_ids: ['3', 'мусор', 3, 999999] });   // ЭКГ строкой и числом, неизвестный id
    assert.deepEqual(col(r, 'Услуга'), ['ЭКГ', 'ЭКГ', 'ЭКГ']);
    assert.deepEqual(run({ service_ids: [999999] }).rows, []);
    assert.throws(() => run({ service_ids: [1], kind_of_care: 'day' }), (e) => e.status === 400 && /Амбулатория/.test(e.message));
  } finally { db.close(); }
});

test('итога нет; здания — только соседнее — пусто; период по индексу и прежний — те же строки', () => {
  const db = clinic();
  try {
    const r = journal(db);
    assert.deepEqual(r.summable_columns, []);
    assert.equal(r.notes.length, 3);
    assert.deepEqual(journal(db, { buildings: ['B'] }).rows, []);
    __setReportsPushDown(false);
    try { assert.deepEqual(journal(db).rows, r.rows); } finally { __setReportsPushDown(true); }
  } finally { db.close(); }
});
