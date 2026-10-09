// CRM_UNIFY_V1 — РЕГИСТРАЦИЯ НА СТОЙКЕ = «ПРИШЁЛ» (решение владельца 1).
// Быстрая регистрация и «пришёл сейчас» шлют ensure_visit с desk: true
// (views/walk-in-booking.js). Сервер верит этому только от регистратуры и
// администратора (основная роль или дополнительная), только сегодня по
// местному времени и только без записи на время (book). Первый приход
// закрывает карточку в «Пришёл», даже если у неё остались строки на другие дни
// (Р8); «Отказ» и «Пришёл» не трогаются; пациент без карточки её не получает
// (решение 2). Всё — через настоящие двери /api/rpc под настоящими ролями.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startCrmApp, localDay, at, addLead, addLine, linesOf } from '../test-helpers/crm-unify-app.js';
import { crmLinkVisit } from '../services/crm/visit-link.js';

const TODAY = localDay(0);
const D = localDay(3);
const nowIso = () => new Date().toISOString();
const desk = (t, who = 'reg', date = nowIso(), extra = {}) =>
  t.rpc('ensure_visit', who, { patient_id: 77, date, doctor_id: 10, visit_type: 'outpatient', desk: true, ...extra });

test('стойка: лид из звонка без пациента — быстрая регистрация закрывает его в «Пришёл» сразу', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { patient: null, phone: '909092638', assigned: 3, name: '909092638' });
    const r = await desk(t);
    assert.equal(r.status, 200, r.text);
    assert.equal(t.lead(rid).patient_id, 77);
    assert.equal(t.lead(rid).status, 'came', 'регистратор зарегистрировал звонившего — а в «Пришёл» пусто');
  } finally { t.close(); }
});

test('стойка: строка карточки на сегодня берёт визит и закрывается; карточка — «Пришёл»', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { assigned: 3, date: TODAY });
    addLine(t.db, rid, { svc: 40, day: TODAY });
    const r = await desk(t);
    assert.equal(r.status, 200, r.text);
    const vid = r.json.data.visit.id;
    assert.deepEqual(linesOf(t.db, rid).map((l) => [l.status, l.visit_id]), [['done', vid]]);
    assert.equal(t.lead(rid).status, 'came');
    // Строка закрыта приходом до зеркала: в визит она не копируется — в счёт
    // идут строки, которые выбрал регистратор (registerWalkIn).
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM visit_services WHERE visit_id = ?').get(vid).n, 0);
  } finally { t.close(); }
});

test('стойка: карточку, записанную колл-центром на неделю вперёд, закрывает первый приход; строка недели остаётся записью', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { assigned: 3, date: D });
    const b = await t.rpc('ensure_visit', 'cc', { patient_id: 77, date: at(D, 10), doctor_id: 10,
      book: { doctor_id: 10, service_id: 30, start: at(D, 10), duration_minutes: 30 } });
    assert.equal(b.status, 200, b.text);
    addLine(t.db, rid, { svc: 30, day: D, doctor: 10, visit: b.json.data.visit.id });
    const r = await desk(t);
    assert.equal(r.status, 200, r.text);
    assert.equal(t.lead(rid).status, 'came', 'первый приход не закрыл карточку');
    assert.deepEqual(linesOf(t.db, rid).filter((l) => l.scheduled_date === D).map((l) => [l.status, l.visit_id]),
      [['pending', b.json.data.visit.id]], 'строка будущего дня закрылась вместе с приходом — запись пропала из карточки');
    assert.equal(t.db.prepare('SELECT status FROM visits WHERE id = ?').get(b.json.data.visit.id).status, 'scheduled');
  } finally { t.close(); }
});

test('стойка: карточка дальше «Записан» («Согласован») тоже закрывается приходом', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { status: 'approved', assigned: 3, date: D });
    addLine(t.db, rid, { svc: 40, day: D });
    const r = await desk(t);
    assert.equal(r.status, 200, r.text);
    assert.equal(t.lead(rid).status, 'came');
    assert.deepEqual(linesOf(t.db, rid).map((l) => l.status), ['pending']);
  } finally { t.close(); }
});

test('стойка: визит дня уже «Пришёл» — регистрация на стойке всё равно закрывает карточку другого дня', async () => {
  const t = await startCrmApp();
  try {
    const e = await t.rpc('ensure_visit', 'reg', { patient_id: 77, date: TODAY, doctor_id: 10 });
    assert.equal(e.status, 200, e.text);
    const vid = e.json.data.visit.id;
    const when = t.db.prepare('SELECT visit_date FROM visits WHERE id = ?').get(vid).visit_date;
    const arr = await t.rpc('calendar_book', 'reg', { visit_id: vid, status: 'arrived', start: when });
    assert.equal(arr.status, 200, arr.text);

    const rid = addLead(t.db, { assigned: 3, date: D, name: 'На четверг' });
    addLine(t.db, rid, { svc: 40, day: D });
    const r = await desk(t);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.data.visit.id, vid);
    assert.equal(t.lead(rid).status, 'came', 'пациент у стойки, визит «Пришёл», а карточка ждёт другого дня');
    assert.deepEqual(linesOf(t.db, rid).map((l) => [l.status, l.visit_id]), [['pending', null]]);
  } finally { t.close(); }
});

test('стойка: администратор и регистратура дополнительной ролью — «Пришёл»', async () => {
  for (const who of ['boss', 'cc2']) {
    const t = await startCrmApp((db) => db.prepare('UPDATE users SET extra_roles = ? WHERE id = 4').run('["registrar"]'));
    try {
      const rid = addLead(t.db, { assigned: 3, date: D });
      addLine(t.db, rid, { svc: 40, day: D });
      const r = await desk(t, who);
      assert.equal(r.status, 200, r.text);
      assert.equal(t.lead(rid).status, 'came', `${who}: регистрация на стойке не закрыла карточку`);
    } finally { t.close(); }
  }
});

test('стойка: колл-центру, врачу, будущему дню и записи на время desk не верят; без desk сегодня — «Записан»', async () => {
  for (const [who, date, extra] of [
    ['cc', nowIso(), {}],
    ['doc', nowIso(), {}],
    ['reg', at(D, 10), {}],
    ['reg', at(TODAY, 9), { book: { doctor_id: 10, service_id: 30, start: at(TODAY, 9), duration_minutes: 30 } }],
  ]) {
    const t = await startCrmApp();
    try {
      const rid = addLead(t.db);
      const r = await desk(t, who, date, extra);
      assert.equal(r.status, 200, r.text);
      assert.equal(t.lead(rid).status, 'scheduled', `${who} ${date} ${Object.keys(extra)}: приход объявлен без прихода`);
    } finally { t.close(); }
  }
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db);
    const r = await t.rpc('ensure_visit', 'reg', { patient_id: 77, date: nowIso(), doctor_id: 10 });
    assert.equal(r.status, 200, r.text);
    assert.equal(t.lead(rid).status, 'scheduled', 'визит без desk объявил приход');
  } finally { t.close(); }
});

test('стойка: карточку, ждущую другой день, ни врач с desk, ни регистратура без desk не двигают', async () => {
  for (const [who, args] of [['doc', { desk: true }], ['reg', {}]]) {
    const t = await startCrmApp();
    try {
      const rid = addLead(t.db, { assigned: 3, date: D });
      addLine(t.db, rid, { svc: 40, day: D });
      const r = await t.rpc('ensure_visit', who, { patient_id: 77, date: nowIso(), doctor_id: 10, ...args });
      assert.equal(r.status, 200, r.text);
      assert.deepEqual([t.lead(rid).status, t.lead(rid).scheduled_date], ['in_process', D], who);
    } finally { t.close(); }
  }
});

test('стойка: предоплата будущего визита — не приход', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { assigned: 3 });
    const b = await t.rpc('ensure_visit', 'reg', { patient_id: 77, date: at(D, 10), doctor_id: 10,
      book: { doctor_id: 10, service_id: 30, start: at(D, 10), duration_minutes: 30 } });
    assert.equal(b.status, 200, b.text);
    const vid = b.json.data.visit.id;
    const add = await t.rpc('booking_lines_add', 'reg', { visit_id: vid, patient_id: 77, lines: [{ service_id: 40 }] });
    assert.equal(add.status, 200, add.text);
    const vs = t.db.prepare('SELECT id FROM visit_services WHERE visit_id = ?').all(vid).map((r) => r.id);
    const inv = await t.rpc('create_invoice_for_visit', 'reg', { visit_id: vid, visit_service_ids: vs, discount_amount: 0, payer_id: null });
    assert.equal(inv.status, 200, inv.text);
    const due = t.db.prepare('SELECT total_amount FROM invoices WHERE id = ?').get(inv.json.data.invoice.id).total_amount;
    const pay = await t.rpc('record_payment', 'kassa', { invoice_id: inv.json.data.invoice.id, amount: Number(due), method: 'cash' });
    assert.equal(pay.status, 200, pay.text);
    assert.equal(t.lead(rid).status, 'scheduled', 'предоплата будущего визита объявлена приходом');
  } finally { t.close(); }
});

test('стойка: визит соседнего здания приходом не считается, даже с desk', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { assigned: 3 });
    const vid = Number(t.db.prepare(`INSERT INTO visits (patient_id, doctor_id, visit_date, status, sync_origin)
                                     VALUES (77, 10, ?, 'scheduled', 'B')`).run(nowIso()).lastInsertRowid);
    crmLinkVisit(t.db, vid, { id: 2, role: 'registrar', extra_roles: [] }, { undated: true, desk: true });
    assert.equal(t.lead(rid).status, 'in_process');
  } finally { t.close(); }
});

test('стойка: пациент без карточки карточку не получает; «Отказ» и «Пришёл» не трогаются', async () => {
  const t = await startCrmApp();
  try {
    let r = await desk(t);
    assert.equal(r.status, 200, r.text);
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM crm_requests').get().n, 0, 'пришедший сам получил карточку');
    const stopped = addLead(t.db, { status: 'stopped' });
    const came = addLead(t.db, { status: 'came' });
    r = await desk(t);
    assert.equal(r.status, 200, r.text);
    assert.equal(t.lead(stopped).status, 'stopped', 'приход открыл закрытую «Отказ»');
    assert.equal(t.lead(came).status, 'came');
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM crm_requests').get().n, 2);
  } finally { t.close(); }
});
