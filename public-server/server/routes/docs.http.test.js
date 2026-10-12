// API_DOCS_V1 — /docs в приложении публичного сервера: страница без ключа на
// трёх языках, свои заголовки кэша и защиты, перенаправления на один адрес,
// адрес сервера и срок не забранной заявки — из настроек службы; адреса
// клиник и служебные адреса не задеты.
import test from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import { createPublicServer } from '../app.js';
import { testDb, testVendor, NOW } from '../test-helpers/fixture.js';
import { listen } from '../../../control-plane/server/test-helpers/listen.js';
import { DOCS_CSP, DOCS_CACHE_SECONDS } from './docs.js';
import { API_DOCS_URL, apiDocsUrl } from '../../../public/js/shared/api-connections.js';

async function up(over = {}) {
  const { db, dir } = testDb();
  const { app } = createPublicServer({ db, dataDir: dir, now: () => NOW, licencePublicKey: testVendor().publicKey, requireHttps: true, trustProxy: false,
    version: '0.1.0', log: { warn() {}, error() {} }, ...over });
  const server = await listen(app);
  return { base: 'http://127.0.0.1:' + server.address().port, close: () => new Promise((r) => server.close(r)) };
}
const get = (s, p, headers = {}) => fetch(s.base + p, { headers, redirect: 'manual' });
// fetch с If-None-Match сам добавляет Cache-Control: no-cache (спецификация fetch) — проверка ETag идёт через node:http.
const status = (url, headers) => new Promise((resolve, reject) => {
  http.get(url, { headers }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
});

test('/docs, /docs/uz, /docs/en — страница без ключа, даже по http за прокси; свои заголовки; HEAD и ETag', async (t) => {
  const s = await up();
  t.after(s.close);
  for (const [p, lang] of [['/docs', 'ru'], ['/docs/', 'ru'], ['/docs/uz', 'uz'], ['/docs/en', 'en']]) {
    const r = await get(s, p);
    assert.equal(r.status, 200, p);
    assert.equal(r.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(r.headers.get('cache-control'), 'public, max-age=' + DOCS_CACHE_SECONDS);
    assert.equal(r.headers.get('content-security-policy'), DOCS_CSP);
    assert.equal(r.headers.get('content-language'), lang);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
    assert.ok((await r.text()).startsWith('<!doctype html><html lang="' + lang + '">'), p);
  }
  const head = await fetch(s.base + '/docs/en', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  const etag = (await get(s, '/docs')).headers.get('etag');
  assert.ok(etag);
  assert.equal(await status(s.base + '/docs', { 'If-None-Match': etag }), 304, 'та же страница — 304');
});

test('один адрес на страницу: /docs/ru и ?lang — перенаправление; чужой язык — 404', async (t) => {
  const s = await up();
  t.after(s.close);
  for (const [p, to] of [['/docs/ru', '/docs'], ['/docs?lang=uz', '/docs/uz'], ['/docs?lang=EN', '/docs/en'], ['/docs?lang=ru', '/docs']]) {
    const r = await get(s, p);
    assert.deepEqual([r.status, r.headers.get('location')], [301, to], p);
  }
  assert.equal((await get(s, '/docs?lang=de')).status, 200, 'незнакомый ?lang — русская страница');
  const de = await get(s, '/docs/de');
  assert.deepEqual([de.status, (await de.json()).error.code], [404, 'not_found']);
});

test('адрес сервера и срок не забранной заявки — из настроек службы; ссылка программы клиники ведёт сюда', async (t) => {
  const s = await up({ baseUrl: 'https://api.staging.example', uncollectedMaxMs: 48 * 3600000 });
  t.after(s.close);
  const html = await (await get(s, '/docs')).text();
  assert.ok(html.includes('https://api.staging.example/shifo/v1/clinic?lang=ru'), 'команды — на адрес этого сервера');
  assert.ok(html.includes('https://api.staging.example/shifo/v1/media/'), 'ссылки в ответах — на адрес этого сервера');
  assert.ok(!html.includes('https://api.easymed.uz'), 'чужого адреса нет');
  assert.ok(html.includes('48 часов'), 'срок — PUBLIC_UNCOLLECTED_MAX_HOURS');
  assert.ok(!html.includes('24 часа'));
  assert.equal(new URL(API_DOCS_URL).pathname, '/docs');
  for (const l of ['uz', 'en']) assert.equal((await get(s, new URL(apiDocsUrl(l)).pathname)).status, 200);
});

test('адреса клиник и служебные не задеты: /docs/v1/… — клиники «docs» нет; /_health; неизвестное — 404 JSON без кэша', async (t) => {
  const s = await up();
  t.after(s.close);
  const c = await get(s, '/docs/v1/clinic');
  assert.deepEqual([c.status, (await c.json()).error.code], [404, 'clinic_not_found']);
  assert.equal((await get(s, '/_health')).status, 200);
  const x = await get(s, '/docsx');
  assert.deepEqual([x.status, x.headers.get('cache-control')], [404, 'no-store']);
});
