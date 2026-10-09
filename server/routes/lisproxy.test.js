// LIS_PROXY_V1 — вход LIS Proxy: ключ, 404 как у неизвестного адреса, журнал
// раньше всего, 200 на любой исход, 500 — только без журнала, ответ не сжат.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { listen } from '../../control-plane/server/test-helpers/listen.js';
import { tmpDir } from '../test-helpers/tmpdir.js';
import { writeProxySettings } from '../lis/lisproxy-settings.js';
import { lisProxyRoutes, NOT_FOUND } from './lisproxy.js';
import { JOURNAL_PENDING, RESULT_OK, ORDER_NOT_FOUND, NOT_FOUND_JSON, NOT_FOUND_TEXT, replyText } from '../lis/lisproxy.js';
import { freshDb, startProxyApp, post, fixture, rows, PROXY_HEADERS, DEV_KEY } from '../test-helpers/lisproxy-clinic.js';

const RESULT = fixture('results', 'bs200_glu');
const ORDER = fixture('orders', 'bs200_order');

test('приём выключен (файла нет), выключен с ключом, нет ключа, не тот, ключ массивом, ключ в теле, GET, лишний путь — тот же 404, что у неизвестного адреса; ничего не записано', async () => {
  const db = freshDb();
  const off = await startProxyApp(db, { listen, settings: false });
  const on = await startProxyApp(db, { listen, enabled: true });
  const disabled = await startProxyApp(db, { listen, enabled: false });
  try {
    const unknown = await fetch(on.base + '/api/definitely-not-here', { method: 'POST', headers: PROXY_HEADERS, body: RESULT });
    assert.equal(unknown.status, 404);
    const unknownBody = await unknown.text();
    assert.equal(unknownBody, JSON.stringify(NOT_FOUND), 'тело 404 — как у app.js');
    const tries = [
      [off.url, RESULT],
      [disabled.url, RESULT],
      [on.base + '/api/lisproxy', RESULT],
      [on.base + '/api/lisproxy?key=WRONG', RESULT],
      [on.base + '/api/lisproxy?key=' + DEV_KEY + '&key=' + DEV_KEY, RESULT],
      [on.base + '/api/lisproxy', RESULT + '&key=' + DEV_KEY],
      [on.base + '/api/lisproxy/x?key=' + DEV_KEY, RESULT],
    ];
    for (const [url, body] of tries) {
      const res = await post(url, body);
      assert.equal(res.status, 404, url);
      assert.equal(await res.text(), unknownBody, url);
    }
    const get = await fetch(on.url);
    assert.equal(get.status, 404);
    assert.equal(await get.text(), unknownBody);
    assert.deepEqual(rows(db), [], 'журнал пуст');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM lab_devices').get().c, 0, 'прибор не заведён');
  } finally { await off.close(); await on.close(); await disabled.close(); db.close(); }
});

test('ключ верный: строка журнала с телом как пришло; результат — 200 «Ok», запрос — 200 «ничего» (ORDER_NOT_FOUND); без сессии (до requirePasswordChanged)', async () => {
  const db = freshDb();
  const app = await startProxyApp(db, { listen });
  try {
    const r1 = await post(app.url, RESULT);
    assert.equal(r1.status, 200);
    assert.equal(await r1.text(), 'Ok', 'ровно «Ok» — руководство поставщика LIS-API.md, §2');
    assert.match(r1.headers.get('content-type'), /^text\/plain/);
    const r2 = await post(app.url, ORDER);
    assert.equal(r2.status, 200);
    assert.equal(await r2.text(), replyText(ORDER_NOT_FOUND));
    const [a, b] = rows(db);
    assert.equal(a.source_body, RESULT, 'тело — байт в байт');
    assert.equal(a.kind, 'result');
    assert.equal(a.peer, '127.0.0.1');
    assert.equal(b.source_body, ORDER);
    assert.equal(b.kind, 'query');
  } finally { await app.close(); db.close(); }
});

/** Маршрут один, с подменённым разбором — для «журнал раньше всего» и ответа. */
async function bareRouter(db, handle) {
  const dataDir = tmpDir('em-lpx-route-');
  writeProxySettings(dataDir, { enabled: true, key: DEV_KEY });
  const app = express();
  app.use('/api', express.json({ limit: '100kb' }));   // как в app.js: общий разборщик JSON стоит раньше
  app.use('/api/lisproxy', lisProxyRoutes(db, dataDir, { handle }));
  const server = await listen(app);
  return { url: 'http://127.0.0.1:' + server.address().port + '/api/lisproxy?key=' + DEV_KEY, close: () => new Promise((r) => server.close(r)) };
}

test('разбор упал после журнала — 200, строка журнала «ошибка разбора», тело сохранено', async () => {
  const db = freshDb();
  const app = await bareRouter(db, () => { throw new Error('сбой'); });
  try {
    const res = await post(app.url, RESULT);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'Ok');
    const [row] = rows(db);
    assert.equal(row.status, 'rejected');
    assert.equal(row.detail, 'LIS Proxy: ошибка разбора — сбой');
    assert.equal(row.source_body, RESULT);
  } finally { await app.close(); db.close(); }
});

test('журнал не записался — 500 «Ошибка сервера», и только тогда', async () => {
  const db = freshDb();
  db.exec("CREATE TRIGGER lpx_boom BEFORE INSERT ON lab_device_messages BEGIN SELECT RAISE(ABORT, 'диск'); END;");
  let called = false;
  const app = await bareRouter(db, () => { called = true; return RESULT_OK; });
  try {
    const res = await post(app.url, RESULT);
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: { code: 'internal', message: 'Ошибка сервера. Повторите позже.' } });
    assert.equal(called, false, 'без журнала разбора нет');
  } finally { await app.close(); db.close(); }
});

test('строка журнала пишется ДО разбора: разбор видит её «не завершён»', async () => {
  const db = freshDb();
  let seen = null;
  const app = await bareRouter(db, (d, { id }) => { seen = d.prepare('SELECT status, detail, source_body FROM lab_device_messages WHERE id = ?').get(id); return RESULT_OK; });
  try {
    await post(app.url, RESULT);
    assert.deepEqual(seen, { status: 'rejected', detail: JOURNAL_PENDING, source_body: RESULT });
  } finally { await app.close(); db.close(); }
});

test('ответ больше 1 КБ при Accept-Encoding: gzip — не сжат (Content-Encoding: identity), JSON читается', async () => {
  const db = freshDb();
  const big = {};
  for (let i = 0; i < 30; i++) big[String(i)] = { clientId: 'LAB-000123', surname: '', name: '', date_birth: '03.02.1990', sex: '1', biomaterial_code: 'serum', code: 'T' + i };
  const app = await startProxyApp(db, { listen });
  const bare = await bareRouter(db, () => ({ type: 'json', body: big }));
  try {
    // Через настоящее приложение: compress.js стоит первым и сжал бы такой JSON.
    const realApp = await post(app.url, ORDER);
    assert.equal(realApp.headers.get('content-encoding'), 'identity');
    const res = await post(bare.url, ORDER);
    assert.equal(res.headers.get('content-encoding'), 'identity');
    const text = await res.text();
    assert.ok(text.length > 1024);
    assert.deepEqual(JSON.parse(text), big);
  } finally { await app.close(); await bare.close(); db.close(); }
});

test('тело не формой (JSON) — тоже запрос с ключом: строка журнала и 200 «ничего» (ORDER_NOT_FOUND)', async () => {
  const db = freshDb();
  const app = await startProxyApp(db, { listen });
  try {
    const res = await fetch(app.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"x":1}' });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), replyText(ORDER_NOT_FOUND));
    assert.equal(rows(db).length, 1);
  } finally { await app.close(); db.close(); }
});

test('«ничего не отдаём» — одна константа: {} по умолчанию; EASYMED_LISPROXY_NOT_FOUND=text — «Order not found» текстом (LIS-API.md, §3–§4)', async () => {
  assert.equal(RESULT_OK.body, 'Ok');
  assert.deepEqual([NOT_FOUND_JSON.type, replyText(NOT_FOUND_JSON)], ['json', '{}']);
  assert.deepEqual([NOT_FOUND_TEXT.type, replyText(NOT_FOUND_TEXT)], ['text', 'Order not found']);
  const prev = process.env.EASYMED_LISPROXY_NOT_FOUND;
  try {
    delete process.env.EASYMED_LISPROXY_NOT_FOUND;
    // Свой экземпляр модуля (адрес с ?…) — константа выбирается при загрузке.
    const byDefault = await import('../lis/lisproxy.js?nf=default');
    assert.equal(byDefault.ORDER_NOT_FOUND, byDefault.NOT_FOUND_JSON, 'до проверки настоящей программой — {}');
    process.env.EASYMED_LISPROXY_NOT_FOUND = 'text';
    const asText = await import('../lis/lisproxy.js?nf=text');
    assert.equal(asText.ORDER_NOT_FOUND, asText.NOT_FOUND_TEXT);
    assert.equal(asText.fallbackReply('apiOrderGet'), asText.NOT_FOUND_TEXT, 'сорвавшийся разбор запроса — та же константа');
    assert.equal(asText.fallbackReply('apiResultSave').body, 'Ok');
  } finally {
    if (prev === undefined) delete process.env.EASYMED_LISPROXY_NOT_FOUND; else process.env.EASYMED_LISPROXY_NOT_FOUND = prev;
  }
  // Текстовый вид уходит как text/plain, без кавычек JSON и без перевода строки.
  const db = freshDb();
  const bare = await bareRouter(db, () => NOT_FOUND_TEXT);
  try {
    const res = await post(bare.url, ORDER);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^text\/plain/);
    assert.equal(await res.text(), 'Order not found');
  } finally { await bare.close(); db.close(); }
});
