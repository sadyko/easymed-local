// LIS_VENDOR_EXACT_V1 — печатный бланк: флаг H/L у значения за пределом
// измерения прибора («>1000», «<0.50»).
//
// AutoLumo A1000 за пределом измерения шлёт сам предел и флаг в NTE-3: ORH
// («выше верхнего предела»), OVR — как ORH, ORL («ниже нижнего»). Приём пишет
// «>предел» с флагом «Выше» и «<предел» с флагом «Ниже» (решение владельца
// 2026-10-06, п. 5; wire.js, ingest.js). Бланк ставит флаг только числу
// (LAB_FLAG_NUMERIC_ONLY_V1), и «>1000» числом не считался: AFP выше предела
// измерения печатался с пустой графой «Флаг» — тише, чем AFP 12 при норме 0–10
// (C1-RESULT, «Remaining risks»; ревью B, п. 9).
//
// Кадры — дословно из приёмки (acceptance\runs\autobio-autolumo-a1000,
// result.json T9b: кодировщик программы клиники AutoLumo1000 1.0.7, режим
// «Enable to send test results by string»), значения синтетические.
import test from 'node:test';
import assert from 'node:assert/strict';
import { labFlagCell, labFlagFor } from '../views/lab-doc.js';
import { readResult, wireFor } from '../../../../server/lis/wire.js';
import { getProfile } from '../../../../server/lis/profiles/index.js';
import { resultFlag } from '../../../../server/lis/ingest.js';

const frame = (obr, nte, obx) => ['MSH|^~\\&|||||20261006130515||ORU^R01|5|P|2.3.1|261006130515450', 'PID|||TEST-0001', obr, nte, obx].join('\r');
const A1000 = {
  // Строковый режим: «>1000.00» + ORH, «<0.50» + ORL.
  overString: frame('OBR|1|LAB-000108|7710|AutoLumo A1000', 'NTE|||LOT-SYN~ORH~AFP~107~~RACK-SYN~1',
    'OBX|10465|CE|107|107|9876543^>1000.00~||||||F|||2026/10/06 13:05:15'),
  underString: frame('OBR|1|LAB-000109|7711|AutoLumo A1000', 'NTE|||LOT-SYN~ORL~AFP~107~~RACK-SYN~1',
    'OBX|10466|CE|107|107|1200^<0.50~||||||F|||2026/10/06 13:05:15'),
  // Обычный режим: прибор шлёт сам предел простым числом + ORH.
  overPlain: frame('OBR|1|LAB-000102|7702|AutoLumo A1000', 'NTE|||LOT-SYN~ORH~AFP~107~~RACK-SYN~1',
    'OBX|10457|CE|107|107|9876543^1000~||||||F|||2026/10/06 13:05:15'),
  // OVR — «выше старшего калибратора»: как ORH.
  overCalibrator: frame('OBR|1|LAB-000103|7703|AutoLumo A1000', 'NTE|||LOT-SYN~OVR~AFP~107~~RACK-SYN~1',
    'OBX|10458|CE|107|107|9876543^1000~||||||F|||2026/10/06 13:05:15'),
};

/** Строка бланка так, как её пишет приём: значение провода и флаг (диапазон клиники 0–10). */
function blankRow(raw) {
  const profile = getProfile('autobio-autolumo-a1000');
  const [o] = readResult(raw, wireFor({ profile, facility: '', app: '' })).observations;
  const flag = resultFlag({ num: null, refLow: 0, refHigh: 10, abnormal: o.abnormal, deviceRange: o.range, qualitative: o.qualitative }) || 'normal';
  return { value: o.value, flag, numeric_value: null, ref_low: 0, ref_high: 10 };
}

test('A1000 за пределом измерения: «>1000.00» печатается с H, «<0.50» — с L (кадры кодировщика прибора)', () => {
  const over = blankRow(A1000.overString);
  assert.deepEqual([over.value, over.flag], ['>1000.00', 'high'], 'приём: «>предел» и «Выше»');
  assert.equal(labFlagCell(over), 'H');
  const under = blankRow(A1000.underString);
  assert.deepEqual([under.value, under.flag], ['<0.50', 'low'], 'приём: «<предел» и «Ниже»');
  assert.equal(labFlagCell(under), 'L');
});

test('A1000 в обычном режиме: предел числом + ORH или OVR — «>1000» и H на бланке', () => {
  for (const raw of [A1000.overPlain, A1000.overCalibrator]) {
    const row = blankRow(raw);
    assert.deepEqual([row.value, row.flag], ['>1000', 'high']);
    assert.equal(labFlagCell(row), 'H');
  }
});

test('«>x» и «<x» — как число: тот же флаг, что даёт labFlagFor; пробел после знака и запятая допустимы', () => {
  const cases = [
    [{ value: '>1000', flag: 'high' }, 'H'],
    [{ value: '> 1000', flag: 'high' }, 'H'],
    [{ value: '<0,5', flag: 'low' }, 'L'],
    [{ value: '  <0.01', flag: 'normal' }, 'N'],   // «<0.01» при норме «ниже 0.01» — норма, как у числа
    [{ value: '>500', flag: 'critical', numeric_value: null }, 'H'],
  ];
  for (const [x, want] of cases) {
    assert.equal(labFlagCell(x), want, JSON.stringify(x));
    assert.equal(labFlagCell(x), labFlagFor(x), 'то же правило, что у числа: ' + JSON.stringify(x));
  }
});

test('текст со знаком, но без числа, флага по-прежнему не получает', () => {
  for (const v of ['>', '<', '> нормы', '<<', '>=5', '≥5', 'больше 1000', '+', '-', '+-']) {
    assert.equal(labFlagCell({ value: v, flag: 'high' }), '', JSON.stringify(v));
  }
});
