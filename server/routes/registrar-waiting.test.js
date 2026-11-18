// WAIT_REG_V1 (3.25.0, 2026-11-17) — «ЖДУТ РЕГИСТРАЦИИ» НА НАСТОЯЩЕМ ПРИЛОЖЕНИИ (стенд crm-unify-app.js:
// все миграции, /api/db с сетью R7b и шагом связи CRM, реестр RPC, вход под ролями).
//
// Проверяется:
//   • в списке — запись колл-центра, запись календаря, запись сайта / партнёра, анализ «на дату»
//     без визита и направление врача; не в списке — отменённая, «Не пришёл», «Пришёл», уже
//     зарегистрированная запись, вчера и завтра;
//   • список — стойке (администратор, регистратура); кассе, колл-центру и врачу — 403;
//   • «Оформить по записи» (двери окна визита: ensure_visit у стойки → строки → счёт) — один визит,
//     ровно записанные строки, один счёт, без второй строки; пациент уходит из списка;
//   • снять строку записи с причиной — журнал визита (invoice_audit_log), без причины — как прежде;
//     анализ «на дату», убранный регистратором, возвращается в заявку без даты;
//   • повтор записанной или направленной услуги — прежний запрет DUP_STOP_V1;
//   • счёт — только при оформлении: запись счёта не заводит.
// День — МЕСТНЫЙ день клиники (localDay), время записи — в его пределах; «сегодня ещё есть
// свободное время» тест не предполагает: запись на сегодня ставится в любой час дня.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startCrmApp, localDay, at, addLead, addLine } from '../test-helpers/crm-unify-app.js';
import { calendarBook, callcenterBook, addVisitLine } from '../test-helpers/crm-link-all.js';

const TODAY = localDay(0);
const PATIENTS = [
  [78, 'Календарёва Анна'], [79, 'Партнёров Борис'], [80, 'Анализова Вера'], [81, 'Направленов Глеб'],
  [82, 'Отменённая Дина'], [83, 'Непришедший Егор'], [84, 'Пришедшая Жанна'], [85, 'Оформленный Зафар'],
  [86, 'Завтрашний Илья'], [87, 'Вчерашняя Камила'], [88, 'Завтра-анализ Лола'],
];
const seed = (db) => {
  const p = db.prepare('INSERT INTO patients (id, full_name, phone) VALUES (?, ?, ?)');
  for (const [id, name] of PATIENTS) p.run(id, name, '+998 90 000 00 ' + String(id).padStart(2, '0'));
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (11, 'doc2', 'x', 'Петрова', 'doctor', 1)").run();
};

const waiting = async (t, who = 'reg', args = {}) => {
  const r = await t.rpc('registrar_waiting', who, args);
  assert.equal(r.status, 200, r.text);
  return r.json.data;
};
const byPatient = (data) => new Map(data.rows.map((r) => [r.patient_id, r]));
const kinds = (row) => row.sources.map((s) => s.kind).sort();

/** Запись сайта / партнёра: визит записан, строка записи, заявка онлайн-записи указывает на визит. */
async function partnerBook(t, pid, hour) {
  const vid = await calendarBook(t, 'reg', TODAY, { hour, svc: 30, doctor: 11, pid });
  t.db.prepare(`INSERT INTO api_connections (id, kind, name, crm_source_key, key_hash, key_sealed, secret_sealed)
                VALUES (5, 'partner', 'med24.uz', 'med24', ?, 'x', 'x')`).run('a'.repeat(64));
  t.db.prepare(`INSERT INTO api_requests (public_id, connection_id, kind, status, doctor_id, start_at, duration_minutes, received_at, patient_id, visit_id)
                VALUES ('rq_test0001', 5, 'appointment', 'confirmed', 11, ?, 30, ?, ?, ?)`).run(at(TODAY, hour), new Date().toISOString(), pid, vid);
  return vid;
}

/** Направление врача: врач заводит визит дня пациента и строку анализа (исполнитель — лаборатория). */
async function doctorSends(t, pid, { arrived = false } = {}) {
  const ev = await t.rpc('ensure_visit', 'doc', { patient_id: pid, date: TODAY, doctor_id: 10, visit_type: 'outpatient' });
  assert.equal(ev.status, 200, ev.text);
  const vid = ev.json.data.visit.id;
  if (arrived) t.db.prepare("UPDATE visits SET status = 'arrived' WHERE id = ?").run(vid);
  const id = await addVisitLine(t, 'doc', vid, { svc: 40, doctor: null });
  return { vid, id };
}

async function seedAll(t) {
  const v77 = await callcenterBook(t, TODAY, { hour: 12, svc: 30, doctor: 10, pid: 77 });            // колл-центр
  const v78 = await calendarBook(t, 'reg', TODAY, { hour: 13, svc: 30, doctor: 10, pid: 78 });       // календарь
  const v79 = await partnerBook(t, 79, 14);                                                           // сайт / партнёр
  const rid = addLead(t.db, { patient: 80, phone: '+998 90 000 00 80', name: 'Анализова Вера' });      // анализ «на дату»
  addLine(t.db, rid, { svc: 40, day: TODAY });
  const d81 = await doctorSends(t, 81, { arrived: true });                                            // направил врач (с приёма)
  return { v77, v78, v79, rid, d81 };
}

test('WAIT_REG_V1: в списке — колл-центр, календарь, сайт / партнёр, анализ «на дату» и направление врача; счёт при записи не заводится', async () => {
  const t = await startCrmApp(seed);
  try {
    const { v77, v78, v79, d81 } = await seedAll(t);
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM invoices').get().n, 0, 'запись завела счёт — счёт выставляется только по приходу');
    const data = await waiting(t);
    assert.equal(data.today, TODAY, 'день списка — не местный день клиники');
    const m = byPatient(data);
    assert.deepEqual([...m.keys()].sort(), [77, 78, 79, 80, 81]);
    assert.equal(data.count, 5);
    assert.deepEqual(kinds(m.get(77)), ['crm']);
    assert.deepEqual(kinds(m.get(78)), ['calendar']);
    assert.deepEqual(m.get(79).sources, [{ kind: 'partner', name: 'med24.uz' }]);
    assert.deepEqual(kinds(m.get(80)), ['crm']);
    assert.deepEqual(m.get(81).sources, [{ kind: 'doctor', name: 'Иванов' }]);
    assert.equal(m.get(77).time, '12:00');
    assert.equal(m.get(78).time, '13:00');
    assert.equal(m.get(80).time, null, 'у анализа «на дату» нет времени');
    assert.deepEqual(m.get(77).services, ['Консультация терапевта']);
    assert.deepEqual(m.get(80).services, ['Анализ крови']);
    assert.deepEqual(m.get(81).services, ['Анализ крови']);
    assert.deepEqual(m.get(77).doctors, ['Иванов']);
    assert.deepEqual(m.get(77).booked_by, ['Оператор А']);
    assert.deepEqual(m.get(78).booked_by, ['Регистратура']);
    assert.equal(m.get(77).visit_id, v77);
    assert.equal(m.get(78).visit_id, v78);
    assert.equal(m.get(79).visit_id, v79);
    assert.equal(m.get(80).visit_id, null, 'у анализа «на дату» визита нет');
    assert.equal(m.get(81).visit_id, d81.vid);
    assert.deepEqual(m.get(80).lines.map((l) => l.kind), ['wish']);
    assert.deepEqual(m.get(81).lines.map((l) => [l.kind, l.visit_service_id]), [['doctor', d81.id]]);
    // По времени: сначала со временем, потом «за день».
    assert.deepEqual(data.rows.slice(0, 3).map((r) => r.patient_id), [77, 78, 79]);
    // Один пациент — patient_id.
    const one = await waiting(t, 'reg', { patient_id: 80 });
    assert.deepEqual(one.rows.map((r) => r.patient_id), [80]);
    const none = await waiting(t, 'reg', { patient_id: 82 });
    assert.equal(none.count, 0);
  } finally { t.close(); }
});

test('WAIT_REG_V1: не в списке — отменённая запись, «Не пришёл», «Пришёл», уже оформленная, вчера и завтра', async () => {
  const t = await startCrmApp(seed);
  try {
    const v82 = await calendarBook(t, 'reg', TODAY, { hour: 15, svc: 30, doctor: 10, pid: 82 });
    const c = await t.rpc('calendar_book', 'reg', { visit_id: v82, start: t.db.prepare('SELECT visit_date FROM visits WHERE id = ?').get(v82).visit_date, status: 'cancelled' });
    assert.equal(c.status, 200, c.text);
    const v83 = await calendarBook(t, 'reg', TODAY, { hour: 16, svc: 30, doctor: 10, pid: 83 });
    t.db.prepare("UPDATE visits SET status = 'no_show' WHERE id = ?").run(v83);
    const v84 = await calendarBook(t, 'reg', TODAY, { hour: 17, svc: 30, doctor: 10, pid: 84 });
    t.db.prepare("UPDATE visits SET status = 'arrived' WHERE id = ?").run(v84);
    const v85 = await calendarBook(t, 'reg', TODAY, { hour: 18, svc: 30, doctor: 10, pid: 85 });
    const ids85 = t.db.prepare("SELECT id FROM visit_services WHERE visit_id = ? AND status = 'added'").all(v85).map((r) => r.id);
    const inv = await t.rpc('create_invoice_for_visit', 'reg', { visit_id: v85, visit_service_ids: ids85, discount_amount: 0, payer_id: null });
    assert.equal(inv.status, 200, inv.text);
    await calendarBook(t, 'reg', localDay(1), { hour: 10, svc: 30, doctor: 10, pid: 86 });
    const y = Number(t.db.prepare("INSERT INTO visits (patient_id, doctor_id, visit_date, status, created_by, booked_at) VALUES (87, 10, ?, 'scheduled', 2, ?)").run(at(localDay(-1), 10), at(localDay(-1), 8)).lastInsertRowid);
    t.db.prepare("INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status, created_by) VALUES (?, 30, 10, 1, 100000, 100000, 'added', 2)").run(y);
    const rid = addLead(t.db, { patient: 88, phone: '+998 90 000 00 88', name: 'Завтра-анализ Лола' });
    addLine(t.db, rid, { svc: 40, day: localDay(1) });
    const data = await waiting(t);
    assert.deepEqual(data.rows.map((r) => r.patient_id), [], 'в списке те, кого сегодня не ждут: ' + JSON.stringify(data.rows.map((r) => [r.patient_id, r.patient_name])));
  } finally { t.close(); }
});

test('WAIT_REG_V1: список — стойке; кассе, колл-центру и врачу — 403', async () => {
  const t = await startCrmApp(seed);
  try {
    await seedAll(t);
    assert.equal((await waiting(t, 'boss')).count, 5, 'администратор не видит список');
    for (const who of ['kassa', 'cc', 'doc']) {
      const r = await t.rpc('registrar_waiting', who, {});
      assert.equal(r.status, 403, who + ': ' + r.text);
    }
    const bad = await t.rpc('registrar_waiting', 'reg', { patient_id: 'x' });
    assert.equal(bad.status, 400, bad.text);
  } finally { t.close(); }
});

test('WAIT_REG_V1: «Оформить по записи» (колл-центр) — тот же визит, ровно строка записи, один счёт; пациент уходит из списка', async () => {
  const t = await startCrmApp(seed);
  try {
    const { v77 } = await seedAll(t);
    const booked = t.db.prepare("SELECT id FROM visit_services WHERE visit_id = ? AND status = 'added'").all(v77).map((r) => r.id);
    assert.equal(booked.length, 1);
    // Двери окна визита у стойки: визит дня «сейчас» (desk), счёт на строки «из записи».
    const ev = await t.rpc('ensure_visit', 'reg', { patient_id: 77, date: new Date().toISOString(), doctor_id: 10, visit_type: 'outpatient', desk: true });
    assert.equal(ev.status, 200, ev.text);
    assert.equal(ev.json.data.visit.id, v77, 'оформление завело второй визит');
    assert.equal(ev.json.data.created, false);
    const inv = await t.rpc('create_invoice_for_visit', 'reg', { visit_id: v77, visit_service_ids: booked, discount_amount: 0, payer_id: null });
    assert.equal(inv.status, 200, inv.text);
    const visits = t.db.prepare("SELECT COUNT(*) n FROM visits WHERE patient_id = 77 AND status NOT IN ('cancelled', 'no_show')").get().n;
    assert.equal(visits, 1, 'у пациента два живых визита');
    assert.deepEqual(t.db.prepare("SELECT id FROM visit_services WHERE visit_id = ? AND status <> 'cancelled' ORDER BY id").all(v77).map((r) => r.id), booked, 'строк визита не столько, сколько записано');
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM invoices WHERE visit_id = ?').get(v77).n, 1);
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id WHERE i.visit_id = ?').get(v77).n, 1);
    const after = byPatient(await waiting(t));
    assert.equal(after.has(77), false, 'оформленный пациент остался в списке');
    assert.deepEqual([...after.keys()].sort(), [78, 79, 80, 81]);
  } finally { t.close(); }
});

test('WAIT_REG_V1: «Оформить по записи» — анализ «на дату»: визит дня заводит стойка, строка одна, счёт один; направление врача — счёт на строку врача, ждёт кассу до оплаты', async () => {
  const t = await startCrmApp(seed);
  try {
    const { rid, d81 } = await seedAll(t);
    const ev = await t.rpc('ensure_visit', 'reg', { patient_id: 80, date: new Date().toISOString(), visit_type: 'outpatient', desk: true });
    assert.equal(ev.status, 200, ev.text);
    const vid = ev.json.data.visit.id;
    // Окно визита ставит анализ строкой «из заявки» — строка CRM, севшая в визит, ей уступает (O1).
    const own = await addVisitLine(t, 'reg', vid, { svc: 40, doctor: null });
    const live = t.db.prepare("SELECT id, service_id FROM visit_services WHERE visit_id = ? AND status <> 'cancelled'").all(vid);
    assert.deepEqual(live.map((r) => r.id), [own], 'в визите две строки анализа');
    const inv = await t.rpc('create_invoice_for_visit', 'reg', { visit_id: vid, visit_service_ids: [own], discount_amount: 0, payer_id: null });
    assert.equal(inv.status, 200, inv.text);
    assert.equal(t.db.prepare("SELECT COUNT(*) n FROM visits WHERE patient_id = 80 AND status NOT IN ('cancelled', 'no_show')").get().n, 1);
    assert.equal(t.db.prepare('SELECT visit_service_id FROM crm_request_services WHERE request_id = ?').get(rid).visit_service_id, own, 'строка заявки не указывает на оформленную строку');
    // Направление врача: визит уже «Пришёл» — тот же визит, счёт на строку врача.
    const ev81 = await t.rpc('ensure_visit', 'reg', { patient_id: 81, date: new Date().toISOString(), visit_type: 'outpatient', desk: true });
    assert.equal(ev81.json.data.visit.id, d81.vid);
    const inv81 = await t.rpc('create_invoice_for_visit', 'reg', { visit_id: d81.vid, visit_service_ids: [d81.id], discount_amount: 0, payer_id: null });
    assert.equal(inv81.status, 200, inv81.text);
    const after = byPatient(await waiting(t));
    assert.equal(after.has(80), false, 'оформленный анализ «на дату» остался в списке');
    // CRM_BOOKINGS_TAB_V1 (направления до оплаты, решение владельца) — направление врача со счётом ждёт кассу:
    // в списке с пометкой «к кассе», пока счёт не оплачен; оплачен — уходит.
    assert.equal(after.get(81) && after.get(81).to_cashier, true, 'неоплаченное направление врача не ждёт кассу');
    const pay81 = await t.rpc('record_payment', 'kassa', { invoice_id: inv81.json.data.invoice.id, amount: inv81.json.data.invoice.total_amount, method: 'cash' });
    assert.equal(pay81.status, 200, pay81.text);
    assert.equal(byPatient(await waiting(t)).has(81), false, 'оплаченное направление врача осталось в списке');
  } finally { t.close(); }
});

test('WAIT_REG_V1: снять строку записи с причиной — журнал визита; короткая причина — отказ; без причины — как в календаре', async () => {
  const t = await startCrmApp(seed);
  try {
    const { v78 } = await seedAll(t);
    const [line] = t.db.prepare("SELECT id FROM visit_services WHERE visit_id = ? AND status = 'added'").all(v78).map((r) => r.id);
    const short = await t.rpc('booking_line_remove', 'reg', { visit_service_id: line, reason: ' а ' });
    assert.equal(short.status, 400, short.text);
    assert.ok(t.db.prepare('SELECT 1 FROM visit_services WHERE id = ?').get(line), 'строку сняли без причины');
    const ok = await t.rpc('booking_line_remove', 'reg', { visit_service_id: line, reason: 'Пациент отказался от консультации' });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(t.db.prepare('SELECT 1 FROM visit_services WHERE id = ?').get(line), undefined);
    const log = t.db.prepare("SELECT visit_id, reason, notes, actor_user_id, actor_name FROM invoice_audit_log WHERE action = 'line_booked_removed'").all();
    assert.equal(log.length, 1);
    assert.equal(log[0].visit_id, v78);
    assert.equal(log[0].reason, 'Пациент отказался от консультации');
    assert.match(log[0].notes, /Консультация терапевта/);
    assert.equal(log[0].actor_user_id, 2);
    // Календарь снимает услугу записи без причины — как прежде, журнала нет.
    const v86 = await calendarBook(t, 'reg', localDay(1), { hour: 11, svc: 30, doctor: 10, pid: 86 });
    const [l86] = t.db.prepare("SELECT id FROM visit_services WHERE visit_id = ?").all(v86).map((r) => r.id);
    const plain = await t.rpc('booking_line_remove', 'reg', { visit_service_id: l86 });
    assert.equal(plain.status, 200, plain.text);
    assert.equal(t.db.prepare("SELECT COUNT(*) n FROM invoice_audit_log WHERE action = 'line_booked_removed'").get().n, 1);
  } finally { t.close(); }
});

test('WAIT_REG_V1: анализ «на дату», убранный регистратором с причиной, — снят с визита, заявка без даты, журнал; пациента в списке нет', async () => {
  const t = await startCrmApp(seed);
  try {
    const { rid } = await seedAll(t);
    // Окно визита: визит дня без «пришёл сейчас» — строка заявки садится в визит строкой CRM …
    const ev = await t.rpc('ensure_visit', 'reg', { patient_id: 80, date: new Date().toISOString(), visit_type: 'outpatient' });
    assert.equal(ev.status, 200, ev.text);
    const vid = ev.json.data.visit.id;
    const auto = t.db.prepare("SELECT id FROM visit_services WHERE visit_id = ? AND service_id = 40 AND status = 'added'").get(vid);
    assert.ok(auto, 'строка заявки не села в визит дня');
    // … и снимается той же дверью, что у календаря, с причиной …
    const rm = await t.rpc('booking_line_remove', 'reg', { visit_service_id: auto.id, reason: 'Анализ сдан в другой лаборатории' });
    assert.equal(rm.status, 200, rm.text);
    // … затем «пришёл сейчас»: строка заявки в визит больше не садится.
    const ev2 = await t.rpc('ensure_visit', 'reg', { patient_id: 80, date: new Date().toISOString(), visit_type: 'outpatient', desk: true });
    assert.equal(ev2.status, 200, ev2.text);
    assert.equal(ev2.json.data.visit.id, vid);
    assert.equal(t.db.prepare("SELECT COUNT(*) n FROM visit_services WHERE visit_id = ? AND status <> 'cancelled'").get(vid).n, 0, 'анализ вернулся в визит');
    const line = t.db.prepare('SELECT status, visit_id, visit_service_id, scheduled_date, released_from_visit_id FROM crm_request_services WHERE request_id = ?').get(rid);
    assert.deepEqual(line, { status: 'pending', visit_id: null, visit_service_id: null, scheduled_date: null, released_from_visit_id: vid },
      'строка заявки не вернулась в CRM без даты');
    assert.equal(t.db.prepare("SELECT reason FROM invoice_audit_log WHERE action = 'line_booked_removed' AND visit_id = ?").get(vid).reason, 'Анализ сдан в другой лаборатории');
    assert.equal(byPatient(await waiting(t)).has(80), false);
  } finally { t.close(); }
});

test('WAIT_REG_V1: повтор направленной врачом услуги — прежний запрет DUP_STOP_V1 (проверка до записи и дверь /api/db)', async () => {
  const t = await startCrmApp(seed);
  try {
    const { d81 } = await seedAll(t);
    const chk = await t.rpc('visit_dup_check', 'reg', { patient_id: 81, date: TODAY, lines: [{ service_id: 40 }] });
    assert.equal(chk.status, 200, chk.text);
    assert.equal(chk.json.data.duplicates.length, 1, 'проверка до записи не назвала повтор');
    const ins = await t.dbq('reg', { table: 'visit_services', op: 'insert', values: { visit_id: d81.vid, service_id: 40, quantity: 1, unit_price: 40000, total: 40000, price_tier: 'primary', status: 'added' } });
    assert.equal(ins.status, 409, ins.text);
    assert.equal(ins.json.error.code, 'duplicate_order');
  } finally { t.close(); }
});
