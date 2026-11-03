// LAB_TUBE_LABEL_V1 (решение владельца 2026-11-02) — этикетка, которую печатает
// карточка очереди, ведёт пробу в нужный заказ.
//
// Снимок владельца (тестовая клиника, визит 20): четыре лабораторные строки —
// № 28 «Анализ крови» и № 29 «Анализ мочи» (счёт А), № 31 «Анализ крови» и
// № 32 «Анализ мочи» (счёт Б). «Штрих-код» печатал ОДНУ этикетку с номером самой
// новой строки — 00000032, мочи счёта Б. BC-780 прислал кровь с этим номером:
// заказ № 32 он не кормит, а заказов крови, которые кормит, два открытых (№ 28 и
// № 31) — «неоднозначно» (LAB_TUBE_ANCHOR_V1, ревью 3.17.1 M1), не записано ничего.
//
// Теперь номер считает views/lab-tube.js — тот же модуль, что у экрана: пробирка
// крови — № 28, самая старая её строка, и прибор этот заказ кормит сам. Приём НЕ
// меняется: заказ номера кормит прибор — проба в нём, остальное делит D3; старые
// этикетки читаются, как прежде.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ingestMessage, worklistLines } from './ingest.js';
import { freshDb, bindPanel, lastRow, blank } from '../test-helpers/lisproxy-clinic.js';
import { tubeGroups, tubeDeviceMap } from '../../public/js/admin/views/lab-tube.js';

const NOW = "strftime('%Y-%m-%dT%H:%M:%SZ','now')";
const seg = (...s) => s.join('\r');
const statusOf = (db, id) => db.prepare('SELECT status FROM visit_services WHERE id = ?').get(id).status;

// BC-780 — провод гематологии Mindray (как dial.test.js): номер пробы — OBR-3.
const BC780 = (sample, wbc = '7.25') => seg(
  'MSH|^~\\&|BC-780|Mindray|||20261102140600||ORU^R01|1|P|2.3.1||||||UNICODE',
  'PID|1||^^^^MR',
  'PV1|1',
  `OBR|1||${sample}|00001^Automated Count^99MRC|||20261102140600`,
  `OBX|1|NM|6690-2^WBC^LN||${wbc}|10*9/L|4.0-10.0|N|||F`,
);

/** Визит 20 со снимка: кровь (услуга 40, панель на BC-780 № 3, WBC подтверждён) и моча (41, панели нет); материал не указан. */
function photoClinic() {
  const db = freshDb();
  db.exec(`
    INSERT INTO lab_devices (id, name, profile, transport, host, port, enabled, discovered, added, model_confirmed)
      VALUES (3, 'BC-780', 'mindray-bc-780', 'mllp', '10.0.0.50', NULL, 1, 0, 1, 1);
    INSERT INTO patients (id, full_name) VALUES (7, 'Тестов');
    INSERT INTO visits (id, patient_id, visit_date, status) VALUES (20, 7, ${NOW}, 'scheduled');
    INSERT INTO services (id, name, is_lab, specimen) VALUES (40, 'Анализ крови', 1, NULL), (41, 'Анализ мочи', 1, NULL);
    INSERT INTO visit_services (id, visit_id, service_id, status, created_at) VALUES
      (28, 20, 40, 'queued', ${NOW}), (29, 20, 41, 'queued', ${NOW}),
      (31, 20, 40, 'queued', ${NOW}), (32, 20, 41, 'queued', ${NOW});
  `);
  bindPanel(db, { id: 40, serviceId: 40, deviceId: 3, name: 'ОАК', lines: [['WBC', 'Лейкоциты', 'WBC']] });
  return db;
}

/** Пробирки визита — модулем экрана, из строк в порядке очереди (новые первыми). */
function tubesOf(db, visitId) {
  const rows = db.prepare(`SELECT vs.*, s.name AS s_name, s.specimen AS s_specimen, s.is_lab AS s_is_lab
                             FROM visit_services vs JOIN services s ON s.id = vs.service_id
                            WHERE vs.visit_id = ? ORDER BY vs.id DESC`).all(visitId)
    .map(({ s_name, s_specimen, s_is_lab, ...vs }) => ({ ...vs, services: { name: s_name, specimen: s_specimen, is_lab: s_is_lab } }));
  const visit = db.prepare('SELECT visit_date FROM visits WHERE id = ?').get(visitId);
  const deviceByService = tubeDeviceMap(db.prepare('SELECT id, service_id, device_id, active FROM lab_panels').all());
  return tubeGroups(rows, { deviceByService, visitDate: visit.visit_date });
}

test('снимок владельца: этикетка пробирки крови — № 28, и BC-780 кладёт кровь в № 28', () => {
  const db = photoClinic();
  const tubes = tubesOf(db, 20);
  assert.deepEqual(tubes.map((t) => [t.code, t.rowIds]), [['00000028', [28, 31]], ['00000029', [29]], ['00000032', [32]]]);
  const blood = tubes.find((t) => t.rowIds.includes(31));
  assert.equal(ingestMessage(db, BC780(blood.code), '10.0.0.50', 3), 'AA');
  const m = lastRow(db);
  assert.deepEqual([m.status, m.visit_service_id, m.sample_id], ['applied', 28, '00000028'], m.detail);
  assert.deepEqual(blank(db, 28), { 'Лейкоциты': '7.25' });
  assert.deepEqual(blank(db, 31), {}, 'вторая строка крови той же пробирки значений не получает: заказ пробирки берёт свои коды первым (planTube)');
  assert.equal(statusOf(db, 28), 'resulted');
  for (const id of [29, 31, 32]) assert.equal(statusOf(db, id), 'queued', 'заказ № ' + id);
  // Рабочий список по той же этикетке (LIS Proxy, запрос прибора) — тесты пробирки крови.
  assert.deepEqual(worklistLines(db, { deviceId: 3, orderId: blood.labelId, bare: true, shown: blood.code }).codes, ['WBC']);
  db.close();
});

test('строка крови, добавленная позже, номер пробирки не меняет — проба по-прежнему в № 28', () => {
  const db = photoClinic();
  db.exec(`INSERT INTO visit_services (id, visit_id, service_id, status, created_at) VALUES (35, 20, 40, 'queued', ${NOW})`);
  const blood = tubesOf(db, 20)[0];
  assert.deepEqual([blood.code, blood.rowIds], ['00000028', [28, 31, 35]]);
  ingestMessage(db, BC780(blood.code), '10.0.0.50', 3);
  assert.deepEqual([lastRow(db).status, lastRow(db).visit_service_id], ['applied', 28], lastRow(db).detail);
  db.close();
});

test('старые этикетки — как прежде: 00000032 (моча) — «неоднозначно», ничего не записано; LAB-000028 — в № 28', () => {
  const db = photoClinic();
  ingestMessage(db, BC780('00000032'), '10.0.0.50', 3);
  const m = lastRow(db);
  assert.deepEqual([m.status, m.visit_service_id], ['unmatched', null], m.detail);
  assert.match(m.detail, /^неоднозначно: номер пробы — заказ № 32 «Анализ мочи»/);
  assert.match(m.detail, /одни и те же анализы/);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM lab_results').get().c, 0);
  ingestMessage(db, BC780('LAB-000028'), '10.0.0.50', 3);
  assert.deepEqual([lastRow(db).status, lastRow(db).visit_service_id], ['applied', 28], lastRow(db).detail);
  db.close();
});
