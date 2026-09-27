// V3120_FIX — печатные бланки после инспекции 3.12.0.
//
// Что проверяется (каждое — снимок инспекции, а не догадка):
//   • кассовый чек при раздельной / частичной оплате печатал ВСЮ сумму счёта
//     одной строкой «Наличные 378 001», хотя взяли 100 000 наличными и 50 000
//     картой, а 228 001 остались долгом. Теперь — строка на каждый платёж,
//     «Оплачено» и «Остаток»;
//   • A4-счёт (классический и компактный) не говорил, сколько уже оплачено, и
//     «К оплате» было суммой счёта, а не остатком;
//   • статус внизу счёта печатался английским «PARTIAL / PAID / DEBT»;
//   • «Дата Дата 26.09.2026» — вызывающие клали слово «Дата» в само значение;
//   • перепечатанный чек называл датой момент перепечатки;
//   • акт: «Скидка −0 UZS», валюта «UZS» вместо «сум», «Page 1 of 1».
//   • квитанция о продаже карты и о депозите — новый бланк.

import { test } from 'node:test';
import assert from 'node:assert';
import { buildSheetHtml } from '../../shared/doc-render.js';
import {
  paymentLines, printInvoiceCheck, invoiceSheetData, printInvoiceSheetById, slipData, dobAge,
} from '../views/receipt-print.js';

const S = { clinicName: 'Клиника «Шифо»', accent: '#167873' };
const text = (html) => String(html)
  .replace(/<style[\s\S]*?<\/style>/g, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ')
  .replace(/\s+/g, ' ');

const ITEMS = [
  { name: 'Консультация терапевта', qty: 1, price: 150000 },
  { name: 'ЭКГ с расшифровкой', qty: 2, price: 80000 },
  { name: 'Капельница', qty: 1, price: 145500 },
];
const fiscal = (extra) => text(buildSheetHtml({
  type: 'fiscal', s: S,
  data: { docNo: 'INV-A-26-00001', items: ITEMS, subtotal: 455500, total: 418000, ...extra },
}));

// ---------------------------------------------------------------------------
// FATAL — кассовый чек при раздельной / частичной оплате
// ---------------------------------------------------------------------------
test('чек: строка на каждый платёж, «Оплачено» и «Остаток» при частичной оплате', () => {
  const t = fiscal({
    payments: [{ label: 'Наличные', amount: 100000 }, { label: 'Карта', amount: 50000 }],
    paid: 150000,
  });
  assert.match(t, /Наличные 100 000/);
  assert.match(t, /Карта 50 000/);
  assert.match(t, /Оплачено 150 000/);
  assert.match(t, /Остаток 268 000/);
  assert.doesNotMatch(t, /Наличные 418 000/, 'вся сумма счёта одной строкой — ровно та ошибка');
});

test('чек: полностью оплаченный счёт не печатает «Остаток»', () => {
  const t = fiscal({ payments: [{ label: 'Перевод', amount: 418000 }], paid: 418000 });
  assert.match(t, /Перевод 418 000/);
  assert.match(t, /Оплачено 418 000/);
  assert.doesNotMatch(t, /Остаток/);
});

test('чек: ранее внесённое печатается отдельной строкой, «Оплачено» — всего по счёту', () => {
  const t = fiscal({ payments: [{ label: 'Наличные', amount: 100000 }], paidBefore: 200000, paid: 300000 });
  assert.match(t, /Ранее оплачено 200 000/);
  assert.match(t, /Наличные 100 000/);
  assert.match(t, /Оплачено 300 000/);
  assert.match(t, /Остаток 118 000/);
});

test('чек без списка платежей: строка способа несёт ОПЛАЧЕННОЕ, а не сумму счёта', () => {
  const t = fiscal({ payMethod: 'Наличные', paid: 150000 });
  assert.match(t, /Наличные 150 000/);
  assert.doesNotMatch(t, /Наличные 418 000/);
  assert.match(t, /Остаток 268 000/);
});

test('копия чека: «Копия» и дата оплаты, а не момент перепечатки', () => {
  const t = fiscal({ payments: [{ label: 'Наличные', amount: 418000 }], paid: 418000, copy: true, paidAt: '26.09.2026 14:05' });
  assert.match(t, /Копия/);
  assert.match(t, /Дата оплаты 26\.09\.2026 14:05/);
});

test('возврат в списке платежей печатается со знаком минус', () => {
  const lines = paymentLines([
    { method: 'cash', amount: 100000 },
    { method: 'card', amount: 50000 },
    { method: 'cash', amount: -30000 },
    { method: 'wallet', amount: 0 },
  ]);
  assert.deepStrictEqual(lines, [
    { label: 'Наличные', amount: 100000 },
    { label: 'Карта', amount: 50000 },
    { label: 'Возврат · Наличные', amount: -30000 },
  ]);
  const t = fiscal({ payments: lines, paid: 120000 });
  assert.match(t, /Возврат · Наличные −30 000/);
});

test('способы «С баланса» и «Подарочная карта» названы по-русски', () => {
  const l = paymentLines([{ method: 'wallet', amount: 1 }, { method: 'gift_card', amount: 2 }]);
  assert.deepStrictEqual(l.map((x) => x.label), ['С баланса', 'Подарочная карта']);
});

// ---------------------------------------------------------------------------
// MAJOR — A4-счёт: оплачено / остаток; статус по-русски; «Дата Дата»
// ---------------------------------------------------------------------------
const invoice = (variant, extra) => text(buildSheetHtml({
  type: 'invoice', s: { ...S, variant: { invoice: variant } },
  data: { docNo: 'INV-A-26-00001', items: ITEMS, subtotal: 455500, total: 418000, ...extra },
}));

for (const variant of ['classic', 'compact']) {
  test(`счёт ${variant}: «Оплачено» и «Остаток», «К оплате» — остаток`, () => {
    const t = invoice(variant, { paid: 150000, status: 'debt' });
    assert.match(t, /Оплачено:? 150 000/);
    assert.match(t, /Остаток к оплате:? 268 000/);
    assert.doesNotMatch(t, /К оплате:? 418 000/, 'к оплате — не сумма счёта, если часть уже внесена');
  });

  test(`счёт ${variant}: без оплаты — «К оплате» = сумма счёта, строки «Оплачено» нет`, () => {
    const t = invoice(variant, { paid: 0, status: 'unpaid' });
    assert.match(t, /К оплате:? 418 000/);
    assert.doesNotMatch(t, /Оплачено/);
  });

  test(`счёт ${variant}: статус словом, а не PARTIAL/PAID/DEBT`, () => {
    for (const [code, word] of [['PARTIAL', 'Частично'], ['paid', 'Оплачен'], ['UNPAID', 'Не оплачен'], ['debt', 'Долг']]) {
      const t = invoice(variant, { status: code });
      assert.match(t, new RegExp(word), code);
      assert.doesNotMatch(t, /PARTIAL|PAID|UNPAID|DEBT/, code);
    }
  });

  test(`счёт ${variant}: «Дата» один раз, даже если вызывающий положил слово в значение`, () => {
    const t = invoice(variant, { issueDate: 'Дата 26.09.2026' });
    assert.doesNotMatch(t, /Дата Дата/);
    assert.match(t, /Дата 26\.09\.2026/);
  });
}

test('термо-счёт: «Дата» один раз', () => {
  const t = invoice('thermal', { issueDate: 'Дата 26.09.2026' });
  assert.doesNotMatch(t, /Дата Дата/);
});

// ---------------------------------------------------------------------------
// Данные A4-счёта из серверных строк (касса, визит, мастер — одна сборка)
// ---------------------------------------------------------------------------
test('invoiceSheetData: русские подписи, местная дата, плательщик по имени, статус кодом', () => {
  const d = invoiceSheetData({
    inv: { id: 7, invoice_number: 'INV-7', subtotal: 100000, total_amount: 90000, paid_amount: 40000, status: 'partial', created_at: '2026-09-26T21:30:00Z' },
    items: [{ id: 1, description: 'ОАК', quantity: 1, unit_price: 100000 }],
    patient: { full_name: 'Рахимов Жасур', mrn: '0024815', phone: '+998901234567', date_of_birth: '1989-09-28' },
    payerName: 'Страховая «Гарант»',
    methods: ['cash', 'card'],
  });
  assert.strictEqual(d.docNo, 'INV-7');
  assert.strictEqual(d.status, 'partial');
  assert.doesNotMatch(d.issueDate, /Дата/, 'значение — голая дата');
  assert.match(d.issueDate, /^\d{2}\.\d{2}\.\d{4}$/);
  const labels = [...d.patient, ...d.billing].map(([k]) => k).join('|');
  assert.doesNotMatch(labels, /Full name|MRN|Phone|Payer|Issue date|Due/);
  assert.ok(d.billing.some(([k, v]) => k === 'Плательщик' && v === 'Страховая «Гарант»'));
  assert.ok(d.billing.some(([k, v]) => k === 'Оплата' && v === 'Наличные, Карта'));
  assert.strictEqual(d.paid, 40000);
  assert.strictEqual(d.total, 90000);
});

test('invoiceSheetData: без плательщика платит пациент', () => {
  const d = invoiceSheetData({ inv: { id: 1, total_amount: 10, paid_amount: 0 }, items: [], patient: {} });
  assert.ok(d.billing.some(([k, v]) => k === 'Плательщик' && v === 'Пациент'));
});

test('возраст печатается «г.» по-русски', () => {
  assert.match(dobAge('1989-09-28'), /^28\.09\.1989 · \d+ г\.$/);
  assert.strictEqual(dobAge(''), '');
  assert.strictEqual(dobAge('мусор'), '');
});

// ---------------------------------------------------------------------------
// Перепечатка чека и A4-счёта по id — с фальшивой базой
// ---------------------------------------------------------------------------
function fakeSb(tables, rpc = {}) {
  return {
    from(t) {
      const f = [];
      const rows = () => (tables[t] || []).filter((r) => f.every(([k, v, op]) => (op === 'in' ? v.map(String).includes(String(r[k])) : String(r[k]) === String(v))));
      const q = {
        select() { return q; }, order() { return q; }, limit() { return q; },
        eq(k, v) { f.push([k, v]); return q; }, in(k, v) { f.push([k, v, 'in']); return q; },
        single() { const r = rows()[0]; return Promise.resolve(r ? { data: r, error: null } : { data: null, error: { message: 'nf' } }); },
        maybeSingle() { return Promise.resolve({ data: rows()[0] || null, error: null }); },
        then(res, rej) { return Promise.resolve({ data: rows(), error: null }).then(res, rej); },
      };
      return q;
    },
    rpc(name, args) { return Promise.resolve({ data: rpc[name] ? rpc[name](args) : [], error: null }); },
  };
}
const DB = () => ({
  invoices: [{ id: 1, invoice_number: 'INV-A-26-00001', subtotal: 455500, discount_amount: 37500, total_amount: 418000, paid_amount: 150000, status: 'debt', patient_id: 3, payer_id: 9, created_at: '2026-09-26T00:10:00Z' }],
  invoice_items: [{ id: 11, invoice_id: 1, description: 'Консультация', quantity: 1, unit_price: 455500, total: 455500, discount_amount: 0 }],
  patients: [{ id: 3, full_name: 'Рахимов Жасур', mrn: '0024815', date_of_birth: '1989-09-28', gender: 'male', phone: '+998901234567' }],
  payments: [
    { id: 1, invoice_id: 1, amount: 100000, method: 'cash', paid_at: '2026-09-26T09:05:00Z' },
    { id: 2, invoice_id: 1, amount: 50000, method: 'card', paid_at: '2026-09-26T09:05:00Z' },
  ],
  payers: [{ id: 9, name: 'Страховая «Гарант»' }],
  visit_services: [],
});

test('перепечатка чека: все платежи счёта, «Оплачено», «Остаток», «Копия», дата оплаты', async () => {
  let html = '';
  const r = await printInvoiceCheck({ supabase: fakeSb(DB()), printableSheet: ({ type, s, data }) => { html = buildSheetHtml({ type, s: s || S, data }); }, invoiceId: 1 });
  assert.deepStrictEqual(r, { ok: true });
  const t = text(html);
  assert.match(t, /Наличные 100 000/);
  assert.match(t, /Карта 50 000/);
  assert.match(t, /Оплачено 150 000/);
  assert.match(t, /Остаток 268 000/);
  assert.match(t, /Копия/);
  assert.match(t, /Дата оплаты 26\.09\.2026/);
});

test('A4-счёт по id: плательщик из справочника, оплачено / остаток, без английских слов', async () => {
  let html = '';
  const r = await printInvoiceSheetById({ supabase: fakeSb(DB()), printableSheet: ({ type, data }) => { html = buildSheetHtml({ type, s: S, data }); }, invoiceId: 1 });
  assert.deepStrictEqual(r, { ok: true });
  const t = text(html);
  assert.match(t, /Страховая «Гарант»/);
  assert.match(t, /Оплачено:? 150 000/);
  assert.match(t, /Остаток к оплате:? 268 000/);
  assert.match(t, /Долг/);
  assert.doesNotMatch(t, /Full name|Outpatient|Issued|Self-pay|On receipt|DEBT/);
});

test('A4-счёт по id: несуществующий счёт не печатается образцом', async () => {
  let printed = false;
  const r = await printInvoiceSheetById({ supabase: fakeSb(DB()), printableSheet: () => { printed = true; }, invoiceId: 404 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(printed, false);
});

// ---------------------------------------------------------------------------
// Акт и общий подвал (doc-render)
// ---------------------------------------------------------------------------
const act = (items, s = {}) => text(buildSheetHtml({
  type: 'act', s: { ...S, footerNote: '', legalNote: '', ...s },
  data: { docNo: 'ACT-1', items, issueDate: '26.09.2026' },
}));

test('акт без скидки не печатает «Скидка −0», валюта — «сум»', () => {
  const t = act([{ name: 'ОАК', qty: 1, price: 60000 }]);
  assert.doesNotMatch(t, /Скидка\s*−\s*0/);
  assert.doesNotMatch(t, /UZS/);
  assert.match(t, /60 000 сум/);
});

test('акт со скидкой её печатает', () => {
  const t = act([{ name: 'ОАК', qty: 1, price: 60000, disc: 10 }]);
  assert.match(t, /Скидка\s*−6 000 сум/);
});

test('подвал: без «Page 1 of 1» и без пустых английских заготовок', () => {
  const t = act([{ name: 'ОАК', qty: 1, price: 60000 }]);
  assert.doesNotMatch(t, /Page 1 of 1|Thank you|electronically/);
});

test('подвал печатает текст, заданный клиникой', () => {
  const t = act([{ name: 'ОАК', qty: 1, price: 60000 }], { footerNote: 'Берегите здоровье' });
  assert.match(t, /Берегите здоровье/);
});

test('шапка не печатает пустые контакты', () => {
  const html = buildSheetHtml({ type: 'act', s: { ...S, address: '', phone: '', email: '', web: '' }, data: { items: [{ name: 'ОАК', qty: 1, price: 1 }] } });
  assert.doesNotMatch(html, /<div>\s*·\s*<\/div>/, 'строка « · » без телефона и почты');
});

// ---------------------------------------------------------------------------
// NEW — квитанция о продаже карты и о депозите
// ---------------------------------------------------------------------------
test('квитанция о продаже карты: покупатель, сумма, способ, номер карты, остаток', () => {
  const d = slipData({
    kind: 'card',
    card: { sale_number: 'CARD-A-26-00001', kind: 'gift_card', name: 'Подарок', amount: 300000, remaining: 300000, valid_until: '2027-03-08' },
    buyer: { full_name: 'Покупатель Тестов', mrn: 'P-26-1' },
    method: 'cash', cashier: 'Кассирова Д.',
  });
  const t = text(buildSheetHtml({ type: 'slip', s: S, data: d }));
  assert.match(t, /Квитанция/);
  assert.match(t, /Подарочная карта/);
  assert.match(t, /Покупатель Тестов/);
  assert.match(t, /CARD-A-26-00001/);
  assert.match(t, /300 000 сум/);
  assert.match(t, /Наличные/);
  assert.match(t, /Остаток на карте 300 000/);
  assert.match(t, /08\.03\.2027/);
});

test('квитанция о приёме депозита: пациент, номер депозита, способ, баланс', () => {
  const d = slipData({
    kind: 'deposit',
    deposit: { deposit_number: 'DEP-A-26-00004', amount: 500000, method: 'card', status: 'received' },
    patient: { full_name: 'Рахимов Жасур', mrn: '0024815' },
    balance: 650000,
  });
  const t = text(buildSheetHtml({ type: 'slip', s: S, data: d }));
  assert.match(t, /Квитанция/);
  assert.match(t, /DEP-A-26-00004/);
  assert.match(t, /Рахимов Жасур/);
  assert.match(t, /500 000 сум/);
  assert.match(t, /Карта/);
  assert.match(t, /Баланс пациента 650 000/);
});

test('квитанция о депозите, ещё не принятом кассой, так и говорит', () => {
  const d = slipData({ kind: 'deposit', deposit: { deposit_number: 'DEP-1', amount: 1000, method: null, status: 'pending' }, patient: { full_name: 'А' } });
  const t = text(buildSheetHtml({ type: 'slip', s: S, data: d }));
  assert.match(t, /оплат\S* в кассе/i);
  assert.doesNotMatch(t, /Способ/);
});

test('квитанция экранирует данные', () => {
  const d = slipData({ kind: 'card', card: { sale_number: '<b>x</b>', kind: 'certificate', amount: 1 }, buyer: { full_name: '<img src=x>' }, method: 'cash' });
  const html = buildSheetHtml({ type: 'slip', s: S, data: d });
  assert.doesNotMatch(html, /<img src=x>|<b>x<\/b>/);
});

// ---------------------------------------------------------------------------
// Экраны, которые печатают счёт: общая сборка вместо своей.
// ---------------------------------------------------------------------------
// Окно визита и мастер записи целиком без DOM не поднимаются; здесь — что они
// зовут общую сборку и больше не несут своих английских подписей / счёта №1.
import fs from 'node:fs';
const src = (p) => fs.readFileSync(new URL('../views/' + p, import.meta.url), 'utf8');
const fnBody = (text, head) => {
  const a = text.indexOf(head);
  assert.ok(a >= 0, head);
  const b = text.indexOf('\n}\n', a);
  return text.slice(a, b);
};

test('окно визита печатает счёт общей сборкой по id, без английских подписей', () => {
  const body = fnBody(src('visit-modal.js'), 'function openInvoicePrintWindow(');
  assert.match(body, /printInvoiceSheetById\(/);
  assert.doesNotMatch(body, /Full name|Issued|Self-pay|On receipt|Outpatient|toUpperCase/);
});

test('мастер записи печатает лист на КАЖДЫЙ счёт пациента, а не счёт №1 со всеми днями', () => {
  const text = src('visit-wizard.js');
  const a = text.indexOf('V3120_FIX — ЛИСТ НА КАЖДЫЙ СЧЁТ ПАЦИЕНТА');
  assert.ok(a > 0);
  const block = text.slice(a, text.indexOf("} catch (e) { console.warn('[wizard] invoice print:', e); }", a));
  assert.match(block, /for \(const pInv of patientInvoices\)/);
  assert.match(block, /printInvoiceSheetById\(\{[^}]*invoiceId: pInv\.id/);
  assert.doesNotMatch(block, /patientTotal\(\)|discountAmount\(\)|'Дата ' \+/, 'сумма и скидка — серверные, не экранные');
});

test('экраны больше не кладут слово «Дата» в значение даты счёта и английский статус', () => {
  for (const f of ['cashier-desk.js', 'fast-registration.js', 'visit-wizard.js', 'service-picker-modal.js']) {
    // Только счета: у акта «Дата» стоит после номера в строке шапки, там это не повтор.
    const t = src(f).split("type: 'invoice'").slice(1).map((x) => x.slice(0, 1500)).join('\n');
    assert.doesNotMatch(t, /issueDate:\s*'Дата '/, f);
    assert.doesNotMatch(t, /status:\s*'(UNPAID|PAID|PARTIAL)'/, f);
  }
});
