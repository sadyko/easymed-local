// INVOICE_APPEND_V1 — одна фраза на все двери (invoice-append.js): «Добавлено в
// счёт № … — новая сумма …», и скидка своей части дописанного счёта.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// I18N_LOCALE_PIN_V1 — русский ДО импорта (CI на en-US).
globalThis.localStorage = { getItem: (k) => (k === 'admin.lang' ? 'ru' : null), setItem() {}, removeItem() {}, clear() {} };
globalThis.document = { documentElement: {} };   // i18n.js ставит documentElement.lang
globalThis.window = { dispatchEvent() {} };        // setLang шлёт 'langchange'
globalThis.CustomEvent = class { constructor(t, o) { this.type = t; Object.assign(this, o || {}); } };

const { isAppended, invoiceAppendNote, appendedPartDiscount } = await import('../invoice-append.js');
const { setLang } = await import('../i18n.js');

const res = { appended: true, invoice: { id: 5, invoice_number: 'INV-A-26-00012', total_amount: 1150000 }, items: [{ discount_amount: 2000 }, { discount_amount: 0 }], rest_discount: 5000 };

test('дописано — фраза с номером и новой суммой; новый счёт — пусто', () => {
  assert.equal(isAppended(res), true);
  assert.equal(invoiceAppendNote(res), 'Добавлено в счёт № INV-A-26-00012 — новая сумма 1 150 000 сум');
  assert.equal(isAppended({ invoice: { id: 1 } }), false);
  assert.equal(invoiceAppendNote({ invoice: { id: 1, invoice_number: 'INV-A-26-00001' } }), '');
  assert.equal(invoiceAppendNote(null), '');
  assert.equal(invoiceAppendNote({ appended: true, invoice: { id: 9, total_amount: 0 } }), 'Добавлено в счёт № 9 — новая сумма 0 сум');
});

test('скидка своей части — свои скидки позиций плюс rest_discount', () => {
  assert.equal(appendedPartDiscount(res), 7000);
  assert.equal(appendedPartDiscount({}), 0);
});

test('узбекский и английский — без кириллицы', () => {
  for (const lang of ['uz', 'en']) {
    setLang(lang);
    try { assert.ok(!/[А-Яа-яЁё]/.test(invoiceAppendNote(res)), lang + ': ' + invoiceAppendNote(res)); }
    finally { setLang('ru'); }
  }
});
