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

// LIS_DISCOVERY_FIX_V1 (ревью 2026-09-29) — одни звёздочки («*», «***») — не
// значение НИ У КАКОЙ строки, как пустое. R11 ловил только числовые (NM), а
// «не смог посчитать» прибор пишет звёздочками и в текстовых строках (ST):
// «***» ложилось в бланк, стирало черновик лаборанта и выглядело результатом.
// Звёздочка рядом с текстом («*6.1», «Positive*») — по-прежнему значение.
const onlyStars = (value) => /^\*+$/.test(value);

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
 *                  reason: '' | 'статус P' | 'пустое значение' | 'нет значения: ***' | 'нет числа: ----' | 'код уже у строки «…»';
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
        // «не использована». Одни звёздочки (LIS_DISCOVERY_FIX_V1) — тоже.
        if (status === 'F' && value && !onlyStars(value) && !noNumber(obs, value)) { used.add(i); repeats.push(obs); }
        return;
      }
      used.add(i);
      // Предварительный (P) и неполученный (X) в бланк не идут: лаборант
      // подтвердил бы число, которое прибор ещё сам не считает окончательным.
      if (status !== 'F') { if (!why.has(a)) why.set(a, 'статус ' + status); return; }
      // Пустое значение — не значение: оно не стирает набранное руками.
      if (!value) { if (!why.has(a)) why.set(a, 'пустое значение'); return; }
      // LIS_DISCOVERY_FIX_V1 — звёздочки раньше «нет числа»: у любой строки
      // одна и та же причина, в том числе у числовой.
      if (onlyStars(value)) { if (!why.has(a)) why.set(a, 'нет значения: ' + value); return; }
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
// Строка прибора в журнале — целиком, как пришла («6690-2^WBC^LN»). Пустой
// OBX-3 (ревью R7) назван словами: пустое место между запятыми человек
// прочитать не может, а сырое сообщение всё равно лежит целиком.
// LIS_REAL_ANALYZERS_V1_SERIES — и подпись прибора рядом, если провод её даёт
// (wire.js label: BS-200 — имя теста из OBX-4, Autobio — имя позиции,
// переадресатор — OBX-4): «2 (GLU)», а не голый номер теста. Только показ; у
// прежних проводов подписи нет, и журнал прежний.
const label = (o) => (o.codeRaw || o.code || '(без кода)') + (o.label ? ' (' + o.label + ')' : '');
const missingText = (missing) => 'не пришли: ' + list(missing.map(({ analyte: a, reason }) =>
  a.name + ' (' + String(a.device_code).trim() + (reason ? ', ' + reason : '') + ')'));

/**
 * Статус сообщения и строка журнала.
 * @returns {{status:'applied'|'unmapped', detail:string}}
 */
export function outcome(plan) {
  const done = plan.fills.length > 0 && !plan.missing.length && !plan.unconfirmed.length && !plan.repeats.length;
  const parts = [];
  if (plan.missing.length) parts.push(missingText(plan.missing));
  if (plan.unconfirmed.length) parts.push('не подтверждено: ' + list(plan.unconfirmed.map(label)));
  if (plan.repeats.length) parts.push('повтор: ' + list(plan.repeats.map(label)));
  if (plan.unused.length) parts.push('не использованы: ' + list(plan.unused.map(label)));
  if (!plan.fills.length && !parts.length) parts.push('в сообщении нет результатов');
  return { status: done ? 'applied' : 'unmapped', detail: parts.join('; ') };
}

// ── LIS_REAL_ANALYZERS_V1_SERIES — по одному тесту в сообщении ──────────────
// (docs/specs/2026-10-01-lis-real-analyzers-design.md, раздел 3)
//
// BS-200 шлёт тест в сообщении (руководство, с. 5: «each ORU^R01 message
// transmits one test»), A1000 — в режиме «по тесту». По правилу одного
// сообщения каждое было бы «подтверждённая строка не пришла», и все легли бы в
// лоток, хотя бланк в итоге полон. Правило владельца (2026-09-28) то же —
// «когда бланк заполнен», — но для такого прибора бланк судится по СЕРИИ.
//
// Серия заказа — сообщения прибора той же модели по одному заказу за
// SERIES_WINDOW_MS, в которых легло хотя бы одно значение. Она пересчитывается
// из сырых сообщений (инвариант 2): ни новых колонок, ни состояния в памяти,
// которое потерялось бы при перезапуске. D4 не меняется: серия решает, когда
// бланк заполнен, а не что применять.

/** Окно серии — 60 минут (решение владельца 2026-10-01, вопрос 4). */
export const SERIES_WINDOW_MS = 60 * 60 * 1000;

/**
 * Причина «не пришла» у строки, которую серия по пересчёту заполнила, но в
 * бланке её нет. Журнал лотка, как и прочие причины planObservations: читается
 * как есть, через словарь не идёт.
 */
const NOT_IN_BLANK = 'в бланк не записано';

/** Значение для сравнения двух прогонов: «5.1» и « 5.1» — одно и то же. */
const valueKey = (v) => String(v == null ? '' : v).trim();

/**
 * Общий план серии. Чистая функция: сообщения серии по порядку прихода
 * (последнее — текущее) и строки бланка в порядке бланка.
 *
 * @param {Array<object[]>} messages  строки прибора каждого сообщения серии
 * @param {object[]} analytes          строки бланка, как у planObservations
 * @param {{written?: Set<string>}} [opts]
 *   written — имена строк бланка, где сейчас лежит значение прибора. Строка,
 *   которую серия по пересчёту «заполнила», но которой в бланке нет (значение
 *   пришло, когда код ещё не был подтверждён, и по D4 не легло), — «не пришла»:
 *   серия верит бланку, а не пересчёту.
 * @returns {{
 *   count: number,
 *   filled: object[],
 *   missing: Array<{analyte:object, reason:string}>,
 *   unconfirmed: object[],
 *   repeats: object[],
 *   changed: Array<{obs:object, analyte:object, was:string[], now:string}>,
 *   resent: Array<{obs:object, analyte:object}>,
 *   unused: object[],
 * }}
 *   filled      — подтверждённые строки бланка, получившие значение хоть в одном сообщении;
 *   missing     — подтверждённые строки, не заполненные никем, с причинами, как у planObservations;
 *   unconfirmed — все попадания в неподтверждённые строки по всей серии (правило 3, R5);
 *   repeats     — второе значение одной строки ВНУТРИ сообщения (R6);
 *   changed     — повтор между сообщениями: более позднее окончательное значение
 *                 уже заполненной строки, и оно ДРУГОЕ («5.1», потом «5.4») —
 *                 повторный прогон или разведение, какое число верное, решает
 *                 человек (R6); в бланке — последнее (D6);
 *   resent      — то же значение по той же строке ещё раз: прибор не получил ACK
 *                 и прислал снова. Не спор — справка;
 *   unused      — «не использованы» ПОСЛЕДНЕГО сообщения.
 */
export function planSeries(messages = [], analytes = [], opts = {}) {
  const plans = messages.map((obs) => planObservations(obs, analytes));
  const values = new Map();         // строка бланка → [{ obs, value }] по порядку прихода
  const reasons = new Map();        // строка бланка → последняя непустая причина «не пришла»
  const unconfirmed = [];
  const repeats = [];
  for (const p of plans) {
    for (const { obs, analyte } of p.fills) {
      if (!values.has(analyte)) values.set(analyte, []);
      values.get(analyte).push({ obs, value: valueKey(obs.value) });
    }
    for (const { analyte, reason } of p.missing) if (reason) reasons.set(analyte, reason);
    unconfirmed.push(...p.unconfirmed);
    repeats.push(...p.repeats);
  }

  const written = opts.written instanceof Set ? opts.written : null;
  const filled = [];
  const missing = [];
  const changed = [];
  const resent = [];
  for (const a of analytes) {
    if (!a.device_code_confirmed || !String(a.device_code == null ? '' : a.device_code).trim()) continue;
    const got = values.get(a);
    if (!got) {
      // Не заполнена ни одним сообщением — с причиной из того сообщения, где
      // она была (статус P, пустое, «нет числа», код у другой строки).
      missing.push({ analyte: a, reason: reasons.get(a) || '' });
      continue;
    }
    if (written && !written.has(a.name)) { missing.push({ analyte: a, reason: NOT_IN_BLANK }); continue; }
    filled.push(a);
    if (got.length < 2) continue;
    const now = got[got.length - 1];
    const was = [...new Set(got.slice(0, -1).map((g) => g.value))].filter((v) => v !== now.value);
    if (was.length) changed.push({ obs: now.obs, analyte: a, was, now: now.value });
    else resent.push({ obs: now.obs, analyte: a });
  }

  return {
    count: messages.length,
    filled,
    missing,
    unconfirmed,
    repeats,
    changed,
    resent,
    unused: plans.length ? plans[plans.length - 1].unused : [],
  };
}

const messagesWord = (n) => (n % 10 === 1 && n % 100 !== 11 ? 'сообщения' : 'сообщений');

/**
 * Статус ТЕКУЩЕГО сообщения серии и строка журнала (раздел 3, пп. 4–6).
 *   — серия чистая (не пришли = 0, не подтверждено = 0, повтор = 0): applied,
 *     «серия из N сообщений принята» (у серии из одного сообщения — ровно
 *     outcome одного сообщения: всё пришло одним сообщением, с. 23);
 *   — единственная беда — «не пришли»: unmapped, pending — серия ещё идёт
 *     (ingest.js ставит в начало SERIES_PENDING_PREFIX);
 *   — иначе (не подтверждено, повтор): unmapped без отметки «ждём» — обычная
 *     строка лотка.
 * Повторная передача и «не использованы» последнего сообщения — справка.
 * @returns {{status:'applied'|'unmapped', detail:string, pending:boolean}}
 */
export function seriesOutcome(s) {
  const disputed = s.unconfirmed.length > 0 || s.repeats.length > 0 || s.changed.length > 0;
  const clean = !disputed && !s.missing.length && s.filled.length > 0;
  const parts = [];
  if (clean && s.count > 1) parts.push('серия из ' + s.count + ' ' + messagesWord(s.count) + ' принята');
  if (s.missing.length) parts.push(missingText(s.missing));
  if (s.unconfirmed.length) parts.push('не подтверждено: ' + list(s.unconfirmed.map(label)));
  const disputes = [
    ...s.repeats.map(label),
    ...s.changed.map((c) => label(c.obs) + ': было ' + c.was.join(', ') + ', в бланке ' + c.now),
  ];
  if (disputes.length) parts.push('повтор: ' + list(disputes));
  if (s.resent.length) parts.push('повторная передача: ' + list(s.resent.map((r) => label(r.obs))));
  if (s.unused.length) parts.push('не использованы: ' + list(s.unused.map(label)));
  return { status: clean ? 'applied' : 'unmapped', detail: parts.join('; '), pending: !disputed && s.missing.length > 0 };
}
