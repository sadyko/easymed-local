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
import { actorIsAdmin } from '../permissions.js';
import { renderReferralsRepresentatives } from './referrals-representatives.js';
import { renderReferralsSources, renderReferralsCategories } from './referrals-sources.js';
import { renderReferralsInternal } from './referrals-internal.js';
import { renderReferralsActivity } from './referrals-activity.js';
import { renderReferralsBot } from './referrals-bot.js';

export const TABS = [
    { id: 'reps',       sub: null,         label: 'Представители',        icon: 'User',        render: renderReferralsRepresentatives },
    { id: 'sources',    sub: 'sources',    label: 'Врачи-источники',      icon: 'Stethoscope', render: renderReferralsSources },
    { id: 'internal',   sub: 'internal',   label: 'Внутренние врачи',     icon: 'Patients',    render: renderReferralsInternal },
    { id: 'categories', sub: 'categories', label: 'Категории источников', icon: 'Folder',      render: renderReferralsCategories },
    { id: 'activity',   sub: 'activity',   label: 'Активность врачей',    icon: 'Activity',    render: renderReferralsActivity },
    // Токен бота открывает переписку с врачами — вкладка только администратору,
    // как и настройки пациентского бота (TELEGRAM_BOT_V1).
    { id: 'bot',        sub: 'bot',        label: 'Telegram-бот',         icon: 'Bot',         render: renderReferralsBot, adminOnly: true },
];
const SUB_TO_TAB = Object.fromEntries(TABS.filter((t) => t.sub).map((t) => [t.sub, t.id]));

export async function renderReferrals(container, ctx = {}) {
    clear(container);
    const tabId = ctx.tabId || null;
    const sub = ctx.payload && ctx.payload.sub;
    const TABS_VISIBLE = TABS.filter((t) => !t.adminOnly || actorIsAdmin());

    const root = h('div', { class: 'fade-in ref-hub' });
    container.appendChild(root);
    root.appendChild(PageHead({
        title: 'Реферирование',
        subtitle: 'Кто направляет пациентов в клинику: внешние врачи через представителей и врачи самой клиники',
    }));

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
    root.appendChild(strip);
    for (const t of TABS_VISIBLE) root.appendChild(hosts[t.id]);

    const mounted = new Set();
    let active = SUB_TO_TAB[sub] || 'reps';
    if (!TABS_VISIBLE.some((t) => t.id === active)) active = 'reps';   // закладка на вкладку, которой у этой роли нет

    function moveByKey(ev, id) {
        const key = ev && ev.key;
        const step = key === 'ArrowRight' ? 1 : key === 'ArrowLeft' ? -1 : 0;
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

    async function ensureMounted(id) {
        if (mounted.has(id)) return;
        mounted.add(id);
        const tab = TABS.find((t) => t.id === id);
        try {
            await tab.render(hosts[id], ctx);
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
