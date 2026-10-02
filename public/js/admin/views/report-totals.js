// REPORT_TOTALS_V1 — строка «Итого» под таблицей отчёта.
//
// Отчёт по счетам на 33 строки заканчивался ничем: суммы по колонкам «Сумма без
// скидки», «Оплачено», «Остаток / долг» приходилось складывать в уме или
// выгружать в Excel ради одной цифры. Считаем их здесь.
//
// «Где нужно» — ключевое слово. Складывать ВСЁ числовое нельзя: проценты,
// средние значения, возраст, год и идентификаторы в сумме дают бессмыслицу,
// которая выглядит как настоящий итог. Поэтому колонка попадает в итог, только
// если она числовая И её заголовок не выглядит как одна из этих величин.
//
// Правило намеренно консервативное: пропустить итог у денежной колонки — просто
// неудобно, показать липовый итог у процентов — уже ошибка в отчёте.

// \b в JavaScript опирается на ASCII-класс \w, поэтому «\bгод\b» не совпадает
// НИ С ЧЕМ в кириллице — граница слова здесь строится через \p{L} и флаг u.
const edge = (w) => `(?<![\\p{L}])${w}(?![\\p{L}])`;
const NOT_SUMMABLE = new RegExp([
    // i18n-exempt: ключевые слова-эвристика для распознавания колонок — данные алгоритма, не текст экрана
    '%', 'процент', 'средн', 'медиан', 'average', 'возраст', 'номер', 'дата', 'время', '№',
    edge('avg'), edge('id'), edge('год'), edge('year'), edge('age'), edge('date'), edge('time'),
    // Ставка — процент, даже без знака % («Ставка врача»). Только В НАЧАЛЕ
    // заголовка: «Услуг по фикс. ставке» — количество, и оно суммируется.
    // i18n-exempt: ключевое слово-эвристика для распознавания колонок — данные алгоритма, не текст экрана
    '^ставк',
].join('|'), 'iu');
// REPORT_TOTALS (ревью I-5) — «доля» из списка убрана: в отчётах это деньги
// («Доля врача», «Оплачено (доля оплаты счёта)», «Стационарная доля»), и их
// итог пропадал. Доля-процент подписана «, %» и отсекается знаком выше.

export function isSummableHeader(label) {
    const s = String(label == null ? '' : label).trim();
    if (!s) return false;
    return !NOT_SUMMABLE.test(s);
}

// columns — [{ label }] в порядке таблицы.
// rows     — исходные строки (ВСЕ, а не только показанные).
// get(row, col, index) — значение ячейки.
// isNumeric(col, index) — числовая ли колонка (определяется вызывающим так же,
//   как он выравнивает ячейки, чтобы итог не появился под текстовой колонкой).
//
// opts (REPORTS_AUDIT_FIX_V1) — что знает сервер, а заголовок не знает:
//   summable — список складываемых колонок (подписи; ответ run_report
//     summable_columns). Если он есть, решает он, а не угадывание по заголовку:
//     «Цена», «Пациентов», количество товара в разных единицах — числа, но их
//     сумма бессмысленна, и заголовок этого не выдаёт.
//   skipRows — номера строк вне итога (total_skip_rows: отменённые счета и
//     счета DEP-/CARD- в «Счетах» — в списке, но не в «Итого»).
//
// Возвращает массив по числу колонок: число — итог, null — итога нет.
export function reportTotals(columns, rows, get, isNumeric, opts = {}) {
    const list = opts && opts.summable;
    const summable = list instanceof Set ? list : (Array.isArray(list) ? new Set(list.map(String)) : null);
    const skip = new Set(Array.isArray(opts && opts.skipRows) ? opts.skipRows : []);
    return (columns || []).map((col, ci) => {
        if (!isNumeric(col, ci)) return null;
        const label = col && col.label;
        if (summable ? !summable.has(String(label == null ? '' : label)) : !isSummableHeader(label)) return null;
        let sum = 0;
        let seen = 0;
        for (const [ri, r] of (rows || []).entries()) {
            if (skip.has(ri)) continue;
            const v = get(r, col, ci);
            if (typeof v === 'number' && Number.isFinite(v)) { sum += v; seen++; }
        }
        if (!seen) return null;
        // Деньги в базе лежат REAL: 0.1 + 0.2 накапливает хвост из нулей,
        // который в отчёте выглядит как ошибка счёта.
        return Math.round(sum * 100) / 100;
    });
}

// ---------------------------------------------------------------------------
// V3120_FIX (I18N + EXCEL) — ОТЧЁТ НА ЯЗЫКЕ ЭКРАНА И ВЫГРУЗКА С ИТОГОМ.
//
// Сервер отдаёт отчёт по-русски. Заголовки колонок, примечания и значения
// колонок-перечислений («Где», «Вид», «Статус»…) переводятся словарём целиком;
// собранные из значений примечания и подписи «Корректировка за …» приходят
// шаблоном (notes_t, cells_t, pending_items.note_t) — перевод сначала,
// подстановка потом, а месяц ГГГГ-ММ пишется словом языка экрана.
//
// Выгрузка в Excel прежде была голой таблицей: без строки «Итого» и без
// примечаний, заголовки — всегда по-русски. Теперь лист отчёта кончается той
// же строкой «Итого», что под таблицей на экране (те же складываемые колонки
// и те же строки вне итога), а примечания — отдельным листом.
//
// tx — { tr, trf, lang, monthName } из i18n.js: модуль остаётся чистым (без
// DOM и без i18n), его проверяют в node.
// ---------------------------------------------------------------------------
const YM_RE = /\b(\d{4})-(0[1-9]|1[0-2])\b(?!-\d)/g;
// Колонки, значения которых — слова словаря, а не данные клиники.
// SUPPLIERS_VAT_V1 — «Категория» (восемь категорий товара у «Прихода по
// поставщикам» и «Остатков»; у «Рефералов» — названия клиники, их tr()
// оставляет как есть) и «Ставка НДС» («без НДС», «не указан»).
// JOURNALS_V1 — у журналов «Пол» («Муж.»/«Жен.»), «Тип палаты» (Люкс /
// Полулюкс / Обычная) и «Кто направил» («Стационар», «сам»; имена врачей и
// источников tr() оставляет как есть) — тоже слова словаря.
export const ENUM_COLS = new Set(['Где', 'Вид', 'Статус', 'Статус счёта', 'Режим ставок', 'Оплата', 'Роль', 'Категория', 'Ставка НДС', 'Пол', 'Тип палаты', 'Кто направил']);

export function localizeReport(r, tx) {
    const res = r || {};
    const ym = (v) => String(v == null ? '' : v).replace(YM_RE,
        (_, y, m) => tx.monthName(Number(m) - 1, { standalone: true }) + ' ' + y);
    const viaT = (text, t) => {
        if (!t || !t.template || tx.lang === 'ru') return tx.tr(text);
        const params = {};
        for (const [k, v] of Object.entries(t.params || {})) params[k] = ym(v);
        return tx.trf(t.template, params);
    };
    const cols = res.columns || [];
    const cellT = new Map((res.cells_t || []).map(([ri, ci, template, params]) => [ri + ':' + ci, { template, params }]));
    const enumCol = cols.map((c) => ENUM_COLS.has(c));
    return {
        columns: cols.map((c) => tx.tr(c)),
        rows: (res.rows || []).map((row, ri) => row.map((v, ci) => {
            const t = cellT.get(ri + ':' + ci);
            if (t) return viaT(v, t);
            return enumCol[ci] && typeof v === 'string' ? tx.tr(v) : v;
        })),
        notes: (res.notes || []).map((n, i) => viaT(n, res.notes_t && res.notes_t[i])),
        pendingNote: res.pending_items && res.pending_items.note
            ? viaT(res.pending_items.note, res.pending_items.note_t) : null,
    };
}

// JOURNALS_V1_SERVICE — длинный текст (заключение врача) на экране обрезается
// до 300 знаков; в Excel и при печати — целиком (reportSheets / report-print.js
// читают исходные строки).
export const PREVIEW_TEXT_CAP = 300;
export function clipPreviewText(text, cap = PREVIEW_TEXT_CAP) {
    const s = String(text == null ? '' : text);
    return s.length > cap ? s.slice(0, cap - 1).trimEnd() + '…' : s;
}

// Листы выгрузки: report — таблица (+ строка «Итого»), notes — примечания или null.
export function reportSheets(r, tx) {
    const res = r || {};
    const loc = localizeReport(res, tx);
    const cols = res.columns || [];
    const rows = res.rows || [];
    const isNum = cols.map((_, ci) => {
        const probe = rows.find((x) => x[ci] != null && x[ci] !== '');
        return typeof (probe && probe[ci]) === 'number';
    });
    const totals = reportTotals(cols.map((c) => ({ label: c })), rows, (row, _c, ci) => row[ci], (_c, ci) => isNum[ci],
        { summable: res.summable_columns, skipRows: res.total_skip_rows });
    const report = [loc.columns, ...loc.rows];
    if (totals.some((v) => v != null)) report.push(totals.map((v, ci) => (ci === 0 ? tx.tr('Итого') : v)));
    const notes = [...(loc.pendingNote ? [loc.pendingNote] : []), ...loc.notes];
    return { report, notes: notes.length ? [[tx.tr('Примечания')], ...notes.map((n) => [n])] : null };
}
