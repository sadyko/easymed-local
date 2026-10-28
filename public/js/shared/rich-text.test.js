// CASE_DOC_A4_V1 — санитария разметки документа: что остаётся и что уходит.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeStoredHtml, htmlToText, richIsEmpty, hasMarkup } from './rich-text.js';

test('оформление врача остаётся: жирный, курсив, списки, абзацы, таблица результатов', () => {
  const html = '<p>Жалобы на <b>боль</b> и <i>слабость</i></p><ul><li>первое</li><li>второе</li></ul>'
    + '<table class="a4-restbl"><thead><tr><th>Показатель</th><th>Значение</th></tr></thead>'
    + '<tbody><tr><td>HGB</td><td>140</td></tr></tbody></table>';
  assert.equal(sanitizeStoredHtml(html), html);
  assert.equal(sanitizeStoredHtml('<span style="color: #b91c1c; font-weight: 700">выше нормы</span>'),
    '<span style="color: #b91c1c; font-weight: 700">выше нормы</span>');
});

test('скрипт уходит ВМЕСТЕ С СОДЕРЖИМЫМ, обработчики и ссылки — вырезаны', () => {
  assert.equal(sanitizeStoredHtml('до<script>alert(1)</script>после'), 'допосле');
  assert.equal(sanitizeStoredHtml('<div onclick="steal()">текст</div>'), '<div>текст</div>');
  assert.equal(sanitizeStoredHtml('<a href="javascript:alert(1)">ссылка</a>'), 'ссылка', 'тег не в списке — вырезан, текст остался');
  assert.equal(sanitizeStoredHtml('<img src=x onerror=alert(1)>'), '');
  assert.equal(sanitizeStoredHtml('<iframe src="http://evil"></iframe>x'), 'x');
  assert.equal(sanitizeStoredHtml('<style>body{display:none}</style>текст'), 'текст');
  assert.equal(sanitizeStoredHtml('<!-- комментарий -->текст'), 'текст');
});

test('style пропускает только оформление и не пропускает url() и выражения', () => {
  assert.equal(sanitizeStoredHtml('<span style="background-color: #fef08a">жёлтым</span>'),
    '<span style="background-color: #fef08a">жёлтым</span>');
  assert.equal(sanitizeStoredHtml('<span style="background: url(http://evil/x.png)">x</span>'), '<span>x</span>');
  assert.equal(sanitizeStoredHtml('<span style="width: expression(alert(1))">x</span>'), '<span>x</span>');
  assert.equal(sanitizeStoredHtml('<div class="a4-restbl secret">x</div>'), '<div class="a4-restbl">x</div>');
});

test('пустое остаётся пустым, а не превращается в разметку', () => {
  assert.equal(sanitizeStoredHtml(''), '');
  assert.equal(sanitizeStoredHtml(null), '');
  assert.equal(sanitizeStoredHtml(undefined), '');
  assert.equal(richIsEmpty('<p><br></p>'), true);
  assert.equal(richIsEmpty('<p>текст</p>'), false);
});

test('htmlToText читается человеком: переносы вместо тегов, сущности расшифрованы', () => {
  assert.equal(htmlToText('<p>Первая</p><p>Вторая</p>'), 'Первая\nВторая');
  assert.equal(htmlToText('строка<br>вторая'), 'строка\nвторая');
  assert.equal(htmlToText('<ul><li>раз</li><li>два</li></ul>'), 'раз\nдва');
  assert.equal(htmlToText('5 &lt; 7 &amp; 8 &gt; 6'), '5 < 7 & 8 > 6');
  assert.equal(htmlToText('<script>alert(1)</script>текст'), 'текст');
  assert.equal(htmlToText('  '), '');
});

// ─── DOC_RICH_FORMAT_V1 — оформление кабинета врача хранится и показывается ───

test('DOC_RICH_FORMAT_V1 (F4): размер — только ключевыми словами, подчёркивание — и text-decoration-line', () => {
  for (const kw of ['x-small', 'small', 'medium', 'large', 'x-large', 'xx-large']) {
    assert.equal(sanitizeStoredHtml(`<span style="font-size: ${kw};">x</span>`), `<span style="font-size: ${kw}">x</span>`, kw);
  }
  // пиксели, проценты и расширения браузера — не размер документа
  assert.equal(sanitizeStoredHtml('<span style="font-size: 40px">x</span>'), '<span>x</span>');
  assert.equal(sanitizeStoredHtml('<span style="font-size: -webkit-xxx-large">x</span>'), '<span>x</span>');
  assert.equal(sanitizeStoredHtml('<span style="text-decoration-line: underline;">x</span>'), '<span style="text-decoration-line: underline">x</span>');
  // так Chrome пишет цвет и подсветку со styleWithCSS
  assert.equal(sanitizeStoredHtml('<span style="color: rgb(25, 113, 194); background-color: rgb(255, 243, 191);">x</span>'),
    '<span style="color: rgb(25, 113, 194); background-color: rgb(255, 243, 191)">x</span>');
});

test('DOC_RICH_FORMAT_V1 (F4): прежний <font color|size> становится span style; плохой цвет и размер отбрасываются', () => {
  assert.equal(sanitizeStoredHtml('<font color="#1971c2">синий</font>'), '<span style="color: #1971c2">синий</span>');
  assert.equal(sanitizeStoredHtml('<font size="5">крупно</font>'), '<span style="font-size: x-large">крупно</span>');
  assert.equal(sanitizeStoredHtml('<font size="2" color="red">мелко</font>'), '<span style="color: red; font-size: small">мелко</span>');
  assert.equal(sanitizeStoredHtml('<font size="1">a</font><font size="7">b</font>'), '<span style="font-size: x-small">a</span><span style="font-size: xx-large">b</span>');
  assert.equal(sanitizeStoredHtml('<font color="rgb(1, 2, 3)">a</font>'), '<span style="color: rgb(1, 2, 3)">a</span>');
  assert.equal(sanitizeStoredHtml('<font color="expression(alert(1))" size="9">a</font>'), '<span>a</span>');
  assert.equal(sanitizeStoredHtml('<font color="javascript:alert(1)" face="Arial" onclick="x()">a</font>'), '<span>a</span>');
  assert.equal(sanitizeStoredHtml('<font color="#zzz">a</font>'), '<span>a</span>');
});

test('DOC_RICH_FORMAT_V1 (F6/F7): класс таблицы a4-tbl проходит, как a4-restbl', () => {
  const t = '<table class="a4-tbl"><tbody><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></tbody></table>';
  assert.equal(sanitizeStoredHtml(t), t);
  assert.equal(sanitizeStoredHtml('<table class="a4-tbl evil a4-restbl"><tr><td>x</td></tr></table>'), '<table class="a4-tbl a4-restbl"><tr><td>x</td></tr></table>');
});

test('DOC_RICH_FORMAT_V1: «<» без конца тега в тексте экранируется — следующий тег страницы не достраивает его', () => {
  // Без «>» тег не распознавался и уходил сырым текстом; за ним в листе идёт
  // «</div>», и браузер дочитывал <img … onerror=…> до него.
  const out = sanitizeStoredHtml('текст <img src=x onerror=alert(1)//');
  assert.ok(!/<img/i.test(out), out);
  assert.equal(out, 'текст &lt;img src=x onerror=alert(1)//');
  assert.equal(sanitizeStoredHtml('SpO2 <95% и 5 > 3'), 'SpO2 &lt;95% и 5 &gt; 3');
  assert.equal(sanitizeStoredHtml('<b>a</b> < <i>b</i>'), '<b>a</b> &lt; <i>b</i>');
  // кавычка без пары тоже не даёт тегу съесть остаток
  assert.ok(!/<img/i.test(sanitizeStoredHtml('<img src="x onerror=alert(1)>')), 'незакрытая кавычка');
  assert.equal(htmlToText(sanitizeStoredHtml('SpO2 <95%')), 'SpO2 <95%');
});

test('DOC_RICH_FORMAT_V1 (F8): таблица в тексте — ячейки через табуляцию, строки — через перевод строки', () => {
  const t = '<table class="a4-restbl"><thead><tr><th>Показатель</th><th>Значение</th></tr></thead>'
    + '<tbody><tr><td>HGB</td><td>140</td></tr><tr><td>WBC</td><td>6,1</td></tr></tbody></table>';
  assert.equal(htmlToText(t), 'Показатель\tЗначение\nHGB\t140\nWBC\t6,1');
  assert.equal(htmlToText('<div><b>ОАК:</b></div>' + t), 'ОАК:\nПоказатель\tЗначение\nHGB\t140\nWBC\t6,1');
  assert.equal(htmlToText('до' + t + 'после'), 'до\nПоказатель\tЗначение\nHGB\t140\nWBC\t6,1\nпосле');
});

test('DOC_RICH_FORMAT_V1 (F8): пустые теги — пусто; список и таблица без текста — пусто', () => {
  assert.equal(richIsEmpty('<ul><li><br></li></ul>'), true);
  assert.equal(richIsEmpty('<table class="a4-tbl"><tr><th></th><th><br></th></tr><tr><td></td><td></td></tr></table>'), true);
  assert.equal(richIsEmpty('<div><br></div><div>&nbsp;</div>'), true);
  assert.equal(richIsEmpty('<table><tr><td>1</td></tr></table>'), false);
  assert.equal(richIsEmpty('<ol><li>пункт</li></ol>'), false);
});

test('DOC_RICH_FORMAT_V1: строки Chrome («код<div>текст</div>») — строки, а не склейка; список — строками', () => {
  assert.equal(htmlToText('код<div>текст</div>'), 'код\nтекст');
  assert.equal(htmlToText('а<div><br></div><div>б</div>'), 'а\n\nб');
  assert.equal(htmlToText('строка1<br><div>строка2</div>'), 'строка1\nстрока2');
  assert.equal(htmlToText('Живот:<ul><li>мягкий</li><li>безболезненный</li></ul>Печень у края'), 'Живот:\nмягкий\nбезболезненный\nПечень у края');
  assert.equal(htmlToText('<p>текст</p><ol><li>раз</li></ol>'), 'текст\nраз');
  // «&amp;lt;» — это набранное «&lt;», а не «<»
  assert.equal(htmlToText('&amp;lt;'), '&lt;');
});

test('DOC_RICH_FORMAT_V1: hasMarkup — разметка документа, а не любой «<» в тексте', () => {
  assert.equal(hasMarkup('<ul><li>a</li></ul>'), true);
  assert.equal(hasMarkup('a<br>b'), true);
  assert.equal(hasMarkup('<span style="color: red">x</span>'), true);
  assert.equal(hasMarkup('<font color="red">x</font>'), true);
  assert.equal(hasMarkup('<table class="a4-restbl"><tr><td>x</td></tr></table>'), true);
  assert.equal(hasMarkup('SpO2 <95%'), false);
  assert.equal(hasMarkup('a < b > c'), false);
  assert.equal(hasMarkup('мелкий <b шрифт'), false, 'тег без «>» — не разметка');
  assert.equal(hasMarkup(''), false);
  assert.equal(hasMarkup(null), false);
});
