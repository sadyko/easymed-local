// LAB_ONE_BARCODE_V1 (решение владельца 2026-11-07, п. 10) — ОДИН ШТРИХ-КОД НА ДЕНЬ ВИЗИТА.
//
// Жалоба клиники: «значения не ставятся, если анализ заказан не первым (например,
// ОАК второй в списке)». Воспроизведено настоящим приёмом (тест 1): у визита
// «СОЭ» (панель на BC-780, материал не указан) и «ОАК» (BC-780, «Кровь»). Этикетка
// карточки 3.21 — по пробирке на материал: «СОЭ» и «ОАК» получили РАЗНЫЕ номера,
// хотя пробирка одна; лаборатория клеит первую (№ 100). Приём кладёт пробу в
// заказ номера, а другие заказы визита заполняет только того же материала (D3,
// ревью C1): «не указан» и «Кровь» — разные, и WBC уходил в «не использованы».
//
// Корень: номер на пробирке называл ЗАКАЗ, а пробирка одна на несколько заказов.
// Теперь карточка печатает один номер на день визита (shared/lab-day-label.js:
// 9 и семь цифр), одну и ту же этикетку на каждую пробирку, и приём по нему
// заполняет каждую строку этого дня визита, которую кормит прибор, в любом порядке.
// Этикетки строк и этикетки 3.21, уже наклеенные, читаются по прежним правилам.
process.env.TZ = 'Asia/Tashkent';
const { default: test } = await import('node:test');
const { default: assert } = await import('node:assert/strict');
const { ingestMessage, worklistLines } = await import('./ingest.js');
const { lisMessageAttach } = await import('../services/rpc/lis.js');
const { freshDb, bindPanel, lastRow, blank } = await import('../test-helpers/lisproxy-clinic.js');
const { dayLabelValue, dayLabelLine, DAY_LABEL_BASE } = await import('../../public/js/shared/lab-day-label.js');
const { normaliseProxyBarcode } = await import('./lisproxy-form.js');

const NOW = "strftime('%Y-%m-%dT%H:%M:%SZ','now')";
const seg = (...s) => s.join('\r');
const statusOf = (db, id) => db.prepare('SELECT status FROM visit_services WHERE id = ?').get(id).status;
const resultsOf = (db) => db.prepare('SELECT COUNT(*) c FROM lab_results').get().c;

// BC-780 — провод гематологии Mindray: номер пробы — OBR-3; [[OBX-3, значение], …].
const BC780 = (sample, obx = [['6690-2^WBC^LN', '7.25']]) => seg(
  'MSH|^~\\&|BC-780|Mindray|||20261107090000||ORU^R01|1|P|2.3.1||||||UNICODE',
  'PID|1||^^^^MR', 'PV1|1',
  `OBR|1||${sample}|00001^Automated Count^99MRC|||20261107090000`,
  ...obx.map(([c, v], i) => `OBX|${i + 1}|NM|${c}||${v}|10*9/L|4.0-10.0|N|||F`));
// BS-200 — провод биохимии Mindray: номер пробы — OBR-2, материал — OBR-15, один тест в сообщении.
let bsId = 0;
const BS200 = (sample, code, value, material = 'serum') => [
  `MSH|^~\\&|Mindray|BS-200|||20261107090000||ORU^R01|${++bsId}|P|2.3.1||||0||ASCII|||`,
  'PID|1|900001|||X||19900101000000|M|||||||||||||||||||||||',
  `OBR|1|${sample}|7|Mindray^BS-200|N||20261107090000||||||||${material}|||||||||||||||||||||||||||||||||`,
  `OBX|1|NM|${code}|${code}|${value}|mmol/L|-|N|||F|||20261107090000|||`].join('\r');

const DEVICES = `INSERT INTO lab_devices (id, name, profile, transport, host, port, enabled, discovered, added, model_confirmed) VALUES
  (3, 'BC-780', 'mindray-bc-780', 'mllp', '10.0.0.50', NULL, 1, 0, 1, 1),
  (1, 'BS-200', 'mindray-bs-200', 'mllp', '10.0.0.40', NULL, 1, 0, 1, 1)`;

/**
 * Визит 20 (сегодня). lines — [id, serviceId, status] по порядку заказа. Услуги:
 *   40 «СОЭ» — BC-780 (ESR), материал не указан; 41 «ОАК» — BC-780 (WBC), «Кровь»;
 *   42 «Биохимия» — BS-200 (GLU, CREA), «Сыворотка»; 43 «Белок мочи» — BS-200 (UPRO, CREA), «Моча»;
 *   44 «Ретикулоциты» — BC-780 (RET), «Кровь»; 45 «Время свертываемости» — без панели.
 */
function clinic(lines, { urineCrea = false } = {}) {
  const db = freshDb();
  db.exec(`${DEVICES};
    INSERT INTO patients (id, full_name) VALUES (7, 'Тестов');
    INSERT INTO visits (id, patient_id, visit_date, status) VALUES (20, 7, ${NOW}, 'scheduled');
    INSERT INTO services (id, name, is_lab, specimen) VALUES
      (40, 'СОЭ', 1, NULL), (41, 'ОАК', 1, 'Кровь'), (42, 'Биохимия', 1, 'Сыворотка'),
      (43, 'Белок мочи', 1, 'Моча'), (44, 'Ретикулоциты', 1, 'Кровь'), (45, 'Время свертываемости', 1, NULL);`);
  for (const [id, sid, status = 'queued'] of lines) {
    db.prepare(`INSERT INTO visit_services (id, visit_id, service_id, status, created_at) VALUES (?, 20, ?, ?, ${NOW})`).run(id, sid, status);
  }
  bindPanel(db, { id: 40, serviceId: 40, deviceId: 3, name: 'СОЭ', lines: [['ESR', 'СОЭ', 'ESR']] });
  bindPanel(db, { id: 41, serviceId: 41, deviceId: 3, name: 'ОАК', lines: [['WBC', 'Лейкоциты', 'WBC']] });
  bindPanel(db, { id: 42, serviceId: 42, deviceId: 1, name: 'Биохимия', lines: [['GLU', 'Глюкоза', 'GLU'], ['CREA', 'Креатинин', 'CREA']] });
  bindPanel(db, { id: 43, serviceId: 43, deviceId: 1, name: 'Белок мочи', lines: [['UPRO', 'Белок мочи', 'UPRO'], ...(urineCrea ? [['CREA', 'Креатинин мочи', 'CREA']] : [])] });
  bindPanel(db, { id: 44, serviceId: 44, deviceId: 3, name: 'Ретикулоциты', lines: [['RET', 'Ретикулоциты', 'RET']] });
  return db;
}
const bc = (db, sample, obx) => ingestMessage(db, BC780(sample, obx), '10.0.0.50', 3);
const bs = (db, sample, code, value, material) => ingestMessage(db, BS200(sample, code, value, material), '10.0.0.40', 1);

test('номер этикетки дня: 9 и семь цифр (90000000 + строка), обратно — строка; прочие номера — не этикетка дня', () => {
  assert.equal(DAY_LABEL_BASE, 90000000);
  assert.equal(dayLabelValue(100), '90000100');
  assert.equal(dayLabelValue(9999999), '99999999');
  assert.equal(dayLabelValue(10000000), '', 'строка не помещается — этикетки дня нет');
  assert.equal(dayLabelLine(90000100), 100);
  assert.equal(dayLabelLine('90000100'), 100);
  for (const n of [100, 90000000, 100000000, '00000100', 'x']) assert.equal(dayLabelLine(n), null, String(n));
  // LIS Proxy и правило голых цифр принимают её как напечатано — 8 цифр.
  const p = normaliseProxyBarcode('90000100');
  assert.deepEqual([p.ok, p.orderId, p.bare], [true, 90000100, true]);
});

test('жалоба клиники воспроизведена: этикетка строки «СОЭ» (первой) на пробирке крови — ОАК (второй) пуст, «не использованы»; этикетка дня — заполнены оба', () => {
  const db = clinic([[100, 40], [101, 41]]);
  bc(db, '00000100', [['ESR', '12'], ['6690-2^WBC^LN', '7.25']]);
  assert.deepEqual(blank(db, 100), { 'СОЭ': '12' });
  assert.deepEqual(blank(db, 101), {}, 'старое правило этикетки строки (D3, ревью C1) — как прежде');
  assert.match(lastRow(db).detail, /не использованы: 6690-2\^WBC\^LN/);
  db.close();

  const db2 = clinic([[100, 40], [101, 41]]);
  assert.equal(bc(db2, dayLabelValue(100), [['ESR', '12'], ['6690-2^WBC^LN', '7.25']]), 'AA');
  const m = lastRow(db2);
  assert.equal(m.status, 'applied', m.detail);
  assert.equal(m.sample_id, '90000100');
  assert.deepEqual([blank(db2, 100), blank(db2, 101)], [{ 'СОЭ': '12' }, { 'Лейкоциты': '7.25' }]);
  assert.deepEqual([statusOf(db2, 100), statusOf(db2, 101)], ['resulted', 'resulted']);
  db2.close();
});

test('ОАК второй, первая — «Биохимия» BS-200: один номер дня — BC-780 заполняет ОАК, BS-200 — «Биохимию»', () => {
  const db = clinic([[100, 42], [101, 41]]);
  const day = dayLabelValue(100);
  bc(db, day);
  assert.deepEqual([lastRow(db).status, lastRow(db).visit_service_id], ['applied', 101], lastRow(db).detail);
  bs(db, day, 'GLU', '5.1');
  bs(db, day, 'CREA', '80');
  assert.deepEqual(blank(db, 100), { 'Глюкоза': '5.1', 'Креатинин': '80' });
  assert.deepEqual(blank(db, 101), { 'Лейкоциты': '7.25' });
  db.close();
});

test('только WBC в сообщении — в ОАК, «СОЭ» не тронута и в лоток не просится (не пришли — её дело)', () => {
  const db = clinic([[100, 40], [101, 41]]);
  bc(db, dayLabelValue(100));
  assert.deepEqual([blank(db, 100), blank(db, 101)], [{}, { 'Лейкоциты': '7.25' }]);
  assert.deepEqual([lastRow(db).status, lastRow(db).visit_service_id], ['applied', 101], lastRow(db).detail);
  db.close();
});

test('анализ добавили ПОСЛЕ печати этикетки, в тот же день: номер прежний, приём заполняет и его', () => {
  const db = clinic([[100, 41]]);
  const day = dayLabelValue(100);
  db.exec(`INSERT INTO visit_services (id, visit_id, service_id, status, created_at) VALUES (105, 20, 44, 'queued', ${NOW})`);
  bc(db, day, [['6690-2^WBC^LN', '7.1'], ['RET', '1.2']]);
  assert.deepEqual([blank(db, 100), blank(db, 105)], [{ 'Лейкоциты': '7.1' }, { 'Ретикулоциты': '1.2' }]);
  db.close();
});

test('кровь и моча на BS-200 (два материала одного прибора): материал пробы (OBR-15) выбирает строку; глюкоза мочи не ложится в сыворотку', () => {
  const db = clinic([[100, 41], [101, 42], [102, 43]]);
  const day = dayLabelValue(100);
  bs(db, day, 'GLU', '5.1', 'serum');
  bs(db, day, 'UPRO', '0.1', 'urine');
  assert.deepEqual(blank(db, 101), { 'Глюкоза': '5.1' });
  assert.deepEqual(blank(db, 102), { 'Белок мочи': '0.1' });
  bs(db, day, 'GLU', '0.3', 'urine');
  assert.deepEqual(blank(db, 101), { 'Глюкоза': '5.1' }, 'глюкоза пробирки мочи не переписала сыворотку');
  assert.notEqual(lastRow(db).status, 'applied');
  db.close();
});

test('два материала одного прибора и общий код (CREA в сыворотке и в моче): материал пробы решает; материала нет — «неоднозначно», ничего не записано', () => {
  const db = clinic([[100, 42], [101, 43]], { urineCrea: true });
  const day = dayLabelValue(100);
  bs(db, day, 'CREA', '80', 'serum');
  bs(db, day, 'CREA', '9000', 'urine');
  assert.deepEqual([blank(db, 100), blank(db, 101)], [{ 'Креатинин': '80' }, { 'Креатинин мочи': '9000' }]);
  db.close();

  const db2 = clinic([[100, 42], [101, 43]], { urineCrea: true });
  bs(db2, dayLabelValue(100), 'CREA', '80', '');
  const m = lastRow(db2);
  assert.equal(m.status, 'unmatched', m.detail);
  assert.match(m.detail, /^неоднозначно/);
  assert.match(m.detail, /моча/);
  assert.equal(resultsOf(db2), 0);
  db2.close();
});

test('возвращённая строка дня значений не получает («по заказу возврат»), оплаченные — получают', () => {
  const db = clinic([[100, 41], [101, 44]]);
  db.exec("INSERT INTO pay_refund_releases (kind, line_id, invoice_id) VALUES ('out', 101, 1)");
  bc(db, dayLabelValue(100), [['6690-2^WBC^LN', '7.1'], ['RET', '1.2']]);
  assert.deepEqual([blank(db, 100), blank(db, 101)], [{ 'Лейкоциты': '7.1' }, {}]);
  assert.match(lastRow(db).detail, /по заказу возврат/);
  db.close();
});

test('строка номера сама возвращена или выдана — номер дня работает: остальные строки дня заполняются', () => {
  const db = clinic([[100, 42, 'completed'], [101, 41]]);
  bc(db, dayLabelValue(100));
  assert.deepEqual([lastRow(db).status, lastRow(db).visit_service_id], ['applied', 101], lastRow(db).detail);
  db.close();
});

test('не оплачено: ворота лаборатории — значение не записано, сказано почему; оплаченные строки дня — записаны', () => {
  const db = clinic([[100, 41, 'added']]);
  bc(db, dayLabelValue(100));
  assert.equal(resultsOf(db), 0);
  assert.match(lastRow(db).detail, /не оплачен/);
  db.close();
  const db2 = clinic([[100, 41], [101, 44, 'added']]);
  bc(db2, dayLabelValue(100), [['6690-2^WBC^LN', '7.1'], ['RET', '1.2']]);
  assert.deepEqual([blank(db2, 100), blank(db2, 101)], [{ 'Лейкоциты': '7.1' }, {}]);
  assert.match(lastRow(db2).detail, /не оплачен/);
  db2.close();
});

test('отдельный забор того же дня: те же анализы в двух открытых строках — «неоднозначно», утренний черновик цел; этикетка строки — точно в свою', () => {
  const db = clinic([[100, 41, 'resulted']]);
  db.exec(`INSERT INTO lab_results (visit_service_id, parameter, value, flag, source) VALUES (100, 'Лейкоциты', '6.0', 'normal', 'analyzer');
           INSERT INTO visit_services (id, visit_id, service_id, status, created_at) VALUES (106, 20, 41, 'queued', ${NOW})`);
  bc(db, dayLabelValue(100), [['6690-2^WBC^LN', '9.9']]);
  assert.match(lastRow(db).detail, /^неоднозначно/);
  assert.deepEqual([blank(db, 100), blank(db, 106)], [{ 'Лейкоциты': '6.0' }, {}]);
  bc(db, '00000106', [['6690-2^WBC^LN', '9.9']]);
  assert.deepEqual(blank(db, 106), { 'Лейкоциты': '9.9' }, '«Печать этикетки» строки — прежнее правило');
  db.close();
});

test('отдельный забор того же дня, другие анализы того же прибора — заполняются по номеру дня', () => {
  const db = clinic([[100, 41, 'resulted']]);
  db.exec(`INSERT INTO lab_results (visit_service_id, parameter, value, flag, source) VALUES (100, 'Лейкоциты', '6.0', 'normal', 'analyzer');
           INSERT INTO visit_services (id, visit_id, service_id, status, created_at) VALUES (107, 20, 44, 'queued', ${NOW})`);
  bc(db, dayLabelValue(100), [['RET', '1.4']]);
  assert.deepEqual([blank(db, 100), blank(db, 107)], [{ 'Лейкоциты': '6.0' }, { 'Ретикулоциты': '1.4' }]);
  db.close();
});

test('день визита: вчерашняя открытая строка того же визита (стационар) номером сегодняшнего дня не заполняется', () => {
  const db = clinic([[100, 41]]);
  db.exec(`UPDATE visits SET visit_date = strftime('%Y-%m-%dT07:00:00Z', 'now', 'localtime', '-1 days') WHERE id = 20;
           UPDATE visit_services SET created_at = strftime('%Y-%m-%dT07:00:00Z', 'now', 'localtime', '-1 days') WHERE id = 100;
           INSERT INTO visit_services (id, visit_id, service_id, status, created_at) VALUES (110, 20, 41, 'queued', ${NOW})`);
  bc(db, dayLabelValue(110));
  assert.deepEqual([blank(db, 100), blank(db, 110)], [{}, { 'Лейкоциты': '7.25' }]);
  db.close();
});

test('день старше 7 дней — отказ, как у голого номера; номера нет в базе — «не найден»', () => {
  const db = clinic([[100, 41]]);
  db.exec(`UPDATE visits SET visit_date = strftime('%Y-%m-%dT07:00:00Z', 'now', 'localtime', '-9 days') WHERE id = 20;
           UPDATE visit_services SET created_at = strftime('%Y-%m-%dT07:00:00Z', 'now', 'localtime', '-9 days') WHERE id = 100;`);
  bc(db, dayLabelValue(100));
  assert.equal(resultsOf(db), 0);
  assert.match(lastRow(db).detail, /старше 7 дней/);
  assert.equal(lastRow(db).visit_service_id, null);
  bc(db, dayLabelValue(555));
  assert.match(lastRow(db).detail, /не найден/);
  db.close();
});

test('этикетка дня, а прибор этого дня визита не кормит ничего — в лоток, сказано почему; прибор неизвестен — отказ', () => {
  const db = clinic([[100, 45], [101, 42]]);
  bc(db, dayLabelValue(100));
  assert.equal(lastRow(db).status, 'unmatched');
  assert.match(lastRow(db).detail, /не кормит/);
  ingestMessage(db, BC780(dayLabelValue(101)), '10.0.0.99', null);
  assert.equal(lastRow(db).status, 'unmatched');
  assert.equal(resultsOf(db), 0);
  db.close();
});

test('прибор ещё не добавлен (находка) — N2, как прежде: ничего не записано', () => {
  const db = clinic([[100, 41]]);
  db.exec('UPDATE lab_devices SET added = 0 WHERE id = 3');
  bc(db, dayLabelValue(100));
  assert.equal(resultsOf(db), 0);
  assert.match(lastRow(db).detail, /ещё не добавлен/);
  db.close();
});

test('прежние этикетки на пробирках: строки (00000101) и LAB- — прежние правила', () => {
  const db = clinic([[100, 42], [101, 41]]);
  bc(db, '00000101');
  assert.deepEqual([lastRow(db).status, lastRow(db).visit_service_id], ['applied', 101]);
  db.close();
});

test('«Привязать» с номером дня — проба ложится в строку дня этого прибора', () => {
  const db = clinic([[100, 42], [101, 41]]);
  ingestMessage(db, BC780('12'), '10.0.0.50', 3);   // номер прибора — в лоток
  const msg = lastRow(db);
  assert.equal(msg.status, 'unmatched');
  const r = lisMessageAttach(db, { id: msg.id, visit_service_id: dayLabelValue(100) }, { id: 1, role: 'admin' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(blank(db, 101), { 'Лейкоциты': '7.25' });
  db.close();
});

test('рабочий список (LIS Proxy) по номеру дня: тесты всех открытых строк дня этого прибора; два материала — «неоднозначно»', () => {
  const db = clinic([[100, 42], [101, 41], [102, 44]]);
  assert.deepEqual(worklistLines(db, { deviceId: 3, orderId: DAY_LABEL_BASE + 100, bare: true, shown: '90000100' }).codes, ['WBC', 'RET']);
  assert.deepEqual(worklistLines(db, { deviceId: 1, orderId: DAY_LABEL_BASE + 100, bare: true, shown: '90000100' }).codes, ['GLU', 'CREA']);
  db.exec(`INSERT INTO visit_services (id, visit_id, service_id, status, created_at) VALUES (103, 20, 43, 'queued', ${NOW})`);
  const w = worklistLines(db, { deviceId: 1, orderId: DAY_LABEL_BASE + 100, bare: true, shown: '90000100' });
  assert.equal(w.ok, false);
  assert.match(w.why, /неоднозначно/);
  db.close();
});

// ═══ Ревью S3, M-2 — ОБЩИЙ КОД В ДВУХ СТРОКАХ ДНЯ ═══════════════════════════════
// 3.22: если хоть один анализ прибора стоял в двух открытых строках дня («ОАК» и
// отдельный «Гемоглобин»; «Биохимия» и отдельная «Глюкоза»), вся проба уходила в
// «Необработанные» — у BC-780 вместе с WBC. Теперь «неоднозначно» — только общие
// коды (их значение не пишется никуда и названы оба заказа), остальное ложится.
// Общий код НЕ отдаётся первой строке: если утренняя пробирка ещё не прогнана,
// значение дневной легло бы в утренний бланк.
function overlapClinic(lines) {
  const db = freshDb();
  db.exec(`${DEVICES};
    INSERT INTO patients (id, full_name) VALUES (7, 'Тестов');
    INSERT INTO visits (id, patient_id, visit_date, status) VALUES (20, 7, ${NOW}, 'scheduled');
    INSERT INTO services (id, name, is_lab, specimen) VALUES
      (41, 'ОАК', 1, 'Кровь'), (49, 'Гемоглобин', 1, 'Кровь'), (42, 'Биохимия', 1, 'Сыворотка'), (48, 'Глюкоза', 1, 'Сыворотка');`);
  for (const [id, sid, status = 'queued'] of lines) {
    db.prepare(`INSERT INTO visit_services (id, visit_id, service_id, status, created_at) VALUES (?, 20, ?, ?, ${NOW})`).run(id, sid, status);
  }
  bindPanel(db, { id: 41, serviceId: 41, deviceId: 3, name: 'ОАК', lines: [['WBC', 'Лейкоциты', 'WBC'], ['HGB', 'Гемоглобин', 'HGB']] });
  bindPanel(db, { id: 49, serviceId: 49, deviceId: 3, name: 'Гемоглобин', lines: [['HGB', 'Гемоглобин', 'HGB']] });
  bindPanel(db, { id: 42, serviceId: 42, deviceId: 1, name: 'Биохимия', lines: [['GLU', 'Глюкоза', 'GLU'], ['CREA', 'Креатинин', 'CREA']] });
  bindPanel(db, { id: 48, serviceId: 48, deviceId: 1, name: 'Глюкоза', lines: [['GLU', 'Глюкоза', 'GLU']] });
  return db;
}
const CBC = [['6690-2^WBC^LN', '7.25'], ['718-7^HGB^LN', '140']];

test('ревью M-2: «ОАК» (WBC, HGB) и отдельный «Гемоглобин» (HGB) в один день — WBC ложится в ОАК, HGB «неоднозначно» и не пишется никуда', () => {
  const db = overlapClinic([[100, 41], [107, 49]]);
  assert.equal(bc(db, dayLabelValue(100), CBC), 'AA');
  const m = lastRow(db);
  assert.equal(m.status, 'unmapped', 'общий код ждёт человека — строка в лотке');
  assert.deepEqual([blank(db, 100), blank(db, 107)], [{ 'Лейкоциты': '7.25' }, {}], 'WBC записан, HGB не отдан ни первой строке, ни второй');
  assert.match(m.detail, /неоднозначно: 718-7\^HGB\^LN — у заказов № 100, № 107/);
  assert.doesNotMatch(m.detail, /не пришли/, 'пришедший, но общий HGB — не «не пришли»');
  assert.equal(statusOf(db, 100), 'resulted');
  assert.equal(statusOf(db, 107), 'queued');

  // «Привязать» к нужному заказу — HGB ложится туда; WBC в ОАК не тронут.
  const r = lisMessageAttach(db, { id: m.id, visit_service_id: 107 }, { id: 1, role: 'admin' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual([blank(db, 100), blank(db, 107)], [{ 'Лейкоциты': '7.25' }, { 'Гемоглобин': '140' }]);
  db.close();
});

test('ревью M-2: «Биохимия» (GLU, CREA) и отдельная «Глюкоза» (GLU), BS-200 по тесту — CREA в «Биохимию», GLU «неоднозначно», ничего не записано', () => {
  const db = overlapClinic([[100, 42], [106, 48]]);
  const day = dayLabelValue(100);
  bs(db, day, 'CREA', '80');
  assert.deepEqual(blank(db, 100), { 'Креатинин': '80' }, 'анализ, который есть только в «Биохимии», ложится');
  bs(db, day, 'GLU', '5.1');
  const m = lastRow(db);
  assert.equal(m.status, 'unmatched', m.detail);
  assert.match(m.detail, /^неоднозначно/);
  assert.match(m.detail, /«Биохимия» \(№ 100\), «Глюкоза» \(№ 106\)/);
  assert.deepEqual([blank(db, 100), blank(db, 106)], [{ 'Креатинин': '80' }, {}]);
  db.close();
});

test('ревью M-2: общий код у ЗАКРЫТОЙ второй строки (выдана) — не «неоднозначно», всё ложится в открытую', () => {
  const db = overlapClinic([[100, 41], [107, 49, 'completed']]);
  bc(db, dayLabelValue(100), CBC);
  assert.deepEqual(blank(db, 100), { 'Лейкоциты': '7.25', 'Гемоглобин': '140' });
  assert.equal(lastRow(db).status, 'applied', lastRow(db).detail);
  db.close();
});
