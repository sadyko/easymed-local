// LAB_ROUND_V1 (решение владельца 2026-11-07, п. 6) — результаты анализаторов до
// 2 знаков (половиной вверх), полное значение — в raw_value; настройка клиники
// doc_settings.lab_round_analyzer (мигр. 279), по умолчанию включена.
process.env.TZ = 'Asia/Tashkent';
const { default: test } = await import('node:test');
const { default: assert } = await import('node:assert/strict');
const { ingestMessage } = await import('./ingest.js');
const { saveLabResults } = await import('../services/rpc/lab.js');
const { freshDb, bindPanel, lastRow } = await import('../test-helpers/lisproxy-clinic.js');
const { roundHalfUp2, labShownValue, labRoundOn } = await import('../../public/js/shared/lab-round.js');

const NOW = "strftime('%Y-%m-%dT%H:%M:%SZ','now')";
const seg = (...s) => s.join('\r');
let n = 0;
const BC780 = (sample, obx) => seg(
  `MSH|^~\\&|BC-780|Mindray|||20261107090000||ORU^R01|${++n}|P|2.3.1||||||UNICODE`,
  'PID|1||^^^^MR', 'PV1|1',
  `OBR|1||${sample}|00001^Automated Count^99MRC|||20261107090000`,
  ...obx.map(([c, v, t = 'NM'], i) => `OBX|${i + 1}|${t}|${c}||${v}|10*9/L|-|N|||F`));

function clinic() {
  const db = freshDb();
  db.exec(`INSERT INTO lab_devices (id, name, profile, transport, host, port, enabled, discovered, added, model_confirmed)
             VALUES (3, 'BC-780', 'mindray-bc-780', 'mllp', '10.0.0.50', NULL, 1, 0, 1, 1);
           INSERT INTO patients (id, full_name) VALUES (7, 'Тестов');
           INSERT INTO visits (id, patient_id, visit_date, status) VALUES (20, 7, ${NOW}, 'scheduled');
           INSERT INTO services (id, name, is_lab, specimen) VALUES (41, 'ОАК', 1, 'Кровь');
           INSERT INTO visit_services (id, visit_id, service_id, status, created_at) VALUES (100, 20, 41, 'queued', ${NOW});`);
  bindPanel(db, { id: 41, serviceId: 41, deviceId: 3, name: 'ОАК',
    lines: [['WBC', 'Лейкоциты', 'WBC'], ['RBC', 'Эритроциты', 'RBC'], ['PLT', 'Тромбоциты', 'PLT'], ['HGB', 'Гемоглобин', 'HGB']] });
  db.exec("UPDATE lab_panel_analytes SET ref_low = 4.0, ref_high = 4.15 WHERE name = 'Лейкоциты'");
  return db;
}
const rowsOf = (db) => Object.fromEntries(db.prepare('SELECT parameter, value, raw_value, numeric_value, flag FROM lab_results WHERE visit_service_id = 100 ORDER BY id')
  .all().map((r) => [r.parameter, { value: r.value, raw: r.raw_value, num: r.numeric_value, flag: r.flag }]));

test('roundHalfUp2: до 2 знаков половиной вверх (строкой, без float); текст и ≤ 2 знаков — как есть', () => {
  for (const [v, want] of [
    ['4.152122', '4.15'], ['4.156', '4.16'], ['4.155', '4.16'], ['1.005', '1.01'], ['0.995', '1.00'], ['9.999', '10.00'],
    ['4.10001', '4.10'], ['-4.155', '-4.16'], ['-0.001', '0.00'], ['123.4567', '123.46'], ['007.123', '7.12'],
  ]) assert.equal(roundHalfUp2(v), want, v);
  for (const v of ['4.1', '390.10', '12', '>1000', 'положительно', '', '1,234', '1e-5', '4.']) assert.equal(roundHalfUp2(v), v, v);
  assert.equal(roundHalfUp2(null), null);
  assert.equal(labRoundOn(1), true);
  assert.equal(labRoundOn(undefined), true, 'настройка не прочиталась — включено');
  assert.equal(labRoundOn(0), false);
});

test('labShownValue: ручной ввод — как набран; прибор при включённой — до 2 знаков; выключено — полное значение прибора, если строку не правили', () => {
  assert.equal(labShownValue({ value: '4.152122', source: 'manual' }, true), '4.152122');
  assert.equal(labShownValue({ value: '4.15', raw_value: '4.152122', source: 'analyzer' }, true), '4.15');
  assert.equal(labShownValue({ value: '4.152122', raw_value: null, source: 'analyzer' }, true), '4.15', 'записано до обновления — показ округлённый');
  assert.equal(labShownValue({ value: '4.15', raw_value: '4.152122', source: 'analyzer' }, false), '4.152122');
  assert.equal(labShownValue({ value: '5.00', raw_value: '4.152122', source: 'analyzer' }, false), '5.00', 'исправлено руками — показывается исправленное');
  assert.equal(labShownValue({ value: '>1000', source: 'analyzer' }, true), '>1000');
});

test('приём: включено (по умолчанию) — в бланке 4.15, полное в raw_value; флаг и numeric_value — по округлённому; текст и короткие — как есть', () => {
  const db = clinic();
  assert.equal(ingestMessage(db, BC780('00000100', [['WBC', '4.152122'], ['RBC', '4.8'], ['PLT', '>1000', 'ST'], ['HGB', '138,456']]), '10.0.0.50', 3), 'AA');
  assert.equal(lastRow(db).status, 'applied', lastRow(db).detail);
  const r = rowsOf(db);
  assert.deepEqual(r['Лейкоциты'], { value: '4.15', raw: '4.152122', num: 4.15, flag: 'normal' }, 'по полному 4.152122 был бы «выше нормы», врач видит 4.15 — норма');
  assert.deepEqual(r['Эритроциты'], { value: '4.8', raw: null, num: 4.8, flag: 'normal' });
  assert.equal(r['Тромбоциты'].value, '>1000');
  assert.equal(r['Тромбоциты'].raw, null);
  assert.deepEqual([r['Гемоглобин'].value, r['Гемоглобин'].raw], ['138.46', '138.456'], 'десятичная запятая — точка, потом до 2 знаков');
  db.close();
});

test('приём: выключено — в бланке полное значение, raw_value пуст', () => {
  const db = clinic();
  db.exec('UPDATE doc_settings SET lab_round_analyzer = 0 WHERE id = 1');
  ingestMessage(db, BC780('00000100', [['WBC', '4.152122']]), '10.0.0.50', 3);
  assert.deepEqual(rowsOf(db)['Лейкоциты'], { value: '4.152122', raw: null, num: 4.152122, flag: 'high' });
  db.close();
});

test('приём: то же сообщение второй раз — «повторная передача», а не «повтор» (сравнивается округлённое с округлённым)', () => {
  const db = clinic();
  const msg = BC780('00000100', [['WBC', '4.152122']]);
  ingestMessage(db, msg, '10.0.0.50', 3);
  ingestMessage(db, msg, '10.0.0.50', 3);
  const m = lastRow(db);
  assert.doesNotMatch(String(m.detail), /повтор:/, m.detail);
  assert.match(String(m.detail), /повторная передача/);
  assert.equal(rowsOf(db)['Лейкоциты'].value, '4.15');
  db.close();
});

test('лист «Внести результаты»: значение прибора, записанное полным, сохранили округлённым — полное уходит в raw_value; ручная правка raw не трогает', () => {
  const db = clinic();
  db.exec('UPDATE doc_settings SET lab_round_analyzer = 0 WHERE id = 1');
  ingestMessage(db, BC780('00000100', [['WBC', '4.152122'], ['RBC', '4.8']]), '10.0.0.50', 3);
  const ids = Object.fromEntries(db.prepare('SELECT parameter, id FROM lab_results WHERE visit_service_id = 100').all().map((r) => [r.parameter, r.id]));
  saveLabResults(db, { visit_service_id: 100, rows: [
    { id: ids['Лейкоциты'], parameter: 'Лейкоциты', value: '4.15', numeric_value: 4.15, flag: 'normal' },
    { id: ids['Эритроциты'], parameter: 'Эритроциты', value: '5.2', numeric_value: 5.2, flag: 'normal' },
  ] }, { id: 1, role: 'lab' });
  const r = rowsOf(db);
  assert.deepEqual([r['Лейкоциты'].value, r['Лейкоциты'].raw], ['4.15', '4.152122']);
  assert.deepEqual([r['Эритроциты'].value, r['Эритроциты'].raw], ['5.2', null]);
  db.close();
});

// Ревью S3, L-1 — лаборант набрал своё значение поверх значения прибора (строка
// остаётся source = 'analyzer', raw_value — прибора): «4.1567» показывалось и
// печаталось «4.16». Округляется только то, что записал прибор: raw_value пуст
// (записано до обновления или при выключенной настройке) или value — его округление.
test('ревью L-1: ручная правка поверх значения прибора не округляется при показе; значение прибора — округляется', () => {
  assert.equal(labShownValue({ value: '4.1567', raw_value: '7.2549', source: 'analyzer' }, true), '4.1567', 'правка руками — как набрана');
  assert.equal(labShownValue({ value: '7.25', raw_value: '7.2549', source: 'analyzer' }, true), '7.25');
  assert.equal(labShownValue({ value: '7.2549', raw_value: null, source: 'analyzer' }, true), '7.25', 'до обновления — округляется, как прежде');
  assert.equal(labShownValue({ value: '7.2549', raw_value: '', source: 'analyzer' }, true), '7.25');
  // Настоящий путь: прибор записал 7.2549 → 7.25, лаборант набрал 4.1567 «Сохранить всё».
  const db = clinic();
  ingestMessage(db, BC780('00000100', [['WBC', '7.2549']]), '10.0.0.50', 3);
  const id = db.prepare("SELECT id FROM lab_results WHERE parameter = 'Лейкоциты'").get().id;
  saveLabResults(db, { visit_service_id: 100, rows: [{ id, parameter: 'Лейкоциты', value: '4.1567', flag: 'normal' }] }, { id: 1, role: 'admin' });
  const r = db.prepare('SELECT value, raw_value, source FROM lab_results WHERE id = ?').get(id);
  assert.equal(labShownValue(r, true), '4.1567');
  assert.equal(labShownValue(r, false), '4.1567');
  db.close();
});

// Ревью S3, L-2 — первая повторная передача после обновления: в черновике полное
// значение 3.21 («7.2549»), прибор шлёт ту же пробу снова — приём читает 7.25. Это не
// «повтор: значения отличаются (7.2549 → 7.25)», а повторная передача. То же у серии.
test('ревью L-2: в бланке полное значение (до обновления), прибор прислал то же — «повторная передача», а не «повтор»; другое — «повтор»', () => {
  const db = clinic();
  db.exec(`INSERT INTO lab_results (visit_service_id, parameter, value, numeric_value, flag, source) VALUES (100, 'Лейкоциты', '7.2549', 7.2549, 'high', 'analyzer');
           UPDATE visit_services SET status = 'resulted' WHERE id = 100;`);
  ingestMessage(db, BC780('00000100', [['WBC', '7.2549']]), '10.0.0.50', 3);
  let m = lastRow(db);
  assert.doesNotMatch(String(m.detail), /повтор:/, m.detail);
  assert.match(String(m.detail), /повторная передача/);
  assert.equal(rowsOf(db)['Лейкоциты'].value, '7.2549', 'бланк не тронут');
  ingestMessage(db, BC780('00000100', [['WBC', '7.31']]), '10.0.0.50', 3);
  m = lastRow(db);
  assert.match(String(m.detail), /повтор: значения отличаются от уже записанных \(Лейкоциты 7\.2549 → 7\.31\)/);
  db.close();
});

test('ревью L-2: выключено, в бланке округлённое (записано при включённой) — то же сообщение снова — «повторная передача»', () => {
  const db = clinic();
  const msg = BC780('00000100', [['WBC', '7.2549']]);
  ingestMessage(db, msg, '10.0.0.50', 3);
  db.exec('UPDATE doc_settings SET lab_round_analyzer = 0 WHERE id = 1');
  ingestMessage(db, msg, '10.0.0.50', 3);
  const m = lastRow(db);
  assert.doesNotMatch(String(m.detail), /повтор:/, m.detail);
  assert.equal(rowsOf(db)['Лейкоциты'].value, '7.25');
  db.close();
});

// Ревью S3, L-2 — «Привязать» снимает значение прибора из прежнего бланка, только
// если там всё ещё ЕГО значение. Записано полным (настройка была выключена или до
// обновления), а сравнивалось с округлённым чтением — значение оставалось в чужом
// бланке как «изменено после прибора».
test('ревью L-2: «Привязать» к другому заказу снимает из прежнего бланка значение прибора, записанное полным', async () => {
  const { lisMessageAttach } = await import('../services/rpc/lis.js');
  const db = clinic();
  db.exec(`INSERT INTO visit_services (id, visit_id, service_id, status, created_at) VALUES (101, 20, 41, 'queued', ${NOW})`);
  db.exec('UPDATE doc_settings SET lab_round_analyzer = 0 WHERE id = 1');
  ingestMessage(db, BC780('00000100', [['WBC', '7.2549']]), '10.0.0.50', 3);
  const m = lastRow(db);
  assert.equal(m.status, 'unmapped', 'бланк не весь — строка в лотке, её можно «Привязать»');
  assert.equal(rowsOf(db)['Лейкоциты'].value, '7.2549');
  db.exec('UPDATE doc_settings SET lab_round_analyzer = 1 WHERE id = 1');
  const r = lisMessageAttach(db, { id: m.id, visit_service_id: 101 }, { id: 1, role: 'admin' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.doesNotMatch(r.detail, /изменено после прибора/, r.detail);
  assert.deepEqual(rowsOf(db), {}, 'из бланка № 100 значения прибора сняты');
  db.close();
});
