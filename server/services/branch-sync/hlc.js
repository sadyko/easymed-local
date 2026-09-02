// BRANCH_RECORDS_V1 — гибридные логические часы.
//
// Метка: <миллисекунды в hex, 12 знаков>-<счётчик в hex, 4 знака>-<буква узла>.
// Ширина фиксирована, поэтому лексикографическое сравнение строк совпадает с
// хронологическим — журнал можно читать обычным ORDER BY, без разбора.
//
// Счётчик существует ради двух случаев, и оба реальны: несколько правок в одну
// миллисекунду и часы, переведённые назад. Во втором случае физическое время
// не растёт, и единственное, что удерживает порядок, — счётчик.
//
// Буква узла в хвосте: две машины, изменившие разные строки в одну и ту же
// миллисекунду, обязаны получить разные метки, иначе одна из правок исчезнет
// при слиянии.
//
// Гибридность — в третьем входе nextStamp: `received`. Без него узел знает
// только свои собственные часы, и филиал, чьи часы отстают на два часа,
// проигрывал бы слиянием даже те правки, что реально сделал позже. С ним
// метка растёт до max(свои часы, свой счётчик, чужая полученная метка) —
// приняв метку от другого узла, часы навсегда узнают о его скорости. Метка
// от чужого узла, не прошедшая isStamp, не игнорируется, а роняет вызов —
// молчание здесь спрятало бы ровно тот случай, о котором важнее всего знать.
//
// Формат строки — замороженный контракт на проводе: ширины полей менять
// нельзя. Метки уже лежат в журнале синхронизации; смена ширины развернула
// бы сравнение старых меток с новыми непредсказуемым образом.

const MS_HEX = 12;
const CNT_HEX = 4;
const MAX_CNT = 0xffff;
const MAX_MS = 0xffffffffffff; // 48 бит — год ~10889; ловит µs/ns часы, подставленные по ошибке
const NODE_RE = /^[A-Z]{1,8}$/; // та же граница, что LETTER_MAX_CHARS в letters.js
const STAMP_RE = /^[0-9a-f]{12}-[0-9a-f]{4}-[A-Z]{1,8}$/;

function requireNode(node) {
  const upper = String(node || '').toUpperCase();
  if (!NODE_RE.test(upper)) {
    // '?' в качестве заглушки молча склеил бы метки двух непарных машин —
    // ровно то столкновение, которого шапка файла обещает не допускать.
    throw new Error('hlc: node letter required, got ' + JSON.stringify(node));
  }
  return upper;
}

function coerceNumber(value) {
  const n = Number(value); // control_state хранит числа TEXT-ом — приводим до isFinite
  return Number.isFinite(n) ? n : 0;
}

/**
 * @param {{ms:number, cnt:number}|null} state предыдущее состояние часов
 * @param {string} node буква филиала
 * @param {() => number} [clock]
 * @param {string|null} [received] метка, полученная от другого узла при синхронизации
 * @returns {{stamp:string, ms:number, cnt:number}}
 */
export function nextStamp(state, node, clock = Date.now, received = null) {
  const nodeLetter = requireNode(node);
  if (received != null && !isStamp(received)) {
    // Молча проигнорировать мусор значило бы молчать именно там, где узнать
    // о неисправном источнике важнее всего — часы просто не выросли бы от
    // чужой метки, а вызывающий код не узнал бы почему.
    throw new Error('hlc: malformed received stamp: ' + JSON.stringify(received));
  }
  const wall = Math.max(0, Math.floor(clock()));
  const prevMs = state ? coerceNumber(state.ms) : 0;
  const prevCnt = state ? coerceNumber(state.cnt) : 0;
  const parsed = received ? parseStamp(received) : null;
  const floor = Math.max(prevMs, parsed ? parsed.ms : 0);

  let ms;
  let cnt;
  if (wall > floor) {
    ms = wall;
    cnt = 0;
  } else {
    // Часы (свои или чужие) не ушли вперёд — держим порядок счётчиком.
    // Оба источника могут стоять на одном и том же floor одновременно —
    // тогда берём МАКСИМУМ их счётчиков, а не первый совпавший, иначе узел
    // с меньшим локальным счётчиком молча проигрывал бы метку, которую
    // только что обогнал по факту получения.
    ms = floor;
    let base = -1;
    if (floor === prevMs) base = Math.max(base, prevCnt);
    if (parsed && floor === parsed.ms) base = Math.max(base, parsed.cnt);
    cnt = base + 1;
    if (cnt > MAX_CNT) { ms = floor + 1; cnt = 0; }
  }
  if (ms > MAX_MS) {
    throw new Error('hlc: ms exceeds the 48-bit wire format: ' + ms);
  }

  const stamp = ms.toString(16).padStart(MS_HEX, '0')
    + '-' + cnt.toString(16).padStart(CNT_HEX, '0')
    + '-' + nodeLetter;
  return { stamp, ms, cnt };
}

/**
 * МЕТКА ОТ ВРЕМЕНИ ПРАВКИ, БЕЗ ПОЛА ЧАСОВ (Задача 7d). Формат тот же, что у
 * nextStamp, и сравнивается тем же compareStamps — меняется ТОЛЬКО источник
 * миллисекунд: время самой правки, а не состояние часов узла.
 *
 * Зачем это отдельно от nextStamp. Часы HLC поднимаются до Date.now() на
 * КАЖДОМ приёме (см. writeClock в journal.js), поэтому nextStamp, даже вызванный
 * с настоящим временем правки, отдаёт ПОЛ — то есть время ОТПРАВКИ. Замерено:
 * до первого приёма правка двухчасовой давности получала честные «два часа
 * назад», после первого приёма — «сейчас». Пока метка решала только порядок
 * приёма, это ничему не мешало; как только по ней стали разбирать, чья правка
 * колонки новее, — она стала отвечать не на тот вопрос: побеждал не тот,
 * кто правил позже, а тот, кто позже вышел на связь.
 *
 * СЧЁТЧИК ВСЕГДА НОЛЬ, а тай-брейк — БУКВА УЗЛА. Две правки одной колонки в
 * одну миллисекунду на разных узлах дают метки, отличающиеся только буквой, и
 * побеждает большая — ОДИНАКОВО на обеих сторонах, потому что сравниваются одни
 * и те же две строки. Именно это и делает слияние сходящимся.
 *
 * ЦЕНА НАЗВАНА ВСЛУХ: это сравнение НАСТЕННЫХ часов двух зданий. Филиал с
 * часами, отставшими на час, будет проигрывать спор за одну и ту же колонку —
 * и это осознанный выбор спецификации (побеждает последняя ПРАВКА), а не
 * недосмотр. Часы клиник синхронизируются по NTP; расхождение в минуты стоит
 * ровно того, что при одновременной правке одного поля в двух зданиях выживет
 * не то значение — и оба здания увидят одно и то же.
 */
export function stampAt(ms, node) {
  const nodeLetter = requireNode(node);
  const at = Math.max(0, Math.floor(Number(ms)));
  if (!Number.isFinite(at)) throw new Error('hlc: stampAt needs a millisecond timestamp, got ' + JSON.stringify(ms));
  if (at > MAX_MS) throw new Error('hlc: ms exceeds the 48-bit wire format: ' + at);
  return at.toString(16).padStart(MS_HEX, '0') + '-' + '0'.repeat(CNT_HEX) + '-' + nodeLetter;
}

/** Отрицательное / 0 / положительное — как у любого компаратора. */
export function compareStamps(a, b) {
  const x = String(a || '');
  const y = String(b || '');
  return x < y ? -1 : x > y ? 1 : 0;
}

/** true, если строка — метка ровно замороженного формата. */
export function isStamp(s) {
  return STAMP_RE.test(String(s == null ? '' : s));
}

/**
 * @param {string} s
 * @returns {{ms:number, cnt:number, node:string}|null} null, если строка не метка
 */
export function parseStamp(s) {
  const str = String(s == null ? '' : s);
  if (!STAMP_RE.test(str)) return null;
  const [msHex, cntHex, node] = str.split('-');
  return { ms: parseInt(msHex, 16), cnt: parseInt(cntHex, 16), node };
}
