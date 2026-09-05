// PATIENTS_HUB_V1 (2026-09-05) — «Пациенты» одним разделом в трёх лицах.
//
// Владелец (docs/plans/2026-09-05-ui-redesign-and-calendar.md, задача 4):
// «1) список пациентов · 2) очередь — кто физически ждёт, оплатил, номер в
// чеке · 3) записи — кабинеты и врачи, слоты, карточки пациент+врач,
// перетаскивание, подсказка со статусом». Три экрана, которые регистратура
// весь день листает по кругу, перестали быть тремя разными адресами в разных
// концах меню.
//
// ЧТО ЭТО ЗА ФАЙЛ. Хост и ничего больше: полоса вкладок, три контейнера и
// правила, по которым содержимое в них появляется и засыпает. Ни одна из трёх
// вкладок здесь не нарисована — каждая остаётся своим экраном со своим файлом,
// и хост зовёт их ровно так же, как звала оболочка.
//
// ПОДМАРШРУТ. Копия договора laboratory.js (HASH_SUBROUTE_V1): вкладка живёт в
// адресе как '#patients/queue' и '#patients/calendar', пишется через
// history.replaceState (переключение вкладки — не новое место, куда должна
// возвращать кнопка «Назад»), и о ней сообщается оболочке через
// window.easymedSetTabSub, потому что адресной строки мало: следующий
// navigate() в этот раздел перепишет хеш из payload панели.
//
// ПРАВА. Отдельного гейта у вкладок нет, и это решение, а не пропуск: три
// вкладки — это ОДИН раздел «Пациенты», и открыть его вправе тот, кому выдан
// ключ `patients` (оболочка спрашивает isRouteAllowed('patients') до нас).
// Тот же довод, что у LAB_PANELS_BY_SECTION_V1 («у кого есть раздел
// Лаборатория, тот правит панели») и у `admissions` → `beds`. Заводить вкладке
// собственный ключ значило бы, что у КАЖДОЙ настроенной сегодня роли раздел
// молча недосчитается двух третей, пока администратор не сходит в настройки
// ролей. Доска очереди только читает, а имена в ней — те же, что в списке
// пациентов строкой выше, так что и раскрытия тут нет. Отдельные ключи `queue`
// и `appointments` продолжают жить для тех, кому нужен ТОЛЬКО экран очереди
// или ТОЛЬКО календарь, без картотеки (permissions.js).

import { h, Icon, clear } from '../ui.js';
// Те же адреса модулей, что у admin.js: одна строка импорта — один экземпляр
// модуля. Разошедшийся ?v= развёл бы состояние экрана на две копии.
import { renderPatients } from './patients.js?v=regfit2';
import { renderQueue } from './queue.js?v=q7';
// MOTION_REVEAL_V1 — переход между вкладками: панель проявляется, полоса
// вкладок возвращается в поле зрения. Общий помощник, не свой на экран.
import { animateIn, smoothScrollTo } from '../motion.js?v=mo1';

const TABS = [
    { id: 'list',     sub: null,       label: 'Список',  icon: 'Patients' },
    { id: 'queue',    sub: 'queue',    label: 'Очередь', icon: 'Clock'    },
    { id: 'calendar', sub: 'calendar', label: 'Записи',  icon: 'Calendar' },
];
const SUB_TO_TAB = { queue: 'queue', calendar: 'calendar' };

// Календарь приезжает ДИНАМИЧЕСКИМ импортом, и это тоже решение. Статический
// импорт связал бы жизнь всего раздела с одним файлом: пока календарь
// переписывают (задача 5), его синтаксическая ошибка уронила бы вместе с ним
// список пациентов и очередь — то есть весь рабочий день регистратуры.
// Динамический импорт локализует поломку в одной вкладке.
const CALENDAR_MODULE = './room-calendar.js?v=aug17e';

async function defaultCalendarLoader() {
    const mod = await import(CALENDAR_MODULE);
    if (typeof mod.renderRoomCalendar !== 'function') {
        throw new Error('room-calendar.js exports no renderRoomCalendar()');
    }
    return mod.renderRoomCalendar;
}

// Договор с календарём — тот же, что у списка пациентов:
// renderRoomCalendar(container, { onNavigate, embedded }). `embedded` снимает
// его собственную полосу вкладок, потому что полосу рисует хост.
export async function mountCalendarInto(host, ctx = {}, load = defaultCalendarLoader) {
    clear(host);
    try {
        const renderRoomCalendar = await load();
        await renderRoomCalendar(host, { onNavigate: ctx.onNavigate, embedded: true });
        return true;
    } catch (e) {
        // Вкладка обязана СМОНТИРОВАТЬСЯ в любом случае и сказать словами, что
        // именно недоступно. Пустая вкладка без объяснения читается как
        // сломанная программа, а исключение отсюда унесло бы весь хост.
        clear(host);
        host.appendChild(h('div', { class: 'empty', style: { padding: '48px 24px', textAlign: 'center' } },
            h('div', { style: { color: 'var(--ink-300, #c3ced2)' } }, Icon('Calendar', { size: 28 })),
            h('div', { style: { marginTop: '10px', fontWeight: '600' } }, 'Календарь записи готовится'),
            h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '4px' } },
                'Экран записи сейчас обновляется. Список пациентов и очередь работают как обычно.')));
        return false;
    }
}

/**
 * Хост раздела «Пациенты». `ctx` — то же, что оболочка даёт любому экрану:
 * { onNavigate, payload, tabId }. `payload.sub` называет вкладку.
 * `calendarLoader` подменяется только тестами.
 */
export async function renderPatientsHub(container, ctx = {}, { calendarLoader = defaultCalendarLoader } = {}) {
    clear(container);
    const tabId = ctx.tabId || null;
    const sub = ctx.payload && ctx.payload.sub;

    const root = h('div', { class: 'fade-in' });
    container.appendChild(root);

    // Полоса вкладок — те же .reg-tabs/.reg-tab, что у полосы регистратуры:
    // залитая активная кнопка, один язык выделения на всю оболочку, а не свой
    // на каждую полосу (admin-views.css, NO_GREETING_V1).
    const strip = h('div', { class: 'reg-tabs', role: 'tablist', 'aria-label': 'Разделы «Пациенты»' });
    const buttons = {};
    const hosts = {};
    for (const t of TABS) {
        hosts[t.id] = h('div', {
            id: 'phub-panel-' + t.id, role: 'tabpanel',
            'aria-labelledby': 'phub-tab-' + t.id, 'data-tab-panel': t.id,
            style: { display: 'none' },
        });
        buttons[t.id] = h('button', {
            class: 'reg-tab', type: 'button', role: 'tab',
            id: 'phub-tab-' + t.id, 'aria-controls': 'phub-panel-' + t.id,
            'aria-selected': 'false', tabindex: '-1', 'data-tab': t.id,
            onclick: () => { select(t.id); },
            onkeydown: (ev) => moveByKey(ev, t.id),
        }, Icon(t.icon, { size: 14 }), h('span', null, t.label));
        strip.appendChild(buttons[t.id]);
    }
    root.appendChild(strip);
    for (const t of TABS) root.appendChild(hosts[t.id]);

    // Вкладка монтируется при первом показе и дальше ЖИВЁТ: прокрутка списка,
    // страница пагинации и наполовину введённый поиск переживают уход на
    // соседнюю вкладку — ровно как панели переживают уход на соседний экран.
    const mounted = { list: false, queue: false, calendar: false };
    let queue = null;        // пульт доски очереди (views/queue.js)
    let active = SUB_TO_TAB[sub] || 'list';

    // Полоса объявлена как tablist, а в tablist по стрелкам ходят: из порядка
    // обхода Tab вынуты все кнопки, кроме активной (это и есть роль tablist),
    // и без этого обработчика до двух вкладок из трёх нельзя было бы добраться
    // с клавиатуры вовсе.
    function moveByKey(ev, id) {
        const key = ev && ev.key;
        const step = key === 'ArrowRight' ? 1 : key === 'ArrowLeft' ? -1 : 0;
        let next = null;
        if (step) {
            const i = TABS.findIndex((t) => t.id === id);
            next = TABS[(i + step + TABS.length) % TABS.length];
        } else if (key === 'Home') next = TABS[0];
        else if (key === 'End') next = TABS[TABS.length - 1];
        if (!next) return;
        if (typeof ev.preventDefault === 'function') ev.preventDefault();
        select(next.id);
        buttons[next.id].focus();
    }

    function paintStrip({ animate = false } = {}) {
        for (const t of TABS) {
            const on = t.id === active;
            const b = buttons[t.id];
            b.className = 'reg-tab' + (on ? ' on' : '');
            b.setAttribute('aria-selected', on ? 'true' : 'false');
            b.setAttribute('tabindex', on ? '0' : '-1');
            hosts[t.id].style.display = on ? '' : 'none';
            // Проявление, а не переезд: панели лежат друг на друге в одном
            // месте, и любой сдвиг соседей на переключении вкладки читался бы
            // как перерисовка всего раздела. Появление играется только по
            // ДЕЙСТВИЮ пользователя — первое открытие раздела уже приезжает
            // со своей .fade-in.
            if (on && animate) animateIn(hosts[t.id]);
        }
    }

    // URL отражает состояние: вкладка лежит в адресе, поэтому F5 её сохраняет,
    // а ссылку можно отдать коллеге. replaceState, а не pushState — переход
    // между вкладками одного раздела не новое место в истории, иначе выйти из
    // «Пациентов» кнопкой «Назад» пришлось бы в три нажатия.
    function syncSubUrl() {
        try {
            const tab = TABS.find((t) => t.id === active);
            const nextSub = (tab && tab.sub) || null;
            if (typeof history !== 'undefined' && history.replaceState) {
                history.replaceState({ view: 'patients', payload: nextSub ? { sub: nextSub } : null },
                    '', '#patients' + (nextSub ? '/' + nextSub : ''));
            }
            // Оболочке — тоже: адресной строки мало, потому что navigate()
            // перепишет хеш из payload ПАНЕЛИ, когда в раздел зайдут снова.
            if (typeof window !== 'undefined' && typeof window.easymedSetTabSub === 'function') {
                window.easymedSetTabSub(tabId, nextSub);
            }
        } catch (e) {
            // Браузер в жёстком режиме может отказать в записи истории. Вкладки
            // продолжают работать, просто перестают быть ссылками — ломать из-за
            // этого экран нельзя.
        }
    }

    async function ensureMounted(id) {
        // Флаг ставится ДО await: два быстрых нажатия по одной вкладке не должны
        // завести вторую доску в том же контейнере.
        if (id === 'list') {
            if (mounted.list) return;
            mounted.list = true;
            await renderPatients(hosts.list, { onNavigate: ctx.onNavigate, embedded: true });
            return;
        }
        if (id === 'queue') {
            if (!mounted.queue) {
                mounted.queue = true;
                queue = await renderQueue(hosts.queue, { embedded: true });
                return;
            }
            // Вернулись на вкладку: доска могла простоять минуты, поэтому
            // сначала свежее чтение, потом снова опрос.
            if (queue) await queue.start();
            return;
        }
        if (mounted.calendar) return;
        mounted.calendar = true;
        await mountCalendarInto(hosts.calendar, ctx, calendarLoader);
    }

    async function select(id, { initial = false } = {}) {
        if (!TABS.some((t) => t.id === id)) id = 'list';
        if (!initial && id === active) return;
        const prev = active;
        active = id;
        paintStrip({ animate: !initial });
        // Вкладку переключили из середины длинного списка — полоса вкладок
        // обязана снова оказаться на глазах, иначе новая вкладка открывается
        // «где-то выше». Плавно, а при просьбе «меньше движения» — мгновенно.
        if (!initial) smoothScrollTo(strip, { block: 'start' });
        // Опрос очереди живёт РОВНО столько, сколько её видно. Спрятанная доска,
        // которая продолжает каждые десять секунд ходить в базу, — это нагрузка
        // без единого читателя, и на смене таких вкладок накапливается.
        if (prev === 'queue' && id !== 'queue' && queue) queue.stop();
        if (!initial) syncSubUrl();
        await ensureMounted(id);
    }

    await select(active, { initial: true });

    return {
        activeTab: () => active,
        select,
        // Оболочка панель не размонтирует, пока та в кэше; когда размонтирует —
        // доска снимет свой таймер сама (views/queue.js следит за isConnected).
        destroy() { if (queue) queue.destroy(); },
    };
}
