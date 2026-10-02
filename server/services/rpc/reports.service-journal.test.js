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
    assert.equal(r.notes.length, 4, 'JOURNALS_V1_CONCLUSION — четвёртое примечание: откуда «Заключение»');
    assert.deepEqual(journal(db, { buildings: ['B'] }).rows, []);
    __setReportsPushDown(false);
    try { assert.deepEqual(journal(db).rows, r.rows); } finally { __setReportsPushDown(true); }
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
    assert.deepEqual(c.slice(8), ['', 'Выполнено'], 'строка акта без «Выполнено» — пусто; битое тело документа — статус строки');
    const ci = r.columns.indexOf('Заключение');
    assert.deepEqual(r.cells_t.filter((t) => t[1] === ci), [0, 2, 4, 6, 9].map((ri) => [ri, ci, 'Выполнено', {}]),
      'статус переводится шаблоном: столбец «Заключение» — не перечисление');
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
