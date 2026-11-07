// LAB_MATRIX_PANEL_V1 (решение владельца 2026-11-07, п. 7) — КОНСТРУКТОР ПАНЕЛИ-ТАБЛИЦЫ.
//
// «Панели» → вид «Таблица (бак. посев)»: лаборатория сама заводит разделы
// («Определяемые микроорганизмы», «Антибиограмма», «Противогрибковая
// чувствительность»), у каждого раздела — 1–3 своих графы («Положительный |
// Отрицательный», «Резистентный | Чувствительный») и строки (добавить, убрать,
// поднять, опустить); шкала степеней одна на таблицу (−, +, ++, +++, ++++ — клиника
// может дописать свои). Сохраняет прежняя кнопка «Сохранить панель» тем же
// атомарным lab_panel_save: сервер проверяет таблицу (shared/lab-matrix.js) и сам
// собирает из неё показатели панели. Анализатор таблицу не кормит — ввод руками.
import { h, Icon, clear } from '../ui.js';
import { tr } from '../i18n.js';
import { DEFAULT_SCALE, MAX_COLUMNS, normalizeMatrix } from '../../shared/lab-matrix.js';

/** Состояние редактора из сохранённой панели (kind, matrix_json) или новое. */
export function editorMatrix(panel) {
    const r = normalizeMatrix(panel && panel.matrix_json);
    if (r.ok) {
        return {
            scale: r.matrix.scale.join(', '),
            sections: r.matrix.sections.map((s) => ({ title: s.title, columns: padColumns(s.columns), rows: [...s.rows] })),
        };
    }
    return { scale: DEFAULT_SCALE.join(', '), sections: [blankSection()] };
}
function padColumns(cols) { return [...cols, '', '', ''].slice(0, MAX_COLUMNS); }
function blankSection() { return { title: '', columns: padColumns([]), rows: [''] }; }

/** То, что уходит в lab_panel_save (panel.matrix). */
export function matrixPayload(m) {
    return {
        scale: String((m && m.scale) || ''),
        sections: ((m && m.sections) || []).map((s) => ({
            title: String(s.title || ''),
            columns: (s.columns || []).map((c) => String(c || '').trim()).filter(Boolean),
            rows: (s.rows || []).map((r) => String(r || '').trim()).filter(Boolean),
        })),
    };
}

const move = (arr, i, d) => {
    const j = i + d;
    if (j < 0 || j >= arr.length) return;
    [arr[i], arr[j]] = [arr[j], arr[i]];
};

/**
 * Редактор таблицы. Поля пишут в m сразу (как шапка панели, ревью R3 LIS_MINDRAY_CODES_V1):
 * перерисовка не теряет набранное. Перестройка — только своего блока.
 */
export function matrixEditor(m) {
    const root = h('div', { class: 'lp-matrix', 'data-matrix-editor': '' });
    const iconBtn = (icon, title, onclick, extra = {}) => h('button', {
        class: 'btn btn-ghost btn-sm', type: 'button', title: tr(title), 'aria-label': tr(title), onclick, ...extra,
    }, Icon(icon, { size: 12 }));

    function paint() {
        clear(root);
        const scaleInp = h('input', { value: m.scale, style: { width: '100%' }, 'data-matrix-scale': '',
            oninput: (e) => { m.scale = e.target.value; } });
        root.appendChild(h('div', { class: 'field' },
            h('label', null, tr('Шкала степеней')), scaleInp,
            h('div', { class: 'hint' }, tr('Через запятую — то, что лаборант выбирает в ячейке: −, +, ++, +++, ++++'))));

        m.sections.forEach((s, si) => {
            const titleInp = h('input', { value: s.title, placeholder: tr('Название раздела, например «Антибиограмма»'), style: { flex: '1 1 auto', minWidth: '0' },
                'data-matrix-title': String(si), oninput: (e) => { s.title = e.target.value; } });
            const colInputs = s.columns.map((c, ci) => h('input', { value: c, placeholder: tr('Графа') + ' ' + (ci + 1), style: { flex: '1 1 0', minWidth: '0' },
                'data-matrix-col': si + ':' + ci, oninput: (e) => { s.columns[ci] = e.target.value; } }));
            const rowsEl = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } });
            s.rows.forEach((r, ri) => {
                rowsEl.appendChild(h('div', { class: 'row', style: { gap: '4px', alignItems: 'center' } },
                    h('input', { value: r, placeholder: tr('Строка, например «E. coli» или «Ампициллин»'), style: { flex: '1 1 auto', minWidth: '0' },
                        'data-matrix-row': si + ':' + ri, oninput: (e) => { s.rows[ri] = e.target.value; } }),
                    iconBtn('ArrowUp', 'Поднять строку', () => { move(s.rows, ri, -1); paint(); }, { disabled: ri === 0 }),
                    iconBtn('ArrowDown', 'Опустить строку', () => { move(s.rows, ri, 1); paint(); }, { disabled: ri === s.rows.length - 1 }),
                    iconBtn('Trash', 'Убрать строку', () => { s.rows.splice(ri, 1); if (!s.rows.length) s.rows.push(''); paint(); })));
            });
            root.appendChild(h('section', { class: 'lp-matrix-sec', 'data-matrix-section': String(si),
                style: { border: '1px solid var(--ink-100)', borderRadius: '10px', padding: '10px', marginTop: '10px' } },
                h('div', { class: 'row', style: { gap: '4px', alignItems: 'center' } },
                    titleInp,
                    iconBtn('ArrowUp', 'Поднять раздел', () => { move(m.sections, si, -1); paint(); }, { disabled: si === 0 }),
                    iconBtn('ArrowDown', 'Опустить раздел', () => { move(m.sections, si, 1); paint(); }, { disabled: si === m.sections.length - 1 }),
                    iconBtn('Trash', 'Убрать раздел', () => { m.sections.splice(si, 1); if (!m.sections.length) m.sections.push(blankSection()); paint(); })),
                h('div', { class: 'hint', style: { marginTop: '6px' } }, tr('Графы раздела (от 1 до 3)')),
                h('div', { class: 'row', style: { gap: '6px' } }, ...colInputs),
                h('div', { class: 'hint', style: { marginTop: '6px' } }, tr('Строки раздела')),
                rowsEl,
                h('button', { class: 'btn btn-outline btn-sm', type: 'button', style: { marginTop: '6px' }, 'data-matrix-add-row': String(si),
                    onclick: () => { s.rows.push(''); paint(); } }, Icon('Plus', { size: 12 }), ' ', tr('Добавить строку'))));
        });
        root.appendChild(h('button', { class: 'btn btn-outline btn-sm', type: 'button', style: { marginTop: '10px' }, 'data-matrix-add-section': '',
            onclick: () => { m.sections.push(blankSection()); paint(); } }, Icon('Plus', { size: 12 }), ' ', tr('Добавить раздел')));
    }
    paint();
    return root;
}
