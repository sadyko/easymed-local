// CRM_DEDUP_SEARCH_TASKS_V1 (2026-09-23) — ЗАДАЧИ НА КАРТОЧКЕ ЗАЯВКИ.
//
// Владелец: «add tasks to the card of the crm». Решено (23.09): список задач у
// карточки — текст, дата и время, ответственный, отметка «сделано»; красный
// счётчик просроченных у пункта CRM в меню — ответственному свои, администратору
// все. Таблица crm_tasks (миграция 148), доступ — через /api/db по реестру
// (schema-registry: пишут admin/registrar/callcenter, удаляет только admin).
//
// СРОК ХРАНИТСЯ В UTC ('YYYY-MM-DDTHH:MM:SSZ'), а вводится и показывается по
// местному времени. Одна форма строки на базу и на «сейчас» — поэтому
// «просрочено» решает простое сравнение строк и на экране, и в запросе счётчика.
//
// Модуль не знает о доске (views/crm.js его импортирует, а не наоборот), и
// его же зовёт оболочка (admin.js) за числом для меню.
import { supabase } from '../../supabase.js';
import { h, Icon, clear, toast, Tag, fmtDateTime } from '../ui.js';
import { tr, trf } from '../i18n.js';

/** «Сейчас» в той же форме, в какой хранится срок. */
export function nowIso(d = new Date()) {
    return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Местные дата 'YYYY-MM-DD' + время 'HH:MM' → срок в UTC, или '' без даты. */
export function localDueIso(ymd, hhmm) {
    if (!ymd) return '';
    const d = new Date(ymd + 'T' + (hhmm || '09:00') + ':00');   // без 'Z' — местное время
    return isNaN(d) ? '' : nowIso(d);
}

/** Открытая задача, чей срок уже наступил. */
export function isOverdue(task, now = nowIso()) {
    return !!task && !task.done_at && !!task.due_at && String(task.due_at) <= now;
}

/**
 * Ближайшая открытая задача каждой заявки: Map(request_id → task). Сначала по
 * сроку; задача без срока — после любой со сроком.
 */
export function nearestOpenTasks(tasks) {
    const out = new Map();
    for (const t of tasks || []) {
        if (!t || t.done_at) continue;
        const key = String(t.request_id);
        const cur = out.get(key);
        if (!cur || dueRank(t) < dueRank(cur)) out.set(key, t);
    }
    return out;
}
const dueRank = (t) => (t.due_at ? String(t.due_at) : '￿');

/**
 * Сколько просроченных задач показать у пункта CRM в меню. Оператору — только
 * назначенные ему, администратору — все. null — число не узнать (нет права на
 * таблицу, нет сети): бейдж тогда не рисуется вовсе, а не врёт нулём.
 */
export async function overdueTaskCount({ me, isAdmin, db = supabase, now = nowIso() } = {}) {
    if (!isAdmin && me == null) return null;
    let q = db.from('crm_tasks').select('id', { count: 'exact', head: true })
        .is('done_at', null).lte('due_at', now);
    if (!isAdmin) q = q.eq('assignee_id', me);
    const { count, error } = await q;
    if (error) return null;
    return Number(count) || 0;
}

/** Открытые задачи всех заявок — для метки «задача: …» на карточках доски. */
export async function loadOpenTasks(db = supabase) {
    const { data, error } = await db.from('crm_tasks')
        .select('id, request_id, text, due_at, assignee_id, done_at')
        .is('done_at', null).order('due_at', { ascending: true }).limit(2000);
    // Роль без права на задачи (врач видит доску, но не задачи) — просто без меток.
    return error ? [] : (data || []);
}

const TEXT_MAX = 500;

/**
 * Блок «Задачи» в окне сохранённой заявки.
 *
 * @param {object} o
 * @param {object} o.request     строка заявки (нужны id и assigned_to/users)
 * @param {{id:number, full_name:string}|null} o.me
 * @param {boolean} o.isAdmin    удалять задачи может только администратор
 * @param {Promise<object[]>|null} o.staff  кого можно назначить (у админа — весь
 *        персонал доски); без него — «я» и оператор заявки
 * @param {() => void} [o.onChange]  после любой правки (обновить бейдж меню)
 */
export function crmTasksBlock({ request, me, isAdmin, staff = null, onChange } = {}) {
    const root = h('div', { class: 'crm-tasks', 'data-crm-tasks': '' });
    const list = h('div', { class: 'crm-task-list' },
        h('div', { class: 'muted', style: { fontSize: '12.5px' } }, 'Загружаем…'));
    let tasks = [];
    let people = basePeople(request, me);
    const nameOf = (id) => {
        const p = people.find((x) => String(x.id) === String(id));
        return p ? p.full_name : '';
    };
    const changed = () => { try { if (onChange) onChange(); } catch (e) { /* бейдж — подсказка */ } };

    function paintList() {
        clear(list);
        if (!tasks.length) {
            list.appendChild(h('div', { class: 'muted', 'data-crm-tasks-empty': '', style: { fontSize: '12.5px' } }, 'Задач пока нет.'));
            return;
        }
        const now = nowIso();
        for (const t of tasks) {
            const late = isOverdue(t, now);
            const done = !!t.done_at;
            const tick = h('input', { type: 'checkbox', 'aria-label': 'Сделано', 'data-task-done': String(t.id) });
            tick.checked = done;
            tick.addEventListener('change', () => toggleDone(t, tick.checked));
            const who = t.assignee_id != null ? (nameOf(t.assignee_id) || trf('Сотрудник №{id}', { id: t.assignee_id })) : '';
            list.appendChild(h('div', {
                class: 'crm-task' + (late ? ' crm-task-overdue' : '') + (done ? ' crm-task-done' : ''),
                'data-task': String(t.id),
            },
                tick,
                h('div', { class: 'crm-task-main' },
                    h('div', { class: 'crm-task-text' }, t.text),
                    h('div', { class: 'crm-task-meta' },
                        t.due_at ? h('span', null, Icon('Clock', { size: 12 }), ' ', fmtDateTime(t.due_at)) : h('span', null, 'Без срока'),
                        who ? h('span', null, Icon('User', { size: 12 }), ' ', who) : null,
                        late ? Tag('Просрочено', { kind: 'warn' }) : null,
                        done ? Tag('Сделано', { kind: 'ok' }) : null)),
                isAdmin ? h('button', {
                    class: 'btn btn-ghost btn-sm', type: 'button', title: 'Удалить задачу', 'data-task-delete': String(t.id),
                    onclick: () => removeTask(t),
                }, Icon('Trash', { size: 13 })) : null));
        }
    }

    async function reload() {
        const { data, error } = await supabase.from('crm_tasks')
            .select('id, request_id, text, due_at, assignee_id, done_at, done_by, created_by, created_at')
            .eq('request_id', request.id).order('due_at', { ascending: true });
        if (error) {
            clear(list);
            list.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px' } },
                trf('Задачи недоступны: {msg}', { msg: error.message })));
            return;
        }
        // Открытые сверху (по сроку), сделанные — внизу.
        tasks = (data || []).slice().sort((a, b) => (!!a.done_at - !!b.done_at) || (dueRank(a) < dueRank(b) ? -1 : dueRank(a) > dueRank(b) ? 1 : 0));
        paintList();
    }

    async function toggleDone(t, on) {
        const values = on ? { done_at: nowIso(), done_by: me ? me.id : null } : { done_at: null, done_by: null };
        const { error } = await supabase.from('crm_tasks').update(values).eq('id', t.id);
        if (error) { toast(error.message, 'fail'); paintList(); return; }
        Object.assign(t, values);
        await reload();
        changed();
    }

    async function removeTask(t) {
        const { error } = await supabase.from('crm_tasks').delete().eq('id', t.id);
        if (error) { toast(error.message, 'fail'); return; }
        await reload();
        changed();
    }

    // ---- форма новой задачи ----
    const textInp = h('input', { type: 'text', maxlength: String(TEXT_MAX), placeholder: 'Что сделать — например, перезвонить после обеда', 'data-task-text': '' });
    // DATE_LIMITS_V1 — у поля даты НЕТ max: срок задачи всегда в будущем.
    const dateInp = h('input', { type: 'date', 'aria-label': 'Дата', 'data-task-date': '' });
    const timeInp = h('input', { type: 'time', 'aria-label': 'Время', value: '10:00', 'data-task-time': '' });
    const whoSel = h('select', { 'aria-label': 'Ответственный', 'data-task-who': '' });
    const defaultWho = () => String((request && request.assigned_to) || (me && me.id) || '');
    let whoTouched = false;
    whoSel.addEventListener('change', () => { whoTouched = true; });
    function fillWho() {
        const keep = whoTouched ? whoSel.value : defaultWho();
        clear(whoSel);
        for (const p of people) whoSel.appendChild(h('option', { value: String(p.id) }, p.full_name || trf('Сотрудник №{id}', { id: p.id })));
        whoSel.value = people.some((p) => String(p.id) === keep) ? keep : (people[0] ? String(people[0].id) : '');
    }
    fillWho();
    if (staff && typeof staff.then === 'function') {
        staff.then((list2) => {
            if (!Array.isArray(list2) || !list2.length) return;
            const merged = [...people];
            for (const p of list2) if (!merged.some((x) => String(x.id) === String(p.id))) merged.push(p);
            people = merged;
            fillWho();
            paintList();
        }).catch(() => {});
    }

    const addBtn = h('button', { class: 'btn btn-sm btn-primary', type: 'button', 'data-task-add': '' }, Icon('Plus', { size: 13 }), ' ', 'Добавить задачу');
    addBtn.addEventListener('click', async () => {
        const text = textInp.value.trim();
        if (!text) { toast('Напишите, что нужно сделать.', 'fail'); return; }
        const due = localDueIso(dateInp.value, timeInp.value);
        if (!due) { toast('Укажите дату задачи.', 'fail'); return; }
        addBtn.disabled = true;
        try {
            const { error } = await supabase.from('crm_tasks').insert({
                request_id: request.id, text: text.slice(0, TEXT_MAX), due_at: due,
                assignee_id: whoSel.value ? Number(whoSel.value) : null,
                created_by: me ? me.id : null,
            });
            if (error) { toast(error.message, 'fail'); return; }
            textInp.value = '';
            await reload();
            changed();
        } finally { addBtn.disabled = false; }
    });

    root.appendChild(list);
    root.appendChild(h('div', { class: 'crm-task-form' }, textInp, dateInp, timeInp, whoSel, addBtn));
    reload();
    return root;
}

/** «Я» и оператор заявки — кого можно назначить без списка персонала. */
function basePeople(request, me) {
    const out = [];
    if (me && me.id != null) out.push({ id: me.id, full_name: me.full_name || tr('Я') });
    const op = request && request.assigned_to;
    if (op != null && !out.some((p) => String(p.id) === String(op))) {
        out.push({ id: op, full_name: (request.users && request.users.full_name) || '' });
    }
    return out;
}
