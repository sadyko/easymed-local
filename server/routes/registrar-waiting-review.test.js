// WAIT_REG_V1 (ревью) — «Ждут регистрации» и снятие строк записи на НАСТОЯЩЕМ приложении
// (стенд crm-unify-app.js: все миграции, /api/db с сетью R7b и шагом связи CRM, реестр RPC).
//
// Ревью нашло (пробы rev-waitreg PROBE-S1, S2) и владелец решил:
//   • H1 — анализ «на дату», снятый регистратором с причиной, возвращался в визит без счёта, а его
//     строка заявки закрывалась «done». Теперь сервер отпускает его ДО ensure_visit по номеру
//     строки заявки (crm_wish_release): без даты, отметка «отпущена», журнал — одной транзакцией;
//     визит дня его больше не берёт. Нечего отпускать — отказ словами, а не «успех»;
//   • M4 — пациент, оформленный утром, у которого позже появился анализ «на дату», — в списке;
//   • M2 + решение владельца — направление врача, не оформленное с причиной, снимает пациента со
//     списка; причина пишется сервером (referral_line_skip) с номером строки визита;
//   • решение владельца — пациент, оформленный БЕЗ счёта, тоже уходит из списка (отметка окна
//     визита registrar_registered); направление врача, пришедшее после отметки, — снова в списке;
//   • решение владельца — запись в календаре без услуги — в списке («услуга не выбрана»);
//   • M3 — снятие строки записи окном регистрации (registration: true) без причины — отказ;
//   • L6 — кто записал: колл-центр и по дополнительной роли;
//   • H2 — консультация по виду приёма в списке и в счёте — по номеру строки визита;
//   • PROBE-S2 — края суток и одна строка на пациента с записью и направлением врача;
//   • M6 — только число (count_only) совпадает с полным списком.
// День — МЕСТНЫЙ день клиники (localDay); время записи — в его пределах; «сегодня ещё есть
// свободное время» тест не предполагает.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startCrmApp, localDay, at, addLead, addLine } from '../test-helpers/crm-unify-app.js';
import { calendarBook, addVisitLine } from '../test-helpers/crm-link-all.js';

const TODAY = localDay(0);
const PATIENTS = [
  [80, 'Анализова Вера'], [81, 'Направленов Глеб'], [82, 'Безуслугова Дина'], [83, 'Консультова Ева'],
  [84, 'Безсчётова Жанна'], [85, 'Полночная Зоя'], [86, 'Ночной Илья'], [87, 'Вчерашняя Камила'],
  [88, 'Завтрашний Лев'], [89, 'Двойной Марк'], [90, 'Чистый Олег'], [91, 'Смешанный Пётр'],
];
const seed = (db) => {
  const p = db.prepare('INSERT INTO patients (id, full_name, phone) VALUES (?, ?, ?)');
  for (const [id, name] of PATIENTS) p.run(id, name, '+998 90 000 00 ' + String(id).padStart(2, '0'));
  db.prepare("INSERT INTO services (id, name, price, type, is_lab) VALUES (41, 'Анализ мочи', 30000, 'lab', 1)").run();
  // L6 — кассир с дополнительной ролью колл-центра.
  db.prepare(`INSERT INTO users (id, username, password_hash, full_name, role, is_doctor, extra_roles)
              VALUES (12, 'mix', 'x', 'Кассир-оператор', 'cashier', 0, '["callcenter"]')`).run();
};

const waiting = async (t, who = 'reg', args = {}) => {
  const r = await t.rpc('registrar_waiting', who, args);
  assert.equal(r.status, 200, r.text);
  return r.json.data;
};
const byPatient = (data) => new Map(data.rows.map((r) => [r.patient_id, r]));
const crmLine = (t, id) => t.db.prepare(`SELECT status, visit_id, visit_service_id, scheduled_date, released_from_visit_id
                                           FROM crm_request_services WHERE id = ?`).get(id);
const liveLines = (t, vid) => t.db.prepare("SELECT id, service_id, status, invoice_item_id FROM visit_services WHERE visit_id = ? AND status <> 'cancelled' ORDER BY id").all(vid);

/** Пациент оформлен утром: визит дня у стойки, своя строка, счёт. */
async function registeredThisMorning(t, pid) {
  const ev = await t.rpc('ensure_visit', 'reg', { patient_id: pid, date: new Date().toISOString(), visit_type: 'outpatient', desk: true });
  assert.equal(ev.status, 200, ev.text);
  const vid = ev.json.data.visit.id;
  const own = await addVisitLine(t, 'reg', vid, { svc: 30, doctor: 10 });
  const inv = await t.rpc('create_invoice_for_visit', 'reg', { visit_id: vid, visit_service_ids: [own], discount_amount: 0, payer_id: null });
  assert.equal(inv.status, 200, inv.text);
  return { vid, own };
}

/** Направление врача: врач заводит визит дня пациента и строку анализа (исполнитель — лаборатория). */
async function doctorSends(t, pid, { arrived = false, svc = 40 } = {}) {
  const ev = await t.rpc('ensure_visit', 'doc', { patient_id: pid, date: TODAY, doctor_id: 10, visit_type: 'outpatient' });
  assert.equal(ev.status, 200, ev.text);
  const vid = ev.json.data.visit.id;
  if (arrived) t.db.prepare("UPDATE visits SET status = 'arrived' WHERE id = ?").run(vid);
  const id = await addVisitLine(t, 'doc', vid, { svc, doctor: null });
  return { vid, id };
}

test('WAIT_REG_V1 (ревью H1, M4): анализ «на дату» у оформленного утром — в списке; crm_wish_release до ensure_visit — в заявку без даты, журнал; визит дня его больше не берёт', async () => {
  const t = await startCrmApp(seed);
  try {
    const { vid, own } = await registeredThisMorning(t, 80);
    const rid = addLead(t.db, { patient: 80, phone: '+998 90 000 00 80', name: 'Анализова Вера' });
    const lid = addLine(t.db, rid, { svc: 40, day: TODAY });
    // M4 — пациент уже оформлен, но анализ «на дату» ещё не сел в визит: стойка его ждёт.
    const before = byPatient(await waiting(t));
    assert.ok(before.has(80), 'анализ «на дату», появившийся после утренней регистрации, не в списке');
    assert.deepEqual(before.get(80).lines.map((l) => [l.kind, l.crm_line_id]), [['wish', lid]]);
    assert.deepEqual(before.get(80).services, ['Анализ крови']);

    // Отказы: короткая причина, чужой пациент, не та роль — строка на месте.
    const short = await t.rpc('crm_wish_release', 'reg', { crm_line_id: lid, patient_id: 80, reason: ' а ' });
    assert.equal(short.status, 400, short.text);
    const other = await t.rpc('crm_wish_release', 'reg', { crm_line_id: lid, patient_id: 81, reason: 'Пациент отказался' });
    assert.equal(other.status, 400, other.text);
    for (const who of ['cc', 'doc', 'kassa']) {
      const r = await t.rpc('crm_wish_release', who, { crm_line_id: lid, patient_id: 80, reason: 'Пациент отказался' });
      assert.equal(r.status, 403, who + ': ' + r.text);
    }
    assert.equal(crmLine(t, lid).scheduled_date, TODAY, 'отказ тронул строку заявки');

    const rel = await t.rpc('crm_wish_release', 'reg', { crm_line_id: lid, patient_id: 80, reason: 'Анализ сдан в другой лаборатории' });
    assert.equal(rel.status, 200, rel.text);
    const line = crmLine(t, lid);
    assert.equal(line.status, 'pending');
    assert.equal(line.scheduled_date, null, 'у отпущенной строки осталась дата');
    assert.equal(line.visit_id, null);
    assert.equal(line.visit_service_id, null);
    assert.notEqual(line.released_from_visit_id, null, 'строка не отмечена отпущенной — визит возьмёт её снова');
    const log = t.db.prepare("SELECT visit_id, reason, notes, actor_user_id FROM invoice_audit_log WHERE action = 'line_wish_released'").all();
    assert.equal(log.length, 1, 'журнал не записан');
    assert.equal(log[0].visit_id, vid, 'журнал не в визите дня пациента');
    assert.equal(log[0].reason, 'Анализ сдан в другой лаборатории');
    assert.match(log[0].notes, /Анализ крови/);
    assert.equal(log[0].actor_user_id, 2);

    // Второй раз отпускать нечего — отказ словами, а не «успех».
    const again = await t.rpc('crm_wish_release', 'reg', { crm_line_id: lid, patient_id: 80, reason: 'Анализ сдан в другой лаборатории' });
    assert.equal(again.status, 409, again.text);

    // Окно визита: ensure_visit (и «пришёл сейчас») — анализ в визит не возвращается.
    for (const desk of [false, true]) {
      const ev = await t.rpc('ensure_visit', 'reg', { patient_id: 80, date: new Date().toISOString(), visit_type: 'outpatient', desk });
      assert.equal(ev.status, 200, ev.text);
      assert.equal(ev.json.data.visit.id, vid);
    }
    assert.deepEqual(liveLines(t, vid).map((r) => r.id), [own], 'отпущенный анализ вернулся в визит');
    assert.equal(crmLine(t, lid).status, 'pending', 'строка заявки закрыта приходом, хотя анализ не оформлен');
    assert.equal(byPatient(await waiting(t)).has(80), false, 'пациент остался в списке');
  } finally { t.close(); }
});

test('WAIT_REG_V1 (ревью H1): анализ «на дату» без визита — отпускается до визита (журнал без визита), визит дня, заведённый после, его не берёт', async () => {
  const t = await startCrmApp(seed);
  try {
    const rid = addLead(t.db, { patient: 90, phone: '+998 90 000 00 90', name: 'Чистый Олег' });
    const lid = addLine(t.db, rid, { svc: 40, day: TODAY });
    const lid2 = addLine(t.db, rid, { svc: 41, day: TODAY });
    assert.deepEqual(byPatient(await waiting(t)).get(90).lines.map((l) => l.crm_line_id), [lid, lid2]);
    const rel = await t.rpc('crm_wish_release', 'reg', { crm_line_id: lid, patient_id: 90, reason: 'Пациент отказался от анализа' });
    assert.equal(rel.status, 200, rel.text);
    assert.equal(t.db.prepare("SELECT visit_id FROM invoice_audit_log WHERE action = 'line_wish_released'").get().visit_id, null);
    const ev = await t.rpc('ensure_visit', 'reg', { patient_id: 90, date: new Date().toISOString(), visit_type: 'outpatient', desk: true });
    assert.equal(ev.status, 200, ev.text);
    const vid = ev.json.data.visit.id;
    assert.deepEqual(liveLines(t, vid).map((r) => r.service_id), [41], 'отпущенный анализ сел в визит, или второй не сел');
    assert.equal(crmLine(t, lid).scheduled_date, null);
  } finally { t.close(); }
});

test('WAIT_REG_V1 (ревью M2, L4): направление врача, не оформленное с причиной, — журнал с номером строки визита на сервере; пациент уходит из списка', async () => {
  const t = await startCrmApp(seed);
  try {
    const { vid, id } = await doctorSends(t, 81, { arrived: true });
    assert.ok(byPatient(await waiting(t)).has(81));
    const short = await t.rpc('referral_line_skip', 'reg', { visit_service_id: id, reason: 'x' });
    assert.equal(short.status, 400, short.text);
    for (const who of ['cc', 'doc', 'kassa']) {
      const r = await t.rpc('referral_line_skip', who, { visit_service_id: id, reason: 'Пациент сдаст анализ завтра' });
      assert.equal(r.status, 403, who + ': ' + r.text);
    }
    // Строка записи — не направление врача: этой дверью её не «пропускают».
    // (визит дня врача без времени стоит на 09:00Z — запись ставится на другой час)
    const v89 = await calendarBook(t, 'reg', TODAY, { hour: 17, svc: 30, doctor: 10, pid: 89 });
    const [booked] = liveLines(t, v89).map((r) => r.id);
    const notOrder = await t.rpc('referral_line_skip', 'reg', { visit_service_id: booked, reason: 'Пациент сдаст анализ завтра' });
    assert.equal(notOrder.status, 400, notOrder.text);

    const ok = await t.rpc('referral_line_skip', 'reg', { visit_service_id: id, reason: 'Пациент сдаст анализ завтра' });
    assert.equal(ok.status, 200, ok.text);
    const log = t.db.prepare("SELECT visit_id, visit_service_id, reason, notes, actor_user_id FROM invoice_audit_log WHERE action = 'line_referral_skipped'").all();
    assert.equal(log.length, 1);
    assert.equal(log[0].visit_id, vid);
    assert.equal(log[0].visit_service_id, id, 'пропуск не привязан к строке визита');
    assert.equal(log[0].reason, 'Пациент сдаст анализ завтра');
    assert.match(log[0].notes, /Анализ крови/);
    assert.match(log[0].notes, /Иванов/);
    assert.ok(t.db.prepare("SELECT 1 FROM visit_services WHERE id = ? AND status = 'added' AND invoice_item_id IS NULL").get(id), 'направление снято с визита');
    assert.equal(byPatient(await waiting(t)).has(81), false, 'не оформленное с причиной направление держит пациента в списке');
    // Врач направил ещё — снова в списке, только новая строка.
    const id2 = await addVisitLine(t, 'doc', vid, { svc: 41, doctor: null });
    const again = byPatient(await waiting(t)).get(81);
    assert.ok(again, 'новое направление врача не в списке');
    assert.deepEqual(again.lines.map((l) => [l.kind, l.visit_service_id]), [['doctor', id2]]);
  } finally { t.close(); }
});

test('WAIT_REG_V1 (ревью, решение владельца): оформлен без счёта — уходит из списка (registrar_registered); направление врача после отметки — снова в списке', async () => {
  const t = await startCrmApp(seed);
  try {
    const v84 = await calendarBook(t, 'reg', TODAY, { hour: 13, svc: 30, doctor: 10, pid: 84 });
    assert.ok(byPatient(await waiting(t)).has(84));
    for (const who of ['cc', 'doc', 'kassa']) {
      const r = await t.rpc('registrar_registered', who, { visit_id: v84 });
      assert.equal(r.status, 403, who + ': ' + r.text);
    }
    const tomorrow = await calendarBook(t, 'reg', localDay(1), { hour: 10, svc: 30, doctor: 10, pid: 88 });
    const notToday = await t.rpc('registrar_registered', 'reg', { visit_id: tomorrow });
    assert.equal(notToday.status, 400, notToday.text);
    const bad = await t.rpc('registrar_registered', 'reg', { visit_id: 'x' });
    assert.equal(bad.status, 400, bad.text);

    const ok = await t.rpc('registrar_registered', 'reg', { visit_id: v84 });
    assert.equal(ok.status, 200, ok.text);
    const marks = t.db.prepare("SELECT visit_id, actor_user_id FROM invoice_audit_log WHERE action = 'visit_registered'").all();
    assert.deepEqual(marks, [{ visit_id: v84, actor_user_id: 2 }]);
    // Повтор отметки — не вторая строка журнала.
    assert.equal((await t.rpc('registrar_registered', 'reg', { visit_id: v84 })).status, 200);
    assert.equal(t.db.prepare("SELECT COUNT(*) n FROM invoice_audit_log WHERE action = 'visit_registered'").get().n, 1);
    assert.equal(byPatient(await waiting(t)).has(84), false, 'оформленный без счёта остался в списке');
    // Строки без счёта ждут кассу — регистрация их не трогала.
    assert.deepEqual(liveLines(t, v84).map((r) => [r.status, r.invoice_item_id]), [['added', null]]);
    // Отметка была раньше — направление врача, пришедшее после неё, снова держит пациента.
    t.db.prepare("UPDATE invoice_audit_log SET created_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-2 minutes') WHERE action = 'visit_registered'").run();
    const sent = await addVisitLine(t, 'doc', v84, { svc: 40, doctor: null });
    const row = byPatient(await waiting(t)).get(84);
    assert.ok(row, 'направление врача после регистрации не в списке');
    assert.deepEqual(row.lines.map((l) => [l.kind, l.visit_service_id]), [['doctor', sent]]);
  } finally { t.close(); }
});

test('WAIT_REG_V1 (ревью, решение владельца): запись в календаре без услуги — в списке («услуга не выбрана»); визит дня без записи — нет', async () => {
  const t = await startCrmApp(seed);
  try {
    const b = await t.rpc('calendar_book', 'reg', { patient_id: 82, doctor_id: 10, start: at(TODAY, 15), duration_minutes: 30, status: 'scheduled' });
    assert.equal(b.status, 200, b.text);
    const v82 = b.json.data.visit.id;
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM visit_services WHERE visit_id = ?').get(v82).n, 0, 'подготовка: у записи есть строка');
    // Визит дня без записи (ensure_visit без book) и без строк — это не запись.
    const ev = await t.rpc('ensure_visit', 'reg', { patient_id: 90, date: TODAY, visit_type: 'outpatient' });
    assert.equal(ev.status, 200, ev.text);
    const m = byPatient(await waiting(t));
    assert.equal(m.has(90), false, 'пустой визит дня без записи в списке');
    const row = m.get(82);
    assert.ok(row, 'запись без услуги не в списке');
    assert.equal(row.no_service, true);
    assert.deepEqual(row.services, []);
    assert.deepEqual(row.doctors, ['Иванов']);
    assert.equal(row.time, '15:00');
    assert.equal(row.visit_id, v82);
    assert.deepEqual(row.lines.map((l) => [l.kind, l.visit_id, l.doctor_id]), [['booking', v82, 10]]);
    assert.deepEqual(row.sources.map((s) => s.kind), ['calendar']);
    // Регистратор выбрал услугу и выставил счёт — пациента в списке нет.
    const line = await addVisitLine(t, 'reg', v82, { svc: 30, doctor: 10 });
    const inv = await t.rpc('create_invoice_for_visit', 'reg', { visit_id: v82, visit_service_ids: [line], discount_amount: 0, payer_id: null });
    assert.equal(inv.status, 200, inv.text);
    assert.equal(byPatient(await waiting(t)).has(82), false);
  } finally { t.close(); }
});

test('WAIT_REG_V1 (ревью M3): окно регистрации снимает строку записи только с причиной (registration: true); календарь — как прежде', async () => {
  const t = await startCrmApp(seed);
  try {
    const v = await calendarBook(t, 'reg', TODAY, { hour: 13, svc: 30, doctor: 10, pid: 89 });
    const [line] = liveLines(t, v).map((r) => r.id);
    const bare = await t.rpc('booking_line_remove', 'reg', { visit_service_id: line, registration: true });
    assert.equal(bare.status, 400, bare.text);
    assert.ok(t.db.prepare('SELECT 1 FROM visit_services WHERE id = ?').get(line), 'строку записи сняли без причины');
    const ok = await t.rpc('booking_line_remove', 'reg', { visit_service_id: line, registration: true, reason: 'Пациент отказался' });
    assert.equal(ok.status, 200, ok.text);
    const log = t.db.prepare("SELECT visit_id, visit_service_id, reason, notes FROM invoice_audit_log WHERE action = 'line_booked_removed'").get();
    assert.equal(log.visit_id, v);
    assert.equal(log.visit_service_id, line, 'журнал снятия не привязан к строке визита');
    assert.doesNotMatch(log.notes, /при регистрации/, 'журнал говорит о регистрации, которой могло не быть');
    // Календарь (без флага) снимает строку как прежде.
    const v2 = await calendarBook(t, 'reg', localDay(1), { hour: 11, svc: 30, doctor: 10, pid: 88 });
    const [l2] = liveLines(t, v2).map((r) => r.id);
    assert.equal((await t.rpc('booking_line_remove', 'reg', { visit_service_id: l2 })).status, 200);
  } finally { t.close(); }
});

test('WAIT_REG_V1 (ревью L6, H2): запись кассира с ролью колл-центра — «Колл-центр / CRM»; консультация по виду приёма — в списке и в счёте по номеру строки', async () => {
  const t = await startCrmApp((db) => {
    seed(db);
    db.prepare("INSERT INTO consultation_types (id, name, price, active) VALUES (5, 'Первичный приём', 120000, 1)").run();
    db.prepare('INSERT INTO doctor_consultation_prices (doctor_id, consultation_type_id, price, available) VALUES (10, 5, 150000, 1)').run();
  });
  try {
    // L6 — визит и строка заведены кассиром с дополнительной ролью колл-центра.
    const vMix = Number(t.db.prepare("INSERT INTO visits (patient_id, doctor_id, visit_date, status, created_by, booked_at) VALUES (91, 10, ?, 'scheduled', 12, ?)")
      .run(at(TODAY, 16), at(TODAY, 8)).lastInsertRowid);
    t.db.prepare("INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status, created_by, scheduled_at) VALUES (?, 30, 10, 1, 100000, 100000, 'added', 12, ?)")
      .run(vMix, at(TODAY, 16));
    // H2 — запись колл-центра на вид приёма (строка service_id NULL + consultation_type_id).
    const b = await t.rpc('calendar_book', 'cc', { patient_id: 83, doctor_id: 10, consultation_type_id: 5, start: at(TODAY, 12), duration_minutes: 30, status: 'scheduled' });
    assert.equal(b.status, 200, b.text);
    const vid = b.json.data.visit.id;
    const add = await t.rpc('booking_lines_add', 'cc', { visit_id: vid, patient_id: 83, lines: [{ consultation_type_id: 5, doctor_id: 10, scheduled_at: at(TODAY, 12) }] });
    assert.equal(add.status, 200, add.text);
    const [ct] = liveLines(t, vid).map((r) => r.id);
    const m = byPatient(await waiting(t));
    assert.deepEqual(m.get(91).sources.map((s) => s.kind), ['crm'], 'запись по дополнительной роли колл-центра — не «Колл-центр / CRM»');
    const row = m.get(83);
    assert.deepEqual(row.services, ['Первичный приём']);
    assert.deepEqual(row.lines.map((l) => [l.kind, l.visit_service_id, l.service_id, l.consultation_type_id, l.doctor_id]), [['booked', ct, null, 5, 10]]);
    // Счёт — по номеру строки визита: та же строка, без второй консультации.
    const inv = await t.rpc('create_invoice_for_visit', 'reg', { visit_id: vid, visit_service_ids: [ct], discount_amount: 0, payer_id: null });
    assert.equal(inv.status, 200, inv.text);
    assert.equal(liveLines(t, vid).length, 1, 'вторая строка консультации');
    assert.notEqual(liveLines(t, vid)[0].invoice_item_id, null, 'строка консультации не в счёте');
    assert.equal(byPatient(await waiting(t)).has(83), false);
  } finally { t.close(); }
});

test('WAIT_REG_V1 (ревью PROBE-S2): края суток; запись и направление врача у одного пациента — одна строка; count_only = длина списка', async () => {
  const t = await startCrmApp(seed);
  try {
    const mk = (pid, iso) => {
      const v = Number(t.db.prepare("INSERT INTO visits (patient_id, doctor_id, visit_date, status, created_by, booked_at) VALUES (?, 10, ?, 'scheduled', 2, ?)").run(pid, iso, iso).lastInsertRowid);
      t.db.prepare("INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status, created_by, scheduled_at) VALUES (?, 30, 10, 1, 100000, 100000, 'added', 2, ?)").run(v, iso);
      return v;
    };
    mk(85, at(TODAY, 0, 5));
    mk(86, at(TODAY, 23, 55));
    mk(87, at(localDay(-1), 23, 55));
    mk(88, at(localDay(1), 0, 5));
    const v89 = await calendarBook(t, 'reg', TODAY, { hour: 15, svc: 30, doctor: 10, pid: 89 });
    const sent = await addVisitLine(t, 'doc', v89, { svc: 40, doctor: null });
    const data = await waiting(t);
    const m = byPatient(data);
    assert.deepEqual([...m.keys()].sort(), [85, 86, 89], 'края суток: ' + JSON.stringify(data.rows.map((r) => [r.patient_id, r.time])));
    assert.equal(m.get(85).time, '00:05');
    assert.equal(m.get(86).time, '23:55');
    const r89 = m.get(89);
    assert.deepEqual(r89.sources.map((s) => s.kind).sort(), ['calendar', 'doctor']);
    assert.deepEqual(r89.lines.map((l) => l.kind).sort(), ['booked', 'doctor']);
    assert.ok(r89.lines.some((l) => l.kind === 'doctor' && l.visit_service_id === sent));
    assert.equal(r89.time, '15:00');
    const n = await waiting(t, 'reg', { count_only: true });
    assert.equal(n.count, data.count);
    assert.equal(n.rows, undefined, 'count_only отдал строки');
  } finally { t.close(); }
});
