// META_INBOX_V1 — «Чат Facebook и Instagram».
//
// Владелец (2026-10-31), глядя на «Чат с пациентами»: «i need one more window
// for facebook comments and messages … yes instagram too, yes build Chat
// facebook». Следом, со снимком «Входящих» Meta Business Suite: «make the
// design same as business facebook please» (META_INBOX_LAYOUT_V2) — поэтому
// раскладка повторяет привычные сотрудникам «Входящие»:
//   * сверху вкладки: Все сообщения · Messenger · Instagram · Комментарии на
//     Facebook · Комментарии в Instagram — со счётчиками непрочитанного;
//   * слева список с поиском и фильтрами «Непрочитанные» / «Без ответа»; у
//     аватара — значок канала в углу;
//   * в середине переписка: исходящие — цветом канала, большое поле
//     «Ответить в Instagram…»;
//   * справа — карточка человека: профиль, подробности, «Отметить как лид»
//     (карточка CRM), для комментария — пост и действия.
// Значки каналов — своими иконками (icons.js) и цветом канала, без логотипов.
//
// Сообщения приходят не мгновенно: клиника локальная, и сервер сам спрашивает
// Meta раз в минуту (meta/inbox-poller.js). Экран перечитывает базу каждые 15
// секунд — новое видно сразу, как оно пришло.
//
// Права — уровень раздела `meta-chat` в «Ролях»: «Просмотр» — читать,
// «Изменение» — отвечать, скрывать комментарии, заводить карточку CRM. Сервер
// проверяет то же самое; здесь скрытые кнопки лишь избавляют от отказа.
//
// Правила Meta, которые экран показывает заранее, а не отказом:
//   * переписка — ответ только в течение 24 часов после последнего сообщения
//     человека; позже поле ответа заменяется объяснением;
//   * ответ в личку на комментарий — один на комментарий.

import { supabase } from '../../supabase.js';
import { h, Icon, clear, toast, PageHead, initials, avColor, field } from '../ui.js';
import { tr, trf } from '../i18n.js';
import { canEdit } from '../permissions.js';
import { renderMetaChatStats } from './meta-chat-stats.js?v=ms1';   // META_INBOX_STATS_V1

// Вкладки сверху. Комментарии разделены по каналу, как во «Входящих» Meta.
export const TABS = [
    { key: 'all',         label: 'Все сообщения' },
    { key: 'messenger',   label: 'Messenger' },
    { key: 'instagram',   label: 'Instagram' },
    { key: 'fb_comments', label: 'Комментарии на Facebook' },
    { key: 'ig_comments', label: 'Комментарии в Instagram' },
];

const state = {
    tab: 'all',
    filter: '',                // '' | 'unread' | 'unanswered'
    info: null,                // meta_inbox_state
    conversations: [], threads: [], unread: null,
    active: null,              // id строки (переписка или комментарий)
    thread: null, query: '',
    drafts: {},                // начатый ответ по ключу tab:id — переживает перерисовку
    commentMode: 'public',     // 'public' | 'private'
    sending: false,
    view: 'inbox',             // 'inbox' | 'stats' — META_INBOX_STATS_V1
};
let refs = {};
let poll = null;

async function rpc(name, args = {}) {
    const { data, error } = await supabase.rpc(name, args);
    if (error) throw new Error(error.message || 'Не удалось выполнить запрос.');
    return data;
}

function canReply() {
    return state.info ? !!state.info.can_reply : canEdit('meta-chat');
}

const isComments = () => state.tab.endsWith('_comments');
const draftKey = () => state.tab + ':' + state.active;

export async function renderMetaChat(container) {
    clear(container);
    stopPolling();
    state.active = null; state.thread = null;
    state.view = 'inbox';

    const root = h('div', { class: 'fade-in', 'data-meta-chat': '' });
    container.appendChild(root);
    refs = { root };
    refs.headRight = h('div', { class: 'mc-head-right' });
    root.appendChild(PageHead({
        title: 'Чат Facebook и Instagram',
        subtitle: 'Сообщения страницы клиники в Messenger и Instagram и комментарии под постами и рекламой. Ответ уходит от имени клиники.',
        right: refs.headRight,
    }));
    refs.banner = h('div', { class: 'mc-banner-wrap' });
    root.appendChild(refs.banner);

    refs.tabs = h('div', { class: 'mc-tabs', role: 'tablist' });
    refs.search = h('input', {
        class: 'mc-search', placeholder: 'Поиск',
        oninput: (e) => { state.query = e.target.value.trim().toLowerCase(); paintList(); },
    });
    refs.filters = h('div', { class: 'mc-filters' });
    refs.list = h('div', { class: 'mc-list' });
    refs.pane = h('div', { class: 'mc-pane' });
    refs.side = h('aside', { class: 'mc-side' });
    refs.stats = h('div', { class: 'mc-stats-host', hidden: true });
    root.appendChild(refs.stats);
    root.appendChild(refs.shell = h('div', { class: 'mc-shell' },
        h('div', { class: 'card mc-main' },
            refs.tabs,
            h('div', { class: 'mc-body' },
                h('div', { class: 'mc-left' },
                    h('div', { class: 'mc-left-top' },
                        h('div', { class: 'mc-search-wrap' }, h('span', { class: 'mc-search-ico' }, Icon('Search', { size: 14 })), refs.search),
                        refs.filters),
                    refs.list),
                refs.pane)),
        refs.side));

    paintTabs();
    paintFilters();
    paintPane();
    await loadState();
    await loadList();
    poll = setInterval(() => {
        if (!root.isConnected) { stopPolling(); return; }
        if (state.view === 'stats') return;   // статистика перечитывается своими кнопками
        // Состояние тоже: первая проверка идёт через секунды после «Включить»,
        // и без этого шапка стояла на «Ждём первую проверку», пряча ответ Meta
        // (no_permission) до перезахода в окно.
        loadState().catch(() => {});
        loadList().catch(() => {});
        if (state.active) refreshThread(true).catch(() => {});
    }, 15000);
}

function stopPolling() { if (poll) { clearInterval(poll); poll = null; } }

// ---------------------------------------------------------------------------
// Состояние подключения: переключатель, «обновить», ошибки по частям
// ---------------------------------------------------------------------------
async function loadState() {
    try { state.info = await rpc('meta_inbox_state'); }
    catch (e) { state.info = null; toast(e.message, 'error'); }
    paintHead();
}

function paintHead() {
    const st = state.info;
    clear(refs.headRight);
    clear(refs.banner);
    if (!st) return;

    // META_INBOX_STATS_V1 — «Статистика» первой кнопкой шапки; на странице
    // статистики та же кнопка ведёт обратно к переписке.
    refs.headRight.appendChild(h('button', {
        class: 'btn btn-ghost mc-stats-btn' + (state.view === 'stats' ? ' is-active' : ''), type: 'button', 'data-meta-stats-toggle': '',
        onclick: () => showView(state.view === 'stats' ? 'inbox' : 'stats'),
    }, Icon(state.view === 'stats' ? 'ChevronLeft' : 'Chart', { size: 15 }), state.view === 'stats' ? 'К переписке' : 'Статистика'));

    const statusText = !st.connected ? 'Meta не подключена'
        : !st.enabled ? 'Опрос выключен'
        : st.last_poll_at ? trf('Проверено {when}', { when: timeShort(st.last_poll_at) }) : 'Ждём первую проверку…';
    refs.headRight.appendChild(h('span', { class: 'mc-status' + (st.enabled && st.connected ? ' is-on' : '') },
        h('span', { class: 'mc-dot' }), statusText));

    if (st.enabled && canReply()) {
        refs.headRight.appendChild(h('button', {
            class: 'mc-icon-btn', type: 'button', title: 'Спросить Meta сейчас, не дожидаясь минуты',
            onclick: async (e) => {
                const b = e.currentTarget;
                b.disabled = true;
                try { state.info = await rpc('meta_inbox_poll_now'); paintHead(); await loadList(); }
                catch (err) { toast(err.message, 'error'); }
                finally { b.disabled = false; }
            },
        }, Icon('Refresh', { size: 15 })));
    }
    if (st.can_manage && st.connected) {
        refs.headRight.appendChild(h('button', {
            class: 'btn ' + (st.enabled ? 'btn-ghost' : 'btn-primary'), type: 'button', 'data-meta-toggle': '',
            onclick: async (e) => {
                // currentTarget обнуляется после первого await: кнопку берём
                // заранее, иначе после ошибки она осталась бы выключенной
                // (current-target-after-await.test.mjs).
                const btn = e.currentTarget;
                btn.disabled = true;
                try { state.info = await rpc('meta_inbox_toggle', { enabled: !st.enabled }); paintHead(); }
                catch (err) { toast(err.message, 'error'); btn.disabled = false; }
            },
        }, st.enabled ? 'Выключить' : 'Включить'));
    }

    if (!st.connected) {
        refs.banner.appendChild(banner('info', 'Сначала подключите Meta: токен и страница клиники задаются в «Настройки → Коммерческие инструменты → Meta: заявки из рекламы». Затем включите опрос здесь.'));
    } else if (!st.enabled) {
        refs.banner.appendChild(banner('info', st.can_manage
            ? 'Опрос выключен: новые сообщения и комментарии не приходят. Нажмите «Включить» — первые придут в течение минуты. История до включения придёт прочитанной.'
            : 'Опрос выключен: новые сообщения и комментарии не приходят. Включает его администратор.'));
    }
    for (const e of st.errors || []) {
        refs.banner.appendChild(banner('warn', h('span', null, h('b', null, tr(partLabel(e.part)) + ': '), tr(e.text))));
    }
}

function showView(view) {
    state.view = view;
    const stats = view === 'stats';
    refs.shell.hidden = stats;
    refs.stats.hidden = !stats;
    paintHead();
    if (stats) renderMetaChatStats(refs.stats, { info: state.info }).catch((e) => toast(e.message, 'error'));
    else { clear(refs.stats); loadList().catch(() => {}); }
}

function partLabel(part) {
    return ({ ig: 'Instagram', messenger: 'Messenger', instagram: 'Instagram Direct', facebook: 'Комментарии Facebook', instagram_comments: 'Комментарии Instagram' })[part] || part;
}

function banner(kind, content) {
    return h('div', { class: 'mc-banner mc-banner-' + kind }, Icon(kind === 'warn' ? 'Warning' : 'Info', { size: 14 }), h('div', null, content));
}

// ---------------------------------------------------------------------------
// Вкладки, фильтры, список
// ---------------------------------------------------------------------------
function tabCount(key) {
    const u = state.unread || {};
    if (key === 'all') return (u.messenger || 0) + (u.instagram || 0);
    if (key === 'messenger' || key === 'instagram') return u[key] || 0;
    // Счётчик комментариев сервер не делит по каналу — делим по загруженным ниткам.
    const plat = key === 'fb_comments' ? 'facebook' : 'instagram';
    return state.threads.filter((t) => t.platform === plat).reduce((n, t) => n + (t.unread || 0), 0);
}

function paintTabs() {
    clear(refs.tabs);
    for (const t of TABS) {
        const n = tabCount(t.key);
        refs.tabs.appendChild(h('button', {
            type: 'button', role: 'tab', class: 'mc-tab' + (state.tab === t.key ? ' is-on' : ''), 'data-meta-tab': t.key,
            'aria-selected': state.tab === t.key ? 'true' : 'false',
            onclick: () => {
                if (state.tab === t.key) return;
                state.tab = t.key; state.active = null; state.thread = null; state.commentMode = 'public';
                paintTabs(); paintPane(); paintList();
            },
        }, t.label, n ? h('span', { class: 'mc-tab-count' }, String(n)) : null));
    }
}

function paintFilters() {
    clear(refs.filters);
    const chipBtn = (key, label) => h('button', {
        type: 'button', class: 'mc-filter' + (state.filter === key ? ' is-on' : ''), 'data-meta-filter': key,
        onclick: () => { state.filter = state.filter === key ? '' : key; paintFilters(); paintList(); },
    }, label);
    refs.filters.appendChild(chipBtn('unread', 'Непрочитанные'));
    refs.filters.appendChild(chipBtn('unanswered', 'Без ответа'));
}

async function loadList() {
    try {
        // Оба списка разом: у каждой вкладки сверху свой счётчик, и переход
        // между вкладками не ждёт сервера.
        const [conv, com] = await Promise.all([rpc('meta_inbox_conversations'), rpc('meta_inbox_comments')]);
        state.conversations = conv.conversations || [];
        state.threads = com.threads || [];
        state.unread = com.unread || conv.unread;
    } catch (e) {
        clear(refs.list);
        refs.list.appendChild(h('div', { class: 'empty', style: { padding: '24px' } }, e.message));
        stopPolling();
        return;
    }
    paintTabs();
    paintList();
    if (state.active) paintSide();
}

function convName(c) {
    return c.peer_name || (c.peer_username ? c.peer_username : '') || tr('Пользователь');
}

function paintList() {
    clear(refs.list);
    const q = state.query;
    const f = state.filter;
    if (isComments()) {
        const plat = state.tab === 'fb_comments' ? 'facebook' : 'instagram';
        const rows = state.threads.filter((t) => t.platform === plat)
            .filter((t) => (f !== 'unread' || t.unread > 0) && (f !== 'unanswered' || !t.answered))
            .filter((t) => !q || [t.author_name, t.text, t.post_text].some((v) => String(v || '').toLowerCase().includes(q)));
        if (!rows.length) { refs.list.appendChild(emptyList()); return; }
        for (const t of rows) refs.list.appendChild(threadRow(t));
        return;
    }
    const rows = state.conversations.filter((c) => state.tab === 'all' || c.platform === state.tab)
        .filter((c) => (f !== 'unread' || c.unread > 0) && (f !== 'unanswered' || c.last_direction === 'in'))
        .filter((c) => !q || [c.peer_name, c.peer_username, c.last_text].some((v) => String(v || '').toLowerCase().includes(q)));
    if (!rows.length) { refs.list.appendChild(emptyList()); return; }
    for (const c of rows) refs.list.appendChild(convRow(c));
}

function emptyList() {
    return h('div', { class: 'muted mc-empty-list' }, state.query || state.filter ? 'Ничего не найдено.'
        : isComments() ? 'Комментариев пока нет.' : 'Сообщений пока нет.');
}

// Аватар с значком канала в углу — как во «Входящих» Meta.
const PLATFORM_ICON = { messenger: 'Msg', instagram: 'Camera', facebook: 'Globe' };
function avatar(name, platform, size = 'md') {
    return h('div', { class: 'mc-av-wrap mc-av-' + size },
        h('div', { class: 'avatar mc-av ' + avColor(name) }, initials(name)),
        platform ? h('span', { class: 'mc-badge mc-badge-' + platform }, Icon(PLATFORM_ICON[platform] || 'Msg', { size: size === 'lg' ? 12 : 9 })) : null);
}

function listRow({ id, name, platform, text, at, unread, mine, tags = [] }) {
    const isActive = state.active === id;
    return h('div', {
        class: 'mc-row' + (isActive ? ' is-on' : '') + (unread ? ' is-unread' : ''), role: 'button', tabindex: '0', 'data-meta-row': String(id),
        onclick: () => openRow(id),
        onkeydown: (e) => { if (e.key === 'Enter') openRow(id); },
    },
        avatar(name, platform),
        h('div', { class: 'mc-row-body' },
            h('div', { class: 'mc-row-top' }, h('span', { class: 'mc-row-name' }, name), h('span', { class: 'mc-row-at' }, listStamp(at))),
            h('div', { class: 'mc-row-last' },
                h('span', { class: 'mc-row-text' }, mine ? h('span', { class: 'mc-you' }, tr('Вы: ')) : null, text || ''),
                unread ? h('span', { class: 'mc-unread-dot', title: String(unread) }) : null),
            tags.length ? h('div', { class: 'mc-row-tags' }, ...tags) : null));
}

function convRow(c) {
    const tags = [];
    if (c.crm_request_id) tags.push(tag('Лид'));
    if (!c.window_open && c.last_in_at) tags.push(tag('окно 24 ч закрыто', 'warn'));
    return listRow({ id: c.id, name: convName(c), platform: c.platform, text: c.last_text, at: c.last_at, unread: c.unread, mine: c.last_direction === 'out', tags });
}

function threadRow(t) {
    const tags = [];
    if (t.post_is_ad) tags.push(tag('Ответ на рекламу'));
    if (t.answered) tags.push(tag('отвечено', 'ok'));
    if (t.is_hidden) tags.push(tag('скрыт', 'warn'));
    if (t.crm_request_id) tags.push(tag('Лид'));
    return listRow({ id: t.id, name: t.author_name || tr('Пользователь'), platform: t.platform, text: t.text, at: t.last_at, unread: t.unread, mine: t.last_is_page, tags });
}

// ---------------------------------------------------------------------------
// Середина: переписка или нитка комментария
// ---------------------------------------------------------------------------
async function openRow(id) {
    state.active = id;
    state.thread = null;
    state.commentMode = 'public';
    paintList();
    paintPane(true);
    await refreshThread(false);
    loadList().catch(() => {});   // счётчик непрочитанных погас
    try { window.easymed && window.easymed.refreshNav && window.easymed.refreshNav(); } catch (e) { /* значок обновится опросом */ }
}

async function refreshThread(quiet) {
    if (!state.active) return;
    const id = state.active, comments = isComments();
    let next;
    try {
        next = comments
            ? await rpc('meta_inbox_comment_thread', { id })
            : await rpc('meta_inbox_messages', { id });
    } catch (e) { if (!quiet) toast(e.message, 'error'); return; }
    if (state.active !== id || isComments() !== comments) return;   // пока ждали, открыли другое
    const changed = JSON.stringify(next) !== JSON.stringify(state.thread);
    state.thread = next;
    // Перерисовка только по изменению: иначе поле ответа теряло бы фокус каждые 15 секунд.
    if (changed) paintPane();
}

function paintPane(loading = false) {
    clear(refs.pane);
    paintSide();
    if (loading) { refs.pane.appendChild(h('div', { class: 'muted', style: { margin: 'auto', padding: '30px' } }, 'Загрузка…')); return; }
    if (!state.thread) {
        refs.pane.appendChild(h('div', { class: 'mc-pane-empty' },
            h('div', { class: 'mc-pane-empty-ico' }, Icon(isComments() ? 'NotePencil' : 'Msg', { size: 26 })),
            h('div', { class: 'mc-pane-empty-title' }, isComments() ? 'Выберите комментарий слева' : 'Выберите переписку слева'),
            h('div', { class: 'muted mc-pane-empty-text' }, isComments()
                ? 'Здесь появится пост, комментарий и ответы под ним. Ответить можно публично или автору в личку.'
                : 'Здесь появится переписка: вопросы человека и ответы клиники.')));
        return;
    }
    if (isComments()) paintCommentThread(state.thread);
    else paintConversation(state.thread);
}

function paneHead(name, platform, sub) {
    return h('div', { class: 'mc-pane-head' },
        avatar(name, platform, 'md'),
        h('div', { class: 'mc-pane-who' },
            h('div', { class: 'mc-pane-name' }, name),
            sub ? h('div', { class: 'mc-pane-sub' }, sub) : null));
}

function paintConversation(t) {
    const c = t.conversation;
    refs.pane.appendChild(paneHead(convName(c), c.platform, c.platform === 'instagram' ? 'Instagram Direct' : 'Messenger'));

    const feed = h('div', { class: 'mc-feed' });
    if (!t.messages.length) feed.appendChild(h('div', { class: 'muted mc-feed-empty' }, 'Сообщений пока нет.'));
    let prevDay = null;
    t.messages.forEach((m, i) => {
        const day = String(m.created_at || '').slice(0, 10);
        if (day !== prevDay) { feed.appendChild(dayDivider(m.created_at)); prevDay = day; }
        // Аватар — у последнего входящего подряд, как в мессенджерах.
        const next = t.messages[i + 1];
        const lastOfRun = !next || next.direction !== m.direction;
        feed.appendChild(messageBubble(m, c, lastOfRun));
    });
    refs.pane.appendChild(feed);
    setTimeout(() => { feed.scrollTop = feed.scrollHeight; }, 0);

    if (!canReply()) { refs.pane.appendChild(readOnlyBar()); return; }
    if (!c.window_open) {
        refs.pane.appendChild(h('div', { class: 'mc-closed', 'data-meta-window-closed': '' }, Icon('Clock', { size: 14 }),
            h('div', null, 'Прошло больше 24 часов после последнего сообщения человека — Meta не разрешает отвечать. Ответить можно, когда он напишет снова; или заведите карточку CRM и позвоните.')));
        return;
    }
    refs.pane.appendChild(composer({
        placeholder: c.platform === 'instagram' ? 'Ответить в Instagram…' : 'Ответить в Messenger…',
        hint: c.window_until ? trf('Ответить можно до {when}', { when: fullStamp(c.window_until) }) : '',
        send: (text) => rpc('meta_inbox_send', { id: c.id, text }),
    }));
}

function messageBubble(m, c, lastOfRun) {
    const out = m.direction === 'out';
    const failed = m.status === 'failed';
    // Вложения — ссылкой, а не картинкой в ленте: файл лежит у Meta, и
    // программа, которая работает без интернета, не тянет его сама. Открывает
    // человек, у чьего компьютера интернет есть.
    const attIcon = (a) => Icon(a.type === 'image' ? 'Image' : a.type === 'video' ? 'Camera' : 'Paperclip', { size: 12 });
    const attLabel = (a) => a.type === 'image' ? tr('картинка') : a.type === 'video' ? tr('видео') : (a.name || tr('вложение'));
    const att = (m.attachments || []).map((a) => a.url
        ? h('a', { href: a.url, target: '_blank', rel: 'noopener noreferrer', class: 'mc-att' }, attIcon(a), ' ', attLabel(a))
        : h('span', { class: 'mc-att' }, attIcon(a), ' ', attLabel(a)));
    const name = convName(c);
    return h('div', { class: 'mc-msg' + (out ? ' is-out' : '') },
        !out ? (lastOfRun ? h('div', { class: 'avatar mc-msg-av ' + avColor(name) }, initials(name)) : h('div', { class: 'mc-msg-av-gap' })) : null,
        h('div', { class: 'mc-msg-col' },
            h('div', { class: 'mc-bubble' + (out ? ' is-out mc-out-' + c.platform : '') + (failed ? ' is-failed' : ''), title: fullStamp(m.created_at) },
                m.text ? h('div', { class: 'mc-bubble-text' }, m.text) : null,
                ...att),
            out && (m.sent_by_name || failed) ? h('div', { class: 'mc-msg-note' },
                m.sent_by_name ? trf('Ответил(-а): {name}', { name: m.sent_by_name }) : '',
                failed ? h('span', { class: 'mc-failed' }, (m.sent_by_name ? ' · ' : ''), tr('не доставлено')) : null,
                failed && m.error_text ? h('div', { class: 'mc-failed-text' }, tr(m.error_text)) : null) : null));
}

function paintCommentThread(t) {
    const root = t.comments.find((c) => c.is_root) || t.comments[0];
    const name = (root && root.author_name) || tr('Пользователь');
    refs.pane.appendChild(paneHead(name, t.post.platform, t.post.is_ad ? 'Ответ на рекламу' : (t.post.platform === 'instagram' ? 'Комментарий в Instagram' : 'Комментарий на Facebook')));

    const feed = h('div', { class: 'mc-feed' });
    feed.appendChild(h('div', { class: 'mc-post' },
        h('div', { class: 'mc-post-label' }, t.post.is_ad ? 'Рекламный пост' : 'Пост'),
        h('div', { class: 'mc-post-text' }, t.post.text || tr('(без подписи)')),
        t.post.url ? h('a', { class: 'mc-post-link', href: t.post.url, target: '_blank', rel: 'noopener' }, Icon('Link', { size: 12 }), ' ', tr('Открыть в Meta')) : null));
    for (const c of t.comments) feed.appendChild(commentCard(c));
    refs.pane.appendChild(feed);
    setTimeout(() => { feed.scrollTop = feed.scrollHeight; }, 0);

    if (!canReply()) { refs.pane.appendChild(readOnlyBar()); return; }
    // Ответ в личку — последнему комментарию человека, на который в личку ещё не отвечали.
    const target = privateTarget(t);
    if (state.commentMode === 'private' && !target) state.commentMode = 'public';
    const modes = h('div', { class: 'mc-modes', role: 'tablist' },
        modeBtn('public', 'Ответ под комментарием'),
        target ? modeBtn('private', trf('В личку: {name}', { name: target.author_name || tr('автору') })) : null);
    refs.pane.appendChild(composer({
        top: modes,
        placeholder: state.commentMode === 'private' ? 'Сообщение автору в Messenger / Direct…' : 'Публичный ответ — его увидят все…',
        hint: state.commentMode === 'private' ? tr('Meta разрешает один ответ в личку на комментарий, в течение 7 дней.') : '',
        send: (text) => state.commentMode === 'private'
            ? rpc('meta_inbox_comment_private', { id: target.id, text })
            : rpc('meta_inbox_comment_reply', { id: root.id, text }),
    }));
}

function privateTarget(t) {
    return [...t.comments].reverse().find((c) => !c.is_page && !c.private_replied_at) || null;
}

function modeBtn(mode, label) {
    return h('button', {
        type: 'button', class: 'mc-mode' + (state.commentMode === mode ? ' is-on' : ''), 'data-meta-mode': mode,
        onclick: () => { if (state.commentMode !== mode) { state.commentMode = mode; paintPane(); } },
    }, label);
}

function commentCard(c) {
    const actions = [];
    if (!c.is_page && canReply()) actions.push(hideButton(c, 'mc-link-btn'));
    // META_INBOX_LEAD_FORM_V1 — лидом может стать любой, кто написал в нитке, а
    // не только автор первого комментария: под каждым — «В CRM» или номер лида.
    if (!c.is_page && c.crm_request_id) actions.push(tag(trf('Лид №{id}', { id: c.crm_request_id }), 'ok'));
    else if (!c.is_page && canReply()) {
        actions.push(h('button', { type: 'button', class: 'mc-link-btn', 'data-meta-crm-comment': String(c.id),
            onclick: () => openLeadForm({ kind: 'comment', id: c.id, name: c.author_name || '' }) }, tr('В CRM')));
    }
    return h('div', { class: 'mc-comment' + (c.is_page ? ' is-page' : '') + (c.is_root ? '' : ' is-reply') + (c.is_hidden ? ' is-hidden' : '') },
        c.is_page ? null : h('div', { class: 'avatar mc-msg-av ' + avColor(c.author_name || '?') }, initials(c.author_name || '?')),
        h('div', { class: 'mc-comment-col' },
            h('div', { class: 'mc-comment-bubble' },
                h('div', { class: 'mc-comment-author' }, c.author_name || tr('Пользователь')),
                h('div', { class: 'mc-comment-text' }, c.text)),
            h('div', { class: 'mc-comment-meta' },
                h('span', null, fullStamp(c.created_at)),
                c.is_page && c.sent_by_name ? h('span', null, trf('Ответил(-а): {name}', { name: c.sent_by_name })) : null,
                c.is_hidden ? tag('скрыт', 'warn') : null,
                c.private_replied_at ? tag('ответ в личку отправлен', 'ok') : null,
                ...actions)));
}

function hideButton(c, cls) {
    return h('button', {
        type: 'button', class: cls, 'data-meta-hide': String(c.id),
        onclick: async (e) => {
            e.currentTarget.disabled = true;
            try {
                const r = await rpc('meta_inbox_comment_hide', { id: c.id, hidden: !c.is_hidden });
                if (!r.ok) toast(tr(r.message), 'error');
                await refreshThread(true); await loadList();
            } catch (err) { toast(err.message, 'error'); }
        },
    }, c.is_hidden ? tr('Показать') : tr('Скрыть'));
}

function readOnlyBar() {
    return h('div', { class: 'mc-readonly' }, Icon('Warning', { size: 13 }), 'Доступ «только чтение» — отвечать от имени клиники нельзя.');
}

/** Поле ответа: Enter — отправить, Shift+Enter — перенос. Черновик живёт в state.drafts. */
function composer({ top = null, placeholder, hint = '', send }) {
    const key = draftKey();
    const input = h('textarea', { class: 'mc-input', rows: '2', placeholder, 'data-meta-input': '' });
    input.value = state.drafts[key] || '';
    const grow = () => { input.style.height = 'auto'; input.style.height = Math.min(Math.max(input.scrollHeight, 44), 160) + 'px'; };
    input.addEventListener('input', () => { state.drafts[key] = input.value; grow(); });
    const go = async () => {
        const text = input.value.trim();
        if (!text || state.sending) return;
        state.sending = true; btn.disabled = true;
        try {
            const r = await send(text);
            if (r && r.ok === false) toast(r.message ? tr(r.message) : tr('Не отправлено.'), 'error');
            else { state.drafts[key] = ''; input.value = ''; grow(); }
            await refreshThread(true);
            await loadList();
        } catch (e) { toast(e.message, 'error'); }
        finally { state.sending = false; btn.disabled = false; }
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); go(); } });
    const btn = h('button', { type: 'button', class: 'mc-send', title: 'Отправить', 'data-meta-send': '', onclick: go }, Icon('Send', { size: 16 }));
    setTimeout(() => { grow(); }, 0);
    return h('div', { class: 'mc-composer' },
        top,
        h('div', { class: 'mc-composer-box' },
            input,
            h('div', { class: 'mc-composer-foot' },
                h('span', { class: 'mc-hint' }, hint),
                btn)));
}

// ---------------------------------------------------------------------------
// Справа: карточка человека
// ---------------------------------------------------------------------------
function paintSide() {
    clear(refs.side);
    const t = state.thread;
    if (!t) {
        refs.side.appendChild(h('div', { class: 'mc-side-empty muted' }, 'Откройте переписку — здесь появится карточка человека.'));
        return;
    }
    if (isComments()) paintCommentSide(t);
    else paintConversationSide(t);
}

function sideSection(title, ...body) {
    return h('section', { class: 'mc-side-sec' }, h('div', { class: 'mc-side-title' }, title), ...body);
}
function sideRow(label, value) {
    return h('div', { class: 'mc-side-row' }, h('span', { class: 'mc-side-label' }, label), h('span', { class: 'mc-side-value' }, value));
}

function leadSection(kind, id, existing, name) {
    if (existing) {
        return sideSection('Этап лида', h('div', { class: 'mc-lead-done' }, Icon('Check', { size: 14 }), trf('Карточка CRM №{id}', { id: existing })));
    }
    if (!canReply()) return sideSection('Этап лида', h('div', { class: 'muted mc-side-note' }, 'Ещё не в CRM.'));
    return sideSection('Этап лида',
        h('button', {
            class: 'mc-side-btn', type: 'button', 'data-meta-crm': '',
            onclick: () => openLeadForm({ kind, id, name }),
        }, 'Отметить как лид'),
        h('div', { class: 'muted mc-side-note' }, 'Создаёт карточку в CRM с источником Meta и последними сообщениями человека.'));
}

// META_INBOX_LEAD_FORM_V1 — форма «Лид в CRM» вместо окошка браузера с одним
// телефоном: имя (из Meta, можно поправить), телефон, комментарий сотрудника,
// «Ответственный — я». Окно того же вида, что окна кассы (.modal).
function openLeadForm({ kind, id, name }) {
    const overlay = h('div', { class: 'modal', 'data-meta-lead-form': '' });
    const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    const nameIn = h('input', { type: 'text', maxlength: '200', 'data-lead-name': '', style: { width: '100%' } });
    nameIn.value = name || '';
    const phoneIn = h('input', { type: 'tel', placeholder: '+998 90 123 45 67', 'data-lead-phone': '', style: { width: '100%' } });
    const commentIn = h('textarea', { rows: '3', maxlength: '2000', placeholder: tr('Что хочет человек, когда удобно связаться…'), 'data-lead-comment': '', style: { width: '100%' } });
    const takeIn = h('input', { type: 'checkbox', 'data-lead-take': '' });
    takeIn.checked = true;
    const save = h('button', { class: 'btn btn-primary', type: 'button', 'data-lead-save': '' }, Icon('Check', { size: 14 }), ' ', tr('Создать лид'));
    save.addEventListener('click', async () => {
        save.disabled = true;
        try {
            const r = await rpc('meta_inbox_to_crm', {
                kind, id, name: nameIn.value.trim(), phone: phoneIn.value.trim(), comment: commentIn.value.trim(), take: !!takeIn.checked,
            });
            if (!r.ok) { toast(tr(r.message), 'error'); save.disabled = false; return; }
            toast(r.status === 'merged' ? tr('Записано в открытую карточку CRM с этим номером.') : tr('Карточка CRM создана.'), 'success');
            close();
            await refreshThread(true); await loadList();
        } catch (e) { toast(e.message, 'error'); save.disabled = false; }
    });
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));
    overlay.appendChild(h('div', { class: 'modal-card modal-compact', style: { width: '460px', maxWidth: 'calc(100vw - 32px)' } },
        h('header', { class: 'modal-head' },
            h('h2', null, Icon('Plus', { size: 16 }), ' ', tr('Лид в CRM')),
            h('button', { class: 'modal-close', type: 'button', 'aria-label': tr('Закрыть'), onclick: close }, '×')),
        h('div', { class: 'modal-body', style: { display: 'grid', gap: '12px' } },
            field(tr('Имя'), nameIn),
            field(tr('Телефон (если знаете)'), phoneIn),
            field(tr('Комментарий'), commentIn),
            h('label', { style: { display: 'flex', gap: '8px', alignItems: 'center' } }, takeIn, tr('Ответственный — я')),
            h('div', { class: 'muted mc-side-note' }, tr('В карточку попадут источник Meta и последние сообщения человека. Если по этому номеру уже есть открытая карточка, запись допишется в неё.'))),
        h('footer', { class: 'modal-foot' },
            h('button', { class: 'btn', type: 'button', onclick: close }, tr('Отмена')),
            save)));
    document.body.appendChild(overlay);
    setTimeout(() => { try { phoneIn.focus(); } catch (_) { /* поддельный DOM проверок */ } }, 0);
}

function paintConversationSide(t) {
    const c = t.conversation;
    const name = convName(c);
    const msgs = t.messages || [];
    const firstIn = msgs.find((m) => m.direction === 'in');
    refs.side.appendChild(h('div', { class: 'mc-side-profile' },
        avatar(name, c.platform, 'lg'),
        h('div', { class: 'mc-side-who' },
            h('div', { class: 'mc-side-name' }, name),
            c.peer_username ? h('div', { class: 'mc-side-handle' }, '@' + c.peer_username) : null)));
    refs.side.appendChild(sideSection('Подробнее',
        sideRow(tr('Канал'), c.platform === 'instagram' ? 'Instagram Direct' : 'Messenger'),
        firstIn ? sideRow(tr('Первое сообщение'), fullStamp(firstIn.created_at)) : null,
        sideRow(tr('Сообщений'), String(msgs.length)),
        sideRow(tr('Ответить можно'), c.window_open && c.window_until ? trf('до {when}', { when: fullStamp(c.window_until) }) : tr('окно закрыто'))));
    refs.side.appendChild(leadSection('conversation', c.id, c.crm_request_id, name));
}

function paintCommentSide(t) {
    const root = t.comments.find((c) => c.is_root) || t.comments[0];
    const name = (root && root.author_name) || tr('Пользователь');
    refs.side.appendChild(h('div', { class: 'mc-side-profile' },
        avatar(name, t.post.platform, 'lg'),
        h('div', { class: 'mc-side-who' },
            h('div', { class: 'mc-side-name' }, name),
            h('div', { class: 'mc-side-handle' }, t.post.platform === 'instagram' ? 'Instagram' : 'Facebook'))));
    const others = t.comments.filter((c) => !c.is_page);
    refs.side.appendChild(sideSection('Подробнее',
        sideRow(tr('Где'), t.post.is_ad ? tr('Реклама') : tr('Пост')),
        sideRow(tr('Комментариев в нитке'), String(t.comments.length)),
        sideRow(tr('Ответ клиники'), t.comments.some((c) => c.is_page) ? tr('есть') : tr('нет')),
        sideRow(tr('Ответ в личку'), others.some((c) => c.private_replied_at) ? tr('отправлен') : tr('нет')),
        t.post.url ? h('a', { class: 'mc-post-link', href: t.post.url, target: '_blank', rel: 'noopener' }, Icon('Link', { size: 12 }), ' ', tr('Открыть в Meta')) : null));
    refs.side.appendChild(leadSection('comment', root.id, root.crm_request_id, root.author_name || ''));
    if (canReply() && root && !root.is_page) {
        refs.side.appendChild(sideSection('Действия', hideButton(root, 'mc-side-btn')));
    }
}

// ---------------------------------------------------------------------------
// Мелочи
// ---------------------------------------------------------------------------
function tag(text, tone = 'plain') {
    return h('span', { class: 'mc-tag mc-tag-' + tone }, text);
}

function timeShort(iso) {
    const d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function fullStamp(iso) {
    const d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function listStamp(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const now = new Date();
    const yest = new Date(now); yest.setDate(now.getDate() - 1);
    if (d.toDateString() === now.toDateString()) return timeShort(iso);
    if (d.toDateString() === yest.toDateString()) return tr('вчера');
    return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
}

function dayDivider(iso) {
    const d = new Date(iso);
    const now = new Date();
    const yest = new Date(now); yest.setDate(now.getDate() - 1);
    const label = isNaN(d) ? '—'
        : d.toDateString() === now.toDateString() ? tr('Сегодня') + ' ' + timeShort(iso)
        : d.toDateString() === yest.toDateString() ? tr('Вчера') + ' ' + timeShort(iso)
        : d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' }) + ' ' + timeShort(iso);
    return h('div', { class: 'mc-day' }, label);
}
