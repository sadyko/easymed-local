// DOC_RICH_FORMAT_V1 (T2, правило F5) — РАЗДЕЛ С ОФОРМЛЕНИЕМ ДЕЛИТСЯ ПО
// СТРАНИЦАМ БЛАНКА УЗЛАМИ, А НЕ ТЕКСТОМ.
//
// Бланк кабинета (service-workspace.js, A4_TEXT_SPLIT_V1) делит раздел, который
// пересёк границу листа A4: что влезло — остаётся в поле [data-field], остальное
// уходит в продолжение [data-cont-of] на следующей странице. Делил он через
// innerText — и список, таблица, жирный, цвет становились строками текста, а
// потом эти строки уходили в форму и в notes.
//
// Здесь — то же для разметки:
//   - МЕСТА РАЗРЕЗА: между верхними блоками поля (абзац, список, таблица, строка
//     текста до <br>); внутри ul/ol — между пунктами; внутри таблицы — между
//     строками данных (со второй: заголовок без строк не остаётся); внутри
//     div/p/blockquote — между их строками и блоками. Слово и ячейка не режутся.
//   - РАЗРЕЗ ПЕРЕНОСИТ ТЕ ЖЕ УЗЛЫ. У предков разреза остаётся их часть, а
//     продолжение получает их неглубокие копии с меткой data-cont-split: тот же
//     вид списка (у ol — start: нумерация продолжается), та же таблица (тот же
//     класс) с повтором заголовка (data-cont-head, contenteditable=false —
//     заголовок правится на первой странице).
//   - СЛИЯНИЕ (joinCont) — точная обратная операция: копия с меткой
//     растворяется в своём оригинале, повтор заголовка выбрасывается. Поэтому
//     проход «слить → разрезать» сколько угодно раз даёт одно и то же, без
//     лишних заголовков и пустых списков.
//   - Блок, который не влез, уезжает целиком; блок выше целой страницы
//     (tooTall) остаётся, где был — разреза нет.
//   - КУРСОР — метка в DOM (пустой span data-caret-mark): она переезжает
//     вместе со своим текстом, а смещение по тексту после переноса узлов врёт.
//
// Ни document, ни window: всё через ownerDocument узлов. Модуль проверяется в
// Node на маленьком DOM (__tests__/mini-dom.mjs); высоту меряет вызывающий
// (fits, tooTall) — модуль только кладёт узлы.

export const CONT_SPLIT = 'data-cont-split';
export const CONT_HEAD = 'data-cont-head';
export const CARET_MARK = 'data-caret-mark';

// Блочные элементы: они сами начинают строку и сами её заканчивают.
const BLOCK = new Set(['DIV', 'P', 'UL', 'OL', 'TABLE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'BLOCKQUOTE', 'PRE', 'HR', 'LI', 'TR', 'TD', 'TH', 'THEAD', 'TBODY', 'TFOOT']);
// Простой текст бланка — только строки: так его делит прежний алгоритм (innerText).
const LINES_ONLY = new Set(['BR', 'DIV', 'P']);
const SECTION = new Set(['THEAD', 'TBODY', 'TFOOT']);
// Блоки, внутри которых тоже ищется место разреза (их строки и вложенные блоки).
const NEST = new Set(['DIV', 'P', 'BLOCKQUOTE']);
// Метка курсора здесь сломала бы разметку (span прямо в списке, строке таблицы, <br>).
const NO_MARK_IN = new Set(['UL', 'OL', 'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'BR', 'HR', 'IMG']);

const isEl = (n) => !!n && n.nodeType === 1;
const isText = (n) => !!n && n.nodeType === 3;
const tagOf = (n) => (isEl(n) ? String(n.tagName).toUpperCase() : '');
const isBr = (n) => tagOf(n) === 'BR';
const isBlock = (n) => BLOCK.has(tagOf(n));
// «Ничего»: пустой текст, комментарий — не строка и не блок.
const isNothing = (n) => !n || (!isEl(n) && !isText(n)) || (isText(n) && n.data === '');
const isWs = (n) => isText(n) && /^[ \t\r\n]+$/.test(n.data);
const isInline = (n) => !isNothing(n) && !isBlock(n);

function firstReal(box) { let n = box.firstChild; while (n && isNothing(n)) n = n.nextSibling; return n; }
function lastReal(box) { let n = box.lastChild; while (n && isNothing(n)) n = n.previousSibling; return n; }
function elementKids(box) { const out = []; for (let n = box.firstChild; n; n = n.nextSibling) if (isEl(n)) out.push(n); return out; }

/**
 * Есть ли в поле оформление: любой элемент, кроме строк (<br>, <div>, <p>).
 * Без него поле — простой текст и делится прежним алгоритмом (A4_TEXT_SPLIT_V1).
 */
export function fieldIsRich(el) {
    if (!el) return false;
    for (let n = el.firstChild; n; n = n.nextSibling) {
        if (!isEl(n)) continue;
        if (!LINES_ONLY.has(tagOf(n)) || fieldIsRich(n)) return true;
    }
    return false;
}

/**
 * Начала «строк» контейнера по порядку: блок — сам себе строка; строчное
 * (текст, жирный, цвет…) — до <br> включительно. Пробел между блоками строкой
 * не считается: он остаётся с предыдущим блоком, а перед строчным — начинает его.
 */
function unitStarts(box) {
    const out = [];
    let inRun = false;
    let ws = null;
    for (let n = box.firstChild; n; n = n.nextSibling) {
        if (isNothing(n)) continue;
        if (isBlock(n)) { out.push(n); inRun = false; ws = null; continue; }
        if (isWs(n)) { if (!inRun && !ws) ws = n; continue; }
        if (!inRun) { out.push(ws || n); inRun = true; ws = null; }
        if (isBr(n)) inRun = false;
    }
    return out;
}

/** Строки таблицы: заголовок (thead или ведущие строки из одних th) и строки данных. */
function tableParts(table) {
    let thead = null;
    const rows = [];
    for (let n = table.firstChild; n; n = n.nextSibling) {
        const t = tagOf(n);
        if (t === 'TR') rows.push(n);
        else if (SECTION.has(t)) {
            if (t === 'THEAD' && !thead) thead = n;
            for (let r = n.firstChild; r; r = r.nextSibling) if (tagOf(r) === 'TR') rows.push(r);
        }
    }
    let head = [];
    if (thead) head = rows.filter((r) => r.parentNode === thead);
    else for (const r of rows) { if (!isHeadRow(r)) break; head.push(r); }
    return { thead, head, body: rows.filter((r) => head.indexOf(r) < 0) };
}
function isHeadRow(r) {
    let cells = 0;
    for (const c of elementKids(r)) { if (tagOf(c) !== 'TH') return false; cells += 1; }
    return cells > 0;
}
// Строка, с которой начинается раздел таблицы, уезжает вместе с разделом:
// пустой tbody на первой странице не остаётся.
function liftRow(r, table) {
    let n = r;
    while (n.parentNode && n.parentNode !== table && firstReal(n.parentNode) === n) n = n.parentNode;
    return n;
}

/**
 * Места разреза поля по порядку документа. Разрез — узел, С КОТОРОГО всё
 * (и всё после него) уезжает в продолжение. Первая строка контейнера местом
 * разреза не бывает: поле и его части не остаются пустыми.
 */
export function blankCuts(field) {
    const out = [];
    if (field) collectCuts(field, out);
    return out;
}
function collectCuts(box, out) {
    unitStarts(box).forEach((u, i) => {
        if (i > 0) out.push(u);
        const t = tagOf(u);
        if (t === 'UL' || t === 'OL') elementKids(u).slice(1).forEach((li) => out.push(li));
        else if (t === 'TABLE') tableParts(u).body.slice(1).forEach((r) => out.push(liftRow(r, u)));
        else if (NEST.has(t)) collectCuts(u, out);
    });
}

/**
 * «Блок» на месте разреза — то, что не делится: у списка — первый пункт, у
 * таблицы — первая строка данных, у div со строками — его первая строка.
 * Его высоту вызывающий сравнивает с целой страницей (tooTall).
 */
export function firstAtom(n) {
    for (let i = 0; i < 64 && isEl(n); i += 1) {
        const t = tagOf(n);
        let next = null;
        if (t === 'UL' || t === 'OL' || SECTION.has(t)) next = elementKids(n)[0] || null;
        else if (t === 'TABLE') next = tableParts(n).body[0] || null;
        else if (NEST.has(t)) { const u = unitStarts(n); next = u.length > 1 ? u[0] : null; }
        if (!next) return n;
        n = next;
    }
    return n;
}

/**
 * Разрезать поле: `cut` и всё после него уезжает в `cont` (пустой элемент
 * продолжения). У каждого предка разреза внутри поля остаётся его часть, а в
 * продолжение идёт его неглубокая копия с меткой CONT_SPLIT (ol — со start,
 * таблица — с повтором заголовка).
 * @returns {boolean} разрезано ли
 */
export function splitAt(field, cut, cont) {
    if (!field || !cut || !cont || cut === field) return false;
    let up = cut.parentNode;
    while (up && up !== field) up = up.parentNode;
    if (!up) return false;
    let from = cut;
    let lead = null;
    let level = cut.parentNode;
    for (;;) {
        const top = level === field;
        const box = top ? cont : level.cloneNode(false);
        if (!top) box.setAttribute(CONT_SPLIT, '1');
        if (lead) box.appendChild(lead);
        for (let n = from; n;) { const nx = n.nextSibling; box.appendChild(n); n = nx; }
        if (top) return true;
        dress(level, box);
        lead = box;
        from = level.nextSibling;
        level = level.parentNode;
    }
}
// Копия предка в продолжении: нумерация ol продолжается, у таблицы — заголовок.
function dress(orig, copy) {
    const t = tagOf(orig);
    if (t === 'OL') {
        let kept = 0;
        for (let n = orig.firstChild; n; n = n.nextSibling) if (tagOf(n) === 'LI') kept += 1;
        const base = parseInt(orig.getAttribute('start'), 10);
        copy.setAttribute('start', String((Number.isFinite(base) ? base : 1) + kept));
    } else if (t === 'TABLE') {
        const head = headCopy(orig);
        for (let i = head.length - 1; i >= 0; i -= 1) copy.insertBefore(head[i], copy.firstChild);
    }
}
function headCopy(table) {
    const { thead, head } = tableParts(table);
    if (!head.length) return [];
    let out;
    if (thead) out = [thead.cloneNode(true)];
    else if (head[0].parentNode === table) out = head.map((r) => r.cloneNode(true));
    else {
        const sec = head[0].parentNode.cloneNode(false);
        sec.removeAttribute(CONT_SPLIT);
        for (const r of head) sec.appendChild(r.cloneNode(true));
        out = [sec];
    }
    for (const h of out) {
        h.setAttribute(CONT_HEAD, '1');
        h.setAttribute('contenteditable', 'false');
        for (const m of findMarks(h)) m.remove();
    }
    return out;
}

/**
 * Слить продолжение `src` обратно в конец `target`: обратная операция к splitAt.
 * Копия с меткой CONT_SPLIT растворяется в своём оригинале (последнем блоке
 * того же тега), повтор заголовка выбрасывается. Нет оригинала (его стёрли на
 * первой странице) — копия остаётся своим блоком, без меток.
 * Между строчными частями ставится <br>: в режиме 'text' (части простого
 * текста — строки, как «\n» раньше) — всегда; в режиме 'rich' — только если
 * <br> в конце первой части стёрт правкой.
 */
export function joinCont(target, src, mode = 'rich') {
    if (!target || !src) return;
    const first = firstReal(src);
    const last = lastReal(target);
    if (first && last && isInline(first) && isInline(last) && (mode === 'text' || !isBr(last))) {
        target.appendChild(target.ownerDocument.createElement('br'));
    }
    if (isEl(first) && first.hasAttribute(CONT_SPLIT)) {
        if (isEl(last) && tagOf(last) === tagOf(first)) {
            while (src.firstChild && src.firstChild !== first) target.appendChild(src.firstChild);
            for (const h of elementKids(first)) if (h.hasAttribute(CONT_HEAD)) first.removeChild(h);
            joinCont(last, first, 'rich');
            first.remove();
        } else unmark(first);
    }
    while (src.firstChild) target.appendChild(src.firstChild);
}
// Копия, которой не с чем слиться, становится обычным блоком: метки сняты у неё
// и у вложенных копий; заголовок таблицы остаётся (он теперь её собственный).
function unmark(el) {
    if (el.hasAttribute(CONT_SPLIT)) {
        el.removeAttribute(CONT_SPLIT);
        if (tagOf(el) === 'OL') el.removeAttribute('start');
    }
    if (el.hasAttribute(CONT_HEAD)) { el.removeAttribute(CONT_HEAD); el.removeAttribute('contenteditable'); }
    for (const k of elementKids(el)) unmark(k);
}

/** Продолжение без содержимого: только <br> и пробелы (Chrome оставляет <br> в пустом поле). */
export function contIsBlank(el) {
    for (let n = el.firstChild; n; n = n.nextSibling) {
        if (isNothing(n) || isBr(n) || isWs(n)) continue;
        return false;
    }
    return true;
}

/**
 * Разрезать поле с оформлением так, чтобы первая часть влезла.
 * fits() — влезает ли поле (в его нынешнем виде) на свою страницу; спрашивается
 * при каждой пробе, между пробами поле сливается обратно (точно).
 * tooTall(узел) — выше ли блок целой страницы: такой блок не переносится.
 * @returns {boolean} true — поле разрезано, продолжение в `cont`; false — поле не тронуто.
 */
export function splitRichField(field, cont, { fits, tooTall } = {}) {
    if (!field || !cont || typeof fits !== 'function') return false;
    const cuts = blankCuts(field);
    if (!cuts.length) return false;
    let lo = 0;
    let hi = cuts.length - 1;
    let best = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        splitAt(field, cuts[mid], cont);
        let ok = false;
        try { ok = !!fits(); } finally { joinCont(field, cont, 'rich'); }
        if (ok) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (best < 0) return false;
    if (typeof tooTall === 'function' && tooTall(firstAtom(cuts[best]))) return false;
    return splitAt(field, cuts[best], cont);
}

/** Режим продолжения: 'rich' — разрезано узлами, 'text' — строками простого текста. */
export function contMode(part) {
    let w = part && part.parentNode;
    for (let i = 0; w && i < 3; i += 1, w = w.parentNode) {
        if (isEl(w) && w.hasAttribute('data-cont-wrap')) return w.getAttribute('data-cont-mode') === 'rich' ? 'rich' : 'text';
    }
    return 'text';
}

/**
 * Поле целиком для формы: копии частей (поле и его продолжения по порядку)
 * сливаются тем же joinCont, что и перед разбивкой, — каждый список и таблица
 * один раз, без повторов заголовка и меток. Живые части не трогаются.
 */
export function mergedFieldClone(parts) {
    const list = (parts || []).filter(Boolean);
    if (!list.length) return null;
    const root = list[0].cloneNode(true);
    for (const p of list.slice(1)) {
        const c = p.cloneNode(true);
        if (!contIsBlank(c)) joinCont(root, c, contMode(p));
    }
    for (const m of findMarks(root)) m.remove();
    return root;
}

// ─── курсор ───────────────────────────────────────────────────────────────────
function findMarks(root) {
    const out = [];
    const walk = (e) => { for (let n = e.firstChild; n; n = n.nextSibling) { if (!isEl(n)) continue; if (n.hasAttribute(CARET_MARK)) out.push(n); else walk(n); } };
    if (isEl(root)) walk(root);
    return out;
}

/**
 * Поставить метку курсора в точку выделения (узел и смещение, как у
 * Selection.anchorNode/anchorOffset). Текстовый узел делится в этой точке.
 * @returns {Element|null} метка; null — в этой точке метку не поставить
 */
export function insertCaretMark(node, offset) {
    if (!node || !node.ownerDocument) return null;
    const mark = node.ownerDocument.createElement('span');
    mark.setAttribute(CARET_MARK, '1');
    if (isText(node)) {
        const p = node.parentNode;
        if (!p) return null;
        const off = Math.max(0, Math.min(Number(offset) || 0, node.data.length));
        if (off === 0) p.insertBefore(mark, node);
        else if (off >= node.data.length) p.insertBefore(mark, node.nextSibling);
        else p.insertBefore(mark, node.splitText(off));
        return mark;
    }
    if (!isEl(node) || NO_MARK_IN.has(tagOf(node))) return null;
    const ref = node.childNodes[Number(offset) || 0] || null;
    node.insertBefore(mark, ref);
    return mark;
}

/**
 * Снять метку курсора: где она стоит — туда курсор ({node, offset}), текстовый
 * узел, разделённый меткой, склеивается обратно. Лишние метки тоже снимаются.
 * @returns {{node: Node, offset: number}|null}
 */
export function takeCaretMark(root) {
    let at = null;
    for (const m of findMarks(root)) {
        const p = m.parentNode;
        if (!p) continue;
        if (at) { m.remove(); continue; }
        const prev = m.previousSibling;
        const next = m.nextSibling;
        if (isText(prev)) {
            at = { node: prev, offset: prev.data.length };
            m.remove();
            if (isText(next)) { prev.appendData(next.data); next.remove(); }
        } else if (isText(next)) {
            at = { node: next, offset: 0 };
            m.remove();
        } else {
            let idx = 0;
            for (let n = p.firstChild; n && n !== m; n = n.nextSibling) idx += 1;
            m.remove();
            at = { node: p, offset: idx };
        }
    }
    return at;
}
