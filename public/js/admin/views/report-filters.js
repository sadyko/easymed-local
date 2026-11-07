// REPORTS_TAX_PAY_V1 (владелец, 2026-11-07) — ФИЛЬТРЫ ОКНА ОТЧЁТА ДО ВЫГРУЗКИ.
//
// «Фильтры в окне отчёта применяются ДО скачивания Excel: например, только
// пациенты, оплатившие картой → Excel». Фильтр — обычный вариант конструктора
// отчётов (option в REPORT_DEFS, reports-hub.js): он уезжает аргументом в
// run_report / cashier_report, отбор делает СЕРВЕР, и на экран, в «Итого» и в
// Excel идёт одна и та же выборка. Смена фильтра сбрасывает результат —
// прежняя таблица не уйдёт в файл под новыми фильтрами.
//
// Здесь — определения пяти общих фильтров и две чистые функции: какие фильтры
// выбраны (строка над таблицей) и как это записать в имя файла. Модуль чистый
// (без DOM и i18n): перевод приходит параметром tx, проверяется тестом в node.
import { METHOD_RU, NON_CASH_INFLOW } from '../../shared/payment-methods.js';

// Способ оплаты: словарь кассы и «Не оплачено» (остаток счёта). Пусто — все.
export const PAY_FILTER_CHOICES = [
    ['', 'Все способы'],
    ...Object.entries(METHOD_RU),
    ['unpaid', 'Не оплачено'],
];
// static: варианты известны браузеру — список с сервера не спрашивается.
export const F_PAY = { arg: 'pay_method', label: 'Способ оплаты', type: 'select', static: true, choices: PAY_FILTER_CHOICES };
// REPORTS_TAX_PAY_V1 (ревью S2 L2) — «Отчёт кассира» считает только приход денег (INFLOW_SQL): «Кошелёк» и
// «Подарочная карта» — не приход, выбор их всегда давал пустой отчёт. Здесь их нет.
export const F_PAY_INFLOW = { ...F_PAY, choices: PAY_FILTER_CHOICES.filter(([v]) => !NON_CASH_INFLOW.includes(v)) };
// Кассир, врач, группа пациентов — списки клиники (report_choices, за воротами отчёта).
export const F_CASHIER = { arg: 'cashier_id', label: 'Кассир', type: 'select', choices: [['', 'Все кассиры']] };
export const F_DOCTOR = { arg: 'doctor_id', label: 'Врач', type: 'select', choices: [['', 'Все врачи']] };
export const F_PATIENT_GROUP = { arg: 'patient_group', label: 'Группа пациентов', type: 'select', choices: [['', 'Все группы пациентов']] };
// Группа услуги — одна из пяти групп каталога (services.type), как у «По услугам».
export const F_GROUP = {
    arg: 'group', label: 'Группа услуг', type: 'select', static: true,
    choices: [['', 'Все группы'], ['consultation', 'Консультации'], ['lab', 'Лаборатория'], ['imaging', 'Диагностика'], ['procedure', 'Процедуры'], ['other', 'Хирургия']],
};

export function isStaticOption(o) {
    return !!(o && o.static);
}

const optionsOf = (rep, kind) => (rep.options || []).filter((o) => !Array.isArray(o.kinds) || o.kinds.includes(kind));

/**
 * Выбранные фильтры вида kind: [{ label, value }] — подпись фильтра и значение
 * словами (из вариантов: статических и пришедших с сервера). «Все» (пусто у
 * выпадающего списка, первый вариант у переключателя) — не фильтр. Слова — без
 * перевода: переводит тот, кто показывает (tx.tr).
 */
export function activeFilters(rep, kind, opts, loaded) {
    const out = [];
    for (const o of optionsOf(rep, kind)) {
        if (o.type === 'services') continue;   // выбор услуг журнала — своей кнопкой
        const v = opts ? opts[o.arg] : undefined;
        const head = Array.isArray(o.choices) ? o.choices : [];
        if (o.type === 'select') {
            if (v === '' || v == null) continue;
        } else if (!head.length || v == null || String(v) === String(head[0][0])) continue;
        const all = [...head, ...((loaded && Array.isArray(loaded[o.arg])) ? loaded[o.arg] : [])];
        const hit = all.find(([cv]) => String(cv) === String(v));
        out.push({ label: o.label, value: hit ? hit[1] : String(v) });
    }
    return out;
}

// Знаки, которых не бывает в имени файла Windows, и управляющие.
const BAD_FILE_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g;
const clean = (s, max) => String(s == null ? '' : s).replace(BAD_FILE_CHARS, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim();

/**
 * Хвост имени файла: «_Способ оплаты Карта_Врач Иванов И.» (на языке экрана),
 * пусто — фильтров нет. Не длиннее 120 знаков.
 */
export function filterFileSuffix(list, tx) {
    const t = tx && typeof tx.tr === 'function' ? tx.tr : (s) => s;
    const parts = (list || []).map((x) => clean(t(x.label) + ' ' + t(x.value), 60)).filter(Boolean);
    if (!parts.length) return '';
    return ('_' + parts.join('_')).slice(0, 120).trim();
}
