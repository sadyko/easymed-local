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
import http from 'node:http';
import zlib from 'node:zlib';
import { freshDb, startProxyApp, post, fixture, rows, PROXY_HEADERS, DEV_KEY } from '../test-helpers/lisproxy-clinic.js';
import { seedLisProxyClinic, lastRow, blank } from '../test-helpers/lisproxy-clinic.js';   // LIS_PROXY_V1 (ревью I1)

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

// ── LIS_PROXY_V1 (ревью I1) — тело читается байтами ДО разбора ─────────────
// Разборщик express отказывал телу больше 100 КБ, больше 1000 пар, не формой
// или не в UTF-8: ответ был {} и журнал без тела, а на не-«Ok» прокси бросает
// остальные тесты пробы (LIS-API.md, §2). Теперь: тело — в журнал первым, разбор
// — свой, на запрос результата — «Ok» всегда.
async function withClinic(fn) {
  const db = freshDb();
  seedLisProxyClinic(db);
  const app = await startProxyApp(db, { listen });
  try { await fn(db, app); } finally { await app.close(); db.close(); }
}
/** POST байтами как есть (fetch перекодировал бы строку в UTF-8). */
function rawPost(urlStr, headers, buf) {
  const u = new URL(urlStr);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: 'POST', headers: { ...headers, 'Content-Length': buf.length } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(buf);
  });
}

test('тело больше 100 КБ и больше 1000 пар — «Ok», тело в журнале целиком, значение в бланке', async () => {
  for (const body of [RESULT + '&pad=' + 'x'.repeat(150000), RESULT + '&x=1'.repeat(1500)]) {
    await withClinic(async (db, app) => {
      const res = await post(app.url, body);
      assert.equal(res.status, 200);
      assert.equal(await res.text(), 'Ok');
      const m = lastRow(db);
      assert.equal(m.source_body, body, 'тело — целиком');
      assert.deepEqual([m.kind, m.status, m.visit_service_id], ['result', 'applied', 123]);
      assert.deepEqual(blank(db, 123), { 'Глюкоза': '5.1' });
    });
  }
});

test('тело больше 2 МБ — «Ok», первые 2 МБ в журнале, строка в лотке с причиной, бланк не тронут', async () => {
  await withClinic(async (db, app) => {
    const body = RESULT + '&pad=' + 'x'.repeat(2200000);
    const res = await post(app.url, body);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'Ok');
    const m = lastRow(db);
    assert.equal(rows(db).length, 1);
    assert.deepEqual([m.kind, m.status, m.resolved_at], ['result', 'rejected', null]);
    assert.match(m.detail, /больше 2 МБ/);
    assert.equal(m.source_body, body.slice(0, 2 * 1024 * 1024));
    assert.deepEqual(blank(db, 123), {}, 'обрезанное тело не разбирается: значение могло оборваться');
  });
});

test('Content-Type text/plain и charset=windows-1251 — «Ok», тело в журнале, значение в бланке', async () => {
  for (const ct of ['text/plain', 'application/x-www-form-urlencoded; charset=windows-1251']) {
    await withClinic(async (db, app) => {
      const res = await post(app.url, RESULT, { ...PROXY_HEADERS, 'Content-Type': ct });
      assert.equal(await res.text(), 'Ok', ct);
      const m = lastRow(db);
      assert.deepEqual([m.source_body, m.kind, m.status], [RESULT, 'result', 'applied'], ct);
      assert.deepEqual(blank(db, 123), { 'Глюкоза': '5.1' }, ct);
    });
  }
});

test('байты не UTF-8 в теле — прочитаны как windows-1251, отметка в журнале; «Ok»; значение в бланке', async () => {
  await withClinic(async (db, app) => {
    const buf = Buffer.from(RESULT.replace('mmol%2FL', 'XX'), 'latin1');
    const i = buf.indexOf('XX');
    buf[i] = 0xEC; buf[i + 1] = 0xEC;   // «мм» в windows-1251
    const r = await rawPost(app.url, PROXY_HEADERS, buf);
    assert.deepEqual([r.status, r.text], [200, 'Ok']);
    const m = lastRow(db);
    assert.equal(m.source_body, RESULT.replace('mmol%2FL', 'мм'));
    assert.equal(m.status, 'applied');
    assert.match(m.detail, /windows-1251/);
    assert.deepEqual(blank(db, 123), { 'Глюкоза': '5.1' });
  });
});

test('тело сжато gzip — распаковано: «Ok», тело в журнале, значение в бланке', async () => {
  await withClinic(async (db, app) => {
    const r = await rawPost(app.url, { ...PROXY_HEADERS, 'Content-Encoding': 'gzip' }, zlib.gzipSync(Buffer.from(RESULT)));
    assert.deepEqual([r.status, r.text], [200, 'Ok']);
    assert.equal(lastRow(db).source_body, RESULT);
    assert.deepEqual(blank(db, 123), { 'Глюкоза': '5.1' });
  });
});

test('method в другом регистре и method[] — тоже результат: «Ok», значение в бланке (ревью A4, A5)', async () => {
  for (const body of [RESULT.replace('method=apiResultSave', 'method=APIRESULTSAVE'), RESULT.replace('method=apiResultSave', 'method[]=apiResultSave')]) {
    await withClinic(async (db, app) => {
      assert.equal(await (await post(app.url, body)).text(), 'Ok', body.slice(0, 30));
      assert.deepEqual([lastRow(db).kind, lastRow(db).status], ['result', 'applied']);
      assert.deepEqual(blank(db, 123), { 'Глюкоза': '5.1' });
    });
  }
});

test('ключ значения дважды — берётся последнее, а не «пустое значение» (ревью A8)', async () => {
  await withClinic(async (db, app) => {
    assert.equal(await (await post(app.url, RESULT + '&lisResult[R][res]=6.2')).text(), 'Ok');
    assert.deepEqual(blank(db, 123), { 'Глюкоза': '6.2' });
  });
});

test('тело с method=apiResultSave, из которого значения не вышло, — всё равно «Ok»', async () => {
  await withClinic(async (db, app) => {
    for (const body of ['method=apiResultSave&lisResult=abc', 'method=apiResultSave&lisResult[name][]=bs200&lisResult[barcode]=LAB-000123', 'METHOD=apiResultSave']) {
      const res = await post(app.url, body);
      assert.deepEqual([res.status, await res.text()], [200, 'Ok'], body);
      assert.equal(lastRow(db).source_body, body);
    }
    const m = lastRow(db);
    assert.deepEqual([m.kind, m.status, m.resolved_at], ['result', 'rejected', null], 'method не разобран — в лотке, не угадывается');
    assert.match(m.detail, /method не разобран/);
  });
});
