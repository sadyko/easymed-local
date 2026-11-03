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
function tubesOf(db, visitId, { skipIds, today } = {}) {   // skipIds, today: ревью U11 — «услуга возвращена», сегодняшний день клиники
  const rows = db.prepare(`SELECT vs.*, s.name AS s_name, s.specimen AS s_specimen, s.is_lab AS s_is_lab
                             FROM visit_services vs JOIN services s ON s.id = vs.service_id
                            WHERE vs.visit_id = ? ORDER BY vs.id DESC`).all(visitId)
    .map(({ s_name, s_specimen, s_is_lab, ...vs }) => ({ ...vs, services: { name: s_name, specimen: s_specimen, is_lab: s_is_lab } }));
  const visit = db.prepare('SELECT visit_date FROM visits WHERE id = ?').get(visitId);
  const deviceByService = tubeDeviceMap(db.prepare('SELECT id, service_id, device_id, active FROM lab_panels').all());
  return tubeGroups(rows, { deviceByService, visitDate: visit.visit_date, skipIds, ...(today ? { today } : {}) });
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

// ═══ Ревью U11 — этикетки карточки через тот же, неизменный приём ═══════════

/** BC-780 с несколькими показателями: [[OBX-3, значение], …]. */
const BC780X = (sample, obx) => seg(
  'MSH|^~\\&|BC-780|Mindray|||20261102140600||ORU^R01|1|P|2.3.1||||||UNICODE',
  'PID|1||^^^^MR',
  'PV1|1',
  `OBR|1||${sample}|00001^Automated Count^99MRC|||20261102140600`,
  ...obx.map(([c, v], i) => `OBX|${i + 1}|NM|${c}||${v}|10*9/L|4.0-10.0|N|||F`),
);
// BS-200 — провод биохимии Mindray: номер пробы — OBR-2, один тест в сообщении.
const BS200 = (sample, code, value, id = 1) => [
  `MSH|^~\\&|Mindray|BS-200|||20261020124717||ORU^R01|${id}|P|2.3.1||||0||ASCII|||`,
  'PID|1|900001|||X||19900101000000|M|||||||||||||||||||||||',
  `OBR|1|${sample}|7|Mindray^BS-200|N||20261020124717||||||||serum|||||||||||||||||||||||||||||||||`,
  `OBX|1|NM|${code}|${code}|${value}|mmol/L|-|N|||F|||20261020124717|||`].join('\r');

/** Визит 20 на BC-780 № 3: «Анализ крови» (WBC) и «Ретикулоциты» (RET) — оба кормит прибор, материал не указан. */
function bloodRetClinic() {
  const db = freshDb();
  db.exec(`
    INSERT INTO lab_devices (id, name, profile, transport, host, port, enabled, discovered, added, model_confirmed)
      VALUES (3, 'BC-780', 'mindray-bc-780', 'mllp', '10.0.0.50', NULL, 1, 0, 1, 1);
    INSERT INTO patients (id, full_name) VALUES (7, 'Тестов');
    INSERT INTO visits (id, patient_id, visit_date, status) VALUES (20, 7, ${NOW}, 'scheduled');
    INSERT INTO services (id, name, is_lab, specimen) VALUES (40, 'Анализ крови', 1, NULL), (42, 'Ретикулоциты', 1, NULL);
  `);
  bindPanel(db, { id: 40, serviceId: 40, deviceId: 3, name: 'ОАК', lines: [['WBC', 'Лейкоциты', 'WBC']] });
  bindPanel(db, { id: 42, serviceId: 42, deviceId: 3, name: 'RET', lines: [['RET', 'Ретикулоциты', 'RET%']] });
  return db;
}

// M1 (проба P2k). Стационар: «Биохимия» (BS-200, сыворотка: GLU, K) утром взята и
// посчитана, не выдана; вечером врач назначил «Электролиты» (BS-200, сыворотка: K,
// NA) — новый забор. Карточка давала вечерней пробирке номер утренней строки (№ 60),
// и вечерний калий ложился в № 60 поверх утреннего; № 66 калия не получал.
test('ревью U11, M1: вечерний забор того же дня — своя этикетка; калий вечера — в № 66, утренний черновик № 60 цел', () => {
  const db = freshDb();
  db.exec(`
    INSERT INTO lab_devices (id, name, profile, transport, host, port, enabled, discovered, added, model_confirmed)
      VALUES (1, 'BS-200', 'mindray-bs-200', 'mllp', '10.0.0.40', NULL, 1, 0, 1, 1);
    INSERT INTO patients (id, full_name) VALUES (7, 'Тестов');
    INSERT INTO visits (id, patient_id, visit_date, status) VALUES (70, 7, ${NOW}, 'scheduled');
    INSERT INTO services (id, name, is_lab, specimen) VALUES (9, 'Биохимия', 1, 'Сыворотка'), (14, 'Электролиты', 1, 'Сыворотка');
    INSERT INTO visit_services (id, visit_id, service_id, status, created_at, sample_collected_at) VALUES (60, 70, 9, 'resulted', ${NOW}, ${NOW});`);
  bindPanel(db, { id: 9, serviceId: 9, deviceId: 1, name: 'Биохимия', lines: [['GLU', 'Глюкоза', 'GLU'], ['K', 'Калий', 'K']] });
  bindPanel(db, { id: 14, serviceId: 14, deviceId: 1, name: 'Электролиты', lines: [['K', 'Калий', 'K'], ['NA', 'Натрий', 'NA']] });
  db.exec(`INSERT INTO lab_results (visit_service_id, parameter, value, flag, source) VALUES (60, 'Калий', '4.1', 'normal', 'analyzer')`);
  db.exec(`INSERT INTO visit_services (id, visit_id, service_id, status, created_at) VALUES (66, 70, 14, 'queued', ${NOW})`);
  const tubes = tubesOf(db, 70);
  assert.deepEqual(tubes.map((t) => [t.code, t.rowIds]), [['00000060', [60]], ['00000066', [66]]]);
  const evening = tubes.find((t) => t.rowIds.includes(66));
  ingestMessage(db, BS200(evening.code, 'K', '5.9'), '10.0.0.40', 1);
  assert.equal(lastRow(db).visit_service_id, 66, lastRow(db).detail);
  ingestMessage(db, BS200(evening.code, 'NA', '140', 2), '10.0.0.40', 1);
  assert.deepEqual(blank(db, 60), { 'Калий': '4.1' }, 'утренний калий не перезаписан');
  assert.deepEqual(blank(db, 66), { 'Калий': '5.9', 'Натрий': '140' });
  db.close();
});

// M1, обратная сторона (пробы P2b/c): анализ добавили ПОСЛЕ забора — у него своя
// этикетка, но и прежняя пробирка годится: прогнали её снова с прежней этикеткой
// (№ 28) — приём кладёт пробу в № 28, а новую строку заполняет как соседа (D3).
test('ревью U11, M1: добавили анализ после забора — своя этикетка; прежняя пробирка (№ 28), прогнанная снова, заполняет и его', () => {
  const db = bloodRetClinic();
  db.exec(`INSERT INTO visit_services (id, visit_id, service_id, status, created_at, sample_collected_at) VALUES (28, 20, 40, 'collected', ${NOW}, ${NOW});
           INSERT INTO visit_services (id, visit_id, service_id, status, created_at) VALUES (31, 20, 42, 'queued', ${NOW});`);
  assert.deepEqual(tubesOf(db, 20).map((t) => [t.code, t.rowIds]), [['00000028', [28]], ['00000031', [31]]]);
  ingestMessage(db, BC780X('00000028', [['6690-2^WBC^LN', '7.1'], ['RET%', '1.2']]), '10.0.0.50', 3);
  assert.equal(lastRow(db).visit_service_id, 28, lastRow(db).detail);
  assert.deepEqual(blank(db, 28), { 'Лейкоциты': '7.1' });
  assert.deepEqual(blank(db, 31), { 'Ретикулоциты': '1.2' }, 'новый анализ заполнен из прежней пробирки (D3)');
  db.close();
});

test('ревью U11, M1: добавили анализ ДО забора — одна пробирка, номер прежний (№ 28), прибор заполняет обе строки', () => {
  const db = bloodRetClinic();
  db.exec(`INSERT INTO visit_services (id, visit_id, service_id, status, created_at) VALUES (28, 20, 40, 'queued', ${NOW}), (31, 20, 42, 'queued', ${NOW});`);
  const tubes = tubesOf(db, 20);
  assert.deepEqual(tubes.map((t) => [t.code, t.rowIds]), [['00000028', [28, 31]]]);
  ingestMessage(db, BC780X(tubes[0].code, [['6690-2^WBC^LN', '7.1'], ['RET%', '1.2']]), '10.0.0.50', 3);
  assert.deepEqual([blank(db, 28), blank(db, 31)], [{ 'Лейкоциты': '7.1' }, { 'Ретикулоциты': '1.2' }]);
  db.close();
});

// M3 (проба P2d) — почему касса напоминает перепечатать после «Вернуть услугу»:
// у пробирки крови № 28 и № 31 («Анализ крови» дважды); № 28 вернули. Номер
// пробирки — теперь № 31 (К4), а с прежней этикеткой BC-780 кладёт кровь в лоток.
test('ревью U11, M3: вернули № 28 — у пробирки номер № 31; прежняя этикетка — в лоток («по заказу возврат»), новая — в № 31', () => {
  const db = bloodRetClinic();
  db.exec(`INSERT INTO visit_services (id, visit_id, service_id, status, created_at) VALUES (28, 20, 40, 'collected', ${NOW}), (31, 20, 40, 'collected', ${NOW});
           INSERT INTO pay_refund_releases (kind, line_id, invoice_id) VALUES ('out', 28, 1);`);
  assert.deepEqual(tubesOf(db, 20).map((t) => [t.code, t.rowIds]), [['00000028', [28, 31]]]);
  const after = tubesOf(db, 20, { skipIds: new Set([28]) });
  assert.deepEqual(after.map((t) => [t.code, t.rowIds]), [['00000031', [31]]]);
  ingestMessage(db, BC780('00000028'), '10.0.0.50', 3);
  assert.deepEqual([lastRow(db).status, lastRow(db).visit_service_id], ['unmatched', null], lastRow(db).detail);
  assert.match(lastRow(db).detail, /по заказу возврат/);
  ingestMessage(db, BC780(after[0].code, '7.3'), '10.0.0.50', 3);
  assert.deepEqual([lastRow(db).status, lastRow(db).visit_service_id], ['applied', 31], lastRow(db).detail);
  db.close();
});

// L6 (проба P2e, 9 дней). Срок — общий с приёмом: «свежая» пробирка ровно та, чей
// голый номер приём принимает; день-граница (7 дней) — ещё да, 8 — уже нет.
test('ревью U11, L6: карточка печатает пробирку, только пока приём примет её номер — 0, 7 дней да; 8, 9 — нет', () => {
  for (const [days, recent] of [[0, true], [7, true], [8, false], [9, false]]) {
    const db = bloodRetClinic();
    // Местный полдень того дня: местный день одинаков и у SQLite, и у JS.
    const at = `strftime('%Y-%m-%dT07:00:00Z', 'now', 'localtime', '-${days} days')`;
    db.exec(`UPDATE visits SET visit_date = ${at} WHERE id = 20;
             INSERT INTO visit_services (id, visit_id, service_id, status, created_at) VALUES (28, 20, 40, 'queued', ${at});`);
    const today = db.prepare("SELECT date('now','localtime') d").get().d;
    const [t] = tubesOf(db, 20, { today });
    assert.equal(t.recent, recent, days + ' дн.: ' + t.day);
    ingestMessage(db, BC780(t.code), '10.0.0.50', 3);
    const m = lastRow(db);
    assert.equal(m.status === 'applied', recent, days + ' дн.: ' + m.status + ' — ' + m.detail);
    if (!recent) assert.match(m.detail, /старше 7 дней/);
    db.close();
  }
});
