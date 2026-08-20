// RECEIPT_QUEUE_V1 — номер очереди на чеке.
//
// Чек служит талоном: с ним идут в кабинет и в лабораторию. Печатает его НЕ
// fiscalBody() из doc-render.js, как можно решить по названию, а designed-
// вариант fiscalClassic() из doc-variants.js: buildSheetHtml() сначала зовёт
// renderDesignedVariant(), и для type='fiscal' тот всегда что-то возвращает —
// ветка fiscalBody() недостижима. Тест закрепляет РЕАЛЬНЫЙ путь.
//
// Ловушка, на которой легко потерять час: renderDesignedVariant подменяет
// данные на sampleFiscal(), если в них нет позиций. Чек без items печатается
// как ОБРАЗЕЦ — с чужими услугами и без очереди. Поэтому в каждом тесте ниже
// items есть, и один тест закрепляет саму подмену.

import { test } from 'node:test';
import assert from 'node:assert';
import { buildSheetHtml } from '../../shared/doc-render.js';

const S = { clinicName: 'Novo Medics' };
const ITEMS = [{ name: 'Консультация ЛОРа', qty: 1, price: 100000 }];
const receipt = (extra) => buildSheetHtml({
  type: 'fiscal', s: S,
  data: { docNo: 'INV-26-00060', subtotal: 100000, total: 100000, items: ITEMS, ...extra },
});

test('номер очереди печатается на чеке', () => {
  const html = receipt({ queue: [{ service: 'Консультация ЛОРа', label: 'Набиев Ойбек', number: 7 }] });
  assert.match(html, /Номер очереди/, 'блок подписан');
  assert.match(html, /Набиев Ойбек/, 'куда идти — без этого номер бессмыслен');
  assert.match(html, />7</, 'сам номер');
});

test('несколько талонов — печатаются все', () => {
  const html = receipt({ queue: [
    { service: 'Консультация ЛОРа', label: 'Набиев Ойбек', number: 7 },
    { service: 'ОАК', label: 'Лаборатория', number: 12 },
  ] });
  assert.match(html, /Набиев Ойбек/);
  assert.match(html, /Лаборатория/);
  assert.match(html, />7</);
  assert.match(html, />12</);
});

// 58-мм лента: пустой блок — выброшенная бумага.
test('без талонов блок не печатается', () => {
  for (const empty of [undefined, null, []]) {
    assert.doesNotMatch(receipt({ queue: empty }), /Номер очереди/, JSON.stringify(empty));
  }
});

test('талон без номера пропускается', () => {
  assert.doesNotMatch(receipt({ queue: [{ service: 'X', label: 'Y', number: null }] }), /Номер очереди/);
});

// ЭТО и есть ловушка: чек, собранный без позиций, печатается как ОБРАЗЕЦ —
// чужие услуги, чужие суммы, без очереди. Если печать когда-нибудь перестанет
// передавать items, чек молча станет выдуманным, и тест это поймает.
test('чек без позиций подменяется образцом — и очередь туда не попадает', () => {
  const html = buildSheetHtml({ type: 'fiscal', s: S, data: {
    docNo: 'INV-1', total: 100000, items: [],
    queue: [{ service: 'Консультация ЛОРа', label: 'Набиев Ойбек', number: 7 }],
  } });
  assert.doesNotMatch(html, /Набиев Ойбек/, 'переданная очередь теряется вместе с данными');
  assert.match(html, /Консультация терапевта/, 'напечатан sampleFiscal(), а не настоящий счёт');
});

test('данные талона экранируются', () => {
  const html = receipt({ queue: [{ service: 'S', label: '<img src=x onerror=alert(1)>', number: 3 }] });
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img/);
});

// ---------------------------------------------------------------------------
// INVOICE_QUEUE_V1 — номер очереди на СЧЁТЕ, а не только на кассовом чеке.
// ---------------------------------------------------------------------------
// Здесь и был потерянный номер. Мастер записи считает талоны и передаёт их в
// печать (service-picker-modal.js: `queue: queueBlock`), но вариант бланка
// выбирается настройками, а в doc_settings варианта нет — значит 'classic'.
// Очередь умел печатать ТОЛЬКО invoiceThermal; invoiceClassic и invoiceCompact
// молча выбрасывали поле. Номер считался, доезжал до шаблона и исчезал.
const INV = {
  docNo: 'INV-26-00102', title: 'Амбулаторные услуги',
  items: [{ name: 'Консультация ЛОРа', qty: 1, price: 100000 }],
  subtotal: 100000, total: 100000, paid: 100000,
};
const invoice = (variant, extra) => buildSheetHtml({
  type: 'invoice', s: { ...S, variant: variant ? { invoice: variant } : undefined },
  data: { ...INV, ...extra },
});

for (const variant of [undefined, 'classic', 'compact', 'thermal']) {
  test(`счёт (${variant || 'по умолчанию'}) печатает номер очереди`, () => {
    const html = invoice(variant, { queue: [{ service: 'Консультация ЛОРа', label: 'Набиев Ойбек', number: 5 }] });
    assert.match(html, /Набиев Ойбек/, 'куда идти');
    assert.match(html, />5</, 'номер');
  });
}

test('счёт без талонов не печатает пустой блок', () => {
  assert.doesNotMatch(invoice('classic', { queue: [] }), /Номер очереди/);
});

// ---------------------------------------------------------------------------
// RECEIPT_DOB_PERFORMER_V1 — на чеке должны быть дата рождения и ИСПОЛНИТЕЛЬ.
// ---------------------------------------------------------------------------
// Чек служит талоном: с ним идут в кабинет и в лабораторию, и там сверяют
// человека. Одного «Пациент ID» для этого мало — тёзки в регистратуре обычное
// дело, а дата рождения различает их сразу.
//
// Дата рождения УЖЕ передавалась в печать (printFiscalCheck кладёт d.dob), но
// fiscalClassic про это поле не знал и молча его выбрасывал — ровно та же
// ошибка, что была с номером очереди.
//
// Исполнитель отвечает на вопрос «к кому идти»: врач, лаборант или медсестра.
test('чек печатает дату рождения пациента', () => {
  const html = receipt({ patientName: 'Рахимов Ж. Б.', mrn: '0024815', dob: '14.03.1984 · 42 г.' });
  assert.match(html, /14\.03\.1984/, 'сама дата');
  assert.match(html, /42 г\./, 'и возраст, посчитанный при печати');
});

test('без даты рождения строка не печатается', () => {
  for (const empty of [undefined, null, '']) {
    const html = receipt({ patientName: 'Рахимов Ж. Б.', dob: empty });
    assert.doesNotMatch(html, /Дата рожд/, JSON.stringify(empty));
  }
});

test('чек печатает исполнителя рядом с услугой', () => {
  const html = receipt({ items: [
    { name: 'Консультация терапевта', qty: 1, price: 150000, performer: 'Юсупов О.', performerRole: 'Врач' },
    { name: 'Общий анализ крови', qty: 1, price: 60000, performer: 'Сулаймонов А.', performerRole: 'Лаборант' },
  ] });
  assert.match(html, /Юсупов О\./);
  assert.match(html, /Врач/);
  assert.match(html, /Сулаймонов А\./);
  assert.match(html, /Лаборант/);
});

// Услуга без назначенного исполнителя — обычное дело (процедуру берёт тот, кто
// свободен). Печатать «—» на 58-мм ленте незачем.
test('услуга без исполнителя не печатает пустую строку', () => {
  const html = receipt({ items: [{ name: 'Консультация терапевта', qty: 1, price: 150000 }] });
  assert.doesNotMatch(html, /Исполнитель/);
});

test('данные исполнителя экранируются', () => {
  const html = receipt({ items: [{ name: 'X', qty: 1, price: 1, performer: '<b>hack</b>', performerRole: 'Врач' }] });
  assert.doesNotMatch(html, /<b>hack<\/b>/);
  assert.match(html, /&lt;b&gt;hack/);
});

// Тот же блок — на ТЕРМО-СЧЁТЕ (invoiceThermal): это та же 58-мм лента, её так
// же несут в кабинет, и различать пациента по ней нужно ровно так же.
const thermal = (extra) => buildSheetHtml({
  type: 'invoice', s: { ...S, variant: { invoice: 'thermal' } },
  data: {
    docNo: 'INV-26-00230', subtotal: 150000, total: 150000,
    patient: [['ФИО', 'Мунавварова Д. А.'], ['Карта №', 'P-26-70035']],
    items: [{ name: 'Консультация гинеколога', qty: 1, price: 150000 }],
    ...extra,
  },
});

test('термо-счёт печатает дату рождения', () => {
  assert.match(thermal({ dob: '14.03.1984 · 42 г.' }), /14\.03\.1984/);
});

test('термо-счёт без даты рождения строку не печатает', () => {
  assert.doesNotMatch(thermal({}), /Дата рожд/);
});

test('термо-счёт печатает исполнителя рядом с услугой', () => {
  const html = thermal({ items: [
    { name: 'Консультация гинеколога', qty: 1, price: 150000, performer: 'Набиев О.', performerRole: 'Врач' },
  ] });
  assert.match(html, /Набиев О\./);
  assert.match(html, /Врач/);
});

test('термо-счёт без исполнителя пустую строку не печатает', () => {
  assert.doesNotMatch(thermal({}), /Исполнитель/);
});

// Счёт печатается РАЗНЫМИ экранами, и они кладут данные пациента по-разному:
// касса — строками в d.patient (['Дата рождения', …], ['Карта №', …]), чек —
// плоскими полями d.dob / d.mrn. Термо-счёт обязан понимать оба вида, иначе
// «добавили на чек» работает у одного экрана и молча не работает у другого —
// ровно это и произошло: на счёте кассы дата рождения не появилась.
test('термо-счёт берёт дату рождения из строк пациента', () => {
  const html = thermal({ patient: [
    ['ФИО', 'Туйчиев Абубакир'], ['Карта №', 'P-26-30958'],
    ['Дата рождения', '15.08.2023 · 3 г.'], ['Телефон', '+998 90 000 00 00'],
  ] });
  assert.match(html, /Дата рожд/);
  assert.match(html, /15\.08\.2023/);
});

test('термо-счёт показывает номер карты, подписанный «Карта №»', () => {
  const html = thermal({ patient: [['ФИО', 'Туйчиев Абубакир'], ['Карта №', 'P-26-30958']] });
  assert.match(html, /P-26-30958/, 'номер карты пропадал: pick() не знал слова «карта»');
});

test('плоское поле по-прежнему работает и имеет приоритет', () => {
  const html = thermal({ dob: '01.01.1990', patient: [['Дата рождения', '15.08.2023']] });
  assert.match(html, /01\.01\.1990/);
});
