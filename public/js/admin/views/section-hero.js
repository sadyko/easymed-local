// SECTION_HERO_V1 (2026-10-31) — тёмный баннер клинических разделов.
//
// Владелец, со снимком баннера «Пациентов» (PATIENTS_HERO_V1): «in clinical
// section put such thing in each, and button like here inside of it but in the
// left side to be conviniet to staff». Отсюда два решения:
//   * баннер — ОДИН на все клинические разделы (Пациенты, Кабинет врача,
//     Лаборатория, Процедуры, Стационар, Задачи медсестры, Порционник,
//     Выписки, Документы), а не копия на экран: часы, приветствие и
//     раскладка живут здесь, экран отдаёт только название, подзаголовок и
//     свои кнопки;
//   * кнопки раздела (вкладки) стоят СЛЕВА, под названием — ближе к меню, откуда
//     пришла рука, а не через весь экран справа. Справа остались дата и часы и,
//     если есть, действия раздела («Новая госпитализация» и т. п.).
//
// Тёплая строка у каждого раздела своя: регистратуре — о встрече, лаборатории —
// о точности, кухне — о диете. Все строки — здесь, в одном файле: решение
// NO_GREETING_V1 для остальных экранов в силе, и app-shell.test.mjs пускает
// приветствия только сюда.
//
// SECTION_HERO_RIGHT_V1 (2026-10-31) — владелец передумал: «can you make similir
// design to each block in clinical section, just buttons should be on a right
// side». Вкладки раздела переехали СПРАВА, под дату и часы, над действиями
// раздела. Слева остались название, подзаголовок и тёплая строка.
//
// Часы — свои у каждого баннера (как у PATIENTS_HERO_V1): таймер гаснет сам,
// когда баннер ушёл из документа, и снимается stop(); unref — чтобы прогон
// тестов не висел. Приветствие пересчитывается вместе с часами.

import { h, Icon } from '../ui.js';
import { tr, trf, monthName } from '../i18n.js';
import { currentUser } from '../data.js';

const WEEKDAYS = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];
const pad2 = (n) => String(n).padStart(2, '0');

/** Тёплая строка раздела — ключ раздела → текст. */
export const SECTION_MESSAGES = {
    patients: 'Пациент — в центре всего, что мы делаем. Тёплая встреча, внимание и улыбка важны не меньше, чем точность данных: помогите каждому почувствовать заботу с первой минуты. Спасибо за вашу работу — вы лицо клиники.',
    consultation: 'Каждый пациент приходит с надеждой. Выслушайте, объясните понятными словами и дайте ясный план — доверие к клинике рождается в вашем кабинете. Спасибо за вашу заботу.',
    labs: 'За каждой пробиркой — человек, который ждёт ответа. Точность и скорость здесь — забота о пациенте и опора для врача. Спасибо за вашу внимательность.',
    procedures: 'Бережные руки и спокойное слово делают процедуру легче. Объясните, что будет, и проследите, чтобы пациенту было удобно. Спасибо за ваше тепло.',
    admissions: 'Пациенты стационара проводят с нами дни и ночи. Порядок в палатах, внимание к жалобам и вовремя выполненные назначения — это и есть выздоровление. Спасибо за вашу смену.',
    'mar-nurse': 'Каждое назначение вовремя — шаг к выздоровлению. Отмечайте выполненное сразу: так врач видит правду, а пациент — заботу. Спасибо за вашу работу.',
    'kitchen-sheet': 'Правильное питание — часть лечения. Точный порционник помогает кухне накормить каждого пациента вовремя и по его диете. Спасибо за внимательность.',
    discharge: 'Выписка — последнее впечатление пациента о клинике. Понятные рекомендации и аккуратные документы помогут ему продолжить лечение дома. Спасибо за вашу работу.',
    'patient-documents': 'Аккуратные документы берегут и пациента, и клинику. Проверьте данные перед печатью — ошибка в бумаге стоит доверия. Спасибо за вашу точность.',
};

/** «Суббота, 31 октября 2026» на текущем языке. */
export function heroDateLabel(d) {
    return `${tr(WEEKDAYS[d.getDay()])}, ${d.getDate()} ${monthName(d.getMonth())} ${d.getFullYear()}`;
}
export function heroTimeLabel(d) {
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}
/** Приветствие по часу: до 12 — утро, до 17 — день, дальше — вечер. */
export function heroGreeting(hour, name) {
    const part = hour < 12 ? 'morning' : hour < 17 ? 'day' : 'evening';
    const withName = {
        morning: 'Доброе утро, {name}!', day: 'Добрый день, {name}!', evening: 'Добрый вечер, {name}!',
    };
    const bare = { morning: 'Доброе утро!', day: 'Добрый день!', evening: 'Добрый вечер!' };
    return name ? trf(withName[part], { name }) : tr(bare[part]);
}
function heroName() {
    const me = currentUser();
    return ((me && (me.full_name || me.username)) || '').trim().split(/\s+/)[0] || '';
}

/**
 * Баннер раздела.
 *   section — ключ раздела (SECTION_MESSAGES) — тёплая строка;
 *   title, sub — название и подзаголовок (переводятся здесь);
 *   tabs — элемент кнопок раздела (вкладки) — встаёт СЛЕВА под названием
 *          (SECTION_HERO_LEFT_V2; справа под часами они были SECTION_HERO_RIGHT_V1);
 *   actions — элемент действий раздела — встаёт справа под часами.
 * Возвращает { el, stop, setSub(text), setTabs(el), setActions(el) }.
 */
export function sectionHero({ section, title, sub = '', tabs = null, actions = null } = {}) {
    const now = new Date();
    const name = heroName();
    const subEl = h('div', { class: 'phub-hero-sub' }, sub ? tr(sub) : '');
    const hello = h('div', { class: 'phub-hero-hello' }, heroGreeting(now.getHours(), name));
    const date = h('span', null, heroDateLabel(now));
    const time = h('b', { class: 'num' }, heroTimeLabel(now));
    const tabsSlot = h('div', { class: 'shero-tabs' });
    const actionsSlot = h('div', { class: 'shero-actions' });
    if (tabs) tabsSlot.appendChild(tabs); else tabsSlot.hidden = true;
    if (actions) actionsSlot.appendChild(actions); else actionsSlot.hidden = true;
    const message = SECTION_MESSAGES[section] || '';
    const el = h('div', { class: 'phub-hero shero', 'data-phub-hero': '', 'data-section-hero': section || '' },
        h('div', { class: 'phub-hero-main' },
            h('div', { class: 'phub-hero-id' },
                h('div', { class: 'phub-hero-title' }, tr(title || '')),
                subEl,
                // SECTION_HERO_LEFT_V2 (2026-10-31) — владелец, глядя на вкладки
                // кабинета справа под часами (SECTION_HERO_RIGHT_V1): «put buttons
                // to the left side». Снова слева, под названием раздела, одной
                // строкой — как в первой версии баннера.
                tabsSlot),
            h('div', { class: 'phub-hero-msg' },
                hello,
                message ? h('div', { class: 'phub-hero-warm' }, tr(message)) : null)),
        h('div', { class: 'phub-hero-ctrl' },
            h('div', { class: 'phub-hero-now' },
                h('span', { class: 'phub-hero-date' }, Icon('Calendar', { size: 14 }), date),
                h('span', { class: 'phub-hero-time' }, Icon('Clock', { size: 14 }), time)),
            actionsSlot));

    let lastHour = now.getHours();
    let timer = setInterval(() => {
        if (!el.isConnected) { stop(); return; }
        const t = new Date();
        time.textContent = heroTimeLabel(t);
        if (t.getHours() !== lastHour) {
            lastHour = t.getHours();
            hello.textContent = heroGreeting(lastHour, name);
            date.textContent = heroDateLabel(t);
        }
    }, 1000);
    if (timer && typeof timer.unref === 'function') timer.unref();
    function stop() { if (timer) { clearInterval(timer); timer = null; } }

    const fill = (slot, node) => {
        while (slot.firstChild) slot.removeChild(slot.firstChild);
        if (node) slot.appendChild(node);
        slot.hidden = !node;
    };
    return {
        el, stop,
        setSub: (text) => { subEl.textContent = text ? tr(text) : ''; },
        setTabs: (node) => fill(tabsSlot, node),
        setActions: (node) => fill(actionsSlot, node),
    };
}
