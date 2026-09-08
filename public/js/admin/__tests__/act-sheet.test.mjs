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

// Акт служит и талоном: с ним идут в лабораторию. Номер очереди на нём —
// то же, что на чеке, и по той же причине (RECEIPT_QUEUE_V1).
test('акт печатает номер очереди', () => {
  const html = act({ queue: [{ service: 'CA 15-3 (Онкомаркер)', label: 'Лаборатория', number: 28 }] });
  assert.match(html, /Номер очереди/, 'блок подписан');
  assert.match(html, /Лаборатория/, 'куда идти — без этого номер бессмыслен');
  assert.match(html, />28</, 'сам номер');
});

test('несколько талонов печатаются все', () => {
  const html = act({ queue: [
    { service: 'CA 15-3 (Онкомаркер)', label: 'Лаборатория', number: 28 },
    { service: 'Консультация ЛОРа', label: 'Набиев Ойбек', number: 7 },
  ] });
  assert.match(html, /Лаборатория/);
  assert.match(html, /Набиев Ойбек/);
  assert.match(html, />28</);
  assert.match(html, />7</);
});

test('без талонов пустой блок не печатается', () => {
  for (const empty of [undefined, null, []]) {
    assert.doesNotMatch(act({ queue: empty }), /Номер очереди/, JSON.stringify(empty));
  }
});

test('талон без номера пропускается', () => {
  assert.doesNotMatch(act({ queue: [{ service: 'X', label: 'Y', number: null }] }), /Номер очереди/);
});

test('данные талона экранируются', () => {
  const html = act({ queue: [{ service: 'S', label: '<img src=x onerror=alert(1)>', number: 3 }] });
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img/);
});

// Образец владельца 2026-09-08: номер очереди стоит ВНИЗУ бланка, под местами
// подписи и печатью. Сначала он был поставлен выше — «ради очереди документ
// несут дальше»; довод был мой, а не владельца, и порядок бланка задаёт он.
test('номер очереди печатается ПОД подписями', () => {
  const html = act({ queue: [{ service: 'CA 15-3 (Онкомаркер)', label: 'Лаборатория', number: 28 }] });
  const q = html.indexOf('Номер очереди');
  const lastSign = html.lastIndexOf('подпись / Ф.И.О.');
  assert.notEqual(q, -1, 'блок очереди на месте');
  assert.ok(q > lastSign, `очередь должна идти после мест подписи (очередь ${q}, подписи ${lastSign})`);
});

// ── Правки владельца по образцу, 2026-09-08 ────────────────────────────────

// Подписывают КАЖДУЮ оказанную услугу — это акт, а не чек-лист. Галочка ☐ не
// говорит, КТО подтвердил, и подшитый акт с галочками ничего не доказывает.
test('в таблице услуг место для подписи, а не галочка', () => {
  const html = act();
  assert.match(html, /Подпись/, 'колонка подписи в шапке');
  assert.doesNotMatch(html, /☐/, 'пустой галочки нет');
  assert.doesNotMatch(html, />✓</, 'и в шапке галочки нет');
});

// Дату бланк проставляет сам (issueDate вверху). Место, чтобы вписать её
// рукой, — приглашение к расхождению между двумя датами на одном документе.
test('места для даты от руки нет', () => {
  const at = act().indexOf('ACT_PROTOCOL_SIGN_V1');
  assert.notEqual(at, -1, 'блок подписей на месте');
  assert.doesNotMatch(act().slice(at), />Дата</, 'в блоке подписей даты не осталось');
});

// На A4 очередь — компактная плашка со скруглением, прижатая влево. Прежде
// сюда бралась вёрстка чека (58 мм): всё по центру, номер в 40px во всю
// ширину листа.
test('очередь — компактная плашка со скруглением, прижата влево', () => {
  const html = act({ queue: [{ service: 'CA 15-3 (Онкомаркер)', label: 'Лаборатория', number: 28 }] });
  const at = html.indexOf('Номер очереди');
  assert.notEqual(at, -1, 'блок на месте');
  const box = html.slice(at, at + 900);
  assert.match(box, /border-radius/, 'угол скруглён');
  assert.doesNotMatch(box, /text-align:\s*center/, 'ничего не центрируется');
  assert.doesNotMatch(box, /font-size:\s*40px/, 'номер не во весь лист');
});
