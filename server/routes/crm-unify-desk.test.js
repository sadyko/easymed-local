// CRM_UNIFY_V1 — РЕГИСТРАЦИЯ НА СТОЙКЕ = «ПРИШЁЛ» (решение владельца 1).
// Быстрая регистрация и «пришёл сейчас» шлют ensure_visit с desk: true
// (views/walk-in-booking.js). Сервер верит этому только от регистратуры и
// администратора (основная роль или дополнительная), только сегодня по
// местному времени и только без записи на время (book). Первый приход
// закрывает карточку в «Пришёл», даже если у неё остались строки на другие дни
// (Р8); «Отказ» и «Пришёл» не трогаются; пациент без карточки её не получает
// (решение 2). Всё — через настоящие двери /api/rpc под настоящими ролями.
//
// РЕВЬЮ ЗАДАЧИ 3 (R1–R7): ступень карточки (воронка) НИКОГДА не решает судьбу
// услуг (деньги). Строки, записанные колл-центром, идут в визит и в кассу ровно
// как до задачи 3; стойка закрывает только карточки, ждущие сегодня или живые
// в окне повторного обращения.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startCrmApp, localDay, at, addLead, addLine, linesOf, daysAgoIso } from '../test-helpers/crm-unify-app.js';
import { crmLinkVisit } from '../services/crm/visit-link.js';
import { crmServiceEvidence } from '../services/crm/visit-status.js';

const TODAY = localDay(0);
const D = localDay(3);
const nowIso = () => new Date().toISOString();
const desk = (t, who = 'reg', date = nowIso(), extra = {}) =>
  t.rpc('ensure_visit', who, { patient_id: 77, date, doctor_id: 10, visit_type: 'outpatient', desk: true, ...extra });
const vsOf = (db, vid) => db.prepare(`SELECT id, service_id, status, invoice_item_id FROM visit_services
                                       WHERE visit_id = ? ORDER BY id`).all(vid);
const lineRow = (db, id) => db.prepare('SELECT status, visit_id FROM crm_request_services WHERE id = ?').get(id);

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
    // Ревью задачи 3 (R2): зеркало ведёт строку в визит ДО правила прихода —
    // касса видит записанную услугу («Ждут счёта»), как до задачи 3.
    assert.deepEqual(vsOf(t.db, vid).map((x) => [x.service_id, x.status]), [[40, 'added']],
      'записанная услуга не дошла до визита — касса её не увидит');
  } finally { t.close(); }
});

test('стойка: карточка закрывается с ПРЕЖНЕЙ датой — дата записи другого дня не меняется', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { assigned: 3, date: D });
    addLine(t.db, rid, { svc: 40, day: D });
    const r = await desk(t);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual([t.lead(rid).status, t.lead(rid).scheduled_date], ['came', D],
      'стойка переписала дату карточки днём прихода');
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

// ═══════════════════════════════════════════════════════════════════════════
// РЕВЬЮ ЗАДАЧИ 3 — АТАКИ R1–R7, перенесённые в репозиторий
// ═══════════════════════════════════════════════════════════════════════════

/** Слот сегодня: через час, если он ещё сегодня, иначе 08:00. */
function slotToday() {
  const d = new Date(Date.now() + 60 * 60 * 1000);
  const same = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` === TODAY;
  if (same) { d.setMinutes(0, 0, 0); return d.toISOString(); }
  return at(TODAY, 8);
}

/** Регистратура ставит СВОЮ строку визита через /api/db и выставляет по ней счёт. */
async function regInsertAndBill(t, vid, svc, doctor) {
  const ins = await t.dbq('reg', { table: 'visit_services', op: 'insert', returning: true, single: 'single',
    values: { visit_id: vid, service_id: svc, doctor_id: doctor, quantity: 1, unit_price: 100000, total: 100000, status: 'added' } });
  assert.equal(ins.status, 200, ins.text);
  const x = ins.json.data.id;
  const inv = await t.rpc('create_invoice_for_visit', 'reg', { visit_id: vid, visit_service_ids: [x], discount_amount: 0, payer_id: null });
  assert.equal(inv.status, 200, inv.text);
  return { x, inv: inv.json.data.invoice.id };
}

// R1 (критическое) — колл-центр записал на СЕГОДНЯ со слотом: зеркало уже
// поставило в визит консультацию 30 и анализ 40 ('added'). Регистратура на
// стойке выбирает ту же консультацию и выставляет счёт. Строка зеркала
// уступает место строке регистратуры — и когда стойка уже закрыла строки
// заявки ('done'): одна консультация — один счёт, анализ ждёт кассы.
for (const deskFlag of [false, true]) {
  test(`R1: запись колл-центра на сегодня, стойка выбрала ту же консультацию — одна строка, анализ ждёт счёта (desk=${deskFlag})`, async () => {
    const t = await startCrmApp();
    try {
      const r = await t.dbq('cc', { table: 'crm_requests', op: 'insert', returning: true, single: 'single',
        values: { full_name: 'Пациент Тест', phone: '+998 90 909 26 38', patient_id: 77, status: 'in_process', source: 'call' } });
      assert.equal(r.status, 200, r.text);
      const rid = r.json.data.id;
      const ins = await t.dbq('cc', { table: 'crm_request_services', op: 'insert', values: [
        { request_id: rid, service_id: 30, scheduled_date: TODAY, doctor_id: 10, status: 'pending' },
        { request_id: rid, service_id: 40, scheduled_date: TODAY, status: 'pending' },
      ] });
      assert.equal(ins.status, 200, ins.text);
      const start = slotToday();
      const b = await t.rpc('ensure_visit', 'cc', { patient_id: 77, date: start, doctor_id: 10,
        book: { doctor_id: 10, service_id: 30, start, duration_minutes: 30 } });
      assert.equal(b.status, 200, b.text);
      const vid = b.json.data.visit.id;
      assert.deepEqual(vsOf(t.db, vid).map((x) => x.service_id).sort(), [30, 40], 'зеркало записи не поставило строки в визит');

      const e = await t.rpc('ensure_visit', 'reg', { patient_id: 77, date: nowIso(), doctor_id: 10, visit_type: 'outpatient',
        ...(deskFlag ? { desk: true } : {}) });
      assert.equal(e.status, 200, e.text);
      assert.equal(e.json.data.visit.id, vid);
      const { x } = await regInsertAndBill(t, vid, 30, 10);

      const rows = vsOf(t.db, vid).filter((y) => y.status !== 'cancelled');
      assert.deepEqual(rows.filter((y) => y.service_id === 30).map((y) => y.id), [x],
        'консультация 30 в визите дважды: строка зеркала осталась рядом с выставленной');
      const lab = rows.filter((y) => y.service_id === 40);
      assert.equal(lab.length, 1);
      assert.deepEqual([lab[0].status, lab[0].invoice_item_id], ['added', null], 'анализ 40 пропал из «Ждут счёта»');
      const ub = await t.rpc('cashier_unbilled', 'kassa', {});
      assert.equal(ub.status, 200, ub.text);
      const mine = ub.json.data.rows.find((g) => g.visit_id === vid);
      assert.ok(mine, 'визит пропал из «Ждут счёта»');
      assert.equal(mine.total, 40000, '«Ждут счёта» — не только анализ: консультация показана второй раз');
      assert.equal(t.lead(rid).status, deskFlag ? 'came' : 'scheduled');
    } finally { t.close(); }
  });
}

// R2 — строка заявки на сегодня (не записанная слотом) и строка «без даты»,
// которых регистратор не выбрал: как до задачи 3 они берут визит и встают в
// него 'added' — касса их видит. Строки заявки — по правилу прихода.
test('R2: строки сегодня и «без даты», не выбранные регистратором, — в визите и в «Ждут счёта»', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { assigned: 3, date: TODAY });
    const l40 = addLine(t.db, rid, { svc: 40, day: TODAY });
    const lUndated = addLine(t.db, rid, { svc: 40, day: null });
    const e = await desk(t);
    assert.equal(e.status, 200, e.text);
    const vid = e.json.data.visit.id;
    await regInsertAndBill(t, vid, 30, 10);
    const unbilled = vsOf(t.db, vid).filter((x) => x.invoice_item_id == null && x.status !== 'cancelled');
    assert.deepEqual(unbilled.map((x) => [x.service_id, x.status]), [[40, 'added']],
      'записанный анализ молча пропал: в визите его нет, касса его не видит');
    assert.deepEqual(lineRow(t.db, l40), { status: 'done', visit_id: vid });
    assert.deepEqual(lineRow(t.db, lUndated), { status: 'done', visit_id: vid });
    assert.equal(t.lead(rid).status, 'came');
  } finally { t.close(); }
});

// R3 — связь строк не зависит от того, открыта ли карточка. Закрытая карточка
// («Пришёл») держит строку на D: запись на D берёт её и ведёт в визит; ступень
// не меняется — закрытая карточка не открывается. Строка проигрышной карточки
// («Отказ») не берётся. Строки не двоятся.
test('R3: строка будущего дня закрытой карточки — запись колл-центра на этот день ведёт её в визит; карточка остаётся закрытой', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { assigned: 3, date: D });
    const l = addLine(t.db, rid, { svc: 40, day: D });
    const stopped = addLead(t.db, { status: 'stopped', name: 'Отказ' });
    const ls = addLine(t.db, stopped, { svc: 40, day: D });
    const r = await desk(t);
    assert.equal(r.status, 200, r.text);
    assert.equal(t.lead(rid).status, 'came');
    assert.deepEqual(lineRow(t.db, l), { status: 'pending', visit_id: null });

    const b = await t.rpc('ensure_visit', 'cc', { patient_id: 77, date: at(D, 10), doctor_id: 10,
      book: { doctor_id: 10, service_id: 30, start: at(D, 10), duration_minutes: 30 } });
    assert.equal(b.status, 200, b.text);
    const vD = b.json.data.visit.id;
    assert.deepEqual(lineRow(t.db, l), { status: 'pending', visit_id: vD }, 'строка закрытой карточки не взяла запись своего дня');
    assert.deepEqual(vsOf(t.db, vD).filter((x) => x.service_id === 40).map((x) => x.status), ['added'],
      'записанный анализ не встал в визит своего дня');
    assert.equal(t.lead(rid).status, 'came', 'закрытая карточка открылась');
    assert.deepEqual(lineRow(t.db, ls), { status: 'pending', visit_id: null }, 'строка «Отказа» взяла запись');
    assert.equal(t.lead(stopped).status, 'stopped');
    assert.equal(t.db.prepare("SELECT COUNT(*) n FROM crm_request_services WHERE service_id = 40 AND status <> 'cancelled'").get().n, 2,
      'строка заявки задвоилась');
  } finally { t.close(); }
});

// R4 — «Отказ» остаётся «Отказом»: ни стойка, ни оплата, ни работа, ни привязка.
async function stoppedWithTodayLine(t) {
  const rid = addLead(t.db, { status: 'stopped', date: TODAY });
  const e = await t.rpc('ensure_visit', 'reg', { patient_id: 77, date: nowIso(), doctor_id: 10 });
  assert.equal(e.status, 200, e.text);
  const vid = e.json.data.visit.id;
  addLine(t.db, rid, { svc: 40, day: TODAY, visit: vid });
  return { rid, vid };
}
test('R4: «Отказ» со строкой этого визита — ни стойка, ни оплата, ни работа, ни привязка его не закрывают', async () => {
  let t = await startCrmApp();
  try {
    const { rid } = await stoppedWithTodayLine(t);
    const r = await desk(t);
    assert.equal(r.status, 200, r.text);
    assert.equal(t.lead(rid).status, 'stopped', 'стойка');
  } finally { t.close(); }
  t = await startCrmApp();
  try {
    const { rid, vid } = await stoppedWithTodayLine(t);
    const { inv } = await regInsertAndBill(t, vid, 40, null);
    const due = t.db.prepare('SELECT total_amount FROM invoices WHERE id = ?').get(inv).total_amount;
    const pay = await t.rpc('record_payment', 'kassa', { invoice_id: inv, amount: Number(due), method: 'cash' });
    assert.equal(pay.status, 200, pay.text);
    assert.equal(t.lead(rid).status, 'stopped', 'оплата');
  } finally { t.close(); }
  t = await startCrmApp();
  try {
    const { rid, vid } = await stoppedWithTodayLine(t);
    const x = Number(t.db.prepare("INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total, status) VALUES (?,40,1,1,1,'in_progress')").run(vid).lastInsertRowid);
    crmServiceEvidence(t.db, [x]);
    assert.equal(t.lead(rid).status, 'stopped', 'работа');
  } finally { t.close(); }
  t = await startCrmApp();
  try {
    const rid = addLead(t.db, { status: 'stopped' });
    const e = await t.rpc('ensure_visit', 'reg', { patient_id: 77, date: nowIso(), doctor_id: 10 });
    t.db.prepare("INSERT INTO crm_booking_links (visit_id, request_id, source) VALUES (?, ?, 'match')").run(e.json.data.visit.id, rid);
    await desk(t);
    assert.equal(t.lead(rid).status, 'stopped', 'привязка записи');
  } finally { t.close(); }
});

// R5 — КАКИЕ карточки закрывает стойка (решение контролёра): открытые, которые
// (а) ждут сегодня — строка на сегодня, строка без даты, дата карточки сегодня
// или привязка к этому визиту (любой давности), или (б) двигались в окне
// повторного обращения (updated_at, иначе created_at; 72 ч — windowHours).
// Старые карточки, ждущие не сегодня, остаются как были.
test('R5: стойка закрывает ждущие сегодня и живые в окне; старые и ждущие другого дня не трогает', async () => {
  const t = await startCrmApp();
  try {
    const old = daysAgoIso(10);
    const recall21 = addLead(t.db, { status: 'recall', date: localDay(-21), updated: daysAgoIso(21), name: 'Перезвонить 3 нед.' });
    const new90 = addLead(t.db, { status: 'in_process', updated: daysAgoIso(90), name: 'Новый 90 дн.' });
    const outside = addLead(t.db, { status: 'in_process', updated: daysAgoIso(4), name: 'Новый 4 дн.' });
    const approvedOld = addLead(t.db, { status: 'approved', date: localDay(10), updated: old, name: 'Согласован +10' });
    addLine(t.db, approvedOld, { svc: 40, day: localDay(10) });
    const schedPast = addLead(t.db, { status: 'scheduled', date: localDay(-14), updated: daysAgoIso(14), name: 'Записан -14' });
    addLine(t.db, schedPast, { svc: 30, day: localDay(-14) });
    const fresh = addLead(t.db, { status: 'recall', date: localDay(5), updated: daysAgoIso(2), name: 'Перезвонить 2 дня назад' });
    const lineToday = addLead(t.db, { status: 'recall', updated: old, name: 'Строка сегодня' });
    addLine(t.db, lineToday, { svc: 40, day: TODAY });
    const undated = addLead(t.db, { status: 'in_process', updated: old, name: 'Строка без даты' });
    addLine(t.db, undated, { svc: 40, day: null });
    const datedToday = addLead(t.db, { status: 'recall', date: TODAY, updated: old, name: 'Дата сегодня' });
    // CRM_UNIFY_V1 (задача 6) — ОБНОВЛЕНО НАМЕРЕННО: «Не пришёл» в окне повторного
    // обращения стойка теперь закрывает (пришёл на день позже). Здесь — давний.
    const noShowOld = addLead(t.db, { status: 'no_show', date: localDay(-5), updated: daysAgoIso(5), name: 'Не пришёл -5' });
    const stopped = addLead(t.db, { status: 'stopped', name: 'Отказ' });

    const r = await desk(t);
    assert.equal(r.status, 200, r.text);
    const st = (id) => t.lead(id).status;
    assert.deepEqual([st(recall21), st(new90), st(outside), st(approvedOld), st(schedPast)],
      ['recall', 'in_process', 'in_process', 'approved', 'scheduled'], 'стойка закрыла старую карточку, которая ждёт не сегодня');
    assert.deepEqual([st(fresh), st(lineToday), st(undated), st(datedToday)], ['came', 'came', 'came', 'came'],
      'стойка не закрыла карточку, ждущую сегодня или живую в окне');
    assert.deepEqual([st(noShowOld), st(stopped)], ['no_show', 'stopped']);
  } finally { t.close(); }
});

test('R5: старая карточка, привязанная к этому визиту записью, закрывается стойкой', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { status: 'scheduled', date: localDay(-30), updated: daysAgoIso(30) });
    const e = await t.rpc('ensure_visit', 'reg', { patient_id: 77, date: nowIso(), doctor_id: 10 });
    assert.equal(e.status, 200, e.text);
    t.db.prepare("INSERT OR REPLACE INTO crm_booking_links (visit_id, request_id, source) VALUES (?, ?, 'match')").run(e.json.data.visit.id, rid);
    t.db.prepare('UPDATE crm_requests SET status = ?, scheduled_date = ?, updated_at = ? WHERE id = ?')
      .run('scheduled', localDay(-30), daysAgoIso(30), rid);
    const r = await desk(t);
    assert.equal(r.status, 200, r.text);
    assert.equal(t.lead(rid).status, 'came');
  } finally { t.close(); }
});

// CRM_UNIFY_V1 (задача 6; Р8, Р11) — «Не пришёл» ставит сервер наутро после
// пропущенной записи. Пациент, пришедший на день позже, — тот же приход: стойка
// закрывает сидовую «Не пришёл», которая двигалась в окне повторного обращения
// (тем же правилом deskCloses, что и живые). Давний «Не пришёл» — история.
// CRM_UNIFY_V1 (ревью задач 5–6, I-5) — ОБНОВЛЕНО НАМЕРЕННО: «Не пришёл» проход ставит без
// движения карточки, поэтому опоздание считается и по ПРОПУЩЕННОМУ ДНЮ (дата карточки не
// раньше окна назад): записанный три недели назад и опоздавший на день — «Пришёл».
// Давний — и давно двигался, и давно пропустил.
test('стойка: «Не пришёл» в пределах окна (пришёл на день позже) — «Пришёл»; давний «Не пришёл» — не трогается', async () => {
  for (const [ago, date, want] of [[0, -1, 'came'], [1, -1, 'came'], [21, -1, 'came'], [10, -10, 'no_show']]) {
    const t = await startCrmApp();
    try {
      const rid = addLead(t.db, { status: 'no_show', date: localDay(date), updated: daysAgoIso(ago) });
      const stopped = addLead(t.db, { status: 'stopped', updated: daysAgoIso(ago), name: 'Отказ' });
      const r = await desk(t);
      assert.equal(r.status, 200, r.text);
      assert.equal(t.lead(rid).status, want, `${ago} дн. назад, пропущен день ${date}`);
      assert.equal(t.lead(stopped).status, 'stopped', 'стойка открыла «Отказ»');
      if (want === 'came') {
        assert.equal(t.lead(rid).scheduled_date, localDay(date), 'дата карточки переписана');
        const d = await t.rpc('discard_empty_visit', 'reg', { visit_id: r.json.data.visit.id });
        assert.equal(d.status, 200, d.text);
        assert.equal(t.lead(rid).status, 'no_show', 'удаление пустого визита не вернуло «Не пришёл»');
      }
    } finally { t.close(); }
  }
});

// R5 — путь по телефону на стойке — тем же правилом. Карточка по телефону
// получает только patient_id и ступень: её строки в визит не идут (правило
// денег — общий семейный номер не ставит услуги в чужой счёт).
// CRM_UNIFY_V1 (финальное ревью, A-C1) — две открытые карточки на один номер
// теперь не берутся вовсе (семья на одном номере), поэтому граница стойки
// проверяется по одной карточке на прогон. Имя заявки звонка — номер.
test('R5: по телефону на стойке — та же граница; строки карточки по телефону в визит не идут', async () => {
  let t = await startCrmApp();
  try {
    const phoneOld = addLead(t.db, { patient: null, phone: '909092638', status: 'recall', updated: daysAgoIso(60), name: '909092638' });
    const r = await desk(t);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual([t.lead(phoneOld).status, t.lead(phoneOld).patient_id], ['recall', null],
      'стойка взяла по телефону старую карточку, которая сегодня не ждёт');
  } finally { t.close(); }
  t = await startCrmApp();
  try {
    const phoneToday = addLead(t.db, { patient: null, phone: '909092638', status: 'recall', date: localDay(-60), updated: daysAgoIso(61), name: '909092638' });
    const lt = addLine(t.db, phoneToday, { svc: 40, day: TODAY });
    const r = await desk(t);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual([t.lead(phoneToday).status, t.lead(phoneToday).patient_id], ['came', 77]);
    assert.deepEqual(lineRow(t.db, lt), { status: 'pending', visit_id: null }, 'строка карточки по телефону взяла визит');
    assert.equal(vsOf(t.db, r.json.data.visit.id).length, 0, 'услуга карточки по телефону встала в счёт');
  } finally { t.close(); }
});

// R6 — discard_empty_visit после стойки возвращает то, что сделала стойка:
// строки снова ждут (без визита), ступени — прежние (и «Не пришёл», который
// приход вернул в «Пришёл»). Визит, в который зеркало уже поставило услуги, —
// не пустой, и удалить его этим путём нельзя.
test('R6: удаление пустого визита после стойки возвращает строки и ступени', async () => {
  const t = await startCrmApp((db) => db.prepare("INSERT INTO services (id, name, price, type) VALUES (50,'Аппендэктомия',3000000,'other')").run());
  try {
    const rid = addLead(t.db, { status: 'in_process', date: TODAY });
    const l = addLine(t.db, rid, { svc: 50, day: TODAY });
    const ns = addLead(t.db, { status: 'no_show', date: TODAY, name: 'НП' });
    const l2 = addLine(t.db, ns, { svc: 50, day: TODAY });
    const r = await desk(t);
    assert.equal(r.status, 200, r.text);
    const vid = r.json.data.visit.id;
    assert.deepEqual([t.lead(rid).status, t.lead(ns).status], ['came', 'came']);
    assert.equal(vsOf(t.db, vid).length, 0, 'хирургия встала в запись');
    const d = await t.rpc('discard_empty_visit', 'reg', { visit_id: vid });
    assert.equal(d.status, 200, d.text);
    assert.deepEqual([t.lead(rid).status, t.lead(ns).status], ['in_process', 'no_show'], 'ступени не вернулись');
    assert.deepEqual(lineRow(t.db, l), { status: 'pending', visit_id: null }, 'строка осталась закрытой без визита');
    assert.deepEqual(lineRow(t.db, l2), { status: 'pending', visit_id: null });
  } finally { t.close(); }
});

test('R6: визит, в который стойка привела записанные услуги, этим путём не удаляется', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { status: 'in_process', date: TODAY });
    addLine(t.db, rid, { svc: 40, day: TODAY });
    const r = await desk(t);
    assert.equal(r.status, 200, r.text);
    const d = await t.rpc('discard_empty_visit', 'reg', { visit_id: r.json.data.visit.id });
    assert.equal(d.status, 400, d.text);
    assert.equal(t.lead(rid).status, 'came');
  } finally { t.close(); }
});

// R7 — desk — только true / 'true'; день — только сегодняшний местный.
test('R7: desk — только true или "true"; день — только сегодня по местному времени', async () => {
  for (const val of [true, 'true', 'TRUE', 1, '1', 'yes', {}, [true]]) {
    const t = await startCrmApp();
    try {
      const rid = addLead(t.db, { assigned: 3, date: D });
      addLine(t.db, rid, { svc: 40, day: D });
      const r = await t.rpc('ensure_visit', 'reg', { patient_id: 77, date: nowIso(), doctor_id: 10, desk: val });
      assert.equal(r.status, 200, r.text);
      assert.equal(t.lead(rid).status, (val === true || val === 'true') ? 'came' : 'in_process', JSON.stringify(val));
    } finally { t.close(); }
  }
  for (const [date, want] of [[at(localDay(1), 10), 'in_process'], [at(localDay(-1), 10), 'in_process'], [TODAY, 'came'],
    [at(TODAY, 0, 5), 'came'], [at(TODAY, 23, 55), 'came']]) {
    const t = await startCrmApp();
    try {
      const rid = addLead(t.db, { assigned: 3, date: D });
      addLine(t.db, rid, { svc: 40, day: D });
      const r = await desk(t, 'reg', date);
      assert.equal(r.status, 200, r.text);
      assert.equal(t.lead(rid).status, want, date);
    } finally { t.close(); }
  }
});
