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

const MS_HEX = 12;
const CNT_HEX = 4;
const MAX_CNT = 0xffff;

/**
 * @param {{ms:number, cnt:number}|null} state предыдущее состояние часов
 * @param {string} node буква филиала
 * @param {() => number} [clock]
 * @returns {{stamp:string, ms:number, cnt:number}}
 */
export function nextStamp(state, node, clock = Date.now) {
  const wall = Math.max(0, Math.floor(clock()));
  const prevMs = state && Number.isFinite(state.ms) ? state.ms : 0;
  const prevCnt = state && Number.isFinite(state.cnt) ? state.cnt : 0;

  let ms = wall;
  let cnt = 0;
  if (wall <= prevMs) {
    // Часы не ушли вперёд — держим порядок счётчиком.
    ms = prevMs;
    cnt = prevCnt + 1;
    if (cnt > MAX_CNT) { ms = prevMs + 1; cnt = 0; }
  }
  const stamp = ms.toString(16).padStart(MS_HEX, '0')
    + '-' + cnt.toString(16).padStart(CNT_HEX, '0')
    + '-' + String(node || '?').toUpperCase();
  return { stamp, ms, cnt };
}

/** Отрицательное / 0 / положительное — как у любого компаратора. */
export function compareStamps(a, b) {
  const x = String(a || '');
  const y = String(b || '');
  return x < y ? -1 : x > y ? 1 : 0;
}
