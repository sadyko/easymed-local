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
