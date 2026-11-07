// LAB_ROUND_V1 (решение владельца 2026-11-07, п. 6) — ОКРУГЛЕНИЕ РЕЗУЛЬТАТОВ АНАЛИЗАТОРОВ.
//
// Анализаторы шлют значения с 6 знаками после запятой («4.152122»), и бланк
// печатал их так. Настройка клиники «Округлять результаты анализаторов до 2
// знаков» (doc_settings.lab_round_analyzer, мигр. 279), по умолчанию ВКЛЮЧЕНА:
//   • приём (server/lis/ingest.js) пишет в бланк значение, округлённое до 2
//     знаков половиной вверх (4.156 → 4.16, 4.155 → 4.16; у отрицательного —
//     от нуля: −4.155 → −4.16), а полное — в lab_results.raw_value. Флаг и
//     numeric_value считаются по ОКРУГЛЁННОМУ — по тому, что видит врач;
//   • выключили — экраны и печать лаборатории показывают полное значение
//     (raw_value), а новые пробы пишутся полными.
// Округляется только число («4.152122», «-0.0051»); текст («>1000»,
// «положительно»), число с ≤ 2 знаками («4.1», «390.10») — как есть. Ручной ввод
// не трогается: правило — только у строк source = 'analyzer'.
// Счёт — строкой, без float: 1.005 даёт 1.01, а не 1.00 (как Number.toFixed).
//
// Модуль чистый: без DOM, без сети, без импортов — его грузят и сервер, и браузер.
const NUM = /^(-?)(\d+)(?:\.(\d+))?$/;

function incDigits(d) {
    const a = d.split('');
    let k = a.length - 1;
    while (k >= 0) {
        if (a[k] === '9') { a[k] = '0'; k--; } else { a[k] = String(Number(a[k]) + 1); break; }
    }
    if (k < 0) a.unshift('1');
    return a.join('');
}

/**
 * Число строкой — до 2 знаков, половиной вверх (от нуля); иначе значение как есть.
 * Округлённое всегда с двумя знаками («4.10», «4.00»): так видно, что знаки были.
 */
export function roundHalfUp2(value) {
    if (value == null) return value;
    const s = String(value).trim();
    const m = NUM.exec(s);
    if (!m || !m[3] || m[3].length <= 2) return value;
    const [, sign, int, frac] = m;
    let digits = int + frac.slice(0, 2);
    if (frac.charCodeAt(2) >= 53) digits = incDigits(digits);   // 53 — «5»
    const whole = digits.slice(0, -2).replace(/^0+(?=\d)/, '') || '0';
    const out = whole + '.' + digits.slice(-2);
    return (sign && /[1-9]/.test(out) ? '-' : '') + out;
}

/** Настройка клиники (doc_settings.lab_round_analyzer): включена всё, кроме явного 0. */
export function labRoundOn(setting) {
    return !(setting === 0 || setting === '0' || setting === false);
}

/**
 * Что показывать в графе «Результат» у строки lab_results ({value, raw_value, source}).
 * Включено — значение прибора до 2 знаков (у уже округлённого — то же; у строк,
 * записанных до обновления или при выключенной настройке, — округлённое).
 * Ревью S3, L-1 — округляется только то, что записал ПРИБОР: raw_value пуст или
 * value — его округление. Лаборант набрал своё поверх значения прибора (строка
 * остаётся 'analyzer', raw_value — прибора) — показывается как набрано.
 * Выключено — полное значение прибора (raw_value), если бланк держит именно его
 * округление (строку не правили руками); иначе — как записано. Ручной ввод — как есть.
 */
export function labShownValue(row, roundOn = true) {
    if (!row) return null;
    const v = row.value;
    if (row.source !== 'analyzer') return v;
    const raw = row.raw_value;
    if (roundOn) {
        const typedOver = raw != null && String(raw).trim() !== '' && String(roundHalfUp2(raw)) !== String(v == null ? '' : v).trim();   // ревью S3, L-1
        return typedOver ? v : roundHalfUp2(v);
    }
    if (raw != null && String(raw).trim() !== '' && String(roundHalfUp2(raw)) === String(v == null ? '' : v).trim()) return raw;
    return v;
}

/**
 * Ревью S3, L-2 — значение прибора в бланке ({value, raw_value}) в том виде, в каком
 * его прочитал бы приём при нынешней настройке: включено — записанное полным (до
 * обновления или при выключенной; raw_value пуст) — округлённое; выключено —
 * округлённое прибором (raw_value есть, value — его округление) — полное. Иначе — как
 * записано (правку руками это не трогает). Им приём сравнивает «то же значение»:
 * «повтор», повторная передача, серия, «Привязать» (снять своё значение).
 */
export function labReadingOf(value, raw, roundOn = true) {
    const v = value == null ? value : String(value).trim();
    const r = raw == null ? '' : String(raw).trim();
    if (roundOn) return r === '' ? roundHalfUp2(v) : v;
    return r !== '' && String(roundHalfUp2(r)) === v ? r : v;
}
