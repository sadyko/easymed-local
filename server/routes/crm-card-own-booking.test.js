// CRM_BOOKING_OWN_CARD_V1 · CRM_CARD_OWN_BOOKING_V1 (3.23.0) — НОВАЯ КАРТОЧКА НЕ ПРЫГАЕТ В
// «ПРИШЁЛ» / «НЕ ПРИШЁЛ» ИЗ-ЗА ЧУЖОГО ВИЗИТА. Владелец (2026-11-10): «when created the new
// card and booked in the calendar (if another card of the patient exists) it either goes to the
// not arrived or arrived».
//
// Причина (план 3.23.0, п. 5): запись не говорила, чья она, сервер угадывал карточку по пациенту,
// а правило «карточка двигалась в окне 72 ч — то же обращение» делало подходящей любую новую
// карточку. Исправление:
//   F1 — запись из карточки называет её (crm_request_id): только её строки садятся, привязываются
//        и двигают ступень;
//   F2 — карточку, у которой своя живая запись на другой день, чужой визит не закрывает;
//   F3 — приход не закрывает карточку без строк, заведённую после того, как заведён визит;
//   F4 — запись без номера карточки берёт ОДНУ карточку (двигавшуюся последней), а желание без
//        даты, севшее в визит другой карточки, свою карточку не двигает.
// Повторный ЗВОНОК в окне 72 ч по-прежнему та же карточка (lead-from-call.js — не тронуто).
//
// Сценарии — воспроизведения расследования (scratchpad inv-crm/repro-item2c.mjs P1, P3, P4, P5;
// repro-item2b.mjs M5 «зеркало»), через настоящие двери под настоящими ролями.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startCrmApp, addLead, daysAgoIso } from '../test-helpers/crm-unify-app.js';
import { openDb } from '../db/connection.js';
import { deskRegister } from '../test-helpers/crm-link-all.js';
import { crmNoShowSweep, crmArrivalCatchUp } from '../services/crm/no-show.js';

// Дни и время — по часам БАЗЫ (SQLite localtime), а не JS: сервер считает местный день визита
// SQLite, и проверка поздним вечером (сдвиг часового пояса JS, tz-late) не должна разводить дни.
const CLOCK = openDb(':memory:');
const pad = (n) => String(n).padStart(2, '0');
const localDay = (off = 0) => CLOCK.prepare("SELECT date('now', 'localtime', ?) AS d").get(off + ' days').d;
const at = (day, hh, mm = 0) => CLOCK.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%SZ', ?, 'utc') AS t").get(day + ' ' + pad(hh) + ':' + pad(mm) + ':00').t;
const today = localDay(0);
const D = localDay(3);
const st = (t, id) => { const r = t.lead(id); return r.status + '@' + (r.scheduled_date || '-'); };
const linkOf = (t, vid) => t.db.prepare('SELECT request_id, source FROM crm_booking_links WHERE visit_id = ?').get(vid) || null;

/** «Сохранить и записать» в карточке (views/crm.js bookDays): ensure_visit с book; ownCard — номер карточки (F1). */
async function bookCard(t, rid, day, hh = 11, { svc = 30, ownCard = true, who = 'cc' } = {}) {
  const args = { patient_id: 77, date: at(day, hh), doctor_id: 10, book: { doctor_id: 10, service_id: svc, start: at(day, hh), duration_minutes: 30 } };
  if (ownCard) args.crm_request_id = rid;
  const b = await t.rpc('ensure_visit', who, args);
  assert.equal(b.status, 200, b.text);
  return b.json.data.visit.id;
}
/** Новая карточка так, как её заводит окно заявки (views/crm.js persist): /api/db. */
async function newCard(t, { day = null, lines = [] } = {}) {
  const r = await t.dbq('cc', { table: 'crm_requests', op: 'insert', returning: true, single: 'single',
    values: { full_name: 'Пациент Тест', phone: '+998 90 909 26 38', patient_id: 77, status: day ? 'scheduled' : 'in_process', source: 'call', scheduled_date: day } });
  assert.equal(r.status, 200, r.text);
  const id = r.json.data.id;
  if (lines.length) {
    const x = await t.dbq('cc', { table: 'crm_request_services', op: 'insert', values: lines.map((l) => ({ request_id: id, status: 'pending', ...l })) });
    assert.equal(x.status, 200, x.text);
  }
  return id;
}
/** Старая карточка A с записью сегодня на 09:00 (её визит заведён час назад). */
async function oldCardBookedToday(t) {
  const A = addLead(t.db, { status: 'in_process', name: 'Пациент Тест', updated: daysAgoIso(6) });
  t.db.prepare("INSERT INTO crm_request_services (request_id, service_id, scheduled_date, doctor_id, status) VALUES (?,30,?,10,'pending')").run(A, today);
  const vA = await bookCard(t, A, today, 9);
  t.db.prepare('UPDATE crm_requests SET updated_at = ? WHERE id = ?').run(daysAgoIso(6), A);
  t.db.prepare("UPDATE visits SET created_at = strftime('%Y-%m-%dT%H:%M:%SZ','now','-1 hour') WHERE id = ?").run(vA);
  return { A, vA };
}

for (const ownCard of [true, false]) {
  test(`P1: новая карточка B записана на +3; сегодня пациента регистрирует стойка по записи A — B остаётся «Записан» на свой день (номер карточки в записи: ${ownCard})`, async () => {
    const t = await startCrmApp();
    try {
      const { A } = await oldCardBookedToday(t);
      const B = await newCard(t, { day: D, lines: [{ service_id: 30, scheduled_date: D, doctor_id: 10 }] });
      const vB = await bookCard(t, B, D, 11, { ownCard });
      assert.equal(st(t, B), 'scheduled@' + D);
      await deskRegister(t, 'reg', { items: [{ svc: 30, doctor: 10 }] });
      assert.equal(st(t, A), 'came@' + today, 'стойка не закрыла карточку, чья это запись');
      assert.equal(st(t, B), 'scheduled@' + D, 'чужой визит закрыл карточку с её собственной записью на другой день');
      assert.deepEqual(t.db.prepare('SELECT scheduled_date, status, visit_id FROM crm_request_services WHERE request_id = ?').all(B),
        [{ scheduled_date: D, status: 'pending', visit_id: vB }]);
      // Наутро ничего не меняется: запись B впереди.
      crmArrivalCatchUp(t.db); crmNoShowSweep(t.db);
      assert.equal(st(t, B), 'scheduled@' + D);
    } finally { t.close(); }
  });
}

test('P3: B заведена (без услуг), пока пациент здесь по визиту A; приход A — B открыта; запись B на +3 привязана к B', async () => {
  const t = await startCrmApp();
  try {
    const { A, vA } = await oldCardBookedToday(t);
    const B = await newCard(t, {});
    const m = await t.rpc('calendar_book', 'reg', { visit_id: vA, start: at(today, 9), status: 'arrived' });
    assert.equal(m.status, 200, m.text);
    assert.equal(st(t, A), 'came@' + today);
    assert.equal(st(t, B), 'in_process@-', 'приход по визиту, заведённому раньше карточки, закрыл новое обращение');
    const b = await t.rpc('calendar_book', 'cc', { patient_id: 77, doctor_id: 10, service_id: 30, start: at(D, 12), duration_minutes: 30, status: 'scheduled' });
    assert.equal(b.status, 200, b.text);
    assert.equal(st(t, B), 'scheduled@' + D);
    assert.equal((linkOf(t, b.json.data.visit.id) || {}).request_id, B, 'запись B ни к какой карточке не привязана');
  } finally { t.close(); }
});

test('P3 (визит и карточка в одну секунду): приход не закрывает карточку, которая не старше визита', async () => {
  const t = await startCrmApp();
  try {
    const A = addLead(t.db, { status: 'in_process', name: 'Пациент Тест', updated: daysAgoIso(6) });
    t.db.prepare("INSERT INTO crm_request_services (request_id, service_id, scheduled_date, doctor_id, status) VALUES (?,30,?,10,'pending')").run(A, today);
    const vA = await bookCard(t, A, today, 9);
    const B = await newCard(t, {});
    t.db.prepare('UPDATE crm_requests SET created_at = (SELECT created_at FROM visits WHERE id = ?), updated_at = (SELECT created_at FROM visits WHERE id = ?) WHERE id = ?').run(vA, vA, B);
    const m = await t.rpc('calendar_book', 'reg', { visit_id: vA, start: at(today, 9), status: 'arrived' });
    assert.equal(m.status, 200, m.text);
    assert.equal(st(t, B), 'in_process@-');
  } finally { t.close(); }
});

test('P4: у B анализ без даты; регистратура открыла визит A — анализ сел в визит, B не сдвинута; A «Не пришёл» — B не уходит в «Не пришёл»', async () => {
  const t = await startCrmApp();
  try {
    const { A, vA } = await oldCardBookedToday(t);
    const B = await newCard(t, { lines: [{ service_id: 40 }] });
    const w = await t.rpc('ensure_visit', 'reg', { patient_id: 77, date: at(today, 9), doctor_id: 10 });
    assert.equal(w.status, 200, w.text);
    assert.equal(w.json.data.visit.id, vA);
    assert.deepEqual(t.db.prepare('SELECT status, visit_id FROM crm_request_services WHERE request_id = ?').all(B), [{ status: 'pending', visit_id: vA }],
      'желание «когда придёт» не село в визит дня (деньги — как прежде)');
    assert.equal(st(t, B), 'in_process@-', 'желание, севшее в визит другой карточки, сдвинуло свою карточку');
    const m = await t.rpc('calendar_book', 'reg', { visit_id: vA, start: at(today, 9), status: 'no_show' });
    assert.equal(m.status, 200, m.text);
    assert.equal(st(t, A).split('@')[0], 'no_show');
    assert.equal(st(t, B), 'in_process@-', 'неявка по чужой записи унесла B в «Не пришёл»');
  } finally { t.close(); }
});

test('P5: A записана вчера и не пришла, B записана на +3 — проход ставит «Не пришёл» только A', async () => {
  const t = await startCrmApp();
  try {
    const y = localDay(-1);
    const A = addLead(t.db, { status: 'in_process', name: 'Пациент Тест', updated: daysAgoIso(6) });
    t.db.prepare("INSERT INTO crm_request_services (request_id, service_id, scheduled_date, doctor_id, status) VALUES (?,30,?,10,'pending')").run(A, y);
    const vA = Number(t.db.prepare("INSERT INTO visits (patient_id, doctor_id, visit_date, status, created_by) VALUES (77, 10, ?, 'scheduled', 3)").run(at(y, 9)).lastInsertRowid);
    t.db.prepare('UPDATE crm_request_services SET visit_id = ? WHERE request_id = ?').run(vA, A);
    t.db.prepare("UPDATE crm_requests SET status = 'scheduled', scheduled_date = ? WHERE id = ?").run(y, A);
    const B = await newCard(t, { day: D, lines: [{ service_id: 30, scheduled_date: D, doctor_id: 10 }] });
    await bookCard(t, B, D, 11);
    crmArrivalCatchUp(t.db); crmNoShowSweep(t.db);
    assert.equal(st(t, A), 'no_show@' + y);
    assert.equal(st(t, B), 'scheduled@' + D);
  } finally { t.close(); }
});

// Зеркало: старая карточка A в «Не пришёл» (меньше 72 ч), новая запись по B — A не тащится.
for (const how of ['card', 'calendar']) {
  test(`зеркало: A в «Не пришёл» (в окне 72 ч), новая запись по B (${how === 'card' ? 'из карточки, с её номером' : 'из календаря, без номера'}) — A остаётся «Не пришёл»`, async () => {
    const t = await startCrmApp();
    try {
      const y = localDay(-1);
      const vA = Number(t.db.prepare("INSERT INTO visits (patient_id, doctor_id, visit_date, status, created_by) VALUES (77, 10, ?, 'scheduled', 3)").run(at(y, 9)).lastInsertRowid);
      const A = addLead(t.db, { status: 'scheduled', date: y, name: 'Пациент Тест', updated: daysAgoIso(2) });
      t.db.prepare("INSERT INTO crm_request_services (request_id, service_id, scheduled_date, status, doctor_id, visit_id) VALUES (?,30,?,'pending',10,?)").run(A, y, vA);
      t.db.prepare("INSERT INTO crm_booking_links (visit_id, request_id, source, created_by, created_request) VALUES (?,?,'callcenter',3,0)").run(vA, A);
      crmNoShowSweep(t.db);
      assert.equal(st(t, A), 'no_show@' + y);
      let B, vB;
      if (how === 'card') {
        B = await newCard(t, { day: D, lines: [{ service_id: 30, scheduled_date: D, doctor_id: 10 }] });
        vB = await bookCard(t, B, D, 11);
      } else {
        B = await newCard(t, {});
        const b = await t.rpc('calendar_book', 'cc', { patient_id: 77, doctor_id: 10, service_id: 30, start: at(D, 11), duration_minutes: 30, status: 'scheduled' });
        assert.equal(b.status, 200, b.text);
        vB = b.json.data.visit.id;
      }
      assert.equal(st(t, A), 'no_show@' + y, 'запись B утащила старую карточку A');
      assert.equal(st(t, B), 'scheduled@' + D);
      if (how === 'calendar') assert.equal((linkOf(t, vB) || {}).request_id, B);
      else assert.deepEqual(t.db.prepare('SELECT DISTINCT request_id FROM crm_request_services WHERE visit_id = ?').all(vB).map((r) => r.request_id), [B]);
    } finally { t.close(); }
  });
}

// F1 — номер карточки проверяется: чужой пациент или закрытая карточка — номер не действует
// (запись не отказывается: связь идёт прежним правилом).
test('F1: номер карточки другого пациента или закрытой карточки не действует — запись проходит, чужую карточку не двигает', async () => {
  const t = await startCrmApp((db) => db.prepare("INSERT INTO patients (id, full_name, phone) VALUES (78,'Другой Пациент','+998 91 111 22 33')").run());
  try {
    const foreign = addLead(t.db, { status: 'in_process', patient: 78, phone: '+998 91 111 22 33', name: 'Другой' });
    const b = await t.rpc('ensure_visit', 'cc', { patient_id: 77, date: at(D, 10), doctor_id: 10, crm_request_id: foreign,
      book: { doctor_id: 10, service_id: 30, start: at(D, 10), duration_minutes: 30 } });
    assert.equal(b.status, 200, b.text);
    assert.equal(t.lead(foreign).status, 'in_process', 'запись пациента 77 сдвинула карточку пациента 78');
    assert.notEqual((linkOf(t, b.json.data.visit.id) || {}).request_id, foreign);
    const bad = await t.rpc('ensure_visit', 'cc', { patient_id: 77, date: at(localDay(4), 10), doctor_id: 10, crm_request_id: 'x1',
      book: { doctor_id: 10, service_id: 30, start: at(localDay(4), 10), duration_minutes: 30 } });
    assert.equal(bad.status, 200, 'кривой номер карточки отказал в записи: ' + bad.text);
  } finally { t.close(); }
});

// F1 — запись из карточки B не трогает ДРУГУЮ живую карточку пациента с желанием на тот же день.
test('F1: запись из карточки B сажает и двигает только B; строка карточки C на тот же день не садится', async () => {
  const t = await startCrmApp();
  try {
    const C = addLead(t.db, { status: 'in_process', name: 'Пациент Тест' });
    t.db.prepare("INSERT INTO crm_request_services (request_id, service_id, scheduled_date, status) VALUES (?,40,?,'pending')").run(C, D);
    const B = await newCard(t, { day: D, lines: [{ service_id: 30, scheduled_date: D, doctor_id: 10 }] });
    const vB = await bookCard(t, B, D, 11);
    assert.equal(st(t, B), 'scheduled@' + D);
    assert.equal(t.lead(C).status, 'in_process', 'запись из карточки B сдвинула карточку C');
    assert.deepEqual(t.db.prepare('SELECT visit_id FROM crm_request_services WHERE request_id = ?').all(C), [{ visit_id: null }]);
    assert.ok(t.db.prepare('SELECT 1 FROM crm_request_services WHERE request_id = ? AND visit_id = ?').get(B, vB));
  } finally { t.close(); }
});

// Повторный ЗВОНОК в окне 72 ч — по-прежнему та же карточка (окно звонка не тронуто).
test('окно 72 ч для звонка осталось: повторный звонок — та же карточка', async () => {
  const { leadFromCall } = await import('../services/crm/lead-from-call.js');
  const t = await startCrmApp();
  try {
    const A = addLead(t.db, { status: 'in_process', name: 'Пациент Тест', updated: daysAgoIso(1) });
    const cid = Number(t.db.prepare("INSERT INTO calls (general_call_id, started_at, disposition, external_number, call_type) VALUES ('C1', strftime('%Y-%m-%dT%H:%M:%SZ','now'), 'ANSWER', '998909092638', 0)").run().lastInsertRowid);
    leadFromCall(t.db, { id: cid, disposition: 'ANSWER', external_number: '998909092638', call_type: 0 });
    assert.deepEqual(t.db.prepare('SELECT id FROM crm_requests').all().map((r) => r.id), [A], 'звонок в окне завёл вторую карточку');
  } finally { t.close(); }
});
