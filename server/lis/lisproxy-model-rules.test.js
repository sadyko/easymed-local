// LIS_PROXY_V1 (ревью I2/I3) — у строк LIS Proxy правила значения и флага —
// модели прибора, те же, что у своего порта:
//   — BS-200 (D6): качественный ответ «+» / «Positive» подтверждённой строки —
//     «Отклонение», «-» / «Negative» — «Норма»; хвостовые нули — как у своего
//     порта (пин ingest.test.js «D6: BS-200»);
//   — AutoLumo A1000 (D9): ERR / GRY / незнакомый флаг — не писать (строка
//     бланка «не пришла», проба в лотке); ORH / ORL — «>предел» / «<предел»,
//     «Выше» / «Ниже»; сроки и контроль (CEX…) не мешают; CRH / CRL — критический.
// Провод синтетического ORU — lisproxy-chem / lisproxy-autobio / lisproxy
// (wire.js wireDecision: MSH-3 LISPROXY и MSH-4 LabPC → по модели строки).
import test from 'node:test';
import assert from 'node:assert/strict';
import { ingestMessage } from './ingest.js';
import { wireDecision } from './wire.js';
import { getProfile } from './profiles/index.js';
import { PROXY_APP } from './lisproxy-form.js';
import { FORWARDER_FACILITY } from './wire.js';
import { freshDb, seedLisProxyClinic, startProxyApp, post, lastRow, blank, bindPanel } from '../test-helpers/lisproxy-clinic.js';
import { listen } from '../../control-plane/server/test-helpers/listen.js';

const R = (o) => 'method=apiResultSave&lisResult[name]=' + (o.name || 'bs200') + '&lisResult[host]=' + (o.host ?? 'LAB-PC-1')
  + '&lisResult[barcode]=' + encodeURIComponent(o.barcode ?? 'LAB-000123') + '&lisResult[code]=' + encodeURIComponent(o.code ?? 'GLU')
  + '&lisResult[R][res]=' + encodeURIComponent(o.res ?? '5.1') + '&lisResult[R][unit]=&lisResult[R][norms]=' + encodeURIComponent(o.norms ?? '')
  + '&lisResult[R][flag]=' + encodeURIComponent(o.flag ?? '');
const LUMO = (res, flag) => R({ name: 'lumo', host: 'LAB-PC-2', barcode: 'B-000777', code: '214', res, flag });
const row = (db, vs) => db.prepare('SELECT value, flag FROM lab_results WHERE visit_service_id = ?').get(vs);

async function withClinic(fn) {
  const db = freshDb();
  seedLisProxyClinic(db);
  const app = await startProxyApp(db, { listen });
  try { await fn(db, app); } finally { await app.close(); db.close(); }
}

test('провод синтетического ORU — по модели строки: BS-200 — lisproxy-chem, A1000 — lisproxy-autobio, прочее и без модели — lisproxy', () => {
  const w = (key) => wireDecision({ profile: key ? getProfile(key) : null, app: PROXY_APP, facility: FORWARDER_FACILITY });
  assert.deepEqual(w('mindray-bs-200'), { wire: 'lisproxy-chem', conflict: false });
  assert.deepEqual(w('autobio-autolumo-a1000'), { wire: 'lisproxy-autobio', conflict: false });
  assert.deepEqual(w('mindray-bc-780'), { wire: 'lisproxy', conflict: false });
  assert.deepEqual(w(null), { wire: 'lisproxy', conflict: false });
  assert.deepEqual(wireDecision({ profile: getProfile('mindray-bs-200'), app: 'Mindray', facility: FORWARDER_FACILITY }),
    { wire: 'forwarder', conflict: false }, 'наш переадресатор с COM — как прежде');
});

test('BS-200 через LIS Proxy (D6): «+» и «Positive» — «Отклонение» при флаге прибора N; «-» и «Negative» — «Норма»', async () => {
  await withClinic(async (db, app) => {
    for (const [res, flag, want] of [['+', '', 'abnormal'], ['+', 'N', 'abnormal'], ['Positive', 'N', 'abnormal'], ['+-', 'N', 'abnormal'],
      ['-', '', 'normal'], ['Negative', 'N', 'normal']]) {
      db.prepare('DELETE FROM lab_results').run();
      assert.equal(await (await post(app.url, R({ res, flag }))).text(), 'Ok');
      assert.deepEqual(row(db, 123), { value: res, flag: want }, res + ' / ' + flag);
    }
  });
});

test('BS-200: свой порт и LIS Proxy — один и тот же флаг на «+» и одно и то же значение «5.10»', async () => {
  await withClinic(async (db, app) => {
    const nid = Number(db.prepare(`INSERT INTO lab_devices (name, profile, transport, host, port, enabled, discovered, added, model_confirmed)
                                   VALUES ('bs200-native', 'mindray-bs-200', 'mllp', '10.0.0.9', NULL, 1, 0, 1, 1)`).run().lastInsertRowid);
    bindPanel(db, { id: 12, serviceId: 12, deviceId: nid, name: 'Мочевина', lines: [['GLU', 'Глюкоза-нат', 'GLU']] });
    const oru = (v, t) => ['MSH|^~\\&|Mindray|BS-200E|||20261009120000||ORU^R01|1|P|2.3.1||||0||ASCII|||',
      'PID|1', 'OBR|1|LAB-000124|1|', `OBX|1|${t}|GLU|GLU|${v}|||N|||F||${v}|20261009120000||`].join('\r');
    for (const [v, t] of [['+', 'ST'], ['5.10', 'NM']]) {
      db.prepare('DELETE FROM lab_results').run();
      ingestMessage(db, oru(v, t), '10.0.0.9', nid);
      await post(app.url, R({ res: v, flag: 'N' }));
      assert.deepEqual(row(db, 123), row(db, 124), v + ': через прокси — как свой порт');
    }
    assert.deepEqual(row(db, 123), { value: '5.1', flag: 'normal' });
  });
});

test('AutoLumo через LIS Proxy (D9): ORH / ORL — «>» / «<» и «Выше» / «Ниже»; CEX не мешает; CRH — критический', async () => {
  await withClinic(async (db, app) => {
    for (const [flag, want] of [['ORH', { value: '>28.4', flag: 'high' }], ['ORL', { value: '<28.4', flag: 'low' }],
      ['CEX', { value: '28.4', flag: 'normal' }], ['CEX-ORH', { value: '>28.4', flag: 'high' }], ['CRH', { value: '28.4', flag: 'critical' }],
      ['N', { value: '28.4', flag: 'normal' }], ['', { value: '28.4', flag: 'normal' }]]) {
      db.prepare('DELETE FROM lab_results').run();
      assert.equal(await (await post(app.url, LUMO('28.4', flag))).text(), 'Ok');
      assert.deepEqual(row(db, 777), want, 'флаг «' + flag + '»');
      assert.equal(lastRow(db).status, 'applied', flag);
    }
  });
});

test('AutoLumo через LIS Proxy (D9): ERR, GRY, незнакомый флаг, «выше» вместе с «ниже» — в бланк не пишется, проба в лотке с флагами', async () => {
  await withClinic(async (db, app) => {
    for (const flag of ['ERR', 'GRY', 'QNS', 'XYZ', 'ORH-ORL', 'CEX-ERR']) {
      db.prepare('DELETE FROM lab_results').run();
      db.prepare('UPDATE lab_device_messages SET resolved_at = CURRENT_TIMESTAMP').run();
      assert.equal(await (await post(app.url, LUMO('28.4', flag))).text(), 'Ok', flag);
      assert.equal(row(db, 777), undefined, flag + ' — не записано');
      const m = lastRow(db);
      assert.equal(m.resolved_at, null, flag + ' — в лотке');
      assert.match(m.detail, new RegExp('флаги прибора: ' + flag), flag);
    }
  });
});

test('BC-780 через LIS Proxy — правила как у своего порта гематологии: значение как пришло, флаг прибора', async () => {
  await withClinic(async (db, app) => {
    await post(app.url, R({ name: 'bc780x', host: 'LABPC', barcode: 'LAB-000555', code: 'WBC', res: '11.50', flag: 'H' }));
    assert.deepEqual(row(db, 555), { value: '11.50', flag: 'high' });
  });
});
