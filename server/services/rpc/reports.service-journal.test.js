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
// JOURNALS_V1_RJ1 — возвраты — настоящими RPC кассы, не руками в invoices.
import { createInvoiceForVisit, createInvoiceForAdmission, recordPayment, refundPayment, refundInvoiceLine } from './billing.js';
import { openCashShift, voidInvoice } from './cashier.js';   // voidInvoice: JOURNALS_V1_RJ2 (F6)

const admin = { id: 9, role: 'admin' };
const registrar = { id: 7, role: 'registrar' };   // JOURNALS_V1_RJ1
const cashier = { id: 8, role: 'cashier', full_name: 'Кассир' };   // JOURNALS_V1_RJ1
const itemOf = (db, vsId) => db.prepare('SELECT invoice_item_id i FROM visit_services WHERE id = ?').get(vsId).i;   // JOURNALS_V1_RJ1
const fullRefund = (db, invoiceId) => refundPayment(db, {   // JOURNALS_V1_RJ1 — полный возврат: касса отменяет счёт
  payment_id: db.prepare('SELECT id FROM payments WHERE invoice_id = ? AND amount > 0').get(invoiceId).id }, cashier);
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
  u.run(7, 'reg', 'x', 'registrar', 'Регистратор', 0);   // JOURNALS_V1_RJ1
  u.run(8, 'cash', 'x', 'cashier', 'Кассир', 0);         // JOURNALS_V1_RJ1
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
  // JOURNALS_V1_RJ1 — визит 10: оплачен и полностью возвращён НАСТОЯЩЕЙ кассой
  // (refund_payment → счёт отменён, строка отпущена со счёта с отметкой
  // pay_refund_releases); статус строки остаётся 'completed'.
  openCashShift(db, { opening_float: 0 }, cashier);
  const inv10 = createInvoiceForVisit(db, { visit_id: 10, visit_service_ids: [12] }, registrar).invoice;
  recordPayment(db, { invoice_id: inv10.id, amount: inv10.total_amount, method: 'cash' }, cashier);
  fullRefund(db, inv10.id);
  const as = db.prepare(`INSERT INTO admission_services (id, admission_id, service_id, doctor_id, performer_id, quantity, unit_price, total, billable, notes, performed_at, created_at)
                         VALUES (?,?,?,?,?,1,0,0,?,?,?,?)`);
  as.run(1, 1, SVC.usgAbd, 3, 1, 1, null, at('2026-03-11'), at('2026-03-10'));    // строка случая — всегда стационар
  as.run(2, 1, SVC.usgAbd, 3, 1, 1, null, at('2026-03-10'), at('2026-03-10'));    // та же работа, что визит 2 — один раз
  as.run(3, 2, SVC.ecg, 3, null, 1, null, null, at('2026-03-21'));                // JOURNALS_V1_RJ1 — запланирована, не выполнена: не в журнале
  as.run(5, 2, SVC.ecg, 3, null, 1, null, at('2026-03-22'), at('2026-03-21'));    // JOURNALS_V1_RJ1 — выполнена 22.03 без исполнителя: врач — назначивший
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
      '2026-03-13', '2026-03-15', '2026-03-22', '2026-03-25']);
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
    assert.deepEqual(col(inp, 'Дата'), ['2026-03-10', '2026-03-11', '2026-03-12', '2026-03-22', '2026-03-25']);
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

// JOURNALS_V1_ALL (владелец, 02.10) — «with not selected service can you make
// show all the services»: ничего не выбрано (пусто, нет аргумента, мусор) —
// журнал по ВСЕМ услугам, ровно те же строки, что при выборе всех услуг.
test('JOURNALS_V1_ALL — ничего не выбрано (пусто, нет, мусор): журнал по всем услугам; примечание «по всем услугам»', () => {
  const db = clinic();
  try {
    const run = (extra) => runReport(db, { kind: 'service_journal', ...MARCH, ...extra }, admin);
    const allIds = db.prepare('SELECT id FROM services ORDER BY id').all().map((s) => s.id);
    const every = run({ service_ids: allIds });
    assert.ok(col(every, 'Услуга').includes('Приём терапевта'), 'услуга, которой нет в выборе журнала по умолчанию, — тоже строка');
    assert.equal(every.rows.length, journal(db).rows.length + 1);
    for (const none of [undefined, null, [], 'abc', 5, [null, 'x', -1, 0, 1.5, {}]]) {
      const r = run(none === undefined ? {} : { service_ids: none });
      assert.deepEqual(r.columns, every.columns, JSON.stringify(none));
      assert.deepEqual(r.rows, every.rows, JSON.stringify(none));
      assert.deepEqual(r.cells_t, every.cells_t, JSON.stringify(none));
      assert.equal(r.notes[0], 'Журнал построен по всем услугам: ни одна не выбрана.', JSON.stringify(none));
      assert.equal(r.notes_t[0], null, 'фраза без чисел — словарём целиком');
      assert.deepEqual(r.notes.slice(1), every.notes.slice(1));
    }
    // Тип и здания работают и без выбора услуг.
    assert.deepEqual(col(run({ kind_of_care: 'inpatient' }), 'Дата'), ['2026-03-10', '2026-03-11', '2026-03-12', '2026-03-22', '2026-03-25']);
    assert.deepEqual(col(run({ kind_of_care: 'outpatient' }), 'Услуга'), col(run({ service_ids: allIds, kind_of_care: 'outpatient' }), 'Услуга'));
    assert.deepEqual(run({ buildings: ['B'] }).rows, []);
    __setReportsPushDown(false);
    try { assert.deepEqual(run({}).rows, every.rows); } finally { __setReportsPushDown(true); }
    assert.throws(() => run({ kind_of_care: 'day' }), (e) => e.status === 400 && /Амбулатория/.test(e.message));
  } finally { db.close(); }
});

test('явный выбор — как прежде: больше 2000 — отказ; неизвестный id — без строк; неверный тип — отказ; примечание «выбрано услуг: N» шаблоном', () => {
  const db = clinic();
  try {
    const run = (extra) => runReport(db, { kind: 'service_journal', ...MARCH, ...extra }, admin);
    assert.throws(() => run({ service_ids: Array.from({ length: 2001 }, (_, i) => i + 1) }),
      (e) => e.status === 400 && /не больше 2000/.test(e.message) && e.template && e.params.max === '2000');
    // JOURNALS_V1_ALL — предел — у присланного массива: 2001 мусорный элемент — тоже отказ, а не «все услуги».
    assert.throws(() => run({ service_ids: Array.from({ length: 2001 }, () => 'x') }), (e) => e.status === 400 && /не больше 2000/.test(e.message));
    const r = run({ service_ids: ['3', 'мусор', 3, 999999] });   // ЭКГ строкой и числом, неизвестный id
    assert.deepEqual(col(r, 'Услуга'), ['ЭКГ', 'ЭКГ', 'ЭКГ']);
    assert.equal(r.notes[0], 'Журнал построен по выбранным услугам — выбрано услуг: 2.', 'ЭКГ и неизвестный id — два выбранных');
    assert.deepEqual(r.notes_t[0], { template: 'Журнал построен по выбранным услугам — выбрано услуг: {n}.', params: { n: '2' } });
    assert.deepEqual(run({ service_ids: [999999] }).rows, []);
    assert.equal(journal(db).notes[0], 'Журнал построен по выбранным услугам — выбрано услуг: 3.');
    assert.throws(() => run({ service_ids: [1], kind_of_care: 'day' }), (e) => e.status === 400 && /Амбулатория/.test(e.message));
  } finally { db.close(); }
});

test('итога нет; здания — только соседнее — пусто; период по индексу и прежний — те же строки', () => {
  const db = clinic();
  try {
    const r = journal(db);
    assert.deepEqual(r.summable_columns, []);
    assert.equal(r.notes.length, 5, 'JOURNALS_V1_CONCLUSION — откуда «Заключение»; JOURNALS_V1_ALL — по каким услугам построен');
    assert.deepEqual(journal(db, { buildings: ['B'] }).rows, []);
    __setReportsPushDown(false);
    try { assert.deepEqual(journal(db).rows, r.rows); } finally { __setReportsPushDown(true); }
  } finally { db.close(); }
});

// JOURNALS_V1_RJ1 (ревью, п. 1) — «возврат не показывается». Касса не ставит
// счёту 'refunded': полный возврат отменяет счёт (closeFullyRefunded →
// voidInvoice), возврат строкой отпускает строку со счёта — и строка остаётся
// 'completed' без invoice_item_id. Признак — отметка pay_refund_releases, та же,
// что у visit_refunded_lines (окно визита) и у выплаты врачу.
test('возвраты настоящей кассой: полный возврат и возврат строкой убирают строку; сосед по счёту и отмена неоплаченного счёта — остаются', () => {
  const db = clinic();
  try {
    assert.equal(db.prepare('SELECT status FROM visit_services WHERE id = 12').get().status, 'completed', 'строка возвращённого счёта осталась «выполненной»');
    assert.equal(itemOf(db, 12), null);
    assert.ok(!col(journal(db), 'Дата').includes('2026-03-16'), 'полностью возвращённый визит 10 — не в журнале');
    // Возврат строкой: из двух строк счёта вернули УЗИ почек, ЭКГ осталась.
    db.prepare("INSERT INTO visits (id, patient_id, visit_date, status) VALUES (20, 2, ?, 'arrived')").run(at('2026-03-19'));
    const line = db.prepare('INSERT INTO visit_services (id, visit_id, service_id, doctor_id, quantity, unit_price, total, status) VALUES (?,20,?,1,1,0,0,?)');
    line.run(50, SVC.usgKid, 'completed');
    line.run(51, SVC.ecg, 'completed');
    const inv = createInvoiceForVisit(db, { visit_id: 20, visit_service_ids: [50, 51] }, registrar).invoice;
    recordPayment(db, { invoice_id: inv.id, amount: inv.total_amount, method: 'cash' }, cashier);
    refundInvoiceLine(db, { invoice_item_id: itemOf(db, 50) }, cashier);
    let r = journal(db, { from: '2026-03-19', to: '2026-03-19' });
    assert.deepEqual(col(r, 'Услуга'), ['ЭКГ'], 'возвращённая строкой услуга — не в журнале, соседняя — в журнале');
    // Обычная отмена неоплаченного счёта (страховой счёт отменили, денег не было) — работа сделана, строка остаётся.
    db.prepare("INSERT INTO visits (id, patient_id, visit_date, status) VALUES (21, 1, ?, 'arrived')").run(at('2026-03-27'));
    line.run(52, SVC.usgKid, 'completed');
    db.prepare('UPDATE visit_services SET visit_id = 21 WHERE id = 52').run();
    const unpaid = createInvoiceForVisit(db, { visit_id: 21, visit_service_ids: [52] }, registrar).invoice;
    db.prepare("UPDATE invoices SET status = 'void' WHERE id = ?").run(unpaid.id);
    db.prepare('UPDATE visit_services SET invoice_item_id = NULL WHERE id = 52').run();
    assert.deepEqual(col(journal(db, { from: '2026-03-27', to: '2026-03-27' }), 'Услуга'), ['УЗИ почек']);
    // Стационар: счёт госпитализации оплачен и полностью возвращён — строки акта нет.
    assert.ok(col(journal(db), 'Дата').includes('2026-03-11'), 'до возврата строка акта 11.03 в журнале');
    const admInv = createInvoiceForAdmission(db, { admission_id: 1, admission_service_ids: [1] }, registrar).invoice;
    recordPayment(db, { invoice_id: admInv.id, amount: admInv.total_amount, method: 'cash' }, cashier);
    fullRefund(db, admInv.id);
    r = journal(db);
    assert.ok(!col(r, 'Дата').includes('2026-03-11'), 'возвращённая строка акта — не в журнале');
  } finally { db.close(); }
});

// JOURNALS_V1_RJ1 (ревью, п. 8) — визит без филиала — свой (OWN_BRANCH_OR, как у
// прочих отчётов); прежде отбор по своему филиалу терял все такие визиты.
test('филиал: визит без филиала — свой; приехавший из соседнего здания без филиала — не свой', () => {
  const db = clinic();
  try {
    const all = col(journal(db), 'Дата');
    assert.deepEqual(col(journal(db, { branch_ids: [1] }), 'Дата'), all, 'свой филиал — все строки: у визитов филиал не записан');
    db.prepare("INSERT INTO branches (id, letter, name) VALUES (2, 'B', 'Филиал Б')").run();
    db.prepare('UPDATE visits SET branch_id = 2 WHERE id = 1').run();                     // 09.03 — в филиале Б
    db.prepare("UPDATE visits SET branch_id = NULL, sync_origin = 'B' WHERE id = 4").run();   // 13.03 — приехал из здания Б
    assert.deepEqual(col(journal(db, { branch_ids: [2] }), 'Дата'), ['2026-03-09']);
    assert.deepEqual(col(journal(db, { branch_ids: [1] }), 'Дата'), all.filter((d) => d !== '2026-03-09' && d !== '2026-03-13'));
  } finally { db.close(); }
});

// JOURNALS_V1_RJ1 (ревью, п. 7) — выписан и снова положен в тот же день: по
// одному дню оба случая «шли», и строка доставалась последнему поступившему.
// Теперь сначала — случай, в чьё ВРЕМЯ попадает строка (её scheduled_at, иначе
// время визита); не попала ни в один — прежнее правило дня, последний.
test('стационар: выписан и снова положен в тот же день — строка идёт к случаю, в чьё время она была', () => {
  const db = clinic();
  try {
    const ibOn12 = (svc) => objectsOf(journal(db, { from: '2026-03-12', to: '2026-03-12' }))
      .filter((o) => o['Услуга'] === svc).map((o) => o['ИБ №']);
    db.prepare("INSERT INTO visits (id, patient_id, visit_date, status) VALUES (42, 1, '2026-03-12T15:00:00Z', 'arrived')").run();
    db.prepare("INSERT INTO visit_services (id, visit_id, service_id, doctor_id, quantity, unit_price, total, status) VALUES (42, 42, ?, 1, 1, 0, 0, 'completed')").run(SVC.usgKid);
    assert.deepEqual(ibOn12('УЗИ почек'), ['ИБ-7'], 'после выписки в день выписки, без нового случая — правило дня');
    // Азизов выписан 12.03 в 07:00 (ИБ-7) и снова положен в 10:00 (ИБ-10).
    db.prepare(`INSERT INTO admissions (id, admission_no, patient_id, attending_doctor_id, status, admitted_at, discharged_at)
                VALUES (5, 'ИБ-10', 1, 2, 'active', '2026-03-12T10:00:00Z', NULL)`).run();
    // Визит открыт в 06:00 (до выписки), а строка назначена на 13:00 — время строки.
    db.prepare("INSERT INTO visits (id, patient_id, visit_date, status) VALUES (41, 1, '2026-03-12T06:00:00Z', 'arrived')").run();
    db.prepare(`INSERT INTO visit_services (id, visit_id, service_id, doctor_id, quantity, unit_price, total, status, scheduled_at)
                VALUES (41, 41, ?, 1, 1, 0, 0, 'completed', '2026-03-12T13:00:00Z')`).run(SVC.usgAbd);
    assert.deepEqual(ibOn12('ЭКГ'), ['ИБ-7'], 'ЭКГ в 07:00 — ещё первый случай, а не последний поступивший');
    assert.deepEqual(ibOn12('УЗИ почек'), ['ИБ-10'], 'в 15:00 — второй случай');
    assert.deepEqual(ibOn12('УЗИ брюшной полости'), ['ИБ-10'], 'время строки (scheduled_at 13:00), а не визита (06:00)');
  } finally { db.close(); }
});

// JOURNALS_V1_RJ1 (ревью, п. 3) — строка акта в журнале, только когда отмечена
// «Выполнено» (performed_at, как IN_DONE_SQL выплаты врачу), и датирована днём
// выполнения: запланированная медсестрой на завтра — ещё не оказанная услуга.
test('стационар: запланированная строка акта — не в журнале, пока не выполнена; дата — день выполнения; план + визит — одна строка', () => {
  const db = clinic();
  try {
    const ecgDays = (r) => objectsOf(r).filter((o) => o['Услуга'] === 'ЭКГ').map((o) => o['Дата']);
    assert.deepEqual(ecgDays(journal(db)), ['2026-03-05', '2026-03-12', '2026-03-22'], 'запланированная 21.03 — не в журнале');
    // План на день визита, заведённый накануне: визит есть, плана в журнале нет.
    db.prepare(`INSERT INTO admission_services (id, admission_id, service_id, doctor_id, quantity, unit_price, total, billable, planned_at, created_at)
                VALUES (6, 2, ?, 3, 1, 0, 0, 1, ?, ?)`).run(SVC.usgAbd, at('2026-03-25'), at('2026-03-24'));
    const abdDays = (r) => objectsOf(r).filter((o) => o['Услуга'] === 'УЗИ брюшной полости' && o['ФИО'] === 'Валиев Сардор').map((o) => o['Дата']);
    assert.deepEqual(abdDays(journal(db)), ['2026-03-25'], 'план 24.03 не стал строкой');
    // Выполнили в день визита — та же работа, одна строка (строка визита).
    db.prepare('UPDATE admission_services SET performed_at = ? WHERE id = 6').run(at('2026-03-25'));
    assert.deepEqual(abdDays(journal(db)), ['2026-03-25']);
    // Запланированную 21.03 выполнили 23.03 — строка 23.03, не 21.03.
    db.prepare('UPDATE admission_services SET performed_at = ? WHERE id = 3').run(at('2026-03-23'));
    assert.deepEqual(ecgDays(journal(db)), ['2026-03-05', '2026-03-12', '2026-03-22', '2026-03-23']);
  } finally { db.close(); }
});

// JOURNALS_V1_RJ1 (ревью) — «прошла кассу» — каждый статус списка, queued тоже:
// мутант без queued прежде выживал только случайно (его строку подменяла строка акта).
test('прошла кассу: queued, collected, in_progress, resulted, completed — в журнале; added и cancelled — нет', () => {
  const db = clinic();
  try {
    const statuses = ['queued', 'collected', 'in_progress', 'resulted', 'completed', 'added', 'cancelled'];
    statuses.forEach((st, i) => {
      const day = '2026-03-' + String(20 + i);
      db.prepare("INSERT INTO visits (id, patient_id, visit_date, status) VALUES (?, 4, ?, 'arrived')").run(30 + i, at(day));
      db.prepare('INSERT INTO visit_services (id, visit_id, service_id, doctor_id, quantity, unit_price, total, status) VALUES (?,?,?,1,1,0,0,?)')
        .run(60 + i, 30 + i, SVC.usgKid, st);
    });
    const r = journal(db, { from: '2026-03-20', to: '2026-03-26', service_ids: [SVC.usgKid] });
    assert.deepEqual(col(r, 'Дата'), ['2026-03-20', '2026-03-21', '2026-03-22', '2026-03-23', '2026-03-24']);
  } finally { db.close(); }
});

// JOURNALS_V1_RJ2 (финальное ревью, F6) — края возвратов, настоящими RPC кассы.
// (а) refund_payment с void_when_zero:false: счёт оставлен открытым, денег на
//     нём ноль, строка к нему привязана. Выплата врачу её не платит
//     (NOT_FULLY_REFUNDED_SQL) — журнал считает так же. Частичный возврат —
//     строка остаётся (как и у выплаты).
// (б) Полный возврат по счёту госпитализации, пока пациент лежит: работа
//     сделана и будет выставлена заново — строка акта остаётся. Возврат после
//     выписки — строки нет (тест «возвраты настоящей кассой» выше).
test('возвраты: полный возврат с открытым счётом — строки нет (как у выплаты врачу); частичный — есть; возврат по счёту лежащего пациента — строка акта есть', () => {
  const db = clinic();
  try {
    const visitLine = (vid, vsId, patient, day, svc) => {
      db.prepare("INSERT INTO visits (id, patient_id, visit_date, status) VALUES (?, ?, ?, 'arrived')").run(vid, patient, at(day));
      db.prepare("INSERT INTO visit_services (id, visit_id, service_id, doctor_id, quantity, unit_price, total, status) VALUES (?,?,?,1,1,0,0,'completed')").run(vsId, vid, svc);
      const inv = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [vsId] }, registrar).invoice;
      recordPayment(db, { invoice_id: inv.id, amount: inv.total_amount, method: 'cash' }, cashier);
      return inv;
    };
    const days = () => col(journal(db, { from: '2026-03-27', to: '2026-03-28' }), 'Дата');
    const open = visitLine(22, 53, 1, '2026-03-27', SVC.usgKid);
    const part = visitLine(23, 54, 1, '2026-03-28', SVC.usgKid);
    assert.deepEqual(days(), ['2026-03-27', '2026-03-28']);
    const payOf = (inv) => db.prepare('SELECT id FROM payments WHERE invoice_id = ? AND amount > 0').get(inv.id).id;
    refundPayment(db, { payment_id: payOf(open), void_when_zero: false }, cashier);
    refundPayment(db, { payment_id: payOf(part), amount: 20000 }, cashier);
    assert.notEqual(db.prepare('SELECT status FROM invoices WHERE id = ?').get(open.id).status, 'void', 'стенд не тот: счёт отменён');
    assert.ok(itemOf(db, 53), 'стенд не тот: строка отпущена со счёта');
    assert.deepEqual(days(), ['2026-03-28'], 'полностью возвращённая строка открытого счёта — не в журнале; частично — в журнале');
    // (б) Валиев лежит (ИБ-8): счёт на ЭКГ 22.03 оплачен и полностью возвращён.
    assert.ok(col(journal(db), 'Дата').includes('2026-03-22'));
    const admInv = createInvoiceForAdmission(db, { admission_id: 2, admission_service_ids: [5] }, registrar).invoice;
    recordPayment(db, { invoice_id: admInv.id, amount: admInv.total_amount, method: 'cash' }, cashier);
    fullRefund(db, admInv.id);
    assert.notEqual(db.prepare('SELECT status FROM invoices WHERE id = ?').get(admInv.id).status, 'void', 'касса не отменяет счёт лежащего пациента');
    assert.ok(col(journal(db), 'Дата').includes('2026-03-22'), 'возврат, пока пациент лежит, — работа сделана, строка остаётся');
    // Кассир всё же отменил счёт с подтверждением «пациент в койке»: строка отпущена
    // с отметкой возврата — работа сделана, её выставят заново; строка остаётся.
    voidInvoice(db, { invoice_id: admInv.id, in_bed_ack: true, reason: 'счёт переделывают' }, cashier);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM pay_refund_releases WHERE kind = 'in' AND line_id = 5").get().n, 1, 'стенд не тот: отметки нет');
    assert.ok(col(journal(db), 'Дата').includes('2026-03-22'), 'отмена счёта лежащего пациента после возврата убрала сделанную работу');
  } finally { db.close(); }
});

// ── Цепочки: рекомендации из кабинета, консультации направивших, заключения ──
function chains(db) {
  const rec = db.prepare(`INSERT INTO recommended_services (patient_id, service_id, recommended_by, recommended_by_name, status, created_at)
                          VALUES (?,?,?,?,?,?)`);
  rec.run(1, SVC.usgAbd, 2, 'Терапевт Т.Т.', 'pending', at('2026-03-05'));
  rec.run(1, SVC.usgAbd, 3, 'Лечащий Л.Л.', 'cancelled', at('2026-03-08'));   // удалена в кабинете — не направление
  rec.run(1, SVC.usgAbd, 4, 'Кардиолог К.К.', 'done', at('2026-03-12'));
  rec.run(2, SVC.usgAbd, null, 'Внешний Врач', 'pending', at('2026-03-20'));   // позже визита — не в счёт
  const doc = db.prepare(`INSERT INTO visit_documents (visit_service_id, visit_id, patient_id, doc_type, body, created_by, created_at, voided_at)
                          VALUES (?,?,?,?,?,?,?,?)`);
  const j = (o) => JSON.stringify(o);
  // Консультация терапевта (строка 11, врач 2); подписал администратор.
  doc.run(11, 9, 1, 'protocol', j({ diagnoses: [{ code: 'K29', name: 'Гастрит', type: 'concomitant' }, { code: 'R10.4', name: 'Боль в животе', type: 'main' }], dx: 'Боль в животе' }), 9, '2026-03-09T07:00:00Z', null);
  doc.run(11, 9, 1, 'protocol', j({ diagnoses: [{ code: 'Z00', name: 'Осмотр', type: 'main' }] }), 2, '2026-03-09T07:30:00Z', '2026-03-09T07:40:00Z');   // отозван
  doc.run(null, null, 1, 'protocol', j({ dx: 'I25 — ИБС' }), 4, '2026-02-01T07:00:00Z', null);   // кардиолог, но за 41 день до визита 4
  doc.run(null, null, 4, 'protocol', j({ dx: 'I20 — Стенокардия' }), 4, '2026-03-04T07:00:00Z', null);
  // Заключения строк журнала.
  doc.run(2, 2, 1, 'diag', j({ conclusion: 'Старое заключение' }), 1, '2026-03-10T08:00:00Z', '2026-03-10T08:30:00Z');   // отозвано
  doc.run(2, 2, 1, 'diag', j({ description: 'Печень увеличена', conclusion: 'Гепатомегалия' }), 1, '2026-03-10T08:30:00Z', null);
  doc.run(3, 3, 1, 'protocol', j({ conclusionText: 'Синусовый ритм, ЧСС 72', dx: 'I49' }), 1, at('2026-03-12'), null);
  doc.run(1, 1, 1, 'diag', j({ conclusion: '', description: 'Без патологии' }), 1, at('2026-03-09'), null);
  doc.run(4, 4, 1, 'diag', j({ conclusion: 'Отозванное' }), 1, at('2026-03-13'), '2026-03-13T08:00:00Z');
  doc.run(8, 6, 3, 'diag', '{oops', 1, at('2026-03-25'), null);   // битое тело — пусто, не 500
  doc.run(7, 5, 2, 'diag', j({ conclusion: 'Х'.repeat(400) }), 1, at('2026-03-15'), null);
  // JOURNALS_V1_CONCLUSION — «Заключение» кабинета пустое: «Диагноз» (основной «код — название»).
  doc.run(9, 7, 4, 'protocol', j({ conclusionText: '', diagnoses: [{ code: 'I20.8', name: 'Стенокардия напряжения', type: 'main' }], dx: 'Стенокардия' }), 1, at('2026-03-05'), null);
}

test('кто направил: ближайшая рекомендация не позже дня визита; удалённая и поздняя — не в счёт', () => {
  const db = clinic();
  try {
    chains(db);
    assert.deepEqual(col(journal(db), 'Кто направил'), ['сам', 'Кардиолог К.К.', 'Терапевт Т.Т.', 'Лечащий Л.Л.', 'Лечащий Л.Л.',
      'Лечащий Л.Л.', 'Кардиолог К.К.', 'Клиника «Шифо»', 'Стационар', 'Стационар']);
  } finally { db.close(); }
});

// JOURNALS_V1_RJ1 (ревью, п. 5) — рекомендация из кабинета называет направившего,
// только если она за 90 дней до визита и не закрыта раньше него.
test('кто направил: старая и выполненная до визита рекомендация — не в счёт; закрытая этим визитом — в счёт', () => {
  const db = clinic();
  try {
    const rec = db.prepare(`INSERT INTO recommended_services (patient_id, service_id, recommended_by, recommended_by_name, status, created_at, closed_at)
                            VALUES (2, ?, ?, ?, ?, ?, ?)`);
    const who = () => objectsOf(journal(db)).find((o) => o['Дата'] === '2026-03-15')['Кто направил'];
    rec.run(SVC.usgKid, 4, 'Кардиолог К.К.', 'done', '2025-07-10T07:00:00Z', '2025-07-11T07:00:00Z');   // восемь месяцев, выполнена
    rec.run(SVC.usgKid, 2, 'Терапевт Т.Т.', 'pending', '2025-12-01T07:00:00Z', null);                 // 104 дня — старше окна
    rec.run(SVC.usgKid, 3, 'Лечащий Л.Л.', 'done', at('2026-03-01'), at('2026-03-03'));               // выполнена до визита
    assert.equal(who(), 'Клиника «Шифо»');
    rec.run(SVC.usgKid, 4, 'Кардиолог К.К.', 'done', at('2026-03-10'), '2026-03-15T09:00:00Z');       // закрыта этим визитом
    assert.equal(who(), 'Кардиолог К.К.');
  } finally { db.close(); }
});

test('диагноз при направлении: основной диагноз подписанной консультации направившего врача за 30 дней', () => {
  const db = clinic();
  try {
    chains(db);
    assert.deepEqual(col(journal(db), 'Диагноз при направлении'), ['', 'I20 — Стенокардия', 'R10.4 — Боль в животе',
      'K35.8 — Острый аппендицит', 'K35.8 — Острый аппендицит', 'K35.8 — Острый аппендицит', '', '', 'I10 — Гипертензия', 'I10 — Гипертензия']);
  } finally { db.close(); }
});

// JOURNALS_V1_CONCLUSION (владелец, 02.10): «the fields of the "conclusion" in
// the journal → the "diagnosis" or "conclusion" in the doctors cabinet. if lab
// or any other leave blank or offer something» → «Status only». Подписанный
// документ строки: «Заключение» кабинета, иначе «Диагноз»; без него — у прочей
// услуги «Выполнено», если она отмечена выполненной; иначе пусто.
test('заключение: подписанный документ — «Заключение», иначе «Диагноз»; отозванное и описание — нет; без документа — «Выполнено» шаблоном', () => {
  const db = clinic();
  try {
    chains(db);
    const r = journal(db);
    const c = col(r, 'Заключение');
    assert.deepEqual(c.slice(0, 7), ['Выполнено', 'I20.8 — Стенокардия напряжения', 'Выполнено', 'Гепатомегалия', 'Выполнено',
      'Синусовый ритм, ЧСС 72', 'Выполнено']);
    assert.equal(c[7].length, 400, 'сервер отдаёт заключение целиком — обрезает только экран');
    assert.deepEqual(c.slice(8), ['Выполнено', 'Выполнено'], 'выполненная строка акта — «Выполнено»; битое тело документа — статус строки');
    const ci = r.columns.indexOf('Заключение');
    assert.deepEqual(r.cells_t.filter((t) => t[1] === ci), [0, 2, 4, 6, 8, 9].map((ri) => [ri, ci, 'Выполнено', {}]),
      'статус переводится шаблоном: столбец «Заключение» — не перечисление');
  } finally { db.close(); }
});

// JOURNALS_V1_RJ1 (ревью, п. 6) — «подписанное врачом»: /api/db пускает и
// регистратуру, и медсестру писать документы diag/protocol. Документ врача —
// только если его автор (created_by) — врач этой строки, врач (is_doctor) или
// администратор (роль или дополнительная роль); остальное журнал не читает.
test('заключение — только документ врача: автор — врач строки, любой врач или администратор; документ регистратора — нет', () => {
  const db = clinic();
  try {
    const u = db.prepare('INSERT INTO users (id, username, password_hash, role, full_name, is_doctor, extra_roles) VALUES (?,?,?,?,?,?,?)');
    u.run(6, 'nurse', 'x', 'nurse', 'Медсестра М.М.', 0, '[]');
    u.run(5, 'reg2', 'x', 'registrar', 'Регистратор-админ', 0, JSON.stringify(['admin']));
    db.prepare('UPDATE visit_services SET doctor_id = 6 WHERE id = 8').run();   // исполнитель строки — медсестра
    const doc = db.prepare(`INSERT INTO visit_documents (visit_service_id, visit_id, patient_id, doc_type, body, created_by, created_at)
                            VALUES (?, ?, ?, 'diag', ?, ?, ?)`);
    const j = (t) => JSON.stringify({ conclusion: t });
    doc.run(10, 8, 2, j('Регистратор вписал'), 7, '2026-03-02T09:00:00Z');   // не врач — не читается
    doc.run(1, 1, 1, j('Другой врач'), 2, '2026-03-09T09:00:00Z');
    doc.run(4, 4, 1, j('Админ по совместительству'), 5, '2026-03-13T09:00:00Z');
    doc.run(7, 5, 2, j('Админ подписал'), 9, '2026-03-15T09:00:00Z');
    doc.run(8, 6, 3, j('Исполнитель-медсестра'), 6, '2026-03-25T09:00:00Z');
    const c = col(journal(db), 'Заключение');
    assert.deepEqual([c[0], c[2], c[6], c[7], c[9]],
      ['Выполнено', 'Другой врач', 'Админ по совместительству', 'Админ подписал', 'Исполнитель-медсестра']);
  } finally { db.close(); }
});

// JOURNALS_V1_RJ2 (финальное ревью, F2) — документы, подписанные в кабинете до
// v3.12.0 (970cc91, 27.09), записаны без created_by: кабинет вставлял их сам,
// а автора сервер ставит только с тех пор. Но кабинет ВСЕГДА писал в тело
// meta.signedBy (DOC_AMEND_AUDIT_V1) — по нему такой документ и признаётся
// подписанным. Без автора и без meta.signedBy (запись через /api/db) — нет.
test('заключение: документ до 3.12 без автора, но с meta.signedBy — подписан; без автора и без подписи — не читается', () => {
  const db = clinic();
  try {
    const doc = db.prepare(`INSERT INTO visit_documents (visit_service_id, visit_id, patient_id, doc_type, body, created_by, created_at)
                            VALUES (?, ?, ?, ?, ?, NULL, ?)`);
    doc.run(1, 1, 1, 'diag', JSON.stringify({ description: 'Печень без особенностей', conclusion: 'Норма (до 3.12)',
      meta: { signedBy: 'УЗИст У.У.', signedAt: '2026-03-09T08:00:00.000Z', version: 1 } }), at('2026-03-09'));
    doc.run(10, 8, 2, 'diag', JSON.stringify({ conclusion: 'Вписано без подписи' }), at('2026-03-02'));
    const c = col(journal(db), 'Заключение');
    assert.equal(c[2], 'Норма (до 3.12)', 'подписанный в кабинете до 3.12 — заключение есть');
    assert.equal(c[0], 'Выполнено', 'без автора и без meta.signedBy — документа нет, статус строки');
  } finally { db.close(); }
});

// JOURNALS_V1_RJ2 (финальное ревью, F4, F5) — какой документ даёт «Заключение».
// F4: документ строки другого пациента (visit_service_id совпал, patient_id —
// нет) — не её. F5: новый документ без текста не прячет старый подписанный —
// берётся последний документ С ТЕКСТОМ.
test('заключение: документ чужого пациента — не читается; новый пустой документ не прячет старый с текстом', () => {
  const db = clinic();
  try {
    const doc = db.prepare(`INSERT INTO visit_documents (visit_service_id, visit_id, patient_id, doc_type, body, created_by, created_at)
                            VALUES (?, ?, ?, 'diag', ?, 1, ?)`);
    doc.run(10, 8, 1, JSON.stringify({ conclusion: 'Чужой пациент' }), '2026-03-02T09:00:00Z');   // строка Бековой, пациент — Азизов
    doc.run(1, 1, 1, JSON.stringify({ conclusion: 'Старое подписанное' }), '2026-03-09T08:00:00Z');
    doc.run(1, 1, 1, JSON.stringify({ conclusion: '', description: 'Повторная подпись без заключения' }), '2026-03-09T10:00:00Z');
    const c = col(journal(db), 'Заключение');
    assert.equal(c[0], 'Выполнено', 'документ другого пациента дал заключение строке');
    assert.equal(c[2], 'Старое подписанное', 'новый пустой документ спрятал старый с текстом');
  } finally { db.close(); }
});

// JOURNALS_V1_RJ1 (ревью, п. 10b) — поле тела документа, записанное объектом
// или списком, печаталось сырым JSON. Берётся только текст (или число); иначе
// поле пустое, и правило идёт дальше («Диагноз», статус строки).
test('заключение: поле-объект в теле документа — не текст: сырой JSON не печатается, правило идёт дальше', () => {
  const db = clinic();
  try {
    const doc = db.prepare(`INSERT INTO visit_documents (visit_service_id, visit_id, patient_id, doc_type, body, created_by, created_at)
                            VALUES (?, ?, ?, ?, ?, 1, ?)`);
    doc.run(7, 5, 2, 'diag', JSON.stringify({ conclusion: { text: 'Объект' }, dx: ['I10'] }), at('2026-03-15'));
    doc.run(10, 8, 2, 'protocol', JSON.stringify({ conclusionText: { a: 1 }, dx: 'I10 — Гипертензия' }), at('2026-03-02'));
    const c = col(journal(db), 'Заключение');
    assert.equal(c[0], 'I10 — Гипертензия', '«Заключение»-объект — дальше «Диагноз»');
    assert.equal(c[7], '', 'ни текста, ни статуса (строка в работе) — пусто');
    assert.ok(!c.some((t) => /[{[]/.test(String(t))), 'сырой JSON в колонке: ' + c.join(' | '));
  } finally { db.close(); }
});

test('заключение анализа: выдан — «Результаты выданы дд.мм.гггг» (день «Проверить и выдать»), не выдан — пусто; документ врача — первым', () => {
  const db = clinic();
  try {
    // Анализы по общему правилу лаборатории (lab-service.js isLabService):
    // 5 — type 'lab', 6 — услуга с привязанной активной панелью.
    db.prepare("INSERT INTO services (id, name, price, type) VALUES (5, 'Общий анализ крови', 50000, 'lab'), (6, 'Глюкоза', 30000, 'other')").run();
    db.prepare("INSERT INTO lab_panels (name, service_id, active) VALUES ('Глюкоза', 6, 1)").run();
    const v = db.prepare("INSERT INTO visits (id, patient_id, visit_date, status) VALUES (?,?,?, 'arrived')");
    const vs = db.prepare('INSERT INTO visit_services (id, visit_id, service_id, doctor_id, quantity, unit_price, total, status, verified_at) VALUES (?,?,?,NULL,1,0,0,?,?)');
    v.run(30, 4, at('2026-03-06')); vs.run(30, 30, 5, 'completed', null);                     // «completed» без выдачи — пусто
    v.run(31, 2, at('2026-03-18')); vs.run(31, 31, 5, 'completed', '2026-03-19T07:00:00Z');   // выдан на следующий день
    v.run(32, 3, at('2026-03-26')); vs.run(32, 32, 6, 'resulted', null);                      // результаты внесены, не выданы
    v.run(34, 1, at('2026-03-20')); vs.run(34, 34, 6, 'completed', '2026-03-20T09:00:00Z');   // выдан, но есть документ врача
    db.prepare(`INSERT INTO visit_documents (visit_service_id, visit_id, patient_id, doc_type, body, created_by, created_at)
                VALUES (34, 34, 1, 'protocol', ?, 1, ?)`).run(JSON.stringify({ conclusionText: 'Гипергликемия' }), at('2026-03-20'));
    db.prepare(`INSERT INTO admission_services (id, admission_id, service_id, doctor_id, quantity, unit_price, total, billable, performed_at, created_at)
                VALUES (30, 1, 5, 3, 1, 0, 0, 1, ?, ?)`).run(at('2026-03-11'), at('2026-03-11'));   // строка акта: выдачи нет — пусто
    const r = journal(db, { service_ids: [5, 6] });
    assert.deepEqual(col(r, 'Дата'), ['2026-03-06', '2026-03-11', '2026-03-18', '2026-03-20', '2026-03-26']);
    assert.deepEqual(col(r, 'Заключение'), ['', '', 'Результаты выданы 19.03.2026', 'Гипергликемия', '']);
    const ci = r.columns.indexOf('Заключение');
    assert.deepEqual(r.cells_t, [[2, ci, 'Результаты выданы {date}', { date: '19.03.2026' }]]);
    const out = journal(db, { service_ids: [5, 6], kind_of_care: 'outpatient' });
    assert.deepEqual(out.cells_t, [[1, out.columns.indexOf('Заключение'), 'Результаты выданы {date}', { date: '19.03.2026' }]],
      'позиция шаблона — в колонках этого журнала');
  } finally { db.close(); }
});

// CABINET_FIX_V1_R3 (F2) — заключение исследования (diag) в журнале — с кодом
// МКБ-10: снимок ревью 2 клал текст врача без кода в conclusionText, и журнал
// печатал «Эхопризнаков патологии нет» без «E71.0 — …». Старый снимок — как прежде.
test('заключение исследования: снимок ревью 2 и старый снимок — код МКБ строкой и текст врача', () => {
  const db = clinic();
  try {
    const doc = db.prepare(`INSERT INTO visit_documents (visit_service_id, visit_id, patient_id, doc_type, body, created_by, created_at)
                            VALUES (?, ?, ?, 'diag', ?, 1, ?)`);
    doc.run(2, 2, 1, JSON.stringify({ description: 'Печень обычных размеров', conclusion: 'E71.0 — Болезнь "кленового сиропа"\nЭхопризнаков патологии нет',
      conclusionAuto: 'E71.0 — Болезнь "кленового сиропа"', conclusionText: 'Эхопризнаков патологии нет' }), at('2026-03-10'));
    doc.run(3, 3, 1, JSON.stringify({ description: 'Ритм синусовый', conclusion: 'N28.9 — Болезнь почки\nНорма' }), at('2026-03-12'));
    const c = col(journal(db), 'Заключение').map(String);
    assert.ok(c.some((t) => t.startsWith('E71.0 — Болезнь "кленового сиропа"') && t.includes('Эхопризнаков патологии нет')), 'снимок ревью 2 без кода: ' + c.join(' | '));
    assert.ok(c.some((t) => t.startsWith('N28.9 — Болезнь почки') && t.includes('Норма')), 'старый снимок читается не как прежде: ' + c.join(' | '));
  } finally { db.close(); }
});
