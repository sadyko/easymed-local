// LAB_TUBE_ANCHOR_V1 (решение владельца 2026-10-20) — проба пробирки идёт в тот
// заказ визита, который кормит приславший её анализатор, а не только в заказ,
// чей номер на этикетке.
//
// Случай владельца (клиника, 2026-10-20): у Рахмонкулова один визит и шесть
// лабораторных услуг; первая — «Время свертываемости крови (Корел)» (№ 52, без
// панели анализатора), последняя — «Общий анализ крови» (панель на BC-20).
// Кнопка «Штрих-код» карточки очереди печатает ОДНУ этикетку на весь визит — с
// номером ПЕРВОЙ услуги (laboratory.js printLabel(rows[0])), и карточка
// показывает «Проба LAB-<номер первой>». BC-20 прислал ОАК с номером 000052:
// приём взял заказ № 52, у его услуги панели нет — проба легла в
// «Необработанные», бланк ОАК остался пустым.
//
// Правило: номер пробы указывает на заказ, панель которого этот прибор не
// кормит, — ищется заказ того же визита, который он кормит (без фильтра
// материала первого заказа: это заказ другого прибора). Один материал — он;
// несколько — тот, чьи подтверждённые коды есть в сообщении; иначе —
// «неоднозначно», ничего не пишется. Дальше — всё как если бы номер указывал на
// найденный заказ. Заказ, который прибор кормит сам, — ровно как прежде.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ingestMessage, worklistLines } from './ingest.js';
import { ORDER_NOT_FOUND, replyText } from './lisproxy.js';
import { freshDb, seedLisProxyClinic, bindPanel, startProxyApp, post, fixture, lastRow, blank } from '../test-helpers/lisproxy-clinic.js';
import { listen } from '../../control-plane/server/test-helpers/listen.js';

const NOW = "strftime('%Y-%m-%dT%H:%M:%SZ','now')";
const seg = (...s) => s.join('\r');
const statusOf = (db, id) => db.prepare('SELECT status FROM visit_services WHERE id = ?').get(id).status;
const anyResults = (db, id) => db.prepare('SELECT COUNT(*) c FROM lab_results WHERE visit_service_id = ?').get(id).c;

// BC-20 — BC-3600 OM, прил. D.7.4 (как sample.test.js): MSH-3/4 пусты, номер — OBR-3.
const BC20 = (sample, wbc = '6.20') => seg(
  'MSH|^~\\&|||||20261020133432||ORU^R01|2|P|2.3.1||||||UNICODE',
  'PID|1||^^^^MR',
  'PV1|1',
  `OBR|1||${sample}|00001^Automated Count^99MRC|||20261020133432|||||||||||||||||HM||||||||Admin`,
  'OBX|1|IS|08001^Take Mode^99MRC||O||||||F',
  `OBX|2|NM|6690-2^WBC^LN||${wbc}|10*9/L||N|||F`,
);
// BC-5300 — пример руководства (как sample.test.js): номер — OBR-3, OBX-3 «LOINC^ИМЯ^LN».
const BC5300 = (sample, wbc = '6.20') => seg(
  'MSH|^~\\&|BC-5300|Mindray|||20261020133432||ORU^R01|1|P|2.3.1||||||UNICODE',
  'PID|1||T0001^^^^MR||Тестов^Анализатор||19900101000000|Мужской',
  'PV1|1|Амбулаторно|Терапия^^12',
  `OBR|1||${sample}|00001^Automated Count^99MRC|||20261020133432|||||||||||||||||HM||||||||Лаборант`,
  'OBX|1|IS|08001^Take Mode^99MRC||O||||||F',
  `OBX|2|NM|6690-2^WBC^LN||${wbc}|10*9/L||N|||F`,
);
const HEMO = { 'mindray-bc-20': BC20, 'mindray-bc-5300': BC5300 };

/**
 * Визит 70 Рахмонкулова — шесть лабораторных услуг по порядку, как у владельца:
 *   52 «Время свертываемости крови (Корел)» — без панели, материал не указан;
 *   53–56 экспресс-тесты (RW, ВИЧ, гепатит C, гепатит B) — у ВИЧ панель на
 *          другом приборе (CL-900i, № 2), у прочих панели нет;
 *   57 «Общий анализ крови» (Кровь) — панель на гематологии № 1, WBC подтверждён.
 * status — статусы заказов по номеру (по умолчанию «ждёт забора»).
 */
function ownerClinic({ profile = 'mindray-bc-20', status = {}, cbcPanel = true } = {}) {
  const db = freshDb();
  const st = (id) => "'" + (status[id] || 'queued') + "'";
  db.exec(`
    INSERT INTO lab_devices (id, name, profile, transport, host, port, enabled, discovered, added, model_confirmed) VALUES
      (1, 'BC-20', '${profile}', 'mllp', '10.0.0.12', NULL, 1, 0, 1, 1),
      (2, 'CL-900i', 'mindray-cl-900i', 'mllp', '10.0.0.43', NULL, 1, 0, 1, 1);
    INSERT INTO patients (id, full_name, date_of_birth, gender) VALUES (7, 'Рахмонкулов', '1980-05-06', 'male');
    INSERT INTO visits (id, patient_id, visit_date, status) VALUES (70, 7, ${NOW}, 'scheduled');
    INSERT INTO services (id, name, is_lab, specimen) VALUES
      (21, 'Время свертываемости крови (Корел)', 1, NULL), (22, 'RW экспресс', 1, 'Кровь'), (23, 'ВИЧ экспресс', 1, 'Кровь'),
      (24, 'Гепатит C экспресс', 1, 'Кровь'), (25, 'Гепатит B экспресс', 1, 'Кровь'), (26, 'Общий анализ крови', 1, 'Кровь');
    INSERT INTO visit_services (id, visit_id, service_id, status, created_at) VALUES
      (52, 70, 21, ${st(52)}, ${NOW}), (53, 70, 22, ${st(53)}, ${NOW}), (54, 70, 23, ${st(54)}, ${NOW}),
      (55, 70, 24, ${st(55)}, ${NOW}), (56, 70, 25, ${st(56)}, ${NOW}), (57, 70, 26, ${st(57)}, ${NOW});
  `);
  bindPanel(db, { id: 23, serviceId: 23, deviceId: 2, name: 'ВИЧ', lines: [['HIV', 'ВИЧ', 'HIV']] });
  if (cbcPanel) bindPanel(db, { id: 26, serviceId: 26, deviceId: 1, name: 'ОАК', lines: [['WBC', 'Лейкоциты', 'WBC']] });
  return db;
}
const NO_PANEL_52 = 'услуга «Время свертываемости крови (Корел)» не привязана ни к одной панели';

// ── 1. Случай владельца, свой порт ─────────────────────────────────────────

test('случай владельца: номер первой услуги (000052, LAB-000052, 00000052) — ОАК визита заполнен, строка лотка при ОАК', () => {
  for (const profile of Object.keys(HEMO)) {
    for (const sample of ['000052', 'LAB-000052', '00000052']) {
      const db = ownerClinic({ profile });
      assert.equal(ingestMessage(db, HEMO[profile](sample), '10.0.0.12', 1), 'AA');
      const m = lastRow(db);
      const label = profile + ' ' + sample + ': ' + m.detail;
      assert.deepEqual([m.status, m.visit_service_id, m.sample_id], ['applied', 57, sample], label);
      assert.deepEqual(blank(db, 57), { 'Лейкоциты': '6.20' }, label);
      assert.equal(statusOf(db, 57), 'resulted', label);
      assert.equal(db.prepare('SELECT source_message_id FROM lab_results WHERE visit_service_id = 57').get().source_message_id, m.id, label);
      for (const id of [52, 53, 54, 55, 56]) {
        assert.equal(anyResults(db, id), 0, label + ': заказ № ' + id + ' не тронут');
        assert.equal(statusOf(db, id), 'queued', label + ': заказ № ' + id);
      }
      db.close();
    }
  }
});

test('случай владельца: «Привязать» с номером карточки «Проба» (52) — тоже в ОАК', () => {
  const db = ownerClinic({ cbcPanel: false });
  ingestMessage(db, BC20('000052'), '10.0.0.12', 1);
  const first = lastRow(db);
  assert.deepEqual([first.status, first.detail], ['unmapped', NO_PANEL_52], 'панели ОАК ещё нет — прежний отказ');
  bindPanel(db, { id: 26, serviceId: 26, deviceId: 1, name: 'ОАК', lines: [['WBC', 'Лейкоциты', 'WBC']] });
  ingestMessage(db, first.raw, first.peer, 1, { touch: false, sampleIdOverride: 52 });
  const m = lastRow(db);
  assert.deepEqual([m.status, m.visit_service_id, m.sample_id], ['applied', 57, '52'], m.detail);
  assert.ok(m.detail.endsWith('привязано вручную'), m.detail);
  assert.deepEqual(blank(db, 57), { 'Лейкоциты': '6.20' });
  db.close();
});

test('рабочий список (worklistLines) по номеру первой услуги — коды и материал ОАК', () => {
  const db = ownerClinic();
  assert.deepEqual(worklistLines(db, { deviceId: 1, orderId: 52 }), {
    ok: true, codes: ['WBC'], patient: { date_of_birth: '1980-05-06', gender: 'male' }, specimen: 'Кровь' });
  assert.deepEqual(worklistLines(db, { deviceId: 1, orderId: 52, bare: true, shown: '00000052' }).codes, ['WBC']);
  db.close();
});

// Правило голых цифр (открыт, не старше 7 дней) судит заказ, в который ляжет
// результат: при пробирке визита — найденный заказ, иначе — заказ номера.
const aMonthAgo = "datetime('now', '-30 days')";
const BARE_57 = (why) => new RegExp('^номер пробы «(000052|00000052)» без префикса LAB- указывает на заказ № 57, который ' + why);

test('номер голыми цифрами: «Время свертываемости» выдана, ОАК открыт — 000052 и 00000052 в ОАК', () => {
  for (const sample of ['000052', '00000052']) {
    const db = ownerClinic({ status: { 52: 'completed' } });
    ingestMessage(db, BC20(sample), '10.0.0.12', 1);
    const m = lastRow(db);
    assert.deepEqual([m.status, m.visit_service_id, m.sample_id], ['applied', 57, sample], m.detail);
    assert.deepEqual(blank(db, 57), { 'Лейкоциты': '6.20' });
    assert.deepEqual(worklistLines(db, { deviceId: 1, orderId: 52, bare: true, shown: sample }).codes, ['WBC'], sample);
    db.close();
  }
});

test('номер голыми цифрами: сам ОАК выдан или старше 7 дней — отказ правила голых цифр, ничего не записано; LAB- — как прежде', () => {
  const closed = ownerClinic({ status: { 57: 'completed' } });
  closed.prepare("INSERT INTO lab_results (visit_service_id, parameter, value, verified_at) VALUES (57, 'Лейкоциты', '5.0', " + NOW + ')').run();
  // Стационарный визит: ОАК назначен месяц назад, «Время свертываемости» — сегодня.
  const old = ownerClinic();
  old.prepare(`UPDATE visits SET visit_date = ${aMonthAgo} WHERE id = 70`).run();
  old.prepare(`UPDATE visit_services SET created_at = ${aMonthAgo} WHERE id <> 52`).run();
  for (const [db, why, label] of [[closed, 'закрыт \\(статус «выдан»\\)', 'выдан'], [old, 'датирован .* старше 7 дней', 'старше 7 дней']]) {
    for (const sample of ['000052', '00000052']) {
      ingestMessage(db, BC20(sample, '7.70'), '10.0.0.12', 1);
      const m = lastRow(db);
      assert.deepEqual([m.status, m.visit_service_id], ['unmatched', null], label + ' ' + sample + ': ' + m.detail);
      assert.match(m.detail, BARE_57(why), label);
      assert.notEqual(blank(db, 57)['Лейкоциты'], '7.70', label);
      assert.match(worklistLines(db, { deviceId: 1, orderId: 52, bare: true, shown: sample }).why, BARE_57(why), label);
    }
  }
  ingestMessage(closed, BC20('LAB-000052', '7.70'), '10.0.0.12', 1);
  assert.deepEqual([lastRow(closed).status, lastRow(closed).visit_service_id, blank(closed, 57)], ['superseded', 57, { 'Лейкоциты': '5.0' }], 'D7 — как прежде');
  ingestMessage(old, BC20('LAB-000052', '7.70'), '10.0.0.12', 1);
  assert.deepEqual([lastRow(old).status, lastRow(old).visit_service_id, blank(old, 57)], ['applied', 57, { 'Лейкоциты': '7.70' }], 'этикетке LAB- возраст не судья');
  closed.close();
  old.close();
});

// ── 2. Кормить нечего — прежний отказ ─────────────────────────────────────

test('ни один заказ визита этот прибор не кормит — прежний отказ, те же слова и статус', () => {
  for (const setup of [
    (db) => {},                                                                          // у ОАК нет панели
    (db) => bindPanel(db, { id: 26, serviceId: 26, deviceId: 2, name: 'ОАК', lines: [['WBC', 'Лейкоциты', 'WBC']] }),   // ОАК — на другом приборе
    (db) => bindPanel(db, { id: 26, serviceId: 26, deviceId: 1, name: 'ОАК', lines: [['WBC', 'Лейкоциты', 'WBC', 0]] }), // код не подтверждён
  ]) {
    const db = ownerClinic({ cbcPanel: false });
    setup(db);
    ingestMessage(db, BC20('LAB-000052'), '10.0.0.12', 1);
    assert.deepEqual([lastRow(db).status, lastRow(db).visit_service_id, lastRow(db).detail], ['unmapped', 52, NO_PANEL_52]);
    ingestMessage(db, BC20('000052'), '10.0.0.12', 1);
    assert.deepEqual([lastRow(db).status, lastRow(db).visit_service_id, lastRow(db).detail], ['unmapped', null, NO_PANEL_52]);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM lab_results').get().c, 0);
    assert.deepEqual(worklistLines(db, { deviceId: 1, orderId: 52 }), { ok: false, why: NO_PANEL_52 });
    db.close();
  }
});

test('прибор сообщения неизвестен — другой заказ не ищется (прежний отказ)', () => {
  const db = ownerClinic();
  ingestMessage(db, BC20('LAB-000052'), '10.0.0.12', null);
  assert.deepEqual([lastRow(db).status, lastRow(db).visit_service_id, lastRow(db).detail], ['unmapped', 52, NO_PANEL_52]);
  assert.equal(anyResults(db, 57), 0);
  db.close();
});

// ── 3. Один BS-200 кормит заказы двух материалов ──────────────────────────

const BS2 = (sample, code, value, id = 1) => [
  `MSH|^~\\&|Mindray|BS-200|||20261020124717||ORU^R01|${id}|P|2.3.1||||0||ASCII|||`,
  'PID|1|900001|||Тестов Анализатор||19900101000000|M|||||||||||||||||||||||',
  `OBR|1|${sample}|7|Mindray^BS-200|N||20261020124717||||||||serum|||||||||||||||||||||||||||||||||`,
  `OBX|1|NM|${code}|${code}|${value}|mmol/L|-|N|||F|||20261020124717|||`].join('\r');

/**
 * Визит 70, BS-200 своего порта (№ 1): 52 «Время свертываемости крови (Корел)»
 * (без панели); 60 «Биохимия» (Сыворотка: GLU, CREA); 61 «Общий анализ мочи»
 * (Моча: UPRO, CREA — креатинин мочи тем же номером теста).
 */
function twoMaterialClinic() {
  const db = freshDb();
  db.exec(`
    INSERT INTO lab_devices (id, name, profile, transport, host, port, enabled, discovered, added, model_confirmed)
      VALUES (1, 'BS-200', 'mindray-bs-200', 'mllp', '10.0.0.40', NULL, 1, 0, 1, 1);
    INSERT INTO patients (id, full_name) VALUES (7, 'Рахмонкулов');
    INSERT INTO visits (id, patient_id, visit_date, status) VALUES (70, 7, ${NOW}, 'scheduled');
    INSERT INTO services (id, name, is_lab, specimen) VALUES
      (21, 'Время свертываемости крови (Корел)', 1, NULL), (9, 'Биохимия', 1, 'Сыворотка'), (13, 'Общий анализ мочи', 1, 'Моча');
    INSERT INTO visit_services (id, visit_id, service_id, status, created_at) VALUES
      (52, 70, 21, 'queued', ${NOW}), (60, 70, 9, 'queued', ${NOW}), (61, 70, 13, 'queued', ${NOW});
  `);
  bindPanel(db, { id: 9, serviceId: 9, deviceId: 1, name: 'Биохимия', lines: [['GLU', 'Глюкоза', 'GLU'], ['CREA', 'Креатинин', 'CREA']] });
  bindPanel(db, { id: 13, serviceId: 13, deviceId: 1, name: 'Моча', lines: [['UPRO', 'Белок мочи', 'UPRO'], ['UCREA', 'Креатинин мочи', 'CREA']] });
  return db;
}
const bs = (db, sample, code, value) => ingestMessage(db, BS2(sample, code, value), '10.0.0.40', 1);
const AMBIGUOUS = [/^неоднозначно: /, /сыворотка: «Биохимия» \(№ 60\)/, /моча: «Общий анализ мочи» \(№ 61\)/, /«Печать этикетки»/, /«Привязать»/];

test('BS-200, два материала: GLU — только «Биохимия», UPRO — только «ОАМ»; код обоих (CREA) и чужой код — «неоднозначно», ничего не записано', () => {
  const db = twoMaterialClinic();
  bs(db, 'LAB-000052', 'GLU', '5.1');
  assert.equal(lastRow(db).visit_service_id, 60, lastRow(db).detail);
  assert.deepEqual([blank(db, 60), blank(db, 61)], [{ 'Глюкоза': '5.1' }, {}]);

  bs(db, '000052', 'UPRO', '0.1');
  assert.equal(lastRow(db).visit_service_id, 61, lastRow(db).detail);
  assert.deepEqual([blank(db, 60), blank(db, 61)], [{ 'Глюкоза': '5.1' }, { 'Белок мочи': '0.1' }]);

  for (const [sample, link] of [['LAB-000052', 52], ['000052', null]]) {
    for (const code of ['CREA', 'XYZ']) {
      bs(db, sample, code, '80');
      const m = lastRow(db);
      assert.deepEqual([m.status, m.visit_service_id, m.sample_id], ['unmatched', link, sample], sample + ' ' + code + ': ' + m.detail);
      for (const re of AMBIGUOUS) assert.match(m.detail, re);
      assert.deepEqual([blank(db, 60), blank(db, 61), blank(db, 52)], [{ 'Глюкоза': '5.1' }, { 'Белок мочи': '0.1' }, {}], sample + ' ' + code);
    }
  }
  assert.deepEqual([statusOf(db, 52), statusOf(db, 60), statusOf(db, 61)], ['queued', 'resulted', 'resulted']);
  db.close();
});

test('BS-200, два материала: рабочий список по номеру первой услуги — «неоднозначно» (сообщения нет — материал не выбрать)', () => {
  const db = twoMaterialClinic();
  for (const opts of [{}, { bare: true, shown: '00000052' }]) {
    const w = worklistLines(db, { deviceId: 1, orderId: 52, ...opts });
    assert.equal(w.ok, false);
    for (const re of AMBIGUOUS) assert.match(w.why, re);
  }
  db.prepare('UPDATE lab_panels SET device_id = NULL WHERE id = 13').run();
  assert.deepEqual(worklistLines(db, { deviceId: 1, orderId: 52 }).codes, ['GLU', 'CREA'], 'один материал — его коды');
  assert.equal(worklistLines(db, { deviceId: 1, orderId: 52 }).specimen, 'Сыворотка');
  db.close();
});

test('номер голыми цифрами: пробирки визита нет или «неоднозначно» — правило у заказа номера, первым, как прежде', () => {
  const none = ownerClinic({ status: { 52: 'completed' }, cbcPanel: false });
  ingestMessage(none, BC20('000052'), '10.0.0.12', 1);
  assert.deepEqual([lastRow(none).status, lastRow(none).visit_service_id], ['unmatched', null]);
  assert.match(lastRow(none).detail, /^номер пробы «000052» без префикса LAB- указывает на заказ № 52, который закрыт/);
  assert.match(worklistLines(none, { deviceId: 1, orderId: 52, bare: true, shown: '00000052' }).why, /указывает на заказ № 52, который закрыт/);
  none.close();

  const two = twoMaterialClinic();
  two.prepare("UPDATE visit_services SET status = 'completed' WHERE id = 52").run();
  bs(two, '000052', 'CREA', '80');
  assert.deepEqual([lastRow(two).status, lastRow(two).visit_service_id], ['unmatched', null]);
  assert.match(lastRow(two).detail, /^номер пробы «000052» без префикса LAB- указывает на заказ № 52, который закрыт/, 'не «неоднозначно»');
  assert.match(worklistLines(two, { deviceId: 1, orderId: 52, bare: true, shown: '00000052' }).why, /указывает на заказ № 52, который закрыт/);
  bs(two, '000052', 'GLU', '5.1');
  assert.deepEqual([lastRow(two).visit_service_id, blank(two, 60)], [60, { 'Глюкоза': '5.1' }], 'один материал по коду — найденный заказ открыт');
  two.close();
});

// ── 4. Оплата и выбор заказа ──────────────────────────────────────────────

test('оплата: первая услуга не оплачена, ОАК оплачен — ОАК заполнен; ОАК не оплачен — прежний текст, ничего не записано', () => {
  const a = ownerClinic({ status: { 52: 'added' } });
  for (const sample of ['LAB-000052', '000052']) {
    ingestMessage(a, BC20(sample), '10.0.0.12', 1);
    assert.deepEqual([lastRow(a).visit_service_id, blank(a, 57)], [57, { 'Лейкоциты': '6.20' }], sample + ': ' + lastRow(a).detail);
  }
  assert.equal(statusOf(a, 52), 'added');
  a.close();

  const UNPAID = 'заказ ещё не оплачен — результат прибора можно «Привязать» после оплаты';
  for (const status of [{ 57: 'added' }, { 52: 'added', 57: 'added' }]) {
    const b = ownerClinic({ status });
    ingestMessage(b, BC20('LAB-000052'), '10.0.0.12', 1);
    assert.deepEqual([lastRow(b).status, lastRow(b).visit_service_id, lastRow(b).detail], ['unmatched', 57, UNPAID], JSON.stringify(status));
    ingestMessage(b, BC20('000052'), '10.0.0.12', 1);
    assert.deepEqual([lastRow(b).status, lastRow(b).visit_service_id, lastRow(b).detail], ['unmatched', null, UNPAID], JSON.stringify(status));
    assert.equal(b.prepare('SELECT COUNT(*) c FROM lab_results').get().c, 0);
    assert.equal(statusOf(b, 57), 'added');
    assert.deepEqual(worklistLines(b, { deviceId: 1, orderId: 52 }), { ok: false, why: UNPAID });
    b.close();
  }
});

test('выбор заказа одного материала: открытый оплаченный раньше неоплаченного и выданного, при равных — меньший номер', () => {
  const second = (db, status) => {
    db.exec(`INSERT INTO services (id, name, is_lab, specimen) VALUES (27, 'Общий анализ крови (стационар)', 1, 'Кровь');
             INSERT INTO visit_services (id, visit_id, service_id, status, created_at) VALUES (58, 70, 27, '${status}', ${NOW});`);
    bindPanel(db, { id: 27, serviceId: 27, deviceId: 1, name: 'ОАК стационар', lines: [['WBC', 'Лейкоциты', 'WBC']] });
  };
  const cases = [
    [{ 57: 'added' }, 'queued', 58],
    [{ 57: 'completed' }, 'queued', 58],
    [{}, 'queued', 57],
    [{}, 'added', 57],
  ];
  for (const [status, s58, want] of cases) {
    const db = ownerClinic({ status });
    second(db, s58);
    if (status[57] === 'completed') db.prepare("INSERT INTO lab_results (visit_service_id, parameter, value, verified_at) VALUES (57, 'Лейкоциты', '5.0', " + NOW + ')').run();
    ingestMessage(db, BC20('LAB-000052', '7.10'), '10.0.0.12', 1);
    const label = JSON.stringify(status) + ' 58:' + s58 + ' — ' + lastRow(db).detail;
    assert.deepEqual([lastRow(db).status, lastRow(db).visit_service_id], ['applied', want], label);
    assert.equal(blank(db, want)['Лейкоциты'], '7.10', label);
    const other = want === 57 ? 58 : 57;
    assert.notEqual(blank(db, other)['Лейкоциты'], '7.10', label);
    db.close();
  }
});

// ── 6. Заказ номера кормит сам прибор — как прежде ────────────────────────

test('заказ номера кормит этот прибор — другой заказ не ищется (R4: ровно как прежде)', () => {
  const db = ownerClinic();
  bindPanel(db, { id: 21, serviceId: 21, deviceId: 1, name: 'Свертываемость', lines: [['WBC', 'Лейкоциты (первая услуга)', 'WBC']] });
  ingestMessage(db, BC20('LAB-000052'), '10.0.0.12', 1);
  assert.deepEqual([lastRow(db).status, lastRow(db).visit_service_id], ['applied', 52], lastRow(db).detail);
  assert.deepEqual([blank(db, 52), blank(db, 57)], [{ 'Лейкоциты (первая услуга)': '6.20' }, {}], 'код заказа пробирки — его (D3)');
  db.close();
});

// ── 5. LIS Proxy ──────────────────────────────────────────────────────────

const R = (bc, code, res) => 'method=apiResultSave&lisResult[name]=bs200&lisResult[host]=LAB-PC-1&lisResult[barcode]=' + bc
  + '&lisResult[code]=' + code + '&lisResult[R][res]=' + res + '&lisResult[R][unit]=&lisResult[R][norms]=&lisResult[R][flag]=';
const ask = (bc) => 'method=apiOrderGet&order[name]=bs200&order[host]=LAB-PC-1&order[barcode]=' + bc;
const NOTHING = replyText(ORDER_NOT_FOUND);

/**
 * Клиника стенда LIS Proxy (seedLisProxyClinic) и первая услуга без панели
 * «Время свертываемости крови (Корел)»: № 120 в визите 55 (рядом с № 123
 * «Биохимия» на bs200) и № 550 в визите 58 (рядом с № 555 ОАК на bc780x).
 */
async function proxyClinic(fn, extra = () => {}) {
  const db = freshDb();
  seedLisProxyClinic(db);
  db.exec(`INSERT INTO services (id, name, is_lab, specimen) VALUES (20, 'Время свертываемости крови (Корел)', 1, NULL);
           INSERT INTO visit_services (id, visit_id, service_id, status, created_at) VALUES (120, 55, 20, 'queued', ${NOW}), (550, 58, 20, 'queued', ${NOW});`);
  extra(db);
  const app = await startProxyApp(db, { listen });
  try { await fn(db, app); } finally { await app.close(); db.close(); }
}

test('LIS Proxy: номер первой услуги — рабочий список и результат заказа, который кормит прибор', async () => {
  await proxyClinic(async (db, app) => {
    for (const bc of ['LAB-000120', '00000120']) {
      const reply = await (await post(app.url, ask(bc))).json();
      assert.deepEqual(reply, { 0: { clientId: bc, surname: '', name: '', date_birth: '03.02.1990', sex: '1', biomaterial_code: 'serum', code: 'GLU' } }, bc);
    }
    assert.equal(await (await post(app.url, R('LAB-000120', 'GLU', '5.1'))).text(), 'Ok');
    const m = lastRow(db);
    assert.deepEqual([m.status, m.visit_service_id, m.sample_id], ['applied', 123, 'LAB-000120'], m.detail);
    assert.deepEqual(blank(db, 123), { 'Глюкоза': '5.1' });
    assert.deepEqual(blank(db, 120), {});
    await post(app.url, fixture('results', 'bc780_wbc').replace('LAB-000555', '00000550'));
    assert.deepEqual([lastRow(db).visit_service_id, lastRow(db).sample_id], [555, '00000550'], lastRow(db).detail);
    assert.deepEqual(blank(db, 555), { 'Лейкоциты': '4.63' });
  });
});

test('LIS Proxy: два материала на bs200 — рабочий список «ничего» с причиной в журнале; результат — в заказ своего кода', async () => {
  await proxyClinic(async (db, app) => {
    const res = await post(app.url, ask('LAB-000120'));
    assert.equal(await res.text(), NOTHING);
    const q = lastRow(db);
    assert.equal(q.reply_body, NOTHING);
    assert.match(q.detail, /^LIS Proxy: рабочий список по пробирке LAB-000120 — ничего не отдано: неоднозначно: /);
    assert.match(q.detail, /сыворотка: «Биохимия» \(№ 123\)/);
    assert.match(q.detail, /моча: «Общий анализ мочи» \(№ 140\)/);
    await post(app.url, R('LAB-000120', 'UPRO', '0.1'));
    assert.deepEqual([lastRow(db).visit_service_id, blank(db, 140), blank(db, 123)], [140, { 'Белок мочи': '0.1' }, {}], lastRow(db).detail);
    await post(app.url, R('LAB-000120', 'GLU', '5.1'));
    assert.deepEqual([lastRow(db).visit_service_id, blank(db, 123)], [123, { 'Глюкоза': '5.1' }], lastRow(db).detail);
  }, (db) => {
    db.prepare(`INSERT INTO visit_services (id, visit_id, service_id, status, created_at) VALUES (140, 55, 13, 'queued', ${NOW})`).run();
    bindPanel(db, { id: 13, serviceId: 13, deviceId: 1, name: 'Моча', lines: [['UPRO', 'Белок мочи', 'UPRO']] });
  });
});
