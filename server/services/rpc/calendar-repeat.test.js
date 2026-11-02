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
