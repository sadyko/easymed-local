// VITALS_NEWS_V1 — NEWS2 (National Early Warning Score 2, Royal College of
// Physicians, 2017): одна реализация на сервер и экран.
//
// Владелец: «dashboard like this» — панель показателей с баллом риска. Шкала
// стандартная, и это важно: медсестра, приходящая из другой клиники, узнаёт
// её без обучения, а числа на экране совпадают с бумажной картой наблюдения.
//
// Семь параметров, каждый даёт 0–3 очка; сумма 0–20. Уровень риска — по
// сумме и по правилу «3 очка у одного параметра». Кислород (2 очка) считается
// только когда пациент на дополнительном кислороде. SpO₂ — по шкале 1 (у
// пациентов с гиперкапнической дыхательной недостаточностью врач ведёт
// шкалу 2 вручную; здесь её нет — это сказано вслух, а не спрятано).

export const CONSCIOUSNESS = Object.freeze(['alert', 'confused', 'voice', 'pain', 'unresponsive']);

/** Диапазоны ввода — то, что физически возможно измерить; вне них — опечатка. */
export const VITAL_RANGES = Object.freeze({
  temp_c:    { min: 30, max: 45,  int: false },
  bp_sys:    { min: 40, max: 300, int: true },
  bp_dia:    { min: 20, max: 200, int: true },
  pulse_bpm: { min: 20, max: 250, int: true },
  resp_rate: { min: 4,  max: 80,  int: true },
  spo2:      { min: 50, max: 100, int: true },
});

/** Нормы для подписи плиток — то, что читает медсестра под числом. */
export const VITAL_NORMS = Object.freeze({
  temp_c:    '36,0–37,2 °C',
  bp:        '< 140/90',
  pulse_bpm: '60–90 уд/мин',
  resp_rate: '12–20 /мин',
  spo2:      '≥ 95 %',
});

// Запятая как десятичный знак («38,4») — так пишут у поста; экран отдаёт сюда
// сырой ввод, и балл обязан считаться по нему так же, как сервер посчитает
// по числу.
const num = (v) => Number(String(v).replace(',', '.'));
const isNum = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(num(v));

function respPoints(v) {
  if (v <= 8) return 3; if (v <= 11) return 1; if (v <= 20) return 0; if (v <= 24) return 2; return 3;
}
function spo2Points(v) {
  if (v <= 91) return 3; if (v <= 93) return 2; if (v <= 95) return 1; return 0;
}
function sbpPoints(v) {
  if (v <= 90) return 3; if (v <= 100) return 2; if (v <= 110) return 1; if (v <= 219) return 0; return 3;
}
function pulsePoints(v) {
  if (v <= 40) return 3; if (v <= 50) return 1; if (v <= 90) return 0; if (v <= 110) return 1; if (v <= 130) return 2; return 3;
}
function tempPoints(v) {
  if (v <= 35.0) return 3; if (v <= 36.0) return 1; if (v <= 38.0) return 0; if (v <= 39.0) return 1; return 2;
}

/**
 * Балл NEWS2 по одному измерению.
 *
 * @param {{resp_rate?, spo2?, on_oxygen?, bp_sys?, pulse_bpm?, consciousness?, temp_c?}} v
 * @returns {{total:number, parts:object, measured:number, complete:boolean, red:boolean, band:string}}
 *   parts — очки по каждому параметру (null, если параметр не измерен);
 *   red — «3 очка у одного параметра» (NEWS2: низко-средний риск даже при малой сумме);
 *   band — 'none' | 'low' | 'low_medium' | 'medium' | 'high'.
 */
export function news2Score(v) {
  const s = v || {};
  const parts = {
    resp_rate:     isNum(s.resp_rate) ? respPoints(num(s.resp_rate)) : null,
    spo2:          isNum(s.spo2) ? spo2Points(num(s.spo2)) : null,
    on_oxygen:     s.on_oxygen === true || s.on_oxygen === 1 || s.on_oxygen === '1' ? 2 : 0,
    bp_sys:        isNum(s.bp_sys) ? sbpPoints(num(s.bp_sys)) : null,
    pulse_bpm:     isNum(s.pulse_bpm) ? pulsePoints(num(s.pulse_bpm)) : null,
    consciousness: s.consciousness ? (s.consciousness === 'alert' ? 0 : 3) : null,
    temp_c:        isNum(s.temp_c) ? tempPoints(num(s.temp_c)) : null,
  };
  const scored = ['resp_rate', 'spo2', 'bp_sys', 'pulse_bpm', 'consciousness', 'temp_c'];
  const measured = scored.filter((k) => parts[k] !== null).length;
  const total = scored.reduce((sum, k) => sum + (parts[k] || 0), 0) + parts.on_oxygen;
  const red = scored.some((k) => parts[k] === 3);
  let band = 'none';
  if (measured > 0) {
    if (total >= 7) band = 'high';
    else if (total >= 5) band = 'medium';
    else if (red) band = 'low_medium';
    else if (total >= 1) band = 'low';
    else band = 'none';
  }
  return { total, parts, measured, complete: measured === scored.length, red, band };
}

/** Уровень словами и что делать — русские ключи словаря (экран переводит tr()). */
export const NEWS_BANDS = Object.freeze({
  none:       { label: 'Риск не повышен',      advice: 'Плановое наблюдение — измерения не реже раза в 12 часов.' },
  low:        { label: 'Низкий риск',           advice: 'Оценка медсестрой; измерения каждые 4–6 часов.' },
  low_medium: { label: 'Низко-средний риск',    advice: 'Срочный осмотр врача; измерения ежечасно.' },
  medium:     { label: 'Средний риск',          advice: 'Срочный осмотр врача в течение 1 часа, учащить измерения.' },
  high:       { label: 'Высокий риск',          advice: 'Экстренный осмотр врача, вызвать реанимационную бригаду, непрерывное наблюдение.' },
});

/** Проверка одного поля измерения: число в физическом диапазоне. */
export function vitalError(key, value) {
  const r = VITAL_RANGES[key];
  if (!r) return null;
  if (value === null || value === undefined || value === '') return null;
  const n = Number(String(value).replace(',', '.'));
  if (!Number.isFinite(n)) return 'не число';
  if (r.int && !Number.isInteger(n)) return 'целое число';
  if (n < r.min || n > r.max) return `от ${r.min} до ${r.max}`;
  return null;
}
