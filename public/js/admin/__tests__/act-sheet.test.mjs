// ACT_SHEET_V1 — акт оказанных услуг: места подписи и номер очереди.
//
// Печатает акт actBody() из doc-render.js: renderDesignedVariant() для
// type='act' ветки не имеет и возвращает undefined, поэтому designed-вариант
// его не перехватывает (в отличие от чека — см. fiscal-receipt.test.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSheetHtml } from '../../shared/doc-render.js';

const S = { clinicName: 'Novo Medics' };
const act = (extra) => buildSheetHtml({
  type: 'act', s: S,
  data: {
    title: 'Акт оказанных медицинских услуг',
    docNo: 'АКТ INV-26-03031',
    coverage: 'По договору',
    patient: [['ФИО', 'Мамашарипова Нилуфар Туйчиевна'], ['Карта №', 'P-26-71065']],
    payer: [['Организация', '"Cenergo" ООО']],
    items: [{ name: 'CA 15-3 (Онкомаркер)', qty: 1, price: 80000 }],
    ...extra,
  },
});

const signPlaces = (html) => (html.match(/подпись \/ Ф\.И\.О\./g) || []).length;

// Решение владельца 2026-09-07: мест подписи два — Пациент и Врач. Третье
// («Представитель страховой») печаталось на КАЖДОМ акте, включая договорные,
// где страховой в сделке нет вообще.
test('акт печатает ровно два места подписи', () => {
  assert.equal(signPlaces(act()), 2);
});

test('«Представитель страховой» с акта убран', () => {
  assert.doesNotMatch(act(), /Представитель страховой/);
});

test('место печати и дата остались', () => {
  const html = act();
  assert.match(html, /М\.П\./);
  assert.match(html, /Дата/);
});
