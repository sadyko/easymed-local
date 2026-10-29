// CASE_DOC_A4_V1 — санитария разметки документа: что остаётся и что уходит.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeStoredHtml, htmlToText, richIsEmpty, hasMarkup, textBreaks, richHasContent, textIsBlank } from './rich-text.js';

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

// ─── DOC_RICH_FORMAT_V1 — ревью T1 ───────────────────────────────────────────

// Значение style атрибута в выходе: ни «&», ни «\», ни «/», ни url( — браузеру
// нечего расшифровывать или дочитывать.
const styleValues = (html) => [...html.matchAll(/style="([^"]*)"/g)].map((m) => m[1]);
const assertStyleClean = (html, where) => {
  for (const v of styleValues(html)) {
    assert.ok(!/[&\\/]|url|expression|import|position|inset|background-image|content/i.test(v), where + ': ' + v);
  }
};

test('ревью T1 (HIGH 1): style не обходится сущностями, экранированием CSS и комментариями', () => {
  const bypass = [
    // сущность без «;» — это «;» и «u» для браузера (так был обход)
    '<span style="color: red&#59 position: fixed&#59 inset: 0&#59 background-image: &#117rl(http://127.0.0.1:9/x)">x</span>',
    '<span style="color: red&#x3b background-image: &#x75rl(file:///C:/Windows/win.ini)">x</span>',
    '<span style="color: red&semi; background-image: url(http://e)">x</span>',
    '<span style="color: rgb&#40;1,2,3&#41;">x</span>',                                     // «(» и «)» сущностями
    '<span style="background-color: \\75 rl(http://127.0.0.1/x)">x</span>',                 // экранирование CSS
    '<span style="color: \\72 ed">x</span>',
    '<span style="color: re/**/d; background-color: y/**/ellow">x</span>',                 // комментарии
    '<span style="color: expression(alert(1))">x</span>',
    '<span style="color: red; @import url(http://e/x.css)">x</span>',
    '<span style="font-weight: 700&#59 content: &#34hi&#34">x</span>',
    '<span style="color: var(--x)">x</span>',                                               // функции, кроме цвета
    '<span style="background-color: image-set(x 1x)">x</span>',
    '<span style="color: red&#0;">x</span>',
  ];
  for (const raw of bypass) {
    const out = sanitizeStoredHtml(raw);
    assertStyleClean(out, raw);
    assert.ok(/^<span( style="[^"]*")?>x<\/span>$/.test(out), raw + ' → ' + out);
  }
  // то, что пишет Chrome со styleWithCSS, проходит как прежде
  assert.equal(sanitizeStoredHtml('<span style="color: rgb(25, 113, 194); font-weight: bold; text-decoration-line: underline line-through; text-align: center; background-color: hsla(50, 100%, 87%, 0.5);">x</span>'),
    '<span style="color: rgb(25, 113, 194); font-weight: bold; text-decoration-line: underline line-through; text-align: center; background-color: hsla(50, 100%, 87%, 0.5)">x</span>');
  assert.equal(sanitizeStoredHtml('<span style="color: #1971c2">x</span>'), '<span style="color: #1971c2">x</span>');
});

test('ревью T1 (HIGH 2): «&», не начинающий сущность, экранируется; сущности остаются; очистка стабильна', () => {
  assert.equal(sanitizeStoredHtml('AT&T, ЧСС > 90'), 'AT&amp;T, ЧСС &gt; 90');
  assert.equal(sanitizeStoredHtml('a &copy b'), 'a &amp;copy b');
  assert.equal(sanitizeStoredHtml('a &amp; b &lt;c&gt; &nbsp; &#39;'), 'a &amp; b &lt;c&gt; &nbsp; &#39;');
  for (const s of ['SpO2 <95%', 'AT&T', '&amp;amp;', 'a<b', '<b>x</b> & y', 'x &lt; y && z']) {
    const once = sanitizeStoredHtml(s);
    assert.equal(sanitizeStoredHtml(once), once, 'второй проход изменил: ' + s);
  }
  assert.equal(htmlToText(sanitizeStoredHtml('AT&T, ЧСС > 90')), 'AT&T, ЧСС > 90');
  assert.equal(htmlToText(sanitizeStoredHtml('&amp;amp;')), '&amp;');
});

test('ревью T1 (LOW 6): закрывающий тег без открытого выброшен, незакрытое закрыто, разметка стабильна', () => {
  assert.equal(sanitizeStoredHtml('<span style="color: red">a</font>b</span>'), '<span style="color: red">ab</span>');
  assert.equal(sanitizeStoredHtml('<b>a</font>b</b>'), '<b>ab</b>');
  assert.equal(sanitizeStoredHtml('<span>a<font color="red">b</span>c'), '<span>a<span style="color: red">b</span></span>c');
  assert.equal(sanitizeStoredHtml('</b></ul>текст'), 'текст');
  assert.equal(sanitizeStoredHtml('<b>жирный без конца'), '<b>жирный без конца</b>');
  assert.equal(sanitizeStoredHtml('<ul><li>a<li>b</ul>'), '<ul><li>a</li><li>b</li></ul>');
  assert.equal(sanitizeStoredHtml('<table><tr><td>1<td>2<tr><td>3</table>'), '<table><tr><td>1</td><td>2</td></tr><tr><td>3</td></tr></table>');
  for (const s of ['<b>a</font>b</b>', '<b>x', '<ul><li>a<li>b</ul>', '<i><b>x</i>y</b>', '<font color="red"><font size="5">x</font>']) {
    const once = sanitizeStoredHtml(s);
    assert.equal(sanitizeStoredHtml(once), once, 'второй проход изменил: ' + s);
  }
});

test('ревью T1 (MEDIUM 3): textBreaks — перевод строки текста — <br>, пробелы между блоками не трогаются', () => {
  assert.equal(textBreaks('<b>Почки</b>: норма\nПечень: норма'), '<b>Почки</b>: норма<br>Печень: норма');
  assert.equal(textBreaks('строка1\nстрока2'), 'строка1<br>строка2');
  assert.equal(textBreaks('<ul>\n<li>a</li>\n<li>b</li>\n</ul>'), '<ul>\n<li>a</li>\n<li>b</li>\n</ul>');
  assert.equal(textBreaks('<table>\n<tr>\n<td>1</td>\n</tr>\n</table>'), '<table>\n<tr>\n<td>1</td>\n</tr>\n</table>');
  assert.equal(textBreaks('a<br>\nb'), 'a<br>b', 'перевод строки после <br> — оформление исходника');
  assert.equal(textBreaks('<b>a</b>\n<i>b</i>'), '<b>a</b><br><i>b</i>');
  assert.equal(textBreaks(''), '');
});

test('ревью T1 (T3): richHasContent — текст или таблица (и пустая); richIsEmpty — по тексту', () => {
  const empty = '<table class="a4-tbl"><tbody><tr><th></th><th></th></tr><tr><td></td><td></td></tr></tbody></table>';
  assert.equal(richHasContent(empty), true);
  assert.equal(richIsEmpty(empty), true, 'F8: в тексте таблица без текста — пусто');
  assert.equal(richHasContent('<ul><li><br></li></ul>'), false);
  assert.equal(richHasContent('<div><br></div>'), false);
  assert.equal(richHasContent('текст'), true);
  assert.equal(richHasContent(''), false);
});

// ─── PRINT_SKIP_EMPTY_V1 — пустое не печатается ──────────────────────────────

test('PRINT_SKIP_EMPTY_V1: неразрывный пробел числовой записью (&#160;, &#xa0;) — пробел, а не текст', () => {
  assert.equal(htmlToText('a&#160;b'), 'a b');
  assert.equal(htmlToText('a&#xa0;b&#xA0;c&#0160;d'), 'a b c d');
  assert.equal(htmlToText('&#160;'), '');
  assert.equal(htmlToText('<p>&#xa0;</p>'), '');
  assert.equal(htmlToText('&amp;#160;'), '&#160;', 'набранное «&#160;» остаётся набранным');
  assert.equal(htmlToText('&#1601;'), '&#1601;', 'другая сущность не задета');
});

test('PRINT_SKIP_EMPTY_V1: richIsEmpty / richHasContent — &#160;, &#xa0; и невидимый пробел U+200B — пусто', () => {
  const EMPTY = ['&#160;', '&#xa0;', '<p>&#160;</p>', '<div>&#xa0;<br></div>', '\u200b', '<p>\u200b</p>',
    '<div>\u200b&nbsp;\u200b</div>', '\ufeff\u200c\u200d\u2060', '<p><br></p>&nbsp;', '<ul><li>\u200b</li></ul>'];
  for (const v of EMPTY) {
    assert.equal(richIsEmpty(v), true, JSON.stringify(v));
    assert.equal(richHasContent(v), false, JSON.stringify(v));
  }
  // текст рядом с невидимым знаком — текст; пустая таблица — по-прежнему содержание раздела
  assert.equal(richIsEmpty('\u200bПочки в норме'), false);
  assert.equal(richHasContent('<p>\u200b</p><table class="a4-tbl"><tr><td></td></tr></table>'), true);
  assert.equal(richIsEmpty('<p>\u200b</p><table class="a4-tbl"><tr><td></td></tr></table>'), true, 'F8: таблица без текста — не текст');
});

test('PRINT_SKIP_EMPTY_V1: textIsBlank — простой текст из пробелов, NBSP и невидимых знаков пуст', () => {
  for (const v of ['', null, undefined, '   ', '\u00a0', '\u200b', ' \u200b\u00a0\t\n', '\ufeff', '\u2060']) {
    assert.equal(textIsBlank(v), true, JSON.stringify(v));
  }
  for (const v of ['\u00ad', '\u200e', '\u200f', '\u180e', '\u2064']) {
    assert.equal(textIsBlank(v), true, JSON.stringify(v));
  }
  for (const v of ['0', 0, 'Муж.', '\u200b14.03.1989', '—']) assert.equal(textIsBlank(v), false, JSON.stringify(v));
});

test('PRINT_SKIP_EMPTY_V1: &#8203;, &#x200b; и &ZeroWidthSpace; — пусто', () => {
  for (const v of ['&#8203;', '&#X200B;', '&#x200b;', '&ZeroWidthSpace;', '<p>&#8203;</p>']) {
    assert.equal(richIsEmpty(v), true, v);
  }
  assert.equal(htmlToText('a&#8203;b'), 'ab');
  assert.equal(richIsEmpty('&amp;#8203;'), false, 'набранное остаётся набранным');
});
