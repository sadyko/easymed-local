// DOCTOR_PROFILE_V1 — «ЧТО УВИДЯТ ПАРТНЁРЫ» И ЦЕНЫ В КАРТОЧКЕ ВРАЧА (макет
// screen-doctor.js slotPreview, «Цены консультаций»). Данные — RPC
// doctor_public_preview: тот же движок записи, то же правило цены, что у кассы
// и будущего API (шаг 8). Здесь только вывод.
//   data === undefined — ещё грузится; null — сотрудник не сохранён;
//   false — сервер не ответил.
// Время, даты и названия — данными (createTextNode).
import { h, clear } from '../ui.js';
import { tr, trf, getLang, monthName } from '../i18n.js';
import { WEEK_DAYS } from './week-hours.js';
import { groupThousands } from '../../shared/money-input.js';

const sum = (n) => trf('{sum} сум', { sum: groupThousands(String(Math.round(Number(n) || 0))) });
const nameIn = (name) => (name && (name[getLang()] || name.ru)) || '—';
const dayLabel = (key) => (WEEK_DAYS.find(([k]) => k === key) || [key, ''])[1];

function pending(box, data, afterSave, failed) {
    if (data === undefined) { box.appendChild(h('p', { class: 'cpf-hint' }, 'Загрузка…')); return true; }
    if (data === null) { box.appendChild(h('p', { class: 'cpf-hint' }, afterSave)); return true; }
    if (data === false) { box.appendChild(h('p', { class: 'cpf-hint' }, failed)); return true; }
    return false;
}

/** «Что увидят партнёры»: по записи — семь дней и окна по 15 минут; живая очередь — часы и «сейчас ждут». */
export function renderPartnerPreview(box, data, { mode = 'schedulable', showQueue = false } = {}) {
    clear(box);
    if (pending(box, data, 'Что увидят партнёры — после сохранения сотрудника.', 'Не удалось загрузить, что увидят партнёры.')) return;
    if (mode === 'live_queue') {
        const kv = h('dl', { class: 'dpp-kv' });
        for (const [key, label] of WEEK_DAYS) {
            const hrs = data.hours && data.hours[key];
            if (!Array.isArray(hrs)) continue;
            kv.append(h('dt', null, label), h('dd', null, document.createTextNode(hrs[0] + '–' + hrs[1])));
        }
        const soft = h('div', { class: 'dpp-soft' },
            h('p', null, h('b', null, 'Живая очередь.'), ' ', 'Партнёры показывают часы приёма и кнопку «Оставить заявку»; время пациент не выбирает.'),
            kv.children.length ? kv : h('p', null, 'Часов приёма нет — врач не принимает ни в один день.'));
        if (showQueue) {
            soft.appendChild(h('p', { class: 'cpf-hint' },
                trf('Сейчас ждут приёма: {n} чел. Партнёры обновляют это число раз в минуту.', { n: Number(data.queue_now) || 0 })));
        }
        box.appendChild(soft);
        return;
    }
    const days = Array.isArray(data.days) ? data.days : [];
    let sel = Math.max(0, days.findIndex((d) => Array.isArray(d.windows) && d.windows.length));
    const chips = h('div', { class: 'dpp-days', role: 'group', 'aria-label': 'Дни для записи' });
    const slots = h('div', { class: 'dpp-day-slots' });
    const paint = () => {
        clear(chips);
        clear(slots);
        days.forEach((d, i) => {
            const off = !Array.isArray(d.windows) || !d.windows.length;
            const parts = String(d.date || '').split('-').map(Number);
            const chip = h('button', { type: 'button', class: 'dpp-day' + (i === sel ? ' on' : '') + (off ? ' off' : ''), 'aria-pressed': i === sel ? 'true' : 'false' },
                h('b', null, dayLabel(d.weekday)), h('span', null, document.createTextNode(parts[2] + ' ' + monthName(parts[1] - 1))));
            if (off) chip.disabled = true;
            else chip.addEventListener('click', () => { sel = i; paint(); });
            chips.appendChild(chip);
        });
        const d = days[sel];
        const wins = d && Array.isArray(d.windows) ? d.windows : [];
        if (!wins.length) { slots.appendChild(h('p', { class: 'cpf-hint' }, 'В этот день врач не принимает.')); return; }
        slots.appendChild(h('div', { class: 'dpp-slots' },
            ...wins.map((w) => h('span', { class: 'dpp-slot' + (w.free ? '' : ' busy') }, document.createTextNode(w.start)))));
        const min = Number(data.initial_minutes) || 0;
        slots.appendChild(h('p', { class: 'cpf-hint' },
            trf('Свободно {free} из {total} окон.', { free: wins.filter((w) => w.free).length, total: wins.length }), ' ',
            min > 15
                ? trf('Приём длится столько, сколько указано у вида консультации: первичный приём на {min} мин показываем, только если подряд свободно окон: {n}.', { min, n: Math.ceil(min / 15) })
                : tr('Приём длится столько, сколько указано у вида консультации.')));
    };
    paint();
    box.append(chips, slots);
}

/**
 * Цены консультаций врача — то, что получат партнёры (решения владельца 8 и 13):
 * своя цена; «Бесплатно»; общая цена вида (строки нет); пустая цена в строке —
 * «0 сум · цена не введена» (empty), чтобы администратор видел, что партнёрам уйдёт 0.
 */
export function renderConsultPrices(box, list) {
    clear(box);
    if (pending(box, list, 'Цены консультаций — после сохранения сотрудника.', 'Не удалось загрузить цены консультаций.')) return;
    if (!Array.isArray(list) || !list.length) {
        box.appendChild(h('p', { class: 'cpf-hint' }, 'Врач не ведёт ни одной консультации — отметьте их в «Консультациях врачей».'));
        return;
    }
    const dl = h('dl', { class: 'dpp-price' });
    for (const c of list) {
        const note = c.empty ? tr('цена не введена') : (c.own ? null : tr('общая цена'));
        const shown = c.empty || Number(c.price) > 0 ? sum(c.price) : tr('Бесплатно');
        dl.append(
            h('dt', null, document.createTextNode(nameIn(c.name)),
                h('span', { class: 'dpp-sub' }, trf('{n} мин', { n: c.minutes }), note ? [' · ', note] : null)),
            h('dd', c.empty ? { class: 'dpp-zero' } : null, shown));
    }
    box.appendChild(dl);
}

/** Услуги прайса группы «Консультации», которые оказывает врач (решение владельца 12). */
export function renderConsultServices(box, list) {
    clear(box);
    if (pending(box, list, 'Консультации из прайса — после сохранения сотрудника.', 'Не удалось загрузить услуги врача.')) return;
    if (!Array.isArray(list) || !list.length) {
        box.appendChild(h('p', { class: 'cpf-hint' }, 'За врачом нет услуг из группы «Консультации».'));
        return;
    }
    const dl = h('dl', { class: 'dpp-price' });
    for (const s of list) {
        dl.append(
            h('dt', null, document.createTextNode(nameIn(s.name)),
                h('span', { class: 'dpp-sub' }, s.online ? tr('На сайте') : tr('Не показывается'), s.own ? [' · ', tr('своя цена врача')] : null)),
            h('dd', null, Number(s.price) > 0 ? sum(s.price) : tr('Бесплатно')));
    }
    box.appendChild(dl);
}
