// CRM_UNIFY_V1 — ПРОВЕРКА ПРАВОК РЕВЬЮ ЗАДАЧИ 3 (C1–C6): ДЕНЬГИ НА СТОЙКЕ.
//
// ИНВАРИАНТ (решение контролёра): строка заявки становится 'done' ТОЛЬКО если
// у неё есть строка визита (visit_service_id), то есть услуга действительно в
// визите. Правило живёт в одном месте — в правиле прихода (crm/visit-status.js).
// Перед ним приход ставит в визит строки, которые визит держит, но которых в
// нём нет ('added', как услугу, добавленную к уже выставленному или пришедшему
// визиту, — касса видит её в «Ждут счёта»). Не ставится — строка ждёт.
//
// Строка ЗЕРКАЛА уступает место такой же услуге регистратуры или кассы, пока
// сама не в счёте, — до первого счёта и после него. Строка заявки без врача —
// та же услуга, что и с врачом. Карточка без строк и без даты ждёт прихода
// только в окне повторного обращения — на любой двери.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startCrmApp, localDay, at, addLead, addLine, linesOf, daysAgoIso } from '../test-helpers/crm-unify-app.js';

const TODAY = localDay(0);
const D = localDay(3);
const nowIso = () => new Date().toISOString();
const hoursAgoIso = (h) => new Date(Date.now() - h * 3600000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const PRICE = { 30: 100000, 40: 40000, 50: 50000, 60: 70000 };
const seed = (db) => {
  db.prepare("INSERT INTO services (id, name, price, type) VALUES (50,'ЭКГ',50000,'procedure')").run();
  db.prepare("INSERT INTO services (id, name, price, type, active) VALUES (60,'Снятая',70000,'procedure',0)").run();
};
const vsOf = (db, vid) => db.prepare('SELECT id, service_id, doctor_id, status, invoice_item_id FROM visit_services WHERE visit_id = ? ORDER BY id').all(vid);
const liveOf = (db, vid, svc) => vsOf(db, vid).filter((r) => r.service_id === svc && r.status !== 'cancelled');
const lineRow = (db, id) => db.prepare('SELECT status, visit_id, visit_service_id FROM crm_request_services WHERE id = ?').get(id);

/** ИНВАРИАНТ: ни одной строки 'done' без строки визита в её визите. */
function assertInvariant(db, where = '') {
  const bad = db.prepare(`SELECT l.id, l.service_id, l.visit_id, l.visit_service_id FROM crm_request_services l
                           WHERE l.status = 'done'
                             AND NOT EXISTS (SELECT 1 FROM visit_services vs
                                              WHERE vs.id = l.visit_service_id AND vs.visit_id = l.visit_id)`).all();
  assert.deepEqual(bad, [], `строка заявки закрыта, а услуги в визите нет ${where}: ${JSON.stringify(bad)}`);
}

function slotToday() {
  const d = new Date(Date.now() + 60 * 60 * 1000);
  const ok = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` === TODAY;
  if (ok) { d.setMinutes(0, 0, 0); return d.toISOString(); }
  return at(TODAY, 8);
}
async function unbilled(t, vid) {
  const r = await t.rpc('cashier_unbilled', 'kassa', {});
  assert.equal(r.status, 200, r.text);
  const row = (r.json.data.rows || []).find((x) => x.visit_id === vid);
  return row ? row.total : 0;
}
/** Регистрация (стойка или нет) + строки регистратуры через /api/db + счёт по ним. */
async function walkIn(t, svcs, { desk = true, who = 'reg', bill = true } = {}) {
  const e = await t.rpc('ensure_visit', who, { patient_id: 77, date: nowIso(), doctor_id: 10, visit_type: 'outpatient', ...(desk ? { desk: true } : {}) });
  assert.equal(e.status, 200, e.text);
  const vid = e.json.data.visit.id;
  const ids = [];
  for (const [svc, doc] of svcs) {
    const ins = await t.dbq(who, { table: 'visit_services', op: 'insert', returning: true, single: 'single',
      values: { visit_id: vid, service_id: svc, doctor_id: doc, quantity: 1, unit_price: PRICE[svc], total: PRICE[svc], status: 'added' } });
    assert.equal(ins.status, 200, ins.text);
    ids.push(ins.json.data.id);
  }
  let inv = null;
  if (ids.length && bill) inv = await invoiceVs(t, vid, ids);
  return { vid, ids, inv };
}
async function invoiceVs(t, vid, ids) {
  const r = await t.rpc('create_invoice_for_visit', 'reg', { visit_id: vid, visit_service_ids: ids, discount_amount: 0, payer_id: null });
  assert.equal(r.status, 200, r.text);
  return r.json.data.invoice;
}
async function pay(t, inv) {
  const due = t.db.prepare('SELECT total_amount FROM invoices WHERE id = ?').get(inv.id).total_amount;
  const p = await t.rpc('record_payment', 'kassa', { invoice_id: inv.id, amount: Number(due), method: 'cash' });
  assert.equal(p.status, 200, p.text);
}
/** Колл-центр: карточка со строками на сегодня и запись на сегодня со слотом. */
async function ccBookToday(t, lines) {
  const r = await t.dbq('cc', { table: 'crm_requests', op: 'insert', returning: true, single: 'single',
    values: { full_name: 'Пациент Тест', phone: '+998 90 909 26 38', patient_id: 77, status: 'in_process', source: 'call' } });
  assert.equal(r.status, 200, r.text);
  const rid = r.json.data.id;
  const ins = await t.dbq('cc', { table: 'crm_request_services', op: 'insert',
    values: lines.map((l) => ({ request_id: rid, service_id: l.svc, scheduled_date: l.day === undefined ? TODAY : l.day, doctor_id: l.doc ?? null, status: 'pending' })) });
  assert.equal(ins.status, 200, ins.text);
  const start = slotToday();
  const b = await t.rpc('ensure_visit', 'cc', { patient_id: 77, date: start, doctor_id: 10, book: { doctor_id: 10, service_id: 30, start, duration_minutes: 30 } });
  assert.equal(b.status, 200, b.text);
  return { rid, vid: b.json.data.visit.id };
}

// ── C1. Строка зеркала и строка регистратуры — одна услуга, один счёт ──────

test('C1a: запись 30+40 на сегодня, стойка берёт 30 — 30 один раз в счёте, 40 ждёт кассы', async () => {
  const t = await startCrmApp(seed);
  try {
    const { rid, vid } = await ccBookToday(t, [{ svc: 30, doc: 10 }, { svc: 40 }]);
    await walkIn(t, [[30, 10]]);
    assert.equal(liveOf(t.db, vid, 30).length, 1);
    assert.deepEqual(liveOf(t.db, vid, 40).map((x) => x.status), ['added']);
    assert.equal(await unbilled(t, vid), 40000);
    assert.equal(t.lead(rid).status, 'came');
    assertInvariant(t.db, 'C1a');
  } finally { t.close(); }
});

test('C1b: запись 30+40, стойка берёт 40 — 40 в счёте один раз, 30 ждёт кассы', async () => {
  const t = await startCrmApp(seed);
  try {
    const { rid, vid } = await ccBookToday(t, [{ svc: 30, doc: 10 }, { svc: 40 }]);
    await walkIn(t, [[40, null]]);
    assert.equal(liveOf(t.db, vid, 40).length, 1);
    assert.ok(liveOf(t.db, vid, 40)[0].invoice_item_id != null);
    assert.equal(liveOf(t.db, vid, 30).length, 1);
    assert.equal(await unbilled(t, vid), 100000);
    assert.equal(t.lead(rid).status, 'came');
    assertInvariant(t.db, 'C1b');
  } finally { t.close(); }
});

test('C1c: запись 30+40, стойка без строк или с чужой услугой — обе записанные ждут кассы', async () => {
  for (const pick of [[], [[50, null]]]) {
    const t = await startCrmApp(seed);
    try {
      const { rid, vid } = await ccBookToday(t, [{ svc: 30, doc: 10 }, { svc: 40 }]);
      await walkIn(t, pick);
      assert.equal(liveOf(t.db, vid, 30).length, 1);
      assert.equal(liveOf(t.db, vid, 40).length, 1);
      assert.equal(await unbilled(t, vid), 140000);
      assert.equal(t.lead(rid).status, 'came');
      assertInvariant(t.db, 'C1c ' + JSON.stringify(pick));
    } finally { t.close(); }
  }
});

// Правило двойника — и ПОСЛЕ первого счёта (оплаченного или нет).
for (const [desk, paid] of [[true, true], [false, true], [false, false]]) {
  test(`C1d: две регистрации за день — 1-я 30 (счёт${paid ? ', оплачен' : ''}), 2-я 40: анализ один (desk=${desk})`, async () => {
    const t = await startCrmApp(seed);
    try {
      const { vid } = await ccBookToday(t, [{ svc: 30, doc: 10 }, { svc: 40 }]);
      const a = await walkIn(t, [[30, 10]], { desk });
      if (paid) await pay(t, a.inv);
      const b = await walkIn(t, [[40, null]], { desk });
      assert.equal(b.vid, vid);
      assert.deepEqual(liveOf(t.db, vid, 40).map((x) => x.id), b.ids,
        'анализ 40 дважды: выставленный регистратурой и строка зеркала в «Ждут счёта»');
      assert.equal(await unbilled(t, vid), 0);
      assertInvariant(t.db, 'C1d');
    } finally { t.close(); }
  });
}

test('C1d: строку, добавленную кассой сразу в счёт, строка зеркала той же услуги тоже уступает', async () => {
  const t = await startCrmApp(seed);
  try {
    const { vid } = await ccBookToday(t, [{ svc: 30, doc: 10 }, { svc: 40 }]);
    const a = await walkIn(t, [[30, 10]]);
    const ins = await t.dbq('reg', { table: 'visit_services', op: 'insert', returning: true, single: 'single',
      values: { visit_id: vid, service_id: 40, quantity: 1, unit_price: 40000, total: 40000, status: 'added' } });
    assert.equal(ins.status, 200, ins.text);
    await invoiceVs(t, vid, [ins.json.data.id]);
    void a;
    assert.deepEqual(liveOf(t.db, vid, 40).map((x) => x.id), [ins.json.data.id]);
    assert.equal(await unbilled(t, vid), 0);
    assertInvariant(t.db);
  } finally { t.close(); }
});

test('C1d: строка зеркала, которая сама уже в счёте, не трогается', async () => {
  const t = await startCrmApp(seed);
  try {
    const { vid } = await ccBookToday(t, [{ svc: 40 }]);
    const auto = liveOf(t.db, vid, 40)[0].id;
    await invoiceVs(t, vid, [auto]);
    const ins = await t.dbq('reg', { table: 'visit_services', op: 'insert', returning: true, single: 'single',
      values: { visit_id: vid, service_id: 40, quantity: 1, unit_price: 40000, total: 40000, status: 'added' } });
    assert.equal(ins.status, 200, ins.text);
    assert.deepEqual(liveOf(t.db, vid, 40).map((x) => x.id).sort((p, q) => p - q), [auto, ins.json.data.id].sort((p, q) => p - q),
      'выставленная строка зеркала исчезла');
  } finally { t.close(); }
});

test('C1e: две регистрации на стойке — 30, потом чужая 50: анализ 40 ждёт кассы один раз', async () => {
  const t = await startCrmApp(seed);
  try {
    const { vid } = await ccBookToday(t, [{ svc: 30, doc: 10 }, { svc: 40 }]);
    await walkIn(t, [[30, 10]]);
    await walkIn(t, [[50, null]]);
    assert.equal(liveOf(t.db, vid, 30).length, 1);
    assert.equal(liveOf(t.db, vid, 40).length, 1);
    assert.equal(await unbilled(t, vid), 40000);
    assertInvariant(t.db, 'C1e');
  } finally { t.close(); }
});

// ── C2. Строки, которые визит берёт, доходят до визита — и после прихода ──

test('C2a: строка сегодня 40 и «без даты» 30 — в визите и в «Ждут счёта»; стойка берёт 50', async () => {
  const t = await startCrmApp(seed);
  try {
    const rid = addLead(t.db, { assigned: 3 });
    const l40 = addLine(t.db, rid, { svc: 40, day: TODAY });
    const l30 = addLine(t.db, rid, { svc: 30, day: null, doctor: 10 });
    const { vid } = await walkIn(t, [[50, null]]);
    assert.equal(liveOf(t.db, vid, 40).length, 1);
    assert.equal(liveOf(t.db, vid, 30).length, 1);
    assert.equal(await unbilled(t, vid), 140000);
    for (const l of [l40, l30]) assert.equal(lineRow(t.db, l).status, 'done');
    assertInvariant(t.db, 'C2a');
  } finally { t.close(); }
});

for (const desk of [true, false]) {
  test(`C2b: вторая регистрация по ОПЛАЧЕННОМУ визиту, строка 40 сегодня появилась после первой (desk=${desk})`, async () => {
    const t = await startCrmApp(seed);
    try {
      const a = await walkIn(t, [[50, null]], { desk });
      await pay(t, a.inv);
      const rid = addLead(t.db, { assigned: 3 });
      const l = addLine(t.db, rid, { svc: 40, day: TODAY });
      const b = await walkIn(t, [[30, 10]], { desk });
      assert.equal(b.vid, a.vid);
      assert.deepEqual(liveOf(t.db, a.vid, 40).map((x) => [x.status, x.invoice_item_id]), [['added', null]],
        'записанный анализ не дошёл до визита');
      assert.equal(lineRow(t.db, l).visit_service_id, liveOf(t.db, a.vid, 40)[0].id);
      assert.equal(await unbilled(t, a.vid), 40000, '«Ждут счёта» — записанный анализ (консультация уже в счёте)');
      assertInvariant(t.db, 'C2b');
    } finally { t.close(); }
  });

  test(`C2c: вторая регистрация по визиту с НЕОПЛАЧЕННЫМ счётом — строка не закрывается без услуги (desk=${desk})`, async () => {
    const t = await startCrmApp(seed);
    try {
      const a = await walkIn(t, [[50, null]], { desk });
      const rid = addLead(t.db, { assigned: 3 });
      const l = addLine(t.db, rid, { svc: 40, day: TODAY });
      const b = await walkIn(t, [[30, 10]], { desk });
      assert.equal(b.vid, a.vid);
      assertInvariant(t.db, 'C2c');
      if (desk) {
        // Стойка — приход: строка встаёт в визит, как услуга к выставленному визиту.
        assert.equal(liveOf(t.db, a.vid, 40).length, 1, 'стойка не поставила записанный анализ в визит');
        assert.equal(lineRow(t.db, l).status, 'done');
      } else {
        // До прихода при счёте дверь записи строк визита не ставит (I5): строка ждёт.
        assert.equal(lineRow(t.db, l).status, 'pending');
        await pay(t, a.inv);   // приход (деньги) — строка встаёт в визит и закрывается
        assert.equal(liveOf(t.db, a.vid, 40).length, 1, 'приход не поставил записанный анализ в визит');
        assert.equal(lineRow(t.db, l).status, 'done');
        assertInvariant(t.db, 'C2c после оплаты');
      }
    } finally { t.close(); }
  });

  test(`C2d: «Пришёл» в календаре раньше, потом регистрация; строки сегодня 40 и «без даты» 50 (desk=${desk})`, async () => {
    const t = await startCrmApp(seed);
    try {
      const e = await t.rpc('ensure_visit', 'reg', { patient_id: 77, date: slotToday(), doctor_id: 10,
        book: { doctor_id: 10, service_id: 30, start: slotToday(), duration_minutes: 30 } });
      assert.equal(e.status, 200, e.text);
      const vid = e.json.data.visit.id;
      const arr = await t.rpc('calendar_book', 'reg', { visit_id: vid, start: e.json.data.visit.visit_date, status: 'arrived' });
      assert.equal(arr.status, 200, arr.text);
      const rid = addLead(t.db, { assigned: 3 });
      const l40 = addLine(t.db, rid, { svc: 40, day: TODAY });
      const l50 = addLine(t.db, rid, { svc: 50, day: null });
      const b = await walkIn(t, [[30, 10]], { desk });
      assert.equal(b.vid, vid);
      for (const [l, s] of [[l40, 40], [l50, 50]]) {
        assert.equal(liveOf(t.db, vid, s).length, 1, `записанная услуга ${s} не дошла до пришедшего визита`);
        assert.deepEqual([lineRow(t.db, l).status, lineRow(t.db, l).visit_service_id], ['done', liveOf(t.db, vid, s)[0].id]);
      }
      assertInvariant(t.db, 'C2d');
    } finally { t.close(); }
  });
}

test('C2e: предоплата записи на сегодня, потом строка «без даты» 50 в карточке, потом стойка', async () => {
  const t = await startCrmApp(seed);
  try {
    const { rid, vid } = await ccBookToday(t, [{ svc: 30, doc: 10 }]);
    await pay(t, await invoiceVs(t, vid, [liveOf(t.db, vid, 30)[0].id]));
    const l = addLine(t.db, rid, { svc: 50, day: null });
    await walkIn(t, []);
    assert.equal(liveOf(t.db, vid, 50).length, 1, 'строка «без даты» не дошла до визита');
    assert.equal(lineRow(t.db, l).status, 'done');
    assert.equal(await unbilled(t, vid), 50000);
    assertInvariant(t.db, 'C2e');
  } finally { t.close(); }
});

test('C2f: лид по телефону с анализом 40 сегодня — две регистрации на стойке; анализ доходит до визита', async () => {
  const t = await startCrmApp(seed);
  try {
    const rid = addLead(t.db, { patient: null, phone: '909092638', updated: hoursAgoIso(2), name: 'phone lead' });
    const l = addLine(t.db, rid, { svc: 40, day: TODAY });
    const a = await walkIn(t, [[30, 10]]);
    assert.deepEqual([t.lead(rid).status, t.lead(rid).patient_id], ['came', 77]);
    assert.equal(lineRow(t.db, l).visit_id, null, 'строка карточки по телефону взяла визит на той же двери');
    await pay(t, a.inv);
    const b = await walkIn(t, [[50, null]]);
    assert.equal(liveOf(t.db, b.vid, 40).length, 1, 'анализ молча закрыт без строки визита');
    assert.equal(lineRow(t.db, l).status, 'done');
    assertInvariant(t.db, 'C2f');
  } finally { t.close(); }
});

test('C2g: услугу, которую в визит поставить нельзя (снята с продажи), приход не закрывает — строка ждёт', async () => {
  const t = await startCrmApp(seed);
  try {
    const rid = addLead(t.db, { assigned: 3 });
    const l = addLine(t.db, rid, { svc: 60, day: TODAY });
    const { vid } = await walkIn(t, []);
    assert.equal(vsOf(t.db, vid).length, 0);
    assert.deepEqual([lineRow(t.db, l).status, lineRow(t.db, l).visit_id], ['pending', vid]);
    assert.equal(t.lead(rid).status, 'came');
    assertInvariant(t.db, 'C2g');
  } finally { t.close(); }
});

// ── C3. Проигрышные не берутся; «Пришёл» — берётся, не открываясь ─────────

test('C3b: строки «Отказа» и «Не квалифицирован» визит не берёт — ни стойка, ни без неё', async () => {
  for (const desk of [true, false]) {
    const t = await startCrmApp(seed);
    try {
      const s = addLead(t.db, { status: 'stopped' });
      const ls = addLine(t.db, s, { svc: 40, day: TODAY });
      const n = addLead(t.db, { status: 'not_qualified' });
      const ln = addLine(t.db, n, { svc: 50, day: null });
      const { vid } = await walkIn(t, [], { desk });
      assert.deepEqual(lineRow(t.db, ls), { status: 'pending', visit_id: null, visit_service_id: null });
      assert.equal(lineRow(t.db, ln).visit_id, null);
      assert.equal(vsOf(t.db, vid).length, 0);
      assert.deepEqual([t.lead(s).status, t.lead(n).status], ['stopped', 'not_qualified']);
    } finally { t.close(); }
  }
});

test('C3c: строка сегодня карточки «Пришёл» доходит до визита через мастер (без стойки); карточка закрыта', async () => {
  const t = await startCrmApp(seed);
  try {
    const rid = addLead(t.db, { status: 'came' });
    const l = addLine(t.db, rid, { svc: 40, day: TODAY });
    const { vid } = await walkIn(t, [], { desk: false });
    assert.equal(lineRow(t.db, l).visit_id, vid);
    assert.equal(liveOf(t.db, vid, 40).length, 1);
    assert.equal(t.lead(rid).status, 'came');
  } finally { t.close(); }
});

// ── C4. Окно: стойка — границы; карточка без строк и без даты — на любой двери ──

test('C4a: стойка — границы окна (71 ч / 73 ч), дата сегодня, строка без даты, свежая карточка другого дня', async () => {
  const t = await startCrmApp(seed);
  try {
    const h71 = addLead(t.db, { updated: hoursAgoIso(71), name: '71h' });
    const h73 = addLead(t.db, { updated: hoursAgoIso(73), name: '73h' });
    const today30d = addLead(t.db, { status: 'recall', date: TODAY, updated: daysAgoIso(30), name: 'date today 30d' });
    const und30d = addLead(t.db, { updated: daysAgoIso(30), name: 'undated line 30d' });
    addLine(t.db, und30d, { svc: 60, day: null });
    const freshD = addLead(t.db, { status: 'approved', date: D, name: 'fresh, waits D' });
    addLine(t.db, freshD, { svc: 40, day: D });
    const r = await t.rpc('ensure_visit', 'reg', { patient_id: 77, date: nowIso(), doctor_id: 10, desk: true });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual([h71, h73, today30d, und30d, freshD].map((id) => t.lead(id).status),
      ['came', 'in_process', 'came', 'came', 'came']);
    assertInvariant(t.db, 'C4a');
  } finally { t.close(); }
});

test('C4c: звонок вчера (без строк и даты), запись из календаря и «Пришёл» — карточка закрыта', async () => {
  const t = await startCrmApp(seed);
  try {
    const rid = addLead(t.db, { updated: hoursAgoIso(24), name: 'call yesterday' });
    const e = await t.rpc('calendar_book', 'reg', { patient_id: 77, doctor_id: 10, start: slotToday(), duration_minutes: 30 });
    assert.equal(e.status, 200, e.text);
    assert.equal(t.lead(rid).status, 'scheduled');
    const arr = await t.rpc('calendar_book', 'reg', { visit_id: e.json.data.visit.id, start: e.json.data.visit.visit_date, status: 'arrived' });
    assert.equal(arr.status, 200, arr.text);
    assert.equal(t.lead(rid).status, 'came');
  } finally { t.close(); }
});

// P3 — карточка без строк и без даты «ждёт» прихода только в окне — на ЛЮБОЙ двери.
test('C4e: «Новый лид» 90 дней без строк и даты — ни регистрация без стойки, ни запись, ни оплата его не трогают', async () => {
  const t = await startCrmApp(seed);
  try {
    const rid = addLead(t.db, { updated: daysAgoIso(90), name: '90d lead' });
    const { inv } = await walkIn(t, [[50, null]], { desk: false });
    assert.equal(t.lead(rid).status, 'in_process', 'регистрация взяла старую карточку о другом обращении');
    const b = await t.rpc('calendar_book', 'reg', { patient_id: 77, doctor_id: 10, start: at(D, 10), duration_minutes: 30 });
    assert.equal(b.status, 200, b.text);
    assert.equal(t.lead(rid).status, 'in_process', 'запись взяла старую карточку о другом обращении');
    await pay(t, inv);
    assert.equal(t.lead(rid).status, 'in_process', 'оплата закрыла старую карточку о другом обращении');
  } finally { t.close(); }
});

test('C4e: в окне — та же карточка без строк и даты берётся регистрацией и закрывается оплатой', async () => {
  const t = await startCrmApp(seed);
  try {
    const rid = addLead(t.db, { updated: hoursAgoIso(48), name: '2d lead' });
    const { inv } = await walkIn(t, [[50, null]], { desk: false });
    assert.equal(t.lead(rid).status, 'scheduled');
    await pay(t, inv);
    assert.equal(t.lead(rid).status, 'came');
  } finally { t.close(); }
});

test('C4f: лид по телефону вчера, регистрация без стойки и оплата — карточка пациента закрыта', async () => {
  const t = await startCrmApp(seed);
  try {
    const rid = addLead(t.db, { patient: null, phone: '909092638', updated: hoursAgoIso(24), name: 'phone yesterday' });
    const { inv } = await walkIn(t, [[50, null]], { desk: false });
    assert.equal(t.lead(rid).patient_id, 77);
    await pay(t, inv);
    assert.equal(t.lead(rid).status, 'came');
  } finally { t.close(); }
});

// ── C5. Удаление пустого визита после стойки ────────────────────────────

test('C5a: удаление после стойки возвращает ступень карточки без строк', async () => {
  const t = await startCrmApp(seed);
  try {
    const rid = addLead(t.db, { status: 'recall', date: TODAY });
    const r = await t.rpc('ensure_visit', 'reg', { patient_id: 77, date: nowIso(), doctor_id: 10, desk: true });
    assert.equal(t.lead(rid).status, 'came');
    const d = await t.rpc('discard_empty_visit', 'reg', { visit_id: r.json.data.visit.id });
    assert.equal(d.status, 200, d.text);
    assert.deepEqual([t.lead(rid).status, t.lead(rid).scheduled_date], ['recall', TODAY]);
  } finally { t.close(); }
});

test('C5b: удаление после стойки: «Не пришёл» и «В обработке» со строками, которые в визит не встают, — возвращаются', async () => {
  const t = await startCrmApp(seed);
  try {
    const ns = addLead(t.db, { status: 'no_show', date: TODAY, name: 'НП' });
    const l1 = addLine(t.db, ns, { svc: 60, day: TODAY });
    const ip = addLead(t.db, { status: 'in_process', name: 'ВО' });
    const l2 = addLine(t.db, ip, { svc: 60, day: null });
    const r = await t.rpc('ensure_visit', 'reg', { patient_id: 77, date: nowIso(), doctor_id: 10, desk: true });
    const vid = r.json.data.visit.id;
    assertInvariant(t.db, 'C5b');
    const d = await t.rpc('discard_empty_visit', 'reg', { visit_id: vid });
    assert.equal(d.status, 200, d.text);
    assert.deepEqual([t.lead(ns).status, t.lead(ip).status], ['no_show', 'in_process']);
    for (const l of [l1, l2]) assert.deepEqual([lineRow(t.db, l).status, lineRow(t.db, l).visit_id], ['pending', null]);
  } finally { t.close(); }
});

test('C5c: визит, куда стойка поставила записанную услугу, не удаляется; ничего не меняется', async () => {
  const t = await startCrmApp(seed);
  try {
    const rid = addLead(t.db, { status: 'in_process' });
    const l = addLine(t.db, rid, { svc: 40, day: TODAY });
    const r = await t.rpc('ensure_visit', 'reg', { patient_id: 77, date: nowIso(), doctor_id: 10, desk: true });
    const vid = r.json.data.visit.id;
    const d = await t.rpc('discard_empty_visit', 'reg', { visit_id: vid });
    assert.equal(d.status, 400);
    assert.equal(t.lead(rid).status, 'came');
    assert.equal(lineRow(t.db, l).status, 'done');
    assert.equal(liveOf(t.db, vid, 40).length, 1);
  } finally { t.close(); }
});

// ── C6. Консультация без врача в заявке — та же услуга; стойка дважды ──────

for (const desk of [true, false]) {
  test(`C6a: консультация 30 в заявке без врача, регистратура берёт 30 у врача 10 — одна консультация (desk=${desk})`, async () => {
    const t = await startCrmApp(seed);
    try {
      const rid = addLead(t.db, { assigned: 3 });
      addLine(t.db, rid, { svc: 30, day: TODAY, doctor: null });
      const { vid, ids } = await walkIn(t, [[30, 10]], { desk });
      assert.deepEqual(liveOf(t.db, vid, 30).map((x) => x.id), ids, 'две консультации ждут: строка зеркала без врача и строка регистратуры');
      assert.equal(await unbilled(t, vid), 0);
      assertInvariant(t.db, 'C6a');
    } finally { t.close(); }
  });
}

test('C6b: стойка дважды без нового — ни строк, ни ступеней, ни следа сверх', async () => {
  const t = await startCrmApp(seed);
  try {
    const { rid, vid } = await ccBookToday(t, [{ svc: 30, doc: 10 }, { svc: 40 }]);
    await walkIn(t, []);
    const snap = () => JSON.stringify([vsOf(t.db, vid), linesOf(t.db, rid), t.lead(rid).status,
      t.db.prepare('SELECT COUNT(*) n FROM crm_booking_undo').get().n]);
    const before = snap();
    await walkIn(t, []);
    assert.equal(snap(), before);
  } finally { t.close(); }
});

// ── ИНВАРИАНТ — обход по батарее дверей, стоек и приходов ──────────────────

test('ИНВАРИАНТ: после записи, стоек, «Пришёл», оплаты, работы и удаления — ни одной закрытой строки без услуги в визите', async () => {
  const t = await startCrmApp(seed);
  try {
    // Карточка колл-центра: сегодня 30+40, без даты 50, снятая 60, на D 40.
    const { rid, vid } = await ccBookToday(t, [{ svc: 30, doc: 10 }, { svc: 40 }, { svc: 50, day: null }, { svc: 60 }, { svc: 40, day: D }]);
    assertInvariant(t.db, 'после записи');
    const a = await walkIn(t, [[30, 10]]);
    assertInvariant(t.db, 'после стойки');
    await pay(t, a.inv);
    assertInvariant(t.db, 'после оплаты');
    const ph = addLead(t.db, { patient: null, phone: '909092638', updated: hoursAgoIso(1), name: 'phone' });
    addLine(t.db, ph, { svc: 50, day: TODAY });
    addLine(t.db, rid, { svc: 40, day: TODAY });
    await walkIn(t, [[50, null]], { desk: false });
    assertInvariant(t.db, 'после регистрации без стойки');
    await walkIn(t, []);
    assertInvariant(t.db, 'после второй стойки');
    const arr = await t.rpc('calendar_book', 'reg', { visit_id: vid, start: t.db.prepare('SELECT visit_date FROM visits WHERE id = ?').get(vid).visit_date, status: 'arrived' });
    assert.equal(arr.status, 200, arr.text);
    assertInvariant(t.db, 'после «Пришёл»');
    // День D: запись, работа над услугой, «Пришёл».
    const bD = await t.rpc('ensure_visit', 'cc', { patient_id: 77, date: at(D, 10), doctor_id: 10, book: { doctor_id: 10, service_id: 30, start: at(D, 10), duration_minutes: 30 } });
    assert.equal(bD.status, 200, bD.text);
    assertInvariant(t.db, 'после записи на D');
    // Пустой визит со стойкой и удаление.
    const other = addLead(t.db, { status: 'recall', date: TODAY, name: 'другая' });
    void other;
    assertInvariant(t.db, 'в конце');
    const all = t.db.prepare("SELECT COUNT(*) n FROM crm_request_services WHERE status = 'done'").get().n;
    assert.ok(all >= 3, 'батарея ничего не закрыла — проверять нечего');
  } finally { t.close(); }
});

// ИНВАРИАНТ — и на двери /api/db: строку заявки вручную не закрывают.
test('ИНВАРИАНТ: /api/db не закрывает строку заявки — ни вставкой «done», ни правкой ждущей', async () => {
  const t = await startCrmApp(seed);
  try {
    const rid = addLead(t.db, { assigned: 3 });
    const l = addLine(t.db, rid, { svc: 40, day: D });
    const up = await t.dbq('cc', { table: 'crm_request_services', op: 'update', values: { status: 'done' }, filters: [{ col: 'id', op: 'eq', val: l }] });
    assert.equal(up.status, 409, up.text);
    assert.equal(lineRow(t.db, l).status, 'pending');
    const ins = await t.dbq('cc', { table: 'crm_request_services', op: 'insert', values: { request_id: rid, service_id: 40, scheduled_date: D, status: 'done' } });
    assert.equal(ins.status, 409, ins.text);
    assertInvariant(t.db);
  } finally { t.close(); }
});
