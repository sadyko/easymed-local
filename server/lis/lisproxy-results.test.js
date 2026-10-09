// LIS_PROXY_V1 — результат через LIS Proxy (apiResultSave): одна строка журнала
// на запрос, прежний приём, номер — только этикетка, мусор — справка,
// восстановление обрезанного номера AutoLumo, находка и выключенный прибор.
// Ответ на каждый исход — ровно «Ok» (руководство поставщика LIS-API.md, §2).
import test from 'node:test';
import assert from 'node:assert/strict';
import { ingestMessage } from './ingest.js';
import { buildOru, PROXY_QUIET_PREFIX, PROXY_NOT_TUBE } from './lisproxy-form.js';
import { journalProxyRequest, handleProxyRequest } from './lisproxy.js';
import { lisRecent, lisMessageAttach } from '../services/rpc/lis.js';
import {
  freshDb, seedLisProxyClinic, addProxyDevice, startProxyApp, post, fixture, rows, lastRow, tray, blank,
} from '../test-helpers/lisproxy-clinic.js';

const LAB = { role: 'lab' };
const order = (db, id) => db.prepare('SELECT status FROM visit_services WHERE id = ?').get(id).status;

async function withClinic(fn) {
  const db = freshDb();
  seedLisProxyClinic(db);
  const app = await startProxyApp(db);
  try { await fn(db, app); } finally { await app.close(); db.close(); }
}

test('BS-200, LAB-000123, GLU — 200 «Ok»; одна строка журнала (тело как пришло, сырое — ORU), 5.1 в бланке, заказ «результаты внесены», не выдан', async () => {
  await withClinic(async (db, app) => {
    const body = fixture('results', 'bs200_glu');
    const res = await post(app.url, body);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'Ok');
    assert.equal(rows(db).length, 1, 'одна строка на запрос');
    const m = lastRow(db);
    assert.equal(m.source_body, body);
    assert.ok(m.raw.startsWith('MSH|^~\\&|LISPROXY|LabPC|'), m.raw);
    assert.deepEqual([m.status, m.device_id, m.visit_service_id, m.sample_id, m.kind], ['applied', 1, 123, 'LAB-000123', 'result']);
    assert.deepEqual(blank(db, 123), { 'Глюкоза': '5.1' });
    assert.equal(order(db, 123), 'resulted');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM lab_results WHERE verified_at IS NOT NULL OR verified_by IS NOT NULL').get().c, 0, 'автовыдачи нет');
  });
});

test('голые цифры — никогда не номер заказа: «900001» при открытом свежем заказе № 900001 другого пациента — лоток, бланк не тронут', async () => {
  await withClinic(async (db, app) => {
    const res = await post(app.url, fixture('results', 'bs200_bare_digits'));
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'Ok', 'лоток — тоже «Ok»: иначе прокси не шлёт остальные тесты пробы');
    const m = lastRow(db);
    assert.deepEqual([m.status, m.visit_service_id, m.sample_id], ['unmatched', null, '900001']);
    assert.ok(m.detail.startsWith(PROXY_NOT_TUBE + ': 900001 — похоже на номер пациента'), m.detail);
    assert.ok(m.raw.includes('\rOBR|1||\r'), 'в сыром номера нет');
    assert.deepEqual(blank(db, 900001), {});
    assert.equal(order(db, 900001), 'queued');
    for (const id of ['bs200_patient_number_as_barcode', 'lumo_numeric_id']) {
      await post(app.url, fixture('results', id));
      assert.equal(lastRow(db).status, 'unmatched', id);
      assert.equal(lastRow(db).visit_service_id, null, id);
    }
    assert.equal(tray(db).length, 3);
  });
});

test('«Привязать» строку с чужим номером к заказу № 123 — номер назвал человек: значение в бланке', async () => {
  await withClinic(async (db, app) => {
    await post(app.url, fixture('results', 'bs200_bare_digits'));
    const r = lisMessageAttach(db, { id: lastRow(db).id, visit_service_id: 123 }, LAB);
    assert.equal(r.status, 'applied');
    assert.deepEqual(blank(db, 123), { 'Глюкоза': '5.1' });
  });
});

test('стена приёма: прибор LIS Proxy и ORU с голыми цифрами в OBR-3 — заказ не ищется (кроме номера от человека)', () => {
  const db = freshDb();
  seedLisProxyClinic(db);
  const raw = buildOru({ code: 'GLU', res: '5.1', barcode: '900001' });
  ingestMessage(db, raw, '127.0.0.1', 1);
  const m = lastRow(db);
  assert.deepEqual([m.status, m.visit_service_id], ['unmatched', null]);
  assert.ok(m.detail.startsWith(PROXY_NOT_TUBE + ': 900001'), m.detail);
  assert.deepEqual(blank(db, 900001), {});
  db.close();
});

test('BC-20/BC-5300 путают поле: «Therapy^^12», «6690-2^WBC^LN», пусто — лоток с причиной о прокси (номер проверяется раньше «Добавить»)', async () => {
  await withClinic(async (db, app) => {
    for (const [id, re] of [['bc20_pv1_dept_as_barcode', /Therapy\^\^12 — проверьте тип анализатора в LIS Proxy \(BC-20\/BC-5300 путают поле\)/],
      ['bc20_loinc_as_barcode', /6690-2\^WBC\^LN/], ['bc20_empty_barcode', /\(пусто\) — анализатор не передал номер пробы/]]) {
      assert.equal((await post(app.url, fixture('results', id))).status, 200);
      const m = lastRow(db);
      assert.equal(m.status, 'unmatched', id);
      assert.match(m.detail, re, id);
    }
  });
});

test('мусор (IS пусто, Take Mode, Test Mode, «нет результата») — строка журнала разрешена сразу: без лотка, без ленты, сырое пусто', async () => {
  await withClinic(async (db, app) => {
    for (const id of ['bc780_junk_IS_empty', 'bc20_take_mode', 'bc20_test_mode']) {
      assert.equal(await (await post(app.url, fixture('results', id))).text(), 'Ok', id);
      const m = lastRow(db);
      assert.ok(m.detail.startsWith(PROXY_QUIET_PREFIX), m.detail);
      assert.ok(m.resolved_at, id + ' разрешена');
      assert.equal(m.raw, '');
    }
    await post(app.url, fixture('results', 'bs200_glu').replace('5.100000', '-268435455.000000'));
    assert.match(lastRow(db).detail, /нет результата «-268435455.000000» \(GLU\)/);
    assert.deepEqual(tray(db), []);
    assert.deepEqual(lisRecent(db, { limit: 50 }, LAB), [], 'в ленте «Последние результаты» их нет');
    assert.deepEqual(blank(db, 123), {});
  });
});

test('AutoLumo: «B-000777» — восстановлен до LAB-000777, 28.4 в строке кода 214; у BS-200 тот же номер — в лоток', async () => {
  await withClinic(async (db, app) => {
    await post(app.url, fixture('results', 'lumo_truncated_barcode'));
    const m = lastRow(db);
    assert.deepEqual([m.status, m.visit_service_id, m.sample_id], ['applied', 777, 'LAB-000777']);
    assert.deepEqual(blank(db, 777), { 'Витамин B12': '28.4' });
    await post(app.url, fixture('results', 'bs200_glu').replace('LAB-000123', 'B-000777'));
    assert.match(lastRow(db).detail, /похоже на обрезанную этикетку AutoLumo/);
  });
});

test('находка (не добавлена) — N2: в бланк не пишет, заказ назван; выключенный прибор — в лоток с причиной', async () => {
  await withClinic(async (db, app) => {
    await post(app.url, fixture('results', 'bs200_glu').replace('bs200', 'bs200new'));
    let m = lastRow(db);
    assert.deepEqual([m.status, m.visit_service_id], ['unmatched', 123]);
    assert.match(m.detail, /прибор ещё не добавлен/);
    db.prepare('UPDATE lab_devices SET enabled = 0 WHERE id = 1').run();
    await post(app.url, fixture('results', 'bs200_glu'));
    m = lastRow(db);
    assert.equal(m.status, 'unmatched');
    assert.match(m.detail, /прибор выключен в «Анализаторах»/);
    assert.deepEqual(blank(db, 123), {});
  });
});

test('запись сорвалась внутри приёма — 200 «Ok», та же строка «rejected» с причиной, тело сохранено', async () => {
  await withClinic(async (db, app) => {
    db.exec("CREATE TRIGGER lpx_no_results BEFORE INSERT ON lab_results BEGIN SELECT RAISE(ABORT, 'диск полон'); END;");
    const body = fixture('results', 'bs200_glu');
    const res = await post(app.url, body);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'Ok');
    assert.equal(rows(db).length, 1);
    const m = lastRow(db);
    assert.equal(m.status, 'rejected');
    assert.match(m.detail, /ошибка записи: диск полон/);
    assert.equal(m.source_body, body);
  });
});

test('значение: «5,1» — число 5.1 (запятая — точка), «<0.5» — текст', async () => {
  await withClinic(async (db, app) => {
    await post(app.url, fixture('results', 'bs200_glu').replace('5.100000', '5%2C1'));
    assert.deepEqual(db.prepare('SELECT value, numeric_value FROM lab_results WHERE visit_service_id = 123').get(), { value: '5.1', numeric_value: 5.1 });
    await post(app.url, fixture('results', 'lumo_truncated_barcode').replace('28.4', '%3C0.5'));
    assert.deepEqual(db.prepare('SELECT value, numeric_value FROM lab_results WHERE visit_service_id = 777').get(), { value: '<0.5', numeric_value: null });
  });
});

test('адрес LIS Proxy сменился — та же строка прибора, в журнале строки — откуда и куда', () => {
  const db = freshDb();
  seedLisProxyClinic(db);
  const body = { method: 'apiResultSave', lisResult: { name: 'bs200', host: 'LAB-PC-1', barcode: 'LAB-000123', code: 'GLU', R: { res: '5.1', unit: '', norms: '', flag: '' } } };
  const id = journalProxyRequest(db, { peer: '192.168.1.35', body: 'x', method: 'apiResultSave' });
  assert.deepEqual(handleProxyRequest(db, { id, peer: '192.168.1.35', body }), { type: 'text', body: 'Ok' });
  const m = lastRow(db);
  assert.equal(m.device_id, 1);
  assert.equal(m.status, 'applied');
  assert.match(m.detail, /адрес LIS Proxy сменился: 127\.0\.0\.1 → 192\.168\.1\.35/);
  db.close();
});

test('прибор не заведён (предел находок) — лоток «прибор не заведён», в приём не идёт', () => {
  const db = freshDb();
  seedLisProxyClinic(db);
  for (let i = 0; i < 20; i++) addProxyDevice(db, { name: 'f' + i, added: 0 });
  const body = { method: 'apiResultSave', lisResult: { name: 'newcomer', host: '', barcode: 'LAB-000555', code: 'WBC', R: { res: '4.63' } } };
  const id = journalProxyRequest(db, { peer: '127.0.0.1', body: 'x', method: 'apiResultSave' });
  assert.deepEqual(handleProxyRequest(db, { id, peer: '127.0.0.1', body }), { type: 'text', body: 'Ok' });
  const m = lastRow(db);
  assert.deepEqual([m.status, m.device_id, m.visit_service_id], ['unmatched', null, null]);
  assert.match(m.detail, /^LIS Proxy: прибор не заведён — достигнут предел/);
  assert.deepEqual(blank(db, 555), {});
  db.close();
});
