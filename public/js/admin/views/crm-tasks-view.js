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
import { loadTaskRows, nowIso, TASK_LIST_LIMIT } from './crm-tasks.js';   // CRM_UNIFY_V1 (итоговое ревью) — порядок и предел

export const TASK_GROUPS = [['overdue', 'Просрочено'], ['today', 'Сегодня'], ['later', 'Позже'], ['nodue', 'Без срока']];

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
 */
export async function renderTasksView(root, { who = 'me', me = null, canPick = false, staff = [], onOpen, onWho, onChanged, db = supabase,
    limit = TASK_LIST_LIMIT } = {}) {
    clear(root);
    if (canPick) {
        const sel = h('select', { class: 'crm-tv-who', 'aria-label': 'Чьи задачи', 'data-task-who-filter': '' },
            h('option', { value: 'me' }, 'Мои'),
            h('option', { value: 'all' }, 'Все операторы'),
            h('option', { value: 'none' }, 'Без ответственного'),
            ...(staff || []).map((p) => h('option', { value: String(p.id) }, p.full_name || trf('Сотрудник №{id}', { id: p.id }))));
        sel.value = String(who);
        sel.addEventListener('change', () => { if (onWho) onWho(sel.value); });
        root.appendChild(h('div', { class: 'crm-tv-head' }, Icon('User', { size: 14 }), sel));
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
    const groups = groupTasks(rows);
    let any = false;
    for (const [key, label] of TASK_GROUPS) {
        const list = groups[key];
        if (!list.length) continue;
        any = true;
        body.appendChild(h('section', { class: 'card crm-tv-group' + (key === 'overdue' ? ' crm-tv-late' : ''), 'data-task-group': key },
            h('h3', { class: 'crm-tv-title' }, label, ' · ' + list.length),
            ...list.map(row)));
    }
    if (!any) body.appendChild(h('div', { class: 'card crm-tv-group' }, h('div', { class: 'empty', 'data-crm-tasks-empty': '' }, 'Открытых задач нет.')));

    // CRM_UNIFY_V1 (итоговое ревью, T3) — ДОСТУПНОСТЬ. Строка была role=button с
    // флажком внутри: у кнопки дети «презентационные», и флажок «Сделано» для
    // экранного диктора пропадал. Теперь строка — просто строка: карточку
    // открывает настоящая кнопка с текстом задачи (Enter и пробел — её родные),
    // а «Сделано» — отдельный флажок рядом со своей подписью.
    function row(t) {
        const lead = t.crm_requests && t.crm_requests.id != null ? t.crm_requests : null;
        const tick = h('input', { type: 'checkbox', 'aria-label': 'Сделано', 'data-task-done': String(t.id) });
        tick.addEventListener('change', async () => {
            if (!tick.checked) return;
            // done_by ставит сервер по сессии (реестр stamps).
            const { error: e } = await db.from('crm_tasks').update({ done_at: nowIso() }).eq('id', t.id);
            if (e) { toast(e.message, 'fail'); tick.checked = false; return; }
            if (onChanged) onChanged();
        });
        const assignee = who !== 'me' && t.users && t.users.full_name
            ? h('span', null, Icon('User', { size: 12 }), ' ', t.users.full_name) : null;
        const title = lead
            ? h('button', { type: 'button', class: 'crm-tv-open crm-tv-text', 'data-task-open': '', title: 'Открыть карточку',
                onclick: () => { if (onOpen) onOpen(t.request_id, lead); } }, t.text)
            : h('div', { class: 'crm-tv-text' }, t.text);
        return h('div', { class: 'crm-tv-row' + (lead ? '' : ' crm-tv-hidden'), 'data-task-row': String(t.id) },
            tick,
            h('div', { class: 'crm-tv-main' },
                title,
                h('div', { class: 'crm-tv-meta' },
                    t.due_at ? h('span', null, Icon('Clock', { size: 12 }), ' ', fmtDateTime(t.due_at)) : h('span', null, 'Без срока'),
                    lead
                        ? h('span', { class: 'crm-tv-lead' }, Icon('Doc', { size: 12 }), ' ', lead.full_name || lead.phone || '—')
                        : h('span', { class: 'muted' }, Icon('Lock', { size: 12 }), ' ', 'Карточка у другого оператора'),
                    assignee)));
    }
}
