// lab-device-codes.test.mjs — из чего выбирать «Поле анализатора»
// (LIS_MINDRAY_CODES_V1). Чистое правило: списки на входе, решение на выходе.
import test from 'node:test';
import assert from 'node:assert/strict';
import { codeChoices, TYPE_OWN } from './lab-device-codes.js';

const SENT = [
  { code: '08001', name: 'Take Mode', value_type: 'IS' },
  { code: '6690-2', name: 'WBC', value_type: 'NM' },
  { code: '718-7', name: 'HGB', value_type: 'NM' },
];
const CHANNELS = [{ code: 'WBC', name: 'Лейкоциты' }, { code: 'PLT', name: 'Тромбоциты' }];

test('присланные коды: числа впереди служебных строк, подпись «код · имя», сохраняется имя', () => {
  const c = codeChoices({ sent: SENT, channels: CHANNELS });
  assert.deepEqual(c.sent.map((o) => o.label), ['6690-2 · WBC', '718-7 · HGB', '08001 · Take Mode']);
  assert.deepEqual(c.sent.map((o) => o.value), ['WBC', 'HGB', 'Take Mode'], 'имя ловят оба вида провода');
});

test('типовой список не повторяет то, что прибор уже присылал', () => {
  assert.deepEqual(codeChoices({ sent: SENT, channels: CHANNELS }).typical.map((o) => o.value), ['PLT']);
});

test('сохранённый код узнаётся и по коду, и по имени, без учёта регистра', () => {
  assert.equal(codeChoices({ sent: SENT, channels: CHANNELS, current: '6690-2' }).selected, 'WBC');
  assert.equal(codeChoices({ sent: SENT, channels: CHANNELS, current: 'wbc' }).selected, 'WBC');
  assert.equal(codeChoices({ sent: SENT, channels: CHANNELS, current: 'PLT' }).selected, 'PLT');
});

test('код вне обоих списков не превращается в «не выбрано» — он показан отдельно', () => {
  const c = codeChoices({ sent: SENT, channels: CHANNELS, current: 'NRBC#' });
  assert.deepEqual(c.orphan, { value: 'NRBC#', label: 'NRBC#' });
  assert.equal(c.selected, 'NRBC#');
});

test('без присланных кодов остаётся типовой список; пустое сохранённое — ничего не выбрано', () => {
  const c = codeChoices({ channels: CHANNELS });
  assert.deepEqual(c.sent, []);
  assert.deepEqual(c.typical.map((o) => o.label), ['WBC · Лейкоциты', 'PLT · Тромбоциты']);
  assert.equal(c.selected, '');
  assert.equal(c.orphan, null);
});

test('пункт «Вписать код…» — служебное значение, не похожее на код прибора', () => {
  assert.match(TYPE_OWN, /^__/);
  assert.ok(!codeChoices({ sent: SENT, channels: CHANNELS }).sent.some((o) => o.value === TYPE_OWN));
});

// LIS_REAL_ANALYZERS_V1_WIRE (экран) — подпись строки прибора (lis_device_codes
// label: BS-200 — имя теста из OBX-4, Autobio — OBX-3) только показывается.
// Сохраняется, как прежде, имя, если оно есть, иначе код: у BS-200 имени нет,
// сохраняется номер теста «12» — сопоставление идёт по номеру, а человек видит имя.
test('BS-200: «12 · GLU», сохраняется «12»; сохранённое «12» узнаётся', () => {
  const sent = [
    { code: '12', name: '', label: 'GLU', value_type: 'NM' },
    { code: '3', name: '', label: '', value_type: 'NM' },
    { code: '206', name: '', label: 'Vitamin B12', value_type: 'NM' },
  ];
  const c = codeChoices({ sent, current: '12' });
  assert.deepEqual(c.sent.map((o) => [o.label, o.value]), [['12 · GLU', '12'], ['3', '3'], ['206 · Vitamin B12', '206']]);
  assert.equal(c.selected, '12');
});

test('код, имя и подпись — все три в пункте, повторы не дублируются; сохраняется имя', () => {
  const c = codeChoices({ sent: [
    { code: '6690-2', name: 'WBC', label: 'Лейкоциты', value_type: 'NM' },
    { code: 'HGB', name: 'HGB', label: 'hgb', value_type: 'NM' },
    { code: '718-7', name: 'HGB', label: '', value_type: 'NM' },
  ] });
  assert.deepEqual(c.sent.map((o) => [o.label, o.value]), [['6690-2 · WBC · Лейкоциты', 'WBC'], ['HGB', 'HGB']]);
});

// LIS_REAL_ANALYZERS_V1 — ревью R5, п. 5: экран узнаёт модель по имени, которым
// прибор назвался (MSH-3/4), по тем же правилам, что сервер (discover.js
// guessProfile): «Панели» помечают подтверждения BS-200 под чужой моделью.
import { namedModel } from './lab-device-codes.js';
import { guessProfile } from '../../../../server/lis/discover.js';
import { listProfiles, aliasesOf } from '../../../../server/lis/profiles/index.js';

test('R5 п. 5: модель по имени прибора — та же, что у сервера (guessProfile), на настоящих и спорных именах', () => {
  const profiles = listProfiles().map((p) => ({ key: p.key, model: p.model, aliases: aliasesOf(p), codesPerInstrument: !!p.codesPerInstrument }));
  const cases = [
    ['Mindray', 'BS-200E'], ['BS-200', ''], ['', 'BS-200E'], ['Mindray BS-200E v2', ''], ['BS-2000M', ''], ['Mindray', ''],
    ['BC-5300', 'Mindray'], ['MINDRAY BC-5300', ''], ['BC-5300 v2', ''], ['BC-20s', ''], ['Mindray BC-20', ''],
    ['AutoLumo A1000', ''], ['A1000', 'Autolumo'], ['XA1000', ''], ['Sysmex CA-1000', ''], ['EasyLab A1000X', ''],
    ['BS-240', 'Mindray'], ['A2000 Plus', ''], ['', ''], ['LabPC', ''], ['BC-780', ''], ['bc 780', ''], ['CL-900i', 'Mindray'],
  ];
  for (const [app, facility] of cases) {
    const server = guessProfile({ app, facility });
    const client = namedModel({ app, facility }, profiles);
    assert.equal(client ? client.key : null, server ? server.key : null, JSON.stringify([app, facility]));
  }
});

// ── LIS_VENDOR_EXACT_V1 — порядок «Присылал этот анализатор» ─────────────────
// Приёмка BC-20 (acceptance\runs\mindray-bc-20, result.json): в списке были все
// 20 результатов, но и 24 служебные строки, а первой стояла «30525-0 · Age»
// (числа шли вперёд, Age — NM), за результатами — 11 строк гистограмм 15xxx (NM).
// Выбери лаборант Age или гистограмму — строка бланка пустеет на каждой пробе.
// Теперь: сначала коды, совпавшие с типовым списком модели, потом остальные
// числовые результаты, потом прочие результаты (качественные ST, CE A1000), и
// только в конце служебные строки: возраст (30525-0), гистограммы и
// скатерограммы (15xxx), режимы, тревоги и примечание Mindray (IS, ST 01001).
// Ничего не прячется: служебная строка — последней, с отметкой service.
import { openDb } from '../../../../server/db/connection.js';
import { migrate } from '../../../../server/db/migrate.js';
import { lisDeviceCodes } from '../../../../server/services/rpc/lis.js';
import { getProfile } from '../../../../server/lis/profiles/index.js';

// BC-20 в полной раскладке Mindray (BC-3600 OM, прил. D.7.4: возраст и
// примечание при сведениях о пациенте, тревоги, гистограммы «Данными») —
// построчно как в приёмке (scenario.mjs bc20Oru), значения синтетические.
const BC20_PARAMS = [
  ['6690-2^WBC^LN', '15.2', '10*9/L'], ['731-0^LYM#^LN', '2.1', '10*9/L'], ['736-9^LYM%^LN', '13.8', '%'],
  ['789-8^RBC^LN', '4.52', '10*12/L'], ['718-7^HGB^LN', '135', 'g/L'], ['787-2^MCV^LN', '84.1', 'fL'],
  ['785-6^MCH^LN', '29.9', 'pg'], ['786-4^MCHC^LN', '355', 'g/L'], ['788-0^RDW-CV^LN', '12.9', '%'],
  ['21000-5^RDW-SD^LN', '42.3', 'fL'], ['4544-3^HCT^LN', '38.0', '%'], ['777-3^PLT^LN', '250', '10*9/L'],
  ['32623-1^MPV^LN', '6.2', 'fL'], ['32207-3^PDW^LN', '15.6', ''], ['10002^PCT^99MRC', '0.155', '%'],
  ['10027^MID#^99MRC', '0.6', '10*9/L'], ['10029^MID%^99MRC', '3.9', '%'], ['10028^GRAN#^99MRC', '12.5', '10*9/L'],
  ['10030^GRAN%^99MRC', '82.3', '%'], ['10014^PLCR^99MRC', '18.4', '%'],
];
function bc20Frame() {
  const segs = ['MSH|^~\\&|||||20261006120000||ORU^R01|1|P|2.3.1||||||UNICODE', 'PID|1||^^^^MR', 'PV1|1',
    'OBR|1||LAB-000101|00001^Automated Count^99MRC|||20261006120000|||||||||||||||||HM||||||||Admin'];
  let n = 0;
  const add = (type, code, value = '', unit = '') => segs.push(`OBX|${++n}|${type}|${code}||${value}|${unit}|||||F`);
  add('IS', '08001^Take Mode^99MRC', 'O'); add('IS', '08002^Blood Mode^99MRC', 'W');
  add('IS', '08003^Test Mode^99MRC', 'CBC'); add('IS', '01002^Ref Group^99MRC', 'General');
  add('NM', '30525-0^Age^LN', '34', 'yr'); add('ST', '01001^Remark^99MRC', '');
  for (const [code, value, unit] of BC20_PARAMS) add('NM', code, value, unit);
  add('IS', '12045^Multiple alerts^99MRC', 'F'); add('IS', '12046^Lym left region alert^99MRC', 'F');
  add('IS', '', 'F');   // прил. D.7.4, OBX 29: строка тревоги без OBX-3
  add('IS', '12048^Mid gran region alert^99MRC', 'F');
  add('NM', '15004^WBC Histogram. Meta Length^99MRC', '1'); add('NM', '15010^WBC Lym left line.^99MRC', '23');
  add('NM', '15011^WBC Lym Mid line.^99MRC', '52'); add('NM', '15012^WBC Mid Gran line.^99MRC', '71');
  add('NM', '15013^WBC Gran right line^99MRC', '215');
  add('ED', '15000^WBC Histogram. Binary^99MRC', '^Application^Octer-stream^Base64^AAECAwQ=');
  add('NM', '15051^RBC Histogram. Left Line^99MRC', '36'); add('NM', '15052^RBC Histogram. Right Line^99MRC', '230');
  add('NM', '15053^RBC Histogram. Binary Meta Length^99MRC', '1');
  add('NM', '15111^PLT Histogram. Left Line^99MRC', '3'); add('NM', '15112^PLT Histogram. Right Line^99MRC', '35');
  add('NM', '15113^PLT Histogram. Binary Meta Length^99MRC', '1');
  return segs.join('\r');
}
const RESULT_VALUES = ['WBC', 'LYM#', 'LYM%', 'RBC', 'HGB', 'MCV', 'MCH', 'MCHC', 'RDW-CV', 'RDW-SD', 'HCT', 'PLT', 'MPV', 'PDW', 'PCT',
  'MID#', 'MID%', 'GRAN#', 'GRAN%', 'PLCR'];

test('BC-20 (приёмка): первым — результат, а не «30525-0 · Age»; все 20 результатов раньше служебных строк; ничего не пропало', () => {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO lab_devices (id, name, profile) VALUES (1, 'BC-20', 'mindray-bc-20')").run();
  db.prepare("INSERT INTO lab_device_messages (device_id, peer, raw, sample_id, status) VALUES (1, '192.168.1.50', ?, 'LAB-000101', 'unmapped')").run(bc20Frame());
  const sent = lisDeviceCodes(db, { device_id: 1 }, { role: 'lab' });
  db.close();
  const c = codeChoices({ sent, channels: getProfile('mindray-bc-20').channels });
  const values = c.sent.map((o) => o.value);
  assert.equal(c.sent.length, sent.length, 'служебные строки не спрятаны — они последние');
  assert.equal(c.sent[0].label, '6690-2 · WBC', 'первым — WBC: ' + c.sent.map((o) => o.label).join(' | '));
  assert.deepEqual(values.slice(0, RESULT_VALUES.length).sort(), [...RESULT_VALUES].sort(), 'первые 20 — результаты');
  const firstService = c.sent.findIndex((o) => o.service);
  assert.equal(firstService, RESULT_VALUES.length, 'служебные начинаются сразу за результатами');
  assert.ok(c.sent.slice(firstService).every((o) => o.service), 'и идут до конца');
  for (const label of ['30525-0 · Age', '15004 · WBC Histogram. Meta Length', '15051 · RBC Histogram. Left Line',
    '15113 · PLT Histogram. Binary Meta Length', '08001 · Take Mode', '12045 · Multiple alerts', '01001 · Remark']) {
    const i = c.sent.findIndex((o) => o.label === label);
    assert.ok(i >= RESULT_VALUES.length && c.sent[i].service, label + ' — среди служебных, после результатов (место ' + i + ')');
  }
  // Сначала — совпавшие с типовым списком модели, следом — прочие результаты (каким бы ни был список профиля).
  const typical = new Set(getProfile('mindray-bc-20').channels.map((ch) => String(ch.code).toUpperCase()));
  const hits = values.slice(0, RESULT_VALUES.length).map((v) => typical.has(v.toUpperCase()));
  const firstMiss = hits.indexOf(false);
  assert.ok(firstMiss === -1 || hits.slice(firstMiss).every((h) => !h), 'типовые модели — раньше прочих: ' + values.join(' '));

  // Точный порядок — при списке модели, где GRA#/GRA% (≠ GRAN#/GRAN% провода), а RDW-SD и P-LCR нет (профиль 3.16.0).
  const old = codeChoices({ sent, channels: ['WBC', 'LYM#', 'MID#', 'GRA#', 'LYM%', 'MID%', 'GRA%', 'RBC', 'HGB', 'HCT', 'MCV', 'MCH', 'MCHC',
    'RDW-CV', 'PLT', 'MPV', 'PDW', 'PCT'].map((code) => ({ code })) });
  assert.deepEqual(old.sent.slice(0, RESULT_VALUES.length).map((o) => o.value), ['WBC', 'LYM#', 'LYM%', 'RBC', 'HGB', 'MCV', 'MCH', 'MCHC',
    'RDW-CV', 'HCT', 'PLT', 'MPV', 'PDW', 'PCT', 'MID#', 'MID%', 'RDW-SD', 'GRAN#', 'GRAN%', 'PLCR'], 'внутри групп — порядок прибора');
});

test('порядок внутри «Присылал этот анализатор»: типовые модели → прочие числа → прочие результаты → служебные', () => {
  const sent = [
    { code: '30525-0', name: 'Age', system: 'LN', value_type: 'NM' },
    { code: '01001', name: 'Remark', system: '99MRC', value_type: 'ST' },
    { code: 'HBsAg', name: '', system: '99MRC', value_type: 'ST' },          // качественный тест CL-900i / BS-240 — результат
    { code: '107', name: '', system: '', value_type: 'CE', label: 'AFP' },    // A1000 «>1000.00» — результат
    { code: 'ALY#', name: '', system: '', value_type: 'NM' },
    { code: '15200', name: 'WBC DIFF Scattergram. BMP', system: '99MRC', value_type: 'NM' },
    { code: 'TSH', name: '', system: '99MRC', value_type: 'NM' },
    { code: '08003', name: 'Test Mode', system: '99MRC', value_type: 'IS' },
  ];
  const c = codeChoices({ sent, channels: [{ code: 'TSH', name: 'ТТГ' }] });
  assert.deepEqual(c.sent.map((o) => o.label), ['TSH', 'ALY#', 'HBsAg', '107 · AFP',
    '30525-0 · Age', '01001 · Remark', '15200 · WBC DIFF Scattergram. BMP', '08003 · Test Mode']);
  assert.deepEqual(c.sent.map((o) => !!o.service), [false, false, false, false, true, true, true, true]);
});

test('служебная строка не становится результатом по совпадению с типовым списком; результат 10xxx Mindray — не служебная', () => {
  const c = codeChoices({ sent: [
    { code: '15004', name: 'WBC Histogram. Meta Length', system: '99MRC', value_type: 'NM' },
    { code: '10002', name: 'PCT', system: '99MRC', value_type: 'NM' },
  ], channels: [{ code: 'WBC Histogram. Meta Length' }, { code: 'PCT' }] });
  assert.deepEqual(c.sent.map((o) => [o.value, !!o.service]), [['PCT', false], ['WBC Histogram. Meta Length', true]]);
});

test('сохранённый служебный код по-прежнему узнаётся и выбран (подтверждение человека не теряется)', () => {
  const c = codeChoices({ sent: [{ code: '30525-0', name: 'Age', system: 'LN', value_type: 'NM' }, { code: '6690-2', name: 'WBC', value_type: 'NM' }], current: '30525-0' });
  assert.equal(c.selected, 'Age');
  assert.equal(c.orphan, null);
});
