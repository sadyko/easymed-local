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
// Разрезанное целое, у которого есть «половины» на соседних страницах.
const STRUCT = new Set(['TABLE', 'UL', 'OL']);
// Абзацные блоки: набранное между половинами таблицы или списка (ревью T2).
const PARA = new Set(['DIV', 'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE']);

const isEl = (n) => !!n && n.nodeType === 1;
const isText = (n) => !!n && n.nodeType === 3;
const tagOf = (n) => (isEl(n) ? String(n.tagName).toUpperCase() : '');
const isBr = (n) => tagOf(n) === 'BR';
const isBlock = (n) => BLOCK.has(tagOf(n));
// DOC_RICH_FORMAT_V1 (ревью T2, HIGH) — метка курсора — «ничего» для разреза и
// слияния: она не строка, не блок и не сосед половины. Иначе курсор на уровне
// поля (↓ из последней ячейки, щелчок справа от таблицы) сам становился
// «последним блоком» части, слияние не узнавало пару, и таблица навсегда
// делилась надвое — в форме две таблицы, у ol нумерация с 1.
const isMark = (n) => isEl(n) && n.hasAttribute(CARET_MARK);
// «Ничего»: пустой текст, комментарий, метка курсора — не строка и не блок.
const isNothing = (n) => !n || (!isEl(n) && !isText(n)) || (isText(n) && n.data === '') || isMark(n);
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
        if (!isEl(n) || isMark(n)) continue;   // ревью T2 — метка курсора не оформление
        if (!LINES_ONLY.has(tagOf(n)) || fieldIsRich(n)) return true;
    }
    return false;
}

/**
 * Начала «строк» контейнера по порядку: блок — сам себе строка; строчное
 * (текст, жирный, цвет…) — до <br> включительно. Пробел между блоками строкой
 * не считается: он остаётся с предыдущим блоком, а перед строчным — начинает его.
 * Метка курсора (ревью T2) — так же: перед строкой она едет с ней, перед блоком
 * остаётся с предыдущим; ни строкой, ни блоком она не бывает.
 */
function unitStarts(box) {
    const out = [];
    let inRun = false;
    let lead = null;
    for (let n = box.firstChild; n; n = n.nextSibling) {
        if (isMark(n) || isWs(n)) { if (!inRun && !lead) lead = n; continue; }
        if (isNothing(n)) continue;
        if (isBlock(n)) { out.push(n); inRun = false; lead = null; continue; }
        if (!inRun) { out.push(lead || n); inRun = true; lead = null; }
        if (isBr(n)) inRun = false;
    }
    return out;
}

/** Строки таблицы: заголовок (thead или ведущие строки из одних th) и строки данных. */
export function tableParts(table) {
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
 *
 * DOC_RICH_FORMAT_V1 (ревью T2, MEDIUM 1) — между половинами таблицы или
 * списка могли набрать текст или нажать Enter (за половиной на странице 1,
 * перед продолжением на странице 2). Пару это не прячет: слияние смотрит сквозь
 * такое (текст, строчное, абзацы без списков и таблиц); пустое выбрасывается,
 * написанное встаёт после целой таблицы или списка. Метка курсора оттуда — в
 * шов: в конец последней ячейки (пункта) страницы 1 или в начало первой
 * ячейки (пункта) страницы 2 — курсор остаётся на той же странице.
 */
export function joinCont(target, src, mode = 'rich') {
    if (!target || !src) return;
    const copy = leadCopy(src);
    const partner = copy ? tailPartner(target, copy) : null;
    if (copy && partner) {
        const tail = [];
        while (partner.nextSibling) tail.push(target.removeChild(partner.nextSibling));
        const lead = [];
        while (src.firstChild && src.firstChild !== copy) lead.push(src.removeChild(src.firstChild));
        for (const h of elementKids(copy)) if (h.hasAttribute(CONT_HEAD)) copy.removeChild(h);
        for (const m of tail) if (isMark(m)) putMark(m, partner, true);
        for (const m of lead) if (isMark(m)) putMark(m, copy, false);
        joinCont(partner, copy, 'rich');
        copy.remove();
        for (const n of tail) if (!isMark(n) && !isEmptyStray(n)) target.appendChild(n);
        // набранное на странице 1 и на странице 2 — разные строки
        const kept = lead.filter((n) => !isMark(n) && !isEmptyStray(n));
        const tl = lastReal(target);
        if (kept.length && isInline(kept[0]) && isInline(tl) && !isBr(tl)) target.appendChild(target.ownerDocument.createElement('br'));
        for (const n of kept) target.appendChild(n);
    } else if (copy) unmark(copy);
    const first = firstReal(src);
    const last = lastReal(target);
    if (first && last && isInline(first) && isInline(last) && (mode === 'text' || !isBr(last))) {
        target.appendChild(target.ownerDocument.createElement('br'));
    }
    while (src.firstChild) {
        const n = src.firstChild;
        if (isEl(n) && n.hasAttribute(CONT_SPLIT)) unmark(n);   // копия не в начале — своё целое, без меток
        target.appendChild(n);
    }
}
// Набранное между половинами: текст, строчное, <br>, абзац без списков и таблиц.
// Копия половины (CONT_SPLIT) — никогда не «между».
function isStray(n) {
    if (isNothing(n) || isText(n)) return true;
    if (!isEl(n) || n.hasAttribute(CONT_SPLIT)) return false;
    if (!isBlock(n)) return true;
    return PARA.has(tagOf(n)) && !hasStruct(n);
}
function hasStruct(el) {
    for (const k of elementKids(el)) if (STRUCT.has(tagOf(k)) || hasStruct(k)) return true;
    return false;
}
function isEmptyStray(n) {
    if (isMark(n)) return false;
    if (isNothing(n) || isBr(n) || isWs(n)) return true;
    if (!isEl(n)) return false;
    return !String(n.textContent || '').trim() && !hasStruct(n) && !findMarks(n).length;
}
// Копия-половина в начале продолжения (перед ней может стоять набранное).
function leadCopy(src) {
    for (let n = src.firstChild; n; n = n.nextSibling) {
        if (isEl(n) && n.hasAttribute(CONT_SPLIT)) return n;
        if (!isStray(n)) return null;
    }
    return null;
}
// Её оригинал в конце части: у таблицы и списка — сквозь набранное после них;
// у div/p/tbody — только последний блок (их строки — сами «набранное»).
function tailPartner(target, copy) {
    const tag = tagOf(copy);
    if (!STRUCT.has(tag)) { const l = lastReal(target); return isEl(l) && tagOf(l) === tag ? l : null; }
    for (let n = target.lastChild; n; n = n.previousSibling) {
        if (isEl(n) && tagOf(n) === tag) return n;
        if (!isStray(n)) return null;
    }
    return null;
}
// Ячейка (пункт) на краю таблицы или списка: последняя строка/пункт или первая
// строка данных/пункт; col — колонка (−1 — крайняя по направлению).
function edgeBox(struct, atEnd, col = -1) {
    let box = struct;
    for (let i = 0; i < 64 && isEl(box); i += 1) {
        const t = tagOf(box);
        let next = null;
        if (t === 'TABLE') {
            const { head, body } = tableParts(box);
            const rows = body.length ? body : head;
            const row = atEnd ? rows[rows.length - 1] : rows[0];
            if (row) {
                const cells = elementKids(row).filter((c) => tagOf(c) === 'TD' || tagOf(c) === 'TH');
                next = cells.length ? cells[col >= 0 ? Math.min(col, cells.length - 1) : (atEnd ? cells.length - 1 : 0)] : row;
            }
        } else if (t === 'UL' || t === 'OL') {
            const its = elementKids(box);
            next = (atEnd ? its[its.length - 1] : its[0]) || null;
        }
        if (!next) return box;
        box = next;
    }
    return box;
}
function putMark(m, struct, atEnd) {
    const box = edgeBox(struct, atEnd);
    if (!atEnd) { box.insertBefore(m, box.firstChild); return; }
    const lc = box.lastChild;
    if (isBr(lc)) box.insertBefore(m, lc); else box.appendChild(m);
}
// Курсор на краю ячейки: в её первом/последнем тексте.
function caretIn(box, atEnd) {
    const texts = [];
    const walk = (e) => { for (let n = e.firstChild; n; n = n.nextSibling) { if (isText(n) && n.data !== '') texts.push(n); else if (isEl(n) && !isMark(n)) walk(n); } };
    walk(box);
    if (!texts.length) return { node: box, offset: 0 };
    const t = atEnd ? texts[texts.length - 1] : texts[0];
    return { node: t, offset: atEnd ? t.data.length : 0 };
}
function topIndex(host, node) {
    let n = node;
    while (n && n.parentNode !== host) n = n.parentNode;
    if (!n) return -1;
    let i = 0;
    for (let k = host.firstChild; k && k !== n; k = k.nextSibling) i += 1;
    return i;
}
function indexIn(host, child) { let i = 0; for (let k = host.firstChild; k && k !== child; k = k.nextSibling) i += 1; return i; }

/**
 * DOC_RICH_FORMAT_V1 (ревью T2, MEDIUM 1) — КУРСОР В ПРОМЕЖУТКЕ МЕЖДУ ПОЛОВИНАМИ.
 * Заголовок продолжения не правится (contenteditable=false), и ↑ из первой строки
 * страницы 2 выводит курсор из таблицы — в начало продолжения; ↓ из последней
 * строки страницы 1 — за таблицу. Набранное там встало бы между половинами.
 * Если курсор (node, offset) стоит в таком промежутке, вернуть место в
 * соседней части: dir 'back' (↑/←) — в последнюю строку (пункт) предыдущей
 * части, 'fwd' (↓/→) — в первую строку данных (пункт) следующей, 'stay'
 * (щелчок) — в свою половину; col — колонка таблицы (−1 — крайняя ячейка).
 * @returns {{node: Node, offset: number, host: Element}|null}
 */
export function gapCaret(parts, node, offset, dir = 'stay', col = -1) {
    const list = (parts || []).filter(Boolean);
    const i = list.findIndex((p) => p === node || (p.contains && p.contains(node)));
    if (i < 0 || !node) return null;
    const host = list[i];
    const pos = node === host ? Number(offset) || 0 : topIndex(host, node);
    // за половиной, которая продолжается в следующей части
    const tailS = lastReal(host);
    const next = list[i + 1];
    const nextC = next && firstReal(next);
    if (isEl(tailS) && STRUCT.has(tagOf(tailS)) && isEl(nextC) && nextC.hasAttribute(CONT_SPLIT) && tagOf(nextC) === tagOf(tailS)
        && !tailS.contains(node) && pos > indexIn(host, tailS)) {
        return dir === 'fwd' ? { ...caretIn(edgeBox(nextC, false, col), false), host: next } : { ...caretIn(edgeBox(tailS, true, col), true), host };
    }
    // перед продолжением половины в начале этой части
    const headC = firstReal(host);
    const prev = list[i - 1];
    const prevS = prev && lastReal(prev);
    if (i > 0 && isEl(headC) && headC.hasAttribute(CONT_SPLIT) && STRUCT.has(tagOf(headC)) && isEl(prevS) && tagOf(prevS) === tagOf(headC)
        && !headC.contains(node) && (node === host ? pos <= indexIn(host, headC) : pos < indexIn(host, headC))) {
        return dir === 'back' ? { ...caretIn(edgeBox(prevS, true, col), true), host: prev } : { ...caretIn(edgeBox(headC, false, col), false), host };
    }
    return null;
}

/**
 * DOC_RICH_FORMAT_V1 (ревью T2, MEDIUM 1) — ШАГ ЧЕРЕЗ ШОВ. Части поля — разные
 * правимые области, и стрелка браузера между ними не ходит: в первом пункте
 * продолжения ↑ и ← на краю курсор не двигают, в последнем пункте половины на
 * странице 1 ↓ и → — тоже. Если стрелка курсор не сдвинула и он стоит в
 * крайней строке (пункте) половины, у которой есть пара, — место в соседней
 * части: 'back' — последняя строка (пункт) предыдущей, 'fwd' — первая строка
 * данных (пункт) следующей; col — колонка (−1 — крайняя ячейка).
 * @returns {{node: Node, offset: number, host: Element}|null}
 */
export function edgeHop(parts, node, dir, col = -1) {
    const list = (parts || []).filter(Boolean);
    const i = list.findIndex((p) => p === node || (p.contains && p.contains(node)));
    if (i < 0 || !node) return null;
    const host = list[i];
    if (dir === 'back' && i > 0) {
        const c = firstReal(host);
        const prev = list[i - 1];
        const p = lastReal(prev);
        if (isEl(c) && c.hasAttribute(CONT_SPLIT) && STRUCT.has(tagOf(c)) && isEl(p) && tagOf(p) === tagOf(c)) {
            const edge = edgeItem(c, false);
            if (edge && edge.contains(node)) return { ...caretIn(edgeBox(p, true, col), true), host: prev };
        }
    }
    if (dir === 'fwd' && i < list.length - 1) {
        const s = lastReal(host);
        const next = list[i + 1];
        const n = firstReal(next);
        if (isEl(s) && STRUCT.has(tagOf(s)) && isEl(n) && n.hasAttribute(CONT_SPLIT) && tagOf(n) === tagOf(s)) {
            const edge = edgeItem(s, true);
            if (edge && edge.contains(node)) return { ...caretIn(edgeBox(n, false, col), false), host: next };
        }
    }
    return null;
}
// Крайняя строка таблицы (данных — у начала) или крайний пункт списка.
function edgeItem(struct, atEnd) {
    if (tagOf(struct) === 'TABLE') {
        const { head, body } = tableParts(struct);
        const rows = body.length ? body : head;
        return (atEnd ? rows[rows.length - 1] : rows[0]) || null;
    }
    const its = elementKids(struct);
    return (atEnd ? its[its.length - 1] : its[0]) || null;
}

/**
 * DOC_RICH_FORMAT_V1 (T3) — ВСЕ ПОЛОВИНЫ разрезанного целого (таблицы,
 * списка) по порядку страниц: оригинал и его копии [data-cont-split] в
 * следующих частях поля. Те же правила пары, что у слияния (leadCopy /
 * tailPartner), — значит, ровно то, что слияние соберёт в одно целое.
 * Неразрезанное — [struct].
 */
export function splitChain(struct, parts) {
    const list = (parts || []).filter(Boolean);
    const partOf = (el) => list.findIndex((p) => p === el || (p.contains && p.contains(el)));
    let cur = struct;
    let i = partOf(cur);
    if (i < 0 || !isEl(cur)) return [struct];
    for (let guard = 0; guard < 500 && i > 0 && cur.hasAttribute(CONT_SPLIT) && leadCopy(list[i]) === cur; guard += 1) {
        const p = tailPartner(list[i - 1], cur);
        if (!p) break;
        cur = p; i -= 1;
    }
    const out = [cur];
    for (let j = i; j < list.length - 1; j += 1) {
        const c = leadCopy(list[j + 1]);
        if (!c || tagOf(c) !== tagOf(cur) || tailPartner(list[j], c) !== out[out.length - 1]) break;
        out.push(c);
    }
    return out;
}

/**
 * Метки курсора из `from` — в конец `to` (пустое продолжение выбрасывается при
 * слиянии, а курсор врача в нём не должен пропасть).
 */
export function keepMarks(from, to) {
    if (!from || !to) return;
    for (const m of findMarks(from)) to.appendChild(m);
}

/**
 * DOC_RICH_FORMAT_V1 (ревью T2, MEDIUM 2) — «\n» текста поля pre-wrap — <br>.
 * Лист рисует простой текст раздела одним текстовым узлом с «\n» (pre-wrap);
 * стоит врачу выделить слово жирным, поле — разметка, и разрезу не за что
 * зацепиться: «строк» в нём одна. На экране «\n» и <br> в pre-wrap — одно и то
 * же, и форма пишет «\n» таких полей <br> (то же правило) — поле не меняется.
 * @returns {number} сколько <br> поставлено
 */
export function breakLines(el) {
    if (!el) return 0;
    const doc = el.ownerDocument;
    const texts = [];
    const walk = (e) => { for (let n = e.firstChild; n; n = n.nextSibling) { if (isText(n)) { if (n.data.indexOf('\n') > -1) texts.push(n); } else if (isEl(n) && !isMark(n)) walk(n); } };
    walk(el);
    let made = 0;
    for (const t of texts) {
        const p = t.parentNode;
        const ref = t.nextSibling;
        const pieces = t.data.split(/\r?\n/);
        t.data = pieces[0];
        for (let k = 1; k < pieces.length; k += 1) {
            p.insertBefore(doc.createElement('br'), ref);
            made += 1;
            if (pieces[k]) p.insertBefore(doc.createTextNode(pieces[k]), ref);
        }
        if (!t.data) p.removeChild(t);
    }
    return made;
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
