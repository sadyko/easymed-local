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
// DOC_RICH_FORMAT_V1 (ревью T3, HIGH 1) — МЕТКА ПАРЫ. Оригинал и все его копии
// на следующих страницах несут один data-split-id: слияние и операции таблицы
// узнают половины по нему, а не «ближайшая таблица того же тега» (новая
// таблица между половинами забирала себе хвост старой). Метка живёт только
// между раскладками: после слияния она снимается (clearSplitIds), в хранение не
// идёт (очистка пропускает лишь style/class/start).
export const SPLIT_ID = 'data-split-id';
let splitSeq = 0;
const newSplitId = () => 's' + (splitSeq += 1).toString(36) + Math.random().toString(36).slice(2, 6);

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
export function splitAt(field, cut, cont, fresh = null) {
    if (!field || !cut || !cont || cut === field) return false;
    let up = cut.parentNode;
    while (up && up !== field) up = up.parentNode;
    if (!up) return false;
    let from = cut;
    let lead = null;
    let level = cut.parentNode;
    for (;;) {
        const top = level === field;
        // ревью T3 (HIGH 1) — метка пары: оригинал и копия узнают друг друга по ней, не по тегу
        if (!top && !level.getAttribute(SPLIT_ID)) { level.setAttribute(SPLIT_ID, newSplitId()); if (fresh) fresh.push(level); }
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
        h.removeAttribute(SPLIT_ID);
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
 * DOC_RICH_FORMAT_V1 (ревью T2, MEDIUM 1) — между половинами могли нажать
 * Enter или поставить курсор (за половиной на странице 1, перед продолжением
 * на странице 2). Пустое пару не прячет и выбрасывается; метка курсора оттуда —
 * в шов: в конец последней ячейки (пункта) страницы 1 или в начало первой
 * ячейки (пункта) страницы 2 — курсор остаётся на той же странице.
 *
 * DOC_RICH_FORMAT_V1 (ревью T3, MEDIUM 2) — НАПИСАННОЕ между половинами
 * (пункт списка, превращённый в абзац; текст, набранный в промежутке) остаётся
 * на своём месте: половины до и после него — раздельные таблицы и списки, у
 * второго ol нумерация продолжает первый (start). Раньше слияние уносило такой
 * абзац за конец всего списка. Пара — по метке пары (SPLIT_ID), не по тегу.
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
        // между половинами было только пустое (leadCopy/tailPartner) — оно выброшено
    } else if (copy) unmark(copy, target);
    const first = firstReal(src);
    const last = lastReal(target);
    if (first && last && isInline(first) && isInline(last) && (mode === 'text' || !isBr(last))) {
        target.appendChild(target.ownerDocument.createElement('br'));
    }
    while (src.firstChild) {
        const n = src.firstChild;
        if (isEl(n) && n.hasAttribute(CONT_SPLIT)) unmark(n, target);   // копия не в начале — своё целое, без меток
        target.appendChild(n);
    }
}
function hasStruct(el) {
    for (const k of elementKids(el)) if (STRUCT.has(tagOf(k)) || hasStruct(k)) return true;
    return false;
}
// Пустое между половинами: пробелы, <br>, пустой абзац. Таблица и список (и
// пустые) — содержание; метка курсора — не «пустое», её переносят в шов.
function isEmptyStray(n) {
    if (isMark(n)) return false;
    if (isNothing(n) || isBr(n) || isWs(n)) return true;
    if (!isEl(n) || STRUCT.has(tagOf(n)) || n.hasAttribute(CONT_SPLIT)) return false;
    return !String(n.textContent || '').trim() && !hasStruct(n) && !findMarks(n).length;
}
const isGap = (n) => isMark(n) || isEmptyStray(n);
// Пара: тот же тег и та же метка пары; у копии без метки (лист до ревью T3) — тег.
function samePair(n, copy) {
    if (!isEl(n) || !isEl(copy) || tagOf(n) !== tagOf(copy)) return false;
    const id = copy.getAttribute(SPLIT_ID);
    return id ? n.getAttribute(SPLIT_ID) === id : true;
}
// Копия-половина в начале продолжения (перед ней — только пустое).
function leadCopy(src) {
    for (let n = src.firstChild; n; n = n.nextSibling) {
        if (isEl(n) && n.hasAttribute(CONT_SPLIT)) return n;
        if (!isGap(n)) return null;
    }
    return null;
}
// Её оригинал в конце части (после него — только пустое).
function tailPartner(target, copy) {
    for (let n = target.lastChild; n; n = n.previousSibling) {
        if (isGap(n)) continue;
        return samePair(n, copy) ? n : null;
    }
    return null;
}
// Оригинал копии по метке пары где угодно в части (для нумерации разошедшихся списков).
function pairById(target, copy) {
    const id = copy.getAttribute(SPLIT_ID);
    if (!id || !target.querySelectorAll) return null;
    const all = [...target.querySelectorAll('[' + SPLIT_ID + '="' + id + '"]')].filter((e) => e !== copy && tagOf(e) === tagOf(copy));
    return all.length ? all[all.length - 1] : null;
}
/** Снять метки пары во всём поле — после слияния они не нужны (живут только между раскладками). */
export function clearSplitIds(root) {
    if (!root || !root.querySelectorAll) return;
    for (const e of root.querySelectorAll('[' + SPLIT_ID + ']')) e.removeAttribute(SPLIT_ID);
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
    if (isEl(tailS) && STRUCT.has(tagOf(tailS)) && isEl(nextC) && nextC.hasAttribute(CONT_SPLIT) && samePair(tailS, nextC)
        && !tailS.contains(node) && pos > indexIn(host, tailS)) {
        return dir === 'fwd' ? { ...caretIn(edgeBox(nextC, false, col), false), host: next } : { ...caretIn(edgeBox(tailS, true, col), true), host };
    }
    // перед продолжением половины в начале этой части
    const headC = firstReal(host);
    const prev = list[i - 1];
    const prevS = prev && lastReal(prev);
    if (i > 0 && isEl(headC) && headC.hasAttribute(CONT_SPLIT) && STRUCT.has(tagOf(headC)) && samePair(prevS, headC)
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
        if (isEl(c) && c.hasAttribute(CONT_SPLIT) && STRUCT.has(tagOf(c)) && samePair(p, c)) {
            const edge = edgeItem(c, false);
            if (edge && edge.contains(node)) return { ...caretIn(edgeBox(p, true, col), true), host: prev };
        }
    }
    if (dir === 'fwd' && i < list.length - 1) {
        const s = lastReal(host);
        const next = list[i + 1];
        const n = firstReal(next);
        if (isEl(s) && STRUCT.has(tagOf(s)) && isEl(n) && n.hasAttribute(CONT_SPLIT) && samePair(s, n)) {
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
 * Ревью T3 (HIGH 1, MEDIUM 1) — половины узнаются по метке пары: так находится
 * и таблица, вложенная в разрезанный абзац (вставка из Word), и цепочка через
 * несколько страниц. Лист без меток (до ревью T3) — по правилам слияния.
 */
export function splitChain(struct, parts) {
    const list = (parts || []).filter(Boolean);
    const partOf = (el) => list.findIndex((p) => p === el || (p.contains && p.contains(el)));
    let cur = struct;
    let i = partOf(cur);
    if (i < 0 || !isEl(cur)) return [struct];
    const id = cur.getAttribute(SPLIT_ID);
    if (id) {
        const all = [];
        for (const p of list) for (const e of p.querySelectorAll('[' + SPLIT_ID + '="' + id + '"]')) if (tagOf(e) === tagOf(cur)) all.push(e);
        if (all.indexOf(cur) > -1) return all;
    }
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
 * Ревью T3 (HIGH 2) — правило textBreaks (rich-text.js): пробелы и переводы
 * строк МЕЖДУ тегами блоков и таблицы (вставка из Excel и Word: «<tr>\n  <td>»)
 * — не строки документа, их «\n» не трогается; «\n» сразу после <br> —
 * оформление исходника. Иначе таблица из Excel получала по <br> на строку и
 * пустое место на страницу перед собой.
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
        if (!/\S/.test(t.data) && (edgeAt(t, el, 'prev') || edgeAt(t, el, 'next'))) continue;
        if (isBr(t.previousSibling)) t.data = t.data.replace(/^\r?\n/, '');
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
// Тег рядом с текстовым узлом — край блока или таблицы (как BLOCK_EDGE_RE в
// textBreaks): сосед-блок, начало/конец блока-родителя, начало/конец поля.
const EDGE = new Set(['P', 'DIV', 'UL', 'OL', 'LI', 'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TH', 'TD', 'H3', 'H4']);
function edgeAt(t, root, side) {
    const sib = side === 'prev' ? t.previousSibling : t.nextSibling;
    if (sib) return isEl(sib) && EDGE.has(tagOf(sib));
    const p = t.parentNode;
    return p === root || EDGE.has(tagOf(p));
}
// Копия, которой не с чем слиться, становится обычным блоком: метки сняты у неё
// и у вложенных копий; заголовок таблицы остаётся (он теперь её собственный).
// Ревью T3 (MEDIUM 2) — ol, отделённый от своей пары абзацем, продолжает её
// нумерацию (start = начало пары + её пункты); пары нет вовсе — нумерация своя.
// Метка пары остаётся до конца слияния: по ней к этой копии присоединится
// копия со следующей страницы.
function unmark(el, target = null) {
    if (el.hasAttribute(CONT_SPLIT)) {
        el.removeAttribute(CONT_SPLIT);
        if (tagOf(el) === 'OL') {
            const p = target ? pairById(target, el) : null;
            if (p) {
                const base = parseInt(p.getAttribute('start'), 10);
                let n = 0;
                for (const k of elementKids(p)) if (tagOf(k) === 'LI') n += 1;
                el.setAttribute('start', String((Number.isFinite(base) ? base : 1) + n));
            } else el.removeAttribute('start');
        }
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
        const fresh = [];
        splitAt(field, cuts[mid], cont, fresh);
        let ok = false;
        // проба не оставляет следа: и копии, и метки пары, поставленные ею
        try { ok = !!fits(); } finally { joinCont(field, cont, 'rich'); for (const e of fresh) e.removeAttribute(SPLIT_ID); }
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
    clearSplitIds(root);
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
