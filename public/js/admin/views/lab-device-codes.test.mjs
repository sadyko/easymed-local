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
