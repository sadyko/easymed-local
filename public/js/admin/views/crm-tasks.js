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
import { h, Icon, clear, toast, fmtDateTime } from '../ui.js';
import { tr, trf } from '../i18n.js';

/** «Сейчас» в той же форме, в какой хранится срок. */
export function nowIso(d = new Date()) {
    return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// Время задачи по умолчанию — ОДНО: его показывает поле «время» и его же берёт
// localDueIso, когда время стёрто (ревью W2-M7: было 10:00 в поле и 09:00 здесь).
export const DEFAULT_DUE_TIME = '10:00';

/** Местные дата 'YYYY-MM-DD' + время 'HH:MM' → срок в UTC, или '' без даты. */
export function localDueIso(ymd, hhmm) {
    if (!ymd) return '';
    const d = new Date(ymd + 'T' + (hhmm || DEFAULT_DUE_TIME) + ':00');   // без 'Z' — местное время
    return isNaN(d) ? '' : nowIso(d);
}

/** Открытая задача, чей срок уже наступил. */
export function isOverdue(task, now = nowIso()) {
    return !!task && !task.done_at && !!task.due_at && String(task.due_at) <= now;
}

/**
 * Ближайшая открытая задача каждой заявки: Map(request_id → task). Сначала по
 * сроку; задача без срока — после любой со сроком.
 * CRM_UNIFY_V1 — `me`: своя задача (assignee_id = me) показывается первой, даже
 * если чужая наступает раньше: на чипе доски человек ищет своё дело.
 */
export function nearestOpenTasks(tasks, me = null) {
    const out = new Map();
    const mine = (t) => me != null && String(t.assignee_id) === String(me);
    for (const t of tasks || []) {
        if (!t || t.done_at) continue;
        const key = String(t.request_id);
        const cur = out.get(key);
        if (!cur || (mine(t) && !mine(cur)) || (mine(t) === mine(cur) && dueRank(t) < dueRank(cur))) out.set(key, t);
    }
    return out;
}
const dueRank = (t) => (t.due_at ? String(t.due_at) : '￿');

// CRM_UNIFY_V1 — ОДНО ПРАВИЛО ДЛЯ СПИСКА И СЧЁТЧИКА: чьи открытые задачи (Р18).
// Вид «Задачи» (crm-tasks-view.js) и красный счётчик меню строят запрос здесь.
// Задача приходит с карточкой (embed crm_requests): у невидимой карточки сервер
// отдаёт пустую связь — строка вида «Карточка у другого оператора».
export const TASK_LIST_SELECT = 'id, request_id, text, due_at, assignee_id, done_at, users(full_name), crm_requests(id, full_name, phone, status, assigned_to)';
/**
 * @param {object} db  клиент /api/db
 * @param {object} o
 * @param {'me'|'all'|'none'|string|number} o.who  мои / все / без ответственного / сотрудник
 * @param {number|null} o.me
 * @param {string} [o.columns]
 * @param {boolean} [o.count]  только число (count: 'exact', без строк)
 * @param {boolean} [o.withCount]  строки и число всего отбора (CRM_UNIFY_V1 — «показаны первые N»)
 */
export function taskQuery(db, { who = 'me', me = null, columns = TASK_LIST_SELECT, count = false, withCount = false } = {}) {
    const opts = count ? { count: 'exact', head: true } : (withCount ? { count: 'exact' } : undefined);
    let q = db.from('crm_tasks').select(columns, opts).is('done_at', null);
    if (who === 'me') q = q.eq('assignee_id', me == null ? 0 : Number(me));
    else if (who === 'none') q = q.is('assignee_id', null);
    else if (who !== 'all' && Number(who) > 0) q = q.eq('assignee_id', Number(who));
    return q;
}

/**
 * Сколько просроченных задач показать у пункта CRM в меню. Оператору — только
 * назначенные ему, администратору — все. null — число не узнать (нет права на
 * таблицу, нет сети): бейдж тогда не рисуется вовсе, а не врёт нулём.
 *
 * CRM_UNIFY_V1 — тот же запрос, что у вида «Задачи» (taskQuery), плюс «срок
 * наступил»: щелчок по счётчику открывает вид с тем же отбором `who`. Старая
 * подпись { me, isAdmin } оставлена для совместимости.
 */
export async function overdueTaskCount({ who = null, me = null, isAdmin = false, db = supabase, now = nowIso() } = {}) {
    const w = who || (isAdmin ? 'all' : 'me');
    if (w === 'me' && me == null) return null;
    // CRM_UNIFY_V1 (итоговое ревью) — нужно только число: строк не тянем (число
    // сервер считает по всему отбору, без предела).
    const { count, error } = await taskQuery(db, { who: w, me, columns: 'id', count: true }).lte('due_at', now).limit(1);
    if (error) return null;
    return Number(count) || 0;
}

// CRM_UNIFY_V1 (итоговое ревью) — ПОРЯДОК И ПРЕДЕЛ СПИСКА ЗАДАЧ. Один запрос
// «по сроку» ставил задачи БЕЗ срока первыми (так SQLite сортирует NULL), и
// предел 2000 съедал просроченные — ровно те, ради которых список открывают.
// Теперь два запроса: со сроком — по сроку, без срока — в конце; число всего
// отбора приходит вместе со строками, и вид честно говорит «показаны первые N».
export const TASK_LIST_LIMIT = 5000;
/**
 * Открытые задачи отбора: сначала со сроком (по сроку), потом без срока.
 * @returns {Promise<{rows: object[], total: number, error?: object}>}
 */
export async function loadTaskRows(db, { who = 'me', me = null, columns = TASK_LIST_SELECT, limit = TASK_LIST_LIMIT } = {}) {
    const [dated, undated] = await Promise.all([
        taskQuery(db, { who, me, columns, withCount: true }).not('due_at', 'is', null)
            .order('due_at', { ascending: true }).order('id', { ascending: true }).limit(limit),
        taskQuery(db, { who, me, columns, withCount: true }).is('due_at', null)
            .order('id', { ascending: true }).limit(limit),
    ]);
    const error = (dated && dated.error) || (undated && undated.error);
    if (error) return { rows: [], total: 0, error };
    const a = dated.data || [];
    const b = undated.data || [];
    const total = (Number.isFinite(Number(dated.count)) ? Number(dated.count) : a.length)
        + (Number.isFinite(Number(undated.count)) ? Number(undated.count) : b.length);
    return { rows: [...a, ...b].slice(0, limit), total };
}

/** Открытые задачи всех заявок — для метки «задача: …» на карточках доски. */
export async function loadOpenTasks(db = supabase) {
    // CRM_UNIFY_V1 — с исполнителем (чья задача); порядок и предел — loadTaskRows.
    const res = await loadTaskRows(db, { who: 'all', columns: 'id, request_id, text, due_at, assignee_id, done_at, users(full_name)' });
    // Роль без права на задачи (врач видит доску, но не задачи) — просто без меток.
    return res.error ? [] : res.rows;
}

const TEXT_MAX = 500;

/**
 * Блок «Задачи» в окне сохранённой заявки.
 *
 * @param {object} o
 * @param {object} o.request     строка заявки (нужны id и assigned_to/users)
 * @param {{id:number, full_name:string}|null} o.me
 * @param {boolean} o.isAdmin    удалять задачи может только администратор
 * @param {() => void} [o.onChange]  после любой правки (обновить бейдж меню)
 *
 * CRM_UNIFY_V1 — КОГО МОЖНО НАЗНАЧИТЬ, РЕШАЕТ СЕРВЕР (Р17): RPC
 * crm_task_assignees отдаёт тех, кто может вести эту карточку (активен, ведёт
 * заявки, видит карточку). Браузер чужих прав не знает, поэтому своего списка
 * не собирает. По умолчанию — оператор карточки, если он в ответе сервера; у
 * ничьей карточки выбор обязателен, «себе» по умолчанию нет. Список не
 * загрузился — поле заперто и говорит об этом: задача с угаданным
 * ответственным не уходит.
 */
export function crmTasksBlock({ request, me, isAdmin, onChange } = {}) {
    const root = h('div', { class: 'crm-tasks', 'data-crm-tasks': '' });
    const list = h('div', { class: 'crm-task-list' },
        h('div', { class: 'muted', style: { fontSize: '12.5px' } }, 'Загружаем…'));
    let tasks = [];
    // CRM_UNIFY_V1 — people: кого можно выбрать (только ответ сервера);
    // known: «я» и оператор карточки — лишь подписи к уже стоящим задачам.
    let people = [];
    let peopleState = 'loading';   // 'loading' | 'ready' | 'failed'
    const known = basePeople(request, me);
    const nameOf = (id) => {
        const p = people.find((x) => String(x.id) === String(id)) || known.find((x) => String(x.id) === String(id));
        return p ? p.full_name : '';
    };
    const changed = () => { try { if (onChange) onChange(); } catch (e) { /* бейдж — подсказка */ } };
    // CRM_TASK_EDIT_V1 — id задачи, которая сейчас правится на месте (null — никакая).
    let editingId = null;

    function paintList() {
        clear(list);
        if (!tasks.length) {
            list.appendChild(h('div', { class: 'muted', 'data-crm-tasks-empty': '', style: { fontSize: '12.5px' } }, 'Задач пока нет.'));
            return;
        }
        const now = nowIso();
        for (const t of tasks) {
            if (String(t.id) === String(editingId) && !t.done_at) { list.appendChild(editRow(t)); continue; }   // CRM_TASK_EDIT_V1
            const late = isOverdue(t, now);
            const done = !!t.done_at;
            // CRM_CARD_TASK_DONE_V1 (2026-11-14, владелец со снимком задач карточки:
            // «the same here, but done button and make attractive and compact») —
            // как в виде «Задачи» (crm-tasks-view.js CRM_TASKS_FILTER_V1): задача
            // ОДНОЙ строкой — текст · срок (красный у просроченной) · исполнитель ·
            // «Готово». Сделанная — зачёркнута, и вместо «Готово» тихое «Вернуть»:
            // отметку по-прежнему можно снять (toggleDone).
            const doneBtn = done
                ? h('button', { type: 'button', class: 'crm-task-undo', 'aria-label': 'Вернуть в работу', 'data-task-done': String(t.id),
                    onclick: (e) => { e.currentTarget.disabled = true; toggleDone(t, false); } }, 'Вернуть')
                : h('button', { type: 'button', class: 'crm-task-done-btn', 'aria-label': 'Сделано', 'data-task-done': String(t.id),
                    onclick: (e) => { e.currentTarget.disabled = true; toggleDone(t, true); } }, Icon('Check', { size: 13 }), h('span', null, 'Готово'));
            const who = t.assignee_id != null ? (nameOf(t.assignee_id) || trf('Сотрудник №{id}', { id: t.assignee_id })) : '';
            list.appendChild(h('div', {
                class: 'crm-task' + (late ? ' crm-task-overdue' : '') + (done ? ' crm-task-done' : ''),
                'data-task': String(t.id),
            },
                done ? h('span', { class: 'crm-task-ok' }, Icon('Check', { size: 13 })) : null,
                // CRM_CARD_TASK_FIT_V1 (владелец со снимком карточки, где «Готово»
                // уехала за край: «can you correct it») — карточка заявки узкая,
                // и одна строка «текст · срок · исполнитель · Готово» не влезала.
                // Теперь текст и под ним срок с исполнителем — одним блоком
                // слева, кнопки — справа, и ничто не выходит за карточку.
                h('div', { class: 'crm-task-body' },
                    h('div', { class: 'crm-task-text', title: t.text }, t.text),
                    h('div', { class: 'crm-task-meta' },
                        // «Просрочено» — словом в самом сроке, а не одним цветом:
                        // красный не все различают.
                        h('span', { class: 'crm-task-due' + (late ? ' is-late' : '') },
                            Icon('Clock', { size: 12 }), ' ', late ? h('b', null, 'Просрочено') : null, late ? ' · ' : '',
                            t.due_at ? fmtDateTime(t.due_at) : 'Без срока'),
                        who ? h('span', { class: 'crm-task-who' }, Icon('User', { size: 12 }), ' ', who) : null)),
                doneBtn,
                // CRM_TASK_EDIT_V1 (2026-11-14, владелец со снимком задачи карточки: «add edit
                // button») — карандаш у открытой задачи: текст, срок и ответственный правятся
                // на месте, в строке. Сделанную не правят — её сначала «Вернуть».
                done ? null : h('button', {
                    class: 'btn btn-ghost btn-sm', type: 'button', title: 'Изменить задачу', 'aria-label': 'Изменить задачу', 'data-task-edit': String(t.id),
                    onclick: () => { editingId = t.id; paintList(); },
                }, Icon('Edit', { size: 13 })),
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

    // CRM_TASK_EDIT_V1 — строка задачи в режиме правки: те же поля, что у формы новой
    // задачи, с её нынешними значениями. Правила те же: текст и дата обязательны,
    // ответственный — только из ответа сервера (crm_task_assignees). Список не
    // загрузился — ответственный не меняется, правятся текст и срок.
    function editRow(t) {
        const pad = (n) => String(n).padStart(2, '0');
        const d = t.due_at ? new Date(t.due_at) : null;
        const ok = d && !Number.isNaN(d.getTime());
        const txt = h('input', { type: 'text', maxlength: String(TEXT_MAX), value: t.text || '', 'aria-label': 'Задача', 'data-task-edit-text': '' });
        const date = h('input', { type: 'date', 'aria-label': 'Дата', 'data-task-edit-date': '',
            value: ok ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` : '' });
        const time = h('input', { type: 'time', 'aria-label': 'Время', 'data-task-edit-time': '',
            value: ok ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : DEFAULT_DUE_TIME });
        const who = h('select', { 'aria-label': 'Ответственный', 'data-task-edit-who': '' });
        who.appendChild(h('option', { value: '' }, '— выберите ответственного —'));
        for (const p of people) who.appendChild(h('option', { value: String(p.id) }, p.full_name || trf('Сотрудник №{id}', { id: p.id })));
        // Нынешний ответственный, которого нет в ответе сервера, остаётся видимым: иначе
        // поле показало бы «— выберите —», и сохранение молча сняло бы его.
        if (t.assignee_id != null && !people.some((p) => String(p.id) === String(t.assignee_id))) {
            who.appendChild(h('option', { value: String(t.assignee_id) }, nameOf(t.assignee_id) || trf('Сотрудник №{id}', { id: t.assignee_id })));
        }
        who.value = t.assignee_id != null ? String(t.assignee_id) : '';
        who.disabled = peopleState !== 'ready';
        const save = h('button', { class: 'btn btn-sm btn-primary', type: 'button', 'data-task-edit-save': '' }, Icon('Check', { size: 13 }), ' ', 'Сохранить');
        const cancel = h('button', { class: 'btn btn-sm btn-ghost', type: 'button', 'data-task-edit-cancel': '',
            onclick: () => { editingId = null; paintList(); } }, 'Отмена');
        save.addEventListener('click', async () => {
            const text = txt.value.trim();
            if (!text) { toast('Напишите, что нужно сделать.', 'fail'); return; }
            const due = localDueIso(date.value, time.value);
            if (!due) { toast('Укажите дату задачи.', 'fail'); return; }
            const values = { text: text.slice(0, TEXT_MAX), due_at: due };
            if (peopleState === 'ready') {
                if (!who.value) { toast('Выберите ответственного.', 'fail'); return; }
                // Сменить можно только на предложенного сервером; прежний остаётся как был.
                if (String(who.value) !== String(t.assignee_id ?? '')) {
                    if (!people.some((p) => String(p.id) === String(who.value))) { toast('Выберите ответственного.', 'fail'); return; }
                    values.assignee_id = Number(who.value);
                }
            }
            save.disabled = true;
            const { error } = await supabase.from('crm_tasks').update(values).eq('id', t.id);
            if (error) { toast(error.message, 'fail'); save.disabled = false; return; }
            editingId = null;
            await reload();
            changed();
        });
        return h('div', { class: 'crm-task crm-task-editing', 'data-task': String(t.id), 'data-task-editing': '' },
            h('div', { class: 'crm-task-form crm-task-edit-form' }, txt, date, time, who, save, cancel));
    }

    async function toggleDone(t, on) {
        // done_by ставит сервер по сессии (реестр stamps) — экран его не шлёт.
        const values = { done_at: on ? nowIso() : null };
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
    const timeInp = h('input', { type: 'time', 'aria-label': 'Время', value: DEFAULT_DUE_TIME, 'data-task-time': '' });
    const whoSel = h('select', { 'aria-label': 'Ответственный', 'data-task-who': '' });
    // CRM_UNIFY_V1 — по умолчанию оператор карточки (если сервер его предлагает);
    // у ничьей карточки — никто: «себе» по умолчанию больше нет.
    const defaultWho = () => String((request && request.assigned_to) || '');
    let whoTouched = false;
    whoSel.addEventListener('change', () => { whoTouched = true; });
    // CRM_UNIFY_V1 — список не загрузился: сообщение у поля, поле заперто.
    const whoError = h('div', { class: 'muted crm-task-who-error', 'data-task-who-error': '', style: { fontSize: '12.5px', display: 'none' } },
        Icon('Warning', { size: 12 }), ' ', 'Список ответственных не загрузился — задачу сейчас не поставить. Закройте карточку и откройте её снова.');
    function fillWho() {
        const keep = whoTouched ? whoSel.value : defaultWho();
        clear(whoSel);
        whoSel.appendChild(h('option', { value: '' }, '— выберите ответственного —'));
        for (const p of people) whoSel.appendChild(h('option', { value: String(p.id) }, p.full_name || trf('Сотрудник №{id}', { id: p.id })));
        whoSel.value = people.some((p) => String(p.id) === keep) ? keep : '';
        whoSel.disabled = peopleState === 'failed';
        whoError.style.display = peopleState === 'failed' ? '' : 'none';
    }
    fillWho();
    // CRM_UNIFY_V1 — кого можно назначить, решает сервер (Р17).
    const assigneesFailed = () => { peopleState = 'failed'; people = []; fillWho(); };
    Promise.resolve()
        .then(() => supabase.rpc('crm_task_assignees', { request_id: request.id }))
        .then(({ data, error }) => {
            if (error || !Array.isArray(data)) { assigneesFailed(); return; }
            people = data.map((p) => ({ id: p.id, full_name: p.full_name }));
            peopleState = 'ready';
            fillWho();
            paintList();
        })
        .catch(assigneesFailed);

    const addBtn = h('button', { class: 'btn btn-sm btn-primary', type: 'button', 'data-task-add': '' }, Icon('Plus', { size: 13 }), ' ', 'Добавить задачу');
    addBtn.addEventListener('click', async () => {
        const text = textInp.value.trim();
        if (!text) { toast('Напишите, что нужно сделать.', 'fail'); return; }
        const due = localDueIso(dateInp.value, timeInp.value);
        if (!due) { toast('Укажите дату задачи.', 'fail'); return; }
        // CRM_UNIFY_V1 — ответственный обязателен и только из ответа сервера.
        if (peopleState === 'failed') { toast('Список ответственных не загрузился — задачу сейчас не поставить. Закройте карточку и откройте её снова.', 'fail'); return; }
        if (!whoSel.value || !people.some((p) => String(p.id) === String(whoSel.value))) { toast('Выберите ответственного.', 'fail'); return; }
        addBtn.disabled = true;
        try {
            const { error } = await supabase.from('crm_tasks').insert({
                request_id: request.id, text: text.slice(0, TEXT_MAX), due_at: due,
                assignee_id: Number(whoSel.value),   // CRM_UNIFY_V1 — выбран из ответа сервера
                // created_by ставит сервер по сессии (реестр stamps).
            });
            if (error) { toast(error.message, 'fail'); return; }
            textInp.value = '';
            await reload();
            changed();
        } finally { addBtn.disabled = false; }
    });

    root.appendChild(list);
    root.appendChild(h('div', { class: 'crm-task-form' }, textInp, dateInp, timeInp, whoSel, addBtn));
    root.appendChild(whoError);   // CRM_UNIFY_V1
    reload();
    return root;
}

/** «Я» и оператор заявки — подписи к задачам. CRM_UNIFY_V1: выбрать их можно, только если их предлагает сервер. */
function basePeople(request, me) {
    const out = [];
    if (me && me.id != null) out.push({ id: me.id, full_name: me.full_name || tr('Я') });
    const op = request && request.assigned_to;
    if (op != null && !out.some((p) => String(p.id) === String(op))) {
        out.push({ id: op, full_name: (request.users && request.users.full_name) || '' });
    }
    return out;
}
