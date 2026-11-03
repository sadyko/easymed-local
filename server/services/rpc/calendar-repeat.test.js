// REPEAT_VISIT_V1 (2026-11-02) — «ПОВТОРНЫЙ ВИЗИТ» ЗАНИМАЕТ ВРЕМЯ ОДНОЙ ОПЕРАЦИЕЙ.
//
// Кабинет врача записывал повторный визит тремя запросами (calendar_book —
// всегда 'first', правка visit_kind, строка консультации без времени), а если
// у пациента в тот день уже был визит, окно предлагало «Добавить в этот
// визит» и писало «записан», не заняв ни минуты. И пустая запись одного врача
// переезжала под запись другого (dayVisitMovableFor).
//
// Здесь проверяется сам обработчик:
//   • свободный день — визит 'repeat' и строка консультации одним вызовом,
//     строка со временем приёма и ценой врача, время занято;
//   • у пациента в этот день уже есть визит — отказ revisit_day_taken словами,
//     и в базе НИЧЕГО не изменилось (ни переноса, ни «добавить в этот визит»);
//   • отказ строки откатывает и визит;
//   • цена строки — по дню ВИЗИТА (ярус «второй визит»), а не по сегодняшнему;
//   • пустая запись другого врача не переносится — ни calendar_book, ни
//     ensure_visit; запись без врача и запись того же врача — как прежде.
//
// Время набирается МЕСТНОЕ (new Date(y, m, d, h)), как в calendar.test.js:
// обработчик проверяется вместе с переводом настенного времени в UTC. День —
// ближайший будущий понедельник и дальше: «сегодня» здесь не участвует.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { calendarBook } from './calendar.js';
import { ensureVisit } from './visits.js';
import { dayVisitMovableFor } from '../crm/booking-mirror.js';

const REG = { id: 1, role: 'registrar', extra_roles: [] };
const DOC = { id: 10, role: 'doctor', is_doctor: true, extra_roles: [] };

function nextMonday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  do { d.setDate(d.getDate() + 1); } while (d.getDay() !== 1);
  return d;
}
const MON = nextMonday();
/** ISO момента: понедельник MON + `day` дней, местные hh:mm. */
const at = (day, hh, mm = 0) => new Date(MON.getFullYear(), MON.getMonth(), MON.getDate() + day, hh, mm, 0, 0).toISOString();

function freshDb() {
  const db = openDb(':memory:');
  migrate(db);
  const u = db.prepare('INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (?,?,?,?,?,?)');
  u.run(1, 'reg', 'x', 'Регистратор', 'registrar', 0);
  u.run(10, 'doc', 'x', 'Иванов Иван', 'doctor', 1);
  u.run(11, 'doc2', 'x', 'Петров Пётр', 'doctor', 1);
  u.run(12, 'nurse', 'x', 'Медсестра', 'nurse', 0);
  db.prepare("INSERT INTO patients (id, full_name) VALUES (77, 'Пациент Тест')").run();
  db.prepare("INSERT INTO patients (id, full_name) VALUES (78, 'Другой Пациент')").run();
  db.prepare("INSERT INTO consultation_types (id, name, name_ru, price, sort_order, active) VALUES (6, 'Повторный', 'Повторный приём', 60000, 1, 1)").run();
  db.prepare('INSERT INTO doctor_consultation_prices (doctor_id, consultation_type_id, price, available, is_free) VALUES (10, 6, 120000, 1, 0)').run();
  // Осмотр невролога: второй визит с 5-го по 30-й день — 60 000 вместо 100 000.
  db.prepare("INSERT INTO services (id, name, price, type, price_secondary, secondary_days_from, secondary_days_to) VALUES (31, 'Осмотр невролога', 100000, 'consultation', 60000, 5, 30)").run();
  db.prepare("INSERT INTO services (id, name, price, type) VALUES (32, 'Операция', 900000, 'other')").run();
  return db;
}

test('REPEAT_VISIT_V1: пустая запись другого врача не переносится — ни calendar_book, ни ensure_visit', async () => {
  const db = freshDb();
  try {
    const a = await calendarBook(db, { patient_id: 77, doctor_id: 11, start: at(7, 9), duration_minutes: 30 }, REG);
    assert.equal(dayVisitMovableFor(db, a.visit.id, 10), false, 'запись Петрова отдана Иванову');
    assert.equal(dayVisitMovableFor(db, a.visit.id, 11), true, 'тот же врач — перенос его же записи');
    await assert.rejects(
      () => calendarBook(db, { patient_id: 77, doctor_id: 10, start: at(7, 14), duration_minutes: 30 }, REG),
      (e) => e.code === 'day_visit_other_doctor');   // поправка 2 — честные слова, тест ниже
    const ens = await ensureVisit(db, { patient_id: 77, date: at(7, 14), doctor_id: 10,
      book: { doctor_id: 10, start: at(7, 14), duration_minutes: 30 } }, REG);
    assert.deepEqual([ens.booked, ens.reason], [false, 'day_visit_busy']);
    const v = db.prepare('SELECT doctor_id, visit_date FROM visits WHERE id = ?').get(a.visit.id);
    assert.equal(v.doctor_id, 11, 'врач чужой записи переписан');
    assert.equal(Date.parse(v.visit_date), Date.parse(at(7, 9)), 'время чужой записи переписано');
    // Запись без врача — переносится под любого врача, как прежде.
    const b = await calendarBook(db, { patient_id: 78, start: at(7, 9), duration_minutes: 30 }, REG);
    assert.equal(dayVisitMovableFor(db, b.visit.id, 10), true);
    const moved = await calendarBook(db, { patient_id: 78, doctor_id: 10, start: at(7, 15), duration_minutes: 30 }, REG);
    assert.deepEqual([moved.moved, moved.visit.id, moved.visit.doctor_id], [true, b.visit.id, 10]);
  } finally { db.close(); }
});

// REPEAT_VISIT_V1 (поправка 2) — ЧЕСТНЫЕ СЛОВА ОТКАЗА. После правила выше запись к
// врачу Б в день, где у пациента ПУСТАЯ запись к врачу А, получала day_visit_busy
// «…и по нему уже идёт работа…» — работы нет, есть чужая запись. Теперь — свой код
// и слова «уже есть запись к <врач> в <время>»; «добавить в этот визит» остаётся
// (один пациент — один визит дня), а визит с работой — прежний отказ.
test('REPEAT_VISIT_V1 (поправка 2): пустая запись к другому врачу — отказ day_visit_other_doctor «уже есть запись к … в …»', async () => {
  const db = freshDb();
  try {
    const a = await calendarBook(db, { patient_id: 77, doctor_id: 11, start: at(7, 9), duration_minutes: 30 }, REG);
    for (const extra of [{ doctor_id: 10 }, {}]) {   // к другому врачу и без врача
      await assert.rejects(
        () => calendarBook(db, { patient_id: 77, start: at(7, 14), duration_minutes: 30, ...extra }, REG),
        (e) => {
          assert.equal(e.status, 409);
          assert.equal(e.code, 'day_visit_other_doctor');
          assert.deepEqual(e.params, { visit_id: a.visit.id, start: '09:00', doctor: 'Петров Пётр' });
          assert.equal(e.message, 'У пациента в этот день уже есть запись к Петров Пётр в 09:00. Перенесите её или выберите другой день.');
          assert.equal(e.template, 'У пациента в этот день уже есть запись к {doctor} в {start}. Перенесите её или выберите другой день.');
          return true;
        });
    }
    const v = db.prepare('SELECT doctor_id, visit_date FROM visits WHERE id = ?').get(a.visit.id);
    assert.deepEqual([v.doctor_id, Date.parse(v.visit_date)], [11, Date.parse(at(7, 9))], 'отказ тронул ту запись');
    // Согласие «добавить в этот визит» — как у day_visit_busy: ответом визит дня.
    const add = await calendarBook(db, { patient_id: 77, doctor_id: 10, start: at(7, 14), duration_minutes: 30, add_to_day_visit: true }, REG);
    assert.deepEqual([add.added_to_day_visit, add.visit.id], [true, a.visit.id]);
    // По визиту дня есть работа (счёт) — прежний отказ day_visit_busy: его слова верны.
    db.prepare("INSERT INTO invoices (invoice_number, visit_id, patient_id, subtotal, total_amount) VALUES ('INV-U8-1', ?, 77, 1000, 1000)").run(a.visit.id);
    await assert.rejects(() => calendarBook(db, { patient_id: 77, doctor_id: 10, start: at(7, 14), duration_minutes: 30 }, REG),
      (e) => e.code === 'day_visit_busy');
  } finally { db.close(); }
});

// REPEAT_VISIT_V1 (ревью, minor-2) — ЗАПИСЬ КОЛЛ-ЦЕНТРА К ДРУГОМУ ВРАЧУ — ТОЖЕ «ЗАПИСЬ».
// Запись колл-центра до прихода держит строку своей консультации в смете ('added',
// без счёта и работы). Правило выше требовало ноль живых строк, и такая запись
// получала day_visit_busy «…и по нему уже идёт работа…» — работы нет. Свободные
// строки в смете слов не меняют: решают статус до прихода, отсутствие работы и врач
// визита ≠ врач новой записи. «Добавить в этот визит» — как прежде, у обоих кодов.
test('REPEAT_VISIT_V1 (ревью, minor-2): запись колл-центра к другому врачу со строкой в смете — day_visit_other_doctor, а не «уже идёт работа»', async () => {
  const db = freshDb();
  try {
    const a = await calendarBook(db, { patient_id: 77, doctor_id: 11, start: at(7, 9), duration_minutes: 30 }, REG);
    db.prepare("INSERT INTO visit_services (visit_id, consultation_type_id, doctor_id, status) VALUES (?, 6, 11, 'added')").run(a.visit.id);
    db.prepare("INSERT INTO visit_services (visit_id, service_id, status) VALUES (?, 31, 'added')").run(a.visit.id);   // и услуга «на дату» без врача
    await assert.rejects(
      () => calendarBook(db, { patient_id: 77, doctor_id: 10, start: at(7, 14), duration_minutes: 30 }, REG),
      (e) => {
        assert.deepEqual([e.status, e.code], [409, 'day_visit_other_doctor']);
        assert.equal(e.message, 'У пациента в этот день уже есть запись к Петров Пётр в 09:00. Перенесите её или выберите другой день.');
        return true;
      });
    const v = db.prepare('SELECT doctor_id, visit_date FROM visits WHERE id = ?').get(a.visit.id);
    assert.deepEqual([v.doctor_id, Date.parse(v.visit_date)], [11, Date.parse(at(7, 9))], 'отказ тронул ту запись');
    const add = await calendarBook(db, { patient_id: 77, doctor_id: 10, start: at(7, 14), duration_minutes: 30, add_to_day_visit: true }, REG);
    assert.deepEqual([add.added_to_day_visit, add.visit.id], [true, a.visit.id], '«Добавить в этот визит» перестало работать');
    // Строка отпущена кассой — это уже работа: прежний day_visit_busy.
    db.prepare("UPDATE visit_services SET status = 'queued' WHERE visit_id = ? AND service_id = 31").run(a.visit.id);
    await assert.rejects(() => calendarBook(db, { patient_id: 77, doctor_id: 10, start: at(7, 14), duration_minutes: 30 }, REG),
      (e) => e.code === 'day_visit_busy');
  } finally { db.close(); }
});

const snapshot = (db) => ({
  visits: db.prepare('SELECT id, patient_id, doctor_id, visit_date, visit_kind, status FROM visits ORDER BY id').all(),
  lines: db.prepare('SELECT id, visit_id FROM visit_services ORDER BY id').all(),
});
const repeatArgs = (over = {}) => ({
  patient_id: 77, doctor_id: 10, start: at(7, 14), duration_minutes: 30, status: 'scheduled',
  notes: 'Контроль после лечения', visit_kind: 'repeat', line: { consultation_type_id: 6 }, ...over,
});

test('REPEAT_VISIT_V1: свободный день — визит «повторный» и консультация одним вызовом, время занято', async () => {
  const db = freshDb();
  try {
    const out = await calendarBook(db, repeatArgs(), DOC);
    assert.equal(out.created, true);
    assert.equal(out.visit.visit_kind, 'repeat', 'визит записан «первичным»');
    const lines = db.prepare('SELECT * FROM visit_services WHERE visit_id = ?').all(out.visit.id);
    assert.equal(lines.length, 1, 'строка консультации не легла вместе с визитом');
    const l = lines[0];
    assert.deepEqual([l.consultation_type_id, l.service_id, l.doctor_id, l.status, l.unit_price, l.total],
      [6, null, 10, 'added', 120000, 120000], 'строка: вид приёма, врач записи, цена врача');
    assert.equal(Date.parse(l.scheduled_at), Date.parse(out.visit.visit_date), 'у строки нет времени приёма');
    assert.equal(out.line && out.line.id, l.id, 'ответ не называет строку');
    await assert.rejects(
      () => calendarBook(db, { patient_id: 78, doctor_id: 10, start: at(7, 14), duration_minutes: 30 }, REG),
      (e) => e.code === 'slot_taken', 'время повторного визита осталось свободным');
  } finally { db.close(); }
});

// REPEAT_VISIT_V1 (ревью, minor-4) — СВЕРКА КАРТОЧКИ CRM ПОСЛЕ COMMIT НЕ ОТМЕНЯЕТ ЗАПИСЬ.
// onVisitLinesAdded звался за транзакцией без try/catch: сбой карточки отдавал браузеру
// 500, когда визит и строка уже сохранены, — окно писало «Не удалось записать», а
// повтор упирался в revisit_day_taken. Теперь — как у кассы (billing.js): лог, ответ.
test('REPEAT_VISIT_V1 (ревью, minor-4): сбой сверки карточки после записи — ответ с визитом и строкой, ошибка в логе', async () => {
  const db = freshDb();
  const logged = [];
  const origError = console.error;
  console.error = (...a) => { logged.push(a.map(String).join(' ')); };
  try {
    const out = await calendarBook(db, repeatArgs(), DOC, { onVisitLinesAdded: () => { throw new Error('карточка сломана'); } });
    assert.deepEqual([out.created, out.visit.visit_kind, !!(out.line && out.line.id)], [true, 'repeat', true], 'запись с ответом не вернулась');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM visit_services WHERE visit_id = ?').get(out.visit.id).n, 1);
    assert.ok(logged.some((l) => l.includes('карточка сломана') && l.includes(String(out.visit.id))), 'сбой не попал в лог: ' + JSON.stringify(logged));
  } finally { console.error = origError; db.close(); }
});

test('REPEAT_VISIT_V1: у пациента в этот день уже есть визит — отказ словами, ничего не записано', async () => {
  const db = freshDb();
  try {
    // Пустая запись к Петрову в 09:00 — без строк и без счёта.
    await calendarBook(db, { patient_id: 77, doctor_id: 11, start: at(7, 9), duration_minutes: 30 }, REG);
    const before = snapshot(db);
    for (const extra of [{}, { add_to_day_visit: true }]) {
      await assert.rejects(() => calendarBook(db, repeatArgs(extra), DOC), (e) => {
        assert.equal(e.status, 409);
        assert.equal(e.code, 'revisit_day_taken');
        assert.deepEqual([e.params.start, e.params.doctor], ['09:00', 'Петров Пётр']);
        assert.equal(e.message, 'У пациента в этот день уже есть приём в 09:00 у Петров Пётр — выберите другой день или время.');
        assert.equal(e.template, 'У пациента в этот день уже есть приём в {start} у {doctor} — выберите другой день или время.');
        return true;
      });
      assert.deepEqual(snapshot(db), before, 'отказ что-то записал или перенёс');
    }
    // Своя запись того же врача в этот день — тоже отказ, а не перенос на новое время.
    const own = await calendarBook(db, repeatArgs({ patient_id: 78, start: at(8, 14) }), DOC);
    await assert.rejects(() => calendarBook(db, repeatArgs({ patient_id: 78, start: at(8, 16) }), DOC),
      (e) => e.code === 'revisit_day_taken' && e.params.start === '14:00');
    assert.equal(Date.parse(db.prepare('SELECT visit_date FROM visits WHERE id = ?').get(own.visit.id).visit_date), Date.parse(at(8, 14)));
  } finally { db.close(); }
});

test('REPEAT_VISIT_V1: отказ строки откатывает визит; неверный вид, услуга без врача и правка записи — отказ', async () => {
  const db = freshDb();
  try {
    await assert.rejects(() => calendarBook(db, repeatArgs({ line: { service_id: 32 } }), DOC),
      (e) => e.status === 400 && /хирургия/.test(e.message));
    await assert.rejects(() => calendarBook(db, repeatArgs({ line: { consultation_type_id: 999 } }), DOC),
      (e) => e.status === 400 && /Вид приёма не найден/.test(e.message));
    await assert.rejects(() => calendarBook(db, repeatArgs({ visit_kind: 'weird' }), DOC), /Вид визита указан неверно/);
    await assert.rejects(() => calendarBook(db, repeatArgs({ doctor_id: undefined }), REG), /выберите врача/);
    await assert.rejects(() => calendarBook(db, repeatArgs({ doctor_id: 12 }), REG), /среди врачей клиники/);
    assert.deepEqual(snapshot(db), { visits: [], lines: [] }, 'после отказа остался визит или строка');
    const ok = await calendarBook(db, { patient_id: 77, doctor_id: 10, start: at(7, 9), duration_minutes: 30 }, REG);
    await assert.rejects(() => calendarBook(db, { visit_id: ok.visit.id, start: at(7, 10), visit_kind: 'repeat' }, REG),
      /только новой записи/);
    assert.equal(db.prepare('SELECT visit_kind FROM visits WHERE id = ?').get(ok.visit.id).visit_kind, 'first');
  } finally { db.close(); }
});

test('REPEAT_VISIT_V1: цена строки — по дню ВИЗИТА: через 10 дней после первого — ярус «второй визит»', async () => {
  const db = freshDb();
  try {
    const first = await calendarBook(db, repeatArgs({ visit_kind: 'first', start: at(0, 10), line: { service_id: 31 } }), REG);
    assert.deepEqual([first.line.price_tier, first.line.unit_price], ['primary', 100000]);
    // Сегодня первого приёма ещё нет (он в будущем понедельнике) — котировка
    // «на сегодня» дала бы первичную цену. День визита — через 10 дней после.
    const rep = await calendarBook(db, repeatArgs({ start: at(10, 10), line: { service_id: 31 } }), DOC);
    assert.deepEqual([rep.line.price_tier, rep.line.unit_price], ['secondary', 60000], 'цена посчитана не по дню визита');
  } finally { db.close(); }
});

// REPEAT_VISIT_V1 (поправка 3) — строка записи calendar_book — такая же дверь
// строки визита, как касса и /api/db: проверка повтора U9 (domain/dup-order.js)
// ДО вставки и журнал обхода ПОСЛЕ, в той же транзакции. Визит здесь всегда
// новый, повтору в нём взяться неоткуда, поэтому поведением проверку не
// увидеть — проверяется сама дверь (исходник), чтобы следующая правка вставки
// её не потеряла.
test('REPEAT_VISIT_V1 (поправка 3): вставка строки calendar_book — между assertOrders и logRepeatOrders', () => {
  const src = fs.readFileSync(new URL('./calendar.js', import.meta.url), 'utf8');
  const at = src.indexOf('lineId = insertBookingLine(');
  assert.ok(at > 0, 'вставки строки записи в calendar_book нет');
  assert.match(src.slice(Math.max(0, at - 1500), at), /const orders = assertOrders\(db, \[\{ visit_id: id,[^\n]*\n?[^\n]*\], \{ user, reason: repeatReasonArg\(a\) \}\);/,
    'перед вставкой нет проверки повтора');
  assert.match(src.slice(at, at + 1500), /logRepeatOrders\(db, orders, user\);/, 'после вставки нет журнала обхода');
});

// REPEAT_VISIT_V1 · К6 (дизайн, касса «Платежи») — строка повторного визита —
// обычная строка визита для обоих окон кассы: «Заменить услугу» в
// неоплаченном счёте и «Вернуть услугу» после оплаты.
test('REPEAT_VISIT_V1 (К6): строку повторного визита касса заменяет и возвращает, как любую', async () => {
  const { createInvoiceForVisit, recordPayment, refundInvoiceLine, changeUnpaidService } = await import('./billing.js');
  const { openCashShift } = await import('./cashier.js');
  const db = freshDb();
  try {
    db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (9, 'cash', 'x', 'Кассир', 'cashier')").run();
    db.prepare("INSERT INTO services (id, name, price, type) VALUES (33, 'Осмотр кардиолога', 80000, 'consultation')").run();
    const CASH = { id: 9, role: 'cashier', full_name: 'Кассир', extra_roles: [] };
    openCashShift(db, { opening_float: 0 }, CASH);
    const rep = await calendarBook(db, repeatArgs({ line: { service_id: 31 } }), DOC);
    const bill = createInvoiceForVisit(db, { visit_id: rep.visit.id, visit_service_ids: [rep.line.id] }, REG);
    assert.equal(bill.invoice.total_amount, 100000);
    changeUnpaidService(db, { visit_service_id: rep.line.id, new_service_id: 33 }, REG);
    const swapped = db.prepare('SELECT service_id, scheduled_at FROM visit_services WHERE id = ?').get(rep.line.id);
    assert.equal(swapped.service_id, 33, 'замена не дошла до строки');
    assert.equal(Date.parse(swapped.scheduled_at), Date.parse(rep.visit.visit_date), 'замена потеряла время приёма');
    assert.equal(db.prepare('SELECT total_amount FROM invoices WHERE id = ?').get(bill.invoice.id).total_amount, 80000);
    recordPayment(db, { invoice_id: bill.invoice.id, amount: 80000, method: 'cash' }, CASH);
    const item = db.prepare('SELECT invoice_item_id AS i FROM visit_services WHERE id = ?').get(rep.line.id).i;
    const back = refundInvoiceLine(db, { invoice_item_id: item }, CASH);
    assert.equal(back.refunded, 80000, 'возврат строки повторного визита не вернул деньги');
  } finally { db.close(); }
});
