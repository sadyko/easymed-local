// LAB_SCAN_BIND_V1 (решение владельца 2026-11-07, к ревью S3) — ПРИВЯЗКА СКАНЕРОМ.
//
// BC-780 не прочитал штрихкод пробирки (снимок владельца: четыре пробирки прочитаны
// «0000xxxx», штатив 2, места 1–2 — «Inv.114220_2-1», «Inv.114245_2-2») и прислал
// пробу со своим номером «Inv.<номер прогона>_<штатив>-<место>». Она ложится в
// «Необработанные». Теперь «Привязать» принимает ЭТИКЕТКУ, отсканированную сканером
// компьютера (или 8 цифр под штрихкодом), и проба ложится ровно так, как если бы
// анализатор прислал этот номер сам: строки дня визита, которые он кормит, ворота
// оплаты и закрытия, срок 7 дней, «повтор». Номер заказа без нулей («123») —
// прежняя ручная привязка.
// И «Inv.» сам по себе не совпадает ни с чем: цифры из него не вынимаются.
process.env.TZ = 'Asia/Tashkent';
const { default: test } = await import('node:test');
const { default: assert } = await import('node:assert/strict');
const { ingestMessage, parseSampleId } = await import('./ingest.js');
const { lisMessageAttach } = await import('../services/rpc/lis.js');
const { freshDb, bindPanel, lastRow, blank } = await import('../test-helpers/lisproxy-clinic.js');
const { dayLabelValue, dayLabelLine } = await import('../../public/js/shared/lab-day-label.js');
const { normaliseProxyBarcode } = await import('./lisproxy-form.js');

const NOW = "strftime('%Y-%m-%dT%H:%M:%SZ','now')";
const ADMIN = { id: 1, role: 'admin' };
const seg = (...s) => s.join('\r');
const BC780 = (sample, obx = [['6690-2^WBC^LN', '7.25']]) => seg(
  'MSH|^~\\&|BC-780|Mindray|||20261107090000||ORU^R01|1|P|2.3.1||||||UNICODE',
  'PID|1||^^^^MR', 'PV1|1',
  `OBR|1||${sample}|00001^Automated Count^99MRC|||20261107090000`,
  ...obx.map(([c, v], i) => `OBX|${i + 1}|NM|${c}||${v}|10*9/L|4.0-10.0|N|||F`));
const results = (db) => db.prepare('SELECT COUNT(*) c FROM lab_results').get().c;
const row = (db, id) => db.prepare('SELECT * FROM lab_device_messages WHERE id = ?').get(id);

/** Визит 20 сегодня: № 100 «Время свертываемости» (без панели), № 101 «ОАК» (BC-780) — второй в списке. */
function clinic({ cbcStatus = 'queued', id = 101 } = {}) {
  const db = freshDb();
  db.exec(`INSERT INTO lab_devices (id, name, profile, transport, host, port, enabled, discovered, added, model_confirmed)
             VALUES (3, 'BC-780', 'mindray-bc-780', 'mllp', '10.0.0.50', NULL, 1, 0, 1, 1);
    INSERT INTO patients (id, full_name) VALUES (7, 'Тестов');
    INSERT INTO visits (id, patient_id, visit_date, status) VALUES (20, 7, ${NOW}, 'scheduled');
    INSERT INTO services (id, name, is_lab, specimen) VALUES (45, 'Время свертываемости', 1, NULL), (41, 'ОАК', 1, 'Кровь');
    INSERT INTO visit_services (id, visit_id, service_id, status, created_at) VALUES (100, 20, 45, 'queued', ${NOW}), (${id}, 20, 41, '${cbcStatus}', ${NOW});`);
  bindPanel(db, { id: 41, serviceId: 41, deviceId: 3, name: 'ОАК', lines: [['WBC', 'Лейкоциты', 'WBC'], ['HGB', 'Гемоглобин', 'HGB']] });
  return db;
}
const CBC = [['6690-2^WBC^LN', '7.25'], ['718-7^HGB^LN', '140']];
/** Проба без прочитанного штрихкода — в лоток; её строка лотка. */
function noRead(db, sample = 'Inv.114220_2-1', obx = CBC) {
  ingestMessage(db, BC780(sample, obx), '10.0.0.50', 3);
  return lastRow(db);
}

test('«Inv.» не совпадает ни с чем: заказ № 114220 есть и открыт — проба всё равно в лотке, цифры из «Inv.» не вынимаются', () => {
  const db = clinic({ id: 114220 });
  const m = noRead(db);
  assert.equal(m.status, 'unmatched');
  assert.equal(m.sample_id, 'Inv.114220_2-1');
  assert.equal(m.visit_service_id, null, 'проба не привязана к заказу 114220');
  assert.equal(results(db), 0);
  assert.match(m.detail, /не прочитал штрихкод/);
  assert.match(m.detail, /штатив 2, место 1/);
  for (const s of ['Inv.114220_2-1', 'Inv.114245_2-2', 'inv.90000100_1-1']) {
    assert.equal(parseSampleId(s), null, s);
    assert.equal(dayLabelLine(s), null, s);
    assert.equal(normaliseProxyBarcode(s).ok, false, s);
  }
  db.close();
});

test('скан этикетки дня визита (90000100) — ОАК (второй в списке) заполнен, как будто номер прислал анализатор; строка «Inv.» разобрана', () => {
  const db = clinic();
  const m = noRead(db);
  const r = lisMessageAttach(db, { id: m.id, label: dayLabelValue(100) }, ADMIN);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.status, 'applied', r.detail);
  assert.deepEqual(blank(db, 101), { 'Лейкоциты': '7.25', 'Гемоглобин': '140' });
  const rec = lastRow(db);
  assert.equal(rec.sample_id, '90000100', 'в журнале — номер этикетки');
  assert.match(rec.detail, /привязано по этикетке/);
  assert.match(rec.detail, /Inv\.114220_2-1/, 'что прислал прибор — в журнале');
  assert.doesNotMatch(rec.detail, /привязано вручную/);
  assert.ok(row(db, m.id).resolved_at, 'строка «Inv.» ушла из лотка');
  db.close();
});

test('скан этикетки строки (00000101) — тот же приём, что у прибора', () => {
  const db = clinic();
  const m = noRead(db, 'Inv.114245_2-2');
  const r = lisMessageAttach(db, { id: m.id, label: '00000101' }, ADMIN);
  assert.equal(r.status, 'applied', r.detail);
  assert.deepEqual(blank(db, 101), { 'Лейкоциты': '7.25', 'Гемоглобин': '140' });
  db.close();
});

test('ворота как у прибора: не оплачено — не записано, сказано почему; новая строка лотка с номером этикетки', () => {
  const db = clinic({ cbcStatus: 'added' });
  const m = noRead(db);
  const r = lisMessageAttach(db, { id: m.id, label: '00000101' }, ADMIN);
  assert.equal(r.status, 'unmatched');
  assert.match(r.detail, /не оплачен/);
  assert.equal(results(db), 0);
  assert.equal(lastRow(db).sample_id, '00000101');
  assert.equal(lastRow(db).resolved_at, null, 'отказ — снова в лотке, уже с номером этикетки');
  db.close();
});

test('срок 7 дней как у прибора: этикетка старого заказа — отказ; номер заказа без нулей — прежняя ручная привязка', () => {
  const db = clinic();
  db.exec(`UPDATE visits SET visit_date = strftime('%Y-%m-%dT07:00:00Z', 'now', 'localtime', '-9 days') WHERE id = 20;
           UPDATE visit_services SET created_at = strftime('%Y-%m-%dT07:00:00Z', 'now', 'localtime', '-9 days')`);
  const m = noRead(db);
  const r = lisMessageAttach(db, { id: m.id, label: '00000101' }, ADMIN);
  assert.equal(r.status, 'unmatched');
  assert.match(r.detail, /старше 7 дней/);
  assert.equal(results(db), 0);
  const again = lastRow(db);
  const manual = lisMessageAttach(db, { id: again.id, visit_service_id: 101 }, ADMIN);
  assert.equal(manual.status, 'applied', manual.detail);
  assert.deepEqual(blank(db, 101), { 'Лейкоциты': '7.25', 'Гемоглобин': '140' });
  db.close();
});

test('«повтор» как у прибора: в черновике уже WBC 7.25, проба «Inv.» с 9.9 по этикетке — не переписывает, «повтор»; номер заказа — принимает новые', () => {
  const db = clinic();
  ingestMessage(db, BC780('00000101', CBC), '10.0.0.50', 3);
  assert.deepEqual(blank(db, 101), { 'Лейкоциты': '7.25', 'Гемоглобин': '140' });
  const m = noRead(db, 'Inv.114246_2-3', [['6690-2^WBC^LN', '9.9'], ['718-7^HGB^LN', '140']]);
  const r = lisMessageAttach(db, { id: m.id, label: '00000101' }, ADMIN);
  assert.match(r.detail, /повтор: значения отличаются/);
  assert.deepEqual(blank(db, 101), { 'Лейкоциты': '7.25', 'Гемоглобин': '140' }, 'черновик не переписан');
  const held = lastRow(db);
  const manual = lisMessageAttach(db, { id: held.id, visit_service_id: 101 }, ADMIN);
  assert.equal(manual.ok, true);
  assert.equal(blank(db, 101)['Лейкоциты'], '9.9', 'номер заказа — прежняя ручная привязка: новые значения приняты');
  db.close();
});

test('не этикетка — отказ сразу, строка лотка не тронута', () => {
  const db = clinic();
  const m = noRead(db);
  for (const label of ['123', 'Inv.114220_2-1', '', '0000010', '000001011', 'ABC-000101', 7]) {
    assert.throws(() => lisMessageAttach(db, { id: m.id, label }, ADMIN), (e) => e.status === 400 && /Отсканируйте этикетку/.test(e.message), String(label));
  }
  assert.equal(row(db, m.id).resolved_at, null);
  assert.equal(results(db), 0);
  // Прежняя этикетка LAB-, отсканированная на любой раскладке, — тоже этикетка.
  const r = lisMessageAttach(db, { id: m.id, label: 'ДФИ-000101' }, ADMIN);
  assert.equal(r.status, 'applied', r.detail);
  db.close();
});
