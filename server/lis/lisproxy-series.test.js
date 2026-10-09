// LIS_PROXY_V1 — серия у строк LIS Proxy всегда и по строке прибора; лишний
// показатель гематологии — справка, незнакомый тест BS-200 — лоток (как свой порт).
import test from 'node:test';
import assert from 'node:assert/strict';
import { SERIES_PENDING_PREFIX } from './inbox.js';
import { PROXY_QUIET_PREFIX } from './lisproxy-form.js';
import { freshDb, seedLisProxyClinic, addProxyDevice, bindPanel, startProxyApp, post, fixture, lastRow, tray, blank, rows } from '../test-helpers/lisproxy-clinic.js';
import { listen } from '../../control-plane/server/test-helpers/listen.js';   // LIS_PROXY_V1 — стенд получает listen от теста

async function withClinic(fn) {
  const db = freshDb();
  seedLisProxyClinic(db);
  const app = await startProxyApp(db, { listen });
  try { await fn(db, app); } finally { await app.close(); db.close(); }
}

test('BC-780 по значению в запросе: WBC — «ждём остальные», HGB — серия принята, обе строки applied, лоток пуст', async () => {
  await withClinic(async (db, app) => {
    await post(app.url, fixture('results', 'bc780_wbc'));
    const first = lastRow(db);
    assert.equal(first.status, 'unmapped');
    assert.ok(first.detail.startsWith(SERIES_PENDING_PREFIX), first.detail);
    assert.deepEqual(blank(db, 555), { 'Лейкоциты': '4.63' });
    await post(app.url, fixture('results', 'bc780_hgb'));
    assert.equal(lastRow(db).status, 'applied');
    assert.equal(lastRow(db).detail, 'серия из 2 сообщений принята');
    assert.deepEqual(blank(db, 555), { 'Лейкоциты': '4.63', 'Гемоглобин': '132' });
    assert.deepEqual(rows(db).map((m) => m.status), ['applied', 'applied']);
    assert.deepEqual(tray(db), []);
  });
});

test('BC-780: показатель, которого нет в панели (P-LCR), — справка, разрешена; серия не страдает', async () => {
  await withClinic(async (db, app) => {
    await post(app.url, fixture('results', 'bc780_wbc'));
    await post(app.url, fixture('results', 'bc780_wbc').replace('WBC', 'P-LCR').replace('4.63', '31.2'));
    const extra = lastRow(db);
    assert.equal(extra.detail, PROXY_QUIET_PREFIX + 'не использованы: P-LCR');
    assert.ok(extra.resolved_at, 'не в лотке');
    await post(app.url, fixture('results', 'bc780_hgb'));
    assert.equal(lastRow(db).status, 'applied');
    assert.deepEqual(tray(db), []);
  });
});

test('BC-780: неподтверждённая строка панели — лоток (D4), не справка', async () => {
  const db = freshDb();
  seedLisProxyClinic(db);
  db.prepare("UPDATE lab_panel_analytes SET device_code_confirmed = 0 WHERE panel_id = 7 AND device_code = 'HGB'").run();
  const app = await startProxyApp(db, { listen });
  try {
    await post(app.url, fixture('results', 'bc780_hgb'));
    const m = lastRow(db);
    assert.equal(m.resolved_at, null);
    assert.match(m.detail, /не подтверждено: HGB/);
    assert.deepEqual(blank(db, 555), {});
  } finally { await app.close(); db.close(); }
});

test('BS-200: незнакомый тест — лоток, как на своём порту', async () => {
  await withClinic(async (db, app) => {
    await post(app.url, fixture('results', 'bs200_glu').replace('code]=GLU', 'code]=CREA'));
    const m = lastRow(db);
    assert.equal(m.resolved_at, null);
    assert.match(m.detail, /не использованы: CREA/);
  });
});

test('серия — по строке прибора: HGB второго BC-780 той же пробирки — своя серия, «ждущую» строку первого прибора не принимает', async () => {
  await withClinic(async (db, app) => {
    const second = addProxyDevice(db, { name: 'bc780y', label: 'LABPC2', profile: 'mindray-bc-780' });
    await post(app.url, fixture('results', 'bc780_wbc'));
    const first = lastRow(db);
    await post(app.url, fixture('results', 'bc780_hgb').replace('bc780x', 'bc780y').replace('LABPC', 'LABPC2'));
    const m = lastRow(db);
    assert.equal(m.device_id, second);
    assert.equal(m.status, 'applied', 'бланк полон — HGB принят (та же модель — та же панель)');
    assert.equal(m.detail, '', 'серия из одного сообщения — как одно сообщение (match.js seriesOutcome)');
    const still = db.prepare('SELECT status, detail FROM lab_device_messages WHERE id = ?').get(first.id);
    assert.equal(still.status, 'unmapped');
    assert.ok(still.detail.startsWith(SERIES_PENDING_PREFIX), 'строка первого прибора — в своей серии');
  });
});

test('две услуги одной пробирки (D3) через LIS Proxy: Глюкоза и Мочевина — каждая в свою, лоток пуст', async () => {
  const db = freshDb();
  seedLisProxyClinic(db);
  bindPanel(db, { id: 8, serviceId: 12, deviceId: 1, name: 'Мочевина', lines: [['UREA', 'Мочевина', 'UREA']] });
  const app = await startProxyApp(db, { listen });
  try {
    await post(app.url, fixture('results', 'bs200_glu'));
    await post(app.url, fixture('results', 'bs200_glu').replace('code]=GLU', 'code]=UREA').replace('5.100000', '4.200000'));
    assert.deepEqual(blank(db, 123), { 'Глюкоза': '5.1' });
    assert.deepEqual(blank(db, 124), { 'Мочевина': '4.2' });
    assert.deepEqual(tray(db), []);
  } finally { await app.close(); db.close(); }
});
