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
import { startCrmApp, addLead, localDay, at } from '../test-helpers/crm-unify-app.js';

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

test('без дня или пациента — пусто, без ошибки; неверный день — отказ; кто не читает строки CRM — 403', async () => {
  const t = await startCrmApp();
  try {
    assert.deepEqual(await ask(t, 'reg', { patient_id: 77, day: '' }), []);
    assert.deepEqual(await ask(t, 'reg', { patient_id: null, day: today }), []);
    const bad = await t.rpc('crm_day_lines', 'reg', { patient_id: 77, day: '10.11.2026' });
    assert.equal(bad.status, 400, bad.text);
    for (const who of ['cc', 'boss', 'doc', 'kassa']) assert.equal((await t.rpc('crm_day_lines', who, { patient_id: 77, day: today })).status, 200, who);
  } finally { t.close(); }
});
