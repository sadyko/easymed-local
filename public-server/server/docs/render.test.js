// API_DOCS_V1 — страница документации сама по себе: целая (ничего со стороны,
// без скриптов), доступная (язык, заголовки, якоря, таблицы, фокус), с
// телефона и на печать, без ключей и чисел мимо docs/facts.js; на узбекском и
// английском — ни одного русского слова вне примеров.
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderDocs, DOCS_PAGE_LANGS, withUnit, listOf } from './render.js';
import { SECTIONS, ENDPOINTS, PAGE, SAMPLE } from './content.js';
import { KEY_RE, SECRET_RE } from '../../../public/js/shared/api-connections.js';

const pages = Object.fromEntries(DOCS_PAGE_LANGS.map((l) => [l, renderDocs({ lang: l })]));
const textOf = (html) => html.replace(/<style>[\s\S]*?<\/style>/g, '').replace(/<pre[\s\S]*?<\/pre>/g, '').replace(/<[^>]+>/g, ' ');

test('единицы и списки: падеж по числу на трёх языках', () => {
  assert.deepEqual([1, 2, 5, 11, 21, 24, 107].map((n) => withUnit(n, 'hour', 'ru')),
    ['1 час', '2 часа', '5 часов', '11 часов', '21 час', '24 часа', '107 часов']);
  assert.deepEqual([withUnit(1, 'min', 'en'), withUnit(30, 'min', 'en'), withUnit(30, 'min', 'uz')], ['1 minute', '30 minutes', '30 daqiqa']);
  assert.equal(listOf([1, 5, 10, 30, 60], 'ru'), '1, 5, 10, 30 и 60');
  assert.equal(listOf([7, 14, 30], 'uz', true), '7, 14 yoki 30');
  assert.equal(listOf([3, 6, 12], 'en', true), '3, 6 or 12');
});

test('целая страница: язык, заголовок, канонический адрес и переводы; ни скриптов, ни файлов со стороны', () => {
  for (const [lang, html] of Object.entries(pages)) {
    assert.ok(html.startsWith('<!doctype html><html lang="' + lang + '">'), lang);
    assert.ok(html.includes('<meta name="viewport" content="width=device-width, initial-scale=1">'));
    assert.ok(html.includes('<title>' + PAGE.title[lang] + '</title>'));
    assert.ok(html.includes('<link rel="canonical" href="' + SAMPLE.base + (lang === 'ru' ? '/docs' : '/docs/' + lang) + '">'));
    for (const l of DOCS_PAGE_LANGS) assert.ok(html.includes('hreflang="' + l + '"'));
    assert.ok(!/<script|<img|<iframe|<link rel="stylesheet"|@import|url\(/i.test(html), lang + ': что-то грузится со стороны');
    for (const m of html.matchAll(/(?:href|src)="([^"]*)"/g)) {
      assert.ok(/^(#[a-z0-9-]+|\/docs(\/(uz|en))?|mailto:[^"]+|https:\/\/api\.easymed\.uz\/docs(\/(uz|en))?)$/.test(m[1]), lang + ': ссылка ' + m[1]);
    }
    assert.ok(!html.includes('{{'), lang + ': число без docs/facts.js');
  }
});

test('доступность: один h1, разделы с h2 и якорем, адреса с h3, все якоря есть, таблицы и код — с клавиатуры', () => {
  for (const [lang, html] of Object.entries(pages)) {
    assert.equal((html.match(/<h1>/g) || []).length, 1);
    assert.ok(html.includes('<a class="skip" href="#main">') && html.includes('<main id="main">'));
    assert.match(html, new RegExp('<a href="/docs' + (lang === 'ru' ? '' : '/' + lang) + '" hreflang="' + lang + '" lang="' + lang + '" aria-current="page">'));
    for (const s of SECTIONS) assert.ok(html.includes('<section id="' + s.id + '" aria-labelledby="' + s.id + '-h"><h2 id="' + s.id + '-h">'), s.id);
    for (const e of ENDPOINTS) assert.ok(html.includes('<h3 id="ep-' + e.id + '-h">'), e.id);
    const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
    assert.equal(new Set(ids).size, ids.length, 'id повторяется');
    for (const m of html.matchAll(/href="#([^"]+)"/g)) assert.ok(ids.includes(m[1]), lang + ': якоря нет — #' + m[1]);
    assert.ok(!/<pre(?! tabindex="0")/.test(html), 'код прокручивается с клавиатуры');
    assert.ok(!/<div class="tw"(?! role="region" tabindex="0" aria-label=")/.test(html), 'таблица прокручивается с клавиатуры');
    assert.ok(!/<th(?=[\s>])(?! scope="col")/.test(html), 'заголовок столбца — scope');
  }
});

test('телефон и печать: колонка сужается до экрана, широкое прокручивается внутри, печать без навигации', () => {
  const css = /<style>([\s\S]*?)<\/style>/.exec(pages.ru)[1];
  for (const s of ['grid-template-columns:minmax(0,1fr)', '.tw{overflow-x:auto', 'pre{', 'overflow:auto', '@media print{', 'nav.toc,.skip{display:none}',
    '@media (prefers-color-scheme:dark)', 'td code{overflow-wrap:normal}']) assert.ok(css.includes(s), s);
  for (const px of css.match(/font[^;}]*?(\d+(?:\.\d+)?)px/g) || []) {
    assert.ok(/(12\.5|13\.5|15|17|20|24|30)px/.test(px), 'размер не со шкалы: ' + px);
  }
});

// API_DOCS_V1 — таблицы на телефоне: уже 600 px строка таблицы — блоком, над каждым
// значением — подпись его столбца (data-label, только CSS); на широком экране и в
// печати — обычная таблица. Глазами (Playwright, 320 и 360 px) проверено, что ни
// одна таблица не прокручивается вбок и «Что делать» видно сразу.
test('таблицы на телефоне: у каждой ячейки — подпись своего столбца; уже 600 px строка — блоком с подписями, на широком экране и в печати — таблица', () => {
  for (const [lang, html] of Object.entries(pages)) {
    const tables = [...html.matchAll(/<table>([\s\S]*?)<\/table>/g)].map((m) => m[1]);
    assert.ok(tables.length >= 20, lang + ': таблиц ' + tables.length);
    let cells = 0;
    for (const tb of tables) {
      const head = [...tb.matchAll(/<th scope="col">([\s\S]*?)<\/th>/g)].map((m) => m[1].replace(/<[^>]+>/g, ''));
      const rows = [.../<tbody>([\s\S]*)<\/tbody>/.exec(tb)[1].matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((m) => m[1]);
      assert.ok(head.length >= 2 && rows.length >= 1, lang + ': ' + head.join(' | '));
      for (const row of rows) {
        const labels = [...row.matchAll(/<td(?: data-label="([^"]*)")?>/g)].map((m) => m[1]);
        assert.deepEqual(labels, head, lang + ': подпись ячейки — заголовок её столбца');
        cells += labels.length;
      }
    }
    assert.ok(cells >= 300, lang + ': ячеек ' + cells);
  }
  const css = /<style>([\s\S]*?)<\/style>/.exec(pages.ru)[1];
  const narrow = /@media screen and \(max-width:599\.98px\)\{((?:[^{}]*\{[^{}]*\})*)\}/.exec(css);
  assert.ok(narrow, 'узкий экран — своя таблица, печать — нет (media screen)');
  for (const s of ['.tw table,.tw thead,.tw tbody,.tw tr,.tw th,.tw td{display:block}', '.tw thead{position:absolute', 'clip-path:inset(50%)',
    '.tw td::before{content:attr(data-label)']) assert.ok(narrow[1].includes(s), s);
  assert.ok(!/display:none/.test(narrow[1]), 'заголовки скрыты только глазу — программа чтения с экрана их читает');
  assert.ok(!css.replace(narrow[0], '').includes('data-label'), 'на широком экране и в печати подписей над ячейками нет');
});

test('ни ключа, ни секрета: только переменная $EASYMED_KEY и обрезанные em_live_… / em_whsec_…', () => {
  for (const html of Object.values(pages)) {
    for (const w of html.split(/[\s"'<>`]+/)) assert.ok(!KEY_RE.test(w) && !SECRET_RE.test(w), 'похоже на ключ: ' + w.slice(0, 12));
    assert.ok(!/\bem_(?:live|whsec)_[A-Za-z0-9]{8,}/.test(html));
    assert.ok(html.includes('Bearer ' + SAMPLE.keyVar));
  }
});

test('узбекская и английская страницы: русского текста нет нигде, кроме названия языка в переключателе', () => {
  for (const lang of ['uz', 'en']) {
    const words = textOf(pages[lang]).match(/\S*[А-Яа-яЁё]\S*/g) || [];
    assert.deepEqual([...new Set(words)], ['Русский'], lang);
  }
});
