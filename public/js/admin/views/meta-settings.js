// META_LEADS_V1_VIEW — Настройки → «Коммерческие инструменты» → «Meta: заявки
// из рекламы».
//
// Экран отвечает на четыре вопроса администратора, карточка на каждый:
//   1. Подключение — есть ли токен, какая страница, какие формы (и какие из
//      них забирать). Токен вводится один раз и уходит на сервер; обратно
//      приходит только признак и хвост (rpc/meta.js).
//   2. Опрос — включён ли, как часто, когда был последний удачный, что
//      сломалось (слово причины → фраза из shared/meta-reasons.js), «Проверить
//      сейчас» и «Забрать за последние N дней» для первого запуска.
//   3. Последние заявки — что реально пришло и куда легло в CRM.
//   4. Как получить токен — пошагово, как у Telegram-бота: без этой карточки
//      администратор идёт гуглить и приносит токен не с теми правами.
//
// Образцы: telegram-settings.js (токен, карточки, run() «одна кнопка за раз»)
// и telephony-settings.js (карточка опроса, таблица последних событий).
// Переключатели сохраняются сразу по щелчку — выключатель, ждущий отдельной
// кнопки, оставляют «включённым» и уходят (урок telegram-settings.js).

import { supabase } from '../../supabase.js';
import { h, Icon, PageHead, clear, toast, field, checkField, fmtDateTime } from '../ui.js';
import { tr, trf } from '../i18n.js';
import { isLicensed } from '../licence.js';
import { metaReasonText, META_REASONS_NEED_ACTION } from '../../shared/meta-reasons.js';

const state = { s: null, leads: null, leadsError: null, busy: false, pages: null };
const refs = { root: null, body: null, leadsBody: null, onNavigate: null };

async function rpc(name, args = {}) {
    const { data, error } = await supabase.rpc(name, args);
    if (error) throw new Error(error.message || 'Не удалось выполнить запрос.');
    return data;
}

export async function renderMetaSettings(container, { onNavigate } = {}) {
    clear(container);
    refs.onNavigate = onNavigate || null;
    state.pages = null;
    refs.root = h('div', { class: 'fade-in' });
    container.appendChild(refs.root);

    refs.root.appendChild(PageHead({
        title: 'Meta: заявки из рекламы',
        subtitle: 'Facebook и Instagram: заявки из рекламных форм сами попадают в CRM. Токен доступа хранится на сервере в зашифрованном виде.',
    }));

    const body = h('div');
    refs.root.appendChild(body);
    refs.body = body;

    body.appendChild(h('div', { class: 'muted', style: { padding: '24px' } }, 'Загрузка…'));
    try {
        state.s = await rpc('meta_settings_get');
    } catch (e) {
        clear(body);
        body.appendChild(h('div', { class: 'empty', style: { padding: '30px' } },
            trf('Не удалось загрузить настройки: {msg}', { msg: e.message })));
        return;
    }
    paint();
    loadLeads();
}

function paint() {
    clear(refs.body);
    refs.body.appendChild(connectionCard());
    refs.body.appendChild(pollingCard());
    refs.body.appendChild(leadsCard());
    refs.body.appendChild(helpCard());
}

// ---------------------------------------------------------------------------
// Статус — одной строкой: первое, что администратор ищет глазами
// ---------------------------------------------------------------------------
const BANNER_STYLE = {
    ok:   { bg: '#e8f6ed', fg: '#2e8b52' },
    warn: { bg: '#fdf3e1', fg: '#b07d1f' },
    err:  { bg: '#fbeae9', fg: '#b0453b' },
    info: { bg: '#e9ebfb', fg: '#4b52b0' },
};
function banner(kind, icon, title, note) {
    const c = BANNER_STYLE[kind] || BANNER_STYLE.info;
    return h('div', { class: 'meta-banner', 'data-kind': kind, style: { display: 'flex', gap: '10px', alignItems: 'flex-start', padding: '12px 14px', borderRadius: '10px', background: c.bg, color: c.fg, marginBottom: '14px' } },
        h('span', { style: { display: 'inline-flex', marginTop: '1px' } }, Icon(icon, { size: 16 })),
        h('div', null,
            h('div', { style: { fontWeight: 600 } }, title),
            note ? h('div', { style: { fontSize: '12.5px', marginTop: '2px', opacity: .9 } }, note) : null));
}

function statusRows() {
    const s = state.s;
    const out = [];
    if (!isLicensed('crm')) {
        out.push(banner('err', 'Warning', 'Модуль CRM не подключён',
            'Заявкам из рекламы некуда идти: без доски CRM опрос не запускается. Подключите модуль в «Настройки → Подписка».'));
    }
    if (!s.token_set) {
        out.push(banner('warn', 'Warning', 'Токен не задан', 'Заявки не забираются. Создайте токен по инструкции внизу страницы и вставьте его в поле ниже.'));
        return out;
    }
    if (s.last_error && META_REASONS_NEED_ACTION.includes(s.last_error)) {
        out.push(banner('err', 'Warning', 'Нужно вмешательство', metaReasonText(s.last_error)));
        return out;
    }
    if (s.enabled && s.last_ok_at) {
        out.push(banner('ok', 'Check', trf('Подключено · страница «{page}»', { page: s.page_name || s.page_id }),
            trf('Последняя удачная проверка: {when}', { when: fmtDateTime(s.last_ok_at) })
            + (s.last_error ? ' · ' + metaReasonText(s.last_error) : '')));
        return out;
    }
    if (s.enabled) {
        out.push(banner('info', 'Clock', 'Опрос включён, первая проверка скоро',
            s.last_error ? metaReasonText(s.last_error) : 'Заявки появятся в CRM в течение пары минут после публикации.'));
        return out;
    }
    out.push(banner('warn', 'Warning', 'Токен сохранён, опрос выключен', 'Включите «Забирать заявки» в карточке «Опрос», чтобы заявки шли в CRM.'));
    return out;
}

// ---------------------------------------------------------------------------
// 1. Подключение — токен, страница, формы
// ---------------------------------------------------------------------------
function connectionCard() {
    const s = state.s;
    const card = h('div', { style: { padding: '18px' } });
    for (const b of statusRows()) card.appendChild(b);

    // type=password — токен не должен светиться на экране в регистратуре.
    const input = h('input', {
        type: 'password', autocomplete: 'off', spellcheck: 'false', style: { width: '100%' },
        placeholder: s.token_set ? 'Введите новый токен, чтобы заменить' : 'EAAG…',
    });
    const showBtn = h('button', { class: 'btn btn-sm', type: 'button',
        onclick: () => {
            input.type = input.type === 'password' ? 'text' : 'password';
            showBtn.textContent = input.type === 'password' ? tr('Показать') : tr('Скрыть');
        } }, 'Показать');
    card.appendChild(field(
        s.token_set && s.token_tail ? trf('Сохранённый токен: …{hint} (заменить)', { hint: s.token_tail })
            : s.token_set ? 'Токен сохранён (заменить)' : 'Токен доступа Meta',
        h('div', { class: 'row', style: { gap: '8px' } }, h('div', { style: { flex: '1' } }, input), showBtn)));

    const saveBtn = h('button', { class: 'btn btn-primary', type: 'button',
        onclick: async () => {
            const v = input.value.trim();
            if (!v) return toast('Введите токен.', 'warn');
            await run(saveBtn, async () => { await connectWith({ token: v }); input.value = ''; });
        } }, Icon('Check', { size: 13 }), ' Проверить и сохранить токен');

    const testBtn = h('button', { class: 'btn', type: 'button', disabled: !s.token_set,
        onclick: async () => { await run(testBtn, () => connectWith({})); } },
        Icon('Refresh', { size: 13 }), ' Проверить связь');

    const clearBtn = h('button', { class: 'btn btn-danger', type: 'button',
        style: { display: s.token_set ? '' : 'none' },
        onclick: async () => {
            if (!confirm(tr('Удалить токен? Опрос будет выключен, новые заявки из рекламы перестанут попадать в CRM.'))) return;
            await run(clearBtn, async () => {
                state.s = await rpc('meta_token_clear');
                state.pages = null;
                toast('Токен удалён, опрос выключен.', 'info');
                paint();
            });
        } }, 'Удалить токен');

    card.appendChild(h('div', { class: 'row', style: { gap: '8px', marginTop: '12px' } },
        saveBtn, testBtn, h('span', { class: 'grow' }), clearBtn));

    if (s.token_set) {
        card.appendChild(h('div', { class: 'muted', style: { marginTop: '14px', fontSize: '13.5px' } },
            'Страница:', ' ', h('b', null, s.page_name || '—'),
            s.page_id ? h('span', { class: 'cell-mono', style: { marginLeft: '6px', fontSize: '12.5px' } }, '#' + s.page_id) : null,
            s.token_checked_at ? [' ', trf('· проверено {when}', { when: fmtDateTime(s.token_checked_at) })] : null));
        if (state.pages && state.pages.length > 1) card.appendChild(pagePicker());
        card.appendChild(formsBlock());
    }

    return h('div', { class: 'card', style: { marginBottom: '16px' } },
        h('div', { class: 'card-header' }, h('h3', null, Icon('Megaphone', { size: 16 }), ' Подключение')),
        card);
}

// Несколько страниц у одного токена — выбрать нужную; остальное делает сервер.
function pagePicker() {
    const sel = h('select', { style: { minWidth: '240px' } },
        ...state.pages.map((p) => h('option', { value: p.id, selected: p.id === state.s.page_id }, p.name + ' (#' + p.id + ')')));
    const btn = h('button', { class: 'btn btn-sm', type: 'button',
        onclick: async () => { await run(btn, () => connectWith({ page_id: sel.value })); } }, 'Выбрать страницу');
    return h('div', { style: { marginTop: '10px' } },
        field('У токена несколько страниц — какая принадлежит клинике?',
            h('div', { class: 'row', style: { gap: '8px', alignItems: 'center' } }, sel, btn)));
}

async function connectWith(args) {
    const res = await rpc('meta_connect', args);
    state.s = res.settings || state.s;
    if (!res.ok) {
        toast(res.message || tr('Meta отклонила подключение.'), 'error');
        paint();
        return;
    }
    state.pages = Array.isArray(res.pages) ? res.pages : null;
    toast(trf('Подключено: страница «{page}», форм: {n}', { page: res.page ? res.page.name : '', n: (res.forms || []).length }), 'success');
    paint();
}

// Список форм страницы с галочками. Галочки и режим сохраняются сразу.
function formsBlock() {
    const s = state.s;
    const box = h('div', { style: { marginTop: '14px' } });
    if (!s.forms.length) {
        box.appendChild(h('div', { class: 'muted', style: { fontSize: '13.5px' } },
            'У страницы пока нет рекламных форм. Создайте форму в Ads Manager (цель «Лиды») и нажмите «Проверить связь».'));
        return box;
    }
    const modeCb = h('input', { type: 'checkbox', checked: s.forms_mode === 'selected',
        onchange: async () => {
            modeCb.disabled = true;
            try {
                state.s = await rpc('meta_settings_save', { forms_mode: modeCb.checked ? 'selected' : 'all' });
                toast(modeCb.checked ? 'Заявки берутся только из отмеченных форм.' : 'Заявки берутся из всех форм страницы.', 'success');
            } catch (e) {
                modeCb.checked = !modeCb.checked;
                toast(e.message || 'Не удалось сохранить.', 'error');
            } finally { modeCb.disabled = false; }
        } });
    box.appendChild(checkField('Забирать заявки только из отмеченных форм', modeCb));
    box.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px', margin: '-6px 0 10px 26px' } },
        'Без этой галочки берутся все формы страницы, включая новые. Сохраняется сразу.'));

    const tb = h('tbody');
    for (const f of s.forms) {
        const cb = h('input', { type: 'checkbox', checked: f.selected !== false,
            onchange: async () => {
                cb.disabled = true;
                try { state.s = await rpc('meta_settings_save', { forms: [{ id: f.id, selected: cb.checked }] }); }
                catch (e) { cb.checked = !cb.checked; toast(e.message || 'Не удалось сохранить.', 'error'); }
                finally { cb.disabled = false; }
            } });
        tb.appendChild(h('tr', { 'data-form-id': f.id },
            h('td', { style: { width: '32px' } }, cb),
            h('td', null, f.name || ('#' + f.id)),
            h('td', { class: 'muted', style: { fontSize: '12.5px' } }, formStatus(f.status)),
            h('td', { class: 'cell-mono', style: { fontSize: '12.5px', textAlign: 'right' } }, String(f.leads_count || 0))));
    }
    box.appendChild(h('table', { class: 'tbl meta-forms', style: { width: '100%' } },
        h('thead', null, h('tr', null, h('th', null, ''), h('th', null, 'Форма'), h('th', null, 'Состояние'), h('th', { style: { textAlign: 'right' } }, 'Заявок у Meta'))),
        tb));
    return box;
}

function formStatus(st) {
    const v = String(st || '').toUpperCase();
    if (v === 'ACTIVE') return tr('активна');
    if (v === 'ARCHIVED') return tr('в архиве');
    if (v === 'DELETED') return tr('удалена');
    if (v === 'DRAFT') return tr('черновик');
    return v ? v.toLowerCase() : '—';
}

// ---------------------------------------------------------------------------
// 2. Опрос
// ---------------------------------------------------------------------------
function pollingCard() {
    const s = state.s;
    const card = h('div', { style: { padding: '18px' } });

    const enabled = h('input', { type: 'checkbox', checked: !!s.enabled, 'data-meta-enabled': '1',
        onchange: async () => {
            enabled.disabled = true;
            try {
                state.s = await rpc('meta_settings_save', { enabled: enabled.checked });
                toast(enabled.checked ? 'Опрос заявок включён.' : 'Опрос заявок выключен.', 'success');
                paint();
            } catch (e) {
                enabled.checked = !enabled.checked;   // не сохранилось — не врём галочкой
                toast(e.message || 'Не удалось сохранить.', 'error');
            } finally { enabled.disabled = false; }
        } });
    card.appendChild(checkField('Забирать заявки', enabled));
    card.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px', margin: '-6px 0 12px 26px' } },
        'Сохраняется сразу. Сервер клиники сам спрашивает Meta о новых заявках и заводит их в CRM: источник «Meta (Facebook / Instagram)», ответы формы — в комментарии.'));

    const intInput = h('input', { type: 'number', min: '1', step: '1', style: { width: '120px' }, value: String(s.poll_minutes || 2) });
    const intBtn = h('button', { class: 'btn', type: 'button',
        onclick: async () => {
            const v = Number(intInput.value);
            if (!Number.isInteger(v) || v < 1) return toast('Период опроса — целое число минут, не меньше 1.', 'warn');
            await run(intBtn, async () => {
                state.s = await rpc('meta_settings_save', { poll_minutes: v });
                toast('Сохранено.', 'success');
            });
        } }, 'Сохранить период');
    card.appendChild(field('Период опроса, минут',
        h('div', { class: 'row', style: { gap: '8px', alignItems: 'center' } }, intInput, intBtn)));

    const statusRow = (label, value) => h('div', { class: 'muted', style: { fontSize: '13.5px', marginTop: '4px' } },
        label, ': ', h('span', { style: { color: 'var(--ink-700, inherit)' } }, value));
    card.appendChild(h('div', { style: { marginTop: '10px' } },
        statusRow('Последняя проверка', s.last_poll_at ? fmtDateTime(s.last_poll_at) : '—'),
        statusRow('Последняя удачная', s.last_ok_at ? fmtDateTime(s.last_ok_at) : '—'),
        statusRow('Последняя ошибка', s.last_error ? metaReasonText(s.last_error) : '—')));

    const nowBtn = h('button', { class: 'btn', type: 'button', disabled: !s.enabled,
        onclick: async () => { await run(nowBtn, () => pollNow({})); } },
        Icon('Refresh', { size: 13 }), ' Проверить сейчас');
    const daysInput = h('input', { type: 'number', min: '1', max: '90', step: '1', style: { width: '80px' }, value: '7' });
    const daysBtn = h('button', { class: 'btn', type: 'button', disabled: !s.enabled,
        onclick: async () => {
            const d = Number(daysInput.value);
            if (!Number.isInteger(d) || d < 1 || d > 90) return toast('Число дней — от 1 до 90: дольше Meta заявки не хранит.', 'warn');
            await run(daysBtn, () => pollNow({ days: d }));
        } }, 'Забрать за последние');
    card.appendChild(h('div', { class: 'row', style: { gap: '8px', marginTop: '14px', alignItems: 'center', flexWrap: 'wrap' } },
        nowBtn, h('span', { class: 'grow' }), daysBtn, daysInput, h('span', { class: 'muted', style: { fontSize: '12.5px' } }, 'дней')));
    card.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '10px' } },
        'Заявки появляются в CRM с задержкой до одного периода опроса. Повторная заявка того же человека с открытой карточкой в CRM дописывается в её комментарий, а не заводит вторую.'));

    return h('div', { class: 'card', style: { marginBottom: '16px' } },
        h('div', { class: 'card-header' }, h('h3', null, Icon('Refresh', { size: 16 }), ' ', tr('Опрос'))),
        card);
}

async function pollNow(args) {
    const r = await rpc('meta_poll_now', args);
    state.s = r.settings || state.s;
    const n = (r.created || 0) + (r.merged || 0);
    if (state.s.last_error && state.s.last_error !== 'truncated') toast(metaReasonText(state.s.last_error), 'error');
    else if (!n) toast('Новых заявок нет.', 'info');
    else toast(trf('Получено заявок: {n} (новых карточек: {c}, добавлено к открытым: {m})', { n, c: r.created || 0, m: r.merged || 0 }), 'success');
    if (r.errors) toast(trf('Не удалось подшить заявок: {n} — см. таблицу ниже.', { n: r.errors }), 'warn');
    paint();
    loadLeads();
}

// ---------------------------------------------------------------------------
// 3. Последние заявки
// ---------------------------------------------------------------------------
function leadsCard() {
    refs.leadsBody = h('div');
    paintLeads();
    return h('div', { class: 'card', style: { marginBottom: '16px' } },
        h('div', { class: 'card-header' }, h('h3', null, Icon('ListBullet', { size: 16 }), ' ', tr('Последние заявки'))),
        refs.leadsBody);
}

async function loadLeads() {
    try {
        state.leads = await rpc('meta_leads_recent', { limit: 50 });
        state.leadsError = null;
    } catch (e) {
        state.leads = null;
        state.leadsError = e;
    }
    if (refs.leadsBody) paintLeads();
}

const LEAD_STATUS = { created: 'Создана карточка', merged: 'Добавлена к открытой карточке', error: 'Ошибка' };

function paintLeads() {
    const box = refs.leadsBody;
    if (!box) return;
    clear(box);
    if (state.leadsError) {
        box.appendChild(h('div', { class: 'muted', style: { padding: '24px' } },
            trf('Не удалось загрузить заявки: {msg}', { msg: state.leadsError.message })));
        return;
    }
    if (state.leads === null) {
        box.appendChild(h('div', { class: 'muted', style: { padding: '24px' } }, 'Загрузка…'));
        return;
    }
    if (!state.leads.length) {
        box.appendChild(h('div', { class: 'empty', style: { padding: '34px 20px' } },
            h('p', null, 'Заявок из рекламы пока нет.'),
            h('p', { class: 'muted', style: { fontSize: '12.5px', marginTop: '4px' } },
                'Включите опрос — новые заявки появятся здесь и в CRM сами.')));
        return;
    }
    const tb = h('tbody');
    for (const l of state.leads) {
        const when = l.created_time ? fmtDateTime(l.created_time) : (l.received_at ? fmtDateTime(l.received_at) : '—');
        const status = l.status === 'error'
            ? h('span', { style: { color: 'var(--crit-700, #96271b)' } }, tr('Ошибка'), l.error ? ': ' + l.error : '')
            : tr(LEAD_STATUS[l.status] || l.status);
        tb.appendChild(h('tr', { 'data-leadgen-id': l.leadgen_id },
            h('td', { class: 'muted', style: { fontSize: '12.5px', whiteSpace: 'nowrap' } }, when),
            h('td', null, l.full_name || '—'),
            h('td', { class: 'cell-mono', style: { fontSize: '12.5px' } }, l.phone || '—'),
            h('td', { class: 'muted', style: { fontSize: '12.5px' } }, l.form_name || '—'),
            h('td', { style: { fontSize: '12.5px' } }, status),
            h('td', null, l.crm_request_id
                ? h('button', { class: 'btn btn-ghost btn-sm', type: 'button',
                    onclick: () => { if (refs.onNavigate) refs.onNavigate('crm'); } },
                    l.crm_stage_label || tr('Открыть CRM'))
                : '—')));
    }
    box.appendChild(h('table', { class: 'tbl', style: { width: '100%' } },
        h('thead', null, h('tr', null,
            h('th', null, 'Дата заявки'),
            h('th', null, 'Имя'),
            h('th', null, 'Телефон'),
            h('th', null, 'Форма'),
            h('th', null, 'Итог'),
            h('th', null, 'CRM'))),
        tb));
}

// ---------------------------------------------------------------------------
// 4. Как получить токен
// ---------------------------------------------------------------------------
function helpCard() {
    const card = h('div', { style: { padding: '18px' } });
    // Целые предложения через trf(): адреса и названия прав подставляются,
    // а не склеиваются с русскими обрывками (I18N_COVERAGE_V1, форма 2).
    const RIGHTS = 'leads_retrieval, pages_show_list, pages_read_engagement, pages_manage_ads';
    card.appendChild(h('ol', { style: { margin: '0 0 0 18px', lineHeight: '1.8' } },
        h('li', null, trf('Откройте {site} → «Мои приложения» → «Создать приложение», тип «Бизнес». Привяжите приложение к Business Manager клиники.', { site: 'developers.facebook.com' })),
        h('li', null, trf('В {site} → «Настройки компании» → «Пользователи» → «Системные пользователи» создайте системного пользователя с ролью «Администратор» и назначьте ему активы: страницу клиники (полный контроль) и созданное приложение.', { site: 'business.facebook.com' })),
        h('li', null, trf('У системного пользователя нажмите «Создать токен»: выберите приложение, срок «Никогда не истекает» и права {rights}. Скопируйте токен сразу — Meta показывает его один раз.', { rights: RIGHTS })),
        h('li', null, 'Вставьте токен в поле выше и нажмите «Проверить и сохранить токен». Программа найдёт страницу клиники и её рекламные формы.'),
        h('li', null, 'Включите «Забирать заявки». Новые заявки появятся в CRM в течение пары минут; заявки за прошлые дни можно забрать кнопкой «Забрать за последние … дней».'),
    ));
    card.appendChild(h('div', { class: 'muted', style: { marginTop: '14px', fontSize: '13.5px' } },
        'Токен — это доступ ко всем заявкам страницы клиники. Не пересылайте его в чатах и не храните в текстовых файлах: на сервере он лежит зашифрованным и обратно в браузер не выдаётся. Если токен всё же куда-то попал — отзовите его у системного пользователя и сохраните здесь новый.'));
    card.appendChild(h('div', { class: 'muted', style: { marginTop: '8px', fontSize: '13.5px' } },
        'Серверу клиники нужен выход в интернет. Публичный адрес и webhook не нужны: программа сама спрашивает Meta, поэтому приложение может оставаться в режиме разработки — для своей страницы этого достаточно.'));
    return h('div', { class: 'card' },
        h('div', { class: 'card-header' }, h('h3', null, Icon('Help', { size: 16 }), ' Как получить токен')),
        card);
}

// Одна кнопка за раз: два параллельных сохранения — гонка, в которой побеждает случайное.
async function run(btn, fn) {
    if (state.busy) return;
    state.busy = true;
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = '…';
    try { await fn(); }
    catch (e) { toast(e.message || 'Не удалось выполнить операцию.', 'error'); }
    finally {
        state.busy = false;
        try { btn.disabled = false; btn.textContent = label; } catch (_) { /* перерисовано */ }
    }
}
