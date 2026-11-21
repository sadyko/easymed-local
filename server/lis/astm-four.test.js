// LIS_ASTM_FOUR_V1 (решение владельца 2026-11-21: «yes we should add») — ЧЕТЫРЕ
// ASTM-ПРИБОРА КАК МОДЕЛИ EASY-MED: Sysmex XN-350 (гематология), Sysmex CA-660
// (коагулометр), Roche cobas c 311 (биохимия), Roche cobas e 411 (ИХЛА).
//
// Говорят они ASTM, Easy-Med читает HL7 — их приносит переадресатор лаборатории
// (Desktop\new lis, 95ee060, src/astm/read.js toForwarderOru): MSH-3 — модель
// («XN-350», «CA-660», «cobas c311», «cobas e411»), MSH-4 — «LabPC», номер пробы —
// OBR-3, код — OBX-3.1 («WBC^^SYSMEX», «041^^SYSMEX», «10^^ROCHE»), подпись — OBX-4,
// значение — OBX-5. До этой правки модели не было: прибор ложился строкой
// «модель не определена», и лаборатория выбирала «Другой анализатор». Теперь
// модель угадывается по MSH-3 сама, и у XN-350 и CA-660 в «Поле анализатора» —
// типовые показатели.
//
// Сообщения ниже собраны ровно так, как их собирает toForwarderOru переадресателя.
process.env.TZ = 'Asia/Tashkent';
const { default: test } = await import('node:test');
const { default: assert } = await import('node:assert/strict');
const { listProfiles, getProfile, findChannel } = await import('./profiles/index.js');
const { guessProfile, ensureDevice } = await import('./discover.js');
const { wireDecision } = await import('./wire.js');
const { ingestMessage } = await import('./ingest.js');
const { lisProfiles } = await import('../services/rpc/lis.js');
const { freshDb, bindPanel, lastRow, blank } = await import('../test-helpers/lisproxy-clinic.js');

const NOW = "strftime('%Y-%m-%dT%H:%M:%SZ','now')";
const ADMIN = { id: 1, role: 'admin' };

/** HL7 переадресателя для ASTM-прибора — как toForwarderOru (new lis, src/astm/read.js). */
const FWD = (model, system, sample, rows) => [
  `MSH|^~\\&|${model}|LabPC|||20261121100000||ORU^R01|1|P|2.3.1`,
  `OBR|1||${sample}`,
  ...rows.map(([code, label, value, unit, flag = '', type = 'NM'], i) =>
    `OBX|${i + 1}|${type}|${code}^^${system}|${label}|${value}|${unit}||${flag}|||F`),
].join('\r') + '\r';

const FOUR = [
  { key: 'sysmex-xn-350', vendor: 'Sysmex', model: 'XN-350', msh3: 'XN-350', kind: 'hematology' },
  { key: 'sysmex-ca-660', vendor: 'Sysmex', model: 'CA-660', msh3: 'CA-660', kind: 'coagulation' },
  { key: 'roche-cobas-c311', vendor: 'Roche', model: 'cobas c 311', msh3: 'cobas c311', kind: 'chemistry' },
  { key: 'roche-cobas-e411', vendor: 'Roche', model: 'cobas e 411', msh3: 'cobas e411', kind: 'immunoassay' },
];

test('четыре модели в списке: марка, модель, вид; провод переадресателя; звонит переадресатор (2575); по пробе, не по тесту', () => {
  for (const f of FOUR) {
    const p = getProfile(f.key);
    assert.ok(p, 'нет профиля ' + f.key);
    assert.deepEqual([p.vendor, p.model, p.kind], [f.vendor, f.model, f.kind], f.key);
    assert.deepEqual([p.wire, p.connect, p.defaultPort, p.transports], ['forwarder', 'listen', 2575, ['mllp']], f.key);
    assert.ok(!p.oneTestPerMessage, f.key + ': переадресатор шлёт пробу одним сообщением');
    assert.ok(!p.codesPerInstrument, f.key + ': коды задаёт производитель, не клиника на каждом приборе');
  }
  assert.ok(listProfiles().length >= 13);
});

test('модель угадывается по MSH-3 переадресателя — и только своя', () => {
  for (const f of FOUR) {
    assert.equal(guessProfile({ app: f.msh3, facility: 'LabPC' })?.key, f.key, f.msh3);
  }
  // Как могла бы назвать себя модель в другом написании — та же.
  assert.equal(guessProfile({ app: 'cobas c 311' })?.key, 'roche-cobas-c311');
  assert.equal(guessProfile({ app: 'Roche cobas e411' })?.key, 'roche-cobas-e411');
  assert.equal(guessProfile({ app: 'Sysmex XN-350' })?.key, 'sysmex-xn-350');
  // Соседние модели — не эти: другой прибор, другие показатели.
  for (const other of ['XN-3500', 'XN-550', 'XN-L', 'CA-6600', 'CA-1000', 'Sysmex CA-1500', 'cobas c 3110', 'cobas e 601', 'cobas', 'Roche']) {
    const g = guessProfile({ app: other, facility: 'LabPC' });
    assert.ok(!g || !FOUR.some((f) => f.key === g.key), other + ' угадан как ' + (g && g.key));
  }
});

test('XN-350: показатели — имена Sysmex, как в записи R прибора (NEUT#, LYMPH%, EO#, IG#, P-LCR…)', () => {
  const p = getProfile('sysmex-xn-350');
  const codes = p.channels.map((c) => c.code);
  assert.deepEqual([...codes].sort(), ['BASO#', 'BASO%', 'EO#', 'EO%', 'HCT', 'HGB', 'IG#', 'IG%', 'LYMPH#', 'LYMPH%', 'MCH', 'MCHC',
    'MCV', 'MONO#', 'MONO%', 'MPV', 'NEUT#', 'NEUT%', 'NRBC#', 'NRBC%', 'P-LCR', 'PCT', 'PDW', 'PLT', 'RBC', 'RDW-CV', 'RDW-SD', 'WBC'].sort());
  // Имена Mindray здесь не годятся — XN их не шлёт.
  for (const never of ['NEU#', 'LYM%', 'EOS#', 'BAS%', 'MON#', 'PLCR']) assert.equal(findChannel('sysmex-xn-350', never), null, never);
  assert.equal(findChannel('sysmex-xn-350', 'neut#').name, 'Нейтрофилы, абс.');
  assert.equal(p.channelsSource, 'conventional', 'список типовой: экран просит сверить по прибору');
});

test('CA-660: показатели — коды Sysmex (041 ПВ, с; 042 ПВ, %; 044 МНО; 051 АЧТВ; 061 фибриноген)', () => {
  const p = getProfile('sysmex-ca-660');
  assert.deepEqual(p.channels.map((c) => c.code), ['041', '042', '044', '051', '061']);
  assert.equal(findChannel('sysmex-ca-660', '044').name, 'МНО');
  assert.equal(p.channelsSource, 'conventional');
  assert.equal(p.wireSource, 'driver', 'поля CA-660 — по драйверам: экран просит сверить первую пробу');
});

test('cobas c 311 и e 411: типового списка нет — номера тестов приходят с первой пробой', () => {
  for (const key of ['roche-cobas-c311', 'roche-cobas-e411']) {
    const p = getProfile(key);
    assert.deepEqual(p.channels, [], key);
    assert.equal(p.channelsSource, 'device', key);
  }
  assert.equal(getProfile('roche-cobas-c311').wireSource, 'driver');
  assert.equal(getProfile('roche-cobas-e411').wireSource, 'documented');
});

test('экран получает модели через lisProfiles: подпись «Sysmex XN-350», «Roche cobas e 411»', () => {
  const list = lisProfiles(null, {}, ADMIN);
  for (const f of FOUR) {
    const p = list.find((x) => x.key === f.key);
    assert.ok(p, f.key);
    assert.equal(p.vendor + ' ' + p.model, f.vendor + ' ' + f.model);
    assert.equal(p.wire, 'forwarder');
  }
});

/** Клиника: визит 20 сегодня, строки 101..104 — ОАК, коагулограмма, биохимия, ТТГ; оплачены, в заборе. */
function clinic() {
  const db = freshDb();
  db.exec(`INSERT INTO patients (id, full_name) VALUES (7, 'Тестов Пациент');
    INSERT INTO visits (id, patient_id, visit_date, status) VALUES (20, 7, ${NOW}, 'scheduled');
    INSERT INTO services (id, name, is_lab, specimen) VALUES (41, 'ОАК', 1, 'Кровь'), (42, 'Коагулограмма', 1, 'Плазма'),
      (43, 'Биохимия', 1, 'Сыворотка'), (44, 'ТТГ', 1, 'Сыворотка');
    INSERT INTO visit_services (id, visit_id, service_id, status, created_at) VALUES
      (101, 20, 41, 'queued', ${NOW}), (102, 20, 42, 'queued', ${NOW}), (103, 20, 43, 'queued', ${NOW}), (104, 20, 44, 'queued', ${NOW});`);
  return db;
}

/** Переадресатор с лабораторного ПК 10.0.0.70 прислал первую пробу: строка прибора заведена сама, модель угадана. */
function found(db, msh3) {
  const { device } = ensureDevice(db, { sendingApp: msh3, sendingFacility: 'LabPC', peer: '10.0.0.70' });
  return device;
}

test('сквозь приём: четыре прибора с одного лабораторного ПК — четыре строки, модели угаданы, значения в бланках по этикетке строки', () => {
  const db = clinic();
  const xn = found(db, 'XN-350');
  const ca = found(db, 'CA-660');
  const c311 = found(db, 'cobas c311');
  const e411 = found(db, 'cobas e411');
  assert.deepEqual([xn, ca, c311, e411].map((d) => d.profile), FOUR.map((f) => f.key), 'модель угадана по MSH-3');
  assert.equal(new Set([xn.id, ca.id, c311.id, e411.id]).size, 4, 'один адрес — четыре прибора: различает MSH-3');
  assert.equal(wireDecision({ profile: getProfile('sysmex-xn-350'), facility: 'LabPC', app: 'XN-350' }).wire, 'forwarder');

  // Лаборатория: «Добавить» каждый; панели — коды из «Поля анализатора».
  db.prepare('UPDATE lab_devices SET added = 1, model_confirmed = 1 WHERE id IN (?, ?, ?, ?)').run(xn.id, ca.id, c311.id, e411.id);
  bindPanel(db, { id: 41, serviceId: 41, deviceId: xn.id, name: 'ОАК', lines: [['WBC', 'Лейкоциты', 'WBC'], ['NEUT%', 'Нейтрофилы, %', 'NEUT%'], ['PLT', 'Тромбоциты', 'PLT']] });
  bindPanel(db, { id: 42, serviceId: 42, deviceId: ca.id, name: 'Коагулограмма', lines: [['PT', 'ПВ', '041'], ['INR', 'МНО', '044'], ['APTT', 'АЧТВ', '051']] });
  bindPanel(db, { id: 43, serviceId: 43, deviceId: c311.id, name: 'Биохимия', lines: [['ALT', 'АЛТ', '685'], ['GLU', 'Глюкоза', '717']] });
  bindPanel(db, { id: 44, serviceId: 44, deviceId: e411.id, name: 'ТТГ', lines: [['TSH', 'ТТГ', '10'], ['HBSAG', 'HBsAg', '20']] });

  ingestMessage(db, FWD('XN-350', 'SYSMEX', '00000101', [['WBC', '', '7.25', '10*3/uL'], ['NEUT%', '', '55.1', '%'], ['PLT', '', '231', '10*3/uL']]), '10.0.0.70', xn.id);
  assert.equal(lastRow(db).status, 'applied', lastRow(db).detail);
  assert.deepEqual(blank(db, 101), { 'Лейкоциты': '7.25', 'Нейтрофилы, %': '55.1', 'Тромбоциты': '231' });

  ingestMessage(db, FWD('CA-660', 'SYSMEX', '00000102', [['041', 'PT', '12.4', 'sec'], ['042', 'PT%', '98.0', '%'], ['044', 'INR', '1.02', ''], ['051', 'APTT', '31.2', 'sec', 'H']]), '10.0.0.70', ca.id);
  assert.equal(lastRow(db).status, 'applied', lastRow(db).detail);
  assert.deepEqual(blank(db, 102), { 'ПВ': '12.4', 'МНО': '1.02', 'АЧТВ': '31.2' });

  ingestMessage(db, FWD('cobas c311', 'ROCHE', '00000103', [['685', '', '24', 'U/L'], ['717', '', '5.4', 'mmol/L']]), '10.0.0.70', c311.id);
  assert.equal(lastRow(db).status, 'applied', lastRow(db).detail);
  assert.deepEqual(blank(db, 103), { 'АЛТ': '24', 'Глюкоза': '5.4' });

  // e 411: качественный — текстом, флаг A (переадресатор: «Положительно (COI 12.5)»).
  ingestMessage(db, FWD('cobas e411', 'ROCHE', '00000104', [['10', '', '2.15', 'uIU/mL'], ['20', '', 'Положительно (COI 12.5)', '', 'A', 'ST']]), '10.0.0.70', e411.id);
  assert.equal(lastRow(db).status, 'applied', lastRow(db).detail);
  assert.deepEqual(blank(db, 104), { 'ТТГ': '2.15', 'HBsAg': 'Положительно (COI 12.5)' });
  db.close();
});

test('один прибор одной модели — не кормит панель другой модели (ОАК на XN-350 не принимает CA-660)', () => {
  const db = clinic();
  const xn = found(db, 'XN-350');
  const ca = found(db, 'CA-660');
  db.prepare('UPDATE lab_devices SET added = 1, model_confirmed = 1 WHERE id IN (?, ?)').run(xn.id, ca.id);
  bindPanel(db, { id: 41, serviceId: 41, deviceId: xn.id, name: 'ОАК', lines: [['WBC', 'Лейкоциты', 'WBC']] });
  ingestMessage(db, FWD('CA-660', 'SYSMEX', '00000101', [['041', 'PT', '12.4', 'sec']]), '10.0.0.70', ca.id);
  assert.equal(lastRow(db).status, 'unmatched');
  assert.match(lastRow(db).detail, /кормится анализатором другой модели \(«XN-350»\)/, 'модель названа по-человечески');
  assert.deepEqual(blank(db, 101), {});
  db.close();
});
