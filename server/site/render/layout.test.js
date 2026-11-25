import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { esc, page } from './layout.js';
import { invalidateContentCache } from '../content.js';

test('esc обезвреживает HTML', () => {
  assert.equal(esc(`<img src=x onerror="a('b')">`), '&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;');
});

test('page: полный документ с hreflang, языком и без утечек', () => {
  const db = openDb(':memory:'); migrate(db); invalidateContentCache();
  const html = page({ db, lang: 'ru', path: '/ru/doctors', title: 'Врачи <script>', description: 'x', body: '<p>тело</p>' });
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<html lang="ru"/);
  assert.match(html, /name="viewport" content="width=device-width, initial-scale=1"/,
    'мобильный viewport обязателен — 90% посетителей с телефона');
  assert.match(html, /hreflang="uz"/);
  assert.match(html, /hreflang="en"/);
  assert.match(html, /hreflang="x-default"/);
  assert.ok(!html.includes('Врачи <script>'), 'title экранируется');
  assert.ok(html.includes('<p>тело</p>'), 'body вставляется как есть');
  assert.ok(!/admin|emsid|supabase/i.test(html), 'ничего внутреннего в разметке');
  db.close();
});

// W4-R3 — settings.analytics.inject_snippet: исключение №3 из ПРАВИЛА
// ЭКРАНИРОВАНИЯ (заголовок файла), тот же уровень доверия, что и у
// contact.map_embed (home.js/static-pages.js) — админ-ввод, вставляется как
// есть перед </body>, чтобы код аналитики реально выполнялся браузером.
test('page: код аналитики (analytics.inject_snippet) вставляется как есть перед </body>', () => {
  const db = openDb(':memory:'); migrate(db);
  const snippet = '<script>window.ga=1;/* GA */</script>';
  db.prepare(`UPDATE website_settings SET settings = ? WHERE id = 1`)
    .run(JSON.stringify({ analytics: { inject_snippet: snippet } }));
  invalidateContentCache();

  const html = page({ db, lang: 'ru', path: '/ru/', title: 'Главная', body: '<p>тело</p>' });
  assert.ok(html.includes(snippet), 'снипет присутствует дословно');
  assert.ok(html.indexOf(snippet) < html.indexOf('</body>'), 'снипет стоит перед закрытием body');
  db.close();
});

test('page: без analytics.inject_snippet ничего лишнего перед </body> не появляется', () => {
  const db = openDb(':memory:'); migrate(db); invalidateContentCache();
  const html = page({ db, lang: 'ru', path: '/ru/', title: 'Главная', body: '<p>тело</p>' });
  assert.match(html, /<script src="\/assets\/site\.js" defer><\/script>\n<\/body>/,
    'пустая настройка — сразу закрытие body, ничего не вставлено');
  db.close();
});
