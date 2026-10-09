// LIS_PROXY_V1 — рабочий список (apiOrderGet): те же ворота, что у результата;
// только подтверждённые коды; пробирка — все услуги визита этого прибора;
// dd.MM.yyyy, пол 1/0; мусорный номер — «ничего» (ORDER_NOT_FOUND: {} или
// «Order not found» — решает проверка настоящей программой); журнал с ответом;
// касса не держится.
import test from 'node:test';
import assert from 'node:assert/strict';
import { worklistLines } from './ingest.js';
import { ORDER_NOT_FOUND, replyText } from './lisproxy.js';
import { freshDb, seedLisProxyClinic, bindPanel, addProxyDevice, startProxyApp, post, fixture, lastRow, rows } from '../test-helpers/lisproxy-clinic.js';

const ask = (barcode, name = 'bs200', host = 'LAB-PC-1') =>
  'method=apiOrderGet&order[name]=' + name + '&order[host]=' + host + '&order[barcode]=' + encodeURIComponent(barcode);

async function withClinic(fn, extra = () => {}) {
  const db = freshDb();
  seedLisProxyClinic(db);
  extra(db);
  const app = await startProxyApp(db);
  try { await fn(db, app); } finally { await app.close(); db.close(); }
}
const json = async (res) => { assert.equal(res.status, 200); return res.json(); };
/** Ответ «ничего не отдаём» — ровно константа ORDER_NOT_FOUND, и в журнале — она же. */
const NOTHING = replyText(ORDER_NOT_FOUND);
async function nothing(res, db, label) {
  assert.equal(res.status, 200, label);
  assert.equal(await res.text(), NOTHING, label);
  assert.equal(lastRow(db).reply_body, NOTHING, label);
}

test('BS-200, LAB-000123: одна запись на подтверждённый код; clientId — номер пробирки, имён нет, дата dd.MM.yyyy, пол «1», сыворотка', async () => {
  await withClinic(async (db, app) => {
    const reply = await json(await post(app.url, fixture('orders', 'bs200_order')));
    assert.deepEqual(reply, { 0: { clientId: 'LAB-000123', surname: '', name: '', date_birth: '03.02.1990', sex: '1', biomaterial_code: 'serum', code: 'GLU' } });
    const m = lastRow(db);
    assert.deepEqual([m.kind, m.status, m.visit_service_id, m.sample_id, m.device_id, !!m.resolved_at], ['query', 'unmatched', null, 'LAB-000123', 1, true]);
    assert.equal(m.reply_body, JSON.stringify(reply));
    assert.equal(m.detail, 'LIS Proxy: рабочий список по пробирке LAB-000123 — отдано тестов: 1 (GLU)');
    assert.equal(m.source_body, fixture('orders', 'bs200_order'));
  });
});

test('пробирка — все услуги визита этого прибора (D3): Глюкоза и Мочевина, порядок панели, без повторов; неподтверждённая строка не отдаётся', async () => {
  await withClinic(async (db, app) => {
    const reply = await json(await post(app.url, ask('LAB-000123')));
    assert.deepEqual(Object.values(reply).map((e) => e.code), ['GLU', 'UREA']);
  }, (db) => {
    bindPanel(db, { id: 8, serviceId: 12, deviceId: 1, name: 'Мочевина', lines: [['UREA', 'Мочевина', 'UREA'], ['GLU2', 'Глюкоза ещё раз', 'glu'], ['CREA', 'Креатинин', 'CREA', 0]] });
  });
});

test('ворота: не оплачен, отменён, выдан, нет панели, панель другой модели, ничего не подтверждено — «ничего» с причиной в журнале', async () => {
  await withClinic(async (db, app) => {
    const cases = [
      [ask('LAB-000130'), /заказ ещё не оплачен/],
      [ask('LAB-000131'), /заказ отменён/],
      [ask('LAB-000555'), /кормится анализатором другой модели/],
      [ask('LAB-000999'), /заказ по номеру пробы не найден/],
    ];
    for (const [body, re] of cases) {
      await nothing(await post(app.url, body), db, body);
      assert.match(lastRow(db).detail, re, body);
    }
    db.prepare("INSERT INTO lab_results (visit_service_id, parameter, value, verified_at) VALUES (123, 'Глюкоза', '5.1', strftime('%Y-%m-%dT%H:%M:%SZ','now'))").run();
    await nothing(await post(app.url, ask('LAB-000123')), db, 'выдан');
    assert.match(lastRow(db).detail, /результат заказа уже выдан/);
    db.prepare('UPDATE lab_panel_analytes SET device_code_confirmed = 0 WHERE panel_id = 5').run();
    await nothing(await post(app.url, ask('LAB-000132')), db, 'ничего не подтверждено');
    assert.match(lastRow(db).detail, /нет подтверждённых кодов этого прибора/);
  });
});

test('прибор не добавлен, выключен, мусорный номер (ORU^R01, QRY^Q02, ALL, N, метка времени, пусто) — «ничего»', async () => {
  await withClinic(async (db, app) => {
    for (const id of ['cl_garbage_msh9', 'cl_garbage_qry', 'cl_garbage_all', 'cl_garbage_n', 'cl_garbage_timestamp', 'cl_garbage_empty']) {
      await nothing(await post(app.url, fixture('orders', id)), db, id);
    }
    assert.match(lastRow(db).detail, /прибор ещё не добавлен/, 'cl900i — находка');
    db.prepare("UPDATE lab_devices SET added = 1, profile = 'mindray-cl-900i' WHERE proxy_name = 'cl900i'").run();
    for (const id of ['cl_garbage_msh9', 'cl_garbage_all', 'cl_garbage_timestamp', 'cl_garbage_empty']) {
      await nothing(await post(app.url, fixture('orders', id)), db, id);
      assert.match(lastRow(db).detail, /не штрихкод пробирки/, id);
    }
    db.prepare('UPDATE lab_devices SET enabled = 0 WHERE id = 1').run();
    await nothing(await post(app.url, fixture('orders', 'bs200_order')), db, 'выключен');
    assert.match(lastRow(db).detail, /прибор выключен/);
  });
});

test('AutoLumo: «B-000777» — восстановлен, код 214; «B-000123» — LAB-000123 в журнале, панель другой модели — «ничего»', async () => {
  await withClinic(async (db, app) => {
    const reply = await json(await post(app.url, ask('B-000777', 'lumo', 'LAB-PC-2')));
    assert.deepEqual(reply, { 0: { clientId: 'LAB-000777', surname: '', name: '', date_birth: '03.02.1990', sex: '1', biomaterial_code: 'serum', code: '214' } });
    await nothing(await post(app.url, fixture('orders', 'lumo_order_truncated')), db, 'lumo_order_truncated');
    assert.equal(lastRow(db).sample_id, 'LAB-000123');
    assert.match(lastRow(db).detail, /кормится анализатором другой модели/);
  });
});

test('пол и дата: женщина — «0», без даты и пол «другой» — пустые, в журнале — предупреждение; моча — urine', async () => {
  await withClinic(async (db, app) => {
    const r1 = await json(await post(app.url, ask('LAB-000132')));
    assert.deepEqual([r1[0].date_birth, r1[0].sex], ['', '']);
    assert.match(lastRow(db).detail, /дата рождения не указана — прибор получит пустую дату/);
    db.prepare("UPDATE visit_services SET status = 'queued' WHERE id = 130").run();
    db.prepare("UPDATE services SET specimen = 'Моча' WHERE id = 9").run();
    const r2 = await json(await post(app.url, ask('LAB-000130')));
    assert.deepEqual([r2[0].date_birth, r2[0].sex, r2[0].biomaterial_code], ['20.11.1985', '0', 'urine']);
  });
});

test('строка рабочего списка не держит кассу: не привязана к заказу', async () => {
  await withClinic(async (db, app) => {
    await post(app.url, fixture('orders', 'bs200_order'));
    assert.equal(db.prepare('SELECT COUNT(*) c FROM lab_device_messages WHERE visit_service_id = 123').get().c, 0);
  });
});

test('BS-200: подтверждение для другой строки прибора (номер теста свой у каждого) — не отдаётся', () => {
  const db = freshDb();
  seedLisProxyClinic(db);
  const other = addProxyDevice(db, { name: 'bs200b', label: 'LAB-PC-9', profile: 'mindray-bs-200' });
  assert.match(worklistLines(db, { deviceId: other, orderId: 123 }).why, /привязана к другому анализатору той же модели/);
  db.prepare('UPDATE lab_panel_analytes SET device_code_confirmed_device_id = ? WHERE panel_id = 5').run(other);
  assert.deepEqual(worklistLines(db, { deviceId: 1, orderId: 123 }), { ok: false, why: 'у панели нет подтверждённых кодов этого прибора' });
  db.close();
});

test('рабочий список больше 1 КБ (12 тестов) — JSON целиком, без gzip', async () => {
  await withClinic(async (db, app) => {
    const res = await post(app.url, ask('LAB-000123'));
    assert.equal(res.headers.get('content-encoding'), 'identity');
    const reply = await res.json();
    assert.equal(Object.keys(reply).length, 12);
    assert.ok(JSON.stringify(reply).length > 1024);
  }, (db) => {
    const lines = [];
    for (let i = 1; i <= 11; i++) lines.push(['T' + i, 'Тест ' + i, 'T' + i]);
    db.prepare('DELETE FROM lab_panel_analytes WHERE panel_id = 5').run();
    db.prepare('DELETE FROM lab_panels WHERE id = 5').run();
    bindPanel(db, { id: 5, serviceId: 9, deviceId: 1, name: 'Биохимия', lines: [['GLU', 'Глюкоза', 'GLU'], ...lines] });
  });
});

test('журнал: каждый запрос рабочего списка — своя разрешённая строка с ответом', async () => {
  await withClinic(async (db, app) => {
    await post(app.url, fixture('orders', 'bs200_order'));
    await post(app.url, fixture('orders', 'cl_garbage_all'));
    assert.deepEqual(rows(db).map((m) => [m.kind, !!m.resolved_at, m.reply_body != null]), [['query', true, true], ['query', true, true]]);
  });
});
