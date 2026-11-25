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
//
// V3120_FIX (2026-09-27) — поправка к абзацу выше: «одного ключа хватает»
// оказалось правдой только для ЭКРАНА. Данные вкладок сервер отдаёт по своим
// правилам — доску по разделу `queue`, сетку календаря по BOOK_ROLES, — и
// вкладка, нарисованная роли, которой сервер откажет, открывалась стеной
// отказов (лаборант — «Очередь», медсестра/кассир/лаборант — «Записи»).
// Поэтому вкладка видна по тому же правилу, что её отдельный адрес.

import { h, Icon, clear } from '../ui.js';
// I18N_COVERAGE_V1 — причина сбоя подставляется В ПЕРЕВЕДЁННЫЙ шаблон, а не
// склеивается из кусков: склейка непереводима целиком ни на один язык.
import { tr, trf } from '../i18n.js';
import { setRailTools } from '../rail-tools.js';   // PATIENTS_RAIL_V1 — вкладки раздела в левой колонке
import { grantAllows, isRouteAllowed, hasActorRole, actorRoleCodes } from '../permissions.js';   // GRANTS_V1 — окна раздела по матрице прав; V3120_FIX — isRouteAllowed; WAIT_REG_V1 — hasActorRole, actorRoleCodes
// Те же адреса модулей, что у admin.js: одна строка импорта — один экземпляр
// модуля. Разошедшийся ?v= развёл бы состояние экрана на две копии.
import { renderPatients, duplicatesRailButton, duplicatesOn, setDuplicatesMode } from './patients.js?v=regfit2';   // DUP_TO_RAIL_V1
import { renderQueue } from './queue.js?v=q7';
import { renderRegistrarWaiting, loadRegistrarWaiting, WAITING_ROLES, BADGE_ARGS, REFERRAL_BADGE_ARGS } from './registrar-waiting.js';   // WAIT_REG_V1 — «Ждут регистрации»; CRM_BOOKINGS_TAB_V1 — «Записи CRM», счётчик по фильтру по умолчанию
import { watchScreen, shownOnScreen } from '../live.js';   // WAIT_REG_V1 — счётчик вкладки свежий без «Обновить»; ревью M6 — спрятанный раздел не опрашивается
// MOTION_REVEAL_V1 — переход между вкладками: панель проявляется, полоса
// вкладок возвращается в поле зрения. Общий помощник, не свой на экран.
import { animateIn, smoothScrollTo } from '../motion.js?v=mo1';

const TABS = [
    // PATIENTS_RAIL_V1 — в колонке «Регистрации» первая кнопка зовётся «Пациенты»:
    // баннера с именем раздела больше нет, и «Список» перестал говорить, чей он.
    { id: 'list',     sub: null,       label: 'Пациенты', icon: 'Patients' },
    { id: 'queue',    sub: 'queue',    label: 'Очередь', icon: 'Clock'    },
    { id: 'calendar', sub: 'calendar', label: 'Записи',  icon: 'Calendar' },
    // BOOKING_TAB_REMOVED_V1 (2026-11-23, владелец: «there is tab called booking in the patients
    // list, it is the same as CRM bookings. we need to remove the booking list. and leave only the
    // CRM booking tab») — вкладки «Бронирование» (BOOKING_DAY_V1, views/booking-day.js) больше нет:
    // записи ведут «Записи» (календарь) и «Записи CRM». Старый адрес #patients/booking открывает
    // «Записи CRM» (SUB_TO_TAB), а кому они закрыты — список.
    // WAIT_REG_V1 (2026-11-17, владелец: «in the registrator window we should show the patients
    // that were sent and patients for which we created a booking so registrators won't be
    // confused») — кого сегодня ждёт стойка: записи, анализы «на дату», направления врача
    // (views/registrar-waiting.js), со счётчиком на самой вкладке.
    // CRM_BOOKINGS_TAB_V1 (2026-11-17, решение владельца с макета) — вкладка стала «Записи CRM»: список
    // записей с фильтрами (день, источник, статус, врач, поиск). Адрес прежний — #patients/waiting
    // (ссылки и закладки регистратуры живут), счётчик — сегодняшние записи CRM, которые ещё ждут
    // (фильтр вкладки по умолчанию, BADGE_ARGS), а не то, что открыто в фильтрах сейчас.
    { id: 'waiting',  sub: 'waiting',  label: 'Записи CRM', icon: 'Headset' },
    // REFERRALS_TAB_V1 (2026-11-24, владелец: «Put referal separately from Записи CRM, put it in block
    // separately») — направления врача (рекомендации) — свой пункт ОТДЕЛЬНЫМ БЛОКОМ колонки (черта между
    // группами — admin.js fillRailTools), со своим счётчиком. Тот же список (registrar-waiting.js,
    // режим 'referrals'), адрес #patients/referrals.
    { id: 'referrals', sub: 'referrals', label: 'Направления врача', icon: 'Flag' },
];
const SUB_TO_TAB = { list: 'list', queue: 'queue', calendar: 'calendar', booking: 'waiting', waiting: 'waiting', referrals: 'referrals', duplicates: 'list' };   // list: WAIT_REG_V1 (ревью) — у регистратуры «Список» не первый; duplicates: DUP_OWN_VIEW_V1
// WAIT_REG_V1 — вкладку видит стойка (администратор, регистратура): сервер отдаёт список только
// ей (rpc/registrar-waiting.js WAITING_ROLES) — вкладка, за которой сервер откажет, не рисуется
// (V3120_FIX). Своего ключа прав нет: стойка — роль, а не окно матрицы.
const TAB_ROLES = { waiting: WAITING_ROLES, referrals: WAITING_ROLES };
// WAIT_REG_V1 — анализы «на дату» (заявки CRM) поток изменений не несёт: список перечитывается
// и сам — раз в минуту, пока раздел на экране.
const WAITING_POLL_MS = 60000;

// ROLE_QUEUE_V1 — скрыт ли раздел в «Видимости разделов» (FIX_318_V1: правило
// оболочки, window.easymed.isNavHidden). Нет оболочки — не скрыт.
function navHidden(id) {
    const fn = typeof window !== 'undefined' && window.easymed && window.easymed.isNavHidden;
    return typeof fn === 'function' ? !!fn(id) : false;
}

// ---------------------------------------------------------------------------
// PATIENTS_HERO_V1 (2026-10-31) — ТЁМНЫЙ БАННЕР НАД ВКЛАДКАМИ.
//
// Владелец прислал снимок прежней «Aurora»-полосы регистратуры (название
// раздела, приветствие, тёплый абзац, дата с живыми часами и вкладки-пилюли
// на тёмном фоне) и попросил: «Make the registration block more in this
// design». Это ОТМЕНА решения NO_GREETING_V1 (2026-09-05, «убрать
// приветственные баннеры») — но только для раздела «Пациенты»: остальные
// экраны по-прежнему без приветствий, и app-shell.test.mjs стережёт это
// для всех файлов, кроме этого.
//
// Чем этот баннер отличается от прежнего (registrar-header.js до 09-05):
//   * часы — СВОИ у каждого баннера, а не модульный таймер на всех: прежний
//     _regClockTimer делили два экземпляра модуля под разными ?v=, и это была
//     живая мина. Таймер сам гаснет, когда баннер ушёл из документа, и
//     снимается в destroy() хоста; unref — чтобы прогон тестов не висел;
//   * приветствие пересчитывается вместе с часами — «доброе утро» не
//     доживает до вечера у окна, открытого с утра;
//   * вкладки баннера — ТЕ ЖЕ кнопки tablist хоста (роли, id, стрелки), а не
//     вторая полоса: у раздела одна навигация;
//   * всё через tr()/trf() и monthName() — на узбекском и английском баннер
//     говорит на своём языке, а не по-русски.
// ---------------------------------------------------------------------------
//
// PATIENTS_RAIL_V1 (2026-11-21, владелец со снимком баннера: «put all the
// buttons on the left side bar and you can remove this big blue place to use
// space smartly») — БАННЕРА БОЛЬШЕ НЕТ. Вкладки раздела стоят кнопками в левой
// колонке (admin/rail-tools.js → admin.js renderSidebar), как у «Закупок» и CRM;
// имя раздела — заголовок колонки («Регистрация», REGISTRATION_DEPT_V1).
// Приветствие, дата и часы ушли вместе с баннером; часы и так есть внизу колонки.
// Экран начинается сразу с содержимого вкладки.
//
// SECTION_HERO_V1 — помощники даты и приветствия живут в общем баннере;
// отсюда — для тех, кто импортировал их у «Пациентов».
export { heroDateLabel, heroTimeLabel, heroGreeting } from './section-hero.js';

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
export async function mountCalendarInto(host, ctx = {}, load = defaultCalendarLoader, { onRetry = null } = {}) {
    clear(host);
    try {
        const renderRoomCalendar = await load();
        await renderRoomCalendar(host, { onNavigate: ctx.onNavigate, embedded: true });
        return true;
    } catch (e) {
        // CALENDAR_RETRY_V1 (владелец: «в клиниках календарь не открывается,
        // пишет, что готовится»). Здесь было ДВЕ ошибки, и обе клиника видела
        // как «программа не доделана».
        //
        // 1. ЗАГЛУШКА ВРАЛА. «Календарь записи готовится» читается как «этот
        //    экран ещё не написан» — и клиника просто перестаёт им пользоваться.
        //    А на самом деле экран написан и работает: не загрузился ФАЙЛ. Чаще
        //    всего потому, что окно открыли раньше, чем поднялась сама
        //    программа (после включения компьютера или после обновления): один
        //    неотвеченный запрос — и вкладка мертва. Теперь заглушка говорит
        //    правду и НАЗЫВАЕТ причину: с одного снимка экрана видно, что
        //    случилось, без похода к компьютеру клиники.
        // 2. ВТОРОЙ ПОПЫТКИ НЕ БЫЛО. Вкладка помечалась смонтированной ДО
        //    загрузки и назад не отмечалась, поэтому одна неудача гасила
        //    календарь до конца рабочего дня — переключение вкладок не помогало.
        //    Теперь есть кнопка «Повторить», и возврат на вкладку пробует снова.
        //
        // Исключение отсюда по-прежнему не выпускает: оно унесло бы весь
        // раздел, то есть ещё и список пациентов с очередью.
        const reason = String((e && (e.message || e)) || '').slice(0, 200);
        // Причина нужна и в консоли целиком: в заглушке она обрезана, а разбор
        // идёт по стеку. Сам console.error обёрнут — браузер в жёстком режиме
        // может отказать и в нём.
        try { console.error('[patients-hub] календарь не загрузился:', e); } catch (_) { /* не повод ронять вкладку */ }
        clear(host);
        const retry = h('button', {
            class: 'btn', type: 'button', style: { marginTop: '14px' },
            onclick: () => { if (typeof onRetry === 'function') onRetry(); },
        }, Icon('Refresh', { size: 14 }), h('span', null, 'Повторить'));
        host.appendChild(h('div', { class: 'empty', style: { padding: '48px 24px', textAlign: 'center' } },
            h('div', { style: { color: 'var(--ink-300, #c3ced2)' } }, Icon('Calendar', { size: 28 })),
            h('div', { style: { marginTop: '10px', fontWeight: '600' } }, 'Календарь записи не открылся'),
            h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '4px' } },
                'Экран записи не загрузился. Список пациентов и очередь работают как обычно.'),
            onRetry ? retry : null,
            reason ? h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '10px', opacity: '0.75' } },
                trf('Причина: {reason}', { reason })) : null));
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

    // PATIENTS_RAIL_V1 — кнопки вкладок — пункты колонки (.nav-item), а не полоса
    // в баннере. Узлы создаются один раз и переезжают в колонку целиком:
    // переключение только перекрашивает их, колонку не перерисовывает.
    const buttons = {};
    const hosts = {};
    // GRANTS_V1 — «Очередь» и «Записи» можно закрыть роли в «Настройки → Роли».
    // Ненастроенный ключ = вкладка видна, как и была.
    const TAB_GRANT = { queue: 'patients.queue', calendar: 'patients.calendar' };
    // V3120_FIX — ВКЛАДКА, ЗА КОТОРОЙ СЕРВЕР ОТКАЖЕТ, НЕ РИСУЕТСЯ. «Записи»
    // показывались медсестре, кассиру и лаборанту, а сетку календаря сервер
    // отдаёт только BOOK_ROLES (rpc/calendar.js) — вкладка открывалась стеной
    // отказов. «Очередь» — та же история с разделом `queue` (rpc/queue.js
    // queueBoard). Правило — то же, что у отдельных адресов #appointments и
    // #queue (permissions.js): одна дверь, один ответ.
    const TAB_ROUTE = { queue: 'queue', calendar: 'appointments' };
    // ROLE_QUEUE_V1 — и «Видимость разделов»: скрытая у клиники «Очередь»
    // (пункт меню и #queue) не живёт и вкладкой «Пациентов». Правило —
    // оболочки (window.easymed.isNavHidden), как у меню и плиток «Настроек».
    const TAB_NAV = { queue: 'queue' };
    const allowedTabs = TABS.filter((t) => (!TAB_GRANT[t.id] || grantAllows(TAB_GRANT[t.id], 'view'))
        && (!TAB_ROUTE[t.id] || isRouteAllowed(TAB_ROUTE[t.id]))
        && (!TAB_NAV[t.id] || !navHidden(TAB_NAV[t.id]))
        && (!TAB_ROLES[t.id] || hasActorRole(TAB_ROLES[t.id])));   // WAIT_REG_V1
    // WAIT_REG_V1 — счётчик «Ждут регистрации» на самой вкладке: виден и тогда, когда открыта
    // другая вкладка (регистратор весь день в «Списке»). «0» не рисуется.
    const hasWaiting = allowedTabs.some((t) => t.id === 'waiting');
    // WAIT_REG_V1 (ревью, решение владельца) — РЕГИСТРАТУРЕ «Ждут регистрации» ПЕРВОЙ И ОТКРЫТОЙ ПО
    // УМОЛЧАНИЮ: её работа — те, кого сегодня ждут. Администратор (и регистратор, у которого есть ещё и
    // роль администратора) — «Список» первым, как прежде. Порядок — и полосы, и стрелок клавиатуры
    // (одна последовательность visibleTabs). Роль неизвестна — порядок прежний.
    const roles = actorRoleCodes();
    const deskFirst = hasWaiting && roles.includes('registrar') && !roles.includes('admin');
    const visibleTabs = deskFirst
        ? [...allowedTabs.filter((t) => t.id === 'waiting'), ...allowedTabs.filter((t) => t.id !== 'waiting')]
        : allowedTabs;
    const waitBadge = hasWaiting ? h('span', { class: 'reg-tab-badge', 'data-tab-badge': 'waiting', hidden: true, 'aria-hidden': 'true' }) : null;
    // REFERRALS_TAB_V1 — счётчик «Направлений врача»: сегодняшние открытые направления.
    const hasReferrals = allowedTabs.some((t) => t.id === 'referrals');
    const refBadge = hasReferrals ? h('span', { class: 'reg-tab-badge', 'data-tab-badge': 'referrals', hidden: true, 'aria-hidden': 'true' }) : null;
    function setReferralCount(n) {
        if (!refBadge) return;
        const k = Math.max(0, Number(n) || 0);
        refBadge.textContent = k > 0 ? String(k) : '';
        if (k > 0) refBadge.removeAttribute('hidden'); else refBadge.setAttribute('hidden', '');
        const b = buttons.referrals;
        if (b) b.setAttribute('aria-label', k > 0 ? trf('Направления врача: {n}', { n: k }) : tr('Направления врача'));
    }
    function setWaitingCount(n) {
        if (!waitBadge) return;
        const k = Math.max(0, Number(n) || 0);
        waitBadge.textContent = k > 0 ? String(k) : '';
        if (k > 0) waitBadge.removeAttribute('hidden'); else waitBadge.setAttribute('hidden', '');
        // ревью L5 — имя вкладки для читалки — с числом: «Записи CRM: 3» (сам значок ей не читается).
        const b = buttons.waiting;
        if (b) b.setAttribute('aria-label', k > 0 ? trf('Записи CRM: {n}', { n: k }) : tr('Записи CRM'));   // CRM_BOOKINGS_TAB_V1
    }
    for (const t of visibleTabs) {
        hosts[t.id] = h('div', {
            id: 'phub-panel-' + t.id, role: 'region',
            'aria-labelledby': 'phub-tab-' + t.id, 'data-tab-panel': t.id,
            style: { display: 'none' },
        });
        buttons[t.id] = h('button', {
            class: 'nav-item', type: 'button', title: t.label,
            id: 'phub-tab-' + t.id, 'aria-controls': 'phub-panel-' + t.id,
            'data-tab': t.id,
            // SUBVIEW_KEEPS_RAIL_V1 — кнопки стоят в колонке и на подэкранах раздела
            // (карта пациента). Оттуда кнопка сначала ВОЗВРАЩАЕТ в «Пациентов»
            // (панель из кэша, как была), потом переключает вкладку — в этом порядке:
            // select() пишет адрес вкладки replaceState, и до возврата он затёр бы
            // в истории запись карты пациента.
            // DUP_OWN_VIEW_V1 — любой пункт из «Дубликатов» выходит из дублей:
            // «Пациенты» — снова полный список, остальные — своя вкладка.
            onclick: () => { returnToHub(); if (dupView) setDuplicatesMode(false); select(t.id); },
        }, h('span', { class: 'nav-icon' }, Icon(t.icon, { size: 18 })), h('span', null, t.label), t.id === 'waiting' ? waitBadge : (t.id === 'referrals' ? refBadge : null));   // WAIT_REG_V1 — счётчик на пункте колонки
    }
    for (const t of visibleTabs) root.appendChild(hosts[t.id]);
    // DUP_TO_RAIL_V1 — «Дубликаты» отдельной группой под вкладками (черта между
    // группами — admin.js fillRailTools). Кнопку отдаёт список (patients.js),
    // когда смонтирован, — до этого её нет.
    let dupBtn = null;
    // DUP_OWN_VIEW_V1 — «Дубликаты» — свой пункт колонки: пока он открыт,
    // «Пациенты» НЕ выделены, адрес — #patients/duplicates (F5 и ссылка его
    // держат). Экран — тот же смонтированный список в режиме дублей (patients.js).
    let dupView = sub === 'duplicates';
    // REFERRALS_TAB_V1 — «Направления врача» — отдельным блоком под вкладками.
    const paintRail = () => setRailTools('patients', () => [
        visibleTabs.filter((t) => t.id !== 'referrals').map((t) => buttons[t.id]),
        hasReferrals ? [buttons.referrals] : [],
        dupBtn ? [dupBtn] : []]);
    paintRail();

    // Кнопка колонки нажата не из «Пациентов» (с карты пациента): сначала
    // вернуться в раздел (панель из кэша), потом действовать.
    function returnToHub() {
        const here = typeof window !== 'undefined' && window.easymed && window.easymed.state ? window.easymed.state.view : 'patients';
        if (here !== 'patients' && typeof ctx.onNavigate === 'function') ctx.onNavigate('patients');
    }

    // Вкладка монтируется при первом показе и дальше ЖИВЁТ: прокрутка списка,
    // страница пагинации и наполовину введённый поиск переживают уход на
    // соседнюю вкладку — ровно как панели переживают уход на соседний экран.
    const mounted = { list: false, queue: false, calendar: false, waiting: false, referrals: false };
    let referrals = null;   // REFERRALS_TAB_V1 — пульт списка «Направления врача»
    let queue = null;        // пульт доски очереди (views/queue.js)
    let waiting = null;      // WAIT_REG_V1 — пульт списка «Ждут регистрации» (views/registrar-waiting.js)
    let active = SUB_TO_TAB[sub] || (deskFirst ? 'waiting' : 'list');   // WAIT_REG_V1 (ревью) — регистратуре по умолчанию «Ждут регистрации»
    // GRANTS_V1 — адрес просит закрытую вкладку: открываем список, а не пустой экран.
    if (!visibleTabs.some((t) => t.id === active)) active = 'list';

    // PATIENTS_RAIL_V1 — в колонке кнопки — обычные пункты меню: каждая в порядке
    // обхода Tab, выбранная помечена aria-current (как у «Закупок» и CRM), а не
    // tablist со стрелками — роли tab вне полосы вкладок не место.

    function paintStrip({ animate = false } = {}) {
        for (const t of visibleTabs) {
            const shown = t.id === active;
            const on = shown && !(t.id === 'list' && dupView);   // DUP_OWN_VIEW_V1
            const b = buttons[t.id];
            b.className = 'nav-item' + (on ? ' active' : '');
            if (on) b.setAttribute('aria-current', 'page'); else if (b.removeAttribute) b.removeAttribute('aria-current');
            hosts[t.id].style.display = shown ? '' : 'none';
            // Проявление, а не переезд: панели лежат друг на друге в одном
            // месте, и любой сдвиг соседей на переключении вкладки читался бы
            // как перерисовка всего раздела. Появление играется только по
            // ДЕЙСТВИЮ пользователя — первое открытие раздела уже приезжает
            // со своей .fade-in.
            if (shown && animate) animateIn(hosts[t.id]);
        }
    }

    // URL отражает состояние: вкладка лежит в адресе, поэтому F5 её сохраняет,
    // а ссылку можно отдать коллеге. replaceState, а не pushState — переход
    // между вкладками одного раздела не новое место в истории, иначе выйти из
    // «Пациентов» кнопкой «Назад» пришлось бы в три нажатия.
    function syncSubUrl() {
        try {
            const tab = TABS.find((t) => t.id === active);
            // WAIT_REG_V1 (ревью) — у регистратуры без подмаршрута открывается «Ждут регистрации»: «Список»
            // пишется явно (#patients/list), иначе F5 уводил бы со списка.
            const nextSub = (active === 'list' && dupView) ? 'duplicates'   // DUP_OWN_VIEW_V1
                : ((tab && tab.sub) || (deskFirst && active === 'list' ? 'list' : null));
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
            // DUP_TO_RAIL_V1 — фильтр дубликатов живёт в списке: нажали с другой
            // вкладки — сначала открыть «Пациентов».
            dupBtn = duplicatesRailButton({
                beforeToggle: () => { returnToHub(); if (active !== 'list') select('list'); },
                // DUP_OWN_VIEW_V1 — режим сменился (кнопкой или адресом): колонка и адрес вслед.
                onChange: (on) => { const was = dupView; dupView = on; paintStrip(); if (was !== on) syncSubUrl(); },
            });
            if (dupView) setDuplicatesMode(true);   // пришли по #patients/duplicates
            paintRail();
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
        if (id === 'referrals') {   // REFERRALS_TAB_V1
            if (mounted.referrals) { if (referrals) await referrals.reload(); return; }
            mounted.referrals = true;
            referrals = await renderRegistrarWaiting(hosts.referrals, { mode: 'referrals', onNavigate: ctx.onNavigate, onCount: setReferralCount });
            return;
        }
        if (id === 'waiting') {   // WAIT_REG_V1
            if (mounted.waiting) { if (waiting) await waiting.reload(); return; }   // вернулись — свежее чтение
            mounted.waiting = true;
            waiting = await renderRegistrarWaiting(hosts.waiting, { onNavigate: ctx.onNavigate, onCount: setWaitingCount });
            return;
        }
        if (mounted.calendar) return;
        mounted.calendar = true;
        // CALENDAR_RETRY_V1 — флаг снимается обратно, если смонтировать не
        // удалось. Иначе одна неудачная загрузка (программа ещё поднималась,
        // сеть моргнула) держала бы заглушку до конца рабочего дня: переход на
        // соседнюю вкладку и обратно упирался бы в `mounted.calendar`.
        const ok = await mountCalendarInto(hosts.calendar, ctx, calendarLoader, {
            onRetry: () => { mounted.calendar = false; ensureMounted('calendar'); },
        });
        if (!ok) mounted.calendar = false;
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
        if (!initial) smoothScrollTo(root, { block: 'start' });   // PATIENTS_RAIL_V1 — полосы нет, к началу экрана
        // Опрос очереди живёт РОВНО столько, сколько её видно. Спрятанная доска,
        // которая продолжает каждые десять секунд ходить в базу, — это нагрузка
        // без единого читателя, и на смене таких вкладок накапливается.
        if (prev === 'queue' && id !== 'queue' && queue) queue.stop();
        if (!initial) syncSubUrl();
        await ensureMounted(id);
    }

    await select(active, { initial: true });

    // WAIT_REG_V1 — СЧЁТЧИК «ЖДУТ РЕГИСТРАЦИИ» ЖИВЁТ, ПОКА РАЗДЕЛ НА ЭКРАНЕ. Вкладка смонтирована —
    // перечитывается она сама (и называет число); нет — спрашивается только число. Будит его
    // запись визита, строки или счёта (live-relevance.js 'registrar', поток /api/live), а анализы
    // «на дату» потоком не приходят — поэтому ещё и раз в минуту. Сбой счётчика экран не роняет.
    let waitingTimer = null;
    let liveStop = () => {};
    // WAIT_REG_V1 (ревью M6) — список перечитывается целиком, только когда он ОТКРЫТ; иначе (другая
    // вкладка, вкладка ещё не открывалась) — только число (count_only: сервер не собирает подписи), а
    // смонтированный список перечитается сам при возврате на вкладку (ensureMounted).
    async function refreshWaiting({ referralsToo = true } = {}) {
        if (referralsToo) void refreshReferrals();   // REFERRALS_TAB_V1 — тем же будильником
        if (!hasWaiting) return;
        try {
            if (waiting && active === 'waiting') { await waiting.reload(); return; }   // вкладка назовёт число сама — по фильтру по умолчанию
            const res = await loadRegistrarWaiting({ countOnly: true, args: BADGE_ARGS });   // CRM_BOOKINGS_TAB_V1 — сегодняшние записи CRM, которые ждут
            setWaitingCount(res.count);
        } catch (_) { /* число не узнали — вкладка покажет причину сама, когда её откроют */ }
    }
    // REFERRALS_TAB_V1 — счётчик «Направлений врача»: открыт список — он назовёт число сам; иначе — только число.
    async function refreshReferrals() {
        if (!hasReferrals) return;
        try {
            if (referrals && active === 'referrals') { await referrals.reload(); return; }
            const res = await loadRegistrarWaiting({ countOnly: true, args: REFERRAL_BADGE_ARGS });
            setReferralCount(res.count);
        } catch (_) { /* число не узнали — вкладка покажет причину сама */ }
    }
    if (hasWaiting) {
        // Открытая вкладка число уже назвала сама — спрашивается только счётчик другой (REFERRALS_TAB_V1).
        if (active === 'waiting') void refreshReferrals();
        else void refreshWaiting({ referralsToo: active !== 'referrals' });
        liveStop = watchScreen({ root, screen: 'registrar', reload: () => refreshWaiting() });
        waitingTimer = setInterval(() => {
            if (root.isConnected === false) { clearInterval(waitingTimer); waitingTimer = null; return; }
            if (typeof document !== 'undefined' && document.hidden) return;
            // ревью M6 — раздел спрятан оболочкой (открыт другой экран, панель в кэше) — не опрашиваем:
            // вернётся на экран — живое обновление и следующий тик перечитают.
            if (!shownOnScreen(root)) return;
            void refreshWaiting();
        }, WAITING_POLL_MS);
        if (waitingTimer && typeof waitingTimer.unref === 'function') waitingTimer.unref();
    }

    return {
        activeTab: () => active,
        select,
        // Оболочка панель не размонтирует, пока та в кэше; когда размонтирует —
        // доска снимет свой таймер сама (views/queue.js следит за isConnected).
        destroy() {
            if (queue) queue.destroy();   // PATIENTS_RAIL_V1 — часов баннера больше нет
            if (waitingTimer) { clearInterval(waitingTimer); waitingTimer = null; }   // WAIT_REG_V1
            liveStop();
        },
    };
}
