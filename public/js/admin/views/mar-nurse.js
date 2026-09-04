// MAR_NURSE_V1 — РАБОЧЕЕ МЕСТО МЕДСЕСТРЫ: задачи листа назначений (Задача 5
// плана docs/plans/2026-09-04-inpatient-workflow.md).
//
// ─── ПАЦИЕНТ — ЯКОРЬ, А НЕ ФИЛЬТР ───────────────────────────────────────────
//
// «Ошибка "не тот пациент" — то, против чего построен экран медсестры» (раздел
// «Ловушки» плана). Отсюда раскладка: СЛЕВА ЛЮДИ, справа задачи выбранного
// человека. Плоский список задач по отделению — «10:00 Цефтриаксон, 10:00
// Омепразол, 10:00 Цефтриаксон» — заставляет читать имя КАЖДОЙ строки и
// прощает пропуск ровно один раз. Список людей заставляет выбрать человека
// один раз и дальше работать внутри него.
//
// ─── ЧЕТЫРЕ ГРУППЫ, А НЕ ОДНА ОЧЕРЕДЬ ───────────────────────────────────────
//
// Просрочено / Сейчас / Позже / По требованию — группы считает СЕРВЕР
// (treatment_tasks_due), и «задержано» он кладёт в «Сейчас», а не в
// «Просрочено»: доза, опоздавшая на двадцать минут, — работа, которую надо
// сделать немедленно, а «Просрочено» — список, по которому потом объясняются.
// Пересчитывать это в браузере нельзя: тогда экран и сервер разошлись бы в том,
// что значит «пора».
//
// ─── ОТКАЗ И ПРОПУСК — ПЕРВОГО КЛАССА ───────────────────────────────────────
//
// Худшая дыра референса: там доза либо «дана», либо не отмечена никак. Не
// введённая доза выглядит там ровно как забытая, и лист врача не отличает
// «пациент отказался» от «медсестра не дошла». Здесь у кнопки «Выполнить»
// ЕСТЬ ПАРА — «Не введено», и она требует выбрать, что случилось (отказ /
// придержано / пропущено) и написать причину. Сервер требует причину второй
// раз, независимо от этого экрана.
//
// ─── «5 ПРАВ» ───────────────────────────────────────────────────────────────
//
// Подтверждение показывает пять вещей крупно — пациент, препарат, доза, путь
// введения, время — и красный баннер аллергии, если она записана в карте.
// Это не форма: это то, что медсестра обязана сверить вслух у койки, и экран
// обязан показать ей ровно эти пять строк, а не пятнадцать полей.

import { supabase } from '../../supabase.js';
import { h, Icon, Tag, clear, toast, field, PageHead, initials } from '../ui.js';
import { tr, trf } from '../i18n.js';   // I18N_COVERAGE_V1 — перевод СНАЧАЛА, подстановка ПОТОМ
import { isModuleAllowed } from '../permissions.js';
import { inpatientModal } from './admission-modal.js?v=inp5';
import { todayLocal } from './mar-sheet.js?v=inp5';

export function canOpenMarNurse() {
    return isModuleAllowed('mar-nurse');
}

// ─── Справочники экрана ─────────────────────────────────────────────────────

// Порядок групп — порядок работы смены, а не алфавит.
export const MAR_TASK_GROUPS = [
    ['overdue', 'Просрочено'],
    ['now', 'Сейчас'],
    ['later', 'Позже'],
    ['prn', 'По требованию'],
];

// Три способа НЕ ввести дозу. Причина обязательна у всех трёх: строка «не
// введено» без причины отвечает на вопрос «что случилось?» словом «ничего».
export const OMISSION_OPTIONS = [
    ['refused', 'Отказ пациента'],
    ['held', 'Придержано'],
    ['missed', 'Пропущено'],
];

// Дополнительный расход у койки: разбитая ампула и то, что ушло сверх дозы.
// Помнит об этом ровно тот человек, который стоит у койки, и ровно в эту
// минуту — поэтому спрашивается здесь, а не потом на складе.
//
// РАЗНИЦА МЕЖДУ ДВУМЯ РОДАМИ — ЭТО ДЕНЬГИ, а не слово. Обе строки списываются
// со склада (MED_ADMIN_CHARGE_V1, rpc/treatment-orders.js), но разбитую
// медсестрой ампулу клиника не выставляет больному — это её убыток, а не его
// счёт, — а перерасход выставляет, как всякий расходник. Сервер понимает это
// признаком `billable`, и здесь он и проставляется.
export const EXTRA_KINDS = [['waste', 'Брак'], ['overuse', 'Перерасход']];

const GROUP_LABEL = Object.fromEntries(MAR_TASK_GROUPS);
const GROUP_TONE = { overdue: 'crit', now: 'warn', later: '', prn: 'info' };

export function groupLabel(key) { return GROUP_LABEL[key] || ''; }

// ─── Чистые правила ─────────────────────────────────────────────────────────

/**
 * Люди из плоского ответа сервера. Одна строка на госпитализацию, со счётом по
 * каждой группе — «просрочено: 2» на карточке пациента и есть весь смысл этого
 * списка: медсестра сначала выбирает, к кому идти, и только потом — что нести.
 *
 * Порядок: сперва те, у кого просрочено, потом те, у кого есть «сейчас», потом
 * по имени. Сортировка по палате была бы удобнее ногам и хуже пациенту.
 */
export function patientsFromTasks(due) {
    const groups = (due && due.groups) || {};
    const byAdmission = new Map();
    for (const [key] of MAR_TASK_GROUPS) {
        for (const t of (groups[key] || [])) {
            const id = Number(t.admission_id);
            if (!byAdmission.has(id)) {
                byAdmission.set(id, {
                    admission_id: id,
                    patient_id: t.patient_id,
                    patient_name: t.patient_name || '',
                    ward_id: t.ward_id, ward_name: t.ward_name || '',
                    bed_id: t.bed_id, bed_code: t.bed_code || '',
                    counts: { overdue: 0, now: 0, later: 0, prn: 0 },
                    total: 0,
                });
            }
            const row = byAdmission.get(id);
            row.counts[key] += 1;
            row.total += 1;
        }
    }
    return [...byAdmission.values()].sort((a, b) =>
        (b.counts.overdue - a.counts.overdue)
        || (b.counts.now - a.counts.now)
        || String(a.patient_name).localeCompare(String(b.patient_name)));
}

/** Задачи одного пациента, по тем же четырём группам. */
export function tasksForAdmission(due, admissionId) {
    const groups = (due && due.groups) || {};
    const out = {};
    for (const [key] of MAR_TASK_GROUPS) {
        out[key] = (groups[key] || []).filter((t) => Number(t.admission_id) === Number(admissionId));
    }
    return out;
}

/** Койка и палата одной строкой — то, что называют вслух вместе с именем. */
export function bedLine(row) {
    const r = row || {};
    return [
        r.ward_name || null,
        r.bed_code ? trf('койка {code}', { code: r.bed_code }) : null,
    ].filter(Boolean).join(' · ');
}

/**
 * ПЯТЬ ПРАВ. Порядок закреплён и проверяется тестом: пациент — препарат — доза
 * — путь введения — время. Переставь их, и сверка перестанет быть сверкой:
 * читают её сверху вниз, вслух, у койки.
 */
export function fiveRights(task, patient) {
    const t = task || {};
    const p = patient || {};
    return [
        { key: 'patient', label: 'Пациент', value: [t.patient_name || p.patient_name || '', bedLine(t.bed_code ? t : p)].filter(Boolean).join(' · ') },
        { key: 'drug', label: 'Препарат', value: t.name || '' },
        { key: 'dose', label: 'Доза', value: t.dose || '—' },
        { key: 'route', label: 'Путь введения', value: t.route || '—' },
        { key: 'time', label: 'Время', value: t.due_at || (t.date ? trf('{date} · по требованию', { date: t.date }) : '') },
    ];
}

/** Аллергия пациента — из его карты (patients.allergies), а не из назначения. */
export function allergyOf(allergyMap, patientId) {
    if (!patientId) return '';
    const v = allergyMap instanceof Map ? allergyMap.get(Number(patientId)) : (allergyMap || {})[patientId];
    return typeof v === 'string' ? v.trim() : '';
}

/**
 * Строки дополнительного расхода → ровно та форма, которую читает сервер
 * (parseExtraConsumption в rpc/treatment-orders.js): МАССИВ позиций склада
 * `{ product_id, qty, billable, name }`. Всё, что не разбирается в позицию с
 * количеством, сервер записывает текстом и честно предупреждает, что списать
 * это сможет только человек, — поэтому форму держим его, а не свою.
 *
 * ПОЗИЦИЯ СКЛАДА БЕРЁТСЯ У НАЗНАЧЕНИЯ (`stock_item_id`), и это не упрощение:
 * у койки бьётся ампула ТОГО ЖЕ препарата, который вводят, и перерасход — это
 * тоже он. Выбор чужой позиции (второй шприц, ещё флакон физраствора) — работа
 * склада, а не медсестры с планшетом в руках; назначения без позиции склада
 * поэтому просто не показывают этот блок, вместо того чтобы предлагать выбор,
 * которого здесь всё равно не сделать.
 */
export function extraPayload(rows, productId) {
    const pid = Number(productId);
    if (!Number.isFinite(pid) || pid <= 0) return null;
    const items = (rows || [])
        .map((r) => ({ kind: r.kind, qty: Number(r.qty), note: String(r.note || '').trim() }))
        .filter((r) => EXTRA_KINDS.some(([k]) => k === r.kind) && Number.isFinite(r.qty) && r.qty > 0)
        .map((r) => ({
            product_id: pid,
            qty: r.qty,
            // Брак не выставляется пациенту, перерасход выставляется.
            billable: r.kind !== 'waste',
            name: r.note || tr(EXTRA_KINDS.find(([k]) => k === r.kind)[1]),
        }));
    return items.length ? items : null;
}

// ─── Диалоги ────────────────────────────────────────────────────────────────

function anchorBig(name, sub) {
    return h('div', {
        style: {
            display: 'flex', alignItems: 'center', gap: '12px', padding: '13px 15px',
            background: 'var(--primary-25, #f2faf8)', border: '1px solid var(--primary-100, #d7efe9)',
            borderRadius: '11px',
        },
    },
        h('span', {
            style: {
                width: '44px', height: '44px', borderRadius: '999px', flex: '0 0 44px',
                background: 'var(--primary-600, #1f7a72)', color: '#fff',
                display: 'grid', placeItems: 'center', fontWeight: 700, fontSize: '15px',
            },
        }, initials(name || '?')),
        h('div', { style: { minWidth: 0 } },
            h('div', { style: { fontSize: '20px', fontWeight: 800, color: 'var(--ink-900)', lineHeight: 1.2 } }, name || '—'),
            sub ? h('div', { class: 'muted', style: { fontSize: '13.5px', marginTop: '2px' } }, sub) : null),
    );
}

/**
 * Красный баннер аллергии. Он НЕ прячется под «подробнее» и не серый: это
 * последнее место, где неверный препарат ещё можно не ввести.
 */
export function allergyBanner(text) {
    if (!text) return null;
    return h('div', {
        style: {
            display: 'flex', gap: '9px', alignItems: 'flex-start', padding: '11px 13px',
            background: 'rgba(179,38,30,.10)', border: '1px solid rgba(179,38,30,.35)',
            borderRadius: '11px', color: '#8c1d18',
        },
    },
        Icon('Warning', { size: 16 }),
        h('div', null,
            h('div', { style: { fontSize: '15px', fontWeight: 800 } }, tr('Аллергия')),
            h('div', { style: { fontSize: '13.5px', marginTop: '2px' } }, text)));
}

function rightsBlock(task, patient) {
    const box = h('div', { style: { display: 'grid', gap: '7px' } });
    for (const r of fiveRights(task, patient)) {
        box.appendChild(h('div', {
            style: { display: 'flex', justifyContent: 'space-between', gap: '14px', alignItems: 'baseline' },
        },
            h('span', { class: 'muted', style: { fontSize: '13.5px' } }, tr(r.label)),
            h('span', { style: { fontSize: '17px', fontWeight: 700, textAlign: 'right' } }, r.value || '—')));
    }
    return box;
}

function extraBox(task) {
    const productId = task && task.stock_item_id ? Number(task.stock_item_id) : null;
    // Списывать нечего и некуда: у назначения нет позиции склада. Пустая форма
    // здесь была бы обещанием, которого сервер не выполнит.
    if (!productId) {
        return {
            el: h('div', { class: 'muted', style: { fontSize: '12.5px' } },
                tr('Дополнительный расход не записывается: у назначения не указана позиция склада.')),
            read: () => null,
        };
    }
    const rows = [];
    const list = h('div', { style: { display: 'grid', gap: '8px' } });
    const add = () => {
        const kindSel = h('select', null, ...EXTRA_KINDS.map(([v, l]) => h('option', { value: v }, tr(l))));
        const qtyInp = h('input', { type: 'number', min: '0', step: '0.01', placeholder: '1' });
        const noteInp = h('input', { type: 'text', placeholder: tr('Что случилось') });
        rows.push({ kindSel, qtyInp, noteInp });
        list.appendChild(h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
            h('div', { style: { flex: '1 1 120px' } }, kindSel),
            h('div', { style: { flex: '1 1 80px' } }, qtyInp),
            h('div', { style: { flex: '2 1 160px' } }, noteInp)));
    };
    const box = h('details', null,
        h('summary', { style: { fontSize: '13.5px', cursor: 'pointer' } },
            tr('Дополнительный расход (брак / перерасход)')),
        list,
        h('button', { class: 'btn btn-sm', type: 'button', style: { marginTop: '8px' }, onclick: add },
            Icon('Plus', { size: 13 }), ' ', tr('Строка расхода')));
    add();
    return {
        el: box,
        read: () => extraPayload(rows.map((r) => ({ kind: r.kindSel.value, qty: r.qtyInp.value, note: r.noteInp.value })), productId),
    };
}

function markArgs(task, status, extra) {
    const args = { order_id: task.order_id, date: task.date, status };
    // PRN отмечается БЕЗ слота: плановых точек у него нет, и сервер откажет,
    // если час всё-таки прислать.
    if (task.prn !== 1 && task.prn !== true && task.slot !== undefined && task.slot !== null) args.slot = task.slot;
    if (extra) args.extra = extra;
    return args;
}

/** «Выполнить» — подтверждение «5 прав». */
export function openGiveModal({ task, patient, allergy = '', onDone } = {}) {
    if (!task || !task.order_id) { toast(tr('Задача не найдена.'), 'fail'); return; }
    const noteInp = h('input', { type: 'text', placeholder: tr('Примечание (необязательно)') });
    const extra = extraBox(task);

    inpatientModal(tr('Подтвердите введение'), 'Check', [
        anchorBig(task.patient_name || (patient && patient.patient_name) || '', bedLine(task)),
        allergyBanner(allergy),
        h('div', { class: 'card', style: { padding: '13px 15px' } }, rightsBlock(task, patient)),
        field(tr('Примечание'), noteInp),
        extra.el,
        h('div', { class: 'muted', style: { fontSize: '12.5px' } },
            tr('Сверьте вслух пять пунктов выше. Отметка встанет в лист назначений с вашим именем и временем.')),
    ], tr('Подтвердить введение'), async () => {
        const args = markArgs(task, 'given', extra.read());
        args.note = noteInp.value.trim();
        const { data, error } = await supabase.rpc('treatment_admin_mark', args);
        if (error) { toast((error.message) || tr('Не удалось отметить введение.'), 'fail'); return false; }
        // MED_ADMIN_CHARGE_V1 — отметка «дала» списывает препарат и начисляет
        // за него (Задача 6), и склад отвечает ПРЕДУПРЕЖДЕНИЕМ, а не отказом:
        // медицинская запись не отменяется из-за пустого остатка. Молчать об
        // этом нельзя — «не списано» узнают потом на инвентаризации, а сказать
        // об этом надо тому, кто стоит у койки.
        const warn = (data && Array.isArray(data.warnings) ? data.warnings : []).find((w) => w && w.message);
        toast(warn ? warn.message : tr('Доза отмечена как введённая.'), warn ? 'info' : 'ok');
        if (onDone) await onDone();
        return true;
    }, { width: 560 });
}

/**
 * «Не введено» — отказ, придержано, пропущено. ПРИЧИНА ОБЯЗАТЕЛЬНА, и запрос без
 * неё вообще не уходит: сервер откажет («Отказ, пропуск и задержку дозы
 * записывают только с причиной»), но человеку это должно сказать окно, а не
 * красная плашка после ожидания.
 */
export function openOmitModal({ task, patient, allergy = '', onDone } = {}) {
    if (!task || !task.order_id) { toast(tr('Задача не найдена.'), 'fail'); return; }
    const statusSel = h('select', null, ...OMISSION_OPTIONS.map(([v, l]) => h('option', { value: v }, tr(l))));
    const reasonInp = h('input', { type: 'text', placeholder: tr('Например: пациент отказался, тошнота') });
    const noteInp = h('input', { type: 'text', placeholder: tr('Примечание (необязательно)') });
    const extra = extraBox(task);

    inpatientModal(tr('Доза не введена'), 'Warning', [
        anchorBig(task.patient_name || (patient && patient.patient_name) || '', bedLine(task)),
        allergyBanner(allergy),
        h('div', { class: 'card', style: { padding: '13px 15px' } }, rightsBlock(task, patient)),
        field(tr('Что произошло'), statusSel, { required: true }),
        field(tr('Причина'), reasonInp, { required: true }),
        field(tr('Примечание'), noteInp),
        extra.el,
        h('div', { class: 'muted', style: { fontSize: '12.5px' } },
            tr('Не введённая доза остаётся на листе врача отдельным знаком — не пустой клеткой.')),
    ], tr('Записать'), async () => {
        const reason = reasonInp.value.trim();
        if (!reason) { toast(tr('Укажите причину: без неё доза не записывается.'), 'fail'); return false; }
        const args = markArgs(task, statusSel.value, extra.read());
        args.reason = reason;
        args.note = noteInp.value.trim();
        const { error } = await supabase.rpc('treatment_admin_mark', args);
        if (error) { toast((error.message) || tr('Не удалось записать.'), 'fail'); return false; }
        toast(tr('Записано: доза не введена.'), 'ok');
        if (onDone) await onDone();
        return true;
    }, { width: 560 });
}

// ─── Экран ──────────────────────────────────────────────────────────────────

export async function renderMarNurse(root, ctx = {}) {
    const state = {
        date: todayLocal(), wardId: '', wards: [],
        due: null, allergies: new Map(), selected: null,
    };

    const wrap = h('div', { class: 'fade-in' });
    root.appendChild(wrap);

    const wardSel = h('select', { class: 'input' }, h('option', { value: '' }, tr('Все отделения')));
    const headBox = h('div');
    const body = h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(240px, 320px) 1fr', gap: '16px', alignItems: 'start' } });
    wrap.appendChild(headBox);
    wrap.appendChild(body);

    headBox.appendChild(PageHead({
        title: 'Задачи медсестры',
        subtitle: 'Кому и что вводить сейчас: пациент, доза, время — и что делать, если доза не введена',
        right: [
            h('label', { class: 'field', style: { margin: 0 } },
                h('span', { class: 'field-label' }, tr('Отделение')), wardSel),
            h('button', { class: 'btn btn-sm', type: 'button', onclick: () => load() },
                Icon('Refresh', { size: 13 }), ' ', tr('Обновить')),
        ],
    }));

    async function loadWards() {
        const { data } = await supabase.from('wards').select('id, name').order('name');
        state.wards = Array.isArray(data) ? data : [];
        for (const w of state.wards) wardSel.appendChild(h('option', { value: String(w.id) }, w.name || ''));
    }

    // Аллергии берутся ОДНИМ запросом на всех, кого показываем, а не по одному
    // при открытии окна: баннер обязан быть уже на экране в момент, когда
    // медсестра нажала «Выполнить», а не догрузиться через полсекунды после.
    async function loadAllergies(patientIds) {
        state.allergies = new Map();
        const ids = [...new Set(patientIds.filter(Boolean).map(Number))];
        if (!ids.length) return;
        try {
            const { data } = await supabase.from('patients').select('id, allergies').in('id', ids);
            for (const p of (data || [])) state.allergies.set(Number(p.id), p.allergies || '');
        } catch (e) { /* без карты аллергий экран работает, но баннера не будет */ }
    }

    async function load() {
        clear(body);
        body.appendChild(h('div', { class: 'muted', style: { padding: '18px', fontSize: '13.5px' } }, tr('Загрузка…')));
        const args = { date: state.date };
        if (state.wardId) args.ward_id = Number(state.wardId);
        const { data, error } = await supabase.rpc('treatment_tasks_due', args);
        if (error || !data) {
            clear(body);
            body.appendChild(h('div', { class: 'card', style: { padding: '18px' } },
                h('div', { class: 'empty' }, trf('Не удалось загрузить задачи: {msg}',
                    { msg: (error && error.message) || tr('нет данных') }))));
            state.due = null;
            return;
        }
        state.due = data;
        const people = patientsFromTasks(data);
        await loadAllergies(people.map((p) => p.patient_id));
        if (!people.some((p) => p.admission_id === state.selected)) {
            state.selected = people.length ? people[0].admission_id : null;
        }
        paint(people);
    }

    function paint(people) {
        clear(body);
        body.appendChild(peopleCard(people));
        body.appendChild(tasksCard(people));
    }

    function peopleCard(people) {
        const card = h('div', { class: 'card' },
            h('div', { class: 'card-header' },
                h('h3', null, Icon('Patients', { size: 16 }), ' ', tr('Пациенты')),
                h('span', { style: { flex: 1 } }),
                h('span', { class: 'muted', style: { fontSize: '12.5px' } }, trf('пациентов: {n}', { n: people.length }))));
        if (!people.length) {
            card.appendChild(h('div', { class: 'empty', style: { padding: '26px' } }, tr('Задач на смену нет.')));
            return card;
        }
        for (const p of people) {
            const active = p.admission_id === state.selected;
            card.appendChild(h('button', {
                type: 'button',
                style: {
                    display: 'flex', alignItems: 'center', gap: '11px', width: '100%', textAlign: 'left',
                    padding: '12px 14px', border: '0', borderBottom: '1px solid var(--ink-100)',
                    background: active ? 'var(--primary-25, #f2faf8)' : 'transparent',
                    cursor: 'pointer', font: 'inherit',
                },
                onclick: () => { state.selected = p.admission_id; paint(people); },
            },
                h('span', {
                    style: {
                        width: '38px', height: '38px', borderRadius: '999px', flex: '0 0 38px',
                        background: 'var(--primary-600, #1f7a72)', color: '#fff',
                        display: 'grid', placeItems: 'center', fontWeight: 700, fontSize: '15px',
                    },
                }, initials(p.patient_name || '?')),
                h('span', { style: { flex: 1, minWidth: 0 } },
                    // ИМЯ — САМОЕ КРУПНОЕ НА СТРОКЕ (то же правило, что в окне
                    // «Стационар»): это защита от «не того пациента».
                    h('span', { style: { display: 'block', fontSize: '17px', fontWeight: 800, color: 'var(--ink-900)' } },
                        p.patient_name || tr('без имени')),
                    h('span', { class: 'muted', style: { display: 'block', fontSize: '12.5px' } }, bedLine(p))),
                p.counts.overdue
                    ? Tag(trf('просрочено: {n}', { n: p.counts.overdue }), { kind: 'crit', dot: true })
                    : Tag(trf('задач: {n}', { n: p.total }))));
        }
        return card;
    }

    function tasksCard(people) {
        const box = h('div', { style: { display: 'grid', gap: '14px' } });
        const p = people.find((x) => x.admission_id === state.selected);
        if (!p) {
            box.appendChild(h('div', { class: 'card' },
                h('div', { class: 'empty', style: { padding: '26px' } }, tr('Выберите пациента слева.'))));
            return box;
        }
        const allergy = allergyOf(state.allergies, p.patient_id);
        box.appendChild(h('div', { class: 'card', style: { padding: '14px 16px', display: 'grid', gap: '10px' } },
            anchorBig(p.patient_name, bedLine(p)),
            allergyBanner(allergy),
            h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
                h('button', {
                    class: 'btn btn-sm', type: 'button',
                    onclick: () => ctx.onNavigate && ctx.onNavigate('mar-sheet', { sub: String(p.admission_id) }),
                }, Icon('Doc', { size: 13 }), ' ', tr('Лист назначений')))));

        const tasks = tasksForAdmission(state.due, p.admission_id);
        for (const [key, label] of MAR_TASK_GROUPS) {
            const list = tasks[key] || [];
            const card = h('div', { class: 'card' },
                h('div', { class: 'card-header' },
                    h('h3', null, tr(label)),
                    h('span', { style: { flex: 1 } }),
                    Tag(trf('задач: {n}', { n: list.length }), { kind: list.length ? GROUP_TONE[key] : '', dot: !!list.length })));
            if (!list.length) {
                card.appendChild(h('div', { class: 'empty', style: { padding: '18px', fontSize: '13.5px' } }, tr('Пусто.')));
            } else {
                for (const t of list) card.appendChild(taskRow(t, p, allergy));
            }
            box.appendChild(card);
        }
        return box;
    }

    function taskRow(t, p, allergy) {
        const when = t.due_at
            ? String(t.due_at).slice(11)
            : (t.given_today ? trf('сегодня дано раз: {n}', { n: t.given_today }) : tr('по требованию'));
        return h('div', {
            style: {
                display: 'flex', alignItems: 'center', gap: '12px',
                padding: '12px 16px', borderTop: '1px solid var(--ink-100)', flexWrap: 'wrap',
            },
        },
            h('div', { style: { fontSize: '17px', fontWeight: 800, minWidth: '64px' } }, when),
            h('div', { style: { flex: 1, minWidth: '160px' } },
                h('div', { style: { fontSize: '15px', fontWeight: 700, color: 'var(--ink-900)' } }, t.name || ''),
                h('div', { class: 'muted', style: { fontSize: '12.5px' } },
                    [t.dose || null, t.route || null,
                        t.late_min ? trf('опоздание {n} мин', { n: t.late_min }) : null].filter(Boolean).join(' · '))),
            h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
                h('button', {
                    class: 'btn btn-primary btn-sm', type: 'button',
                    onclick: () => openGiveModal({ task: t, patient: p, allergy, onDone: load }),
                }, Icon('Check', { size: 13 }), ' ', tr('Выполнить')),
                h('button', {
                    class: 'btn btn-sm', type: 'button',
                    onclick: () => openOmitModal({ task: t, patient: p, allergy, onDone: load }),
                }, tr('Не введено'))));
    }

    wardSel.addEventListener('change', () => { state.wardId = wardSel.value; state.selected = null; load(); });

    await loadWards();
    await load();
    return { state, reload: load };
}
