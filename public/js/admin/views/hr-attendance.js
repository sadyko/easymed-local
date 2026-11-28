// STAFF_ATTENDANCE_V1 (2026-11-27) — «HR → Посещаемость»: EasyMed Staff, этап 1.
//
// Вкладки:
//   Сегодня        — сводка (на работе, ушли, не пришли, опоздали, рано ушли,
//                    нет ухода) и таблица сотрудников с графиком и отметками;
//   Отчёт          — период по сотрудникам, выгрузка в Excel (две страницы:
//                    итоги и смены);
//   Подозрительное — отказы бота и один код у разных сотрудников;
//   Точки входа    — входы с экраном QR: ссылка экрана, «Новая ссылка экрана»;
//   Сотрудники и Telegram — код подключения сотрудника, отключение;
//   Бот            — токен @BotFather, проверка связи, «опоздание после N мин».
// Правка смены (приход, уход, аннулировать) — окно с обязательной причиной,
// история правок — там же. Сервер: rpc/attendance.js.
import { h, Icon, clear, toast, field } from '../ui.js';
import { tr, trf } from '../i18n.js';
import { supabase } from '../../supabase.js';

const SHEETJS_URL = '../../vendor/xlsx-0.20.3.js';
let _xlsx = null;
const loadXlsx = () => (_xlsx ||= import(/* @vite-ignore */ SHEETJS_URL).then((m) => (m && m.utils ? m : m.default)));

async function rpc(name, args = {}) {
    const { data, error } = await supabase.rpc(name, args);
    if (error) throw new Error(error.message || tr('Не удалось выполнить запрос.'));
    return data;
}

const STATUS = {
    present:  { label: 'На работе', cls: 'ok' },
    left:     { label: 'Ушёл',      cls: 'muted' },
    absent:   { label: 'Не пришёл', cls: 'bad' },
    expected: { label: 'Ожидается', cls: 'muted' },
    off:      { label: 'Выходной',  cls: 'muted' },
};
const FLAG_LABEL = {
    unknown_telegram: 'Telegram не подключён к сотруднику',
    bad_token: 'Поддельный или чужой QR-код',
    expired_token: 'Просроченный QR-код',
    replay: 'Повтор того же кода',
    inactive_location: 'Отключённая точка входа',
    branch_not_allowed: 'Не тот филиал',
    inactive_employee: 'Уволенный сотрудник',
    too_soon: 'Двойная отметка за минуту',
    rate_limited: 'Слишком много попыток',
    confirm_expired: 'Подтверждение просрочено',
    missing_out: 'Не отметил уход',
    not_private: 'Попытка из группы',
};

const dur = (m) => (m ? `${Math.floor(m / 60)} ${tr('ч')} ${String(m % 60).padStart(2, '0')} ${tr('мин')}` : '—');
const ddmm = (d) => (d ? d.split('-').reverse().join('.') : '');
function localToday() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function monthStart() { return localToday().slice(0, 8) + '01'; }

// STAFF_ATTENDANCE_NAV_V1 (2026-11-28, владелец: «make today filter with other
// dates as drop down and all other bring under attendance in left navigation
// bar») — вкладок на экране больше нет. Главный экран «Посещаемость» — один,
// с выбором периода выпадающим списком (Сегодня, Вчера, неделя, месяц, свой
// день, свой период): один день — доска дня, несколько — отчёт за период.
// «Подозрительное», «Точки входа», «Сотрудники и Telegram», «Бот» — подпункты
// под «Посещаемостью» в левом меню (admin.js attendanceSubRail); какой открыт —
// ctx.payload.sub.
export const ATTENDANCE_SUBS = [
    { id: 'flags',     label: 'Подозрительное',        icon: 'Warning' },
    { id: 'locations', label: 'Точки входа',           icon: 'MapPin' },
    { id: 'links',     label: 'Сотрудники и Telegram', icon: 'User' },
    { id: 'bot',       label: 'Бот',                   icon: 'Bot' },
];

export async function renderAttendancePage(container, ctx = {}) {
    clear(container);
    const sub = ctx.payload && ATTENDANCE_SUBS.some((s) => s.id === ctx.payload.sub) ? ctx.payload.sub : 'board';
    const page = h('div', { class: 'fade-in hr-page att-page', 'data-att': sub });
    container.appendChild(page);
    // ATT_TOOLBAR_V1 (2026-11-28, владелец: «remove text on top, no need to show
    // where am I») — заголовка и подзаголовка нет: где ты, видно по левому меню.
    const body = h('div');
    page.appendChild(body);
    async function show() {
        clear(body);
        body.appendChild(h('div', { class: 'card empty' }, tr('Загрузка…')));
        try {
            const fn = { board: boardTab, flags: flagsTab, locations: locationsTab, links: linksTab, bot: botTab }[sub];
            await fn(body, show);
        } catch (e) { clear(body); body.appendChild(h('div', { class: 'card error-state' }, e.message)); }
    }
    await show();
}

// ---- период ----------------------------------------------------------------
const PERIODS = [
    ['today', 'Сегодня'], ['yesterday', 'Вчера'], ['week', 'Эта неделя'], ['last_week', 'Прошлая неделя'],
    ['month', 'Этот месяц'], ['last_month', 'Прошлый месяц'], ['day', 'Выбрать день'], ['range', 'Свой период'],
];
const boardState = { period: 'today', day: '', from: '', to: '', department_id: '', branch_id: '', position: '', status: '' };

const ymdOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function shift(days) { const d = new Date(); d.setDate(d.getDate() + days); return ymdOf(d); }

/** Выбранный период: { kind: 'day', date } или { kind: 'range', from, to }. */
function resolvePeriod(st) {
    const now = new Date();
    const dow = (now.getDay() + 6) % 7;   // понедельник = 0
    switch (st.period) {
        case 'yesterday': return { kind: 'day', date: shift(-1) };
        case 'week': return { kind: 'range', from: shift(-dow), to: localToday() };
        case 'last_week': return { kind: 'range', from: shift(-dow - 7), to: shift(-dow - 1) };
        case 'month': return { kind: 'range', from: monthStart(), to: localToday() };
        case 'last_month': {
            const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
            const last = new Date(now.getFullYear(), now.getMonth(), 0);
            return { kind: 'range', from: ymdOf(first), to: ymdOf(last) };
        }
        case 'day': return { kind: 'day', date: st.day || localToday() };
        case 'range': return { kind: 'range', from: st.from || monthStart(), to: st.to || localToday() };
        default: return { kind: 'day', date: localToday() };
    }
}

/**
 * ATT_TOOLBAR_V1 — период: четыре частых варианта кнопками (Сегодня, Вчера,
 * Неделя, Месяц) и «Другой период» списком для остальных; для «Выбрать день» /
 * «Свой период» — поля дат в одной плашке рядом, без подписей над ними.
 */
const QUICK = [['today', 'Сегодня'], ['yesterday', 'Вчера'], ['week', 'Неделя'], ['month', 'Месяц']];
function periodControls(reshow) {
    const setPeriod = (id) => { boardState.period = id; boardState.status = ''; reshow(); };
    const seg = h('div', { class: 'segmented seg-lg att-seg', role: 'group', 'aria-label': tr('Период') },
        ...QUICK.map(([id, label]) => h('button', { type: 'button', class: boardState.period === id ? 'on' : '', 'data-att-quick': id, onclick: () => setPeriod(id) }, tr(label))));
    const isQuick = QUICK.some(([id]) => id === boardState.period);
    const sel = h('select', { class: 'att-more' + (isQuick ? '' : ' on'), 'data-att-period': '', 'aria-label': tr('Другой период'), onchange: () => { if (sel.value) setPeriod(sel.value); } },
        h('option', { value: '', selected: isQuick }, tr('Другой период')),
        ...PERIODS.filter(([id]) => !QUICK.some(([q]) => q === id)).map(([id, label]) => h('option', { value: id, selected: boardState.period === id }, tr(label))));
    const date = (key, label) => h('input', {
        type: 'date', value: boardState[key] || (key === 'from' ? monthStart() : localToday()), max: localToday(), 'data-att-r': key, 'aria-label': tr(label),
        onchange: (e) => { boardState[key] = e.target.value; reshow(); },
    });
    const dates = boardState.period === 'day' ? [date('day', 'День')]
        : boardState.period === 'range' ? [date('from', 'С'), h('span', { class: 'att-dash' }, '—'), date('to', 'По')] : null;
    return h('div', { class: 'att-tb-period' }, seg, sel,
        dates ? h('div', { class: 'att-dates' }, Icon('Calendar', { size: 15 }), ...dates) : null);
}

async function boardTab(host, reshow) {
    const p = resolvePeriod(boardState);
    if (p.kind === 'day') return todayTab(host, reshow, p.date);
    return reportTab(host, reshow, p.from, p.to);
}

// ---- фильтры ---------------------------------------------------------------
// ATT_TOOLBAR_V1 — одна плашка: слева период, справа фильтры и действия.
// Подписей над списками нет — «Все отделы» / «Все филиалы» говорят сами за
// себя; выбранный фильтр подсвечен, чтобы не забыть, что список сужен.
function filterBar(opts, state, onChange, period, actions = []) {
    const sel = (key, ph, label, list) => {
        const s = h('select', { class: 'att-fsel' + (state[key] ? ' on' : ''), 'data-att-f': key, 'aria-label': tr(label), onchange: () => { state[key] = s.value; onChange(); } },
            h('option', { value: '' }, tr(ph)),
            ...list.map((o) => h('option', { value: String(o.v), selected: String(state[key] || '') === String(o.v) }, o.t)));
        return s;
    };
    return h('div', { class: 'card att-toolbar' },
        period,
        h('div', { class: 'att-tb-filters' },
            sel('department_id', 'Все отделы', 'Отдел', opts.departments.map((d) => ({ v: d.id, t: d.name }))),
            opts.branches.length > 1 ? sel('branch_id', 'Все филиалы', 'Филиал', opts.branches.map((b) => ({ v: b.id, t: b.name }))) : null,
            opts.positions.length ? sel('position', 'Все должности', 'Должность', opts.positions.map((v) => ({ v, t: v }))) : null,
            ...actions));
}

/** ATT_TOOLBAR_V1 — карточка показателя: иконка, большое число, подпись, пояснение. */
function statTile({ id = null, icon, label, value, note = '', tone = '', on = false, onclick = null }) {
    return h(onclick ? 'button' : 'div', {
        type: onclick ? 'button' : null, class: 'att-tile' + (tone ? ' ' + tone : '') + (on ? ' on' : '') + (onclick ? ' is-btn' : ''),
        'data-att-tile': id, onclick,
    },
        h('span', { class: 'att-tile-ico' }, Icon(icon, { size: 18 })),
        h('span', { class: 'att-tile-txt' },
            h('b', null, String(value)),
            h('span', { class: 'att-tile-label' }, tr(label)),
            note ? h('span', { class: 'att-tile-note' }, note) : null));
}

// ---- Сегодня ---------------------------------------------------------------
async function todayTab(host, reshow, day) {
    const d = await rpc('attendance_today', {
        date: day || null, department_id: boardState.department_id || null,
        branch_id: boardState.branch_id || null, position: boardState.position || null,
    });
    clear(host);
    host.appendChild(filterBar(d.options, boardState, reshow, periodControls(reshow)));

    const s = d.summary;
    // Карточка — фильтр таблицы: нажали — показаны только эти, нажали снова — все.
    const tile = (id, icon, label, n, tone = '') => statTile({
        id, icon, label, value: n, tone, on: boardState.status === id,
        onclick: () => { boardState.status = boardState.status === id ? '' : id; reshow(); },
    });
    host.appendChild(h('div', { class: 'att-tiles' },
        tile('present', 'Check', 'На работе', s.present, 'ok'),
        tile('left', 'ArrowRight', 'Ушли', s.left),
        tile('absent', 'Warning', 'Не пришли', s.absent, s.absent ? 'bad' : ''),
        tile('late', 'Clock', 'Опоздали', s.late, s.late ? 'warn' : ''),
        tile('early', 'ArrowDown', 'Ушли раньше', s.early, s.early ? 'warn' : ''),
        tile('expected', 'Calendar', 'Ожидаются', s.expected),
        tile('off', 'Pause', 'Выходной', s.off)));

    if (d.stale.length) {
        host.appendChild(h('div', { class: 'card att-stale', 'data-att-stale': '' },
            h('div', { class: 'att-stale-head' }, Icon('Warning', { size: 16 }), ' ', trf('Не отмечен уход — {n}', { n: d.stale.length })),
            ...d.stale.map((x) => h('div', { class: 'att-stale-row' },
                h('span', null, x.full_name, ' · ', ddmm(x.day), ' ', tr('приход'), ' ', x.in_time),
                d.can_edit ? h('button', { type: 'button', class: 'btn btn-outline btn-sm', onclick: () => openSession(x.id, reshow) }, tr('Поправить')) : null))));
    }

    const match = (r) => {
        const st = boardState.status;
        if (!st) return true;
        if (st === 'late') return r.late_min > 0;
        if (st === 'early') return r.early_min > 0;
        return r.status === st;
    };
    const rows = d.rows.filter(match);
    if (!rows.length) { host.appendChild(h('div', { class: 'card empty' }, tr('Сотрудников по этим условиям нет.'))); return; }
    host.appendChild(h('div', { class: 'card hr-table-wrap' }, h('table', { class: 'tbl att-table' },
        h('thead', null, h('tr', null, ...['Сотрудник', 'Отдел', 'График', 'Приход', 'Уход', 'На работе', 'Статус', ''].map((t) => h('th', null, t ? tr(t) : '')))),
        h('tbody', null, ...rows.map((r) => {
            const st = STATUS[r.status];
            return h('tr', { 'data-att-row': String(r.user_id) },
                h('td', null, h('div', { class: 'hr-name' }, r.full_name), h('div', { class: 'hr-sub' }, r.position || '',
                    r.linked ? null : h('span', { class: 'att-nolink' }, (r.position ? ' · ' : ''), tr('Telegram не подключён')))),
                h('td', null, r.department || '—'),
                h('td', null, r.sched || h('span', { class: 'hr-muted' }, tr('нет графика'))),
                h('td', null, r.first_in || '—', r.late_min ? h('div', { class: 'att-late' }, trf('опоздание {n} мин', { n: r.late_min })) : null),
                h('td', null, r.last_out || (r.status === 'present' ? h('span', { class: 'hr-muted' }, '…') : '—'),
                    r.early_min ? h('div', { class: 'att-late' }, trf('раньше на {n} мин', { n: r.early_min })) : null),
                h('td', null, dur(r.minutes)),
                h('td', null, h('span', { class: 'att-badge att-' + st.cls }, tr(st.label))),
                h('td', { class: 'num' }, d.can_edit ? (r.sessions.length
                    ? h('button', { type: 'button', class: 'btn btn-outline btn-sm', 'data-att-edit': String(r.sessions[r.sessions.length - 1].id),
                        onclick: () => openSession(r.sessions[r.sessions.length - 1].id, reshow) }, tr('Поправить'))
                    : h('button', { type: 'button', class: 'btn btn-outline btn-sm', 'data-att-add': String(r.user_id),
                        onclick: () => openCreate(r, d.date, reshow) }, tr('Отметить вручную'))) : null));
        })))));
}

// ---- окна правки -----------------------------------------------------------
function modal(title) {
    document.querySelector('[data-att-modal]')?.remove();
    const overlay = h('div', { class: 'modal', 'data-att-modal': '' });
    const onKey = (ev) => { if (ev.key === 'Escape') close(); };
    const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
    const body = h('div', { class: 'modal-body' });
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));
    overlay.appendChild(h('div', { class: 'modal-card att-modal', role: 'dialog', 'aria-modal': 'true' },
        h('div', { class: 'modal-head' }, h('h2', null, title), h('button', { class: 'modal-close', type: 'button', 'aria-label': tr('Закрыть'), onclick: close })),
        body));
    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKey);
    return { body, close };
}

async function openSession(id, after) {
    const data = await rpc('attendance_session_get', { id }).catch((e) => { toast(e.message, 'error'); return null; });
    if (!data) return;
    const s = data.session;
    const m = modal(trf('Смена — {name}', { name: s.full_name }));
    const inAt = h('input', { type: 'datetime-local', value: s.in_local || '', 'data-att-in': '' });
    const outAt = h('input', { type: 'datetime-local', value: s.out_local || '', 'data-att-out': '' });
    const reason = h('textarea', { rows: '2', maxlength: '1000', placeholder: tr('Например: забыл телефон, подтвердил старший врач'), 'data-att-reason': '' });
    const act = async (action) => {
        if (reason.value.trim().length < 3) { toast(tr('Напишите причину правки.'), 'warn'); reason.focus(); return; }
        if (action === 'void' && !window.confirm(tr('Аннулировать эту смену? Она перестанет считаться в часах.'))) return;
        try {
            await rpc('attendance_correct', { action, id, in_at: inAt.value || null, out_at: outAt.value || null, reason: reason.value });
            toast(tr('Сохранено.'), 'success'); m.close(); after();
        } catch (e) { toast(e.message, 'error'); }
    };
    // Родной append() превратил бы пустую ветку в текст «null» — заметку кладём отдельно.
    if (s.missing_out) m.body.append(h('div', { class: 'att-note' }, tr('Уход не был отмечен: смену закрыл следующий приход. Укажите время ухода, если оно известно.')));
    m.body.append(
        h('div', { class: 'hrr-form' },
            field(tr('Приход'), inAt), field(tr('Уход'), outAt),
            h('div', { class: 'hrr-f-wide' }, field(tr('Причина правки (обязательно)'), reason))),
        h('div', { class: 'hrr-actions' },
            h('button', { type: 'button', class: 'btn btn-outline', 'data-att-void': '', onclick: () => act('void') }, tr('Аннулировать')),
            h('button', { type: 'button', class: 'btn btn-primary', 'data-att-save': '', onclick: () => act('edit') }, tr('Сохранить'))));
    if (data.corrections.length) {
        m.body.append(h('h3', { class: 'hrr-h3' }, tr('История правок')),
            h('ul', { class: 'hrr-history' }, ...data.corrections.map((c) => h('li', null,
                h('span', { class: 'hrr-history-when' }, c.at.replace('T', ' ').slice(0, 16)),
                h('span', null, c.action === 'void' ? tr('Аннулирована') : c.action === 'create' ? tr('Создана вручную')
                    : `${c.old_in || '—'} – ${c.old_out || '—'}  →  ${c.new_in || '—'} – ${c.new_out || '—'}`,
                h('span', { class: 'hrr-history-note' }, ' — ', c.reason)),
                c.by_name ? h('span', { class: 'hrr-history-by' }, c.by_name) : null))));
    }
}

function openCreate(row, day, after) {
    const m = modal(trf('Отметить вручную — {name}', { name: row.full_name }));
    const from = row.sched ? row.sched.split('–')[0] : '09:00';
    const inAt = h('input', { type: 'datetime-local', value: `${day}T${from}`, 'data-att-in': '' });
    const outAt = h('input', { type: 'datetime-local', value: '', 'data-att-out': '' });
    const reason = h('textarea', { rows: '2', maxlength: '1000', placeholder: tr('Например: телефон разрядился, приход подтвердил заведующий'), 'data-att-reason': '' });
    m.body.append(
        h('div', { class: 'hrr-form' },
            field(tr('Приход'), inAt), field(tr('Уход (если уже ушёл)'), outAt),
            h('div', { class: 'hrr-f-wide' }, field(tr('Причина (обязательно)'), reason))),
        h('div', { class: 'hrr-actions' }, h('button', { type: 'button', class: 'btn btn-primary', 'data-att-create': '',
            onclick: async () => {
                if (reason.value.trim().length < 3) { toast(tr('Напишите причину правки.'), 'warn'); reason.focus(); return; }
                try {
                    await rpc('attendance_correct', { action: 'create', user_id: row.user_id, in_at: inAt.value, out_at: outAt.value || null, reason: reason.value });
                    toast(tr('Сохранено.'), 'success'); m.close(); after();
                } catch (e) { toast(e.message, 'error'); }
            } }, tr('Сохранить'))));
}

// ---- Отчёт -----------------------------------------------------------------
async function reportTab(host, reshow, from, to) {
    const d = await rpc('attendance_report', { from, to, department_id: boardState.department_id || null, branch_id: boardState.branch_id || null, position: boardState.position || null });
    clear(host);
    host.appendChild(filterBar(d.options, boardState, reshow, periodControls(reshow), [
        h('button', { type: 'button', class: 'btn btn-outline att-export', 'data-att-export': '', onclick: () => exportReport(d) },
            Icon('Download', { size: 15 }), ' ', tr('Excel')),
    ]));
    if (!d.employees.length) { host.appendChild(h('div', { class: 'card empty' }, tr('Сотрудников по этим условиям нет.'))); return; }
    // ATT_TOOLBAR_V1 — итоги периода карточками над таблицей (раньше их не было).
    const sum = (k) => d.employees.reduce((a, e) => a + (Number(e[k]) || 0), 0);
    const sched = sum('scheduled_days'), present = sum('days_present');
    const late = sum('late_days'), early = sum('early_days'), missing = sum('missing_out'), absent = sum('absent_days');
    host.appendChild(h('div', { class: 'att-tiles' },
        statTile({ icon: 'Patients', label: 'Сотрудников', value: d.employees.length }),
        statTile({ icon: 'Clock', label: 'Отработано', value: `${Math.round(sum('minutes') / 60)} ${tr('ч')}` }),
        statTile({ icon: 'Activity', label: 'Явка', value: sched ? `${Math.round((present / sched) * 100)}%` : '—', tone: 'ok',
            note: trf('{n} из {m} дней', { n: present, m: sched }) }),
        statTile({ icon: 'Clock', label: 'Опоздания', value: late, tone: late ? 'warn' : '', note: late ? trf('{n} мин', { n: sum('late_min') }) : '' }),
        statTile({ icon: 'ArrowDown', label: 'Ранние уходы', value: early, tone: early ? 'warn' : '' }),
        statTile({ icon: 'Flag', label: 'Нет ухода', value: missing, tone: missing ? 'warn' : '' }),
        statTile({ icon: 'Warning', label: 'Прогулы', value: absent, tone: absent ? 'bad' : '' })));
    host.appendChild(h('div', { class: 'card hr-table-wrap' }, h('table', { class: 'tbl att-table' },
        h('thead', null, h('tr', null, ...['Сотрудник', 'Отдел', 'Дней по графику', 'Был на работе', 'Часы', 'Опозданий', 'Ранних уходов', 'Нет ухода', 'Прогулы'].map((t) => h('th', { class: t === 'Сотрудник' || t === 'Отдел' ? '' : 'num' }, tr(t))))),
        h('tbody', null, ...d.employees.map((e) => h('tr', { 'data-att-rep': String(e.user_id) },
            h('td', null, h('div', { class: 'hr-name' }, e.full_name), h('div', { class: 'hr-sub' }, e.position)),
            h('td', null, e.department || '—'),
            h('td', { class: 'num' }, String(e.scheduled_days)),
            h('td', { class: 'num' }, String(e.days_present)),
            h('td', { class: 'num' }, dur(e.minutes)),
            h('td', { class: 'num' + (e.late_days ? ' att-late' : '') }, e.late_days ? trf('{n} ({m} мин)', { n: e.late_days, m: e.late_min }) : '0'),
            h('td', { class: 'num' + (e.early_days ? ' att-late' : '') }, String(e.early_days)),
            h('td', { class: 'num' + (e.missing_out ? ' att-late' : '') }, String(e.missing_out)),
            h('td', { class: 'num' + (e.absent_days ? ' att-bad' : '') }, String(e.absent_days))))))));
}

async function exportReport(d) {
    let XLSX;
    try { XLSX = await loadXlsx(); } catch { toast(tr('Не удалось загрузить Excel-библиотеку.'), 'error'); return; }
    const wb = XLSX.utils.book_new();
    const sum = [[tr('Сотрудник'), tr('Должность'), tr('Отдел'), tr('Дней по графику'), tr('Был на работе'), tr('Часы'), tr('Опозданий'), tr('Минут опозданий'), tr('Ранних уходов'), tr('Нет ухода'), tr('Прогулы')],
        ...d.employees.map((e) => [e.full_name, e.position, e.department, e.scheduled_days, e.days_present, Math.round(e.minutes / 6) / 10, e.late_days, e.late_min, e.early_days, e.missing_out, e.absent_days])];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sum), tr('Итоги'));
    const ses = [[tr('Дата'), tr('Сотрудник'), tr('Отдел'), tr('Приход'), tr('Уход'), tr('Часы'), tr('Вход'), tr('Выход'), tr('Правки')],
        ...d.sessions.map((s) => [ddmm(s.day), s.full_name, s.department, s.in_time, s.out_time || (s.missing_out ? tr('нет ухода') : ''),
            s.minutes != null ? Math.round(s.minutes / 6) / 10 : '', s.in_location || (s.source === 'correction' ? tr('вручную') : ''), s.out_location || '', s.corrections || ''])];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(ses), tr('Смены'));
    XLSX.writeFile(wb, `attendance_${d.from}_${d.to}.xlsx`);
}

// ---- Подозрительное --------------------------------------------------------
const flagsState = { from: '', to: '' };

async function flagsTab(host, reshow) {
    flagsState.from ||= localToday();
    flagsState.to ||= localToday();
    const d = await rpc('attendance_flags_list', flagsState);
    clear(host);
    const date = (key) => h('input', { type: 'date', value: flagsState[key], onchange: (e) => { flagsState[key] = e.target.value; reshow(); } });
    host.appendChild(h('div', { class: 'card card-pad-sm hr-filters' },
        h('div', { class: 'hr-f hr-f-date' }, field(tr('С'), date('from'))),
        h('div', { class: 'hr-f hr-f-date' }, field(tr('По'), date('to')))));
    if (d.shared.length) {
        host.appendChild(h('div', { class: 'card att-stale' },
            h('div', { class: 'att-stale-head' }, Icon('Warning', { size: 16 }), ' ', tr('Один QR-код у нескольких сотрудников — возможно, код переслали')),
            ...d.shared.map((x) => h('div', { class: 'att-stale-row' }, h('span', null, x.at_local, ' · ', x.location, ' · ', x.names)))));
    }
    if (!d.items.length) { host.appendChild(h('div', { class: 'card empty' }, tr('За эти дни подозрительных попыток нет.'))); return; }
    host.appendChild(h('div', { class: 'card hr-table-wrap' }, h('table', { class: 'tbl att-table' },
        h('thead', null, h('tr', null, ...['Когда', 'Что', 'Сотрудник', 'Точка', 'Подробно'].map((t) => h('th', null, tr(t))))),
        h('tbody', null, ...d.items.map((f) => h('tr', null,
            h('td', null, f.at_local), h('td', null, tr(FLAG_LABEL[f.kind] || f.kind)),
            h('td', null, f.full_name || (f.tg_user_id ? trf('Telegram {id}', { id: f.tg_user_id }) : '—')),
            h('td', null, f.location || '—'), h('td', { class: 'hr-sub' }, f.detail || '')))))));
}

// ---- Точки входа -----------------------------------------------------------
async function locationsTab(host, reshow) {
    const d = await rpc('attendance_locations_list');
    clear(host);
    host.appendChild(h('div', { class: 'card card-pad-sm att-explain' },
        h('p', null, tr('Точка входа — экран у входа в здание (компьютер, планшет или телевизор с браузером). На нём QR-код, который меняется каждые несколько секунд: сфотографированный код быстро перестаёт работать. Откройте ссылку экрана в браузере у входа и разверните на весь экран (F11).')),
        d.can_edit ? h('button', { type: 'button', class: 'btn btn-primary btn-sm', 'data-att-loc-new': '', onclick: () => openLocation(null, d.branches, reshow) }, Icon('Plus', { size: 14 }), ' ', tr('Точка входа')) : null));
    if (!d.locations.length) { host.appendChild(h('div', { class: 'card empty' }, tr('Точек входа пока нет. Добавьте главный вход каждого здания.'))); return; }
    host.appendChild(h('div', { class: 'att-locs' }, ...d.locations.map((l) => {
        const url = l.screen_path ? location.origin + l.screen_path : null;
        return h('div', { class: 'card att-loc' + (l.active ? '' : ' is-off'), 'data-att-loc': String(l.id) },
            h('div', { class: 'att-loc-head' }, h('div', null, h('div', { class: 'hr-name' }, l.name), h('div', { class: 'hr-sub' }, [l.branch, l.active ? null : tr('отключена'), trf('код меняется раз в {n} с', { n: l.rotate_seconds })].filter(Boolean).join(' · '))),
                d.can_edit ? h('button', { type: 'button', class: 'hrr-icon-btn', title: tr('Изменить'), 'aria-label': tr('Изменить'), onclick: () => openLocation(l, d.branches, reshow) }, Icon('Edit', { size: 14 })) : null),
            url ? h('div', { class: 'att-loc-url' }, h('code', null, url)) : null,
            url ? h('div', { class: 'att-loc-actions' },
                h('button', { type: 'button', class: 'btn btn-outline btn-sm', onclick: () => window.open(url, '_blank', 'noopener') }, tr('Открыть экран')),
                h('button', { type: 'button', class: 'btn btn-outline btn-sm', onclick: async () => { try { await navigator.clipboard.writeText(url); toast(tr('Ссылка скопирована.'), 'success'); } catch { window.prompt(tr('Скопируйте ссылку:'), url); } } }, tr('Копировать ссылку')),
                h('button', { type: 'button', class: 'btn btn-outline btn-sm', 'data-att-loc-reset': String(l.id), onclick: async () => {
                    if (!window.confirm(tr('Выдать новую ссылку экрана? Старая ссылка и все старые коды перестанут работать — откройте новую ссылку на экране у входа.'))) return;
                    try { await rpc('attendance_location_reset_screen', { id: l.id }); toast(tr('Новая ссылка готова.'), 'success'); reshow(); } catch (e) { toast(e.message, 'error'); }
                } }, tr('Новая ссылка экрана'))) : null);
    })));
}

function openLocation(l, branches, after) {
    const m = modal(l ? tr('Точка входа') : tr('Новая точка входа'));
    const name = h('input', { type: 'text', maxlength: '200', value: l ? l.name : '', placeholder: tr('Например: Главный вход'), 'data-att-loc-name': '' });
    const branch = h('select', { 'data-att-loc-branch': '' }, h('option', { value: '' }, tr('Любой филиал')),
        ...branches.map((b) => h('option', { value: String(b.id), selected: l ? l.branch_id === b.id : branches.length === 1 }, b.name)));
    const rotate = h('input', { type: 'number', min: '3', max: '120', step: '1', value: l ? String(l.rotate_seconds) : '3', 'data-att-loc-rotate': '' });   // STAFF_ATTENDANCE_FAST_QR_V1
    const active = h('input', { type: 'checkbox', checked: l ? !!l.active : true });
    m.body.append(h('div', { class: 'hrr-form' },
        h('div', { class: 'hrr-f-wide' }, field(tr('Название'), name)),
        field(tr('Филиал'), branch), field(tr('Код меняется раз в, секунд'), rotate),
        h('label', { class: 'hr-f-check' }, active, ' ', tr('Точка работает')),
        h('div', { class: 'hrr-f-wide hrr-hint' }, tr('Сотрудник с назначенным филиалом может отмечаться только у точек своего филиала.'))),
    h('div', { class: 'hrr-actions' }, h('button', { type: 'button', class: 'btn btn-primary', 'data-att-loc-save': '', onclick: async () => {
        if (!name.value.trim()) { toast(tr('Напишите название точки.'), 'warn'); return; }
        try {
            await rpc('attendance_location_save', { id: l ? l.id : null, name: name.value, branch_id: branch.value || null, rotate_seconds: Number(rotate.value) || 3, active: active.checked });
            toast(tr('Сохранено.'), 'success'); m.close(); after();
        } catch (e) { toast(e.message, 'error'); }
    } }, tr('Сохранить'))));
    name.focus();
}

// ---- Сотрудники и Telegram -------------------------------------------------
async function linksTab(host, reshow) {
    const d = await rpc('staff_links_list');
    clear(host);
    const linked = d.staff.filter((s) => s.linked_at).length;
    host.appendChild(h('div', { class: 'card card-pad-sm att-explain' },
        h('p', null, trf('Подключено {n} из {total}.', { n: linked, total: d.staff.length }), ' ',
            tr('Нажмите «Код подключения» и передайте сотруднику ссылку (лично или через рабочий чат): он откроет её в своём Telegram, и бот привяжется к нему. Ссылка одноразовая и действует 15 минут.')),
        d.bot_ready ? null : h('p', { class: 'att-late' }, tr('Бот сотрудников ещё не готов: подключите его во вкладке «Бот».'))));
    host.appendChild(h('div', { class: 'card hr-table-wrap' }, h('table', { class: 'tbl att-table' },
        h('thead', null, h('tr', null, ...['Сотрудник', 'Отдел', 'Telegram', ''].map((t) => h('th', null, t ? tr(t) : '')))),
        h('tbody', null, ...d.staff.map((s) => h('tr', { 'data-att-link': String(s.id) },
            h('td', null, h('div', { class: 'hr-name' }, s.full_name), h('div', { class: 'hr-sub' }, s.position || '')),
            h('td', null, s.department || '—'),
            h('td', null, s.linked_at ? h('span', { class: 'att-badge att-ok' }, s.tg_username ? '@' + s.tg_username : tr('подключён')) : h('span', { class: 'hr-muted' }, tr('не подключён'))),
            h('td', { class: 'num' }, d.can_edit ? h('div', { class: 'att-row-actions' },
                h('button', { type: 'button', class: 'btn btn-outline btn-sm', disabled: !d.bot_ready, 'data-att-code': String(s.id), onclick: () => issueCode(s) }, tr('Код подключения')),
                s.linked_at ? h('button', { type: 'button', class: 'btn btn-outline btn-sm', 'data-att-revoke': String(s.id), onclick: async () => {
                    if (!window.confirm(trf('Отключить Telegram сотрудника «{name}»? Он перестанет отмечаться, пока не подключится заново.', { name: s.full_name }))) return;
                    try { await rpc('staff_link_revoke', { user_id: s.id }); toast(tr('Отключено.'), 'success'); reshow(); } catch (e) { toast(e.message, 'error'); }
                } }, tr('Отключить')) : null) : null)))))));
}

async function issueCode(s) {
    let r;
    try { r = await rpc('staff_link_code_create', { user_id: s.id }); } catch (e) { toast(e.message, 'error'); return; }
    const m = modal(trf('Подключение — {name}', { name: s.full_name }));
    m.body.append(
        h('p', null, tr('Передайте эту ссылку сотруднику. Он должен открыть её в СВОЁМ Telegram. Ссылка одноразовая, действует 15 минут.')),
        h('div', { class: 'att-loc-url' }, h('code', { 'data-att-code-url': '' }, r.url)),
        h('div', { class: 'hrr-actions' },
            h('button', { type: 'button', class: 'btn btn-primary', onclick: async () => { try { await navigator.clipboard.writeText(r.url); toast(tr('Ссылка скопирована.'), 'success'); } catch { window.prompt(tr('Скопируйте ссылку:'), r.url); } } }, tr('Копировать ссылку'))));
}

// ---- Бот -------------------------------------------------------------------
async function botTab(host, reshow) {
    const s = await rpc('staff_bot_settings_get');
    clear(host);
    const token = h('input', { type: 'password', autocomplete: 'off', placeholder: s.has_token ? trf('Сохранён: {hint}', { hint: s.token_hint }) : '1234567890:AA…', 'data-att-bot-token': '' });
    const grace = h('input', { type: 'number', min: '0', max: '120', value: String(s.grace_minutes), 'data-att-bot-grace': '' });
    const enabled = h('input', { type: 'checkbox', checked: s.enabled, 'data-att-bot-on': '' });
    const status = s.last_check_status === 'ok' ? h('span', { class: 'att-badge att-ok' }, trf('Связь есть: @{name}', { name: s.bot_username }))
        : s.last_check_status === 'error' ? h('span', { class: 'att-badge att-bad' }, s.last_check_error || tr('Ошибка связи'))
            : h('span', { class: 'hr-muted' }, tr('Связь ещё не проверяли'));
    host.appendChild(h('div', { class: 'card card-pad att-bot' },
        h('ol', { class: 'att-steps' },
            h('li', null, tr('В Telegram откройте @BotFather, отправьте /newbot и придумайте имя, например «Клиника — сотрудники». Это должен быть ОТДЕЛЬНЫЙ бот, не пациентский.')),
            h('li', null, tr('Скопируйте токен, который пришлёт @BotFather, вставьте ниже и сохраните.')),
            h('li', null, tr('Нажмите «Проверить связь», затем включите бота.'))),
        h('div', { class: 'hrr-form' },
            h('div', { class: 'hrr-f-wide' }, field(tr('Токен бота'), token)),
            field(tr('Опоздание считается после, минут'), grace),
            h('label', { class: 'hr-f-check' }, enabled, ' ', tr('Бот включён'))),
        h('div', { class: 'att-bot-status' }, status),
        h('div', { class: 'hrr-actions' },
            s.has_token ? h('button', { type: 'button', class: 'btn btn-outline', onclick: async () => {
                if (!window.confirm(tr('Удалить токен и выключить бота? Сотрудники не смогут отмечаться, пока бот не подключат снова.'))) return;
                try { await rpc('staff_bot_clear_token'); reshow(); } catch (e) { toast(e.message, 'error'); }
            } }, tr('Удалить токен')) : null,
            s.has_token ? h('button', { type: 'button', class: 'btn btn-outline', 'data-att-bot-check': '', onclick: async () => {
                try { const r = await rpc('staff_bot_check'); toast(r.last_check_status === 'ok' ? tr('Связь с ботом есть.') : (r.last_check_error || tr('Ошибка связи')), r.last_check_status === 'ok' ? 'success' : 'error'); reshow(); } catch (e) { toast(e.message, 'error'); }
            } }, tr('Проверить связь')) : null,
            h('button', { type: 'button', class: 'btn btn-primary', 'data-att-bot-save': '', onclick: async () => {
                try {
                    await rpc('staff_bot_settings_save', { bot_token: token.value || null, grace_minutes: Number(grace.value), enabled: enabled.checked });
                    toast(tr('Сохранено.'), 'success'); reshow();
                } catch (e) { toast(e.message, 'error'); }
            } }, tr('Сохранить')))));
}
