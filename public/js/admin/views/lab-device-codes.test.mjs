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
