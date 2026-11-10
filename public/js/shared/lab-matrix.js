// LAB_MATRIX_PANEL_V1 (решение владельца 2026-11-07, п. 7) — ПАНЕЛЬ-ТАБЛИЦА (БАК. ПОСЕВ).
//
// Устройство таблицы (lab_panels.matrix_json, мигр. 280):
//   { scale: ['−', '+', '++', '+++', '++++'],
//     sections: [{ title: 'Антибиограмма', columns: ['Резистентный', 'Чувствительный'],
//                  rows: ['Ампициллин', 'Цефтриаксон'] }] }
// Каждая ячейка — показатель панели «строка · графа» в разделе (group_label) со
// списком степеней (value_type 'select'): значения ложатся обычными строками
// lab_results, и всё, что умеет читать анализы (карта, бот, «Документы»), видит их
// и без знания о таблице; бланк лаборатории собирает из них таблицу (matrixGrid).
// Ручной ввод: анализатор таблицу не кормит.
//
// Модуль чистый: без DOM, без сети, без импортов — его грузят и сервер, и браузер.
export const MATRIX_KIND = 'matrix';
export const DEFAULT_SCALE = Object.freeze(['−', '+', '++', '+++', '++++']);
export const MAX_COLUMNS = 3;
const MAX_SECTIONS = 20;
const MAX_ROWS = 200;
const MAX_SCALE = 10;

const txt = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
const listOf = (v) => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,;\n]/) : []).map(txt).filter(Boolean);

/** Имя показателя ячейки: «строка · графа». */
export const cellName = (row, column) => txt(row) + ' · ' + txt(column);

/**
 * Проверка и приведение устройства таблицы. Ошибка — {text, params}: текст —
 * ключ словаря (сервер отдаёт его rpcT, экран — trf).
 * @returns {{ok:true, matrix:{scale:string[], sections:Array<{title:string, columns:string[], rows:string[]}>}}
 *          | {ok:false, error:{text:string, params?:object}}}
 */
export function normalizeMatrix(raw) {
    let m = raw;
    if (typeof m === 'string') { try { m = JSON.parse(m); } catch { m = null; } }
    if (!m || typeof m !== 'object') return { ok: false, error: { text: 'Таблица панели пуста — добавьте раздел, графы и строки.' } };
    const scale = [...new Set(listOf(m.scale))];
    const useScale = scale.length ? scale : [...DEFAULT_SCALE];
    if (useScale.length > MAX_SCALE) return { ok: false, error: { text: 'Степеней в шкале не больше {n}.', params: { n: MAX_SCALE } } };
    const sections = [];
    const titles = new Set();
    const cells = new Map();
    for (const s of Array.isArray(m.sections) ? m.sections : []) {
        if (!s || typeof s !== 'object') continue;
        const title = txt(s.title);
        const columns = [...new Set(listOf(s.columns))];
        const rows = listOf(s.rows);
        if (!title && !columns.length && !rows.length) continue;   // пустой раздел — как не было
        if (!title) return { ok: false, error: { text: 'У раздела таблицы нет названия.' } };
        if (titles.has(title)) return { ok: false, error: { text: 'Раздел «{name}» записан дважды.', params: { name: title } } };
        titles.add(title);
        if (!columns.length || columns.length > MAX_COLUMNS) {
            return { ok: false, error: { text: 'В разделе «{name}» должно быть от 1 до {n} граф.', params: { name: title, n: MAX_COLUMNS } } };
        }
        if (!rows.length) return { ok: false, error: { text: 'В разделе «{name}» нет ни одной строки.', params: { name: title } } };
        if (rows.length > MAX_ROWS) return { ok: false, error: { text: 'В разделе «{name}» больше {n} строк.', params: { name: title, n: MAX_ROWS } } };
        const seen = new Set();
        for (const r of rows) {
            if (seen.has(r)) return { ok: false, error: { text: 'Строка «{row}» записана в разделе «{name}» дважды.', params: { row: r, name: title } } };
            seen.add(r);
            for (const c of columns) {
                const k = cellName(r, c);
                if (cells.has(k)) {
                    return { ok: false, error: { text: 'Строка «{row}» с графой «{col}» уже есть в разделе «{name}» — назовите её иначе.', params: { row: r, col: c, name: cells.get(k) } } };
                }
                cells.set(k, title);
            }
        }
        sections.push({ title, columns, rows });
    }
    if (!sections.length) return { ok: false, error: { text: 'Таблица панели пуста — добавьте раздел, графы и строки.' } };
    if (sections.length > MAX_SECTIONS) return { ok: false, error: { text: 'Разделов в таблице не больше {n}.', params: { n: MAX_SECTIONS } } };
    return { ok: true, matrix: { scale: useScale, sections } };
}

/** Показатели панели из таблицы: ячейка — показатель «строка · графа» раздела, список степеней. */
export function matrixAnalytes(matrix) {
    const out = [];
    const options = (matrix.scale || DEFAULT_SCALE).join(', ');
    for (const s of matrix.sections || []) {
        for (const r of s.rows) {
            for (const c of s.columns) {
                out.push({ name: cellName(r, c), group_label: s.title, value_type: 'select', value_options: options, decimals: 0 });
            }
        }
    }
    return out;
}

/** Устройство таблицы из lab_panels (kind, matrix_json); null — обычная панель или испорчено. */
export function panelMatrix(panel) {
    if (!panel || panel.kind !== MATRIX_KIND) return null;
    const r = normalizeMatrix(panel.matrix_json);
    return r.ok ? r.matrix : null;
}

/**
 * Таблица для бланка: значения ячеек из результатов ({parameter, value}); у
 * повторов имени — последний (как бланк обычной панели). Пустые строки таблицы
 * печатаются тоже — бланк перечисляет назначенное.
 * @returns {{scale:string[], sections:Array<{title:string, columns:string[], rows:Array<{name:string, cells:string[]}>}>, filled:number}}
 */
export function matrixGrid(matrix, results) {
    const val = new Map();
    for (const r of results || []) {
        const v = txt(r && r.value);
        if (r && r.parameter) val.set(txt(r.parameter), v);
    }
    let filled = 0;
    const sections = (matrix.sections || []).map((s) => ({
        title: s.title,
        columns: s.columns,
        rows: s.rows.map((name) => ({
            name,
            cells: s.columns.map((c) => {
                const v = val.get(cellName(name, c)) || '';
                if (v) filled++;
                return v;
            }),
        })),
    }));
    return { scale: matrix.scale || [...DEFAULT_SCALE], sections, filled };
}

/**
 * TG_LAB_MATRIX_V1 (3.23.0) — ЧАСТЬ ГРУППЫ БЛАНКА у панели-таблицы: { matrix } —
 * таблица посева из результатов; у обычной или испорченной панели (и без панели)
 * — {}: группа печатается списком, как прежде. Раскладывается в группу:
 * { title, tests, ...matrixGroupPart(panel, results) }. Одна на все места печати —
 * лаборатория, карта пациента, «Документы», бот в Telegram, история болезни: бот
 * собирал группу без таблицы и печатал посев списком «строка · графа ++++».
 * @param {{kind?:string, matrix_json?:string|object}|null|undefined} panel  строка lab_panels
 * @param {Array<{parameter:string, value:any}>} results
 * @returns {{matrix?: ReturnType<typeof matrixGrid>}}
 */
export function matrixGroupPart(panel, results) {
    const matrix = panelMatrix(panel);
    return matrix ? { matrix: matrixGrid(matrix, results) } : {};
}
