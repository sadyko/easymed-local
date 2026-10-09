// LIS_PROXY_V1 — apiBarcodeListGet (пакетная загрузка выключена) и незнакомый
// method: «ничего» (ORDER_NOT_FOUND) и строка журнала, не ошибка; в лоток не идут.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ORDER_NOT_FOUND, replyText } from './lisproxy.js';
import { freshDb, startProxyApp, post, fixture, lastRow, tray, device } from '../test-helpers/lisproxy-clinic.js';

const NOTHING = replyText(ORDER_NOT_FOUND);

test('apiBarcodeListGet — 200 «ничего», строка журнала «пакетная загрузка выключена», прибор найден и на связи', async () => {
  const db = freshDb();
  const app = await startProxyApp(db);
  try {
    const res = await post(app.url, fixture('lists', 'cl_barcode_list'));
    assert.equal(res.status, 200);
    assert.equal(await res.text(), NOTHING);
    const m = lastRow(db);
    assert.deepEqual([m.kind, !!m.resolved_at, m.reply_body], ['query', true, NOTHING]);
    assert.equal(m.detail, 'LIS Proxy: запрос всех проб (apiBarcodeListGet) — пакетная загрузка выключена, ответ ' + NOTHING);
    assert.ok(device(db, 'cl900i').last_seen_at);
    assert.deepEqual(tray(db), []);
  } finally { await app.close(); db.close(); }
});

test('незнакомый method — 200 «ничего», строка журнала, не ошибка; без имени — без прибора', async () => {
  const db = freshDb();
  const app = await startProxyApp(db);
  try {
    const body = fixture('unknown', 'unknown_method');
    const res = await post(app.url, body);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), NOTHING);
    const m = lastRow(db);
    assert.equal(m.detail, 'LIS Proxy: незнакомый запрос «apiSomethingNew» — ответ ' + NOTHING);
    assert.deepEqual([m.kind, m.device_id, m.source_body, !!m.resolved_at, m.reply_body], ['query', null, body, true, NOTHING]);
    assert.deepEqual(tray(db), []);
  } finally { await app.close(); db.close(); }
});
