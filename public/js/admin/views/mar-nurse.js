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
// ─── СВОЮ ОТМЕТКУ МОЖНО СНЯТЬ САМОЙ — ПЯТНАДЦАТЬ МИНУТ ──────────────────────
//
// Закрытая точка уходит из четырёх групп работы, и до сих пор уходила совсем:
// последняя отметка пациента убирала его из списка вместе с единственной
// дорогой к исправлению промаха. Поэтому здесь есть пятый список — «Сделано»,
// и в нём кнопка «Снять отметку».
//
// КОГДА ОНА ЕСТЬ, РЕШАЕТ СЕРВЕР (unmarkVerdict в rpc/treatment-orders.js) и
// присылает готовый ответ в `undo` каждой строки: своя отметка и не старше
// пятнадцати минут — кнопка; иначе — та же фраза, которой ответил бы сервер,
// прямо в строке. Повторить правило в браузере значило бы завести вторые часы
// и вторые права: экран показал бы кнопку там, где сервер откажет, — и
// медсестра узнала бы об отказе после нажатия, у койки.
//
// Причина обязательна и здесь, и снятие оставляет след (кто снял, когда,
// почему) — окно даёт СКОРОСТЬ, а не тишину.

// ─── ПИТАНИЕ — ЗДЕСЬ ЖЕ, НО НИЖЕ ЛЕКАРСТВ ───────────────────────────────────
//
// Приёмы пищи медсестра отмечает «как выдачу препарата» (Задача 7 плана), и
// отмечать их она должна ТАМ, ГДЕ УЖЕ РАБОТАЕТ. Отдельный экран «Питание»
// означал бы третий список тех же людей, в который она зайдёт в лучшем случае
// вечером и заполнит по памяти — то есть напишет неправду.
//
// Но полоса питания стоит НИЖЕ четырёх групп назначений и мельче их, и это не
// вкус: на этом экране безопасность — лекарства. Съеденный или несъеденный
// обед — важная запись; пропущенный антибиотик — вред пациенту. Как только
// питание получит здесь ту же величину, что доза, экран перестанет отвечать на
// вопрос «что сделать прямо сейчас» одним взглядом.
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
// MAR_OUTCOME_VISIBLE_V1 — знак, цвет и тон состояния берутся у ЛИСТА ВРАЧА, а
// не заводятся здесь заново: «отказ пациента» обязан выглядеть одинаково на
// обоих экранах одной смены (cellStateColor в views/mar-sheet.js).
import {
    todayLocal, hhmm, cellStateLabel, cellGlyph, cellStateColor, cellStateTone, VOIDED_GLYPH,
} from './mar-sheet.js?v=inp5';
// DIET_TABLES_V1 — названия приёмов пищи и отметок берутся у порционника: три
// копии одного списка разошлись бы молча, и «Полдник» здесь перестал бы быть
// «Полдником» на кухне.
import { mealTitle, mealStatusTitle, mealStatusTone, mealsTitle, MEAL_STATUS_OPTIONS } from './kitchen-sheet.js';

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

// «Сделано» — не пятая группа СРОЧНОСТИ, а список уже закрытых точек: работы в
// нём нет, и в счётчике задач ему не место. Отсюда отдельная константа, а не
// пятая строка в MAR_TASK_GROUPS.
export const MAR_DONE_GROUP = ['done', 'Сделано'];

const GROUP_LABEL = Object.fromEntries([...MAR_TASK_GROUPS, MAR_DONE_GROUP]);
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
    const rowFor = (t) => {
        const id = Number(t.admission_id);
        if (!byAdmission.has(id)) {
            byAdmission.set(id, {
                admission_id: id,
                patient_id: t.patient_id,
                patient_name: t.patient_name || '',
                ward_id: t.ward_id, ward_name: t.ward_name || '',
                bed_id: t.bed_id, bed_code: t.bed_code || '',
                counts: { overdue: 0, now: 0, later: 0, prn: 0, done: 0 },
                total: 0,
            });
        }
        return byAdmission.get(id);
    };
    for (const [key] of MAR_TASK_GROUPS) {
        for (const t of (groups[key] || [])) {
            const row = rowFor(t);
            row.counts[key] += 1;
            row.total += 1;      // «total» — это РАБОТА; «Сделано» в неё не входит
        }
    }
    // Человек, у которого на сегодня всё отмечено, из списка НЕ исчезает: пока
    // окно самоисправления открыто, к нему есть зачем вернуться. Счётчик задач
    // при этом остаётся честным нулём.
    for (const t of (groups.done || [])) rowFor(t).counts.done += 1;
    return [...byAdmission.values()].sort((a, b) =>
        (b.counts.overdue - a.counts.overdue)
        || (b.counts.now - a.counts.now)
        || String(a.patient_name).localeCompare(String(b.patient_name)));
}

/** Задачи одного пациента, по тем же четырём группам. */
export function tasksForAdmission(due, admissionId) {
    const groups = (due && due.groups) || {};
    const out = {};
    for (const [key] of [...MAR_TASK_GROUPS, MAR_DONE_GROUP]) {
        out[key] = (groups[key] || []).filter((t) => Number(t.admission_id) === Number(admissionId));
    }
    return out;
}

/**
 * Подпись закрытой точки: что именно отмечено и кем.
 *
 * Статус называется СЛОВОМ («Введено», «Отказ пациента»), а не галочкой: в
 * списке, из которого отметку снимают, «✓» без слова и имени — украшение.
 */
export function doneLine(task) {
    const t = task || {};
    return [
        cellStateLabel(t.status) ? tr(cellStateLabel(t.status)) : '',
        t.given_by_name || '',
    ].filter(Boolean).join(' · ');
}

/**
 * Кнопка снятия — ровно там, где сервер её разрешил (`undo.allowed`), и ни
 * строкой дальше. Своих часов и своей копии правила здесь нет намеренно:
 * см. шапку файла.
 */
export function canUndo(task) {
    return !!(task && task.undo && task.undo.allowed && task.administration_id);
}

/** Почему кнопки нет — словами сервера, а не «недоступно». */
export function undoRefusal(task) {
    const u = (task && task.undo) || {};
    return u.allowed ? '' : String(u.message || '');
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
    // НОМЕР КАРТЫ — ЧАСТЬ ИМЕНИ ПАЦИЕНТА В ЭТОЙ СВЕРКЕ. Имя, палата и койка
    // различают двух Каримовых в одной палате только кодом койки, а койку у
    // поста меняют — и тогда сверять оказывается нечего. Лист врача показывает
    // MRN в шапке; окно, в котором доза действительно вводится, показывать его
    // обязано тем более (MAR_MRN_V1).
    return [
        { key: 'patient', label: 'Пациент', value: [
            t.patient_name || p.patient_name || '',
            t.mrn || p.mrn || null,
            bedLine(t.bed_code ? t : p),
        ].filter(Boolean).join(' · ') },
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

/** Номер карты пациента — оттуда же, тем же запросом (MAR_MRN_V1). */
export function mrnOf(mrnMap, patientId) {
    if (!patientId) return '';
    const v = mrnMap instanceof Map ? mrnMap.get(Number(patientId)) : (mrnMap || {})[patientId];
    return typeof v === 'string' ? v.trim() : (v ? String(v) : '');
}

/**
 * СНЯТЫЕ ОТМЕТКИ ВЫБРАННОГО ПАЦИЕНТА — из листа назначений (treatment_orders_
 * list отдаёт их отдельным списком `voided_marks`).
 *
 * Окно снятия обещает медсестре дословно: «Отметка не исчезнет: в истории
 * останется, кто её снял, когда и почему». На этом экране обещание до сих пор
 * не выполнялось вовсе — снятая точка просто уходила с экрана (в «Сделано»
 * сервер отдаёт только `voided_at IS NULL`), и медсестра, снявшая отметку не у
 * того пациента, не имела никакого способа увидеть, что она сделала.
 *
 * Задач тут нет: это НЕ работа, а след, и он стоит в самом низу, под списком
 * сделанного.
 */
export function voidedPoints(sheet, date) {
    const out = [];
    for (const o of ((sheet && sheet.orders) || [])) {
        for (const m of (o.voided_marks || [])) {
            if (!m.voided_at) continue;
            if (date && m.due_date !== date) continue;
            out.push({
                order_id: o.id, name: o.name || '', dose: o.dose || '', route: o.route || '',
                administration_id: m.id, status: m.status, slot: m.due_slot, date: m.due_date,
                given_at: m.given_at, given_by: m.given_by,
                voided_at: m.voided_at, voided_by: m.voided_by, void_reason: m.void_reason || '',
            });
        }
    }
    // Свежее снятие — сверху: исправляют по горячим следам, и смотрят туда же.
    return out.sort((a, b) => String(b.voided_at).localeCompare(String(a.voided_at)));
}

/** Кто снял, когда и почему — три вопроса одной строкой. */
export function voidedLine(point, people) {
    const v = point || {};
    const who = people instanceof Map ? (people.get(Number(v.voided_by)) || '') : ((people || {})[v.voided_by] || '');
    return [
        tr(cellStateLabel(v.status)),
        v.voided_at ? trf('снята в {time}', { time: hhmm(v.voided_at) }) : null,
        who || null,
        v.void_reason || null,
    ].filter(Boolean).join(' · ');
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

/**
 * «Снять отметку» — своя, по горячим следам.
 *
 * ПРИЧИНА ОБЯЗАТЕЛЬНА, и запрос без неё не уходит (сервер откажет второй раз,
 * но человеку это говорит окно, а не красная плашка после ожидания). Окно
 * ГОВОРИТ ВСЛУХ, что снятие остаётся в истории: медсестра должна понимать, что
 * исправляет запись, а не стирает её.
 */
export function openUndoModal({ task, patient, onDone } = {}) {
    if (!task || !task.administration_id) { toast(tr('Отметка не найдена.'), 'fail'); return; }
    if (!canUndo(task)) { toast(undoRefusal(task) || tr('Снять эту отметку может старшая медсестра.'), 'fail'); return; }
    const reasonInp = h('input', { type: 'text', placeholder: tr('Например: нажала не ту строку') });

    inpatientModal(tr('Снять отметку'), 'Warning', [
        anchorBig(task.patient_name || (patient && patient.patient_name) || '', bedLine(task)),
        h('div', { class: 'card', style: { padding: '13px 15px' } },
            h('div', { style: { fontSize: '17px', fontWeight: 700 } }, task.name || ''),
            h('div', { class: 'muted', style: { fontSize: '13.5px', marginTop: '2px' } },
                [task.dose || null, task.route || null,
                    task.given_at ? hhmm(task.given_at) : null, doneLine(task)].filter(Boolean).join(' · '))),
        field(tr('Причина'), reasonInp, { required: true }),
        h('div', { class: 'muted', style: { fontSize: '12.5px' } },
            tr('Отметка не исчезнет: в истории останется, кто её снял, когда и почему. Списанный препарат вернётся на склад, начисление снимется — кроме уже выставленного в счёт.')),
    ], tr('Снять отметку'), async () => {
        const reason = reasonInp.value.trim();
        if (!reason) { toast(tr('Укажите причину: без неё отметка не снимается.'), 'fail'); return false; }
        const { data, error } = await supabase.rpc('treatment_admin_unmark', {
            administration_id: task.administration_id, reason,
        });
        if (error) { toast((error.message) || tr('Не удалось снять отметку.'), 'fail'); return false; }
        // «Строка уже в счёте — уберите её через кассу»: клиническая запись
        // снята, а деньги остались, и молчать об этом нельзя.
        const warn = (data && Array.isArray(data.warnings) ? data.warnings : []).find((w) => w && w.message);
        toast(warn ? warn.message : tr('Отметка снята. Час снова свободен.'), warn ? 'info' : 'ok');
        if (onDone) await onDone();
        return true;
    }, { width: 560 });
}

// ─── Экран ──────────────────────────────────────────────────────────────────

export async function renderMarNurse(root, ctx = {}) {
    const state = {
        date: todayLocal(), wardId: '', wards: [],
        due: null, allergies: new Map(), mrns: new Map(), people: new Map(), selected: null,
        // Питание выбранного пациента на выбранный день (admission_meals_list).
        // Спрашивается по ОДНОМУ человеку, а не по отделению: полоса стоит в
        // карточке выбранного, и лист на всех был бы запросом впрок.
        meals: null,
        // Лист назначений выбранного пациента на тот же день. Нужен ровно ради
        // СНЯТЫХ отметок: `treatment_tasks_due` отдаёт только действующие
        // (voided_at IS NULL), а след снятия обещан медсестре окном снятия.
        sheet: null,
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
    // MAR_MRN_V1 — тем же запросом берётся НОМЕР КАРТЫ: «5 прав» называют
    // пациента именем, номером карты и койкой, а второй запрос за номером
    // означал бы, что окно подтверждения открывается раньше, чем узнаёт, кого
    // подтверждает.
    async function loadAllergies(patientIds) {
        state.allergies = new Map();
        state.mrns = new Map();
        const ids = [...new Set(patientIds.filter(Boolean).map(Number))];
        if (!ids.length) return;
        try {
            const { data } = await supabase.from('patients').select('id, allergies, mrn').in('id', ids);
            for (const p of (data || [])) {
                state.allergies.set(Number(p.id), p.allergies || '');
                state.mrns.set(Number(p.id), p.mrn || '');
            }
        } catch (e) { /* без карты аллергий экран работает, но баннера не будет */ }
    }

    // Имена тех, кто снимал отметки. Список «Сделано» называет человека тем
    // именем, которое прислал сервер (given_by_name); у снятой отметки такого
    // поля нет — она приезжает из листа назначений, где стоит только id.
    async function loadPeople() {
        try {
            const { data } = await supabase.from('users').select('id, full_name').limit(500);
            const map = new Map();
            for (const u of (data || [])) map.set(Number(u.id), u.full_name || '');
            state.people = map;
        } catch (e) { /* имена — украшение следа, след без них читается */ }
    }

    // Питание грузится ОТДЕЛЬНЫМ запросом и его отказ не роняет смену: экран
    // медсестры существует ради доз, и «не удалось прочитать обед» не имеет
    // права стереть с него лист назначений.
    async function loadMeals() {
        state.meals = null;
        if (!state.selected) return;
        const { data } = await supabase.rpc('admission_meals_list', {
            admission_id: state.selected, meal_date: state.date,
        });
        if (data && Array.isArray(data.meals)) state.meals = data;
    }

    // Лист назначений выбранного пациента — ради СНЯТЫХ отметок. Отдельный
    // запрос и отдельный отказ: не прочитался лист — смена работает дальше,
    // просто без следа снятия.
    async function loadSheet() {
        state.sheet = null;
        if (!state.selected) return;
        const { data } = await supabase.rpc('treatment_orders_list', {
            admission_id: state.selected, from: state.date, to: state.date, include_cancelled: true,
        });
        if (data && Array.isArray(data.orders)) state.sheet = data;
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
        for (const p of people) p.mrn = mrnOf(state.mrns, p.patient_id);
        if (!people.some((p) => p.admission_id === state.selected)) {
            state.selected = people.length ? people[0].admission_id : null;
        }
        await loadPeople();
        await loadMeals();
        await loadSheet();
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
                // Список перерисовывается СРАЗУ (выбор человека обязан быть
                // мгновенным), а полоса питания догружается и перерисовывает
                // себя следом: ждать сервер, чтобы подсветить строку, — значит
                // заставить медсестру нажать второй раз.
                onclick: () => {
                    state.selected = p.admission_id;
                    state.meals = null;
                    state.sheet = null;
                    paint(people);
                    Promise.all([loadMeals(), loadSheet()]).then(() => paint(people));
                },
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
                    h('span', { class: 'muted', style: { display: 'block', fontSize: '12.5px' } },
                        [p.mrn || null, bedLine(p) || null].filter(Boolean).join(' · '))),
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
            anchorBig(p.patient_name, [p.mrn || null, bedLine(p) || null].filter(Boolean).join(' · ')),
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

        // Питание — ПОСЛЕ работы с лекарствами и ДО списка сделанного.
        box.appendChild(mealsCard(people, p));

        const done = tasks.done || [];
        const undone = voidedPoints(state.sheet, state.date);
        if (done.length || undone.length) box.appendChild(doneCard(done, undone, p));
        return box;
    }

    /**
     * Полоса приёмов пищи на сегодня: по строке на приём, положенный разовостью
     * питания этого пациента (её разворачивает сервер, admission_meals_list —
     * «какие приёмы входят в 5-разовое» это факт диетологии, а не свойство
     * массива).
     *
     * Отметка ставится ОДНИМ выбором из списка, без окна подтверждения. Это
     * сознательная разница с дозой: «5 прав» существуют потому, что неверный
     * препарат вредит пациенту, а неверно отмеченный полдник исправляется
     * следующим нажатием — и второй экран подтверждения на каждый из пяти
     * приёмов пищи привёл бы к тому, что не отмечали бы вовсе.
     */
    function mealsCard(people, p) {
        const card = h('div', { class: 'card' },
            h('div', { class: 'card-header' },
                h('h3', null, tr('Питание сегодня')),
                h('span', { style: { flex: 1 } }),
                h('span', { class: 'muted', style: { fontSize: '12.5px' } }, dietLine(state.meals))));

        const data = state.meals;
        if (!data || !data.meals.length) {
            card.appendChild(h('div', { class: 'muted', style: { padding: '14px 16px', fontSize: '12.5px' } },
                tr('Лист питания не загружен.')));
            return card;
        }

        for (const m of data.meals) {
            const status = (m.mark && m.mark.status) || 'waiting';
            const sel = h('select', { class: 'input' },
                h('option', { value: '' }, tr('Отметить…')),
                ...MEAL_STATUS_OPTIONS.map(([v, l]) => h('option', { value: v }, tr(l))));
            sel.addEventListener('change', async () => {
                const value = sel.value;
                if (!value) return;
                sel.disabled = true;
                const { error } = await supabase.rpc('admission_meal_mark', {
                    admission_id: p.admission_id, meal_date: data.meal_date,
                    meal_key: m.meal_key, status: value,
                });
                if (error) {
                    // Слова сервера, а не пересказ: отказ «пациент выписан»
                    // объясняет медсестре, что произошло, а «не удалось» — нет.
                    toast(error.message || tr('Не удалось отметить приём пищи.'), 'fail');
                    sel.disabled = false;
                    sel.value = '';
                    return;
                }
                await loadMeals();
                paint(people);
            });
            card.appendChild(h('div', {
                style: {
                    display: 'flex', alignItems: 'center', gap: '12px',
                    padding: '9px 16px', borderTop: '1px solid var(--ink-100)', flexWrap: 'wrap',
                },
            },
                h('div', { style: { fontSize: '13.5px', fontWeight: 700, minWidth: '128px' } }, mealTitle(m.meal_key)),
                h('div', { style: { flex: 1, minWidth: '120px' } },
                    Tag(mealStatusTitle(status), { kind: mealStatusTone(status), dot: status !== 'waiting' })),
                h('div', { style: { flex: '0 1 190px' } }, sel)));
        }
        return card;
    }

    /** «Стол №9 · 5-разовое» в шапке полосы — или прямое «Стол не назначен». */
    function dietLine(data) {
        if (!data) return '';
        const diet = data.diet_code
            ? trf('Стол №{code}', { code: data.diet_code })
            : tr('Стол не назначен');
        return data.meals_per_day ? [diet, mealsTitle(data.meals_per_day)].join(' · ') : diet;
    }

    // «Сделано за смену» — список, из которого снимают промах. Он идёт ПОСЛЕДНИМ
    // и не спорит с работой: сверху то, что надо сделать, внизу то, что сделано.
    function doneCard(list, undone, p) {
        const card = h('div', { class: 'card' },
            h('div', { class: 'card-header' },
                h('h3', null, tr(MAR_DONE_GROUP[1])),
                h('span', { style: { flex: 1 } }),
                Tag(trf('отметок: {n}', { n: list.length }))));
        for (const t of list) card.appendChild(doneRow(t, p));
        // СНЯТЫЕ — ниже сделанного и мельче его: это не работа и не выполнение,
        // а след. Но он ЕСТЬ: до MAR_UNDO_TRACE_V1 снятая точка просто уходила с
        // экрана, и окно снятия обещало историю, которой медсестра нигде не
        // видела.
        if ((undone || []).length) {
            card.appendChild(h('div', {
                style: { padding: '10px 16px 4px', borderTop: '1px solid var(--ink-100)' },
            },
                h('div', { style: { fontSize: '13.5px', fontWeight: 700 } }, tr('Снятые отметки')),
                h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '2px' } },
                    tr('Отметка снята, но не стёрта: час снова ждёт дозу, а запись о снятии остаётся.'))));
            for (const u of undone) card.appendChild(undoneRow(u));
        }
        return card;
    }

    /**
     * ОДНА ЗАКРЫТАЯ ТОЧКА. Введённая доза, отказ, «придержано» и записанный
     * пропуск читаются РАЗНО — знаком, цветом и плашкой, а не одним словом в
     * общей серой строке (MAR_OUTCOME_VISIBLE_V1).
     *
     * До этого дня все четыре исхода рисовались одинаково: 12.5 px серым,
     * «Введено · Иванова» и «Отказ пациента · Иванова» в одном тоне и без
     * знака. Лист врача уже различал их знаком, цветом и легендой, полоса
     * питания на этом же экране — цветом плашки; список, в котором медсестра
     * проверяет СВОЮ работу за смену, оставался единственным местом, где
     * невведённая доза выглядела как введённая.
     */
    function doneRow(t, p) {
        const refusal = undoRefusal(t);
        const status = t.status || 'given';
        const col = cellStateColor(status);
        return h('div', {
            style: {
                display: 'flex', alignItems: 'center', gap: '12px',
                padding: '12px 16px', borderTop: '1px solid var(--ink-100)', flexWrap: 'wrap',
                // Полоска слева — тот же цвет состояния: строку видно с
                // расстояния вытянутой руки, не читая её.
                borderLeft: '3px solid ' + col.fg, background: col.bg,
            },
        },
            h('div', { style: { fontSize: '17px', fontWeight: 800, minWidth: '64px' } }, hhmm(t.given_at)),
            h('div', {
                style: { fontSize: '20px', fontWeight: 800, color: col.fg, minWidth: '24px', textAlign: 'center' },
                title: tr(cellStateLabel(status)),
            }, cellGlyph(status)),
            h('div', { style: { flex: 1, minWidth: '160px' } },
                h('div', { style: { fontSize: '15px', fontWeight: 700, color: 'var(--ink-900)' } }, t.name || ''),
                h('div', { class: 'muted', style: { fontSize: '12.5px' } },
                    [t.dose || null, t.route || null, t.given_by_name || null,
                        t.reason || null].filter(Boolean).join(' · '))),
            Tag(tr(cellStateLabel(status)), { kind: cellStateTone(status), dot: true }),
            canUndo(t)
                ? h('button', {
                    class: 'btn btn-sm', type: 'button',
                    onclick: () => openUndoModal({ task: t, patient: p, onDone: load }),
                }, tr('Снять отметку'))
                // Не серая кнопка, а ПРИЧИНА: «недоступно» отправило бы медсестру
                // искать, что она сделала не так, вместо того чтобы позвать старшую.
                : h('div', { class: 'muted', style: { fontSize: '12.5px', maxWidth: '320px', textAlign: 'right' } },
                    refusal));
    }

    /** Снятая отметка: зачёркнутая, со знаком «↺» и с тем, кто, когда и почему. */
    function undoneRow(u) {
        return h('div', {
            style: {
                display: 'flex', alignItems: 'center', gap: '12px',
                padding: '9px 16px', borderTop: '1px solid var(--ink-100)', flexWrap: 'wrap',
            },
        },
            h('div', { class: 'muted', style: { fontSize: '15px', fontWeight: 700, minWidth: '64px' } },
                hhmm(u.given_at)),
            h('div', { class: 'muted', style: { fontSize: '17px', fontWeight: 800, minWidth: '24px', textAlign: 'center' } },
                VOIDED_GLYPH),
            h('div', { style: { flex: 1, minWidth: '160px' } },
                h('div', {
                    class: 'muted',
                    style: { fontSize: '13.5px', fontWeight: 700, textDecoration: 'line-through' },
                }, u.name || ''),
                h('div', { class: 'muted', style: { fontSize: '12.5px' } }, voidedLine(u, state.people))));
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
