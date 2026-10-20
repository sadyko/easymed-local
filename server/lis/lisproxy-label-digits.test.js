// LAB_BARCODE_DIGITS_V1 (решение владельца 2026-10-20) — штрихкод этикетки —
// одни цифры, 8 знаков («00000123»): «LAB-000123» сканер на русской раскладке
// набирал «ДФИ-000123». Через LIS Proxy такой номер идёт тем же правилом, что у
// прибора без прокси: заказ открыт и не старше 7 дней — и для результата, и для
// рабочего списка. Номер пациента (не 8 цифр как напечатано) — как прежде, лоток.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ingestMessage } from './ingest.js';
import { buildOru, PROXY_NOT_TUBE } from './lisproxy-form.js';
import { ORDER_NOT_FOUND, replyText } from './lisproxy.js';
import { freshDb, seedLisProxyClinic, startProxyApp, post, fixture, lastRow, blank } from '../test-helpers/lisproxy-clinic.js';
import { listen } from '../../control-plane/server/test-helpers/listen.js';

const result = (barcode) => fixture('results', 'bs200_glu').replace('lisResult[barcode]=LAB-000123', 'lisResult[barcode]=' + barcode);
const ask = (barcode) => 'method=apiOrderGet&order[name]=bs200&order[host]=LAB-PC-1&order[barcode]=' + encodeURIComponent(barcode);
const order = (db, id) => db.prepare('SELECT status FROM visit_services WHERE id = ?').get(id).status;
/** Заказ № 123 (визит 55) — месячной давности. */
const ageOrder123 = (db) => {
  db.prepare("UPDATE visit_services SET created_at = datetime('now', '-30 days') WHERE id = 123").run();
  db.prepare("UPDATE visits SET visit_date = datetime('now', '-30 days') WHERE id = 55").run();
};

async function withClinic(fn, extra = () => {}) {
  const db = freshDb();
  seedLisProxyClinic(db);
  extra(db);
  const app = await startProxyApp(db, { listen });
  try { await fn(db, app); } finally { await app.close(); db.close(); }
}

test('LIS Proxy, штрихкод «00000123» (новая этикетка): значение в бланке заказа № 123, в журнале — номер как пришёл', async () => {
  await withClinic(async (db, app) => {
    assert.ok(result('00000123').includes('[barcode]=00000123'));
    const res = await post(app.url, result('00000123'));
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'Ok');
    const m = lastRow(db);
    assert.deepEqual([m.status, m.visit_service_id, m.sample_id], ['applied', 123, '00000123'], m.detail);
    assert.ok(m.raw.includes('\rOBR|1||00000123\r'), m.raw);
    assert.deepEqual(blank(db, 123), { 'Глюкоза': '5.1' });
    assert.equal(order(db, 123), 'resulted');
  });
});

test('LIS Proxy, «00000123» к заказу старше 7 дней — лоток с причиной, заказ не привязан, бланк не тронут', async () => {
  await withClinic(async (db, app) => {
    await post(app.url, result('00000123'));
    const m = lastRow(db);
    assert.deepEqual([m.status, m.visit_service_id], ['unmatched', null], m.detail);
    assert.match(m.detail, /старше 7 дней/);
    assert.deepEqual(blank(db, 123), {});
    assert.equal(order(db, 123), 'queued');
  }, ageOrder123);
});

test('LIS Proxy, номер пациента и лишние нули («900001», «0000000123», «0900001») — как прежде: не номер пробирки, заказ не ищется', async () => {
  await withClinic(async (db, app) => {
    for (const raw of ['900001', '0000000123', '0900001']) {
      await post(app.url, result(raw));
      const m = lastRow(db);
      assert.deepEqual([m.status, m.visit_service_id], ['unmatched', null], raw);
      assert.ok(m.detail.startsWith(PROXY_NOT_TUBE + ': ' + raw), m.detail);
    }
    assert.deepEqual(blank(db, 900001), {});
    assert.deepEqual(blank(db, 123), {});
  });
});

test('LIS Proxy, рабочий список по «00000123»: тесты заказа № 123, clientId — номер как пришёл; заказ старше 7 дней — «ничего» с причиной', async () => {
  await withClinic(async (db, app) => {
    const res = await post(app.url, ask('00000123'));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { 0: { clientId: '00000123', surname: '', name: '', date_birth: '03.02.1990', sex: '1', biomaterial_code: 'serum', code: 'GLU' } });
    assert.equal(lastRow(db).sample_id, '00000123');
  });
  await withClinic(async (db, app) => {
    const res = await post(app.url, ask('00000123'));
    assert.equal(await res.text(), replyText(ORDER_NOT_FOUND));
    assert.match(lastRow(db).detail, /ничего не отдано: .*старше 7 дней/);
  }, ageOrder123);
});

test('стена приёма у прибора LIS Proxy: ORU со штрихкодом из 8 цифр проходит к правилу голых цифр; «900001» — как прежде', () => {
  const db = freshDb();
  seedLisProxyClinic(db);
  ingestMessage(db, buildOru({ code: 'GLU', res: '5.1', barcode: '00000123' }), '127.0.0.1', 1);
  assert.deepEqual([lastRow(db).status, lastRow(db).visit_service_id], ['applied', 123], lastRow(db).detail);
  ingestMessage(db, buildOru({ code: 'GLU', res: '5.1', barcode: '900001' }), '127.0.0.1', 1);
  assert.deepEqual([lastRow(db).status, lastRow(db).visit_service_id], ['unmatched', null]);
  assert.ok(lastRow(db).detail.startsWith(PROXY_NOT_TUBE + ': 900001'), lastRow(db).detail);
  db.close();
});
