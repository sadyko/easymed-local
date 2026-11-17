// CRM_BOOKINGS_TAB_V1 (3.25.0, 2026-11-17) — «ЗАПИСИ CRM»: ФИЛЬТРЫ СПИСКА registrar_waiting НА НАСТОЯЩЕМ
// ПРИЛОЖЕНИИ (стенд crm-unify-app.js: все миграции, /api/db с сетью R7b и шагом связи CRM, реестр RPC,
// вход под ролями).
//
// Решение владельца (с макета): регистратор видит записи, не выбирая врача, кабинет или услугу.
// Список — фильтрами: день (сегодня / завтра / 7 дней / дата), источник, статус, врач, поиск.
// Без фильтров ответ — прежний «Ждут регистрации» (сегодня, все источники, «Ждут»): его стерегут
// registrar-waiting*.test.js без изменений.
//
// Проверяется:
//   • источник — каждый по отдельности и вместе; строка с двумя источниками подходит по любому;
//   • день — завтра, 7 дней (сегодня … +6), прошлый день; больше 7 дней, «с» позже «по», день и
//     период вместе, неверная дата — 400;
//   • статус — «Оформлены» (счёт, отметка «оформлен», «Пришёл», выставленное направление врача; приход
//     с улицы — не запись), «Не пришли» («Не пришёл» сегодня, неоформленная запись прошлого дня),
//     «Отменены» (отменённая запись, отменённая строка заявки на дату, анализ, отпущенный стойкой с
//     причиной, направление врача, не оформленное с причиной), «Все»;
//   • врач — только записи к нему; список врачей — по is_doctor / роли «Врач»;
//   • поиск — имя, цифры телефона, номер карты;
//   • count_only — то же число, что строк у полного ответа с теми же фильтрами;
//   • неверные аргументы — 400, чужие роли — 403.
// День — МЕСТНЫЙ день клиники (localDay); «сегодня ещё есть свободное время» тест не предполагает:
// запись на сегодня ставится в любой час дня, прошлый день — прямой вставкой.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startCrmApp, localDay, at, addLead, addLine } from '../test-helpers/crm-unify-app.js';
import { calendarBook, callcenterBook, addVisitLine, deskRegister } from '../test-helpers/crm-link-all.js';

const TODAY = localDay(0);
const PATIENTS = [
  [78, 'Календарёва Анна'], [79, 'Партнёров Борис'], [80, 'Анализова Вера'], [81, 'Направленов Глеб'],
  [82, 'Отменённая Дина'], [83, 'Непришедший Егор'], [84, 'Пришедшая Жанна'], [85, 'Оформленный Зафар'],
  [86, 'Завтрашний Илья'], [87, 'Вчерашняя Камила'], [88, 'Недельная Лола'], [89, 'Двойной Марк'],
  [90, 'Уличный Олег'], [91, 'Восьмидневный Пётр'],
];
const seed = (db) => {
  const p = db.prepare('INSERT INTO patients (id, full_name, phone) VALUES (?, ?, ?)');
  for (const [id, name] of PATIENTS) p.run(id, name, '+998 90 000 00 ' + String(id).padStart(2, '0'));
  db.prepare("UPDATE patients SET mrn = 'EM-004321' WHERE id = 88").run();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (11, 'doc2', 'x', 'Петрова', 'doctor', 1)").run();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (12, 'adoc', 'x', 'Админ-врач', 'admin', 1)").run();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor, is_active) VALUES (13, 'gone', 'x', 'Уволенный', 'doctor', 1, 0)").run();
};

const list = async (t, args = {}, who = 'reg') => {
  const r = await t.rpc('registrar_waiting', who, args);
  assert.equal(r.status, 200, r.text);
  return r.json.data;
};
const ids = (data) => data.rows.map((r) => r.patient_id).sort((a, b) => a - b);
const rowOf = (data, pid, status = null) => data.rows.find((r) => r.patient_id === pid && (status == null || r.status === status));

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

/** Запись прямой вставкой (прошлый день — calendar_book прошлое время не пишет). */
function rawBooking(t, pid, iso, { status = 'scheduled', doctor = 10, by = 2 } = {}) {
  const v = Number(t.db.prepare('INSERT INTO visits (patient_id, doctor_id, visit_date, status, created_by, booked_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(pid, doctor, iso, status, by, iso).lastInsertRowid);
  t.db.prepare("INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status, created_by, scheduled_at) VALUES (?, 30, ?, 1, 100000, 100000, 'added', ?, ?)")
    .run(v, doctor, by, iso);
  return v;
}

async function seedToday(t) {
  const v77 = await callcenterBook(t, TODAY, { hour: 12, svc: 30, doctor: 10, pid: 77 });            // колл-центр
  const v78 = await calendarBook(t, 'reg', TODAY, { hour: 13, svc: 30, doctor: 10, pid: 78 });       // календарь
  const v79 = await partnerBook(t, 79, 14);                                                           // сайт / партнёр (врач 11)
  const rid = addLead(t.db, { patient: 80, phone: '+998 90 000 00 80', name: 'Анализова Вера' });      // анализ «на дату»
  const lid = addLine(t.db, rid, { svc: 40, day: TODAY });
  const d81 = await doctorSends(t, 81, { arrived: true });                                            // направил врач
  return { v77, v78, v79, rid, lid, d81 };
}

test('CRM_BOOKINGS_TAB_V1: источник — CRM, календарь, сайт / партнёр, направил врач, вместе; без фильтра — все; count_only — то же число', async () => {
  const t = await startCrmApp(seed);
  try {
    await seedToday(t);
    // Двойной: запись календаря и направление врача у одного пациента — одна строка, два источника.
    const v89 = await calendarBook(t, 'reg', TODAY, { hour: 15, svc: 30, doctor: 10, pid: 89 });
    await addVisitLine(t, 'doc', v89, { svc: 40, doctor: null });
    assert.deepEqual(ids(await list(t)), [77, 78, 79, 80, 81, 89], 'без фильтра — не прежний список');
    assert.deepEqual(ids(await list(t, { sources: ['crm'] })), [77, 80]);
    assert.deepEqual(ids(await list(t, { sources: ['calendar'] })), [78, 89]);
    assert.deepEqual(ids(await list(t, { sources: ['partner'] })), [79]);
    assert.deepEqual(ids(await list(t, { sources: ['doctor'] })), [81, 89]);
    assert.deepEqual(ids(await list(t, { sources: ['crm', 'doctor'] })), [77, 80, 81, 89]);
    assert.deepEqual(ids(await list(t, { sources: [] })), [77, 78, 79, 80, 81, 89], 'пустой список источников — не «все»');
    const both = rowOf(await list(t, { sources: ['doctor'] }), 89);
    assert.deepEqual(both.sources.map((s) => s.kind).sort(), ['calendar', 'doctor'], 'строка с двумя источниками потеряла второй');
    // Строки несут день и статус.
    const crm = await list(t, { sources: ['crm'] });
    assert.equal(crm.today, TODAY);
    assert.deepEqual(crm.rows.map((r) => [r.patient_id, r.day, r.status]), [[77, TODAY, 'waiting'], [80, TODAY, 'waiting']]);
    assert.equal(rowOf(crm, 77).booked_by[0], 'Оператор А', 'кто записал (оператор) не назван');
    // count_only — число строк с теми же фильтрами (счётчик вкладки — по фильтру по умолчанию).
    for (const f of [{ sources: ['crm'] }, { sources: ['doctor'] }, {}]) {
      const full = await list(t, f);
      const n = await list(t, { ...f, count_only: true });
      assert.equal(n.count, full.rows.length, JSON.stringify(f));
      assert.equal(n.rows, undefined, 'count_only отдал строки');
    }
  } finally { t.close(); }
});

test('CRM_BOOKINGS_TAB_V1: день — завтра, 7 дней (сегодня … +6), по дню и времени; восьмой день — нет; прошлый день «Ждут» — пусто', async () => {
  const t = await startCrmApp(seed);
  try {
    await callcenterBook(t, TODAY, { hour: 12, svc: 30, doctor: 10, pid: 77 });
    await callcenterBook(t, localDay(1), { hour: 9, svc: 30, doctor: 10, pid: 86 });
    await callcenterBook(t, localDay(6), { hour: 10, svc: 30, doctor: 10, pid: 88 });
    await callcenterBook(t, localDay(7), { hour: 10, svc: 30, doctor: 10, pid: 91 });
    const rid = addLead(t.db, { patient: 78, phone: '+998 90 000 00 78', name: 'Календарёва Анна' });
    addLine(t.db, rid, { svc: 40, day: localDay(2) });                                                 // анализ на послезавтра
    const tomorrow = await list(t, { day: localDay(1) });
    assert.deepEqual(tomorrow.rows.map((r) => [r.patient_id, r.day, r.status, r.time]), [[86, localDay(1), 'waiting', '09:00']]);
    assert.equal(tomorrow.from, localDay(1));
    assert.equal(tomorrow.to, localDay(1));
    const week = await list(t, { from: TODAY, to: localDay(6) });
    assert.deepEqual(week.rows.map((r) => [r.patient_id, r.day]), [[77, TODAY], [86, localDay(1)], [78, localDay(2)], [88, localDay(6)]],
      '7 дней — не по дню: ' + JSON.stringify(week.rows.map((r) => [r.patient_id, r.day])));
    assert.equal(rowOf(week, 78).time, null, 'у анализа на дату — время');
    assert.equal(week.count, 4);
    assert.equal((await list(t, { from: TODAY, to: localDay(6), count_only: true })).count, 4);
    // Прошлый день: неоформленная запись — «Не пришли», не «Ждут».
    rawBooking(t, 87, at(localDay(-1), 10));
    assert.deepEqual(ids(await list(t, { day: localDay(-1) })), [], 'прошлый день — «Ждут»');
    const past = await list(t, { day: localDay(-1), status: 'no_show' });
    assert.deepEqual(past.rows.map((r) => [r.patient_id, r.day, r.status]), [[87, localDay(-1), 'no_show']]);
  } finally { t.close(); }
});

test('CRM_BOOKINGS_TAB_V1: «Оформлены» — счёт, отметка «оформлен», «Пришёл», выставленное направление врача; приход с улицы — не запись; «Ждут» их не показывает', async () => {
  const t = await startCrmApp(seed);
  try {
    const { v77, d81 } = await seedToday(t);
    // 77 — оформлен со счётом окном визита.
    const ev = await t.rpc('ensure_visit', 'reg', { patient_id: 77, date: new Date().toISOString(), doctor_id: 10, visit_type: 'outpatient', desk: true });
    assert.equal(ev.json.data.visit.id, v77);
    const booked = t.db.prepare("SELECT id FROM visit_services WHERE visit_id = ? AND status = 'added'").all(v77).map((r) => r.id);
    assert.equal((await t.rpc('create_invoice_for_visit', 'reg', { visit_id: v77, visit_service_ids: booked, discount_amount: 0, payer_id: null })).status, 200);
    // 85 — оформлен без счёта (отметка).
    const v85 = await calendarBook(t, 'reg', TODAY, { hour: 16, svc: 30, doctor: 10, pid: 85 });
    assert.equal((await t.rpc('registrar_registered', 'reg', { visit_id: v85 })).status, 200);
    // 84 — «Пришёл».
    const v84 = await calendarBook(t, 'reg', TODAY, { hour: 17, svc: 30, doctor: 10, pid: 84 });
    t.db.prepare("UPDATE visits SET status = 'arrived' WHERE id = ?").run(v84);
    // 81 — направление врача выставлено.
    assert.equal((await t.rpc('create_invoice_for_visit', 'reg', { visit_id: d81.vid, visit_service_ids: [d81.id], discount_amount: 0, payer_id: null })).status, 200);
    // 90 — пришёл с улицы: визит стойки и счёт, записи не было.
    const walk = await deskRegister(t, 'reg', { pid: 90 });
    assert.equal((await t.rpc('create_invoice_for_visit', 'reg', { visit_id: walk.vid, visit_service_ids: walk.ids, discount_amount: 0, payer_id: null })).status, 200);

    const waiting = await list(t);
    assert.deepEqual(ids(waiting), [78, 79, 80], '«Ждут» показывает оформленных');
    const reg = await list(t, { status: 'registered' });
    assert.deepEqual(ids(reg), [77, 81, 84, 85], '«Оформлены»: ' + JSON.stringify(reg.rows.map((r) => [r.patient_id, r.sources])));
    assert.ok(reg.rows.every((r) => r.status === 'registered' && r.day === TODAY));
    assert.deepEqual(rowOf(reg, 77).sources.map((s) => s.kind), ['crm']);
    assert.deepEqual(rowOf(reg, 77).services, ['Консультация терапевта']);
    assert.deepEqual(rowOf(reg, 81).sources, [{ kind: 'doctor', name: 'Иванов' }]);
    assert.deepEqual(rowOf(reg, 81).services, ['Анализ крови']);
    assert.equal(rowOf(reg, 84).time, '17:00');
    assert.deepEqual(ids(await list(t, { status: 'registered', sources: ['crm'] })), [77]);
    assert.equal((await list(t, { status: 'registered', count_only: true })).count, 4);
  } finally { t.close(); }
});

test('CRM_BOOKINGS_TAB_V1: «Не пришли» — «Не пришёл» сегодня и неоформленная запись прошлого дня; «Отменены» — отменённая запись, строка заявки, отпущенный анализ и пропущенное направление — с причиной', async () => {
  const t = await startCrmApp(seed);
  try {
    // Не пришли. (Запись колл-центра со строкой карточки здесь не годится: строку, державшую визит
    // «Не пришёл», шаг A берёт снова — она «ждёт» анализом на дату, правило WAIT_REG_V1.)
    const v83 = await calendarBook(t, 'reg', TODAY, { hour: 16, svc: 30, doctor: 10, pid: 83 });
    t.db.prepare("UPDATE visits SET status = 'no_show' WHERE id = ?").run(v83);
    rawBooking(t, 87, at(localDay(-1), 10));
    // Отменённая запись (календарь).
    const v82 = await calendarBook(t, 'reg', TODAY, { hour: 15, svc: 30, doctor: 10, pid: 82 });
    const c = await t.rpc('calendar_book', 'reg', { visit_id: v82, start: t.db.prepare('SELECT visit_date FROM visits WHERE id = ?').get(v82).visit_date, status: 'cancelled' });
    assert.equal(c.status, 200, c.text);
    // Строка заявки на сегодня, отменённая оператором.
    const rid88 = addLead(t.db, { patient: 88, phone: '+998 90 000 00 88', name: 'Недельная Лола' });
    const l88 = addLine(t.db, rid88, { svc: 40, day: TODAY });
    t.db.prepare("UPDATE crm_request_services SET status = 'cancelled' WHERE id = ?").run(l88);
    // Анализ «на дату», отпущенный стойкой с причиной (визита ещё нет).
    const rid80 = addLead(t.db, { patient: 80, phone: '+998 90 000 00 80', name: 'Анализова Вера' });
    const l80 = addLine(t.db, rid80, { svc: 40, day: TODAY });
    const rel = await t.rpc('crm_wish_release', 'reg', { crm_line_id: l80, patient_id: 80, reason: 'Анализ сдан в другой лаборатории' });
    assert.equal(rel.status, 200, rel.text);
    // Направление врача, не оформленное с причиной.
    const d81 = await doctorSends(t, 81, { arrived: true });
    assert.equal((await t.rpc('referral_line_skip', 'reg', { visit_service_id: d81.id, reason: 'Пациент сдаст анализ завтра' })).status, 200);

    assert.deepEqual(ids(await list(t)), [], '«Ждут» показывает не пришедших и отменённых');
    const noShow = await list(t, { status: 'no_show' });
    assert.deepEqual(noShow.rows.map((r) => [r.patient_id, r.status]), [[83, 'no_show']], 'сегодня «Не пришли»');
    assert.deepEqual(rowOf(noShow, 83).sources.map((s) => s.kind), ['calendar']);
    assert.deepEqual(rowOf(noShow, 83).services, ['Консультация терапевта']);
    assert.equal(rowOf(noShow, 83).time, '16:00');
    assert.deepEqual(ids(await list(t, { day: localDay(-1), status: 'no_show' })), [87]);
    const both = await list(t, { from: localDay(-1), to: TODAY, status: 'no_show' });
    assert.deepEqual(both.rows.map((r) => [r.patient_id, r.day]), [[87, localDay(-1)], [83, TODAY]]);

    const cancelled = await list(t, { status: 'cancelled' });
    assert.deepEqual(ids(cancelled), [80, 81, 82, 88], '«Отменены»: ' + JSON.stringify(cancelled.rows.map((r) => [r.patient_id, r.sources])));
    assert.deepEqual(rowOf(cancelled, 82).sources.map((s) => s.kind), ['calendar']);
    assert.deepEqual(rowOf(cancelled, 88).sources.map((s) => s.kind), ['crm']);
    assert.deepEqual(rowOf(cancelled, 88).services, ['Анализ крови']);
    assert.deepEqual(rowOf(cancelled, 80).sources.map((s) => s.kind), ['crm']);
    assert.deepEqual(rowOf(cancelled, 80).services, ['Анализ крови']);
    assert.deepEqual(rowOf(cancelled, 80).reasons, ['Анализ сдан в другой лаборатории']);
    assert.deepEqual(rowOf(cancelled, 81).reasons, ['Пациент сдаст анализ завтра']);
    assert.deepEqual(ids(await list(t, { status: 'cancelled', sources: ['crm'] })), [80, 88]);
    assert.equal((await list(t, { status: 'cancelled', count_only: true })).count, 4);
    // «Все» — объединение статусов этого дня.
    const all = await list(t, { status: 'all' });
    assert.deepEqual(all.rows.map((r) => [r.patient_id, r.status]).sort((a, b) => a[0] - b[0]),
      [[80, 'cancelled'], [81, 'cancelled'], [82, 'cancelled'], [83, 'no_show'], [88, 'cancelled']]);
  } finally { t.close(); }
});

test('CRM_BOOKINGS_TAB_V1: «Все» — у пациента, оформленного утром, с анализом на дату — две строки (оформлен и ждёт); статус «Ждут» сегодня — ровно прежний список', async () => {
  const t = await startCrmApp(seed);
  try {
    const v78 = await calendarBook(t, 'reg', TODAY, { hour: 9, svc: 30, doctor: 10, pid: 78 });
    const booked = t.db.prepare("SELECT id FROM visit_services WHERE visit_id = ?").all(v78).map((r) => r.id);
    assert.equal((await t.rpc('create_invoice_for_visit', 'reg', { visit_id: v78, visit_service_ids: booked, discount_amount: 0, payer_id: null })).status, 200);
    const rid = addLead(t.db, { patient: 78, phone: '+998 90 000 00 78', name: 'Календарёва Анна' });
    addLine(t.db, rid, { svc: 40, day: TODAY });
    const all = await list(t, { status: 'all' });
    assert.deepEqual(all.rows.filter((r) => r.patient_id === 78).map((r) => r.status).sort(), ['registered', 'waiting']);
    const w = await list(t, { status: 'waiting' });
    const plain = await list(t);
    assert.deepEqual(w.rows, plain.rows, 'status: waiting — не прежний список');
    assert.deepEqual(w.rows.map((r) => [r.patient_id, r.status, r.services]), [[78, 'waiting', ['Анализ крови']]]);
  } finally { t.close(); }
});

test('CRM_BOOKINGS_TAB_V1: врач — только записи к нему; список врачей — is_doctor или роль «Врач», действующие', async () => {
  const t = await startCrmApp(seed);
  try {
    await seedToday(t);                                                             // 77, 78 — к врачу 10; 79 — к врачу 11
    const rid = addLead(t.db, { patient: 88, phone: '+998 90 000 00 88', name: 'Недельная Лола' });
    addLine(t.db, rid, { svc: 30, day: TODAY, doctor: 11 });                        // анализ «на дату» к врачу 11
    const d11 = await list(t, { doctor_id: 11 });
    assert.deepEqual(ids(d11), [79, 88]);
    assert.deepEqual(ids(await list(t, { doctor_id: 10 })), [77, 78]);
    assert.deepEqual(ids(await list(t, { doctor_id: '11', sources: ['partner'] })), [79]);
    assert.deepEqual(d11.doctors.map((d) => [d.id, d.name]).sort((a, b) => a[0] - b[0]), [[10, 'Иванов'], [11, 'Петрова'], [12, 'Админ-врач']],
      'список врачей: ' + JSON.stringify(d11.doctors));
    assert.equal((await list(t, { doctor_id: 11, count_only: true })).count, 2);
  } finally { t.close(); }
});

test('CRM_BOOKINGS_TAB_V1: поиск — имя (без регистра), цифры телефона, номер карты; с другими фильтрами', async () => {
  const t = await startCrmApp(seed);
  try {
    await seedToday(t);
    await callcenterBook(t, localDay(3), { hour: 10, svc: 30, doctor: 10, pid: 88 });
    assert.deepEqual(ids(await list(t, { q: 'календарёва' })), [78]);
    assert.deepEqual(ids(await list(t, { q: 'ПАРТНЁРОВ' })), [79]);
    assert.deepEqual(ids(await list(t, { q: '90 000 00 80' })), [80], 'телефон с пробелами');
    assert.deepEqual(ids(await list(t, { q: '+998900000081' })), [81], 'телефон цифрами');
    assert.deepEqual(ids(await list(t, { q: 'Пациент' })), [77]);
    assert.deepEqual(ids(await list(t, { q: 'нет-такого' })), []);
    assert.deepEqual(ids(await list(t, { q: 'em-0043', from: TODAY, to: localDay(6) })), [88], 'номер карты');
    assert.deepEqual(ids(await list(t, { q: 'em-0043' })), [], 'поиск вышел за день');
    assert.deepEqual(ids(await list(t, { q: '   ' })), [77, 78, 79, 80, 81], 'пустой поиск сузил список');
    assert.equal((await list(t, { q: '0000078', count_only: true })).count, 1);
  } finally { t.close(); }
});

test('CRM_BOOKINGS_TAB_V1: неверные аргументы — 400 словами; чужие роли — 403 и с фильтрами', async () => {
  const t = await startCrmApp(seed);
  try {
    const bad = [
      { day: 'завтра' }, { day: '2026-02-30' }, { day: 20261118 }, { from: TODAY }, { to: TODAY },
      { from: localDay(1), to: TODAY }, { from: TODAY, to: localDay(7) }, { day: TODAY, from: TODAY, to: TODAY },
      { sources: 'crm' }, { sources: ['crm', 'sms'] }, { sources: [1] },
      { status: 'paid' }, { status: ['waiting'] },
      { doctor_id: 'x' }, { doctor_id: -2 }, { doctor_id: 1.5 },
      { q: { a: 1 } }, { q: 'я'.repeat(201) },
    ];
    for (const args of bad) {
      const r = await t.rpc('registrar_waiting', 'reg', args);
      assert.equal(r.status, 400, JSON.stringify(args).slice(0, 80) + ': ' + r.text);
      assert.match(String(r.json.error && r.json.error.message), /[А-Яа-яЁё]/, 'отказ не словами: ' + r.text);
    }
    // Ровно 7 дней — можно; пустые значения — как «не задано».
    assert.equal((await t.rpc('registrar_waiting', 'reg', { from: TODAY, to: localDay(6) })).status, 200);
    assert.equal((await t.rpc('registrar_waiting', 'reg', { day: '', doctor_id: '', q: '', status: '', sources: null })).status, 200);
    for (const who of ['kassa', 'cc', 'doc']) {
      const r = await t.rpc('registrar_waiting', who, { status: 'all', from: TODAY, to: localDay(6), sources: ['crm'] });
      assert.equal(r.status, 403, who + ': ' + r.text);
    }
    assert.equal((await t.rpc('registrar_waiting', 'boss', { status: 'all' })).status, 200, 'администратору закрыто');
  } finally { t.close(); }
});
