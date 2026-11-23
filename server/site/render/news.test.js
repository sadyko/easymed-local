// WEBSITE_V1 (W4) — новости/блог: проверка ленты, карточки статьи и правила W4-R2 (пункт меню
// «Новости» появляется только когда есть хоть одна опубликованная новость).
import test from 'node:test';
import assert from 'node:assert/strict';
import { startSite } from '../app.test.js';
import { seedSite } from '../../test-helpers/site-seed.js';
import { invalidateContentCache } from '../content.js';

// WEBSITE_V1 (Easy-Med, этап 1) — в Chilla новость заводилась через RPC
// админки (website_content_save / _publish / _list); админка сайта — следующий
// этап, её RPC здесь ещё нет. Поэтому строка website_posts пишется напрямую —
// в том виде, в каком её оставляет публикация (published=1, published_at).
// Возвращает строку со слагом, как прежде list().
let postSeq = 0;
function insertPost(db, contentRu, published) {
  postSeq += 1;
  const slug = 'post-' + postSeq;
  const id = Number(db.prepare(`INSERT INTO website_posts (published, slug, content, published_at)
    VALUES (?, ?, ?, CASE WHEN ? = 1 THEN strftime('%Y-%m-%dT%H:%M:%SZ','now') END)`)
    .run(published ? 1 : 0, slug, JSON.stringify({ ru: contentRu }), published ? 1 : 0).lastInsertRowid);
  invalidateContentCache();
  return { id, slug };
}
function publishPost(db, contentRu) { return insertPost(db, contentRu, true); }

test('список новостей: показывает опубликованную, заголовок и анонс', async () => {
  const { server, base, db } = await startSite(seedSite);
  invalidateContentCache();
  try {
    publishPost(db, { title: 'Открытие нового отделения', excerpt: 'Мы расширяемся', body: 'Текст.' });
    const res = await fetch(base + '/ru/news');
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Открытие нового отделения/);
    assert.match(html, /Мы расширяемся/);
  } finally { server.close(); }
});

test('страница новости: 200, текст статьи по абзацам, Article JSON-LD', async () => {
  const { server, base, db } = await startSite(seedSite);
  invalidateContentCache();
  try {
    const post = publishPost(db, {
      title: 'Новое оборудование', excerpt: 'Кратко', body: 'Первый абзац.\n\nВторой абзац.',
    });
    const res = await fetch(base + '/ru/news/' + post.slug);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /<h1[^>]*>Новое оборудование<\/h1>/);
    assert.match(html, /Первый абзац\./);
    assert.match(html, /Второй абзац\./);
    assert.match(html, /"@type":"Article"/);
    assert.match(html, /"headline":"Новое оборудование"/);
  } finally { server.close(); }
});

test('неопубликованная новость и неизвестный слаг — 404', async () => {
  const { server, base, db } = await startSite(seedSite);
  invalidateContentCache();
  try {
    const row = insertPost(db, { title: 'Черновик', excerpt: '', body: '' }, false);

    const res = await fetch(base + '/ru/news/' + row.slug);
    assert.equal(res.status, 404, 'неопубликованная новость недоступна по своему слагу');

    const res2 = await fetch(base + '/ru/news/nobody');
    assert.equal(res2.status, 404);
  } finally { server.close(); }
});

test('навигация: ссылка «Новости» появляется только после публикации хотя бы одной новости (W4-R2)', async () => {
  const { server, base, db } = await startSite(seedSite);
  invalidateContentCache();
  try {
    const before = await fetch(base + '/ru/');
    const beforeHtml = await before.text();
    assert.ok(!beforeHtml.includes('/ru/news'), 'до первой публикации пункта меню нет вовсе');

    publishPost(db, { title: 'Первая новость', excerpt: '', body: '' });

    const after = await fetch(base + '/ru/');
    const afterHtml = await after.text();
    assert.match(afterHtml, /href="\/ru\/news"/, 'после публикации пункт меню появился');
  } finally { server.close(); }
});
