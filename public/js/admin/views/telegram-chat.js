// TELEGRAM_CHAT_V1 — «Чат с пациентами».
//
// Две колонки, как в Telegram: слева список чатов, справа лента сообщений.
// Раздел живёт в левом меню, а не в отчётах: отчёт смотрят раз в месяц, а сюда
// заходят отвечать людям, и он должен быть на виду.
//
// Право решает уровень доступа роли: «Просмотр» показывает переписку без поля
// ввода, «Редактирование» разрешает отвечать. Сервер проверяет то же самое —
// здесь скрытое поле ввода лишь избавляет от бессмысленного отказа.
//
// TELEGRAM_BROADCAST_V2 — в шапке живёт кнопка «Сообщение пациентам»,
// открывающая поп-ап массовой рассылки (telegram-report.js). Раньше эта форма
// стояла в «Отчётах» рядом со статистикой бота; отчёт смотрят раз в месяц, а
// рассылку отправляют оттуда же, где отвечают людям. В отчёте остались только
// подключения и охват.

import { supabase } from '../../supabase.js';
import { threadChanged } from '../../shared/thread-sync.js?v=ts1';   // TELEGRAM_DRAFT_KEEP_V1
// TELEGRAM_CHAT_FILE_V1 — те же правила вложения, что и на сервере.
import { attachmentError, isImageName, humanSize } from '../../shared/chat-attachment.js?v=att1';
import { uploadFile } from '../storage.js';
import { h, Icon, clear, toast, PageHead, initials, avColor } from '../ui.js';
import { canEdit } from '../permissions.js';

// TELEGRAM_CHAT_FOLDERS_V1 — вкладки над списком, как в Telegram.
// `tab` — 'all' | 'unread' | номер папки. «Все» и «Непрочитанные» вычисляются
// на лету и в базе не хранятся: это не папки, а взгляды на один и тот же список.
const state = {
  chats: [], folders: [], active: null, thread: null,
  tab: 'all', query: '', sending: false,
  // TELEGRAM_DRAFT_KEEP_V1 — начатый ответ по чатам: опрос ленты перерисовывает
  // панель вместе с полем ввода, и без этого набранный текст пропадал прямо во
  // время печати. Черновик переживает и перерисовку, и переход в другой чат.
  drafts: {},
  // TELEGRAM_CHAT_FILE_V1 — выбранные, но ещё не отправленные файлы, по чатам.
  // Живут рядом с черновиком и по той же причине: опрос ленты пересобирает
  // панель, и выбранное вложение иначе исчезало бы вместе с полем ввода.
  attachments: {},
};
let refs = {};
let poll = null;

async function rpc(name, args = {}) {
    const { data, error } = await supabase.rpc(name, args);
    if (error) throw new Error(error.message || 'Не удалось выполнить запрос.');
    return data;
}

// 'viewer' — только читать. Поле ответа не рисуем вовсе: кнопка, которая всегда
// отвечает отказом, хуже её отсутствия.
function canReply() {
    return canEdit('telegram-chat');
}

// TELEGRAM_BROADCAST_V2 — рассылка переехала сюда из «Отчётов», но правило
// доступа у неё своё: на СЕРВЕРЕ она admin-only (rpc/telegram.js → requireAdmin
// → hasAnyRole(user, ['admin'])), тогда как сам чат выдаётся ролям через
// «Настройки → Роли». Поэтому кнопку показываем только админу — по тому же
// правилу, что и поле ответа выше.
//
// Роли считаем ТАК ЖЕ, как сервер: основная + extra_roles. Смотреть только на
// user.role — это ровно тот «primary-role-only» баг, который в
// server/services/roles.js уже исправлен: администратор по дополнительной роли
// не увидел бы кнопку, хотя сервер его пропускает.
function canBroadcast() {
    const u = (typeof window !== 'undefined' && window.easymed && window.easymed.state && window.easymed.state.user) || null;
    if (!u) return false;
    if (u.is_super_admin === true || u.is_admin === true) return true;
    const extra = Array.isArray(u.extra_roles) ? u.extra_roles : [];
    return [u.role, ...extra].includes('admin');
}

// Модуль рассылки грузим по клику, а не при входе в чат: сюда заходят отвечать
// людям, и большинству эта форма за сессию не понадобится ни разу.
function broadcastButton() {
    const btn = h('button', { class: 'btn btn-primary', type: 'button', onclick: async () => {
        btn.disabled = true;
        try {
            const m = await import('./telegram-report.js?v=tgr5');
            m.openBroadcastModal();
        } catch (e) {
            toast('Не удалось открыть форму рассылки: ' + (e.message || e), 'error');
        } finally { btn.disabled = false; }
    } }, Icon('Send', { size: 13 }), ' Сообщение пациентам');
    return btn;
}

export async function renderTelegramChat(container) {
    clear(container);
    stopPolling();

    const root = h('div', { class: 'fade-in' });
    container.appendChild(root);
    root.appendChild(PageHead({
        title: 'Чат с пациентами',
        subtitle: canReply()
            ? 'Сообщения пациентов из Telegram-бота. Ответ уходит пациенту от имени клиники.'
            : 'Сообщения пациентов из Telegram-бота. У вас доступ только на чтение.',
        right: canBroadcast() ? broadcastButton() : null,   // TELEGRAM_BROADCAST_V2
    }));

    // Папки — вертикальной полосой слева, как в Telegram Desktop: горизонтальная
    // лента вкладок обрезает названия уже на третьей папке, а вертикальная
    // растёт вниз сколько нужно и оставляет списку всю ширину.
    refs.rail = h('div', { style: {
        width: '76px', flex: '0 0 76px', borderRight: '1px solid var(--ink-100)',
        background: 'var(--ink-25,#f6f8f9)', overflowY: 'auto', overflowX: 'hidden',
        padding: '6px 0', display: 'flex', flexDirection: 'column', gap: '2px',
    } });

    // Поле поиска — «таблеткой» с иконкой внутри и крестиком очистки: обычный
    // прямоугольный input посреди мессенджера выглядит деталью из другой эпохи.
    refs.search = h('input', {
        placeholder: 'Поиск',
        oninput: (e) => { state.query = e.target.value.trim().toLowerCase(); paintClear(); paintList(); },
        style: {
            width: '100%', border: '1px solid transparent', borderRadius: '99px',
            background: 'var(--ink-50,#f1f4f5)', padding: '8px 30px 8px 32px',
            fontSize: '13px', outline: 'none', transition: 'background .12s, border-color .12s',
        },
        onfocus: (e) => { e.target.style.background = 'var(--white,#fff)'; e.target.style.borderColor = 'var(--primary-300)'; },
        onblur: (e) => { e.target.style.background = 'var(--ink-50,#f1f4f5)'; e.target.style.borderColor = 'transparent'; },
    });
    refs.clearBtn = h('button', {
        type: 'button', title: 'Очистить',
        onclick: () => { refs.search.value = ''; state.query = ''; paintClear(); paintList(); refs.search.focus(); },
        style: {
            position: 'absolute', right: '8px', top: '50%', transform: 'translateY(-50%)',
            border: 'none', background: 'transparent', cursor: 'pointer', display: 'none',
            color: 'var(--ink-500)', padding: '2px', lineHeight: '1',
        },
    }, Icon('X', { size: 13 }));

    const searchWrap = h('div', { style: { position: 'relative', padding: '10px 10px 8px', flex: '0 0 auto' } },
        h('span', { style: {
            position: 'absolute', left: '20px', top: '50%', transform: 'translateY(-50%)',
            color: 'var(--ink-400)', pointerEvents: 'none', display: 'flex',
        } }, Icon('Search', { size: 14 })),
        refs.search, refs.clearBtn);

    refs.list = h('div', { style: { flex: '1', overflow: 'auto' } });

    const leftCol = h('div', { style: {
        width: '320px', flex: '0 0 320px', borderRight: '1px solid var(--ink-100)',
        display: 'flex', flexDirection: 'column', minHeight: '0', background: 'var(--white,#fff)',
    } }, searchWrap, refs.list);
    refs.pane = h('div', { style: { flex: '1', display: 'flex', flexDirection: 'column', minWidth: '0' } });

    root.appendChild(h('div', { class: 'card', style: {
        display: 'flex', height: 'calc(100vh - 210px)', minHeight: '420px', overflow: 'hidden', padding: '0',
    } }, refs.rail, leftCol, refs.pane));

    function paintClear() { refs.clearBtn.style.display = refs.search.value ? 'block' : 'none'; }

    paintPane(null);
    await loadChats();
    // Лёгкий опрос: сообщения приходят в бота, а не в браузер, поэтому список
    // сам себя обновляет. 10 секунд — компромисс между «живо» и «не долбить БД».
    poll = setInterval(() => { loadChats().catch(() => {}); if (state.active) refreshThread(); }, 10000);
}

function stopPolling() { if (poll) { clearInterval(poll); poll = null; } }

async function loadChats() {
    let res;
    try { res = await rpc('telegram_chats_list'); }
    catch (e) {
        clear(refs.list);
        refs.list.appendChild(h('div', { class: 'empty', style: { padding: '24px' } }, e.message));
        stopPolling();
        return;
    }
    state.chats = res.chats || [];
    state.folders = res.folders || [];
    paintTabs();
    paintList();
}

// ---------------------------------------------------------------------------
// Вкладки: Все · Непрочитанные · папки клиники
// ---------------------------------------------------------------------------
function unreadChats() { return state.chats.filter((c) => c.unread > 0); }

function chatsForTab(tab) {
    if (tab === 'all') return state.chats;
    if (tab === 'unread') return unreadChats();
    const id = Number(tab);
    return state.chats.filter((c) => (c.folders || []).includes(id));
}

// Одна «кнопка папки» в вертикальной полосе: иконка, подпись под ней и
// счётчик уголком — раскладка Telegram Desktop.
function railItem({ label, icon, count, active, onclick, ondblclick, title }) {
    const badge = count ? h('span', { style: {
        position: 'absolute', top: '2px', right: '10px',
        background: active ? 'var(--primary-600)' : 'var(--ink-400)', color: '#fff',
        borderRadius: '99px', fontSize: '10px', lineHeight: '1', padding: '3px 5px', minWidth: '16px',
        textAlign: 'center', fontWeight: '600',
    } }, String(count)) : null;

    const btn = h('button', {
        type: 'button', title: title || label, onclick, ondblclick,
        style: {
            position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center',
            gap: '3px', padding: '9px 4px 7px', margin: '0 5px', border: 'none', borderRadius: '10px',
            background: active ? 'var(--primary-50)' : 'transparent',
            color: active ? 'var(--primary-700)' : 'var(--ink-500)',
            cursor: 'pointer', fontFamily: 'inherit', width: 'calc(100% - 10px)',
            transition: 'background .12s, color .12s',
        },
        onmouseenter: (e) => { if (!active) e.currentTarget.style.background = 'var(--ink-50,#f1f4f5)'; },
        onmouseleave: (e) => { if (!active) e.currentTarget.style.background = 'transparent'; },
    },
        Icon(icon, { size: 19 }),
        h('span', { style: {
            fontSize: '10.5px', fontWeight: active ? '600' : '500', lineHeight: '1.15',
            textAlign: 'center', maxWidth: '64px', overflow: 'hidden',
            textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block',
        } }, label),
        badge);
    return btn;
}

function paintTabs() {
    clear(refs.rail);

    refs.rail.appendChild(railItem({
        label: 'Все', icon: 'Msg', count: state.chats.length, active: state.tab === 'all',
        onclick: () => { state.tab = 'all'; paintTabs(); paintList(); },
    }));
    refs.rail.appendChild(railItem({
        label: 'Непроч.', title: 'Непрочитанные', icon: 'Bell', count: unreadChats().length,
        active: state.tab === 'unread',
        onclick: () => { state.tab = 'unread'; paintTabs(); paintList(); },
    }));

    if (state.folders.length) {
        refs.rail.appendChild(h('div', { style: {
            height: '1px', background: 'var(--ink-100)', margin: '6px 12px',
        } }));
    }

    for (const f of state.folders) {
        refs.rail.appendChild(railItem({
            label: f.name, icon: 'Folder', count: f.count, active: String(state.tab) === String(f.id),
            title: f.name + (canReply() ? ' — двойной клик: переименовать или удалить' : ''),
            onclick: () => { state.tab = String(f.id); paintTabs(); paintList(); },
            ondblclick: () => { if (canReply()) editFolder(f); },
        }));
    }

    // Папки заводит тот, кто ведёт переписку. Читателю кнопку не показываем —
    // она всё равно получила бы отказ на сервере.
    if (canReply()) {
        refs.rail.appendChild(railItem({
            label: 'Папка', title: 'Новая папка', icon: 'Plus', count: 0, active: false,
            onclick: newFolder,
        }));
    }
}

async function newFolder() {
    const name = prompt('Название папки (например, «Долги» или «Анализы готовы»):');
    if (name === null) return;
    try {
        const res = await rpc('telegram_folder_save', { name });
        state.folders = res.folders;
        paintTabs();
        toast('Папка создана. Добавляйте в неё чаты кнопкой 📁 в списке.', 'success');
    } catch (e) { toast(e.message, 'error'); }
}

async function editFolder(folder) {
    const name = prompt('Переименовать папку (пустое поле — удалить папку):', folder.name);
    if (name === null) return;
    try {
        const res = String(name).trim()
            ? await rpc('telegram_folder_save', { id: folder.id, name })
            : await rpc('telegram_folder_save', { delete_id: folder.id });
        state.folders = res.folders;
        // Удалили открытую вкладку — возвращаемся к «Всем», иначе список пуст
        // без объяснимой причины.
        if (!state.folders.some((f) => String(f.id) === String(state.tab))) state.tab = 'all';
        paintTabs();
        paintList();
    } catch (e) { toast(e.message, 'error'); }
}

// Папки чата: чат может лежать в нескольких сразу, как в Telegram.
async function openFolderPicker(chat, anchor) {
    if (!state.folders.length) return newFolder();
    const menu = h('div', { style: {
        position: 'fixed', zIndex: '200', background: 'var(--white,#fff)',
        border: '1px solid var(--ink-100)', borderRadius: '12px', padding: '6px',
        boxShadow: '0 12px 34px rgba(11,20,24,.16)', minWidth: '200px',
    } });
    menu.appendChild(h('div', { style: {
        fontSize: '10.5px', fontWeight: '700', letterSpacing: '.04em', textTransform: 'uppercase',
        color: 'var(--ink-400)', padding: '4px 8px 6px',
    } }, 'Папки чата'));

    const r = anchor.getBoundingClientRect();
    menu.style.left = Math.min(r.left, window.innerWidth - 220) + 'px';
    menu.style.top = (r.bottom + 6) + 'px';

    for (const f of state.folders) {
        const inIt = (chat.folders || []).includes(f.id);
        menu.appendChild(h('label', { style: {
            display: 'flex', gap: '9px', alignItems: 'center', padding: '7px 8px',
            cursor: 'pointer', fontSize: '13px', borderRadius: '8px',
        },
            onmouseenter: (e) => { e.currentTarget.style.background = 'var(--ink-25,#f6f8f9)'; },
            onmouseleave: (e) => { e.currentTarget.style.background = 'transparent'; },
        },
            h('input', { type: 'checkbox', checked: inIt, onchange: async (e) => {
                try {
                    const res = await rpc('telegram_folder_set_chat', {
                        folder_id: f.id, chat_id: chat.chat_id, member: e.target.checked,
                    });
                    state.chats = res.chats; state.folders = res.folders;
                    paintTabs(); paintList();
                } catch (err) { toast(err.message, 'error'); }
            } }),
            f.name));
    }
    const close = (e) => { if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('mousedown', close); } };
    document.addEventListener('mousedown', close);
    document.body.appendChild(menu);
}

function paintList() {
    clear(refs.list);
    if (!state.chats.length) {
        refs.list.appendChild(h('div', { class: 'muted', style: { padding: '24px', fontSize: '13px' } },
            'Пока никто не писал. Пациенты появляются здесь, как только подключат бота.'));
        return;
    }

    // Поиск идёт и по имени в Telegram, и по ФИО пациента, и по номеру, и по
    // тексту последнего сообщения: сотрудник ищет «того, кто спрашивал про
    // анализ», а не строку в конкретном поле.
    const q = state.query;
    const rows = chatsForTab(state.tab).filter((c) => !q || [
        c.tg_name, c.tg_username, c.phone, c.last_text,
        ...(c.patients || []).map((p) => p.name),
    ].some((v) => String(v || '').toLowerCase().includes(q)));

    if (!rows.length) {
        refs.list.appendChild(h('div', { class: 'muted', style: { padding: '24px', fontSize: '13px' } },
            q ? 'Ничего не найдено.'
              : state.tab === 'unread' ? 'Непрочитанных нет.' : 'В этой папке пока нет чатов.'));
        return;
    }

    for (const c of rows) {
        const name = c.tg_name || c.tg_username || ('Чат ' + c.chat_id);
        // TELEGRAM_ORPHAN_CHAT_V1 — «ничей» чат: человек написал, но связка не
        // создалась (номер набрали текстом вместо кнопки «Поделиться номером»).
        // Раньше такие чаты в список не попадали вовсе, и их непрочитанные
        // висели в бейдже навсегда — открыть было нечего.
        const who = c.unlinked
            ? (c.candidates && c.candidates.length
                ? 'не связан · похоже на ' + c.candidates.map((p) => p.name).join(', ')
                : 'не связан' + (c.candidate_phone ? ' · набрал ' + c.candidate_phone : ''))
            : (c.patients.length ? c.patients.map((p) => p.name).join(', ') : 'карта не найдена');
        const isActive = state.active === c.chat_id;

        // Кнопка папок живёт ВНУТРИ строки, поэтому сама строка — div, а не
        // button: вложенная кнопка в кнопке невалидна и в части браузеров
        // просто не получает клик.
        const folderBtn = !canReply() ? null : h('button', {
            type: 'button', title: 'Папки этого чата',
            onclick: (e) => { e.stopPropagation(); openFolderPicker(c, e.currentTarget); },
            style: {
                flex: '0 0 auto', border: 'none', background: 'transparent', cursor: 'pointer',
                color: (c.folders || []).length ? 'var(--primary-600)' : 'var(--ink-400)',
                padding: '4px', alignSelf: 'center', borderRadius: '8px',
                transition: 'opacity .12s, background .12s',
            },
            onmouseenter: (e) => { e.currentTarget.style.background = 'var(--ink-100)'; },
            onmouseleave: (e) => { e.currentTarget.style.background = 'transparent'; },
        }, Icon('Folder', { size: 14 }));

        // Выделение — скруглённой «плашкой» с отступами, а не полосой во всю
        // ширину: список из плотно уложенных карточек читается как список, а не
        // как таблица, и активный чат видно боковым зрением.
        const row = h('div', {
            onclick: () => openChat(c.chat_id),
            style: {
                position: 'relative', display: 'flex', gap: '11px', alignItems: 'center',
                padding: '9px 10px', margin: '2px 8px', borderRadius: '12px',
                background: isActive ? 'var(--primary-50)' : 'transparent',
                cursor: 'pointer', fontFamily: 'inherit', transition: 'background .12s',
            },
            onmouseenter: (e) => {
                if (!isActive) e.currentTarget.style.background = 'var(--ink-25,#f6f8f9)';
                if (folderBtn) folderBtn.style.opacity = '1';
            },
            onmouseleave: (e) => {
                if (!isActive) e.currentTarget.style.background = 'transparent';
                if (folderBtn && !(c.folders || []).length) folderBtn.style.opacity = '0';
            },
        },
            h('div', { class: 'avatar ' + avColor(name), style: {
                width: '44px', height: '44px', flex: '0 0 auto', borderRadius: '50%',
                display: 'grid', placeItems: 'center', fontSize: '14.5px', fontWeight: '600',
            } }, initials(name)),

            h('div', { style: { flex: '1', minWidth: '0' } },
                // Строка 1: имя слева, время справа — как в любом мессенджере.
                h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '8px' } },
                    h('span', { style: {
                        fontWeight: '600', fontSize: '13.5px', color: 'var(--ink-900)',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: '1',
                    } }, name),
                    h('span', { style: { fontSize: '11px', color: 'var(--ink-400)', flex: '0 0 auto' } },
                        listStamp(c.last_at))),

                // Строка 2: кто это в клинике.
                h('div', { style: {
                    fontSize: '11.5px', color: 'var(--ink-500)', marginTop: '1px',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                } }, who),

                // Строка 3: последнее сообщение и счётчик непрочитанных.
                h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginTop: '2px' } },
                    h('span', { style: {
                        flex: '1', minWidth: '0', fontSize: '12.5px',
                        color: c.unread ? 'var(--ink-800)' : 'var(--ink-500)',
                        fontWeight: c.unread ? '500' : '400',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    } },
                        c.last_direction === 'out'
                            ? h('span', { style: { color: 'var(--primary-600)' } }, 'Вы: ')
                            : null,
                        c.last_text || 'нет сообщений'),
                    c.unread ? h('span', { style: {
                        background: 'var(--primary-500)', color: '#fff', borderRadius: '99px',
                        fontSize: '11px', fontWeight: '600', padding: '1px 6px', minWidth: '18px',
                        textAlign: 'center', flex: '0 0 auto',
                    } }, String(c.unread)) : null),

                c.blocked ? h('div', { style: {
                    fontSize: '10.5px', color: 'var(--crit-500,#b03a3a)', marginTop: '2px',
                } }, '⃠ заблокировал бота') : null,

                // Связать может только тот, кто вправе отвечать: связка открывает
                // чату документы пациента. Кнопка появляется, лишь когда есть
                // кого предложить — иначе сотруднику нечего подтверждать.
                c.unlinked && c.candidate_phone ? h('div', { style: { marginTop: '4px' } },
                    h('button', {
                        class: 'btn btn-sm', type: 'button',
                        style: { fontSize: '11px', padding: '2px 8px', background: '#fffbe6', borderColor: 'var(--warn-300, #fcd34d)' },
                        onclick: async (ev) => {
                            ev.stopPropagation();
                            const cand = (c.candidates && c.candidates[0]) || null;
                            const ask = cand
                                ? 'Связать этот чат с картой «' + cand.name + '» (' + c.candidate_phone + ')?\n\nПосле связывания человек сможет получать документы этого пациента.'
                                : 'Связать этот чат с номером ' + c.candidate_phone + '?\n\nКарта по номеру не найдена — документы появятся, когда она заведётся.';
                            if (!confirm(ask)) return;
                            try {
                                await rpc('telegram_chat_link', { chat_id: c.chat_id, phone: c.candidate_phone });
                                toast('Чат связан.', 'success');
                                await loadChats();
                            } catch (e) { toast((e && e.message) || 'Не удалось связать чат.', 'error'); }
                        },
                    }, '🔗 Связать с пациентом')) : null),

            folderBtn);

        // Иконка папок проявляется на наведении — если чат уже разложен по
        // папкам, она видна всегда, иначе список рябит от значков.
        if (folderBtn && !(c.folders || []).length) folderBtn.style.opacity = '0';
        refs.list.appendChild(row);
    }
}

// Время в списке: сегодня — часы, вчера — «вчера», раньше — дата. Полный
// timestamp в узкой колонке не помещается и не нужен.
function listStamp(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const yest = new Date(now); yest.setDate(now.getDate() - 1);
    if (sameDay) return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    if (d.toDateString() === yest.toDateString()) return 'вчера';
    return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
}

async function openChat(chatId) {
    state.active = chatId;
    paintList();
    paintPane(null, true);
    await refreshThread();
    // TELEGRAM_CHAT_BADGE_V1 — telegram_chat_messages пометил входящие
    // прочитанными; без этого значок в меню держал бы старое число до
    // следующего фонового опроса. Здесь, а не в refreshThread(): тот крутится
    // в 10-секундном поллинге открытой переписки, и счётчики меню опрашивались
    // бы вдвое чаще, чем им нужно.
    try { window.easymed && window.easymed.refreshNav && window.easymed.refreshNav(); } catch (e) {}
}

async function refreshThread() {
    if (!state.active) return;
    const prev = state.thread;
    let next;
    try { next = await rpc('telegram_chat_messages', { chat_id: state.active }); }
    catch (e) { toast(e.message, 'error'); return; }
    state.thread = next;
    // TELEGRAM_DRAFT_KEEP_V1 — перерисовываем, ТОЛЬКО если лента изменилась.
    // Опрос идёт раз в 10 секунд, и раньше каждый его ответ пересобирал панель
    // вместе с полем ввода: набранная фраза исчезала на середине слова. В
    // подавляющем большинстве опросов нового нет — и трогать экран незачем.
    if (threadChanged(prev, next)) paintPane(next);
    loadChats().catch(() => {});   // счётчик непрочитанных погас — обновим список
}

// Фон ленты — едва заметная точечная сетка в фирменном оттенке. Ровная заливка
// делает переписку похожей на таблицу; узор отделяет «разговор» от остального
// интерфейса, как это и сделано в мессенджерах.
const FEED_BG = {
    background:
        'radial-gradient(circle at 1px 1px, rgba(11,20,24,.045) 1px, transparent 0) 0 0/18px 18px,' +
        'linear-gradient(180deg, var(--ink-25,#f6f8f9), var(--ink-25,#f6f8f9))',
};

function paintPane(thread, loading = false) {
    clear(refs.pane);
    if (loading) {
        refs.pane.appendChild(h('div', { class: 'muted', style: { margin: 'auto', padding: '30px' } }, 'Загрузка…'));
        return;
    }
    if (!thread) {
        // Пустое состояние: не голая строка посреди белого поля, а понятная
        // подсказка — сюда попадают, ещё ничего не выбрав.
        refs.pane.appendChild(h('div', { style: {
            margin: 'auto', textAlign: 'center', padding: '30px', maxWidth: '320px',
        } },
            h('div', { style: {
                width: '58px', height: '58px', margin: '0 auto 12px', borderRadius: '50%',
                background: 'var(--primary-50)', color: 'var(--primary-500)',
                display: 'grid', placeItems: 'center',
            } }, Icon('Msg', { size: 26 })),
            h('div', { style: { fontWeight: '600', color: 'var(--ink-800)' } }, 'Выберите чат слева'),
            h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '4px', lineHeight: '1.5' } },
                'Здесь появится переписка с пациентом: его вопросы, ваши ответы и документы, которые отправил бот.')));
        return;
    }

    const l = thread.link || {};
    const name = l.tg_name || l.tg_username || ('Чат ' + thread.chat_id);

    // Шапка: кто это в Telegram И кто это в клинике. Одного telegram-имени мало —
    // сотрудник должен видеть карту пациента, чтобы понимать, о ком речь.
    // Карты вынесены в «чипы»: строка через запятую в шапке нечитаема, когда на
    // номере записана вся семья.
    refs.pane.appendChild(h('div', { style: {
        display: 'flex', alignItems: 'center', gap: '12px',
        padding: '11px 18px', borderBottom: '1px solid var(--ink-100)',
        flex: '0 0 auto', background: 'var(--white,#fff)',
    } },
        h('div', { class: 'avatar ' + avColor(name), style: {
            width: '40px', height: '40px', flex: '0 0 auto', borderRadius: '50%',
            display: 'grid', placeItems: 'center', fontSize: '14px', fontWeight: '600',
        } }, initials(name)),
        h('div', { style: { flex: '1', minWidth: '0' } },
            h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '7px' } },
                h('span', { style: { fontWeight: '700', fontSize: '14.5px', color: 'var(--ink-900)' } }, name),
                l.tg_username ? h('span', { style: { fontSize: '12px', color: 'var(--ink-400)' } }, '@' + l.tg_username) : null,
                l.blocked ? chip('заблокировал бота', 'crit') : null),
            h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '5px', alignItems: 'center', marginTop: '3px' } },
                h('span', { style: { fontSize: '11.5px', color: 'var(--ink-500)' } },
                    'ID ' + (l.tg_user_id || thread.chat_id) + ' · +' + (l.phone || '')),
                ...(thread.patients.length
                    ? thread.patients.map((p) => chip(p.name + ' · ' + p.mrn))
                    : [chip('карта не найдена', 'warn')])))));

    // Лента
    const feed = h('div', { style: {
        flex: '1', overflow: 'auto', padding: '18px 20px', minHeight: '0', ...FEED_BG,
    } });
    if (!thread.messages.length) {
        feed.appendChild(h('div', { class: 'muted', style: { textAlign: 'center', padding: '20px', fontSize: '13px' } },
            'Сообщений пока нет.'));
    }

    // Разделители дат и группировка подряд идущих сообщений одной стороны:
    // без них лента выглядит сплошной стеной и «когда это было» не прочесть.
    let prevDay = null, prevDir = null;
    for (const m of thread.messages) {
        const day = dayKey(m.created_at);
        if (day !== prevDay) {
            feed.appendChild(dayDivider(m.created_at));
            prevDay = day; prevDir = null;
        }
        const grouped = prevDir === m.direction;
        feed.appendChild(bubble(m, grouped));
        prevDir = m.direction;
    }
    refs.pane.appendChild(feed);
    setTimeout(() => { feed.scrollTop = feed.scrollHeight; }, 0);

    if (!canReply()) {
        refs.pane.appendChild(h('div', { style: {
            display: 'flex', gap: '8px', alignItems: 'center', justifyContent: 'center',
            padding: '13px 18px', borderTop: '1px solid var(--ink-100)',
            background: 'var(--white,#fff)', color: 'var(--ink-500)', fontSize: '12.5px', flex: '0 0 auto',
        } }, Icon('Warning', { size: 13 }), 'Доступ «только чтение» — отвечать пациентам нельзя.'));
        return;
    }

    // Поле ответа: растёт под текст до 5 строк, отправка — круглой кнопкой.
    const input = h('textarea', {
        rows: '1', placeholder: 'Напишите ответ…',
        style: {
            width: '100%', resize: 'none', border: 'none', outline: 'none', background: 'transparent',
            fontSize: '13.5px', lineHeight: '1.45', maxHeight: '120px', padding: '0', fontFamily: 'inherit',
        },
    });
    // Пришло новое сообщение — панель пересобирается; черновик возвращаем на
    // место, иначе ответ терялся бы ровно в тот момент, когда пациент пишет.
    //
    // Присваиваем СВОЙСТВО, а не атрибут: h() кладёт неизвестные ключи через
    // setAttribute, а у <textarea> значение живёт не в атрибуте — value="…" на
    // него не влияет вовсе, и черновик молча терялся бы.
    input.value = state.drafts[state.active] || '';
    const grow = () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 120) + 'px'; };
    input.addEventListener('input', () => { state.drafts[state.active] = input.value; grow(); });
    input.addEventListener('keydown', (e) => {
        // Enter отправляет, Shift+Enter — перенос строки: в мессенджере ждут
        // именно этого, а Ctrl+Enter каждый раз приходится вспоминать.
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(input); }
    });

    // Круглая кнопка панели ответа — скрепка и «отправить» отличаются только
    // цветом и содержимым, поэтому форма у них общая.
    const roundBtn = (icon, { title, onclick, primary = false }) => {
        const base = primary ? 'var(--primary-500)' : 'transparent';
        const hover = primary ? 'var(--primary-600)' : 'var(--ink-100,#e6ebec)';
        return h('button', {
            type: 'button', title, onclick,
            style: {
                flex: '0 0 auto', width: '38px', height: '38px', borderRadius: '50%', border: 'none',
                background: base, color: primary ? '#fff' : 'var(--ink-500)', cursor: 'pointer',
                display: 'grid', placeItems: 'center', transition: 'background .12s, transform .08s',
            },
            onmouseenter: (e) => { e.currentTarget.style.background = hover; },
            onmouseleave: (e) => { e.currentTarget.style.background = base; },
            onmousedown: (e) => { e.currentTarget.style.transform = 'scale(.94)'; },
            onmouseup: (e) => { e.currentTarget.style.transform = 'none'; },
        }, icon);
    };

    // TELEGRAM_CHAT_FILE_V1 — выбор файла.
    //
    // Настоящий <input type=file> прячем и жмём его из скрепки: своё оформление
    // у него невозможно, а системная кнопка «Выберите файл» в панели ответа
    // выглядит инородно. multiple — потому что результат обычно не один лист.
    const picker = h('input', {
        type: 'file', multiple: true,
        style: { display: 'none' },
        onchange: (e) => { addAttachments(e.currentTarget.files); e.currentTarget.value = ''; },
    });
    const clip = roundBtn(Icon('Paperclip', { size: 17 }), {
        title: 'Прикрепить файл', onclick: () => picker.click(),
    });
    const send = roundBtn(Icon('Send', { size: 15 }), {
        title: 'Отправить (Enter)', onclick: () => doSend(input), primary: true,
    });

    // Выбранные файлы — строкой над полем ввода, каждый со своим крестиком.
    // Иначе «что именно сейчас уйдёт пациенту» видно только по памяти, а
    // отменить ошибочный выбор нельзя вовсе.
    const tray = h('div', { style: {
        display: 'flex', flexWrap: 'wrap', gap: '6px', padding: '0 18px',
    } });
    refs.tray = tray;
    paintTray();

    refs.pane.appendChild(h('div', { style: {
        display: 'flex', flexDirection: 'column', gap: '8px', padding: '10px 0 12px',
        borderTop: '1px solid var(--ink-100)', background: 'var(--white,#fff)', flex: '0 0 auto',
    } },
        tray,
        h('div', { style: { display: 'flex', gap: '8px', alignItems: 'flex-end', padding: '0 18px' } },
            h('div', { style: {
                flex: '1', background: 'var(--ink-50,#f1f4f5)', borderRadius: '18px',
                padding: '10px 14px', display: 'flex', alignItems: 'center',
            } }, input),
            picker, clip, send)));
    setTimeout(() => { input.focus(); grow(); }, 0);
}

// TELEGRAM_CHAT_FILE_V1 — файлы, выбранные в текущем чате.
function attachmentsOf(chatId = state.active) {
    return state.attachments[chatId] || [];
}

// Проверяем КАЖДЫЙ файл здесь же, при выборе: узнать про «больше 20 МБ» после
// того, как оператор нажал «отправить» и подождал заливку, — значит потерять
// его время дважды. Годные файлы при этом добавляются, негодные отсеиваются
// поимённо, а не «что-то не так с одним из файлов».
function addAttachments(fileList) {
    const chosen = Array.from(fileList || []);
    if (!chosen.length) return;
    const ok = [];
    for (const f of chosen) {
        const bad = attachmentError(f);
        if (bad) toast(`${f.name}: ${bad}`, 'error');
        else ok.push(f);
    }
    if (!ok.length) return;
    state.attachments[state.active] = attachmentsOf().concat(ok);
    paintTray();
}

function removeAttachment(index) {
    const list = attachmentsOf().slice();
    list.splice(index, 1);
    state.attachments[state.active] = list;
    paintTray();
}

function paintTray() {
    const tray = refs.tray;
    if (!tray) return;
    clear(tray);
    const list = attachmentsOf();
    tray.style.display = list.length ? 'flex' : 'none';
    list.forEach((f, i) => {
        tray.appendChild(h('span', { style: {
            display: 'inline-flex', alignItems: 'center', gap: '6px', maxWidth: '260px',
            background: 'var(--ink-50,#f1f4f5)', border: '1px solid var(--ink-100)',
            borderRadius: '10px', padding: '4px 6px 4px 8px', fontSize: '12px', color: 'var(--ink-700)',
        } },
            Icon(isImageName(f.name) ? 'Image' : 'Doc', { size: 13 }),
            h('span', { style: {
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }, title: f.name }, f.name),
            h('span', { style: { color: 'var(--ink-400)', flex: '0 0 auto' } }, humanSize(f.size)),
            h('button', {
                type: 'button', title: 'Убрать', onclick: () => removeAttachment(i),
                style: {
                    flex: '0 0 auto', border: 'none', background: 'transparent', cursor: 'pointer',
                    color: 'var(--ink-400)', padding: '0 2px', display: 'grid', placeItems: 'center',
                },
            }, Icon('X', { size: 12 }))));
    });
}

// Небольшая «плашка» для карт пациента и статусов в шапке.
function chip(text, tone = 'plain') {
    const tones = {
        plain: { bg: 'var(--ink-50,#f1f4f5)', fg: 'var(--ink-600)' },
        warn:  { bg: '#fdf3e1', fg: '#b07d1f' },
        crit:  { bg: '#fbe8e8', fg: '#b03a3a' },
    };
    const t = tones[tone] || tones.plain;
    return h('span', { style: {
        background: t.bg, color: t.fg, borderRadius: '99px', padding: '2px 8px',
        fontSize: '11px', fontWeight: '500', whiteSpace: 'nowrap',
    } }, text);
}

const dayKey = (iso) => String(iso || '').slice(0, 10);

function dayDivider(iso) {
    const d = new Date(iso);
    const now = new Date();
    const yest = new Date(now); yest.setDate(now.getDate() - 1);
    let label;
    if (isNaN(d)) label = '—';
    else if (d.toDateString() === now.toDateString()) label = 'Сегодня';
    else if (d.toDateString() === yest.toDateString()) label = 'Вчера';
    else label = d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });

    return h('div', { style: { display: 'flex', justifyContent: 'center', margin: '14px 0 10px' } },
        h('span', { style: {
            background: 'rgba(11,20,24,.06)', color: 'var(--ink-600)', borderRadius: '99px',
            padding: '3px 11px', fontSize: '11px', fontWeight: '600',
        } }, label));
}

const KIND_NOTE = { document: 'документ', broadcast: 'рассылка' };

function bubble(m, grouped = false) {
    const out = m.direction === 'out';

    // Служебные ответы бота — это не реплика оператора, а автоматика. В Telegram
    // такие вещи показывают отдельной строчкой по центру, и здесь так же:
    // иначе лента выглядит как будто клиника завалила пациента сообщениями.
    if (m.kind === 'system') {
        return h('div', { style: { display: 'flex', justifyContent: 'center', margin: '4px 0' } },
            h('div', { style: {
                maxWidth: '80%', background: 'rgba(11,20,24,.05)', color: 'var(--ink-500)',
                borderRadius: '12px', padding: '5px 11px', fontSize: '11.5px', textAlign: 'center',
                whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            } }, trimText(m.text, 220),
                h('span', { style: { opacity: '.7' } }, '  ' + timeShort(m.created_at))));
    }

    const isDoc = m.kind === 'document';
    const radius = out
        ? `16px 16px ${grouped ? '16px' : '4px'} 16px`
        : `16px 16px 16px ${grouped ? '16px' : '4px'}`;

    return h('div', { style: {
        display: 'flex', justifyContent: out ? 'flex-end' : 'flex-start', marginBottom: grouped ? '3px' : '9px',
    } },
        h('div', { style: {
            maxWidth: '68%', padding: '8px 12px 6px', borderRadius: radius,
            background: out ? 'var(--primary-500)' : 'var(--white,#fff)',
            color: out ? '#fff' : 'var(--ink-900)',
            border: out ? 'none' : '1px solid var(--ink-100)',
            boxShadow: '0 1px 2px rgba(11,20,24,.06)',
            whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: '13.5px', lineHeight: '1.45',
        } },
            // Кто ответил — над текстом и заметно: пациенту отвечают разные
            // сотрудники, и «кто это сказал» важнее, чем выглядит.
            (m.author && !grouped) ? h('div', { style: {
                fontSize: '11.5px', fontWeight: '600', marginBottom: '2px',
                color: out ? 'rgba(255,255,255,.9)' : 'var(--primary-700)',
            } }, m.author) : null,

            isDoc ? fileLine(m, out) : m.text,

            h('div', { style: {
                fontSize: '10.5px', marginTop: '3px', textAlign: 'right',
                color: out ? 'rgba(255,255,255,.75)' : 'var(--ink-400)',
            } },
                (KIND_NOTE[m.kind] ? KIND_NOTE[m.kind] + ' · ' : '') + timeShort(m.created_at))));
}

// TELEGRAM_CHAT_FILE_V1 — строка отправленного файла.
//
// Если известно, ГДЕ он лежит, имя становится ссылкой: «что мы вчера отправили
// пациенту?» — вопрос, который задают через неделю, и отвечать на него по
// памяти нельзя. Файлы, выданные ботом по кнопке «Мои документы», пути не
// имеют — там показывается просто имя, как и раньше.
function fileLine(m, out) {
    const label = h('span', { style: { fontWeight: '500' } }, m.text);
    if (!m.file_path) return label;
    return h('a', {
        href: '/api/storage/telegram-media/' + String(m.file_path).split('/').map(encodeURIComponent).join('/'),
        target: '_blank', rel: 'noopener',
        title: 'Открыть отправленный файл',
        style: {
            display: 'inline-flex', alignItems: 'center', gap: '6px',
            color: 'inherit', textDecoration: 'underline', textUnderlineOffset: '2px',
        },
    }, Icon(isImageName(m.text) ? 'Image' : 'Doc', { size: 14 }), label);
}

function timeShort(iso) {
    const d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}
function trimText(s, n) {
    const t = String(s || '');
    return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

// Отправка ответа: текст, файлы, или и то и другое.
//
// Когда есть и текст, и файл, текст уходит ПОДПИСЬЮ к первому файлу, а не
// отдельным сообщением: так это делает сам Telegram, и пациент видит снимок с
// пояснением, а не два уведомления подряд. Остальные файлы идут без подписи.
async function doSend(input) {
    const text = input.value.trim();
    const files = attachmentsOf();
    if ((!text && !files.length) || state.sending) return;
    const chatId = state.active;

    state.sending = true;
    input.disabled = true;
    try {
        if (!files.length) {
            await rpc('telegram_chat_send', { chat_id: chatId, text });
        } else {
            // Файл сначала кладётся в хранилище клиники, и только путь уходит в
            // RPC: /api/rpc принимает JSON, и гнать двадцать мегабайт в base64
            // означало бы на треть больше данных и весь файл в памяти сервера.
            for (let i = 0; i < files.length; i++) {
                const f = files[i];
                const up = await uploadFile('telegram-media', f, `chat/${chatId}/`);
                await rpc('telegram_chat_send_file', {
                    chat_id: chatId, path: up.path, name: f.name,
                    caption: i === 0 ? text : '',
                });
                // Отправленное убираем сразу: если следующий файл не уйдёт,
                // повторная отправка не продублирует уже доставленные.
                state.attachments[chatId] = attachmentsOf(chatId).filter((x) => x !== f);
                paintTray();
            }
        }
        input.value = '';
        delete state.drafts[chatId];   // отправленное не должно вернуться при следующей перерисовке
        await refreshThread();
    } catch (e) {
        toast(e.message || 'Не удалось отправить.', 'error');
    } finally {
        state.sending = false;
        input.disabled = false;
        input.focus();
    }
}

// Тестовая точка входа: опрос ленты — то место, где пропадал набранный ответ.
export const __test_refreshThread = refreshThread;
// Опрос по setInterval живёт, пока жив раздел. В браузере это правильно, а в
// тестах — держит процесс: без этой точки прогон не завершается и падение
// одного теста выглядит как зависший набор.
export const __test_stopPolling = stopPolling;
