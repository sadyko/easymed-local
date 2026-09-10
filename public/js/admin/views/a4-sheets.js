// A4_SHEETS_V1 (2026-09-10) — ДОКУМЕНТ ОТДЕЛЬНЫМИ ЛИСТАМИ A4.
//
// Владелец: «documents and the lab and the doctors profile protocol document is
// printing as one looong document, can we treat them as a4 list, in the printing
// and in the ui. so when user writes, separate a4 list is created not dotted
// line with text "here is second page"».
//
// ЧТО БЫЛО. Лист на экране был один и бесконечный, а место разрыва отмечала
// полоса с подписью «СТРАНИЦА 2» (a4-paginate.js) — то есть пунктир поперёк
// бумаги, которой на бумаге нет. Хуже того, для истории болезни расчёт вообще
// не работал: он считал ПРЯМЫХ детей листа, а их у него двое — шапка и тело
// целиком. Разрыв поэтому вставал ПЕРЕД телом, и первая страница выходила
// пустой: шапка, полоса, и весь документ на второй.
//
// ЧТО СТАЛО. Листов столько, сколько страниц: каждый — своя белая бумага со
// своими полями и тенью, между ними пусто. Блоки раскладываются по листам
// измерением, а раздел, который не помещается целиком, ДЕЛИТСЯ по границам
// своих абзацев: конец уезжает на следующий лист и остаётся редактируемым.
//
// ГДЕ ЖИВЁТ ПРАВДА ДОКУМЕНТА. В исходном поле раздела — том, которое читает
// редактор при сохранении. Продолжение на следующем листе это ВТОРОЕ ОКНО В ТО
// ЖЕ ПОЛЕ, а не вторая запись: перед сохранением и печатью раскладка
// «схлопывается» (flush) — хвосты возвращаются в свои поля, и редактор читает
// целое. Без этого шага текст со второй страницы не дошёл бы до сервера, и
// узналось бы это через месяц, когда документ понадобился.
//
// ЧЕГО ЗДЕСЬ НЕТ. Перекладка НЕ ИДЁТ, пока курсор внутри листа: перенос узла с
// кареткой сбрасывает набор на полуслове. Лист, в котором сейчас пишут, растёт
// ниже своей страницы, а раскладывается по листам, как только из него ушли.

/** Высота листа A4 при 96 dpi и его поля — те же числа, что в .a4-paper. */
export const A4_H = 1123;
export const A4_PAD = 48;

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** Высота блока с его внешними отступами — тем, что он занимает на бумаге. */
function outer(el) {
    if (!el || !el.getBoundingClientRect) return 0;
    const r = el.getBoundingClientRect();
    const cs = typeof getComputedStyle === 'function' ? getComputedStyle(el) : null;
    return num(r.height) + (cs ? num(parseFloat(cs.marginTop)) + num(parseFloat(cs.marginBottom)) : 0);
}

/** Тело листа: контейнер, в котором лежат блоки документа. */
function bodyOf(sheet) {
    return sheet.querySelector('.a4-flow');
}

function newSheet(doc, cls) {
    const body = doc.createElement('div');
    body.className = 'a4-flow ' + cls;
    const paper = doc.createElement('div');
    paper.className = 'a4-paper a4-paper-next';
    paper.appendChild(body);
    return paper;
}

/**
 * СХЛОПНУТЬ ПРОДОЛЖЕНИЯ. Хвост, уехавший на следующий лист, возвращается в своё
 * поле; листы, кроме первого, исчезают. После этого документ снова один поток —
 * ровно тот, который читают сохранение и печать.
 */
export function flushA4Sheets(stack) {
    if (!stack || !stack.querySelectorAll) return;
    for (const cont of [...stack.querySelectorAll('[data-a4-cont]')]) {
        const key = cont.getAttribute('data-a4-cont');
        const primary = stack.querySelector('[data-a4-field="' + key + '"]');
        if (primary) {
            while (cont.firstChild) primary.appendChild(cont.firstChild);
        }
        const wrap = cont.closest ? cont.closest('.a4-cont-wrap') : null;
        (wrap || cont).remove();
    }
    // Всё содержимое возвращается на первый лист, лишние листы уходят.
    const sheets = [...stack.querySelectorAll('.a4-paper')];
    const first = sheets[0];
    if (!first) return;
    const firstBody = bodyOf(first);
    for (const sh of sheets.slice(1)) {
        const b = bodyOf(sh);
        if (b && firstBody) while (b.firstChild) firstBody.appendChild(b.firstChild);
        sh.remove();
    }
}

/**
 * Разделить блок по границам его абзацев.
 *
 * Делится ТОЛЬКО редактируемое поле раздела и только между его детьми: резать
 * абзац посередине значит резать предложение, а предложение, разорванное
 * пополам, читается как ошибка ввода, а не как перенос страницы.
 *
 * @returns {Node|null} блок-продолжение, если делить было чем
 */
function splitBlock(doc, block, avail) {
    const field = block.querySelector ? block.querySelector('[data-a4-field]') : null;
    if (!field || !field.children || field.children.length < 2) return null;
    const key = field.getAttribute('data-a4-field');
    const kids = [...field.children];

    // Сколько абзацев влезает: элементы переносятся во временный хвост, пока
    // блок не станет ниже остатка страницы.
    const tail = [];
    while (field.children.length > 1 && outer(block) > avail) {
        const last = field.lastElementChild;
        tail.unshift(last);
        field.removeChild(last);
    }
    if (!tail.length) return null;
    if (!field.children.length) {                 // не влез даже первый абзац
        for (const el of tail) field.appendChild(el);
        return null;
    }

    const contField = doc.createElement(field.tagName);
    contField.className = field.className;
    contField.setAttribute('data-a4-cont', key);
    if (field.getAttribute('contenteditable')) contField.setAttribute('contenteditable', 'true');
    for (const el of tail) contField.appendChild(el);

    const wrap = doc.createElement('div');
    wrap.className = 'a4-cont-wrap ' + (block.className || '');
    wrap.appendChild(contField);
    void kids;
    return wrap;
}

/**
 * РАЗЛОЖИТЬ ДОКУМЕНТ ПО ЛИСТАМ.
 *
 * @param {HTMLElement} stack контейнер с первым листом (.a4-paper)
 * @returns {number} сколько листов вышло
 */
export function layoutA4Sheets(stack) {
    if (!stack || !stack.querySelector) return 1;
    const doc = stack.ownerDocument || document;
    flushA4Sheets(stack);

    const first = stack.querySelector('.a4-paper');
    if (!first) return 1;
    const body = bodyOf(first);
    if (!body) return 1;
    const cls = String(body.className || '').replace('a4-flow', '').trim();

    // Ёмкость листа: высота бумаги без верхнего и нижнего полей. У первого
    // листа её ещё уменьшает шапка бланка — она часть страницы, а не документа.
    const cap = A4_H - A4_PAD * 2;
    const head = first.querySelector('.a4-lh');
    let used = head ? outer(head) : 0;
    let sheet = first;
    let flow = body;
    let pages = 1;

    for (const block of [...body.children]) {
        if (block.parentNode !== flow) flow.appendChild(block);
        const bh = outer(block);
        if (bh <= 0) continue;                    // не измерено — не гадаем
        if (used + bh <= cap) { used += bh; continue; }

        // Блок не помещается: сперва пробуем разделить его по абзацам.
        const cont = used < cap - 60 ? splitBlock(doc, block, cap - used) : null;
        const next = newSheet(doc, cls);
        sheet.parentNode.insertBefore(next, sheet.nextSibling);
        sheet = next; flow = bodyOf(next); pages += 1;
        if (cont) {
            flow.appendChild(cont);
            used = outer(cont);
        } else {
            flow.appendChild(block);
            used = outer(block);
        }
        // Раздел выше целой страницы делить дальше нечем: он остаётся на своём
        // листе и растягивает его. На бумаге браузер разложит его по строкам —
        // здесь честнее показать это, чем обрезать написанное.
    }
    return pages;
}

/**
 * Следить за документом и держать листы верными.
 *
 * @returns {{dispose:Function, flush:Function}}
 */
export function setupA4Sheets(host, { delay = 220 } = {}) {
    const stack = host && host.querySelector ? host : null;
    if (!stack) return { dispose: () => {}, flush: () => {} };
    let timer = null;
    const timers = [];
    let obs = null;

    const typingInside = () => {
        const el = typeof document !== 'undefined' ? document.activeElement : null;
        return !!(el && stack.contains && stack.contains(el) && el !== stack);
    };
    const run = () => {
        if (!stack.isConnected) return;
        // Пока пишут — не трогаем: перенос узла с кареткой обрывает набор.
        if (typingInside()) return;
        layoutA4Sheets(stack);
    };
    const sched = () => { clearTimeout(timer); timer = setTimeout(run, delay); };

    if (typeof ResizeObserver !== 'undefined') { obs = new ResizeObserver(sched); obs.observe(stack); }
    if (stack.addEventListener) {
        stack.addEventListener('input', sched);
        // Ушли из поля — раскладываем немедленно: именно этого и ждут, дописав
        // абзац и щёлкнув мимо.
        stack.addEventListener('focusout', () => { clearTimeout(timer); timer = setTimeout(run, 60); });
    }
    // Лист наполняется в два приёма: разметка сразу, данные — ответом сервера.
    timers.push(setTimeout(run, 320), setTimeout(run, 1100));

    return {
        dispose: () => {
            clearTimeout(timer);
            for (const t of timers) clearTimeout(t);
            if (obs) { try { obs.disconnect(); } catch (e) { /* нечего отменять */ } }
        },
        // Перед сохранением и печатью: хвосты возвращаются в свои поля.
        flush: () => { try { flushA4Sheets(stack); } catch (e) { /* документ уже снят с экрана */ } },
    };
}
