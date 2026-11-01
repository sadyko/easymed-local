// COMMERCE_TOOLS_V1 — пункт меню «Коммерческие инструменты»: список инструментов.
//
// Владелец (2026-10-30), глядя на экран Push-уведомления прямо на месте пункта:
// «it is one of the instrument call push notification. I will build next one so
// make them separate, as there will be more instrument». Поэтому пункт меню —
// витрина, а каждый инструмент — свой экран со своим адресом (#commerce-push …)
// и «Назад» сюда (PARENT_OF в admin.js).
//
// Новый инструмент = строка в TOOLS + маршрут в admin.js (case, CRUMBS,
// PARENT_OF: 'commerce') + правило в permissions.js isRouteAllowed. Карточка
// видна только тому, кому её экран открыт: витрина не зовёт в «Нет доступа».

import { h, Icon, PageHead, clear } from '../ui.js';
import { tr } from '../i18n.js';
import { isRouteAllowed } from '../permissions.js';
import { supabase } from '../../supabase.js';   // CHATS_TO_COMMERCE_V1 — непрочитанные на карточках чатов

// CHATS_TO_COMMERCE_V1 (2026-10-31, владелец: «put these two chat place to
// commercial instruments and messages should appear on top of commercial
// block») — два чата ушли из бокового меню сюда, ПЕРВЫМ блоком «Сообщения»,
// над инструментами: переписка — то, что ждёт ответа сейчас, а инструменты —
// то, что запускают по плану. На карточке — сколько не прочитано (те же RPC,
// что кормят значок пункта меню в admin.js), красным, как в меню.
export const CHATS = [
    {
        route: 'telegram-chat',
        icon: 'Msg',
        title: 'Чат с пациентами',
        desc: 'Переписка с пациентами в Telegram-боте клиники.',
        unreadRpc: 'telegram_chat_unread', unreadOf: (d) => d && d.unread,
    },
    {
        route: 'meta-chat',
        icon: 'Globe',
        title: 'Чат Facebook и Instagram',
        desc: 'Сообщения и комментарии страницы клиники в Facebook и Instagram.',
        unreadRpc: 'meta_inbox_unread', unreadOf: (d) => d && d.total,
    },
];

// CLINIC_NEWS_V1 (2026-10-31, владелец: «add here informative dashboard button
// too, where can be added daily news of clinic, about foreign doctors coming,
// some equipment is not working place and so on») — доска объявлений для
// сотрудников. Свой блок «Для сотрудников» между чатами и инструментами:
// это не переписка с пациентами и не инструмент продаж, а новости клиники.
export const BOARD = {
    route: 'clinic-news',
    icon: 'Info',
    title: 'Информационная доска',
    desc: 'Новости клиники для сотрудников: приезжие врачи, неработающее оборудование, объявления дня.',
};

/** Чаты, которые роли можно открыть. */
export function visibleChats() {
    return CHATS.filter((c) => isRouteAllowed(c.route));
}

export const TOOLS = [
    {
        route: 'commerce-push',
        icon: 'Megaphone',
        title: 'Push-уведомления',
        desc: 'Рассылка пациентам в Telegram или по SMS: текст, предпросмотр, фильтры по визитам и услугам.',
    },
    // Владелец: «add this to commercial instrument too» — тот же экран, что
    // плитка в «Настройки → Коммерческие инструменты»; плитка там осталась.
    {
        route: 'telegram-deeplinks',
        icon: 'Link',
        title: 'Ссылки для рекламы в Telegram',
        desc: 'Своя ссылка на бота для каждого объявления: ответ, файл, кнопка «Оставить заявку», счётчики переходов и заявок',
    },
    // REFERRALS_TO_COMMERCE_V1 (2026-10-31, владелец: «put refirrirovania to
    // commercial instruments too») — раздел целиком, со своими вкладками;
    // пункта меню у него больше нет (admin.js NAV).
    {
        route: 'referrals',
        icon: 'Target',
        title: 'Реферирование',
        desc: 'Представители и внешние врачи, внутренние направления, активность врачей и боты для врачей и представителей.',
    },
];

/** Инструменты, которые роли можно открыть. */
export function visibleTools() {
    return TOOLS.filter((t) => isRouteAllowed(t.route));
}

export function renderCommerceHub(container, ctx = {}) {
    clear(container);
    const root = h('div', { class: 'fade-in', 'data-commerce-hub': '' });
    container.appendChild(root);
    root.appendChild(PageHead({
        title: 'Коммерческие инструменты',
        subtitle: 'Инструменты для работы с пациентами. Подключения (SMS, Telegram, Meta) настраиваются в «Настройки → Коммерческие инструменты».',
    }));

    const tools = visibleTools();
    const chats = visibleChats();   // CHATS_TO_COMMERCE_V1
    const board = isRouteAllowed(BOARD.route) ? BOARD : null;   // CLINIC_NEWS_V1
    if (!tools.length && !chats.length && !board) {
        root.appendChild(h('div', { class: 'empty', style: { padding: '30px' } }, 'Коммерческие инструменты вашей роли недоступны.'));
        return;
    }
    const open = (t) => { if (ctx.onNavigate) ctx.onNavigate(t.route); };
    const card = (t, attr, badge = null) => h('div', {
        class: 'card ct-card',
        role: 'button',
        tabindex: '0',
        [attr]: t.route,
        onclick: () => open(t),
        onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(t); } },
    },
        h('span', { class: 'ct-ico' }, Icon(t.icon, { size: 22 }), badge),
        h('div', { class: 'ct-title' }, t.title),
        h('div', { class: 'ct-desc' }, t.desc),
        h('span', { class: 'ct-open' }, tr('Открыть'), Icon('ChevronRight', { size: 14 })),
    );
    const groupHead = (text) => h('div', { class: 'ct-group' }, text);

    if (chats.length) {
        root.appendChild(groupHead(tr('Сообщения')));
        root.appendChild(h('div', { class: 'ct-grid', 'data-commerce-chats': '' }, ...chats.map((c) => {
            // Значок заполняется, когда ответит сервер; пока — пусто, а не «0».
            const badge = h('span', { class: 'ct-badge', 'data-chat-unread': c.route, hidden: true });
            loadUnread(c).then((n) => {
                if (n > 0) { badge.textContent = n > 99 ? '99+' : String(n); badge.hidden = false; }
            });
            return card(c, 'data-commerce-chat', badge);
        })));
    }
    if (board) {
        root.appendChild(groupHead(tr('Для сотрудников')));
        root.appendChild(h('div', { class: 'ct-grid', 'data-commerce-board': '' }, card(board, 'data-commerce-news')));
    }
    if (tools.length) {
        if (chats.length || board) root.appendChild(groupHead(tr('Инструменты')));
        root.appendChild(h('div', { class: 'ct-grid' }, ...tools.map((t) => card(t, 'data-commerce-tool'))));
    }
}

/** Непрочитанные чата; сбой счётчика — просто без значка, экран не ломается. */
async function loadUnread(chat) {
    try {
        const { data, error } = await supabase.rpc(chat.unreadRpc);
        if (error) return 0;
        return Number(chat.unreadOf(data)) || 0;
    } catch (_) { return 0; }
}
