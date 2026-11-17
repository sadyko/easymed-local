// DAILY_REPORT_BOT_V1 (2026-11-13) — «Коммерческие инструменты» → «Отчёт в Telegram».
//
// Владелец: «I will create new telegram bot that pushes daily report to group of
// board of directors, make setting block as follow that I will put token and
// choose the time when it has to push message and every day to that group my bot
// pushes report about cashier, types of payment, CRM and so on».
//
// Пять карточек по порядку настройки: 1) бот — токен из @BotFather; 2) группа —
// «Найти группу» показывает группы, куда бота добавили, и выбирают щелчком;
// 3) расписание — время, «за какой день», выключатель; 4) что в отчёте — блоки;
// 5) проверка — предпросмотр и «Отправить сейчас». Отправляет СЕРВЕР
// (services/daily-report): страница может быть закрыта, отчёт всё равно уйдёт.
//
// Только администратор (permissions.js, rpc/daily-report.js): в отчёте деньги
// клиники. Образец карточек — sms-settings.js.

import { supabase } from '../../supabase.js';
import { h, Icon, PageHead, clear, toast, field, checkField, fmtDateTime } from '../ui.js';
import { tr, trf } from '../i18n.js';

// Порядок и имена блоков — как в отчёте (server/services/daily-report/report.js).
// DAILY_REPORT_FORMAT_V2 — блоки второго формата («Итог дня»), в его порядке.
const SECTION_LABELS = {
    cash: 'Принято за день: способы оплаты, счетов закрыто',
    cashiers: 'По кассирам',
    coverage: 'По типу покрытия',
    departments: 'По отделениям',
    groups: 'По группам услуг',
    patients: 'Пациенты и стационар',
    crm: 'Колл-центр: заявки, дошли, завели карту',
    debt: 'Долг пациентов',
    calls: 'Звонки',
    doctors: 'Врачи',
};

const state = { s: null, busy: false, chats: null, preview: null };
const refs = { body: null };

async function rpc(name, args = {}) {
    const { data, error } = await supabase.rpc(name, args);
    if (error) throw new Error(error.message || tr('Не удалось выполнить запрос.'));
    return data;
}

export async function renderDailyReport(container) {
    clear(container);
    const root = h('div', { class: 'fade-in', 'data-daily-report': '' });
    container.appendChild(root);
    root.appendChild(PageHead({
        title: 'Отчёт в Telegram',
        subtitle: 'Каждый день в назначенное время бот присылает в группу совета директоров отчёт: касса, способы оплаты, долги, пациенты, CRM, звонки.',
    }));
    refs.body = h('div');
    root.appendChild(refs.body);
    refs.body.appendChild(h('div', { class: 'muted', style: { padding: '24px' } }, 'Загрузка…'));
    state.chats = null; state.preview = null;
    try { state.s = await rpc('daily_report_settings_get'); }
    catch (e) {
        clear(refs.body);
        refs.body.appendChild(h('div', { class: 'empty', style: { padding: '30px' } },
            trf('Не удалось загрузить настройки: {msg}', { msg: e.message })));
        return;
    }
    paint();
}

function paint() {
    clear(refs.body);
    refs.body.appendChild(statusBanner());
    refs.body.appendChild(botCard());
    refs.body.appendChild(groupCard());
    refs.body.appendChild(scheduleCard());
    refs.body.appendChild(sectionsCard());
    refs.body.appendChild(checkCard());
}

const card = (icon, title, ...body) => h('div', { class: 'card', style: { marginBottom: '16px' } },
    h('div', { class: 'card-header' }, h('h3', null, Icon(icon, { size: 16 }), ' ', tr(title))),
    h('div', { style: { padding: '18px' } }, ...body));
const note = (text) => h('div', { class: 'muted', style: { fontSize: '12.5px', margin: '-4px 0 12px', lineHeight: '1.5' } }, text);

function statusBanner() {
    const s = state.s;
    const warn = (title, sub) => h('div', { class: 'drb-banner drb-warn', 'data-drb-banner': 'warn' }, Icon('Warning', { size: 16 }),
        h('div', null, h('b', null, title), sub ? h('div', { class: 'drb-sub' }, sub) : null));
    if (!s.has_token) return warn(tr('Бот не подключён'), tr('Создайте бота в @BotFather и вставьте его токен ниже.'));
    if (!s.chat_id) return warn(tr('Группа не выбрана'), tr('Добавьте бота в группу совета директоров и нажмите «Найти группу».'));
    if (!s.enabled) return warn(tr('Отчёт выключен'), tr('Отправьте проверочный отчёт, затем включите ежедневную отправку.'));
    return h('div', { class: 'drb-banner drb-ok', 'data-drb-banner': 'ok' }, Icon('Check', { size: 16 }),
        h('div', null,
            h('b', null, trf('Каждый день в {time} · {day}', { time: s.send_time, day: s.period === 'yesterday' ? tr('за вчера') : tr('за сегодня') })),
            h('div', { class: 'drb-sub' }, s.last_error
                // DAILY_REPORT_FAIL_V1 — причина от сервера — фраза словаря (tr; незнакомая — как есть).
                ? trf('Последняя попытка не удалась: {msg}', { msg: tr(s.last_error) })
                : s.last_sent_at ? trf('Последний отчёт ушёл {at}', { at: fmtDateTime(s.last_sent_at) }) : tr('Отчётов ещё не было.'))));
}

// ---------------------------------------------------------------------------
// 1. Бот
// ---------------------------------------------------------------------------
function botCard() {
    const s = state.s;
    const tokenInp = h('input', { type: 'password', autocomplete: 'new-password', spellcheck: 'false', 'data-drb-token': '', style: { width: '100%' },
        placeholder: s.has_token ? tr('Введите новый токен, чтобы заменить') : '1234567890:AA…' });
    const saveBtn = h('button', { class: 'btn btn-primary', type: 'button', 'data-drb-token-save': '',
        onclick: () => run(saveBtn, async () => {
            if (!tokenInp.value.trim()) { toast(tr('Вставьте токен бота.'), 'warn'); return; }
            const r = await rpc('daily_report_settings_save', { bot_token: tokenInp.value });
            state.s = r;
            if (r.check_error) toast(trf('Токен сохранён, но Telegram не ответил: {msg}', { msg: r.check_error }), 'warn');
            else toast(trf('Бот подключён: @{name}', { name: r.bot_username || '—' }), 'success');
            paint();
        }) }, Icon('Check', { size: 13 }), ' ', tr('Сохранить токен'));
    const clearBtn = s.has_token ? h('button', { class: 'btn btn-danger', type: 'button',
        onclick: () => {
            if (!confirm(tr('Удалить токен? Ежедневный отчёт будет выключен.'))) return;
            run(clearBtn, async () => { state.s = await rpc('daily_report_token_clear'); toast(tr('Токен удалён, отчёт выключен.'), 'info'); paint(); });
        } }, tr('Удалить токен')) : null;
    return card('Bot', 'Бот',
        s.has_token ? h('div', { class: 'drb-line' }, Icon('Check', { size: 14 }),
            s.bot_username ? trf('Подключён бот @{name}', { name: s.bot_username }) : trf('Токен сохранён: …{hint}', { hint: s.token_hint })) : null,
        note(tr('Создайте НОВОГО бота: в Telegram откройте @BotFather, отправьте /newbot, придумайте имя — он пришлёт токен. Пациентский бот сюда не подходит.')),
        field(s.has_token ? tr('Новый токен (заменить)') : tr('Токен бота'), tokenInp),
        h('div', { class: 'row', style: { gap: '8px', marginTop: '4px' } }, saveBtn, h('span', { class: 'grow' }), clearBtn));
}

// ---------------------------------------------------------------------------
// 2. Группа
// ---------------------------------------------------------------------------
function groupCard() {
    const s = state.s;
    const findBtn = h('button', { class: 'btn', type: 'button', disabled: !s.has_token, 'data-drb-find': '',
        onclick: () => run(findBtn, async () => {
            state.chats = (await rpc('daily_report_find_chats')).chats || [];
            if (!state.chats.length) toast(tr('Групп не найдено. Добавьте бота в группу, напишите в ней любое сообщение и нажмите снова.'), 'warn');
            paint();
        }) }, Icon('Search', { size: 13 }), ' ', tr('Найти группу'));
    const choose = (c) => run(null, async () => {
        state.s = await rpc('daily_report_settings_save', { chat_id: c.id, chat_title: c.title });
        state.chats = null;
        toast(trf('Группа выбрана: {name}', { name: c.title }), 'success');
        paint();
    });
    const list = Array.isArray(state.chats) && state.chats.length
        ? h('div', { class: 'drb-chats' }, ...state.chats.map((c) => h('button', {
            type: 'button', class: 'drb-chat' + (String(c.id) === String(s.chat_id) ? ' on' : ''), 'data-drb-chat': c.id,
            onclick: () => choose(c),
        }, Icon('Patients', { size: 14 }), h('span', null, c.title), h('small', null, c.id))))
        : null;
    const idInp = h('input', { type: 'text', value: s.chat_id, spellcheck: 'false', placeholder: '-1001234567890', style: { width: '100%' } });
    const idBtn = h('button', { class: 'btn', type: 'button',
        onclick: () => run(idBtn, async () => {
            state.s = await rpc('daily_report_settings_save', { chat_id: idInp.value.trim() });
            toast(tr('Номер группы сохранён.'), 'success');
            paint();
        }) }, tr('Сохранить номер'));
    return card('Patients', 'Группа совета директоров',
        s.chat_id ? h('div', { class: 'drb-line' }, Icon('Check', { size: 14 }), trf('Отчёт идёт в группу: {name}', { name: s.chat_title || s.chat_id })) : null,
        note(tr('Добавьте бота в группу совета директоров (Участники → Добавить), затем нажмите «Найти группу» и выберите её.')),
        h('div', { class: 'row', style: { gap: '8px' } }, findBtn),
        list,
        h('details', { class: 'drb-manual' },
            h('summary', null, tr('Ввести номер группы вручную')),
            h('div', { class: 'row', style: { gap: '8px', alignItems: 'flex-end', marginTop: '10px' } },
                h('div', { style: { flex: '1 1 260px' } }, field(tr('Номер группы'), idInp)), idBtn)));
}

// ---------------------------------------------------------------------------
// 3. Расписание
// ---------------------------------------------------------------------------
function scheduleCard() {
    const s = state.s;
    const timeInp = h('input', { type: 'time', value: s.send_time, 'data-drb-time': '', style: { width: '140px' } });
    const periodSel = h('select', { 'data-drb-period': '' },
        h('option', { value: 'today', selected: s.period === 'today' }, tr('За сегодня — вечерний отчёт')),
        h('option', { value: 'yesterday', selected: s.period === 'yesterday' }, tr('За вчера — утренний отчёт')));
    const saveBtn = h('button', { class: 'btn btn-primary', type: 'button', 'data-drb-schedule-save': '',
        onclick: () => run(saveBtn, async () => {
            state.s = await rpc('daily_report_settings_save', { send_time: timeInp.value, period: periodSel.value });
            toast(tr('Расписание сохранено.'), 'success');
            paint();
        }) }, Icon('Check', { size: 13 }), ' ', tr('Сохранить'));
    // Выключатель сохраняется сразу (урок telegram-settings.js: выключатель,
    // ждущий отдельной кнопки, оставляют «включённым» и уходят).
    const enabledCb = h('input', { type: 'checkbox', checked: s.enabled, 'data-drb-enabled': '', disabled: !s.has_token || !s.chat_id,
        onchange: async () => {
            enabledCb.disabled = true;
            try {
                state.s = await rpc('daily_report_settings_save', { enabled: enabledCb.checked });
                toast(enabledCb.checked ? tr('Ежедневный отчёт включён.') : tr('Ежедневный отчёт выключен.'), 'success');
                paint();
            } catch (e) {
                enabledCb.checked = !enabledCb.checked;
                enabledCb.disabled = false;
                toast(e.message || tr('Не удалось сохранить.'), 'error');
            }
        } });
    return card('Clock', 'Расписание',
        h('div', { class: 'row', style: { gap: '12px', alignItems: 'flex-end', flexWrap: 'wrap' } },
            field(tr('Время отправки'), timeInp),
            h('div', { style: { flex: '1 1 260px' } }, field(tr('За какой день'), periodSel)),
            saveBtn),
        note(tr('Время — по часам сервера клиники. Если сервер был выключен в это время, отчёт уйдёт, как только он включится в тот же день.')),
        h('div', { style: { marginTop: '6px', paddingTop: '14px', borderTop: '1px solid var(--ink-100)' } },
            checkField(tr('Отправлять отчёт каждый день'), enabledCb)));
}

// ---------------------------------------------------------------------------
// 4. Что в отчёте
// ---------------------------------------------------------------------------
function sectionsCard() {
    const s = state.s;
    const boxes = (s.all_sections || Object.keys(SECTION_LABELS)).map((k) => ({
        k, cb: h('input', { type: 'checkbox', checked: s.sections.includes(k), 'data-drb-section': k }),
    }));
    const saveBtn = h('button', { class: 'btn btn-primary', type: 'button', 'data-drb-sections-save': '',
        onclick: () => run(saveBtn, async () => {
            state.s = await rpc('daily_report_settings_save', { sections: boxes.filter((b) => b.cb.checked).map((b) => b.k) });
            state.preview = null;
            toast(tr('Состав отчёта сохранён.'), 'success');
            paint();
        }) }, Icon('Check', { size: 13 }), ' ', tr('Сохранить'));
    return card('ListBullet', 'Что в отчёте',
        note(tr('Числа — те же, что на экране «Сводка», за один день и со сравнением с днём раньше.')),
        h('div', { class: 'drb-sections' }, ...boxes.map((b) => checkField(tr(SECTION_LABELS[b.k] || b.k), b.cb))),
        h('div', { class: 'row', style: { marginTop: '12px' } }, saveBtn));
}

// ---------------------------------------------------------------------------
// 5. Проверка
// ---------------------------------------------------------------------------
/** Текст отчёта для показа: теги Telegram (<b>, <i>) снимаются, сущности — обратно в знаки. */
export function plainReport(html) {
    return String(html || '').replace(/<\/?(b|i)>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function checkCard() {
    const s = state.s;
    const prevBtn = h('button', { class: 'btn', type: 'button', 'data-drb-preview': '',
        onclick: () => run(prevBtn, async () => { state.preview = (await rpc('daily_report_preview')).text; paint(); }) },
        Icon('Doc', { size: 13 }), ' ', tr('Предпросмотр'));
    const sendBtn = h('button', { class: 'btn btn-primary', type: 'button', disabled: !s.has_token || !s.chat_id, 'data-drb-send': '',
        onclick: () => run(sendBtn, async () => {
            const r = await rpc('daily_report_send_now');
            state.s = r.settings || state.s;
            if (r.ok) toast(tr('Отчёт отправлен в группу.'), 'success');
            else toast(r.error || tr('Отчёт не отправлен.'), 'error');
            paint();
        }) }, Icon('Send', { size: 13 }), ' ', tr('Отправить сейчас'));
    return card('Send', 'Проверка',
        note(tr('«Отправить сейчас» шлёт отчёт в группу немедленно — расписание это не меняет.')),
        h('div', { class: 'row', style: { gap: '8px' } }, prevBtn, sendBtn),
        state.preview != null ? h('pre', { class: 'drb-preview', 'data-drb-preview-text': '' }, plainReport(state.preview)) : null);
}

// Одна кнопка за раз: повторный щелчок, пока сервер думает, ничего не шлёт.
async function run(btn, fn) {
    if (state.busy) return;
    state.busy = true;
    if (btn) btn.disabled = true;
    try { await fn(); }
    catch (e) { toast(e.message || tr('Не удалось выполнить операцию.'), 'error'); }
    finally {
        state.busy = false;
        try { if (btn) btn.disabled = false; } catch (_) { /* перерисовано */ }
    }
}
