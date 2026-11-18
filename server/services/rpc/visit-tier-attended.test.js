// VISIT_TIER_ATTENDED_V1 (3.25.0, правило владельца) — ЦЕНА «ВТОРОГО» И
// «ПОВТОРНОГО» ВИЗИТА — ТОЛЬКО ПОСЛЕ ВИЗИТА, НА КОТОРЫЙ ПАЦИЕНТ ПРИШЁЛ И ЗА
// КОТОРЫЙ ВЫСТАВЛЕН СЧЁТ.
//
// Было: две записи колл-центра одной услуги (через день и через три) — вторая
// получала ярус «второй визит» (бывает и 0 сум), хотя первого визита не было;
// касса брала записанный ярус, и отмена / «Не пришёл» первой записи его не
// пересчитывали (расследование: пробы T1, T3).
//
// Правило (server/services/rpc/service-price-quote.js): прошлая строка той же
// услуги считается, только если её визит не отменён и не «Не пришёл», день
// визита — не позже сегодняшнего и не позже дня этой строки, сама строка — в
// живом счёте (не 'void' / 'refunded') и деньги за неё не возвращены. Тот же
// день — по окну услуги («со дня» пусто — с 1-го дня; 0 — и тот же день).
// Касса решает ярус невыставленной строки заново в миг счёта (billing.js) и
// пишет его в строку; выставленные строки не трогаются никогда.
//
// Даты — только сдвигами от сегодняшнего местного дня (часы визитов 8–15); правило
// часов не сравнивает — только местные дни, — так что время запуска теста не важно.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startCrmApp, localDay, at } from '../../test-helpers/crm-unify-app.js';
import { createInvoiceForVisit, recordPayment, refundInvoiceLine } from './billing.js';
import { openCashShift, voidInvoice, cashierUnbilled } from './cashier.js';
import { quoteServicePrices } from './service-price-quote.js';

const KASSA = { id: 9, role: 'cashier', full_name: 'Кассир' };
const REG = { id: 2, role: 'registrar', full_name: 'Регистратура' };
const PRICE = 100000, SECOND = 60000, REPEAT = 30000;

// Услуга 30 (консультация терапевта, 100 000): второй визит 60 000 на 1–6 день,
// повторный 30 000 на 1–10 день. Услуга 31: второй визит 50 000 с 0-го по 6-й
// день — окно, которое считает и визит того же дня.
function seed(db) {
  db.prepare(`UPDATE services SET price_secondary = ?, secondary_days_from = 1, secondary_days_to = 6,
                                  price_repeat = ?, repeat_days_from = 1, repeat_days_to = 10 WHERE id = 30`).run(SECOND, REPEAT);
  db.prepare(`INSERT INTO services (id, name, price, type, requires_doctor, price_secondary, secondary_days_from, secondary_days_to)
              VALUES (31, 'Перевязка', 100000, 'procedure', 0, 50000, 0, 6)`).run();
}

const lineOf = (db, id) => db.prepare('SELECT id, visit_id, unit_price, total, price_tier, invoice_item_id FROM visit_services WHERE id = ?').get(id);
const linesOfVisit = (db, vid) => db.prepare('SELECT id, unit_price, price_tier, invoice_item_id FROM visit_services WHERE visit_id = ? ORDER BY id').all(vid);
const itemOf = (db, vsId) => db.prepare('SELECT ii.* FROM invoice_items ii JOIN visit_services vs ON vs.invoice_item_id = ii.id WHERE vs.id = ?').get(vsId);

// Визит пациента 77 на местный день `offset` (10:00) с одной строкой услуги —
// напрямую в базу; bill — выставить его кассой (как будто пациент пришёл).
function visitWithLine(t, offset, { serviceId = 30, status = 'arrived', tier = 'primary', bill = false, hour = 10 } = {}) {
  const vid = Number(t.db.prepare("INSERT INTO visits (patient_id, doctor_id, visit_date, status) VALUES (77, 10, ?, ?)")
    .run(at(localDay(offset), hour), status).lastInsertRowid);
  const vs = Number(t.db.prepare(`INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status, price_tier)
                                  VALUES (?, ?, 10, 1, ?, ?, 'added', ?)`).run(vid, serviceId, PRICE, PRICE, tier).lastInsertRowid);
  if (bill) createInvoiceForVisit(t.db, { visit_id: vid, visit_service_ids: [vs] }, KASSA);
  return { vid, vs };
}

// Запись колл-центра на день `offset`: слот календаря + строка услуги 30 (карточка CRM).
async function ccBooking(t, offset) {
  const b = await t.rpc('calendar_book', 'cc', { patient_id: 77, doctor_id: 10, start: at(localDay(offset), 10), duration_minutes: 30 });
  assert.equal(b.status, 200, b.text);
  const vid = b.json.data.visit.id;
  const add = await t.rpc('booking_lines_add', 'cc', { visit_id: vid, patient_id: 77, lines: [{ service_id: 30, doctor_id: 10 }] });
  assert.equal(add.status, 200, add.text);
  const lines = linesOfVisit(t.db, vid);
  assert.equal(lines.length, 1);
  return { vid, vs: lines[0].id };
}

// «Сегодня — день второй записи»: визиты сдвигаются назад на `shift` дней (часы
// не трогаем), как будто прошло время.
const shiftBack = (db, vid, shift) => db.prepare("UPDATE visits SET visit_date = strftime('%Y-%m-%dT%H:%M:%SZ', visit_date, ?) WHERE id = ?")
  .run(`-${shift} days`, vid);

// ─── Сценарий владельца ─────────────────────────────────────────────────────

test('две записи колл-центра: вторая записана по обычной цене — первой ещё не было', async () => {
  const t = await startCrmApp(seed);
  try {
    const first = await ccBooking(t, 1);
    const second = await ccBooking(t, 3);
    assert.deepEqual([lineOf(t.db, first.vs).price_tier, lineOf(t.db, first.vs).unit_price], ['primary', PRICE]);
    assert.deepEqual([lineOf(t.db, second.vs).price_tier, lineOf(t.db, second.vs).unit_price], ['primary', PRICE],
      'будущая запись — не прошлый визит');
    const q = await t.rpc('service_price_quote', 'cc', { patient_id: 77, service_ids: [30], date: localDay(3) });
    assert.equal(q.status, 200, q.text);
    assert.equal(q.json.data.quotes[30].tier, 'primary');
    assert.equal(q.json.data.quotes[30].price, PRICE);
  } finally { t.close(); }
});

for (const fate of ['cancelled', 'no_show', 'never_came', 'still_future']) {
  test(`сценарий владельца (${fate}): первая запись не состоялась — вторая выставляется по обычной цене`, async () => {
    const t = await startCrmApp(seed);
    try {
      const first = await ccBooking(t, 1);
      const second = await ccBooking(t, 3);
      // Строка второй записи — как её записали до 3.25.0 (ярус от будущей
      // записи): касса обязана решить ярус заново, а не верить записанному.
      t.db.prepare('UPDATE visit_services SET price_tier = ?, unit_price = ?, total = ? WHERE id = ?').run('secondary', SECOND, SECOND, second.vs);
      if (fate === 'still_future') {
        // пациент пришёл на вторую запись сегодня, первая (завтра) ещё впереди
        t.db.prepare('UPDATE visits SET visit_date = ? WHERE id = ?').run(at(localDay(0), 10), second.vid);
      } else {
        // прошло три дня: первая запись была позавчера, вторая — сегодня
        shiftBack(t.db, first.vid, 3);
        shiftBack(t.db, second.vid, 3);
        if (fate !== 'never_came') t.db.prepare('UPDATE visits SET status = ? WHERE id = ?').run(fate, first.vid);
      }
      const r = await t.rpc('create_invoice_for_visit', 'kassa', { visit_id: second.vid, visit_service_ids: [second.vs] });
      assert.equal(r.status, 200, r.text);
      const inv = t.db.prepare('SELECT subtotal, discount_amount, total_amount FROM invoices WHERE id = ?').get(r.json.data.invoice.id);
      assert.deepEqual(inv, { subtotal: PRICE, discount_amount: 0, total_amount: PRICE });
      const l = lineOf(t.db, second.vs);
      assert.equal(l.price_tier, 'primary', 'ярус в строке исправлен при счёте');
      assert.equal(l.unit_price, PRICE);
      assert.equal(itemOf(t.db, second.vs).unit_price, PRICE);
    } finally { t.close(); }
  });
}

// ─── Пришёл и выставлен — ярусы работают ────────────────────────────────────

test('первый визит был и выставлен: второй — цена второго визита в окне, третий — повторного, вне окна — обычная', async () => {
  const t = await startCrmApp(seed);
  try {
    visitWithLine(t, -3, { bill: true });
    // смета регистратуры на сегодня — второй визит
    let q = quoteServicePrices(t.db, { patient_id: 77, service_ids: [30], date: localDay(0) }).quotes[30];
    assert.deepEqual([q.tier, q.price, q.days_since], ['secondary', SECOND, 3]);
    const second = visitWithLine(t, -1, { tier: 'primary' });   // записано «первым» — касса поправит
    createInvoiceForVisit(t.db, { visit_id: second.vid, visit_service_ids: [second.vs] }, KASSA);
    assert.deepEqual([lineOf(t.db, second.vs).price_tier, itemOf(t.db, second.vs).unit_price], ['secondary', SECOND]);
    // третий — повторный (прошлый был вторым), 1 день после второго
    const third = visitWithLine(t, 0);
    q = quoteServicePrices(t.db, { patient_id: 77, service_ids: [30], visit_id: third.vid, date: localDay(0) }).quotes[30];
    assert.deepEqual([q.tier, q.price], ['repeat', REPEAT]);
    createInvoiceForVisit(t.db, { visit_id: third.vid, visit_service_ids: [third.vs] }, KASSA);
    assert.deepEqual([lineOf(t.db, third.vs).price_tier, itemOf(t.db, third.vs).unit_price], ['repeat', REPEAT]);
  } finally { t.close(); }
});

test('окно прошло: выставленный визит 20 дней назад — снова обычная цена', async () => {
  const t = await startCrmApp(seed);
  try {
    visitWithLine(t, -20, { bill: true });
    const now = visitWithLine(t, 0, { tier: 'secondary' });
    createInvoiceForVisit(t.db, { visit_id: now.vid, visit_service_ids: [now.vs] }, KASSA);
    assert.deepEqual([lineOf(t.db, now.vs).price_tier, itemOf(t.db, now.vs).unit_price], ['primary', PRICE]);
  } finally { t.close(); }
});

test('прошлый визит был, но счёта не было — не в счёт; счёт отменён — тоже', async () => {
  const t = await startCrmApp(seed);
  try {
    const past = visitWithLine(t, -2);   // пришёл, но не выставлен
    let q = quoteServicePrices(t.db, { patient_id: 77, service_ids: [30], date: localDay(0) }).quotes[30];
    assert.equal(q.tier, 'primary');
    const out = createInvoiceForVisit(t.db, { visit_id: past.vid, visit_service_ids: [past.vs] }, KASSA);
    q = quoteServicePrices(t.db, { patient_id: 77, service_ids: [30], date: localDay(0) }).quotes[30];
    assert.equal(q.tier, 'secondary', 'выставлен — прошлый визит');
    voidInvoice(t.db, { invoice_id: out.invoice.id, keep_services: true }, KASSA);
    q = quoteServicePrices(t.db, { patient_id: 77, service_ids: [30], date: localDay(0) }).quotes[30];
    assert.equal(q.tier, 'primary', 'счёт отменён — прошлого визита нет');
  } finally { t.close(); }
});

test('за первый визит вернули деньги (возврат строки) — второй по обычной цене', async () => {
  const t = await startCrmApp(seed);
  try {
    openCashShift(t.db, { opening_float: 0 }, KASSA);
    const past = visitWithLine(t, -2);
    t.db.prepare("UPDATE visit_services SET status = 'completed' WHERE id = ?").run(past.vs);   // работа сделана — строка остаётся в визите
    const out = createInvoiceForVisit(t.db, { visit_id: past.vid, visit_service_ids: [past.vs] }, KASSA);
    recordPayment(t.db, { invoice_id: out.invoice.id, amount: PRICE, method: 'cash' }, KASSA);
    assert.equal(quoteServicePrices(t.db, { patient_id: 77, service_ids: [30], date: localDay(0) }).quotes[30].tier, 'secondary');
    refundInvoiceLine(t.db, { invoice_item_id: itemOf(t.db, past.vs).id }, KASSA);
    assert.ok(lineOf(t.db, past.vs), 'строка осталась в визите невыставленной');
    const now = visitWithLine(t, 0, { tier: 'secondary' });
    createInvoiceForVisit(t.db, { visit_id: now.vid, visit_service_ids: [now.vs] }, KASSA);
    assert.deepEqual([lineOf(t.db, now.vs).price_tier, itemOf(t.db, now.vs).unit_price], ['primary', PRICE]);
  } finally { t.close(); }
});

test('выставленная, но будущая запись (предоплата) — не прошлый визит', async () => {
  const t = await startCrmApp(seed);
  try {
    visitWithLine(t, 2, { status: 'scheduled', bill: true });   // оплачено вперёд, визита ещё не было
    const q = quoteServicePrices(t.db, { patient_id: 77, service_ids: [30], date: localDay(5) }).quotes[30];
    assert.equal(q.tier, 'primary');
  } finally { t.close(); }
});

// ─── Тот же день: решает окно услуги ────────────────────────────────────────

test('тот же день: окно «со дня» не задано (с 1-го) — выставленный утренний визит не в счёт; окно с 0-го — в счёт', async () => {
  const t = await startCrmApp(seed);
  try {
    visitWithLine(t, 0, { hour: 8, bill: true });                  // услуга 30, окно 1–6
    visitWithLine(t, 0, { serviceId: 31, hour: 8, bill: true });   // услуга 31, окно 0–6
    const later30 = visitWithLine(t, 0, { hour: 15, tier: 'secondary' });
    const later31 = visitWithLine(t, 0, { serviceId: 31, hour: 15, tier: 'primary' });
    createInvoiceForVisit(t.db, { visit_id: later30.vid, visit_service_ids: [later30.vs] }, KASSA);
    createInvoiceForVisit(t.db, { visit_id: later31.vid, visit_service_ids: [later31.vs] }, KASSA);
    assert.deepEqual([lineOf(t.db, later30.vs).price_tier, itemOf(t.db, later30.vs).unit_price], ['primary', PRICE]);
    assert.deepEqual([lineOf(t.db, later31.vs).price_tier, itemOf(t.db, later31.vs).unit_price], ['secondary', 50000]);
  } finally { t.close(); }
});

// ─── Выставленное не трогается ──────────────────────────────────────────────

test('выставленная строка не меняется: ни новой частью счёта, ни отменой счёта прошлого визита', async () => {
  const t = await startCrmApp(seed);
  try {
    const past = visitWithLine(t, -2);
    const pastInv = createInvoiceForVisit(t.db, { visit_id: past.vid, visit_service_ids: [past.vs] }, KASSA);
    const now = visitWithLine(t, 0);
    const first = createInvoiceForVisit(t.db, { visit_id: now.vid, visit_service_ids: [now.vs] }, KASSA);
    const before = { line: lineOf(t.db, now.vs), item: itemOf(t.db, now.vs),
      inv: t.db.prepare('SELECT subtotal, total_amount FROM invoices WHERE id = ?').get(first.invoice.id) };
    assert.deepEqual([before.line.price_tier, before.item.unit_price], ['secondary', SECOND]);
    // прошлый счёт отменили — выставленная сегодня строка остаётся как есть
    voidInvoice(t.db, { invoice_id: pastInv.invoice.id, keep_services: true }, KASSA);
    // в визит добавили анализ и выставили (дописывается в тот же неоплаченный счёт)
    const lab = Number(t.db.prepare(`INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total, status)
                                     VALUES (?, 40, 1, 40000, 40000, 'added')`).run(now.vid).lastInsertRowid);
    createInvoiceForVisit(t.db, { visit_id: now.vid, visit_service_ids: [lab] }, KASSA);
    assert.deepEqual(lineOf(t.db, now.vs), before.line);
    assert.deepEqual(itemOf(t.db, now.vs), before.item);
    const inv = t.db.prepare('SELECT subtotal FROM invoices WHERE id = ?').get(first.invoice.id);
    assert.equal(inv.subtotal, before.inv.subtotal + 40000, 'новая часть — 40 000 сверху, прежняя строка — как была');
  } finally { t.close(); }
});

// ─── Смета = счёт ───────────────────────────────────────────────────────────

test('смета (service_price_quote) называет ту же цену, что выставит касса, — и записанный ярус экрана не важен', async () => {
  const t = await startCrmApp(seed);
  try {
    for (const [label, setup, want] of [
      ['без прошлого визита', () => {}, PRICE],
      ['после выставленного визита', () => visitWithLine(t, -2, { bill: true }), SECOND],
    ]) {
      setup();
      const now = visitWithLine(t, 0, { tier: 'repeat' });   // экран прислал чужой ярус
      const q = await t.rpc('service_price_quote', 'reg', { patient_id: 77, service_ids: [30], visit_id: now.vid, date: localDay(0), doctor_id: 10 });
      assert.equal(q.status, 200, q.text);
      assert.equal(q.json.data.quotes[30].price, want, label + ': смета');
      const r = await t.rpc('create_invoice_for_visit', 'reg', { visit_id: now.vid, visit_service_ids: [now.vs] });
      assert.equal(r.status, 200, r.text);
      assert.equal(itemOf(t.db, now.vs).unit_price, want, label + ': счёт');
      assert.equal(lineOf(t.db, now.vs).price_tier, q.json.data.quotes[30].tier, label + ': ярус строки — ярус сметы');
      // следующий круг — с чистого листа: визит этого круга отменяем
      t.db.prepare("UPDATE visits SET status = 'cancelled' WHERE id = ?").run(now.vid);
    }
  } finally { t.close(); }
});

test('«Ждут счёта» кассы показывает ту же сумму, что выставит счёт', async () => {
  const t = await startCrmApp(seed);
  try {
    openCashShift(t.db, { opening_float: 0 }, KASSA);
    const first = await ccBooking(t, 1);
    const second = await ccBooking(t, 3);
    t.db.prepare('UPDATE visit_services SET price_tier = ?, unit_price = ?, total = ? WHERE id = ?').run('secondary', SECOND, SECOND, second.vs);
    shiftBack(t.db, first.vid, 3);
    shiftBack(t.db, second.vid, 3);
    t.db.prepare("UPDATE visits SET status = 'no_show' WHERE id = ?").run(first.vid);
    const list = cashierUnbilled(t.db, {}, KASSA);
    const row = list.rows.find((r) => r.visit_id === second.vid);
    assert.ok(row, 'визит в «Ждут счёта»');
    assert.equal(row.total, PRICE);
    const r = createInvoiceForVisit(t.db, { visit_id: second.vid, visit_service_ids: [second.vs] }, KASSA);
    assert.equal(r.invoice.subtotal, row.total);
  } finally { t.close(); }
});

test('счёт плательщику тоже решает ярус заново', async () => {
  const t = await startCrmApp(seed);
  try {
    t.db.prepare("INSERT INTO payers (id, name, kind, active) VALUES (5, 'Страховая', 'insurance', 1)").run();
    const now = visitWithLine(t, 0, { tier: 'secondary' });
    const r = createInvoiceForVisit(t.db, { visit_id: now.vid, visit_service_ids: [now.vs], payer_id: 5 }, KASSA);
    assert.equal(r.invoice.payer_id, 5);
    assert.deepEqual([lineOf(t.db, now.vs).price_tier, itemOf(t.db, now.vs).unit_price, r.invoice.subtotal], ['primary', PRICE, PRICE]);
  } finally { t.close(); }
});

test('строка соседнего здания (без ссылки на позицию) — прошлый визит, если у её визита есть живой счёт с этой услугой', async () => {
  const t = await startCrmApp(seed);
  try {
    const past = visitWithLine(t, -2, { bill: true });
    // так строка выглядит у соседа: ссылка на позицию счёта не едет (journal.js)
    t.db.prepare("UPDATE visit_services SET invoice_item_id = NULL, sync_origin = 'B' WHERE id = ?").run(past.vs);
    let q = quoteServicePrices(t.db, { patient_id: 77, service_ids: [30], date: localDay(0) }).quotes[30];
    assert.equal(q.tier, 'secondary');
    t.db.prepare("UPDATE invoices SET status = 'void' WHERE visit_id = ?").run(past.vid);
    q = quoteServicePrices(t.db, { patient_id: 77, service_ids: [30], date: localDay(0) }).quotes[30];
    assert.equal(q.tier, 'primary');
  } finally { t.close(); }
});

// Регистратура, а не только касса, выставляет строку, записанную экраном.
test('строка мастера с ярусом экрана через /api/db: счёт регистратуры — ярус сервера', async () => {
  const t = await startCrmApp(seed);
  try {
    const now = visitWithLine(t, 0);
    t.db.prepare('DELETE FROM visit_services WHERE id = ?').run(now.vs);
    const ins = await t.dbq('reg', { table: 'visit_services', op: 'insert', returning: true, single: 'single',
      values: { visit_id: now.vid, service_id: 30, doctor_id: 10, quantity: 1, unit_price: 0, total: 0, status: 'added', price_tier: 'repeat' } });
    assert.equal(ins.status, 200, ins.text);
    const vsId = ins.json.data.id;
    const r = createInvoiceForVisit(t.db, { visit_id: now.vid, visit_service_ids: [vsId] }, REG);
    assert.equal(r.invoice.subtotal, PRICE);
    assert.equal(lineOf(t.db, vsId).price_tier, 'primary');
  } finally { t.close(); }
});
