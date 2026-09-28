// LIS_MINDRAY_CODES_V1 — какая строка прибора ложится в какую строку бланка и
// когда проба лежит в лотке. Чистое правило: ни базы, ни записи. ingest.js
// спрашивает его и пишет то, что оно решило, — проверять надо правило, а не SQL.
//
// Mindray пишет OBX-3 как «6690-2^WBC^LN», переадресатор с лабораторного ПК —
// как «WBC^^99MRC». Подтверждённый device_code совпадает с компонентом 1 ИЛИ 2,
// без учёта регистра. Два прохода: сначала по коду, потом по имени, и только в
// строки бланка, которые ещё свободны. Поэтому совпадение по коду бьёт
// совпадение по имени, где бы ни стояли строки в сообщении; внутри одного
// прохода пишется первая по порядку сообщения. Сам спор исходом не прячется
// (ревью R6): второе окончательное значение для уже заполненной строки бланка
// названо «повтор», и проба лежит в лотке — какое из двух чисел верное, решает
// человек, а не порядок строк.
//
// D4 не меняется: неподтверждённое сопоставление не применяется никогда. Но
// значение, пришедшее для неподтверждённой строки, названо отдельно: человек
// положил этот код в бланк, и посмотреть на него должен человек.
//
// Лоток (решение владельца 2026-09-28): проба принята, когда заполнена каждая
// ПОДТВЕРЖДЁННАЯ строка бланка. Лишние строки прибора (режимы пробы,
// референсная группа, гистограммы) — справка в журнале, а не повод для клика.

const key = (s) => String(s == null ? '' : s).trim().toUpperCase();

// Ревью R11: числовая строка (NM) без единой цифры — «***», «----», «ERR» — так
// прибор пишет «не смог посчитать». Это не значение: в бланк не идёт (иначе
// стёрла бы черновик лаборанта и легла бы пустышкой под видом результата), а
// строка бланка «не пришла» с причиной. Значение с цифрой — «<0.01», «>1000»,
// «*6.1» — пишется как было: у него есть смысл, и его читает человек.
const noNumber = (obs, value) => key(obs.valueType) === 'NM' && !/\d/.test(value);

/**
 * @param {Array<{code:string,name:string,codeRaw:string,value:string,status:string}>} observations  строки прибора
 * @param {Array<{id:number,name:string,device_code:string,device_code_confirmed:number}>} analytes  строки бланка в порядке бланка
 * @returns {{
 *   fills: Array<{obs:object, analyte:object}>,
 *   missing: Array<{analyte:object, reason:string}>,
 *   unconfirmed: object[],
 *   repeats: object[],
 *   unused: object[],
 * }}
 *   fills        — что писать в бланк;
 *   missing      — ВСЕ подтверждённые строки бланка без значения, в порядке бланка;
 *                  reason: '' | 'статус P' | 'пустое значение' | 'нет числа: ***' | 'код уже у строки «…»';
 *   unconfirmed  — строки прибора, пришедшие для неподтверждённой строки бланка;
 *   repeats      — второе окончательное значение для уже заполненной строки бланка;
 *   unused       — строки прибора, которые ни к чему не относятся.
 */
export function planObservations(observations = [], analytes = []) {
  const confirmed = new Map();      // код → строка бланка (первая по порядку бланка)
  const expected = [];              // все подтверждённые строки бланка — каждая ждёт значения
  const unconfirmed = new Set();
  const why = new Map();            // строка бланка → почему значение не легло
  for (const a of analytes) {
    const k = key(a.device_code);
    if (!k) continue;
    if (!a.device_code_confirmed) { unconfirmed.add(k); continue; }
    expected.push(a);
    // Ревью R2: вторая подтверждённая строка с тем же кодом значения не получит
    // никогда — прибор шлёт его один раз, и оно ложится в первую. Раньше её не
    // было даже в «не пришли», и проба с пустой строкой считалась принятой.
    // Теперь она названа, и проба лежит в лотке: какую из двух строк кормит
    // этот код, решает человек (редактор панелей такое и сохранить не даёт).
    if (confirmed.has(k)) why.set(a, 'код уже у строки «' + confirmed.get(k).name + '»');
    else confirmed.set(k, a);
  }

  const filled = new Set();         // строки бланка, получившие значение
  const used = new Set();           // индексы строк прибора, уже отнесённых к строке бланка
  const fills = [];
  const repeats = [];               // второе значение для уже заполненной строки (ревью R6)

  for (const part of ['code', 'name']) {
    observations.forEach((obs, i) => {
      if (used.has(i)) return;
      const a = confirmed.get(key(obs[part]));
      if (!a) return;
      const status = key(obs.status) || 'F';
      const value = String(obs.value == null ? '' : obs.value).trim();
      if (filled.has(a)) {
        // Ревью R6: строка бланка уже получила значение, а пришло второе
        // окончательное. Записанным остаётся первое (проход по коду идёт
        // раньше прохода по имени), но спор — повод для лотка: молча выбрать
        // одно из двух чисел значило бы выдать пациенту, возможно, не то.
        // Предварительное (P), «не получено» (X), пустое и «без числа» (R11)
        // — не спор: «P, потом F» — законная пара, и такая строка остаётся
        // «не использована».
        if (status === 'F' && value && !noNumber(obs, value)) { used.add(i); repeats.push(obs); }
        return;
      }
      used.add(i);
      // Предварительный (P) и неполученный (X) в бланк не идут: лаборант
      // подтвердил бы число, которое прибор ещё сам не считает окончательным.
      if (status !== 'F') { if (!why.has(a)) why.set(a, 'статус ' + status); return; }
      // Пустое значение — не значение: оно не стирает набранное руками.
      if (!value) { if (!why.has(a)) why.set(a, 'пустое значение'); return; }
      if (noNumber(obs, value)) { if (!why.has(a)) why.set(a, 'нет числа: ' + value); return; }
      filled.add(a);
      fills.push({ obs, analyte: a });
    });
  }

  // Ревью R5 (правило 3 спецификации): совпадение с НЕподтверждённой строкой
  // бланка считается и тогда, когда строку прибора уже взяла подтверждённая.
  // «6690-2^WBC^LN» ложится в строку «WBC», но код «6690-2» человек положил в
  // другую строку и не подтвердил — посмотреть обязан человек. Раньше
  // проверялись только неиспользованные строки, и такая проба проходила молча.
  const unconfirmedHits = [];
  const unused = [];
  observations.forEach((obs, i) => {
    if (unconfirmed.has(key(obs.code)) || unconfirmed.has(key(obs.name))) unconfirmedHits.push(obs);
    else if (!used.has(i)) unused.push(obs);
  });

  const missing = expected
    .filter((a) => !filled.has(a))
    .map((a) => ({ analyte: a, reason: why.get(a) || '' }));

  return { fills, missing, unconfirmed: unconfirmedHits, repeats, unused };
}

// Журнал читает человек в лотке: полсотни кодов гистограмм и режимов в одной
// ячейке не читаются. Сырое сообщение хранится целиком (инвариант 2).
const LIST_CAP = 15;
const list = (items) => items.length > LIST_CAP
  ? items.slice(0, LIST_CAP).join(', ') + ' и ещё ' + (items.length - LIST_CAP)
  : items.join(', ');

/**
 * Статус сообщения и строка журнала.
 * @returns {{status:'applied'|'unmapped', detail:string}}
 */
export function outcome(plan) {
  const done = plan.fills.length > 0 && !plan.missing.length && !plan.unconfirmed.length && !plan.repeats.length;
  const parts = [];
  if (plan.missing.length) {
    parts.push('не пришли: ' + list(plan.missing.map(({ analyte: a, reason }) =>
      a.name + ' (' + String(a.device_code).trim() + (reason ? ', ' + reason : '') + ')')));
  }
  if (plan.unconfirmed.length) parts.push('не подтверждено: ' + list(plan.unconfirmed.map((o) => o.codeRaw || o.code)));
  if (plan.repeats.length) parts.push('повтор: ' + list(plan.repeats.map((o) => o.codeRaw || o.code)));
  if (plan.unused.length) parts.push('не использованы: ' + list(plan.unused.map((o) => o.codeRaw || o.code)));
  if (!plan.fills.length && !parts.length) parts.push('в сообщении нет результатов');
  return { status: done ? 'applied' : 'unmapped', detail: parts.join('; ') };
}
