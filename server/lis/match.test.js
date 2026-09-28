// match.test.js — какая строка прибора кладётся в какую строку бланка, и когда
// проба лежит в лотке (LIS_MINDRAY_CODES_V1). Чистые функции: ни базы, ни времени.
import test from 'node:test';
import assert from 'node:assert/strict';
import { planObservations, outcome } from './match.js';

const obs = (codeRaw, value = '1', status = 'F') => {
  const [code = '', name = '', system = ''] = codeRaw.split('^');
  return { code, name, system, codeRaw, value, status, valueType: 'NM', unit: '', range: '', abnormal: '' };
};
const line = (id, name, device_code, confirmed = 1) => ({ id, name, device_code, device_code_confirmed: confirmed });

test('подтверждённый код ловит строку прибора и по коду, и по имени, без учёта регистра', () => {
  const byName = planObservations([obs('6690-2^WBC^LN', '9.81')], [line(1, 'Лейкоциты', 'WBC')]);
  assert.equal(byName.fills.length, 1);
  assert.equal(byName.fills[0].analyte.id, 1);
  assert.equal(planObservations([obs('6690-2^WBC^LN', '9.81')], [line(1, 'Лейкоциты', '6690-2')]).fills.length, 1);
  assert.equal(planObservations([obs('6690-2^wbc^LN')], [line(1, 'Лейкоциты', 'WBC')]).fills.length, 1, 'регистр не важен');
});

test('две строки прибора на одну строку бланка — побеждает совпавшая по коду', () => {
  const p = planObservations([obs('12345^WBC^99MRC', '1.0'), obs('WBC^^99MRC', '2.0')], [line(1, 'Лейкоциты', 'WBC')]);
  assert.equal(p.fills.length, 1);
  assert.equal(p.fills[0].obs.value, '2.0');
  assert.deepEqual(p.unused.map((o) => o.codeRaw), ['12345^WBC^99MRC']);
});

test('неподтверждённая строка не заполняется, а пришедшее для неё названо отдельно (D4)', () => {
  const p = planObservations([obs('6690-2^WBC^LN')], [line(1, 'Лейкоциты', 'WBC', 0)]);
  assert.equal(p.fills.length, 0);
  assert.deepEqual(p.unconfirmed.map((o) => o.codeRaw), ['6690-2^WBC^LN']);
  assert.equal(p.missing.length, 0, 'неподтверждённую строку ещё никто не ждёт — «не пришла» она не бывает');
});

test('предварительное и пустое значение не ложатся, строка бланка названа с причиной', () => {
  const p = planObservations([obs('WBC^^99MRC', '6.1', 'P'), obs('HGB^^99MRC', '')],
    [line(1, 'Лейкоциты', 'WBC'), line(2, 'Гемоглобин', 'HGB')]);
  assert.equal(p.fills.length, 0);
  assert.deepEqual(p.missing.map((m) => m.analyte.name + ':' + m.reason), ['Лейкоциты:статус P', 'Гемоглобин:пустое значение']);
});

test('лоток: бланк заполнен — applied, лишние строки только в справке', () => {
  const o = outcome(planObservations([obs('08001^Take Mode^99MRC', 'O'), obs('6690-2^WBC^LN', '9.81')], [line(1, 'Лейкоциты', 'WBC')]));
  assert.equal(o.status, 'applied');
  assert.equal(o.detail, 'не использованы: 08001^Take Mode^99MRC');
});

test('лоток: подтверждённая строка не пришла — unmapped с её именем и кодом', () => {
  const o = outcome(planObservations([obs('6690-2^WBC^LN', '9.81')], [line(1, 'Лейкоциты', 'WBC'), line(2, 'Гемоглобин', 'HGB')]));
  assert.equal(o.status, 'unmapped');
  assert.equal(o.detail, 'не пришли: Гемоглобин (HGB)');
});

test('лоток: ничего не легло — unmapped, и журнал говорит почему', () => {
  assert.equal(outcome(planObservations([], [])).status, 'unmapped');
  assert.equal(outcome(planObservations([], [])).detail, 'в сообщении нет результатов');
  assert.equal(outcome(planObservations([obs('ALT^^99MRC')], [])).detail, 'не использованы: ALT^^99MRC');
});

test('длинный список лишних строк обрезается с остатком', () => {
  const many = Array.from({ length: 20 }, (_, i) => obs(`${i}^X${i}^99MRC`));
  const o = outcome(planObservations([obs('6690-2^WBC^LN', '9.81'), ...many], [line(1, 'Лейкоциты', 'WBC')]));
  assert.match(o.detail, / и ещё 5$/);
});
