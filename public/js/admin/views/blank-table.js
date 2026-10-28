// DOC_RICH_FORMAT_V1 (T3, правило F6) — ТАБЛИЦА В ДОКУМЕНТЕ КАБИНЕТА ВРАЧА.
//
// Владелец: «простая таблица» — без объединения ячеек. Кнопка «Таблица» в
// панели оформления бланка вставляет в курсор table.a4-tbl: первая строка —
// заголовок (thead, th), остальные — данные (tbody, td); в пустой ячейке <br>,
// чтобы в неё можно было щёлкнуть. Под таблицей — абзац: врач пишет дальше.
//
// Таблицу бланк делит по страницам (T2, blank-split.js): строки страницы 2
// лежат в копии table[data-cont-split], заголовок там — повтор
// [data-cont-head] (не правится, следующая раскладка строит его заново).
// Поэтому каждая операция работает с таблицей ЦЕЛИКОМ — со всеми её
// половинами (splitChain — те же правила пары, что у слияния):
//   - строка добавляется и удаляется в своей половине (в копии tbody — тоже:
//     слияние вернёт её в таблицу);
//   - столбец — во всех строках всех половин, и в повторе заголовка, чтобы
//     страница 2 не ждала раскладки;
//   - «Удалить таблицу» — все половины разом (копия без оригинала после
//     слияния стала бы своей таблицей).
// Здесь только узлы; кнопки, панель и клавиши — в service-workspace.js.
// Ни document, ни window: модуль проверяется в Node (__tests__/mini-dom.mjs).

import { CONT_HEAD, splitChain, tableParts } from './blank-split.js';

export const TBL_MAX_ROWS = 15;
export const TBL_MAX_COLS = 8;
const TBL_CLASS = 'a4-tbl';

const isEl = (n) => !!n && n.nodeType === 1;
const isText = (n) => !!n && n.nodeType === 3;
const tagOf = (n) => (isEl(n) ? String(n.tagName).toUpperCase() : '');
const kids = (el) => { const out = []; for (let n = el.firstChild; n; n = n.nextSibling) if (isEl(n)) out.push(n); return out; };
const cellsOf = (tr) => kids(tr).filter((c) => tagOf(c) === 'TD' || tagOf(c) === 'TH');
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.floor(Number(v) || 0)));
const PARA = new Set(['DIV', 'P']);
const NO_INSIDE = new Set(['TABLE', 'UL', 'OL']);
const BLOCK = new Set(['DIV', 'P', 'UL', 'OL', 'TABLE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE', 'HR']);

function closestUpTo(node, tags, stop) {
    for (let n = isEl(node) ? node : node && node.parentNode; n && n !== stop; n = n.parentNode) if (tags.has(tagOf(n))) return n;
    return null;
}
function newCell(doc, tag) { const c = doc.createElement(tag); c.appendChild(doc.createElement('br')); return c; }
function indexIn(parent, child) { let i = 0; for (let n = parent.firstChild; n && n !== child; n = n.nextSibling) i += 1; return i; }

/** Таблица строки × столбцы (1–15 × 1–8): первая строка — заголовок th. */
export function buildTable(doc, rows, cols) {
    const r = clamp(rows, 1, TBL_MAX_ROWS);
    const c = clamp(cols, 1, TBL_MAX_COLS);
    const t = doc.createElement('table');
    t.className = TBL_CLASS;
    const thead = doc.createElement('thead');
    const htr = doc.createElement('tr');
    for (let k = 0; k < c; k += 1) htr.appendChild(newCell(doc, 'th'));
    thead.appendChild(htr);
    const tbody = doc.createElement('tbody');
    for (let i = 1; i < r; i += 1) {
        const tr = doc.createElement('tr');
        for (let k = 0; k < c; k += 1) tr.appendChild(newCell(doc, 'td'));
        tbody.appendChild(tr);
    }
    t.appendChild(thead);
    t.appendChild(tbody);
    return t;
}

// Разделить всё от точки курсора до части поля (host): возвращает узел части,
// перед которым встаёт таблица (null — в конец). Строчные предки и абзац
// делятся неглубокими копиями (стиль абзаца, жирный — продолжаются после).
function splitToHost(host, node, offset) {
    let parent;
    let cut;
    if (isText(node)) {
        parent = node.parentNode;
        const off = clamp(offset, 0, node.data.length);
        if (off === 0) cut = node;
        else if (off >= node.data.length) cut = node.nextSibling;
        else cut = node.splitText(off);
    } else {
        parent = node;
        cut = node.childNodes[Number(offset) || 0] || null;
    }
    for (let guard = 0; parent && parent !== host && guard < 64; guard += 1) {
        if (!cut) { cut = parent.nextSibling; parent = parent.parentNode; continue; }
        let atStart = true;
        for (let n = parent.firstChild; n && n !== cut; n = n.nextSibling) if (!(isText(n) && n.data === '')) { atStart = false; break; }
        if (atStart) { cut = parent; parent = parent.parentNode; continue; }
        const copy = parent.cloneNode(false);
        for (let n = cut; n;) { const nx = n.nextSibling; copy.appendChild(n); n = nx; }
        parent.parentNode.insertBefore(copy, parent.nextSibling);
        cut = copy;
        parent = parent.parentNode;
    }
    return cut;
}

/**
 * Вставить таблицу в курсор (node, offset) части поля host. Курсор в ячейке
 * другой таблицы или в списке — новая таблица встаёт после них (вложенных
 * таблиц нет). Под таблицей — абзац, если дальше нет текста.
 * Ревью T3 (HIGH 1) — таблица или список, разрезанные по страницам, — одно
 * целое: новая таблица встаёт после ПОСЛЕДНЕЙ половины (parts — части поля), а
 * не между половинами, где слияние отдавало ей хвост старой таблицы.
 * @returns {{table: Element, caret: {node: Node, offset: number}, host: Element}}
 */
export function insertTable(host, node, offset, rows, cols, parts = null) {
    const doc = host.ownerDocument;
    const table = buildTable(doc, rows, cols);
    let inside = null;
    if (node && node !== host && host.contains(node)) {
        for (let n = isEl(node) ? node : node.parentNode; n && n !== host; n = n.parentNode) if (NO_INSIDE.has(tagOf(n))) inside = n;   // самое внешнее
    }
    let ref;
    if (inside) {
        const halves = parts ? splitChain(inside, parts) : [inside];
        const last = halves[halves.length - 1] || inside;
        const list = (parts || [host]).filter(Boolean);
        host = list.find((p) => p === last || (p.contains && p.contains(last))) || host;
        let top = last;
        while (top.parentNode && top.parentNode !== host) top = top.parentNode;
        ref = top.nextSibling;
    } else {
        ref = node && (node === host || host.contains(node)) ? splitToHost(host, node, offset) : null;
    }
    host.insertBefore(table, ref);
    let next = table.nextSibling;
    while (isText(next) && next.data === '') next = next.nextSibling;
    if (!next || (BLOCK.has(tagOf(next)) && !PARA.has(tagOf(next)))) {
        const p = doc.createElement('div');
        p.appendChild(doc.createElement('br'));
        host.insertBefore(p, next);
    }
    return { table, caret: { node: table.querySelector('th'), offset: 0 }, host };
}

/**
 * DOC_RICH_FORMAT_V1 (ревью T3, MEDIUM 1) — ВСТАВКА ИЗ EXCEL И WORD. Таблицы,
 * вставленные в часть поля, приводятся к «простой таблице» документа:
 *   - таблица поднимается на уровень части поля из обёрток (Word: <div
 *     class=WordSection1>, Excel и браузер — div/span/font); обёртка делится
 *     вокруг неё, опустевшая — убирается (таблица внутри пункта списка или
 *     ячейки не трогается);
 *   - colspan / rowspan разворачиваются в простые ячейки — сетка
 *     прямоугольная, короткие строки дополняются (объединения ячеек нет —
 *     решение владельца);
 *   - класс a4-tbl — тонкие рамки на экране и в печати.
 * Повторный вызов ничего не меняет; уже приведённая таблица проверяется
 * дёшево (зовётся на каждый ввод: вставка браузером через execCommand не
 * отличима от набора по inputType).
 * @returns {number} сколько таблиц изменено
 */
export function normalizePasted(host) {
    if (!host || !host.querySelectorAll) return 0;
    let n = 0;
    for (const t of [...host.querySelectorAll('table')]) {
        if (!host.contains(t) || closestUpTo(t.parentNode, LIFT_STOP, host)) continue;   // вложенная (в ячейке, в пункте) — как есть
        const classed = /\ba4-(tbl|restbl)\b/.test(t.getAttribute('class') || '');
        if (t.parentNode === host && classed && !needsGrid(t)) continue;
        liftToHost(host, t);
        squareGrid(t);
        if (!classed) t.setAttribute('class', ((t.getAttribute('class') || '') + ' ' + TBL_CLASS).trim());
        n += 1;
    }
    return n;
}
// Объединения ячеек или строки разной длины — сетку надо выровнять.
function needsGrid(t) {
    if (t.querySelector('[colspan],[rowspan]')) return true;
    let w = -1;
    for (const r of t.querySelectorAll('tr')) { const k = cellsOf(r).length; if (w < 0) w = k; else if (k !== w) return true; }
    return false;
}
const LIFT_STOP = new Set(['TD', 'TH', 'LI', 'TABLE']);
function liftToHost(host, t) {
    if (t.parentNode === host) return;
    const was = t.parentNode;
    const ref = (() => { const p = t.parentNode; const i = indexIn(p, t); p.removeChild(t); return splitToHost(host, p, i); })();
    host.insertBefore(t, ref);
    // обёртки, опустевшие после подъёма, — убрать (до части поля)
    for (let w = was; w && w !== host;) {
        const up = w.parentNode;
        if (isEl(w) && !String(w.textContent || '').trim() && !w.querySelector('table,ul,ol,img,br')) w.remove();
        w = up;
    }
}
// Сетка без объединений: каждая строка — столько ячеек, сколько столбцов у таблицы.
function squareGrid(t) {
    const rows = [];
    for (const k of kids(t)) {
        if (tagOf(k) === 'TR') rows.push(k);
        else if (tagOf(k) === 'THEAD' || tagOf(k) === 'TBODY' || tagOf(k) === 'TFOOT') for (const r of kids(k)) if (tagOf(r) === 'TR') rows.push(r);
    }
    if (!rows.length) return;
    const doc = t.ownerDocument;
    const span = (c, a) => Math.max(1, Math.min(a === 'colspan' ? TBL_MAX_COLS * 4 : 200, parseInt(c.getAttribute(a), 10) || 1));
    const slots = rows.map(() => []);
    rows.forEach((tr, r) => {
        let c = 0;
        for (const cell of cellsOf(tr)) {
            while (slots[r][c]) c += 1;
            const cs = span(cell, 'colspan');
            const rs = Math.min(span(cell, 'rowspan'), rows.length - r);
            for (let dr = 0; dr < rs; dr += 1) for (let dc = 0; dc < cs; dc += 1) slots[r + dr][c + dc] = dr === 0 && dc === 0 ? { cell } : { tag: tagOf(cell).toLowerCase() };
            cell.removeAttribute('colspan');
            cell.removeAttribute('rowspan');
            c += cs;
        }
    });
    const width = Math.max(...slots.map((s) => s.length));
    rows.forEach((tr, r) => {
        const own = cellsOf(tr);
        if (own.length === width && slots[r].every((s, i) => s && s.cell === own[i])) return;
        for (const c of own) tr.removeChild(c);
        for (let c = 0; c < width; c += 1) {
            const s = slots[r][c];
            tr.appendChild(s && s.cell ? s.cell : newCell(doc, s && s.tag === 'th' ? 'th' : 'td'));
        }
    });
}

/**
 * Shift+Tab в первой ячейке — курсор перед таблицей: в конец строки над ней,
 * а если над таблицей ничего нет — на место перед ней.
 */
export function beforeTable(cell, parts) {
    const chain = tableChain(cell, parts);
    if (!chain.length) return null;
    let top = chain[0];
    const list = (parts || []).filter(Boolean);
    const host = list.find((p) => p === top || (p.contains && p.contains(top))) || top.parentNode;
    while (top.parentNode && top.parentNode !== host) top = top.parentNode;
    let prev = top.previousSibling;
    while (isText(prev) && !/\S/.test(prev.data)) prev = prev.previousSibling;
    if (isText(prev)) return { node: prev, offset: prev.data.length };
    if (isEl(prev) && !NO_INSIDE.has(tagOf(prev))) return cellCaret(prev, true);
    return { node: host, offset: indexIn(host, top) };
}

/** Есть ли текст в ячейках строки (спросить перед «− строка»). */
export function rowHasText(cell) {
    const tr = cell && cell.parentNode;
    return tagOf(tr) === 'TR' && cellsOf(tr).some((c) => String(c.textContent || '').trim());
}
/** Есть ли текст в ячейках столбца во всех половинах таблицы (спросить перед «− столбец»). */
export function columnHasText(cell, parts) {
    const chain = tableChain(cell, parts);
    const tr = cell && cell.parentNode;
    if (!chain.length || tagOf(tr) !== 'TR') return false;
    const col = cellsOf(tr).indexOf(cell);
    const { head, body } = layout(chain);
    return head.concat(body).some((r) => { const c = cellsOf(r)[col]; return !!c && !!String(c.textContent || '').trim(); });
}

/** Все половины таблицы ячейки (или самой таблицы) по порядку страниц. */
export function tableChain(cellOrTable, parts) {
    const t = tagOf(cellOrTable) === 'TABLE' ? cellOrTable : closestUpTo(cellOrTable, new Set(['TABLE']), null);
    if (!t) return [];
    return splitChain(t, parts);
}

// Строки таблицы целиком: заголовок оригинала, повторы заголовка в копиях,
// строки данных всех половин по порядку.
function layout(chain) {
    const origin = chain[0];
    const head = tableParts(origin).head;
    const copies = [];
    const body = [];
    for (const half of chain) {
        const tp = tableParts(half);
        for (const r of tp.head) if (half !== origin) copies.push(r);
        for (const r of tp.body) {
            if (r.closest && r.closest('[' + CONT_HEAD + ']')) copies.push(r); else body.push(r);
        }
    }
    return { origin, head, copies, body };
}
const isCopyRow = (tr) => !!(tr && tr.closest && tr.closest('[' + CONT_HEAD + ']'));

/** Строки, по которым ходит Tab: заголовок и данные, без повтора заголовка. */
function editableCells(chain) {
    const { head, body } = layout(chain);
    const out = [];
    for (const r of head.concat(body)) out.push(...cellsOf(r));
    return out;
}

/** Tab / Shift+Tab: следующая (предыдущая) ячейка таблицы через половины; на краю — null. */
export function cellStep(cell, parts, back = false) {
    const chain = tableChain(cell, parts);
    if (!chain.length) return null;
    const cells = editableCells(chain);
    const i = cells.indexOf(cell);
    if (i < 0) return null;
    return cells[back ? i - 1 : i + 1] || null;
}

/** Есть ли текст в таблице (во всех половинах) — спросить перед удалением. */
export function tableHasText(chain) {
    for (const r of layout(chain).head.concat(layout(chain).body)) for (const c of cellsOf(r)) if (String(c.textContent || '').trim()) return true;
    return false;
}

const at = (cell) => ({ node: cell, offset: 0 });

/** Курсор в ячейке: в начале (или в конце — после её последнего текста). */
export function cellCaret(cell, atEnd = false) {
    if (!atEnd) return at(cell);
    let last = null;
    const walk = (e) => { for (let n = e.firstChild; n; n = n.nextSibling) { if (isText(n) && n.data !== '') last = n; else if (isEl(n)) walk(n); } };
    walk(cell);
    return last ? { node: last, offset: last.data.length } : at(cell);
}

/** «+ строка» — под текущей; из заголовка — первой строкой данных. Курсор — в ту же колонку новой строки. */
export function addRow(cell, parts) {
    const chain = tableChain(cell, parts);
    const tr = cell && cell.parentNode;
    if (!chain.length || tagOf(tr) !== 'TR' || isCopyRow(tr)) return null;
    const doc = tr.ownerDocument;
    const { origin, head, body } = layout(chain);
    const col = cellsOf(tr).indexOf(cell);
    const n = Math.max(1, cellsOf(tr).length);
    const row = doc.createElement('tr');
    for (let k = 0; k < n; k += 1) row.appendChild(newCell(doc, 'td'));
    if (head.indexOf(tr) > -1) {
        if (body.length) body[0].parentNode.insertBefore(row, body[0]);
        else {
            let tbody = kids(origin).find((k) => tagOf(k) === 'TBODY');
            if (!tbody) { tbody = doc.createElement('tbody'); origin.appendChild(tbody); }
            tbody.appendChild(row);
        }
    } else tr.parentNode.insertBefore(row, tr.nextSibling);
    return at(cellsOf(row)[Math.max(0, Math.min(col, n - 1))]);
}

/** Можно ли «− строка»: строку данных — да; заголовок — только когда строк данных нет; повтор заголовка — нет. */
export function canRemoveRow(cell, parts) {
    const chain = tableChain(cell, parts);
    const tr = cell && cell.parentNode;
    if (!chain.length || tagOf(tr) !== 'TR' || isCopyRow(tr)) return false;
    const { head, body } = layout(chain);
    return head.indexOf(tr) < 0 || !body.length;
}

/**
 * «− строка». Курсор — в ту же колонку следующей строки (или предыдущей).
 * Таблица без строк удаляется целиком. Нельзя — null.
 */
export function removeRow(cell, parts) {
    if (!canRemoveRow(cell, parts)) return null;
    const chain = tableChain(cell, parts);
    const tr = cell.parentNode;
    const { head, body } = layout(chain);
    const rows = head.concat(body);
    if (rows.length <= 1) return deleteTable(cell, parts);
    const i = rows.indexOf(tr);
    const col = cellsOf(tr).indexOf(cell);
    const to = rows[i + 1] || rows[i - 1];
    tr.parentNode.removeChild(tr);
    const cs = cellsOf(to);
    return at(cs[Math.max(0, Math.min(col, cs.length - 1))] || to);
}

/** «+ столбец» — справа от текущего, во всех строках всех половин (и в повторе заголовка). */
export function addColumn(cell, parts) {
    const chain = tableChain(cell, parts);
    const tr = cell && cell.parentNode;
    if (!chain.length || tagOf(tr) !== 'TR') return null;
    const doc = tr.ownerDocument;
    const col = cellsOf(tr).indexOf(cell);
    const { head, copies, body } = layout(chain);
    let made = null;
    for (const r of head.concat(copies, body)) {
        const cs = cellsOf(r);
        const tag = head.indexOf(r) > -1 || copies.indexOf(r) > -1 ? 'th' : 'td';
        const c = newCell(doc, tag);
        r.insertBefore(c, cs[col + 1] || null);
        if (r === tr) made = c;
    }
    return made ? at(made) : null;
}

/** «− столбец» — текущий во всех строках; последний столбец — таблица удаляется. */
export function removeColumn(cell, parts) {
    const chain = tableChain(cell, parts);
    const tr = cell && cell.parentNode;
    if (!chain.length || tagOf(tr) !== 'TR') return null;
    const { head, copies, body } = layout(chain);
    const width = Math.max(0, ...head.concat(body).map((r) => cellsOf(r).length));
    if (width <= 1) return deleteTable(cell, parts);
    const col = cellsOf(tr).indexOf(cell);
    for (const r of head.concat(copies, body)) { const c = cellsOf(r)[col]; if (c) r.removeChild(c); }
    const cs = cellsOf(tr);
    return cs.length ? at(cs[Math.min(col, cs.length - 1)]) : null;
}

/** «Удалить таблицу» — все половины. Курсор — туда, где стояла таблица. */
export function deleteTable(cellOrTable, parts) {
    const chain = tableChain(cellOrTable, parts);
    if (!chain.length) return null;
    const origin = chain[0];
    const host = origin.parentNode;
    const offset = indexIn(host, origin);
    for (const t of chain) if (t.parentNode) t.parentNode.removeChild(t);
    return { node: host, offset };
}

/**
 * Enter в ячейке — перенос строки в ней (<br>), а не абзац снаружи. Запасной
 * путь, если insertLineBreak браузера недоступен. <br> в самом конце ячейки
 * строки не даёт — тогда второй, как делает браузер.
 * @returns {{node: Node, offset: number}} курсор после переноса
 */
export function insertCellBreak(node, offset) {
    const doc = node.ownerDocument;
    let parent;
    let ref;
    if (isText(node)) {
        parent = node.parentNode;
        const off = clamp(offset, 0, node.data.length);
        if (off === 0) ref = node;
        else if (off >= node.data.length) ref = node.nextSibling;
        else ref = node.splitText(off);
    } else { parent = node; ref = node.childNodes[Number(offset) || 0] || null; }
    const br = doc.createElement('br');
    parent.insertBefore(br, ref);
    let after = br.nextSibling;
    while (isText(after) && after.data === '') after = after.nextSibling;
    if (!after) parent.appendChild(doc.createElement('br'));
    return { node: parent, offset: indexIn(parent, br) + 1 };
}
