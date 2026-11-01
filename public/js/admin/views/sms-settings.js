// SMS_INFORM_V1 — «Коммерческие инструменты» → «SMS-информирование» (Play Mobile).
//
// Первый шаг интеграции (2026-10-30, владелец выбрал провайдера: «Play
// Mobile»): подключение и проверка. Какие сообщения система будет слать сама
// (напоминания о записи и т. п.) — следующим шагом, когда владелец их назовёт.
//
// Три карточки:
//   1. Подключение — адрес, логин, пароль и имя отправителя, которые Play
//      Mobile выдаёт клинике по договору. Пароль уходит на сервер и хранится
//      шифртекстом; обратно приходит только признак и хвост (rpc/sms.js).
//   2. Проверочное SMS — одно сообщение на свой номер: единственный честный
//      способ узнать, что логин, пароль и отправитель верны.
//   3. Журнал — что ушло и чем кончилось.
//
// Образец — meta-settings.js: карточки, run() «одна кнопка за раз»,
// переключатель сохраняется сразу по щелчку.

import { supabase } from '../../supabase.js';
import { h, Icon, PageHead, clear, toast, field, checkField, fmtDateTime } from '../ui.js';
import { tr, trf } from '../i18n.js';

const state = { s: null, log: null, logError: null, busy: false };
const refs = { body: null, logBody: null };

async function rpc(name, args = {}) {
    const { data, error } = await supabase.rpc(name, args);
    if (error) throw new Error(error.message || 'Не удалось выполнить запрос.');
    return data;
}

export async function renderSmsSettings(container) {
    clear(container);
    const root = h('div', { class: 'fade-in', 'data-sms-settings': '' });
    container.appendChild(root);
    root.appendChild(PageHead({
        title: 'SMS-информирование',
        subtitle: 'SMS пациентам через Play Mobile. Логин и пароль выдаёт Play Mobile по договору; пароль хранится на сервере в зашифрованном виде.',
    }));
    refs.body = h('div');
    root.appendChild(refs.body);
    refs.body.appendChild(h('div', { class: 'muted', style: { padding: '24px' } }, 'Загрузка…'));
    try {
        state.s = await rpc('sms_settings_get');
    } catch (e) {
        clear(refs.body);
        refs.body.appendChild(h('div', { class: 'empty', style: { padding: '30px' } },
            trf('Не удалось загрузить настройки: {msg}', { msg: e.message })));
        return;
    }
    paint();
    loadLog();
}

function paint() {
    clear(refs.body);
    refs.body.appendChild(connectionCard());
    refs.body.appendChild(testCard());
    refs.body.appendChild(logCard());
}

const BANNER_STYLE = {
    ok:   { bg: '#e8f6ed', fg: '#2e8b52' },
    warn: { bg: '#fdf3e1', fg: '#b07d1f' },
};
function banner(kind, icon, title, note) {
    const c = BANNER_STYLE[kind];
    return h('div', { 'data-sms-banner': kind, style: { display: 'flex', gap: '10px', alignItems: 'flex-start', padding: '12px 14px', borderRadius: '10px', background: c.bg, color: c.fg, marginBottom: '14px' } },
        h('span', { style: { display: 'inline-flex', marginTop: '1px' } }, Icon(icon, { size: 16 })),
        h('div', null,
            h('div', { style: { fontWeight: 600 } }, title),
            note ? h('div', { style: { fontSize: '12.5px', marginTop: '2px', opacity: .9 } }, note) : null));
}

function complete(s) { return !!(s.base_url && s.login && s.password_set && s.originator); }

function statusBanner() {
    const s = state.s;
    if (!complete(s)) return banner('warn', 'Warning', 'Подключение не заполнено', 'Введите адрес, логин, пароль и имя отправителя, которые выдал Play Mobile.');
    if (!s.enabled) return banner('warn', 'Warning', 'Подключение заполнено, отправка выключена', 'Отправьте проверочное SMS на свой номер, затем включите отправку.');
    return banner('ok', 'Check', trf('Отправка включена · отправитель «{name}»', { name: s.originator }), null);
}

// ---------------------------------------------------------------------------
// 1. Подключение
// ---------------------------------------------------------------------------
function connectionCard() {
    const s = state.s;
    const card = h('div', { style: { padding: '18px' } });
    card.appendChild(statusBanner());

    const urlInp = h('input', { type: 'url', value: s.base_url, placeholder: 'https://…', spellcheck: 'false', style: { width: '100%' } });
    const loginInp = h('input', { type: 'text', value: s.login, autocomplete: 'off', spellcheck: 'false', style: { width: '100%' } });
    // type=password — пароль не должен светиться на экране.
    const passInp = h('input', { type: 'password', autocomplete: 'new-password', spellcheck: 'false', style: { width: '100%' },
        placeholder: s.password_set ? 'Введите новый пароль, чтобы заменить' : '' });
    const origInp = h('input', { type: 'text', value: s.originator, maxlength: '20', spellcheck: 'false', style: { width: '100%' }, placeholder: '3700' });

    card.appendChild(field('Адрес сервера Play Mobile', urlInp));
    card.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px', margin: '-6px 0 12px' } },
        'Адрес из письма Play Mobile. Окончание /broker-api/send программа допишет сама.'));
    card.appendChild(h('div', { class: 'row', style: { gap: '12px', alignItems: 'flex-start' } },
        h('div', { style: { flex: 1 } }, field('Логин', loginInp)),
        h('div', { style: { flex: 1 } }, field(
            s.password_set && s.password_tail ? trf('Сохранённый пароль: …{hint} (заменить)', { hint: s.password_tail })
                : s.password_set ? 'Пароль сохранён (заменить)' : 'Пароль', passInp))));
    card.appendChild(field('Имя отправителя (originator)', origInp));
    card.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px', margin: '-6px 0 12px' } },
        'Имя или короткий номер, согласованный с Play Mobile, — его пациент видит вместо номера.'));

    const saveBtn = h('button', { class: 'btn btn-primary', type: 'button',
        onclick: async () => {
            await run(saveBtn, async () => {
                const args = { base_url: urlInp.value, login: loginInp.value, originator: origInp.value };
                if (passInp.value.trim()) args.password = passInp.value;
                state.s = await rpc('sms_settings_save', args);
                toast('Подключение сохранено.', 'success');
                paint();
            });
        } }, Icon('Check', { size: 13 }), ' Сохранить');

    const clearBtn = h('button', { class: 'btn btn-danger', type: 'button', style: { display: s.password_set ? '' : 'none' },
        onclick: async () => {
            if (!confirm(tr('Удалить пароль? Отправка SMS будет выключена.'))) return;
            await run(clearBtn, async () => {
                state.s = await rpc('sms_password_clear');
                toast('Пароль удалён, отправка выключена.', 'info');
                paint();
            });
        } }, 'Удалить пароль');

    // Переключатель сохраняется сразу: выключатель, ждущий отдельной кнопки,
    // оставляют «включённым» и уходят (урок telegram-settings.js).
    const enabledCb = h('input', { type: 'checkbox', checked: s.enabled, 'data-sms-enabled': '',
        onchange: async () => {
            enabledCb.disabled = true;
            try {
                state.s = await rpc('sms_settings_save', { enabled: enabledCb.checked });
                toast(enabledCb.checked ? 'Отправка SMS включена.' : 'Отправка SMS выключена.', 'success');
                paint();
            } catch (e) {
                enabledCb.checked = !enabledCb.checked;
                enabledCb.disabled = false;
                toast(e.message || 'Не удалось сохранить.', 'error');
            }
        } });

    card.appendChild(h('div', { class: 'row', style: { gap: '8px', marginTop: '4px' } },
        saveBtn, h('span', { class: 'grow' }), clearBtn));
    card.appendChild(h('div', { style: { marginTop: '16px', paddingTop: '14px', borderTop: '1px solid var(--ink-100)' } },
        checkField('Отправка SMS включена', enabledCb)));

    return h('div', { class: 'card', style: { marginBottom: '16px' } },
        h('div', { class: 'card-header' }, h('h3', null, Icon('Msg', { size: 16 }), ' ', tr('Подключение Play Mobile'))),
        card);
}

// ---------------------------------------------------------------------------
// 2. Проверочное SMS
// ---------------------------------------------------------------------------
function testCard() {
    const s = state.s;
    const phoneInp = h('input', { type: 'tel', placeholder: '+998 90 123 45 67', style: { width: '100%' } });
    const textInp = h('textarea', { rows: '2', style: { width: '100%' } });
    textInp.value = tr('Проверка SMS из Easy-Med.');
    const sendBtn = h('button', { class: 'btn', type: 'button', disabled: !complete(s), 'data-sms-test': '',
        onclick: async () => {
            await run(sendBtn, async () => {
                const r = await rpc('sms_send_test', { phone: phoneInp.value, text: textInp.value });
                if (r.ok) toast('SMS принято Play Mobile. Проверьте телефон.', 'success');
                else toast(tr(r.message) + (r.detail ? ' (' + r.detail + ')' : ''), 'error');
                loadLog();
            });
        } }, Icon('Send', { size: 13 }), ' Отправить проверочное SMS');
    return h('div', { class: 'card', style: { marginBottom: '16px' } },
        h('div', { class: 'card-header' }, h('h3', null, Icon('Send', { size: 16 }), ' ', tr('Проверочное SMS'))),
        h('div', { style: { padding: '18px' } },
            h('div', { class: 'muted', style: { fontSize: '13.5px', marginBottom: '12px' } },
                complete(s) ? 'Отправьте SMS на свой номер — так видно, что логин, пароль и отправитель верны. Работает и при выключенной отправке.'
                    : 'Сначала сохраните подключение.'),
            h('div', { class: 'row', style: { gap: '12px', alignItems: 'flex-start' } },
                h('div', { style: { flex: '0 0 240px' } }, field('Номер телефона', phoneInp)),
                h('div', { style: { flex: 1 } }, field('Текст', textInp))),
            sendBtn));
}

// ---------------------------------------------------------------------------
// 3. Журнал
// ---------------------------------------------------------------------------
function logCard() {
    refs.logBody = h('div');
    paintLog();
    return h('div', { class: 'card', style: { marginBottom: '16px' } },
        h('div', { class: 'card-header' }, h('h3', null, Icon('ListBullet', { size: 16 }), ' ', tr('Журнал SMS'))),
        refs.logBody);
}

async function loadLog() {
    try { state.log = await rpc('sms_log_recent', { limit: 50 }); state.logError = null; }
    catch (e) { state.log = null; state.logError = e; }
    if (refs.logBody) paintLog();
}

const KIND = { test: 'Проверка' };

function paintLog() {
    const box = refs.logBody;
    if (!box) return;
    clear(box);
    if (state.logError) {
        box.appendChild(h('div', { class: 'muted', style: { padding: '24px' } }, trf('Не удалось загрузить журнал: {msg}', { msg: state.logError.message })));
        return;
    }
    if (state.log === null) { box.appendChild(h('div', { class: 'muted', style: { padding: '24px' } }, 'Загрузка…')); return; }
    if (!state.log.length) { box.appendChild(h('div', { class: 'empty', style: { padding: '34px 20px' } }, 'SMS ещё не отправлялись.')); return; }
    const tb = h('tbody');
    for (const m of state.log) {
        const result = m.status === 'sent'
            ? h('span', { style: { color: 'var(--ok-700, #2e8b52)' } }, tr('Принято Play Mobile'))
            : h('span', { style: { color: 'var(--crit-700, #96271b)' } }, tr('Ошибка'), m.error ? ': ' + m.error : '');
        tb.appendChild(h('tr', { 'data-sms-id': m.message_id },
            h('td', { class: 'muted', style: { fontSize: '12.5px', whiteSpace: 'nowrap' } }, fmtDateTime(m.created_at)),
            h('td', { class: 'cell-mono', style: { fontSize: '12.5px' } }, '+' + m.phone),
            h('td', { style: { fontSize: '12.5px', maxWidth: '360px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: m.text }, m.text),
            h('td', { class: 'muted', style: { fontSize: '12.5px' } }, tr(KIND[m.kind] || m.kind)),
            h('td', { style: { fontSize: '12.5px' } }, result),
            h('td', { class: 'muted', style: { fontSize: '12.5px' } }, m.created_by_name || '—')));
    }
    box.appendChild(h('table', { class: 'tbl', style: { width: '100%' } },
        h('thead', null, h('tr', null,
            h('th', null, 'Когда'), h('th', null, 'Номер'), h('th', null, 'Текст'),
            h('th', null, 'Вид'), h('th', null, 'Итог'), h('th', null, 'Кто отправил'))),
        tb));
}

// Кнопку только блокируем: восстановление textContent стёрло бы иконку внутри
// неё (урок telegram-report.js run()).
async function run(btn, fn) {
    if (state.busy) return;
    state.busy = true;
    btn.disabled = true;
    try { await fn(); }
    catch (e) { toast(e.message || 'Не удалось выполнить операцию.', 'error'); }
    finally {
        state.busy = false;
        try { btn.disabled = false; } catch (_) { /* перерисовано */ }
    }
}
