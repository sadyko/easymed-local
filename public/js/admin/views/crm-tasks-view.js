// CRM_UNIFY_V1 (2026-10-09) — ВИД «ЗАДАЧИ» РЯДОМ С «КАНБАН / СПИСОК».
//
// Владелец: «операторы не видят свои задачи». Задача была видна только внутри
// своей карточки, а списка задач по всем карточкам не было. Здесь — все
// открытые задачи: Просрочено / Сегодня / Позже / Без срока (Р18).
//   • По умолчанию — мои. Администратор и руководитель (crm.all) выбирают:
//     мои, все операторы, без ответственного или сотрудника по имени.
//   • Строка открывает карточку.
//   • Задача на карточке, которую человек не видит (старое поручение — правило
//     orOwn), приходит без карточки: сервер кладёт ограничение заявок в JOIN
//     (schema-registry crm_tasks.embed.crm_requests). Строка говорит «Карточка у
//     другого оператора»: отметить «сделано» можно, открыть — нет.
//   • Красный счётчик меню считает тем же запросом (crm-tasks.js taskQuery).
// Вид — не маршрут, а третий вид раздела CRM (views/crm.js paintBody).
import { supabase } from '../../supabase.js';
import { h, Icon, clear, toast, fmtDateTime } from '../ui.js';
import { trf } from '../i18n.js';
import { formatPhone } from '../phone-format.js';   // CRM_TASKS_LEAD_CHIP_V1
import { loadTaskRows, nowIso, TASK_LIST_LIMIT } from './crm-tasks.js';   // CRM_UNIFY_V1 (итоговое ревью) — порядок и предел

export const TASK_GROUPS = [['overdue', 'Просрочено'], ['today', 'Сегодня'], ['later', 'Позже'], ['nodue', 'Без срока']];

// CRM_TASKS_FILTER_V1 — отборы вида «Задачи» (полоса над списком). Срок
// хранится в UTC той же формы, что nowIso(), поэтому границы — сравнение строк.
//   Просрочено — срок уже наступил (любой день);
//   Сегодня    — срок сегодня по местному времени (в том числе прошедший час);
//   Эта неделя — срок с сегодня до конца воскресенья (неделя с понедельника);
//   Позже      — после этой недели и задачи без срока.
export const TASK_FILTERS = [['all', 'Все'], ['overdue', 'Просрочено'], ['today', 'Сегодня'], ['week', 'Эта неделя'], ['later', 'Позже']];
let taskFilter = 'all';

function dayEdges(now) {
    const start = new Date(now); start.setHours(0, 0, 0, 0);
    const end = new Date(now); end.setHours(23, 59, 59, 999);
    const weekEnd = new Date(end); weekEnd.setDate(weekEnd.getDate() + ((7 - weekEnd.getDay()) % 7));   // до воскресенья
    return { start: nowIso(start), end: nowIso(end), weekEnd: nowIso(weekEnd), now: nowIso(now) };
}

/** Попадает ли открытая задача в отбор key на момент now. */
/**
 * CRM_TASKS_LEAD_CHIP_V1 (2026-11-14, владелец со снимком строки задачи: «make
 * it more visible, patient name and number»). Кому звонить — сразу за текстом
 * задачи, тёмным, а не бледной обрезанной строкой у правого края: значок,
 * имя и номер целиком (formatPhone). Нет имени — один номер, без повтора.
 */
function leadChip(lead) {
    const phone = lead.phone ? (formatPhone(lead.phone) || lead.phone) : '';
    const name = String(lead.full_name || '').trim();
    const sameAsPhone = name && phone && name.replace(/\D/g, '') === String(lead.phone || '').replace(/\D/g, '');
    return h('span', { class: 'crm-tv-lead', 'data-task-lead': '' },
        Icon('User', { size: 13 }),
        name && !sameAsPhone ? h('b', { class: 'crm-tv-lead-name' }, name) : null,
        phone ? h('span', { class: 'crm-tv-lead-phone num' }, phone) : null,
        !name && !phone ? '—' : null);
}

export function taskInFilter(t, key, now = new Date()) {
    if (!t || t.done_at) return false;
    if (key === 'all') return true;
    const due = t.due_at ? String(t.due_at) : '';
    const e = dayEdges(now);
    if (key === 'overdue') return !!due && due <= e.now;
    if (key === 'today') return !!due && due >= e.start && due <= e.end;
    if (key === 'week') return !!due && due >= e.start && due <= e.weekEnd;
    if (key === 'later') return !due || due > e.weekEnd;
    return false;
}

/**
 * Открытые задачи по группам. Срок хранится в UTC той же формы, что nowIso(),
 * поэтому «просрочено» и «до конца сегодняшних местных суток» — сравнение строк.
 * @returns {{overdue:object[], today:object[], later:object[], nodue:object[]}}
 */
export function groupTasks(tasks, now = new Date()) {
    const out = { overdue: [], today: [], later: [], nodue: [] };
    const nowS = nowIso(now);
    const end = new Date(now); end.setHours(23, 59, 59, 999);
    const endS = nowIso(end);
    for (const t of tasks || []) {
        if (!t || t.done_at) continue;
        const due = t.due_at ? String(t.due_at) : '';
        if (!due) out.nodue.push(t);
        else if (due <= nowS) out.overdue.push(t);
        else if (due <= endS) out.today.push(t);
        else out.later.push(t);
    }
    for (const k of Object.keys(out)) {
        out[k].sort((a, b) => String(a.due_at || '').localeCompare(String(b.due_at || '')) || (a.id - b.id));
    }
    return out;
}

/**
 * Нарисовать вид «Задачи» в root.
 * @param {HTMLElement} root
 * @param {object} o
 * @param {'me'|'all'|'none'|string} o.who   чьи задачи (тот же отбор, что у счётчика)
 * @param {number|null} o.me                 кто смотрит
 * @param {boolean} [o.canPick]              администратор / crm.all — выбор оператора
 * @param {{id:number, full_name:string}[]} [o.staff]  сотрудники для выбора
 * @param {(requestId:number, lead:object) => void} [o.onOpen]
 * @param {(who:string) => void} [o.onWho]
 * @param {() => void} [o.onChanged]         после отметки «сделано»
 * @param {number} [o.limit]                 предел строк (по умолчанию TASK_LIST_LIMIT)
 * @param {HTMLElement} [o.headExtra]        кнопка справа в строке отбора («Новая заявка»)
 */
export async function renderTasksView(root, { who = 'me', me = null, canPick = false, staff = [], onOpen, onWho, onChanged, db = supabase,
    limit = TASK_LIST_LIMIT, headExtra = null } = {}) {
    clear(root);
    // CRM_TASKS_COMPACT_V1 (2026-11-14, владелец со снимком вида «Задачи»: «make
    // this place more compact and remove thickin better put button done») —
    // отбор «Мои» и «Новая заявка» ОДНОЙ строкой: раньше кнопка стояла своей
    // строкой над отбором, и до задач было два пустых яруса.
    let sel = null;
    if (canPick) {
        sel = h('select', { class: 'crm-tv-who', 'aria-label': 'Чьи задачи', 'data-task-who-filter': '' },
            h('option', { value: 'me' }, 'Мои'),
            h('option', { value: 'all' }, 'Все операторы'),
            h('option', { value: 'none' }, 'Без ответственного'),
            ...(staff || []).map((p) => h('option', { value: String(p.id) }, p.full_name || trf('Сотрудник №{id}', { id: p.id }))));
        sel.value = String(who);
        sel.addEventListener('change', () => { if (onWho) onWho(sel.value); });
    }
    if (sel || headExtra) {
        root.appendChild(h('div', { class: 'crm-tv-head' },
            sel ? Icon('User', { size: 14 }) : null, sel,
            headExtra ? h('span', { class: 'crm-tv-head-extra' }, headExtra) : null));
    }
    const body = h('div', { class: 'crm-tv', 'data-crm-tasks-view': '' },
        h('div', { class: 'muted', style: { fontSize: '12.5px' } }, 'Загружаем…'));
    root.appendChild(body);

    // CRM_UNIFY_V1 (итоговое ревью) — сначала со сроком (просроченные — первыми),
    // без срока — в конце; обрезанный список говорит об этом, а не молчит:
    // красный счётчик и вид не расходятся без объяснения.
    const { rows, total, error } = await loadTaskRows(db, { who, me, limit });
    clear(body);
    if (error) {
        body.appendChild(h('div', { class: 'muted' }, trf('Задачи недоступны: {msg}', { msg: error.message })));
        return;
    }
    if (total > rows.length) {
        body.appendChild(h('div', { class: 'muted crm-tv-truncated', 'data-task-truncated': '' }, Icon('Warning', { size: 13 }), ' ',
            trf('Показаны первые {n} задач из {total} — сначала просроченные и ближайшие; сузьте отбор, чтобы увидеть остальные.', { n: rows.length, total })));
    }
    // CRM_TASKS_FILTER_V1 (2026-11-14, владелец со снимком группы «Позже»: «why
    // it is in Позже, better put filter and add filter there, today, this week,
    // later. Make task in one line only, task, deadline of task then visible
    // beautiful button done»). Вместо карточек-групп — ОДИН список и полоса
    // отборов со счётчиками: Все · Просрочено · Сегодня · Эта неделя · Позже.
    // Выбранный отбор живёт в модуле (taskFilter): вид перерисовывается после
    // каждого «Готово», и отбор не должен сбрасываться на «Все».
    const now = new Date();
    const live = rows.filter((t) => t && !t.done_at);
    const counts = Object.fromEntries(TASK_FILTERS.map(([k]) => [k, live.filter((t) => taskInFilter(t, k, now)).length]));
    if (!counts[taskFilter] && taskFilter !== 'all') taskFilter = 'all';
    // CRM_TASKS_GRID_V1 — строки — по общим колонкам; у чужих отборов есть колонка исполнителя.
    const list = h('div', { class: 'card crm-tv-list' + (who !== 'me' ? ' has-who' : ''), 'data-task-list': '' });
    const paintList = () => {
        clear(list);
        const shown = live.filter((t) => taskInFilter(t, taskFilter, now));
        if (!shown.length) {
            list.appendChild(h('div', { class: 'empty', 'data-crm-tasks-empty': '' }, live.length ? 'Нет задач в этом отборе.' : 'Открытых задач нет.'));
            return;
        }
        for (const t of shown) list.appendChild(row(t));
    };
    const chips = TASK_FILTERS.map(([key, label]) => {
        const b = h('button', { type: 'button', class: 'crm-tv-chip' + (key === taskFilter ? ' on' : '') + (key === 'overdue' && counts.overdue ? ' is-late' : ''),
            'data-task-filter': key, 'aria-pressed': String(key === taskFilter),
            onclick: () => {
                taskFilter = key;
                for (const c of chips) { const on = c.getAttribute('data-task-filter') === key; c.classList.toggle('on', on); c.setAttribute('aria-pressed', String(on)); }
                paintList();
            } }, label, h('span', { class: 'crm-tv-chip-n' }, String(counts[key])));
        return b;
    });
    body.appendChild(h('div', { class: 'crm-tv-filters', role: 'toolbar', 'aria-label': 'Отбор задач' }, ...chips));
    body.appendChild(list);
    paintList();

    // CRM_UNIFY_V1 (итоговое ревью, T3) — ДОСТУПНОСТЬ. Строка была role=button с
    // флажком внутри: у кнопки дети «презентационные», и флажок «Сделано» для
    // экранного диктора пропадал. Теперь строка — просто строка: карточку
    // открывает настоящая кнопка с текстом задачи (Enter и пробел — её родные),
    // а «Сделано» — отдельный флажок рядом со своей подписью.
    function row(t) {
        const lead = t.crm_requests && t.crm_requests.id != null ? t.crm_requests : null;
        // CRM_TASKS_COMPACT_V1 — «Готово» кнопкой справа, а не флажком слева:
        // флажок у списка задач читали как «выбрать строку», а не «сделано».
        const done = h('button', { type: 'button', class: 'btn btn-sm crm-tv-done', 'aria-label': 'Сделано', 'data-task-done': String(t.id) },
            Icon('Check', { size: 13 }), h('span', null, 'Готово'));
        done.addEventListener('click', async () => {
            if (done.disabled) return;
            done.disabled = true;
            // done_by ставит сервер по сессии (реестр stamps).
            const { error: e } = await db.from('crm_tasks').update({ done_at: nowIso() }).eq('id', t.id);
            if (e) { toast(e.message, 'fail'); done.disabled = false; return; }
            if (onChanged) onChanged();
        });
        // CRM_TASKS_FILTER_V1 — задача ОДНОЙ строкой: текст (открывает карточку),
        // приглушённо — чья карточка и, у чужих отборов, исполнитель; справа —
        // срок (красный у просроченной) и «Готово».
        const late = !!t.due_at && String(t.due_at) <= nowIso(now);
        const assignee = who !== 'me' && t.users && t.users.full_name
            ? h('span', { class: 'crm-tv-who-name' }, Icon('User', { size: 12 }), ' ', t.users.full_name) : null;
        const title = lead
            ? h('button', { type: 'button', class: 'crm-tv-open crm-tv-text', 'data-task-open': '', title: 'Открыть карточку',
                onclick: () => { if (onOpen) onOpen(t.request_id, lead); } }, t.text)
            : h('div', { class: 'crm-tv-text' }, t.text);
        // CRM_TASK_ROW_CLICK_V1 (2026-11-14, владелец: «whole card should be clickable … in my
        // task place») — карточку открывает щелчок по ЛЮБОМУ месту строки, а не только по
        // тексту задачи. Кнопка с текстом осталась — её находит клавиатура и диктор (T3);
        // «Готово» и прочие кнопки строки делают своё и карточку не открывают.
        return h('div', { class: 'crm-tv-row' + (lead ? ' is-clickable' : ' crm-tv-hidden') + (late ? ' is-late' : ''), 'data-task-row': String(t.id),
            onclick: lead ? (ev) => { if (ev.target && ev.target.closest && ev.target.closest('button, a, input, select')) return; if (onOpen) onOpen(t.request_id, lead); } : null },
            title,
            lead ? leadChip(lead) : h('span', { class: 'crm-tv-lead muted' }, Icon('Lock', { size: 12 }), ' ', 'Карточка у другого оператора'),
            // CRM_TASKS_GRID_V1 — у чужих отборов ячейка исполнителя есть ВСЕГДА (пустая —
            // без имени): иначе строка без неё сдвигала бы срок и «Готово» на колонку влево.
            who !== 'me' ? (assignee || h('span', { class: 'crm-tv-who-name' })) : null,
            h('span', { class: 'crm-tv-due' + (late ? ' is-late' : '') },
                Icon('Clock', { size: 12 }), ' ', t.due_at ? fmtDateTime(t.due_at) : 'Без срока'),
            done);
    }
}
