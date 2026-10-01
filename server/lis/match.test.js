// match.test.js — какая строка прибора кладётся в какую строку бланка, и когда
// проба лежит в лотке (LIS_MINDRAY_CODES_V1). Чистые функции: ни базы, ни времени.
import test from 'node:test';
import assert from 'node:assert/strict';
import { planObservations, outcome } from './match.js';
import { planSeries, seriesOutcome, SERIES_WINDOW_MS } from './match.js';   // LIS_REAL_ANALYZERS_V1_SERIES

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

test('две строки прибора на одну строку бланка — пишется совпавшая по коду, вторая — «повтор», проба в лотке', () => {
  // Ревью R6: какое из двух чисел верное, решает человек, а не порядок строк.
  // Записанное значение прежнее — совпадение по коду бьёт совпадение по имени.
  const p = planObservations([obs('12345^WBC^99MRC', '1.0'), obs('WBC^^99MRC', '2.0')], [line(1, 'Лейкоциты', 'WBC')]);
  assert.equal(p.fills.length, 1);
  assert.equal(p.fills[0].obs.value, '2.0');
  assert.deepEqual(p.repeats.map((o) => o.codeRaw), ['12345^WBC^99MRC']);
  assert.deepEqual(p.unused, [], 'спорная строка — не «лишняя»');
  const o = outcome(p);
  assert.equal(o.status, 'unmapped');
  assert.equal(o.detail, 'повтор: 12345^WBC^99MRC');
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

// ── Ревью 2026-09-28 ────────────────────────────────────────────────────────

test('R2: две подтверждённые строки с одним кодом — вторая названа «не пришла», проба в лотке', () => {
  // Прибор шлёт WBC один раз: второй строке значение не достанется никогда.
  // Раньше её не было и в «не пришли» — проба считалась принятой при пустой строке.
  const lines = [line(1, 'Лейкоциты', 'WBC'), line(2, 'Лейкоциты (абс.)', ' wbc '), line(3, 'Гемоглобин', 'HGB')];
  const p = planObservations([obs('WBC^^99MRC', '6.1'), obs('HGB^^99MRC', '142')], lines);
  assert.deepEqual(p.fills.map((f) => f.analyte.id), [1, 3], 'значение ложится в первую строку бланка');
  assert.deepEqual(p.missing.map((m) => m.analyte.id + ':' + m.reason), ['2:код уже у строки «Лейкоциты»']);
  const o = outcome(p);
  assert.equal(o.status, 'unmapped');
  assert.equal(o.detail, 'не пришли: Лейкоциты (абс.) (wbc, код уже у строки «Лейкоциты»)');
});

test('R5: строка прибора совпала с неподтверждённой строкой — в лоток, даже если её уже взяла подтверждённая', () => {
  // Правило 3 спецификации: человек положил код «6690-2» в бланк и не
  // подтвердил — посмотреть обязан человек. Раньше проверялись только
  // неиспользованные строки, и взятая по имени «6690-2^WBC^LN» проходила молча.
  const p = planObservations([obs('6690-2^WBC^LN', '9.81'), obs('08001^Take Mode^99MRC', 'O')],
    [line(1, 'Лейкоциты', 'WBC'), line(2, 'Лейкоциты (LOINC)', '6690-2', 0)]);
  assert.equal(p.fills.length, 1, 'подтверждённая строка своё значение получила');
  assert.deepEqual(p.unconfirmed.map((o) => o.codeRaw), ['6690-2^WBC^LN']);
  assert.deepEqual(p.unused.map((o) => o.codeRaw), ['08001^Take Mode^99MRC'], 'совпавшая строка в «не использованы» не попадает');
  const o = outcome(p);
  assert.equal(o.status, 'unmapped');
  assert.equal(o.detail, 'не подтверждено: 6690-2^WBC^LN; не использованы: 08001^Take Mode^99MRC');
});

test('R6: два окончательных значения одного кода — пишется первое, второе — «повтор», проба в лотке', () => {
  const p = planObservations([obs('WBC^^99MRC', '1.0'), obs('WBC^^99MRC', '2.0')], [line(1, 'Лейкоциты', 'WBC')]);
  assert.deepEqual(p.fills.map((f) => f.obs.value), ['1.0']);
  assert.deepEqual(p.repeats.map((o) => o.value), ['2.0']);
  assert.equal(outcome(p).status, 'unmapped');
  assert.equal(outcome(p).detail, 'повтор: WBC^^99MRC');
});

test('R6: предварительное, пустое и «не получено» — не спор; P, потом F — законно', () => {
  const lines = [line(1, 'Лейкоциты', 'WBC')];
  const pf = planObservations([obs('WBC^^99MRC', '5.9', 'P'), obs('WBC^^99MRC', '6.1')], lines);
  assert.deepEqual(pf.fills.map((f) => f.obs.value), ['6.1']);
  assert.deepEqual(pf.repeats, []);
  assert.equal(outcome(pf).status, 'applied');

  for (const second of [obs('WBC^^99MRC', '5.9', 'P'), obs('WBC^^99MRC', '', 'F'), obs('WBC^^99MRC', '', 'X')]) {
    const p = planObservations([obs('WBC^^99MRC', '6.1'), second], lines);
    assert.deepEqual(p.fills.map((f) => f.obs.value), ['6.1']);
    assert.deepEqual(p.repeats, [], 'статус ' + second.status + ', значение «' + second.value + '» — не спор');
    assert.equal(outcome(p).status, 'applied');
  }
});

test('R11: числовая строка без единой цифры («***», «----», «ERR») — не значение: не пишется, строка «не пришла»', () => {
  // Прибор так пишет «не смог посчитать». Записать это в бланк значило бы
  // стереть черновик лаборанта и выдать пустую цифру за результат.
  for (const v of ['***', '----', 'ERR']) {
    const p = planObservations([obs('WBC^^99MRC', v)], [line(1, 'Лейкоциты', 'WBC')]);
    assert.equal(p.fills.length, 0, v + ' не пишется');
    // LIS_DISCOVERY_FIX_V1 — одни звёздочки теперь «нет значения» у любой
    // строки (тест ниже); «нет числа» — прочим числовым строкам без цифр.
    assert.deepEqual(p.missing.map((m) => m.reason), [(v === '***' ? 'нет значения: ' : 'нет числа: ') + v]);
    assert.equal(outcome(p).status, 'unmapped');
  }
  assert.equal(outcome(planObservations([obs('WBC^^99MRC', '***')], [line(1, 'Лейкоциты', 'WBC')])).detail,
    'не пришли: Лейкоциты (WBC, нет значения: ***)');
  assert.equal(outcome(planObservations([obs('WBC^^99MRC', '----')], [line(1, 'Лейкоциты', 'WBC')])).detail,
    'не пришли: Лейкоциты (WBC, нет числа: ----)');
});

test('R11: значение с цифрой («<0.01», «>1000», «*6.1») пишется как прежде и строку заполняет', () => {
  for (const v of ['<0.01', '>1000', '*6.1']) {
    const p = planObservations([obs('WBC^^99MRC', v)], [line(1, 'Лейкоциты', 'WBC')]);
    assert.deepEqual(p.fills.map((f) => f.obs.value), [v]);
    assert.equal(outcome(p).status, 'applied', v);
  }
  // Текстовая строка (не NM) цифр не обязана иметь: «Positive» — значение.
  const st = planObservations([{ ...obs('HBSAG^^99MRC', 'Positive'), valueType: 'ST' }], [line(1, 'HBsAg', 'HBSAG')]);
  assert.equal(st.fills.length, 1);
});

test('R7: строка прибора с пустым OBX-3 в списках — «(без кода)», а не пустое место', () => {
  const o = outcome(planObservations([obs('WBC^^99MRC', '6.1'), obs('', 'O'), obs('08001^Take Mode^99MRC')],
    [line(1, 'Лейкоциты', 'WBC')]));
  assert.equal(o.status, 'applied');
  assert.equal(o.detail, 'не использованы: (без кода), 08001^Take Mode^99MRC');
});

test('R11: «***» рядом с числом — не спор ни до, ни после', () => {
  const lines = [line(1, 'Лейкоциты', 'WBC')];
  for (const pair of [['6.1', '***'], ['***', '6.1']]) {
    const p = planObservations(pair.map((v) => obs('WBC^^99MRC', v)), lines);
    assert.deepEqual(p.fills.map((f) => f.obs.value), ['6.1'], pair.join(' → '));
    assert.deepEqual(p.repeats, []);
    assert.equal(outcome(p).status, 'applied');
  }
});

// ── LIS_DISCOVERY_FIX_V1 (ревью 2026-09-29) — одни звёздочки не значение ни у
// какой строки. R11 ловил только числовые (NM) строки без цифр, а «не смог
// посчитать» прибор пишет звёздочками и в текстовых строках (ST): «***»
// ложилось в бланк, стирало черновик лаборанта и выглядело результатом.
const as = (type, codeRaw, value, status) => ({ ...obs(codeRaw, value, status), valueType: type });

test('одни звёздочки — не значение у любого типа строки: не пишется, строка «не пришла»', () => {
  for (const type of ['ST', 'NM', 'TX', 'IS', 'CE', '']) {
    for (const v of ['*', '***', '*****', ' *** ']) {
      const p = planObservations([as(type, 'HBSAG^^99MRC', v)], [line(1, 'HBsAg', 'HBSAG')]);
      assert.equal(p.fills.length, 0, type + ' «' + v + '» не пишется');
      assert.deepEqual(p.missing.map((m) => m.reason), ['нет значения: ' + v.trim()], type + ' «' + v + '»');
      assert.equal(outcome(p).status, 'unmapped');
    }
  }
  assert.equal(outcome(planObservations([as('ST', 'HBSAG^^99MRC', '***')], [line(1, 'HBsAg', 'HBSAG')])).detail,
    'не пришли: HBsAg (HBSAG, нет значения: ***)');
});

test('звёздочка рядом с текстом — значение, как прежде; звёздочки до или после значения — не спор', () => {
  for (const v of ['*6.1', 'Positive*', '* см. примечание']) {
    const p = planObservations([as('ST', 'HBSAG^^99MRC', v)], [line(1, 'HBsAg', 'HBSAG')]);
    assert.deepEqual(p.fills.map((f) => f.obs.value), [v]);
    assert.equal(outcome(p).status, 'applied', v);
  }
  const lines = [line(1, 'HBsAg', 'HBSAG')];
  for (const pair of [['Positive', '***'], ['***', 'Positive']]) {
    const p = planObservations(pair.map((v) => as('ST', 'HBSAG^^99MRC', v)), lines);
    assert.deepEqual(p.fills.map((f) => f.obs.value), ['Positive'], pair.join(' → '));
    assert.deepEqual(p.repeats, [], 'звёздочки — не второе значение');
    assert.equal(outcome(p).status, 'applied');
  }
});

// ── LIS_REAL_ANALYZERS_V1_SERIES — по одному тесту в сообщении ──────────────
// BS-200 шлёт тест в сообщении (руководство, с. 5); по правилу одного
// сообщения каждое было бы «подтверждённая строка не пришла», и все легли бы в
// лоток, хотя бланк в итоге полон. Бланк судится по серии: сообщения одного
// заказа с того же прибора (той же модели) за SERIES_WINDOW_MS.
// Провод BS-200: код — номер теста (OBX-3), подпись — имя (OBX-4).
const bs = (n, label, value = '1', status = 'F') => ({ code: n, name: '', system: '', codeRaw: n, label, value, status, valueType: 'NM', unit: '', range: '', abnormal: '' });
const BS_LINES = [line(1, 'Глюкоза', '2'), line(2, 'Мочевина', '3'), line(3, 'Креатинин', '4')];

test('окно серии — 60 минут (решение владельца 2026-10-01, вопрос 4)', () => {
  assert.equal(SERIES_WINDOW_MS, 60 * 60 * 1000);
});

test('серия: три сообщения по строке — после 1-го и 2-го «ждём остальные», после 3-го — принята', () => {
  const m1 = [bs('2', 'GLU', '5.1')];
  const m2 = [bs('3', 'UREA', '4.2')];
  const m3 = [bs('4', 'CREA', '80')];

  const s1 = planSeries([m1], BS_LINES);
  assert.equal(s1.count, 1);
  assert.deepEqual(s1.missing.map((m) => m.analyte.name), ['Мочевина', 'Креатинин']);
  assert.deepEqual(seriesOutcome(s1), { status: 'unmapped', pending: true, detail: 'не пришли: Мочевина (3), Креатинин (4)' });

  const s2 = planSeries([m1, m2], BS_LINES);
  assert.deepEqual(seriesOutcome(s2), { status: 'unmapped', pending: true, detail: 'не пришли: Креатинин (4)' });

  const s3 = planSeries([m1, m2, m3], BS_LINES);
  assert.equal(s3.count, 3);
  assert.deepEqual(s3.filled.map((a) => a.name), ['Глюкоза', 'Мочевина', 'Креатинин']);
  assert.deepEqual(seriesOutcome(s3), { status: 'applied', pending: false, detail: 'серия из 3 сообщений принята' });
});

test('серия: «не использованы» — только самого последнего сообщения', () => {
  const s = planSeries([[bs('2', 'GLU', '5.1'), bs('102', 'calctest1')], [bs('3', 'UREA', '4.2')], [bs('4', 'CREA', '80'), bs('103', 'calctest2')]], BS_LINES);
  assert.deepEqual(seriesOutcome(s), { status: 'applied', pending: false, detail: 'серия из 3 сообщений принята; не использованы: 103 (calctest2)' });
});

test('серия: всё в одном сообщении (руководство, с. 23) — принято сразу, как правило одного сообщения', () => {
  const one = [bs('2', 'GLU', '5.1'), bs('3', 'UREA', '4.2'), bs('4', 'CREA', '80')];
  const s = planSeries([one], BS_LINES);
  assert.deepEqual(seriesOutcome(s), { status: 'applied', pending: false, detail: '' });
  assert.deepEqual(seriesOutcome(s), { ...outcome(planObservations(one, BS_LINES)), pending: false });
});

test('серия: повторный прогон с другим значением — «повтор: было …, в бланке …», в лотке без «ждём»', () => {
  const s = planSeries([[bs('2', 'GLU', '5.1')], [bs('3', 'UREA', '4.2')], [bs('4', 'CREA', '80')], [bs('2', 'GLU', '5.4')]], BS_LINES);
  assert.deepEqual(s.changed.map((c) => [c.analyte.name, c.was, c.now]), [['Глюкоза', ['5.1'], '5.4']]);
  assert.deepEqual(seriesOutcome(s), { status: 'unmapped', pending: false, detail: 'повтор: 2 (GLU): было 5.1, в бланке 5.4' });
});

test('серия: то же значение ещё раз — повторная передача, не спор; серия чистая', () => {
  const s = planSeries([[bs('2', 'GLU', '5.1')], [bs('3', 'UREA', '4.2')], [bs('2', 'GLU', '5.1')], [bs('4', 'CREA', '80')]], BS_LINES);
  assert.deepEqual(s.changed, []);
  assert.deepEqual(s.resent.map((r) => r.analyte.name), ['Глюкоза']);
  assert.deepEqual(seriesOutcome(s), { status: 'applied', pending: false, detail: 'серия из 4 сообщений принята; повторная передача: 2 (GLU)' });
});

test('серия: неподтверждённый код во 2-м сообщении — серия не чистая и после последнего', () => {
  const lines = [...BS_LINES, line(4, 'Белок', '9', 0)];
  const s2 = planSeries([[bs('2', 'GLU', '5.1')], [bs('3', 'UREA', '4.2'), bs('9', 'TP', '70')]], lines);
  assert.deepEqual(seriesOutcome(s2), { status: 'unmapped', pending: false, detail: 'не пришли: Креатинин (4); не подтверждено: 9 (TP)' });
  const s3 = planSeries([[bs('2', 'GLU', '5.1')], [bs('3', 'UREA', '4.2'), bs('9', 'TP', '70')], [bs('4', 'CREA', '80')]], lines);
  assert.deepEqual(seriesOutcome(s3), { status: 'unmapped', pending: false, detail: 'не подтверждено: 9 (TP)' });
});

test('серия: причина «не пришла» — из сообщения, где она была (статус P)', () => {
  const s = planSeries([[bs('2', 'GLU', '5.1')], [bs('3', 'UREA', '4.2', 'P')]], BS_LINES);
  assert.deepEqual(s.missing.map((m) => m.analyte.name + ':' + m.reason), ['Мочевина:статус P', 'Креатинин:']);
  assert.equal(seriesOutcome(s).pending, true, 'причина «не пришли» — всё ещё ожидание');
});

test('серия: строка, которую серия «заполнила», но в бланке её нет, — «не пришла» (written)', () => {
  // Значение пришло, когда код строки ещё не был подтверждён, и в бланк не
  // легло; потом человек подтвердил код. Пересчёт по сырому сказал бы
  // «заполнено» — бланк говорит иное, и верить надо бланку.
  const s = planSeries([[bs('2', 'GLU', '5.1')], [bs('3', 'UREA', '4.2')], [bs('4', 'CREA', '80')]], BS_LINES,
    { written: new Set(['Мочевина', 'Креатинин']) });
  assert.deepEqual(s.missing.map((m) => m.analyte.name + ':' + m.reason), ['Глюкоза:в бланк не записано']);
  assert.equal(seriesOutcome(s).status, 'unmapped');
});

test('серия: «серия из N» — по-русски: 2–4, 5–20, 21', () => {
  const run = (n) => {
    const msgs = Array.from({ length: n }, () => [bs('2', 'GLU', '5.1')]);
    return seriesOutcome(planSeries(msgs, [line(1, 'Глюкоза', '2')])).detail;
  };
  assert.match(run(2), /^серия из 2 сообщений принята/);
  assert.match(run(5), /^серия из 5 сообщений принята/);
  assert.match(run(21), /^серия из 21 сообщения принята/);
});

test('журнал показывает подпись прибора рядом с кодом; у прежнего провода подписи нет — как раньше', () => {
  const p = planObservations([bs('2', 'GLU', '5.1'), bs('102', 'calctest1')], [line(1, 'Глюкоза', '2'), line(2, 'Мочевина', '3')]);
  assert.equal(outcome(p).detail, 'не пришли: Мочевина (3); не использованы: 102 (calctest1)');
  assert.equal(outcome(planObservations([obs('ALT^^99MRC')], [])).detail, 'не использованы: ALT^^99MRC');
});
