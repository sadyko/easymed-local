// A4_PAGINATE_V1 — РАЗРЫВЫ СТРАНИЦ ПРЯМО В РЕДАКТОРЕ.
//
// Владелец (2026-09-08): «treat every document as a a4 list, with real ui
// breaks in the window of user».
//
// Документ пишут на экране, а отдают на бумаге. Пока лист на экране бесконечен,
// врач узнаёт, что таблица разъехалась по двум страницам, только у принтера.
// Здесь между блоками, которые на бумагу уже не помещаются, встаёт настоящий
// разрыв: полоса с номером следующей страницы и пустота до конца листа — ровно
// та, что будет на бумаге.
//
// ПОЧЕМУ ОБЩИЙ МОДУЛЬ. Тот же расчёт жил внутри кабинета врача
// (service-workspace.js) с ОДНИМ набором переменных на весь модуль. Экраны
// продукта кэшируются панелями (admin.js): кабинет врача и история болезни
// бывают смонтированы одновременно, и один общий наблюдатель на два листа
// пересчитывал бы чужой. Здесь состояние своё у каждого вызова, а вызов
// возвращает функцию отмены.

import { h } from '../ui.js';

/** Высота содержимого A4 при 96 dpi за вычетом полей — то, что влезает на лист. */
export const A4_PAGE_H = 1000;

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

function breakEl(pg, fill, label) {
    return h('div', { class: 'a4-pbreak', contenteditable: 'false', style: { height: Math.round(fill) + 'px' } },
        h('span', { class: 'a4-pbreak-tag' }, label(pg)));
}

/**
 * Расставить разрывы по листу.
 *
 * Считается по НАСТОЯЩИМ блокам: сами разрывы из подсчёта исключены, иначе
 * вставленный разрыв менял бы высоту, а изменение высоты — расстановку
 * разрывов, и лист дрожал бы бесконечно.
 */
export function paginateA4(paper, { pageHeight = A4_PAGE_H, label } = {}) {
    if (!paper || !paper.isConnected) return;
    const kids = () => Array.from(paper.children || []);
    for (const el of kids()) {
        if (el.classList && el.classList.contains && el.classList.contains('a4-pbreak')) el.remove();
    }
    let used = 0;
    let pg = 1;
    const ops = [];
    for (const el of kids()) {
        const cs = typeof getComputedStyle === 'function' ? getComputedStyle(el) : null;
        const box = num(el.offsetHeight) + (cs ? num(parseFloat(cs.marginTop)) + num(parseFloat(cs.marginBottom)) : 0);
        if (box <= 0) continue;   // не измерено (скрытый лист, тест без вёрстки) — не гадаем
        if (used > 0 && used + box > pageHeight) {
            pg += 1;
            ops.push({ before: el, fill: Math.max(pageHeight - used, 28), pg });
            used = box;
        } else {
            used += box;
        }
    }
    for (const op of ops) paper.insertBefore(breakEl(op.pg, op.fill, label), op.before);
    return ops.length + 1;   // сколько страниц вышло
}

/**
 * Следить за листом и держать разрывы верными: правка текста, дозагрузка
 * данных и смена ширины окна меняют высоту блоков.
 *
 * @returns {() => void} отменить слежение
 */
export function setupA4Pagination(root, { pageHeight = A4_PAGE_H, label } = {}) {
    const paper = root && root.querySelector ? root.querySelector('.a4-paper') : null;
    const mark = label || ((pg) => 'Страница ' + pg);   // i18n-exempt: подпись листа ДОКУМЕНТА
    if (!paper) return () => {};
    let sig = '';
    let timer = null;
    const timers = [];
    let obs = null;
    const naturalSig = () => Array.from(paper.children || [])
        .filter((el) => !(el.classList && el.classList.contains && el.classList.contains('a4-pbreak')))
        .map((el) => Math.round(num(el.offsetHeight))).join(',');
    const run = () => {
        const next = naturalSig();
        if (next === sig) return;   // изменились только наши разрывы — пересчёт не нужен
        sig = next;
        paginateA4(paper, { pageHeight, label: mark });
    };
    const sched = () => { clearTimeout(timer); timer = setTimeout(run, 200); };
    if (typeof ResizeObserver !== 'undefined') { obs = new ResizeObserver(sched); obs.observe(paper); }
    if (paper.addEventListener) paper.addEventListener('input', sched);
    // Лист наполняется в два приёма: разметка сразу, данные — ответом сервера.
    timers.push(setTimeout(run, 350), setTimeout(run, 1200));
    return () => {
        clearTimeout(timer);
        for (const t of timers) clearTimeout(t);
        if (obs) { try { obs.disconnect(); } catch (e) { /* нечего отменять */ } }
    };
}

// ---------------------------------------------------------------------------
// FORM_003_ONE_PAGE_V1 — ЛИСТ, КОТОРЫЙ ОБЯЗАН БЫТЬ ОДНОЙ СТРАНИЦЕЙ
// ---------------------------------------------------------------------------
// Владелец (2026-09-08), дважды: «make title list content fin in to one a4»,
// «its still too big of content for a4».
//
// Бланк 003 — не «документ произвольной длины», это ОДИН лист утверждённой
// формы: тридцать строк, и на бумаге они умещаются. На экране высота строки
// зависит от того, перенеслось ли длинное значение, а перенос зависит от
// имени пациента и адреса — то есть от пациента. Никакая правка отступов не
// даёт гарантии: на одном пациенте лист влезает, на другом нет.
//
// Поэтому здесь ЗАМЕР, а не расчёт. Содержимое листа измеряется как есть, и
// если оно выше страницы — уменьшается ровно настолько, чтобы влезть. Ниже
// порога не уменьшаем: нечитаемый лист хуже двух страниц, и тогда честнее
// показать, что бланк переполнен.
//
// zoom, а не transform: transform оставил бы прежнее место в потоке, и под
// уменьшенным листом висела бы пустота его прежней высоты. Тот же приём уже
// используется для листа в кабинете врача.
export const A4_FIT_MIN = 0.75;

export function fitA4Content(paper, { min = A4_FIT_MIN } = {}) {
    if (!paper || !paper.querySelector) return 1;
    const inner = paper.querySelector('.f3') || paper.firstElementChild;
    if (!inner || !inner.style) return 1;
    inner.style.zoom = '';
    if (typeof getComputedStyle !== 'function') return 1;
    const cs = getComputedStyle(paper);
    const pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    const box = (paper.clientHeight || 0) - pad;
    const need = inner.scrollHeight || 0;
    if (box <= 0 || need <= 0 || need <= box) return 1;
    const z = Math.max(min, Math.floor((box / need) * 1000) / 1000);
    inner.style.zoom = String(z);
    return z;
}

/**
 * Держать лист одной страницей, пока его правят.
 * @returns {() => void} отменить слежение
 */
export function setupA4Fit(root, opts = {}) {
    const paper = root && root.querySelector ? root.querySelector('.a4-paper') : null;
    if (!paper) return () => {};
    let timer = null;
    const timers = [];
    let obs = null;
    const run = () => fitA4Content(paper, opts);
    const sched = () => { clearTimeout(timer); timer = setTimeout(run, 160); };
    if (typeof ResizeObserver !== 'undefined') { obs = new ResizeObserver(sched); obs.observe(paper); }
    if (paper.addEventListener) { paper.addEventListener('input', sched); paper.addEventListener('change', sched); }
    // Лист наполняется в два приёма: разметка сразу, данные — ответом сервера.
    timers.push(setTimeout(run, 120), setTimeout(run, 500), setTimeout(run, 1400));
    return () => {
        clearTimeout(timer);
        for (const t of timers) clearTimeout(t);
        if (obs) { try { obs.disconnect(); } catch (e) { /* нечего отменять */ } }
    };
}
