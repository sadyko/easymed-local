// JOURNALS_V1_PRINT — «Печать» отчёта: страница из уже полученного ответа
// run_report — ВСЕ строки (не 300 предпросмотра), заголовок, период, здания,
// итог; альбомная, если колонок больше 8; данные экранированы.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reportPrintHtml, dmy, PRINT_PORTRAIT_MAX_COLS } from '../views/report-print.js';

const DICT = { 'Итого': 'Итого', 'Период: {from} — {to}': 'Период: {from} — {to}', 'Здания: {list}': 'Здания: {list}', 'Филиалы: {list}': 'Филиалы: {list}' };
const tx = { tr: (s) => DICT[s] || s, trf: (t, p) => String(DICT[t] || t).replace(/\{(\w+)\}/g, (_, k) => String(p[k])), lang: 'ru', monthName: () => '' };
const many = (n) => Array.from({ length: n }, (_, i) => ['Пациент ' + (i + 1), 1000 * (i + 1)]);

test('ВСЕ строки ответа, заголовок, период дд.мм.гггг, итог по складываемым колонкам', () => {
  const r = { columns: ['Пациент', 'Сумма оплаты'], rows: many(350), summable_columns: ['Сумма оплаты'] };
  const html = reportPrintHtml(r, { title: 'Реестр стационарных пациентов', from: '2026-10-01', to: '2026-10-02', places: { kind: 'buildings', list: [] } }, tx);
  assert.equal((html.match(/<tr>/g) || []).length, 1 + 350 + 1, 'шапка + 350 строк + итог');
  assert.ok(html.includes('<td>Пациент 350</td>'));
  assert.match(html, /<h1>Реестр стационарных пациентов<\/h1>/);
  assert.ok(html.includes('Период: 01.10.2026 — 02.10.2026'));
  assert.ok(!html.includes('Здания:'), 'здания не выбирали — строки о них нет');
  assert.ok(html.includes('<tfoot>') && html.includes(Number(350 * 351 / 2 * 1000).toLocaleString('ru-RU')));
  assert.match(html, /window\.print\(\)/);
});

test('без складываемых колонок итога нет; выбранные здания или филиалы — строкой под заголовком', () => {
  const r = { columns: ['ФИО', 'Услуга'], rows: [['Азизов', 'ЭКГ']], summable_columns: [] };
  const a = reportPrintHtml(r, { title: 'Журнал услуг', from: '2026-03-01', to: '2026-03-31', places: { kind: 'buildings', list: ['Главное', 'Филиал B'] } }, tx);
  assert.ok(!a.includes('<tfoot>'));
  assert.ok(a.includes('Здания: Главное, Филиал B'));
  const b = reportPrintHtml(r, { title: 'Журнал услуг', from: '2026-03-01', to: '2026-03-31', places: { kind: 'branches', list: ['Чиланзар'] } }, tx);
  assert.ok(b.includes('Филиалы: Чиланзар'));
});

test('больше 8 колонок — альбомный лист; 8 и меньше — книжный', () => {
  assert.equal(PRINT_PORTRAIT_MAX_COLS, 8);
  const cols = (n) => Array.from({ length: n }, (_, i) => 'К' + i);
  const meta = { title: 'Т', from: '2026-10-01', to: '2026-10-01' };
  assert.match(reportPrintHtml({ columns: cols(8), rows: [cols(8)] }, meta, tx), /size: A4 portrait/);
  assert.match(reportPrintHtml({ columns: cols(9), rows: [cols(9)] }, meta, tx), /size: A4 landscape/);
});

test('данные клиники не вставляются как HTML: заголовок, ячейки и здания экранированы', () => {
  const html = reportPrintHtml({ columns: ['ФИО', 'Заключение'], rows: [['<img src=x onerror=alert(1)>', 'A & B "C"']] },
    { title: '<script>alert(2)</script>', from: '2026-10-01', to: '2026-10-02', places: { kind: 'buildings', list: ['Здание <b>2</b>'] } }, tx);
  assert.ok(!html.includes('<img src=x'));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(!html.includes('<script>alert(2)'));
  assert.ok(html.includes('&lt;script&gt;alert(2)&lt;/script&gt;'));
  assert.ok(html.includes('A &amp; B &quot;C&quot;'));
  assert.ok(html.includes('Здания: Здание &lt;b&gt;2&lt;/b&gt;'));
});

// Заключение на экране обрезано до 300 знаков (clipPreviewText), а на бумаге —
// целиком; слова-перечисления и заголовки — на языке экрана, как в Excel.
test('печать: длинное заключение целиком, заголовки и слова-перечисления — на языке экрана', () => {
  const en = { 'Пол': 'Sex', 'Муж.': 'Male', 'Заключение': 'Conclusion' };
  const txEn = { tr: (s) => en[s] || s, trf: (t, p) => String(t).replace(/\{(\w+)\}/g, (_, k) => String(p[k])), lang: 'en', monthName: () => '' };
  const long = 'Печень увеличена. '.repeat(40);
  const html = reportPrintHtml({ columns: ['Пол', 'Заключение'], rows: [['Муж.', long]] }, { title: 'Service journal', from: '2026-10-01', to: '2026-10-02' }, txEn);
  assert.ok(html.includes(long.trim()), 'заключение обрезано на печати');
  assert.ok(html.includes('<th>Sex</th>') && html.includes('<td>Male</td>'));
  assert.match(html, /<html lang="en">/);
});

test('dmy: ГГГГ-ММ-ДД → дд.мм.гггг; прочее — как есть', () => {
  assert.equal(dmy('2026-10-02'), '02.10.2026');
  assert.equal(dmy('2026-10-02T07:00:00Z'), '02.10.2026');
  assert.equal(dmy(''), '');
  assert.equal(dmy('вчера'), 'вчера');
});

// Проверка в браузере (02.10): с overflow-wrap: anywhere у ячеек минимальная
// ширина колонки — одна буква, длинное заключение забирает весь лист, и имена
// рвутся по буквам («Карим / ов»). break-word ломает только слово, которое не
// влезает, и не сжимает колонки до буквы.
test('печать: слова в узких колонках не рвутся по буквам', () => {
  const html = reportPrintHtml({ columns: ['ФИО', 'Заключение'], rows: [['Каримов Алишер', 'Х '.repeat(300)]] }, { title: 'Т', from: '2026-10-01', to: '2026-10-01' }, tx);
  assert.doesNotMatch(html, /overflow-wrap:\s*anywhere/);
  assert.match(html, /\.rp-tbl td \{[^}]*overflow-wrap: break-word;/);
});
