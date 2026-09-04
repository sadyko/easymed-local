// MAR_SHEET_V1 — ЛИСТ НАЗНАЧЕНИЙ: ЭКРАН ВРАЧА (Задача 5 плана
// docs/plans/2026-09-04-inpatient-workflow.md).
//
// ─── ЧТО ЭТО ЗА ДОКУМЕНТ ────────────────────────────────────────────────────
//
// Лист назначений — не таблица в программе, а ЛИСТ. Бумажный, подписанный
// лечащим врачом и старшей медсестрой, который через год достанут из истории
// болезни и спросят: что назначили, когда ввели, кто ввёл и почему не ввели.
// Поэтому здесь два требования, которых нет у обычного экрана:
//   • печать обязана давать тот самый лист (шапка, сетка, две подписи внизу);
//   • ни одна строка не исчезает. Отменённое назначение зачёркнуто и названо
//     причиной, снятая отметка остаётся следом — стирать здесь нечего.
//
// ─── ПОЧЕМУ СЕТКА «НАЗНАЧЕНИЕ × ЧАС», А НЕ СПИСОК ───────────────────────────
//
// Врач читает лист поперёк: «в десять у него что?» — и сразу видит все дозы
// одного часа. Список назначений отвечает на другой вопрос («что назначено»),
// и на первый отвечает только пересчётом в уме. Сетка же показывает ДЫРКИ:
// пустая клетка в прошедшем часе — это не оформление, это доза, которой не
// было и о которой никто не написал.
//
// ─── ЧТО СЧИТАЕТ СЕРВЕР, А ЧТО ЭТОТ ФАЙЛ ────────────────────────────────────
//
// Расписание — сервер. treatment_orders_list отдаёт КАЖДОЕ назначение вместе с
// развёрнутыми плановыми точками (`due`: дата, час, абсолютное время) и
// отметками при них. Разворачивать курс в браузере значило бы завести вторую
// таблицу частот, и она разошлась бы с той, по которой сервер принимает
// отметку («этой дозы нет в расписании назначения»).
//
// Здесь считается ровно одно: ОПОЗДАНИЕ. Три степени (ожидает / задержано /
// просрочено) — это 15 и 60 минут от `due_ms`, и посчитать их нужно в браузере,
// потому что они меняются от того, сколько лист открыт, а не от того, что
// прислал сервер. Константы продублированы с server/services/domain/
// mar-schedule.js СОЗНАТЕЛЬНО (серверный модуль не отдаётся в браузер) и
// сверяются тестом __tests__/mar-sheet.test.mjs — он читает тот файл и падает,
// если числа разъехались. То же и со списками путей введения и частот: они
// живут в схеме и в CHECK миграции 093, а здесь только повторены для формы.

import { supabase } from '../../supabase.js';
import { h, Icon, Tag, clear, toast, field, PageHead, initials } from '../ui.js';
import { tr, trf } from '../i18n.js';   // I18N_COVERAGE_V1 — перевод СНАЧАЛА, подстановка ПОТОМ
import { isModuleAllowed } from '../permissions.js';
import { inpatientModal, patientAnchor } from './admission-modal.js?v=inp5';
import { IN_BED_STATUSES } from '../../shared/admission-status.js';
import { PRINT_FONT_FACE_CSS } from '../../shared/print-fonts.js';   // ONEST_TYPOGRAPHY_V1

// Раздел тот же, что у остального стационара (`beds`), плюс кабинет врача:
// лист назначений ведёт ЛЕЧАЩИЙ ВРАЧ, а раздел коек ему не выдают (миграция 092
// раздала `beds` медсестре, старшей, главному врачу и регистратуре). Сервер
// проверяет право отдельно и строже: читают лист только те, кто ведёт пациента
// (READ_ROLES в rpc/treatment-orders.js), назначает — лечащий врач своего
// пациента, главный врач или админ (assertCanPrescribe).
export function canOpenMarSheet() {
    return isModuleAllowed('mar-sheet');
}

// ─── Зеркала серверных справочников ─────────────────────────────────────────

export const MAR_GRACE_MIN = 15;
export const MAR_MISSED_MIN = 60;

// Десять путей введения — дословно ROUTES из domain/mar-schedule.js.
export const ROUTES = [
    'в/в', 'в/в кап.', 'в/в (инфузомат)', 'в/м', 'п/к',
    'внутрь', 'сублингв.', 'ингаляция', 'местно', 'ректально',
];

// Частоты — дословно FREQUENCIES из domain/mar-schedule.js (код и подпись).
export const FREQ_OPTIONS = [
    ['1x', '1 р/д'], ['2x', '2 р/д'], ['3x', '3 р/д'], ['4x', '4 р/д'],
    ['q6h', 'каждые 6 ч'], ['once', 'однократно'], ['prn', 'по требованию'],
];

// Род назначения: четыре группы листа. Порядок — порядок чтения врача:
// лекарства, капельницы, процедуры, уход.
export const KIND_OPTIONS = [
    ['med', 'Лекарство'], ['infusion', 'Инфузия'], ['proc', 'Процедура'], ['care', 'Уход'],
];

export const SOURCE_OPTIONS = [['clinic', 'Препарат клиники'], ['patient', 'Препарат пациента']];

const KIND_LABEL = Object.fromEntries(KIND_OPTIONS);
const FREQ_LABEL = Object.fromEntries(FREQ_OPTIONS);

// ─── Чистые правила листа ───────────────────────────────────────────────────

/** 'YYYY-MM-DD' по МЕСТНЫМ часам — слот это час настенных часов отделения. */
export function todayLocal(now = new Date()) {
    const d = now instanceof Date ? now : new Date(now);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function shiftDate(date, days) {
    const ms = Date.parse(date + 'T00:00:00Z') + days * 86400000;
    return new Date(ms).toISOString().slice(0, 10);
}

/** Абсолютное время плановой точки — местное, как на сервере (dueAtMs). */
export function dueMsOf(date, slot) {
    return Date.parse(`${date}T${String(Math.trunc(Number(slot) || 0)).padStart(2, '0')}:00:00`);
}

/**
 * Три степени опоздания. 'overdue' здесь — ПЛАНОВАЯ точка, до которой никто не
 * дошёл; 'missed' в этом файле значит другое — записанный пропуск с причиной.
 * Слово «просрочено» на экране одно, а строки в базе разные, и путать их нельзя:
 * первое — вопрос к смене, второе — ответ на него.
 */
export function marDueState(dueMs, nowMs) {
    const late = (Number(nowMs) - Number(dueMs)) / 60000;
    if (!Number.isFinite(late) || late < MAR_GRACE_MIN) return 'pending';
    if (late < MAR_MISSED_MIN) return 'delayed';
    return 'overdue';
}

/** Плановые точки назначения на эту дату (из `due`, посчитанного сервером). */
export function duesOn(order, date) {
    return ((order && order.due) || []).filter((d) => d.date === date);
}

export function isPlanned(order, date, slot) {
    return duesOn(order, date).some((d) => Number(d.slot) === Number(slot));
}

/**
 * ОТМЕТКА ИЩЕТСЯ ПО ДАТЕ И ЧАСУ, А НЕ ПО ЧАСУ. Это та самая ошибка референса,
 * из-за которой его лист назначений однодневный: вчерашняя галочка в десять
 * утра там же и сегодня. Ключ — (назначение, ДАТА, слот), как в миграции 093.
 */
export function markAt(order, date, slot) {
    for (const m of ((order && order.marks) || [])) {
        if (m.voided_at) continue;
        if (m.due_date === date && Number(m.due_slot) === Number(slot)) return m;
    }
    return null;
}

/**
 * СНЯТАЯ отметка этого часа — самая свежая, если снимали не раз.
 *
 * UNMARK_WINDOW_V1 — с этого дня отметку снимает не только старшая: медсестра
 * поправляет СВОЙ промах первые пятнадцать минут, и таких строк на листе стало
 * больше, а не меньше. Значит, показывать их надо тем более: врач, читающий
 * лист, обязан видеть, что в этом часу отметка БЫЛА и её сняли, — иначе клетка
 * выглядит как «никто не дошёл», и разговор о дозе начинается с неверного места.
 * Строка не удаляется никогда (093), сервер отдаёт её отдельным списком
 * (voided_marks), и здесь она становится видимой.
 */
export function voidedAt(order, date, slot) {
    let last = null;
    for (const m of ((order && order.voided_marks) || [])) {
        if (!m.voided_at) continue;
        if (m.due_date !== date || Number(m.due_slot) !== Number(slot)) continue;
        if (!last || String(m.voided_at) > String(last.voided_at)) last = m;
    }
    return last;
}

/**
 * Состояние одной клетки.
 *   none      — этого часа у назначения нет (не планировалось);
 *   given     — введено (✓, время и кто);
 *   refused   — пациент отказался;
 *   held      — придержано (врач, состояние, подготовка);
 *   missed    — пропущено и записано;
 *   pending / delayed / overdue — плановая точка без отметки.
 */
export function cellFor(order, date, slot, nowMs) {
    if (!isPlanned(order, date, slot)) return { state: 'none', mark: null, voided: null, due_ms: null };
    const dueMs = dueMsOf(date, slot);
    const mark = markAt(order, date, slot);
    // Снятая отметка НЕ меняет состояния клетки: час снова ждёт дозу (или уже
    // закрыт верной отметкой), и это правда. Она едет рядом, отдельным полем, —
    // след поверх состояния, а не вместо него.
    const voided = voidedAt(order, date, slot);
    if (mark) return { state: mark.status, mark, voided, due_ms: dueMs };
    return { state: marDueState(dueMs, nowMs), mark: null, voided, due_ms: dueMs };
}

/** Введённая доза и записанный пропуск рисуются РАЗНО — и это проверяется. */
export const GIVEN_STATES = ['given'];
export const OMITTED_STATES = ['refused', 'held', 'missed'];

const GLYPH = {
    given: '✓', refused: '✕', held: '‖', missed: '⊘',
    overdue: '!', delayed: '•', pending: '·', none: '',
};

// Знак снятой отметки. Он не спорит со знаком состояния и стоит под ним: клетка
// говорит сначала «что сейчас», потом «а тут было и снято».
export const VOIDED_GLYPH = '↺';

const STATE_LABEL = {
    given: 'Введено', refused: 'Отказ пациента', held: 'Придержано', missed: 'Пропущено',
    overdue: 'Просрочено', delayed: 'Задержано', pending: 'Ожидает', none: '',
};

export function cellGlyph(state) { return GLYPH[state] || ''; }
export function cellStateLabel(state) { return STATE_LABEL[state] || ''; }

const STATE_COLOR = {
    given:   { fg: '#1f7a4d', bg: 'rgba(31,122,77,.10)' },
    refused: { fg: '#b3261e', bg: 'rgba(179,38,30,.10)' },
    held:    { fg: '#8a6100', bg: 'rgba(138,97,0,.10)' },
    missed:  { fg: '#b3261e', bg: 'rgba(179,38,30,.16)' },
    overdue: { fg: '#b3261e', bg: 'rgba(179,38,30,.06)' },
    delayed: { fg: '#8a6100', bg: 'rgba(138,97,0,.06)' },
    pending: { fg: 'var(--ink-500, #767b85)', bg: 'transparent' },
    none:    { fg: 'var(--ink-200, #dfe2e7)', bg: 'transparent' },
};

/** Часы, которые вообще есть на этом листе за эту дату. */
export function gridHours(orders, date) {
    const set = new Set();
    for (const o of orders || []) for (const d of duesOn(o, date)) set.add(Number(d.slot));
    return [...set].sort((a, b) => a - b);
}

/** Действующие / «по требованию» / отменённые — три разных места на листе. */
export function splitOrders(orders) {
    const scheduled = []; const prn = []; const cancelled = [];
    for (const o of orders || []) {
        if (o.status === 'cancelled') { cancelled.push(o); continue; }
        if (o.prn === 1 || o.prn === true) { prn.push(o); continue; }
        scheduled.push(o);
    }
    return { scheduled, prn, cancelled };
}

export function groupByKind(orders) {
    return KIND_OPTIONS
        .map(([kind]) => ({ kind, label: KIND_LABEL[kind], orders: (orders || []).filter((o) => o.kind === kind) }))
        .filter((g) => g.orders.length);
}

/** Час:минута отметки по местным часам — время, когда доза РЕАЛЬНО введена. */
export function hhmm(iso) {
    if (!iso) return '';
    const ms = Date.parse(iso);
    if (Number.isNaN(ms)) return '';
    const d = new Date(ms);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

export function personName(people, id) {
    if (!id) return '';
    const m = people instanceof Map ? people.get(Number(id)) : (people || {})[id];
    return m || '';
}

/** Подпись назначения одной строкой: доза, путь, частота, чей препарат. */
export function orderSubtitle(order) {
    const o = order || {};
    return [
        o.dose || null,
        o.route || null,
        FREQ_LABEL[o.freq_code] ? tr(FREQ_LABEL[o.freq_code]) : null,
        o.source === 'patient' ? tr('Препарат пациента') : null,
    ].filter(Boolean).join(' · ');
}

/** Что написать в подсказке клетки: состояние, время, кто и почему. */
export function cellTitle(cell, people) {
    const c = cell || {};
    if (c.state === 'none') return '';
    const parts = [tr(cellStateLabel(c.state))];
    if (c.mark) {
        const who = personName(people, c.mark.given_by);
        if (c.mark.given_at) parts.push(hhmm(c.mark.given_at));
        if (who) parts.push(who);
        if (c.mark.reason) parts.push(c.mark.reason);
    }
    if (c.voided) {
        // Кто снял, когда и почему — те же три вопроса, что и у самой отметки.
        parts.push(tr('отметка снята'));
        if (c.voided.voided_at) parts.push(hhmm(c.voided.voided_at));
        const vw = personName(people, c.voided.voided_by);
        if (vw) parts.push(vw);
        if (c.voided.void_reason) parts.push(c.voided.void_reason);
    }
    return parts.filter(Boolean).join(' · ');
}

// ─── Печатный лист ──────────────────────────────────────────────────────────

const esc = (s) => String(s == null ? '' : s)
    .replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * Бумажный лист назначений на дату.
 *
 * Ни одной русской буквы в статическом тексте шаблона: подписи приходят через
 * tr()/trf() внутри подстановок, поэтому лист печатается на языке клиники и его
 * видит i18n-аудит (I18N_COVERAGE_V1) — то же правило, что у порционника.
 *
 * ДВЕ ПОДПИСИ ВНИЗУ — не украшение: лист назначений заверяют лечащий врач и
 * старшая медсестра, и без этих строк распечатка не документ.
 */
export function marSheetPrintHtml(sheet) {
    const s = sheet || {};
    const date = s.date || '';
    const orders = s.orders || [];
    const people = s.people || new Map();
    const nowMs = Number.isFinite(s.now_ms) ? s.now_ms : Date.now();
    const { scheduled, prn, cancelled } = splitOrders(orders);
    const hours = gridHours(scheduled, date);

    const cellCell = (o, slot) => {
        const c = cellFor(o, date, slot, nowMs);
        if (c.state === 'none') return '<td class="p-c"></td>';
        const time = c.mark && c.mark.given_at ? hhmm(c.mark.given_at) : '';
        const who = c.mark ? initials(personName(people, c.mark.given_by) || '') : '';
        // Снятая отметка видна и на бумаге: распечатанный лист — документ, и
        // «здесь было и снято» в нём не должно исчезать.
        const undone = c.voided ? '<br>' + esc(VOIDED_GLYPH) : '';
        return `<td class="p-c"><b>${esc(cellGlyph(c.state))}</b>${time ? '<br>' + esc(time) : ''}${who ? '<br>' + esc(who) : ''}${undone}</td>`;
    };

    const groups = groupByKind(scheduled).map((g) => `
    <tr class="p-grp"><td colspan="${hours.length + 1}">${esc(tr(g.label))}</td></tr>
    ${g.orders.map((o) => `<tr>
      <td class="p-name"><b>${esc(o.name || '')}</b><br><span class="p-sub">${esc(orderSubtitle(o))}</span></td>
      ${hours.map((sl) => cellCell(o, sl)).join('')}
    </tr>`).join('')}`).join('');

    const grid = hours.length
        ? `<table class="p-tbl"><thead><tr><th class="p-name">${esc(tr('Назначение'))}</th>${
            hours.map((sl) => `<th>${esc(String(sl).padStart(2, '0'))}</th>`).join('')
        }</tr></thead><tbody>${groups}</tbody></table>`
        : `<p class="p-empty">${esc(tr('На эту дату назначений нет.'))}</p>`;

    const prnBlock = prn.length ? `
    <h2 class="p-h2">${esc(tr('По требованию'))}</h2>
    <table class="p-tbl"><tbody>${prn.map((o) => `<tr>
      <td class="p-name"><b>${esc(o.name || '')}</b><br><span class="p-sub">${esc(orderSubtitle(o))}</span></td>
      <td>${esc((o.prn_marks || []).map((m) => [hhmm(m.given_at), tr(cellStateLabel(m.status)), personName(people, m.given_by)].filter(Boolean).join(' ')).join('; '))}</td>
    </tr>`).join('')}</tbody></table>` : '';

    const cancelledBlock = cancelled.length ? `
    <h2 class="p-h2">${esc(trf('Отменённые назначения: {n}', { n: cancelled.length }))}</h2>
    <table class="p-tbl"><tbody>${cancelled.map((o) => `<tr>
      <td class="p-name"><s>${esc(o.name || '')}</s><br><span class="p-sub">${esc(orderSubtitle(o))}</span></td>
      <td>${esc([o.cancel_reason || '', personName(people, o.cancel_by), o.cancel_at ? o.cancel_at.slice(0, 16).replace('T', ' ') : ''].filter(Boolean).join(' · '))}</td>
    </tr>`).join('')}</tbody></table>` : '';

    return `<!doctype html><html><head><meta charset="utf-8">
<title>${esc(trf('Лист назначений на {date}', { date }))}</title>
<style>
${PRINT_FONT_FACE_CSS}
@page { size: A4 landscape; margin: 10mm; }
body { font-family: 'Onest', -apple-system, 'Segoe UI', Roboto, sans-serif; color: #111; margin: 0; }
h1 { font-size: 20px; margin: 0 0 2px; }
.p-sub2 { font-size: 13.5px; color: #666; margin: 0 0 12px; }
.p-h2 { font-size: 15px; margin: 16px 0 6px; }
.p-tbl { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.p-tbl th { border: 1px solid #999; padding: 4px 5px; font-weight: 700; }
.p-tbl td { border: 1px solid #ccc; padding: 4px 5px; vertical-align: top; }
.p-tbl .p-name { text-align: left; width: 34%; }
.p-c { text-align: center; }
.p-grp td { background: #f0f0f0; font-weight: 700; }
.p-sub { color: #666; }
.p-empty { font-size: 13.5px; color: #666; }
.p-sign { margin-top: 24px; font-size: 13.5px; color: #333; }
tr, table { page-break-inside: auto; }
thead { display: table-header-group; }
</style></head><body>
<h1>${esc(trf('Лист назначений на {date}', { date }))}</h1>
<p class="p-sub2">${esc([s.patient_name || '', s.ward_name || '', s.bed_code ? trf('койка {code}', { code: s.bed_code }) : ''].filter(Boolean).join(' · '))}</p>
${grid}
${prnBlock}
${cancelledBlock}
<p class="p-sign">${esc(trf('Лист назначений на {date}', { date }))} · ${esc(tr('Лечащий врач'))} ______________ · ${esc(tr('Ст. медсестра'))} ______________</p>
<script>window.onload = function () { (document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve()).then(function () { try { window.focus(); window.print(); } catch (e) {} }); };</scr` + `ipt>
</body></html>`;
}

export function printMarSheet(sheet) {
    const w = window.open('', '_blank');
    if (!w) { toast(tr('Разрешите всплывающие окна для печати.'), 'fail'); return null; }
    w.document.write(marSheetPrintHtml(sheet));
    w.document.close();
    return w;
}

// ─── Диалоги ────────────────────────────────────────────────────────────────

/**
 * «+ Назначение». Форма спрашивает ровно то, из чего состоит назначение, и
 * ничего сверх: род, название, дозу, путь введения, частоту, курс, дату начала
 * и ЧЕЙ ПРЕПАРАТ. Последнее — не мелочь: препарат пациента не списывается со
 * склада и не попадает в счёт (Задача 6), и решается это здесь, в момент
 * назначения, а не потом у кассы.
 *
 * «до отмены» — курс без срока: сервер понимает его как days = null, и
 * расписание рождает точки, пока назначение не отменят. Поле «дней» при этом
 * гасится: число, которое никто не считает, хуже пустого поля.
 */
export function openOrderForm({ admissionId, patientName = '', patientSub = '', onDone } = {}) {
    if (!admissionId) { toast(tr('Госпитализация не найдена.'), 'fail'); return; }

    const kindSel = h('select', null, ...KIND_OPTIONS.map(([v, l]) => h('option', { value: v }, tr(l))));
    const nameInp = h('input', { type: 'text', placeholder: tr('Название препарата или процедуры') });
    const doseInp = h('input', { type: 'text', placeholder: tr('Например: 500 мг') });
    const routeSel = h('select', null, h('option', { value: '' }, tr('Путь введения не указан')),
        ...ROUTES.map((r) => h('option', { value: r }, r)));
    const freqSel = h('select', null, ...FREQ_OPTIONS.map(([v, l]) => h('option', { value: v }, tr(l))));
    const daysInp = h('input', { type: 'number', min: '1', step: '1', value: '5' });
    const openEnded = h('input', { type: 'checkbox' });
    const startInp = h('input', { type: 'date', value: todayLocal() });
    const sourceSel = h('select', null, ...SOURCE_OPTIONS.map(([v, l]) => h('option', { value: v }, tr(l))));
    const noteInp = h('input', { type: 'text', placeholder: tr('Примечание для медсестры') });

    const volInp = h('input', { type: 'number', min: '0', step: '1', placeholder: '200' });
    const rateInp = h('input', { type: 'number', min: '0', step: '1', placeholder: '60' });
    const durInp = h('input', { type: 'number', min: '0', step: '1', placeholder: '90' });
    const contInp = h('input', { type: 'checkbox' });
    const infusionBox = h('div', { style: { display: 'none', gap: '12px', flexWrap: 'wrap' } },
        h('div', { style: { flex: '1 1 120px' } }, field(tr('Объём, мл'), volInp)),
        h('div', { style: { flex: '1 1 120px' } }, field(tr('Скорость, мл/ч'), rateInp)),
        h('div', { style: { flex: '1 1 120px' } }, field(tr('Длительность, мин'), durInp)),
        h('label', { style: { display: 'flex', alignItems: 'center', gap: '7px', fontSize: '13.5px' } },
            contInp, tr('Непрерывная инфузия')));

    const courseBox = h('div', { style: { display: 'flex', gap: '12px', alignItems: 'flex-start', flexWrap: 'wrap' } },
        h('div', { style: { flex: '1 1 120px' } }, field(tr('Дней курса'), daysInp)),
        h('label', { style: { display: 'flex', alignItems: 'center', gap: '7px', fontSize: '13.5px', paddingTop: '24px' } },
            openEnded, tr('до отмены')));

    const syncKind = () => {
        infusionBox.style.display = kindSel.value === 'infusion' ? 'flex' : 'none';
    };
    const syncFreq = () => {
        const prn = freqSel.value === 'prn';
        courseBox.style.display = prn ? 'none' : 'flex';
        daysInp.disabled = openEnded.checked;
    };
    kindSel.addEventListener('change', syncKind);
    freqSel.addEventListener('change', syncFreq);
    openEnded.addEventListener('change', syncFreq);
    syncKind(); syncFreq();

    inpatientModal(tr('Новое назначение'), 'Pill', [
        patientAnchor(patientName, patientSub),
        h('div', { style: { display: 'flex', gap: '12px', alignItems: 'flex-start', flexWrap: 'wrap' } },
            h('div', { style: { flex: '1 1 160px' } }, field(tr('Род назначения'), kindSel)),
            h('div', { style: { flex: '2 1 220px' } }, field(tr('Название'), nameInp, { required: true }))),
        h('div', { style: { display: 'flex', gap: '12px', alignItems: 'flex-start', flexWrap: 'wrap' } },
            h('div', { style: { flex: '1 1 140px' } }, field(tr('Доза'), doseInp)),
            h('div', { style: { flex: '1 1 160px' } }, field(tr('Путь введения'), routeSel))),
        h('div', { style: { display: 'flex', gap: '12px', alignItems: 'flex-start', flexWrap: 'wrap' } },
            h('div', { style: { flex: '1 1 160px' } }, field(tr('Частота'), freqSel)),
            h('div', { style: { flex: '1 1 160px' } }, field(tr('Начало курса'), startInp))),
        courseBox,
        field(tr('Чей препарат'), sourceSel),
        infusionBox,
        field(tr('Примечание'), noteInp),
        h('div', { class: 'muted', style: { fontSize: '12.5px' } },
            tr('Назначение попадёт в задачи медсестры на те часы, которые задаёт частота.')),
    ], tr('Назначить'), async () => {
        const name = nameInp.value.trim();
        if (!name) { toast(tr('Укажите название назначения.'), 'fail'); return false; }
        const kind = kindSel.value;
        if ((kind === 'med' || kind === 'infusion') && !routeSel.value) {
            toast(tr('Укажите путь введения.'), 'fail'); return false;
        }
        const prn = freqSel.value === 'prn';
        const args = {
            admission_id: admissionId,
            kind,
            name,
            dose: doseInp.value.trim(),
            route: routeSel.value || null,
            freq_code: freqSel.value,
            starts_on: startInp.value || todayLocal(),
            days: prn || openEnded.checked ? null : (Number(daysInp.value) || null),
            source: sourceSel.value,
            note: noteInp.value.trim(),
        };
        if (kind === 'infusion') {
            args.volume = volInp.value === '' ? null : Number(volInp.value);
            args.rate_ml_h = rateInp.value === '' ? null : Number(rateInp.value);
            args.duration_min = durInp.value === '' ? null : Number(durInp.value);
            args.continuous = contInp.checked ? 1 : 0;
        }
        const { error } = await supabase.rpc('treatment_order_create', args);
        if (error) { toast((error.message) || tr('Не удалось создать назначение.'), 'fail'); return false; }
        toast(tr('Назначение создано.'), 'ok');
        if (onDone) await onDone();
        return true;
    }, { width: 620 });
}

/**
 * «Отменить назначение» — причина обязательна, и строка НЕ УДАЛЯЕТСЯ.
 * Отменённое назначение остаётся на листе зачёркнутым вместе со всеми
 * отметками при нём: по нему уже вводили дозы, и стереть его значило бы стереть
 * их (ловушка референса, названная в плане).
 */
export function openOrderCancel({ order, onDone } = {}) {
    if (!order || !order.id) { toast(tr('Назначение не найдено.'), 'fail'); return; }
    const reasonInp = h('input', { type: 'text', placeholder: tr('Например: аллергическая реакция') });
    const noteInp = h('input', { type: 'text', placeholder: tr('Примечание') });

    inpatientModal(tr('Отменить назначение'), 'Warning', [
        h('div', { style: { fontSize: '17px', fontWeight: 800, color: 'var(--ink-900)' } }, order.name || ''),
        h('div', { class: 'muted', style: { fontSize: '12.5px' } }, orderSubtitle(order)),
        field(tr('Причина отмены'), reasonInp, { required: true }),
        field(tr('Примечание'), noteInp),
        h('div', { class: 'muted', style: { fontSize: '12.5px' } },
            tr('Назначение не удаляется: оно останется на листе зачёркнутым, вместе с уже поставленными отметками.')),
    ], tr('Отменить назначение'), async () => {
        const reason = reasonInp.value.trim();
        if (!reason) { toast(tr('Укажите причину отмены назначения.'), 'fail'); return false; }
        const { error } = await supabase.rpc('treatment_order_cancel', {
            order_id: order.id, reason, note: noteInp.value.trim(),
        });
        if (error) { toast((error.message) || tr('Не удалось отменить назначение.'), 'fail'); return false; }
        toast(tr('Назначение отменено.'), 'ok');
        if (onDone) await onDone();
        return true;
    });
}

// ─── Экран ──────────────────────────────────────────────────────────────────

async function loadPeople() {
    const map = new Map();
    try {
        const { data } = await supabase.from('users').select('id, full_name').limit(500);
        for (const u of (data || [])) map.set(Number(u.id), u.full_name || '');
    } catch (e) { /* имена — украшение листа, лист без них читается */ }
    return map;
}

export async function renderMarSheet(root, ctx = {}) {
    const payload = ctx.payload || {};
    const admissionId = Number(payload.admissionId || payload.sub || 0) || null;

    const wrap = h('div', { class: 'fade-in' });
    root.appendChild(wrap);

    if (!admissionId) { await paintPicker(wrap, ctx); return { picker: true }; }

    const state = {
        admissionId, date: todayLocal(), showCancelled: false,
        sheet: null, admission: null, people: new Map(),
    };
    state.people = await loadPeople();

    const headBox = h('div');
    const body = h('div');
    wrap.appendChild(headBox);
    wrap.appendChild(body);

    async function loadAdmission() {
        const { data } = await supabase.from('admissions')
            .select('*, patients(mrn, full_name), wards(name), beds(code), attending:attending_doctor_id(full_name)')
            .eq('id', state.admissionId).single();
        state.admission = data || null;
    }

    async function load() {
        clear(body);
        body.appendChild(h('div', { class: 'muted', style: { padding: '18px', fontSize: '13.5px' } }, tr('Загрузка…')));
        // include_cancelled: отменённые приезжают ВСЕГДА — иначе переключатель
        // «Показать отменённые · N» не знал бы своего N и требовал бы второго
        // запроса ровно за тем, что уже посчитано.
        const { data, error } = await supabase.rpc('treatment_orders_list', {
            admission_id: state.admissionId, from: state.date, to: state.date, include_cancelled: true,
        });
        clear(body);
        if (error || !data) {
            body.appendChild(h('div', { class: 'card', style: { padding: '18px' } },
                h('div', { class: 'empty' }, trf('Не удалось загрузить лист назначений: {msg}',
                    { msg: (error && error.message) || tr('нет данных') }))));
            state.sheet = null;
            return;
        }
        state.sheet = data;
        paintHead();
        paintSheet();
    }

    function printable() {
        const a = state.admission || {};
        const p = a.patients || {};
        return {
            date: state.date,
            orders: (state.sheet && state.sheet.orders) || [],
            people: state.people,
            now_ms: Date.now(),
            patient_name: p.full_name || '',
            ward_name: (a.wards && a.wards.name) || '',
            bed_code: (a.beds && a.beds.code) || '',
        };
    }

    function paintHead() {
        clear(headBox);
        const a = state.admission || {};
        const p = a.patients || {};
        headBox.appendChild(PageHead({
            title: 'Лист назначений',
            subtitle: 'Что назначено, в какие часы и что из этого введено',
            right: [
                h('button', { class: 'btn btn-sm', type: 'button', onclick: () => load() },
                    Icon('Refresh', { size: 13 }), ' ', tr('Обновить')),
                h('button', { class: 'btn btn-sm', type: 'button', onclick: () => printMarSheet(printable()) },
                    Icon('Print', { size: 13 }), ' ', tr('Печать')),
                h('button', {
                    class: 'btn btn-primary btn-sm', type: 'button',
                    onclick: () => openOrderForm({
                        admissionId: state.admissionId,
                        patientName: p.full_name || '',
                        patientSub: [p.mrn, (a.wards && a.wards.name) || null, (a.beds && a.beds.code) || null].filter(Boolean).join(' · '),
                        onDone: load,
                    }),
                }, Icon('Plus', { size: 13 }), ' ', tr('Назначение')),
            ],
        }));
        // ПАЦИЕНТ — ЯКОРЬ и на этом экране: лист назначений всегда лист ОДНОГО
        // человека, и путать их дороже всего именно здесь.
        headBox.appendChild(h('div', { style: { marginBottom: '14px' } },
            patientAnchor(p.full_name || tr('без имени'), [
                p.mrn || null,
                (a.wards && a.wards.name) || null,
                (a.beds && a.beds.code) ? trf('койка {code}', { code: a.beds.code }) : null,
                (a.attending && a.attending.full_name)
                    ? trf('лечащий: {name}', { name: a.attending.full_name })
                    : tr('лечащий врач не назначен'),
            ].filter(Boolean).join(' · '))));
        headBox.appendChild(dayBar());
    }

    function dayBar() {
        const go = (d) => { state.date = d; load(); };
        return h('div', {
            class: 'card',
            style: { display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 14px', marginBottom: '14px', flexWrap: 'wrap' },
        },
            h('button', { class: 'btn btn-sm', type: 'button', title: tr('Предыдущий день'), onclick: () => go(shiftDate(state.date, -1)) },
                Icon('ChevronLeft', { size: 13 })),
            h('div', { style: { fontSize: '15px', fontWeight: 700, minWidth: '110px', textAlign: 'center' } }, state.date),
            h('button', { class: 'btn btn-sm', type: 'button', title: tr('Следующий день'), onclick: () => go(shiftDate(state.date, 1)) },
                Icon('ChevronRight', { size: 13 })),
            h('button', { class: 'btn btn-sm', type: 'button', onclick: () => go(todayLocal()) }, tr('Сегодня')),
            h('span', { style: { flex: 1 } }),
            legend(),
        );
    }

    function legend() {
        const box = h('div', { style: { display: 'flex', gap: '10px', flexWrap: 'wrap', fontSize: '12.5px' } });
        for (const st of ['given', 'refused', 'held', 'missed', 'overdue', 'pending']) {
            box.appendChild(h('span', { class: 'muted', style: { display: 'inline-flex', gap: '4px', alignItems: 'center' } },
                h('b', { style: { color: STATE_COLOR[st].fg } }, cellGlyph(st)), tr(cellStateLabel(st))));
        }
        return box;
    }

    function paintSheet() {
        clear(body);
        const orders = (state.sheet && state.sheet.orders) || [];
        const { scheduled, prn, cancelled } = splitOrders(orders);
        const nowMs = Date.now();
        const hours = gridHours(scheduled, state.date);

        body.appendChild(gridCard(scheduled, hours, nowMs));
        body.appendChild(stockIssuesCard());
        if (prn.length) body.appendChild(prnCard(prn));
        body.appendChild(cancelledCard(cancelled));
        // Подпись листа — та же строка, что печатается внизу бумаги: экран и
        // распечатка обязаны называть один документ одинаково.
        body.appendChild(h('div', {
            class: 'muted',
            style: { marginTop: '14px', fontSize: '12.5px', display: 'flex', gap: '10px', flexWrap: 'wrap' },
        },
            trf('Лист назначений на {date}', { date: state.date }),
            '·', tr('Лечащий врач'), '______________',
            '·', tr('Ст. медсестра'), '______________'));
    }

    function gridCard(scheduled, hours, nowMs) {
        const card = h('div', { class: 'card' },
            h('div', { class: 'card-header' },
                h('h3', null, Icon('Pill', { size: 16 }), ' ', tr('Назначения по часам')),
                h('span', { style: { flex: 1 } }),
                h('span', { class: 'muted', style: { fontSize: '12.5px' } },
                    trf('назначений: {n}', { n: scheduled.length }))));
        if (!scheduled.length || !hours.length) {
            card.appendChild(h('div', { class: 'empty', style: { padding: '26px' } }, tr('На эту дату назначений нет.')));
            return card;
        }
        const nowHour = state.date === todayLocal() ? new Date(nowMs).getHours() : -1;
        const head = h('tr', null, h('th', { style: { textAlign: 'left', minWidth: '240px' } }, tr('Назначение')));
        for (const sl of hours) {
            const isNow = sl === nowHour;
            head.appendChild(h('th', {
                style: {
                    textAlign: 'center', minWidth: '52px', fontSize: '12.5px',
                    background: isNow ? 'rgba(31,122,114,.12)' : 'transparent',
                    color: isNow ? 'var(--primary-700, #145f59)' : 'inherit',
                },
                title: isNow ? tr('Сейчас') : '',
            }, String(sl).padStart(2, '0'), isNow ? h('div', { style: { fontSize: '12.5px', fontWeight: 700 } }, tr('сейчас')) : null));
        }
        const tbody = h('tbody');
        for (const g of groupByKind(scheduled)) {
            tbody.appendChild(h('tr', null, h('td', {
                colspan: String(hours.length + 1),
                style: { background: 'var(--ink-25, #f7f8fa)', fontWeight: 700, fontSize: '12.5px' },
            }, tr(g.label))));
            for (const o of g.orders) tbody.appendChild(orderRow(o, hours, nowMs));
        }
        card.appendChild(h('div', { style: { overflowX: 'auto' } },
            h('table', { class: 'table' }, h('thead', null, head), tbody)));
        return card;
    }

    function orderRow(o, hours, nowMs) {
        const row = h('tr', null,
            h('td', null,
                h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
                    h('div', { style: { flex: 1, minWidth: 0 } },
                        h('div', { style: { fontSize: '13.5px', fontWeight: 700, color: 'var(--ink-900)' } }, o.name || ''),
                        h('div', { class: 'muted', style: { fontSize: '12.5px' } }, orderSubtitle(o))),
                    h('button', {
                        class: 'btn btn-sm', type: 'button', title: tr('Отменить назначение'),
                        onclick: () => openOrderCancel({ order: o, onDone: load }),
                    }, tr('Отменить')))));
        for (const sl of hours) {
            const c = cellFor(o, state.date, sl, nowMs);
            const col = STATE_COLOR[c.state] || STATE_COLOR.none;
            const time = c.mark && c.mark.given_at ? hhmm(c.mark.given_at) : '';
            const who = c.mark ? initials(personName(state.people, c.mark.given_by) || '') : '';
            row.appendChild(h('td', {
                title: cellTitle(c, state.people),
                style: {
                    textAlign: 'center', background: col.bg, color: col.fg,
                    fontSize: '12.5px', lineHeight: 1.25, whiteSpace: 'nowrap',
                },
            },
                h('div', { style: { fontSize: '15px', fontWeight: 700 } }, cellGlyph(c.state)),
                time ? h('div', null, time) : null,
                who ? h('div', { class: 'muted', style: { fontSize: '12.5px' } }, who) : null,
                c.voided ? h('div', { class: 'muted', style: { fontSize: '12.5px' } }, VOIDED_GLYPH) : null));
        }
        return row;
    }

    // MED_ADMIN_CHARGE_V1 (Задача 6) — НЕСПИСАННОЕ. Отметка «дала», за которой не
    // пошёл склад (количество не выведено из дозы, остатка не хватило), это
    // работа для человека, и на листе она обязана быть видна: молча она нашлась
    // бы при инвентаризации, через месяц, когда уже не вспомнить, что вводили.
    function stockIssuesCard() {
        const issues = (state.sheet && state.sheet.stock_issues) || { count: 0, items: [] };
        const box = h('div');
        if (!issues.count) return box;
        box.appendChild(h('div', {
            class: 'card',
            style: {
                marginTop: '14px', padding: '12px 16px',
                border: '1px solid rgba(138,97,0,.35)', background: 'rgba(138,97,0,.08)',
            },
        },
            h('div', { style: { fontSize: '13.5px', fontWeight: 700, color: '#8a6100' } },
                trf('Не списано со склада: {n}', { n: issues.count })),
            h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '4px' } },
                tr('Доза введена и записана, но склад за ней не пошёл — разберитесь на складе.')),
            ...(issues.items || []).slice(0, 8).map((it) => h('div', { style: { fontSize: '12.5px', marginTop: '3px' } },
                [it.name || '', it.due_date || '', it.due_slot === null || it.due_slot === undefined ? '' : String(it.due_slot).padStart(2, '0') + ':00',
                    it.stock_note || ''].filter(Boolean).join(' · ')))));
        return box;
    }

    function prnCard(prn) {
        const card = h('div', { class: 'card', style: { marginTop: '14px' } },
            h('div', { class: 'card-header' },
                h('h3', null, Icon('Droplet', { size: 16 }), ' ', tr('По требованию')),
                h('span', { style: { flex: 1 } }),
                h('span', { class: 'muted', style: { fontSize: '12.5px' } }, trf('назначений: {n}', { n: prn.length }))));
        card.appendChild(h('div', { class: 'muted', style: { padding: '0 16px 8px', fontSize: '12.5px' } },
            tr('Часов у этих назначений нет: доза даётся по состоянию, и на листе остаётся событием.')));
        for (const o of prn) {
            const events = (o.prn_marks || []).map((m) => [
                hhmm(m.given_at), tr(cellStateLabel(m.status)), personName(state.people, m.given_by), m.reason || null,
            ].filter(Boolean).join(' · '));
            card.appendChild(h('div', {
                style: { padding: '12px 16px', borderTop: '1px solid var(--ink-100)' },
            },
                h('div', { style: { fontSize: '13.5px', fontWeight: 700 } }, o.name || ''),
                h('div', { class: 'muted', style: { fontSize: '12.5px' } }, orderSubtitle(o)),
                events.length
                    ? h('div', { style: { marginTop: '6px', fontSize: '12.5px' } }, ...events.map((e) => h('div', null, e)))
                    : h('div', { class: 'muted', style: { marginTop: '6px', fontSize: '12.5px' } }, tr('Сегодня не давали.')),
                h('div', { style: { marginTop: '6px' } },
                    h('button', {
                        class: 'btn btn-sm', type: 'button',
                        onclick: () => openOrderCancel({ order: o, onDone: load }),
                    }, tr('Отменить')))));
        }
        return card;
    }

    function cancelledCard(cancelled) {
        const box = h('div', { style: { marginTop: '14px' } });
        if (!cancelled.length) return box;
        const toggle = h('button', {
            class: 'btn btn-sm', type: 'button',
            onclick: () => { state.showCancelled = !state.showCancelled; paintSheet(); },
        }, trf('Показать отменённые · {n}', { n: cancelled.length }));
        box.appendChild(toggle);
        if (!state.showCancelled) return box;
        const card = h('div', { class: 'card', style: { marginTop: '10px' } });
        for (const o of cancelled) {
            card.appendChild(h('div', { style: { padding: '12px 16px', borderBottom: '1px solid var(--ink-100)' } },
                h('div', {
                    style: {
                        fontSize: '13.5px', fontWeight: 700, textDecoration: 'line-through',
                        color: 'var(--ink-500, #767b85)',
                    },
                }, o.name || ''),
                h('div', { class: 'muted', style: { fontSize: '12.5px' } }, orderSubtitle(o)),
                h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '4px' } },
                    [
                        o.cancel_reason ? trf('причина: {reason}', { reason: o.cancel_reason }) : null,
                        personName(state.people, o.cancel_by) ? trf('отменил: {name}', { name: personName(state.people, o.cancel_by) }) : null,
                        o.cancel_at ? o.cancel_at.slice(0, 16).replace('T', ' ') : null,
                    ].filter(Boolean).join(' · '))));
        }
        box.appendChild(card);
        return box;
    }

    await loadAdmission();
    paintHead();
    await load();
    return { state, reload: load };
}

/**
 * Экран открыт без пациента (по ссылке из меню, а не из карточки). Показываем
 * тех, кто лежит: искать госпитализацию по номеру в отдельном поле — это шаг,
 * который в отделении никто не сделает.
 */
async function paintPicker(wrap, ctx) {
    wrap.appendChild(PageHead({
        title: 'Лист назначений',
        subtitle: 'Выберите пациента: лист назначений всегда лист одного человека',
    }));
    const card = h('div', { class: 'card' });
    wrap.appendChild(card);
    const { data, error } = await supabase.from('admissions')
        .select('id, status, patients(mrn, full_name), wards(name), beds(code)')
        .in('status', IN_BED_STATUSES).order('id', { ascending: false }).limit(200);
    if (error) {
        card.appendChild(h('div', { class: 'empty', style: { padding: '26px' } },
            trf('Не удалось загрузить: {msg}', { msg: error.message })));
        return;
    }
    const rows = data || [];
    if (!rows.length) {
        card.appendChild(h('div', { class: 'empty', style: { padding: '26px' } }, tr('В отделении никого нет.')));
        return;
    }
    for (const a of rows) {
        const p = a.patients || {};
        card.appendChild(h('button', {
            type: 'button',
            style: {
                display: 'flex', alignItems: 'center', gap: '12px', width: '100%', textAlign: 'left',
                padding: '13px 16px', border: '0', borderBottom: '1px solid var(--ink-100)',
                background: 'transparent', cursor: 'pointer', font: 'inherit',
            },
            onclick: () => ctx.onNavigate && ctx.onNavigate('mar-sheet', { sub: String(a.id) }),
        },
            h('span', {
                style: {
                    width: '38px', height: '38px', borderRadius: '999px', flex: '0 0 38px',
                    background: 'var(--primary-600, #1f7a72)', color: '#fff',
                    display: 'grid', placeItems: 'center', fontWeight: 700, fontSize: '15px',
                },
            }, initials(p.full_name || '?')),
            h('span', { style: { flex: 1, minWidth: 0 } },
                h('span', { style: { display: 'block', fontSize: '17px', fontWeight: 800, color: 'var(--ink-900)' } },
                    p.full_name || tr('без имени')),
                h('span', { class: 'muted', style: { display: 'block', fontSize: '12.5px' } },
                    [p.mrn || null, (a.wards && a.wards.name) || null,
                        (a.beds && a.beds.code) ? trf('койка {code}', { code: a.beds.code }) : null].filter(Boolean).join(' · '))),
            Tag(tr('Открыть'))));
    }
}
