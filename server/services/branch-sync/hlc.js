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
// приняв метку от другого узла, часы навсегда узнают о его скорости.
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
    // Часы (свои или чужие) не ушли вперёд — держим порядок счётчиком того
    // источника, который сейчас на вершине.
    ms = floor;
    cnt = (floor === prevMs ? prevCnt : (parsed && floor === parsed.ms ? parsed.cnt : 0)) + 1;
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
