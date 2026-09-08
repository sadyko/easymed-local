// CASE_DOC_A4_V1 — санитария разметки документа: что остаётся и что уходит.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeStoredHtml, htmlToText, richIsEmpty } from './rich-text.js';

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
