// CRM_UNIFY_V1 (2026-10-10, замечание владельца) — ПАЦИЕНТ ПРИШЁЛ РАНЬШЕ ДНЯ ЗАПИСИ.
//
// Владелец на тестовой клинике: карточка (пациент привязан) «Записать на дату»
// — «Диагностика» на ЗАВТРА 09:00. Сегодня регистратура приняла этот визит: два
// счёта оплачены, врач подписал услугу (visit_services → 'completed'). Карточка
// осталась в «Подтверждён». Ожидание владельца — «Пришёл» сразу.
//
// Правило (решение контролёра):
//   а) работа над услугой (проба, приём, результат, выдано) — приход в любой
//      день визита своего здания;
//   б) отметка «Пришёл» в календаре — тоже: прямое слово человека;
//   в) одна оплата будущего визита — по-прежнему предоплата, не приход;
//   г) догоняющий проход (раз в час и при запуске) закрывает карточки, чьё
//      доказательство когда-то пропустили, — в том числе карточку владельца.
// Всё — через настоящие двери /api/rpc и /api/db под настоящими ролями.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startCrmApp, localDay, at, linesOf } from '../test-helpers/crm-unify-app.js';
import { crmArrivalCatchUp } from '../services/crm/no-show.js';

const TOMORROW = localDay(1);
const vsOf = (db, vid) => db.prepare('SELECT id, service_id, status FROM visit_services WHERE visit_id = ? ORDER BY id').all(vid);
const money = (db) => ({
  visits: db.prepare('SELECT id, status, visit_date FROM visits ORDER BY id').all(),
  invoices: db.prepare('SELECT id, status, total_amount, paid_amount FROM invoices ORDER BY id').all(),
  payments: db.prepare('SELECT id, invoice_id, amount FROM payments ORDER BY id').all(),
  visit_services: db.prepare('SELECT id, visit_id, service_id, status, invoice_item_id FROM visit_services ORDER BY id').all(),
});

/** Карточка с пациентом в «Подтверждён», строка на завтра 09:00 у врача — «Записать на дату». */
async function cardBookedTomorrow(t) {
  const r = await t.dbq('cc', { table: 'crm_requests', op: 'insert', returning: true, single: 'single',
    values: { full_name: 'Пациент Тест', phone: '+998 90 909 26 38', patient_id: 77, status: 'approved', source: 'call' } });
  assert.equal(r.status, 200, r.text);
  const rid = r.json.data.id;
  const ins = await t.dbq('cc', { table: 'crm_request_services', op: 'insert',
    values: [{ request_id: rid, service_id: 30, scheduled_date: TOMORROW, doctor_id: 10, status: 'pending' }] });
  assert.equal(ins.status, 200, ins.text);
  const start = at(TOMORROW, 9);
  const b = await t.rpc('ensure_visit', 'cc', { patient_id: 77, date: start, doctor_id: 10,
    book: { doctor_id: 10, service_id: 30, start, duration_minutes: 30 } });
  assert.equal(b.status, 200, b.text);
  const vid = b.json.data.visit.id;
  assert.deepEqual(linesOf(t.db, rid).map((l) => [l.status, l.visit_id]), [['pending', vid]], 'запись на завтра не взяла строку');
  const booked = t.lead(rid).status;
  assert.notEqual(booked, 'came', 'запись на завтра объявлена приходом');
  return { rid, vid, booked };
}

/** Сегодня: регистратура добавляет к визиту анализ, два счёта, касса оплачивает оба. */
async function payTodayTwoInvoices(t, vid) {
  const add = await t.dbq('reg', { table: 'visit_services', op: 'insert', returning: true, single: 'single',
    values: { visit_id: vid, service_id: 40, quantity: 1, unit_price: 40000, total: 40000, status: 'added' } });
  assert.equal(add.status, 200, add.text);
  for (const svc of [30, 40]) {
    const ids = vsOf(t.db, vid).filter((x) => x.service_id === svc).map((x) => x.id);
    assert.equal(ids.length, 1, 'строка визита ' + svc);
    const inv = await t.rpc('create_invoice_for_visit', 'reg', { visit_id: vid, visit_service_ids: ids, discount_amount: 0, payer_id: null });
    assert.equal(inv.status, 200, inv.text);
    const id = inv.json.data.invoice.id;
    const due = t.db.prepare('SELECT total_amount FROM invoices WHERE id = ?').get(id).total_amount;
    const pay = await t.rpc('record_payment', 'kassa', { invoice_id: id, amount: Number(due), method: 'cash' });
    assert.equal(pay.status, 200, pay.text);
  }
  assert.deepEqual(t.db.prepare('SELECT status FROM invoices WHERE visit_id = ? ORDER BY id').all(vid).map((r) => r.status), ['paid', 'paid']);
}

test('владелец: запись на завтра + оплата сегодня — карточка ждёт (предоплата); врач подписал услугу — «Пришёл» сразу', async () => {
  const t = await startCrmApp();
  try {
    const { rid, vid, booked } = await cardBookedTomorrow(t);
    await payTodayTwoInvoices(t, vid);
    assert.equal(t.lead(rid).status, booked, 'оплата завтрашнего визита сдвинула карточку — предоплата не приход');
    assert.ok(linesOf(t.db, rid).every((l) => l.status === 'pending'), 'оплата завтрашнего визита закрыла строку');

    const vs30 = vsOf(t.db, vid).find((x) => x.service_id === 30).id;
    const before = money(t.db);
    const sign = await t.dbq('doc', { table: 'visit_services', op: 'update', values: { status: 'completed' },
      filters: [{ col: 'id', op: 'eq', val: vs30 }] });
    assert.equal(sign.status, 200, sign.text);

    assert.equal(t.lead(rid).status, 'came', 'врач подписал услугу визита на завтра, а карточка не в «Пришёл»');
    assert.deepEqual(linesOf(t.db, rid).filter((l) => l.service_id === 30).map((l) => [l.status, l.visit_id]), [['done', vid]]);
    // Деньги и визит — как были (кроме самой подписи врача).
    const after = money(t.db);
    assert.deepEqual(after.invoices, before.invoices, 'приход изменил счета');
    assert.deepEqual(after.payments, before.payments);
    assert.deepEqual(after.visits, before.visits, 'приход изменил визит');
    assert.deepEqual(after.visit_services.map((x) => [x.id, x.status, x.invoice_item_id]),
      before.visit_services.map((x) => [x.id, x.id === vs30 ? 'completed' : x.status, x.invoice_item_id]));
  } finally { t.close(); }
});

test('владелец: отметка «Пришёл» в календаре сегодня на визит завтрашнего дня — «Пришёл»', async () => {
  const t = await startCrmApp();
  try {
    const { rid, vid } = await cardBookedTomorrow(t);
    const arr = await t.rpc('calendar_book', 'reg', { visit_id: vid, start: at(TOMORROW, 9), status: 'arrived' });
    assert.equal(arr.status, 200, arr.text);
    assert.equal(t.lead(rid).status, 'came', 'регистратор отметил «Пришёл», а карточка ждёт завтрашнего дня');
    assert.deepEqual(linesOf(t.db, rid).map((l) => l.status), ['done']);
  } finally { t.close(); }
});

test('владелец: карточка, чьё доказательство пропустили до обновления, — закрывается догоняющим проходом; второй проход ничего не меняет', async () => {
  const t = await startCrmApp();
  try {
    const { rid, vid, booked } = await cardBookedTomorrow(t);
    await payTodayTwoInvoices(t, vid);
    // Подпись врача, прошедшая мимо правила прихода (как до обновления).
    const vs30 = vsOf(t.db, vid).find((x) => x.service_id === 30).id;
    t.db.prepare("UPDATE visit_services SET status = 'completed' WHERE id = ?").run(vs30);
    assert.equal(t.lead(rid).status, booked);

    const before = money(t.db);
    crmArrivalCatchUp(t.db);
    assert.equal(t.lead(rid).status, 'came', 'догоняющий проход не закрыл карточку с подписанной услугой');
    assert.deepEqual(linesOf(t.db, rid).filter((l) => l.service_id === 30).map((l) => l.status), ['done']);
    assert.deepEqual(money(t.db), before, 'догоняющий проход изменил визиты, счета, платежи или строки визита');

    const once = JSON.stringify([t.lead(rid), linesOf(t.db, rid)]);
    crmArrivalCatchUp(t.db);
    assert.equal(JSON.stringify([t.lead(rid), linesOf(t.db, rid)]), once, 'второй проход что-то изменил');
  } finally { t.close(); }
});
