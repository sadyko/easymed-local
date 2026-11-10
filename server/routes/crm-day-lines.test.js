// CRM_DAY_LINES_V1 (3.23.0) — РЕГИСТРАТУРА ВИДИТ КАЖДУЮ ЗАПИСАННУЮ СТРОКУ ДНЯ. Владелец: «the
// booked patients cannot be seen in the registrar when adding services». Причина — не
// переименование колонок (код названия колонок не читает): подстановка в смету (crm-lines.js)
// читала через /api/db, где действует ограничение CRM по хозяину (регистратор видит ничьи и свои
// карточки), и только открытые колонки и «Пришёл» — карточку, взятую оператором «в работу», и
// карточку в «Не пришёл» регистратура не видела, а сервер их строки в визит сажал.
//
// RPC crm_day_lines { patient_id, day, visit_id } — то же правило, что у шага связи (шаг A,
// crm/visit-link.js): открытые колонки, конверсия и колонка с ролью «не пришёл», без
// ограничения по хозяину; в ответе — только услуга, врач и дата (не заметки, не телефоны).
// Воспроизведения расследования: scratchpad inv-crm/repro-item1b.mjs, repro-item1c.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startCrmApp, addLead } from '../test-helpers/crm-unify-app.js';
import { crmDayLines } from '../services/rpc/crm-day-lines.js';   // ревью — 403 у роли без доступа
import { openDb } from '../db/connection.js';

// Дни и время — по часам БАЗЫ (SQLite localtime): сервер считает местный день визита SQLite, и
// проверка поздним вечером (сдвиг часового пояса JS) не должна разводить дни теста и сервера.
const CLOCK = openDb(':memory:');
const pad = (n) => String(n).padStart(2, '0');
const localDay = (off = 0) => CLOCK.prepare("SELECT date('now', 'localtime', ?) AS d").get(off + ' days').d;
const at = (day, hh, mm = 0) => CLOCK.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%SZ', ?, 'utc') AS t").get(day + ' ' + pad(hh) + ':' + pad(mm) + ':00').t;
const today = localDay(0);
const FIELDS = ['consultation_type_id', 'doctor_id', 'id', 'scheduled_date', 'service_id', 'visit_id'];
const line = (db, rid, { svc = 40, day = today, doctor = null, visit = null, status = 'pending', note = null } = {}) =>
  Number(db.prepare('INSERT INTO crm_request_services (request_id, service_id, scheduled_date, status, doctor_id, visit_id, note) VALUES (?,?,?,?,?,?,?)')
    .run(rid, svc, day, status, doctor, visit, note).lastInsertRowid);
const ask = async (t, who, args) => {
  const r = await t.rpc('crm_day_lines', who, args);
  assert.equal(r.status, 200, r.text);
  return r.json.data;
};

test('регистратор видит строку карточки, взятой оператором «в работу», и строку карточки «Не пришёл» — только услуга, врач и дата', async () => {
  const t = await startCrmApp();
  try {
    const taken = addLead(t.db, { status: 'scheduled', assigned: 3, date: today });
    const l1 = line(t.db, taken, { svc: 40, note: 'перезвонить маме' });
    const missed = addLead(t.db, { status: 'no_show', date: today });
    const l2 = line(t.db, missed, { svc: 30, doctor: 10 });
    // /api/db под регистратором карточку оператора не отдаёт (ограничение по хозяину) — RPC отдаёт строку.
    const own = await t.dbq('reg', { table: 'crm_requests', op: 'select', columns: 'id', filters: [{ col: 'id', op: 'eq', val: taken }] });
    assert.deepEqual(own.json.data, [], 'проверка самой проверки: ограничение по хозяину действует');
    const got = await ask(t, 'reg', { patient_id: 77, day: today });
    assert.deepEqual(got.map((l) => l.id).sort((a, b) => a - b), [l1, l2].sort((a, b) => a - b));
    for (const l of got) assert.deepEqual(Object.keys(l).sort(), FIELDS, 'в ответе лишнее: ' + JSON.stringify(l));
    assert.ok(!JSON.stringify(got).includes('маме'), 'заметка карточки ушла регистратуре');
    assert.deepEqual(got.find((l) => l.id === l2), { id: l2, service_id: 30, consultation_type_id: null, doctor_id: 10, scheduled_date: today, visit_id: null });
  } finally { t.close(); }
});

test('то же правило, что у шага связи: проигрышные, другой день, закрытые строки и чужой пациент — нет; «Пришёл» — да; без роли «не пришёл» — нет', async () => {
  const t = await startCrmApp((db) => db.prepare("INSERT INTO patients (id, full_name, phone) VALUES (78,'Другой','+998 91 111 22 33')").run());
  try {
    const came = addLead(t.db, { status: 'came' });
    const lCame = line(t.db, came, { svc: 30, doctor: 10 });
    const stopped = addLead(t.db, { status: 'stopped' });
    line(t.db, stopped);
    const open = addLead(t.db, { status: 'in_process' });
    line(t.db, open, { day: localDay(1) });
    line(t.db, open, { status: 'done' });
    const other = addLead(t.db, { status: 'in_process', patient: 78, phone: '+998 91 111 22 33' });
    line(t.db, other);
    const missed = addLead(t.db, { status: 'no_show' });
    const lMissed = line(t.db, missed, { svc: 40 });
    assert.deepEqual((await ask(t, 'reg', { patient_id: 77, day: today })).map((l) => l.id).sort((a, b) => a - b), [lCame, lMissed]);
    t.db.prepare("UPDATE crm_stages SET role = NULL WHERE role = 'no_show'").run();   // CRM_STAGE_ROLES_V1
    assert.deepEqual((await ask(t, 'reg', { patient_id: 77, day: today })).map((l) => l.id), [lCame]);
  } finally { t.close(); }
});

test('визит известен — строки этого приёма; одинаковые строки двух карточек — одна', async () => {
  const t = await startCrmApp();
  try {
    const vid = Number(t.db.prepare("INSERT INTO visits (patient_id, doctor_id, visit_date, status) VALUES (77, 10, ?, 'scheduled')").run(at(today, 10)).lastInsertRowid);
    const a = addLead(t.db, { status: 'scheduled' });
    const b = addLead(t.db, { status: 'in_process' });
    const la = line(t.db, a, { svc: 30, doctor: 10, visit: vid });
    line(t.db, b, { svc: 30, doctor: 10 });
    const lb2 = line(t.db, b, { svc: 40 });
    assert.deepEqual((await ask(t, 'reg', { patient_id: 77, day: today })).map((l) => l.id), [la, lb2]);
    assert.deepEqual((await ask(t, 'reg', { patient_id: 77, day: today, visit_id: vid })).map((l) => l.id), [la]);
  } finally { t.close(); }
});

test('без дня или пациента — пусто, без ошибки; неверный день — отказ', async () => {
  const t = await startCrmApp();
  try {
    assert.deepEqual(await ask(t, 'reg', { patient_id: 77, day: '' }), []);
    assert.deepEqual(await ask(t, 'reg', { patient_id: null, day: today }), []);
    const bad = await t.rpc('crm_day_lines', 'reg', { patient_id: 77, day: '10.11.2026' });
    assert.equal(bad.status, 400, bad.text);
  } finally { t.close(); }
});

// Ревью: доступ — роли, которые открывают мастер визита и каталог услуг (администратор,
// регистратура, касса, врач, медсестра), видят все строки дня; колл-центр — только строки
// карточек, которые видит сам (свои и ничьи; руководитель с crm.all — все); прочие — 403.
test('ревью: регистратура, касса, врач — все строки; оператор — только свои и ничьи карточки; лаборатория — 403', async () => {
  const t = await startCrmApp();
  try {
    const mineCc = addLead(t.db, { status: 'scheduled', assigned: 3 });
    const lCc = line(t.db, mineCc, { svc: 40 });
    const nobody = addLead(t.db, { status: 'in_process' });
    const lNobody = line(t.db, nobody, { svc: 30, doctor: 10 });
    const ids = async (who) => (await ask(t, who, { patient_id: 77, day: today })).map((l) => l.id).sort((a, b) => a - b);
    for (const who of ['reg', 'kassa', 'doc', 'boss', 'head']) assert.deepEqual(await ids(who), [lCc, lNobody].sort((a, b) => a - b), who);
    assert.deepEqual(await ids('cc'), [lCc, lNobody].sort((a, b) => a - b), 'своя и ничья');
    assert.deepEqual(await ids('cc2'), [lNobody], 'оператор Б видит строку карточки оператора А');
    const e = (() => { try { crmDayLines(t.db, { patient_id: 77, day: today }, { id: 99, role: 'lab', extra_roles: [] }); } catch (x) { return x; } return null; })();
    assert.ok(e && e.status === 403, 'лаборатория получила строки заявок: ' + (e && e.message));
  } finally { t.close(); }
});

// Ревью: одно правило с шагом связи ensure_visit (шаг A, undated): желание без даты живой карточки
// (никогда не записанное) — в смету; отпущенное отменой — нет; у «Пришёл» без даты — нет; строка,
// которую держит ДРУГОЙ живой визит, — нет; строки карточки, привязанной к визиту по телефону, — нет.
test('ревью: правило шага связи — желания без даты, отпущенные, чужой живой визит, карточка по телефону', async () => {
  const t = await startCrmApp();
  try {
    const live = addLead(t.db, { status: 'in_process' });
    const wish = line(t.db, live, { svc: 40, day: null });
    const released = line(t.db, live, { svc: 30, day: null });
    t.db.prepare("INSERT INTO visits (id, patient_id, visit_date, status) VALUES (900, 77, ?, 'cancelled')").run(at(localDay(-2), 10));
    t.db.prepare('UPDATE crm_request_services SET released_from_visit_id = 900 WHERE id = ?').run(released);
    const won = addLead(t.db, { status: 'came' });
    line(t.db, won, { svc: 30, doctor: 10, day: null });
    const other = Number(t.db.prepare("INSERT INTO visits (patient_id, doctor_id, visit_date, status) VALUES (77, 10, ?, 'scheduled')").run(at(localDay(-1), 10)).lastInsertRowid);
    const heldElsewhere = addLead(t.db, { status: 'scheduled' });
    line(t.db, heldElsewhere, { svc: 30, doctor: 10, visit: other });   // строка дня держит другой живой визит
    const got = await ask(t, 'reg', { patient_id: 77, day: today });
    assert.deepEqual(got.map((l) => l.id), [wish], JSON.stringify(got));
    assert.equal(got[0].scheduled_date, null);
    // Визит дня, к которому карточка привязана по телефону (шаг D): её строки в него не идут.
    const vid = Number(t.db.prepare("INSERT INTO visits (patient_id, doctor_id, visit_date, status) VALUES (77, 10, ?, 'scheduled')").run(at(today, 11)).lastInsertRowid);
    t.db.prepare("INSERT INTO crm_booking_links (visit_id, request_id, source) VALUES (?, ?, 'phone')").run(vid, live);
    assert.deepEqual(await ask(t, 'reg', { patient_id: 77, day: today, visit_id: vid }), []);
    // Тот же визит открывает ensure_visit — сажает ровно то же (ничего).
    const ev = await t.rpc('ensure_visit', 'reg', { patient_id: 77, date: at(today, 11), doctor_id: 10 });
    assert.equal(ev.status, 200, ev.text);
    assert.deepEqual(t.db.prepare("SELECT COUNT(*) AS n FROM visit_services WHERE visit_id = ?").get(vid).n, 0);
  } finally { t.close(); }
});

test('ревью: что смета предлагает, то ensure_visit и сажает (визит дня без номера — визит дня пациента)', async () => {
  const t = await startCrmApp();
  try {
    const a = addLead(t.db, { status: 'scheduled', assigned: 3 });
    line(t.db, a, { svc: 40 });
    const n = addLead(t.db, { status: 'no_show' });
    line(t.db, n, { svc: 30, doctor: 10 });
    t.db.prepare("INSERT INTO services (id, name, price, type) VALUES (60, 'ЭКГ', 50000, 'procedure')").run();
    const w = addLead(t.db, { status: 'in_process' });
    line(t.db, w, { svc: 60, day: null });
    const offered = (await ask(t, 'reg', { patient_id: 77, day: today })).map((l) => l.service_id).sort((x, y) => x - y);
    const ev = await t.rpc('ensure_visit', 'reg', { patient_id: 77, date: at(today, 10), doctor_id: 10 });
    assert.equal(ev.status, 200, ev.text);
    const seated = t.db.prepare("SELECT service_id FROM visit_services WHERE visit_id = ? ORDER BY service_id").all(ev.json.data.visit.id).map((r) => r.service_id);
    assert.deepEqual(offered, seated, 'смета и сервер разошлись');
    assert.deepEqual(offered, [30, 40, 60]);
  } finally { t.close(); }
});
