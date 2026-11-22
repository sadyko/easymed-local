// REFERRALS_CRM_V1 (2026-10-26) — «Реферирование»: полоса вкладок. REFERRALS_NAV_V1 —
// свой пункт группы «Операции» (владелец: «should not be inside of CRM it should be
// separate section in operation block»); первые полдня открывался кнопкой из CRM.
//
// Владелец прислал шесть снимков прежнего облачного экрана и сказал: «under
// the CRM build Реферирование block … Referal external doctors are in setting
// now and it should be bring here without process change in registration and
// other places». Экран собирает в одном месте то, что раньше лежало по
// настройкам и отчётам: внешних врачей и их представителей, внутренних
// врачей-направителей, категории источников, активность. Данные — те же
// таблицы и те же RPC отчётов (см. server/services/rpc/referrals.js).
//
// Устроен как «Пациенты» (PATIENTS_HUB_V1): вкладки с подмаршрутом
// '#referrals/<sub>' (HASH_SUBROUTE_V1), ленивый монтаж, смонтированная
// вкладка живёт, пока открыт экран. Вкладка «Telegram-бот» (вторая очередь,
// миграция 253) добавится в TABS, когда появится.
import { h, Icon, clear, PageHead } from '../ui.js';
import { tr } from '../i18n.js';
import { animateIn } from '../motion.js?v=mo1';
import { actorIsAdmin, currentRoleLabel } from '../permissions.js';
import { renderReferralsRepresentatives } from './referrals-representatives.js';
import { renderReferralsSources, renderReferralsCategories } from './referrals-sources.js';
import { renderReferralsInternal } from './referrals-internal.js';
import { renderReferralsActivity } from './referrals-activity.js';
import { renderReferralsBot } from './referrals-bot.js';
import { renderReferralsRepBot } from './referrals-rep-bot.js';   // REP_BOT_V1
import { rpc } from './referrals-common.js';   // REP_OWN_DOCTORS_V1
import { setRailTools } from '../rail-tools.js';   // REFERRALS_RAIL_SUB_V1

export const TABS = [
    { id: 'reps',       sub: null,         label: 'Представители',        icon: 'User',        render: renderReferralsRepresentatives },
    { id: 'sources',    sub: 'sources',    label: 'Врачи-источники',      icon: 'Stethoscope', render: renderReferralsSources },
    // REP_OWN_DOCTORS_V1 — медпредставителю врачи клиники не показываются (сервер и так откажет).
    { id: 'internal',   sub: 'internal',   label: 'Внутренние врачи',     icon: 'Patients',    render: renderReferralsInternal, hideForRep: true },
    { id: 'categories', sub: 'categories', label: 'Категории источников', icon: 'Folder',      render: renderReferralsCategories },
    { id: 'activity',   sub: 'activity',   label: 'Активность врачей',    icon: 'Activity',    render: renderReferralsActivity },
    // Токен бота открывает переписку с врачами — вкладка только администратору,
    // как и настройки пациентского бота (TELEGRAM_BOT_V1).
    { id: 'bot',        sub: 'bot',        label: 'Telegram-бот',         icon: 'Bot',         render: renderReferralsBot, adminOnly: true },
    // REP_BOT_V1 — третий бот: медпредставители заводят врачей из Telegram. Тоже только администратору.
    { id: 'repbot',     sub: 'repbot',     label: 'Бот представителей',   icon: 'Bot',         render: renderReferralsRepBot, adminOnly: true },
];
const SUB_TO_TAB = Object.fromEntries(TABS.filter((t) => t.sub).map((t) => [t.sub, t.id]));
// REP_PREVIEW_V1 — имена роли медпредставителя, как их узнаёт сервер
// (services/representative.js REPRESENTATIVE_ROLE_NAMES и код medrep), в нижнем регистре.
// i18n-exempt: имя роли из базы для сравнения, на экран не выводится
export const REP_ROLE_NAMES = ['медпредставитель', 'medrep'];

export async function renderReferrals(container, ctx = {}) {
    clear(container);
    const tabId = ctx.tabId || null;
    const sub = ctx.payload && ctx.payload.sub;
    // REP_OWN_DOCTORS_V1 — кто медпредставитель, решает сервер (роль клиники может
    // называться по-своему); не ответил — вкладки как прежде, а данные всё равно
    // ограничит сервер.
    let ownOnly = false;
    try { ownOnly = !!(await rpc('referrals_scope')).own_only; } catch { /* вкладки как прежде */ }
    // REP_PREVIEW_V1 (2026-11-22, владелец: «when med rep is entering with his role, he should
    // only see his doctors, he shouldn't see internal doctors block» — смотрел через «Просмотр
    // как роль»). Предпросмотр роли меняет только экран: сервер по-прежнему отвечает
    // администратору (referrals_scope → own_only: false), и вкладка «Внутренние врачи»
    // оставалась. Роль предпросмотра — строка roles только с именем, поэтому узнаём её по
    // имени, тем же списком, что сервер (services/representative.js). Своих врачей у
    // предпросмотра нет — нет конкретного человека; плашка ниже говорит, где их увидеть.
    const previewRep = !ownOnly && REP_ROLE_NAMES.includes(String(currentRoleLabel() || '').trim().toLowerCase());
    const TABS_VISIBLE = TABS.filter((t) => (!t.adminOnly || actorIsAdmin()) && !((ownOnly || previewRep) && t.hideForRep));

    const root = h('div', { class: 'fade-in ref-hub' });
    container.appendChild(root);
    root.appendChild(PageHead({
        title: 'Реферирование',
        subtitle: 'Кто направляет пациентов в клинику: внешние врачи через представителей и врачи самой клиники',
    }));
    // REP_PREVIEW_V1 — честная оговорка предпросмотра: вкладки — как у представителя,
    // а списки врачей — все (сервер отвечает администратору).
    if (previewRep) {
        root.appendChild(h('div', { class: 'ref-preview-note', 'data-ref-preview-rep': '' },
            Icon('Info', { size: 15 }),
            h('div', null,
                h('b', null, 'Просмотр как роль «Медпредставитель»'),
                h('div', null, 'Вкладки — как у представителя, но в списках видны все врачи клиники: у предпросмотра роли нет конкретного человека. Чтобы увидеть ровно то, что видит представитель, — только его врачей, — нажмите «Войти как сотрудник» у этого сотрудника в «Сотрудниках».'))));
    }

    const strip = h('div', { class: 'reg-tabs', role: 'tablist', 'aria-label': 'Разделы «Реферирования»' });
    const buttons = {};
    const hosts = {};
    for (const t of TABS_VISIBLE) {
        hosts[t.id] = h('div', {
            id: 'ref-panel-' + t.id, role: 'tabpanel', 'aria-labelledby': 'ref-tab-' + t.id,
            'data-tab-panel': t.id, style: { display: 'none' },
        });
        buttons[t.id] = h('button', {
            class: 'reg-tab', type: 'button', role: 'tab', id: 'ref-tab-' + t.id,
            'aria-controls': 'ref-panel-' + t.id, 'aria-selected': 'false', tabindex: '-1', 'data-tab': t.id,
            onclick: () => { select(t.id); },
            onkeydown: (ev) => moveByKey(ev, t.id),
        }, Icon(t.icon, { size: 14 }), h('span', null, t.label));
        strip.appendChild(buttons[t.id]);
    }
    // REFERRALS_RAIL_SUB_V1 (2026-11-21, владелец со снимком вкладок: «can you put
    // all these button as a sub to under the referals block») — полоса вкладок
    // не над экраном, а в левой колонке «Коммерции», подпунктами под
    // «Реферированием» (admin.js commerceRail берёт её из реестра rail-tools).
    // Сами кнопки, их обработчики, aria и адреса #referrals/<вкладка> прежние.
    strip.setAttribute('aria-orientation', 'vertical');
    setRailTools('referrals', () => [[strip]]);
    for (const t of TABS_VISIBLE) root.appendChild(hosts[t.id]);

    const mounted = new Set();
    let active = SUB_TO_TAB[sub] || 'reps';
    if (!TABS_VISIBLE.some((t) => t.id === active)) active = 'reps';   // закладка на вкладку, которой у этой роли нет

    function moveByKey(ev, id) {
        const key = ev && ev.key;
        // REFERRALS_RAIL_SUB_V1 — вкладки стоят столбцом: стрелки вверх/вниз тоже.
        const step = (key === 'ArrowRight' || key === 'ArrowDown') ? 1 : (key === 'ArrowLeft' || key === 'ArrowUp') ? -1 : 0;
        let next = null;
        if (step) {
            const i = TABS_VISIBLE.findIndex((t) => t.id === id);
            next = TABS_VISIBLE[(i + step + TABS_VISIBLE.length) % TABS_VISIBLE.length];
        } else if (key === 'Home') next = TABS_VISIBLE[0];
        else if (key === 'End') next = TABS_VISIBLE[TABS_VISIBLE.length - 1];
        if (!next) return;
        if (typeof ev.preventDefault === 'function') ev.preventDefault();
        select(next.id);
        buttons[next.id].focus();
    }

    function paintStrip({ animate = false } = {}) {
        for (const t of TABS_VISIBLE) {
            const on = t.id === active;
            const b = buttons[t.id];
            b.className = 'reg-tab' + (on ? ' on' : '');
            b.setAttribute('aria-selected', on ? 'true' : 'false');
            b.setAttribute('tabindex', on ? '0' : '-1');
            hosts[t.id].style.display = on ? '' : 'none';
            if (on && animate) animateIn(hosts[t.id]);
        }
    }

    function syncSubUrl() {
        try {
            const tab = TABS.find((t) => t.id === active);
            const nextSub = (tab && tab.sub) || null;
            if (typeof history !== 'undefined' && history.replaceState) {
                history.replaceState({ view: 'referrals', payload: nextSub ? { sub: nextSub } : null },
                    '', '#referrals' + (nextSub ? '/' + nextSub : ''));
            }
            if (typeof window !== 'undefined' && typeof window.easymedSetTabSub === 'function') {
                window.easymedSetTabSub(tabId, nextSub);
            }
        } catch (e) {
            // история недоступна (тест, старый браузер) — вкладка всё равно переключится
        }
    }

    // REFERRAL_EDIT_FROM_REPS_V1 — «Изменить» у врача в «Представителях»:
    // карточка врача живёт во вкладке «Врачи-источники» (редактор справочника,
    // settings-hub.js), поэтому кнопка переключает вкладку и открывает там
    // карточку этой строки — ту же, что открывает щелчок по ней.
    const tabCtx = {
        ...ctx,
        openSourceCard: TABS_VISIBLE.some((t) => t.id === 'sources') ? async (sourceId) => {
            // Вкладка, откуда пришли, при возврате рисуется заново: иначе она
            // показывала бы прежний номер и телефон, которые только что сменили.
            if (active !== 'sources') mounted.delete(active);
            await select('sources');
            const open = hosts.sources && hosts.sources.openLookupRow;
            return typeof open === 'function' ? open(sourceId) : false;
        } : null,
    };

    async function ensureMounted(id) {
        if (mounted.has(id)) return;
        mounted.add(id);
        const tab = TABS.find((t) => t.id === id);
        try {
            await tab.render(hosts[id], tabCtx);
        } catch (e) {
            clear(hosts[id]);
            hosts[id].appendChild(h('div', { class: 'empty', style: { padding: '30px' } },
                tr('Не удалось открыть вкладку.'), ' ', h('code', null, (e && e.message) || String(e))));
        }
    }

    async function select(id) {
        if (!TABS_VISIBLE.some((t) => t.id === id)) id = 'reps';
        active = id;
        paintStrip({ animate: true });
        syncSubUrl();
        await ensureMounted(id);
    }

    paintStrip();
    await ensureMounted(active);
    return { select, get active() { return active; } };
}
