// PICK_DAY_V1 (решение владельца 2026-11-02) — НЕТ ВРЕМЕНИ СЕГОДНЯ — ДЕНЬ
// ВЫБИРАЕТ РЕГИСТРАТОР.
//
// Мастер визита и калькулятор услуг сами ставили врачебной строке первый
// свободный слот за две недели. Вечером, в выходной врача или при занятом дне
// строка молча уезжала на завтра, а услуги без врача оставались сегодня —
// корзина делилась по дню на два визита и два счёта (на копии dev — все 12
// случаев «одна регистрация — два счёта»), и единственным сигналом было
// «(визитов: N)» на шаге подтверждения.
//
// Теперь автовыбор — только сегодня. Нет свободного времени сегодня — у строки
// нет ни дня, ни времени, красная пометка и две кнопки: «Ближайшее: вт 3 ноября
// 09:00» (ставит ближайший слот) и «Выбрать день». Дальше шаг не пройти, пока
// день не выбран или строка не убрана.
//
// Чистый модуль: подписи и поиск ближайшего слота одни на оба окна (мастер и
// калькулятор), и проверяются без DOM.
import { tr, trf, monthName } from '../i18n.js';

// Сокращения дней недели — ключи словаря (те же, что у дней калькулятора).
const WD = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];

const pad2 = (n) => String(n).padStart(2, '0');

/** Местный день 'ГГГГ-ММ-ДД' без toISOString (в UTC+5 полночь уехала бы на вчера). */
export function localIsoDay(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

/** «вт 3 ноября» — местный день на языке интерфейса. @param {string} dayIso 'ГГГГ-ММ-ДД' */
export function dayWhenLabel(dayIso) {
    const [y, m, d] = String(dayIso).split('-').map(Number);
    const day = new Date(y, m - 1, d);
    return tr(WD[day.getDay()]).toLowerCase() + ' ' + day.getDate() + ' ' + monthName(day.getMonth());
}

/**
 * «вт 3 ноября 09:00» — день и время предложенного слота на языке интерфейса.
 * @param {string} dayIso 'ГГГГ-ММ-ДД' — местный день
 * @param {number} minutes минуты от местной полуночи
 */
export function slotWhenLabel(dayIso, minutes) {
    const mins = Math.max(0, Math.round(Number(minutes) || 0));
    return dayWhenLabel(dayIso) + ' ' + pad2(Math.floor(mins / 60)) + ':' + pad2(mins % 60);
}

/** «Визит — вт 3 ноября: все услуги сметы в этот день» — калькулятор, визит не сегодня. */
export function visitDayNote(dayIso) {
    return trf('Визит — {day}: все услуги сметы в этот день', { day: dayWhenLabel(dayIso) });
}

/**
 * Первый свободный слот среди дней (по порядку списка): { iso, min } или null.
 * @param {string[]} dayIsos дни-кандидаты, ближайший первым
 * @param {(iso: string) => number[]} freeOf свободные начала дня (минуты), уже без занятого сметой
 */
export function nearestFree(dayIsos, freeOf) {
    for (const iso of dayIsos || []) {
        const free = (typeof freeOf === 'function' ? freeOf(iso) : null) || [];
        if (free.length) return { iso, min: free[0] };
    }
    return null;
}

/** Красная пометка строки: сегодня — «Сегодня…», другой день (окно визита) — «В этот день…». */
export function noFreeText(isToday) {
    return isToday ? tr('Сегодня у врача нет свободного времени') : tr('В этот день у врача нет свободного времени');
}

/** «Ближайшее: вт 3 ноября 09:00» — подпись кнопки, которая ставит этот слот. */
export function nearestButtonText(dayIso, minutes) {
    return trf('Ближайшее: {when}', { when: slotWhenLabel(dayIso, minutes) });
}

/**
 * «Услуги на 2 дня → 2 визита, 2 счёта» — предупреждение мастера, когда смета
 * разложится по разным дням (визит = один день, счёт — на визит).
 * Пустая строка — день один, предупреждать не о чем.
 */
export function manyDaysWarning(n) {
    const k = Number(n) || 0;
    if (k < 2) return '';
    const few = k % 10 >= 2 && k % 10 <= 4 && (k % 100 < 12 || k % 100 > 14);
    return few
        ? trf('Услуги на {n} дня → {n} визита, {n} счёта', { n: k })
        : trf('Услуги на {n} дней → {n} визитов, {n} счетов', { n: k });
}
