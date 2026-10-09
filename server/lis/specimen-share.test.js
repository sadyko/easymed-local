// LIS_PROXY_V1 (ревью C1) — «одна пробирка — все услуги визита» (D3, решение
// владельца 2026-10-06, п. 2) только между заказами ОДНОГО материала: пробирка
// мочи не заполняет «Биохимию» сыворотки, и рабочий список пробирки мочи не
// велит анализатору гнать на моче глюкозу сыворотки. На обоих путях: свой порт
// LIS (MLLP) и LIS Proxy.
//
// Материал — services.specimen, свободный текст («Материал (кровь, моча…)»):
// моча / плазма / сыворотка / кровь узнаются по слову, прочее сравнивается
// текстом. Не указан у ОБОИХ — один материал (D3 как прежде: клиника, которая
// поле не заполняет, ничего не теряет); не указан у одного — разные: делить
// пробирку не на чем, значение — в «не использованы», его видно.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ingestMessage, worklistLines, specimenKey } from './ingest.js';
import { freshDb, seedLisProxyClinic, bindPanel, startProxyApp, post, lastRow, blank } from '../test-helpers/lisproxy-clinic.js';
import { listen } from '../../control-plane/server/test-helpers/listen.js';

test('specimenKey: моча, плазма, сыворотка, кровь — по слову; прочее — текстом; пусто — не указан', () => {
  assert.deepEqual(['Моча', 'моча (утренняя)', 'Urine'].map(specimenKey), ['urine', 'urine', 'urine']);
  assert.deepEqual(['Плазма', 'Плазма крови (цитрат)'].map(specimenKey), ['plasma', 'plasma']);
  assert.deepEqual(['Сыворотка', 'Сыворотка крови', 'serum'].map(specimenKey), ['serum', 'serum', 'serum']);
  assert.deepEqual(['Кровь', 'Цельная кровь (ЭДТА)', 'whole blood'].map(specimenKey), ['blood', 'blood', 'blood']);
  assert.deepEqual(['Кал', '  Мокрота '].map(specimenKey), ['кал', 'мокрота']);
  assert.deepEqual([null, '', '   '].map(specimenKey), ['', '', '']);
});

// ── Свой порт (MLLP): BS-200, номер теста — OBX-3 ─────────────────────────
const BS2 = (sample, code, value, id = 1) => [
  `MSH|^~\\&|Mindray|BS-200|||20261009124717||ORU^R01|${id}|P|2.3.1||||0||ASCII|||`,
  'PID|1|900001|||Тестов Анализатор||19900101000000|M|||||||||||||||||||||||',
  `OBR|1|${sample}|7|Mindray^BS-200|N||20261009124717||||||||serum|||||||||||||||||||||||||||||||||`,
  `OBX|1|NM|${code}|${code}|${value}|mmol/L|-|N|||F|||20261009124717|||`].join('\r');

/**
 * Визит 55 Иванова, прибор № 1 — BS-200 своего порта (добавлен):
 *   123 «Биохимия» (Сыворотка, GLU); 140 «Общий анализ мочи» (Моча, UPRO);
 *   141 «Креатинин» (материал не указан, CREA); 142 «HbA1c» (Кровь, HBA1C);
 *   143 «Альбумин» (материал не указан, ALB).
 */
function ownPortClinic() {
  const db = freshDb();
  const now = "strftime('%Y-%m-%dT%H:%M:%SZ','now')";
  db.exec(`
    INSERT INTO lab_devices (id, name, profile, transport, host, port, enabled, discovered, added, model_confirmed)
      VALUES (1, 'BS-200', 'mindray-bs-200', 'mllp', '10.0.0.40', NULL, 1, 0, 1, 1);
    INSERT INTO patients (id, full_name, date_of_birth, gender) VALUES (3, 'Иванов Иван', '1990-02-03', 'male');
    INSERT INTO visits (id, patient_id, visit_date, status) VALUES (55, 3, ${now}, 'scheduled');
    INSERT INTO services (id, name, is_lab, specimen) VALUES
      (9, 'Биохимия', 1, 'Сыворотка'), (13, 'Общий анализ мочи', 1, 'Моча'), (14, 'Креатинин', 1, NULL),
      (15, 'HbA1c', 1, 'Кровь'), (16, 'Альбумин', 1, NULL);
    INSERT INTO visit_services (id, visit_id, service_id, status, created_at) VALUES
      (123, 55, 9, 'queued', ${now}), (140, 55, 13, 'queued', ${now}), (141, 55, 14, 'queued', ${now}),
      (142, 55, 15, 'queued', ${now}), (143, 55, 16, 'queued', ${now});
  `);
  bindPanel(db, { id: 9, serviceId: 9, deviceId: 1, name: 'Биохимия', lines: [['GLU', 'Глюкоза', 'GLU']] });
  bindPanel(db, { id: 13, serviceId: 13, deviceId: 1, name: 'Моча', lines: [['UPRO', 'Белок мочи', 'UPRO']] });
  bindPanel(db, { id: 14, serviceId: 14, deviceId: 1, name: 'Креатинин', lines: [['CREA', 'Креатинин', 'CREA']] });
  bindPanel(db, { id: 15, serviceId: 15, deviceId: 1, name: 'HbA1c', lines: [['HBA1C', 'HbA1c', 'HBA1C']] });
  bindPanel(db, { id: 16, serviceId: 16, deviceId: 1, name: 'Альбумин', lines: [['ALB', 'Альбумин', 'ALB']] });
  return db;
}
const own = (db, sample, code, value) => ingestMessage(db, BS2(sample, code, value), '10.0.0.40', 1);

test('свой порт: глюкоза из пробирки мочи не ложится в «Биохимию» сыворотки — ни в пустую строку, ни поверх 5.1', () => {
  const db = ownPortClinic();
  own(db, 'LAB-000140', 'GLU', '0.3');
  assert.deepEqual(blank(db, 123), {}, 'пустая строка сыворотки не заполнена мочой');
  const m = lastRow(db);
  assert.equal(m.visit_service_id, 140);
  assert.notEqual(m.status, 'applied');
  assert.match(m.detail, /не использованы: GLU/);
  own(db, 'LAB-000123', 'GLU', '5.1');
  assert.deepEqual(blank(db, 123), { 'Глюкоза': '5.1' });
  own(db, 'LAB-000140', 'GLU', '0.3');
  assert.deepEqual(blank(db, 123), { 'Глюкоза': '5.1' }, '5.1 сыворотки не переписан мочой');
  own(db, 'LAB-000140', 'UPRO', '0.1');
  assert.deepEqual(blank(db, 140), { 'Белок мочи': '0.1' }, 'своя услуга пробирки мочи — как прежде');
  db.close();
});

test('свой порт: материал не указан у одной стороны, «кровь» против «сыворотки» — не делят; не указан у обеих — делят (D3 как прежде)', () => {
  const db = ownPortClinic();
  own(db, 'LAB-000123', 'CREA', '80');
  assert.deepEqual(blank(db, 141), {}, 'сыворотка → заказ без материала: не делят');
  own(db, 'LAB-000123', 'HBA1C', '5.6');
  assert.deepEqual(blank(db, 142), {}, 'сыворотка → кровь: не делят');
  own(db, 'LAB-000143', 'CREA', '81');
  assert.deepEqual(blank(db, 141), { 'Креатинин': '81' }, 'материал не указан у обоих — одна пробирка, как прежде');
  db.close();
});

test('свой порт: рабочий список (worklistLines) тем же правилом — пробирка сыворотки без кодов мочи, крови и без материала', () => {
  const db = ownPortClinic();
  assert.deepEqual(worklistLines(db, { deviceId: 1, orderId: 123 }).codes, ['GLU']);
  assert.deepEqual(worklistLines(db, { deviceId: 1, orderId: 140 }).codes, ['UPRO']);
  assert.deepEqual(worklistLines(db, { deviceId: 1, orderId: 143 }).codes, ['ALB', 'CREA'], 'не указан у обоих — делят');
  db.close();
});

// ── LIS Proxy: рабочий список и результат ─────────────────────────────────
const R = (bc, code, res) => 'method=apiResultSave&lisResult[name]=bs200&lisResult[host]=LAB-PC-1&lisResult[barcode]=' + bc
  + '&lisResult[code]=' + code + '&lisResult[R][res]=' + res + '&lisResult[R][unit]=&lisResult[R][norms]=&lisResult[R][flag]=';
const ask = (bc) => 'method=apiOrderGet&order[name]=bs200&order[host]=LAB-PC-1&order[barcode]=' + bc;

async function proxyClinic(fn) {
  const db = freshDb();
  seedLisProxyClinic(db);
  // № 140 «Общий анализ мочи» (Моча) — тот же визит, что № 123 «Биохимия» (Сыворотка); обе панели — на bs200.
  db.prepare("INSERT INTO visit_services (id, visit_id, service_id, status, created_at) VALUES (140, 55, 13, 'queued', strftime('%Y-%m-%dT%H:%M:%SZ','now'))").run();
  bindPanel(db, { id: 13, serviceId: 13, deviceId: 1, name: 'Моча', lines: [['UPRO', 'Белок мочи', 'UPRO']] });
  const app = await startProxyApp(db, { listen });
  try { await fn(db, app); } finally { await app.close(); db.close(); }
}

test('LIS Proxy: рабочий список пробирки мочи — без глюкозы сыворотки, пробирки сыворотки — без белка мочи', async () => {
  await proxyClinic(async (db, app) => {
    const urine = await (await post(app.url, ask('LAB-000140'))).json();
    assert.deepEqual(Object.values(urine).map((e) => [e.code, e.biomaterial_code]), [['UPRO', 'urine']]);
    const serum = await (await post(app.url, ask('LAB-000123'))).json();
    assert.deepEqual(Object.values(serum).map((e) => [e.code, e.biomaterial_code]), [['GLU', 'serum']]);
  });
});

test('LIS Proxy: глюкоза из пробирки мочи не заполняет и не переписывает «Биохимию» сыворотки', async () => {
  await proxyClinic(async (db, app) => {
    await post(app.url, R('LAB-000140', 'UPRO', '0.1'));
    await post(app.url, R('LAB-000140', 'GLU', '0.3'));
    assert.deepEqual(blank(db, 123), {}, 'пустая строка сыворотки не заполнена мочой');
    assert.equal(lastRow(db).visit_service_id, 140);
    await post(app.url, R('LAB-000123', 'GLU', '5.1'));
    await post(app.url, R('LAB-000140', 'GLU', '0.3'));
    assert.deepEqual(blank(db, 123), { 'Глюкоза': '5.1' }, '5.1 не переписан');
    assert.deepEqual(blank(db, 140), { 'Белок мочи': '0.1' });
  });
});
