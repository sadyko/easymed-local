// ═══════════════════════════════════════════════════════════════════════════
// CASE_OVERVIEW_V1 — ОБЗОР ГОСПИТАЛИЗАЦИИ: экран врача поверх истории болезни
// ═══════════════════════════════════════════════════════════════════════════
//
// Владелец: «list of the patients → pressed opens a patients dashboard and
// main action → opens the documents to fill for the doctor. but in the
// dashboard we can see status of the patient, services prescription, and
// discharge button with generating the payments», «in the header navigation
// between the patients for the doctors».
//
// Два экрана — одна шапка (caseHead): «Обзор» (этот файл, маршрут
// 'case-overview') и «Документы» (case-workspace.js, 'case-file'). В шапке —
// пациент (нажатие ведёт в документы), статус и день, койка, лечащий врач,
// стрелки по соседям отделения и ГЛАВНОЕ ДЕЙСТВИЕ: «Заполнить историю
// болезни» — открывает документы на том, что по регламенту следующий.
//
// Данные — один вызов admission_overview (rpc/case-overview.js). Экран ничего
// не считает сам: сроки, состояния, «что следующее» и «сколько в счёте»
// приезжают готовыми, здесь — слова, порядок и кнопки.
import { supabase } from '../../supabase.js';
import { h, Icon, Tag, clear, toast, initials, avColor, fmtDate, fmtDateTime } from '../ui.js';
import { tr, trf } from '../i18n.js';
import { admissionStatusLabel, IN_BED_STATUSES } from '../../shared/admission-status.js';
import { dateNumeric } from '../../shared/date-words.js';
import { moneyDisplay } from '../../shared/money-input.js';
import { caseDocTitle } from './case-docs.js?v=cw1';
import { openAdmissionDischargeRequestModal, openAdmissionAttendingModal, openAdmissionDietModal, goToMarSheet, goToCaseOverview } from './admission-modal.js?v=inp2';
import { outcomeTitle } from './discharge.js';
import { genderWord } from './title-sheet-print.js';

const state = { admissionId: null, ov: null, failed: null };

const sum = (n) => trf('{sum} сум', { sum: moneyDisplay(String(Math.round(Number(n) || 0))) || '0' });
const dt = (iso) => (iso ? fmtDateTime(iso) : '');

function ageOf(dob, nowIso) {
    if (!dob) return null;
    const b = new Date(dob); const n = nowIso ? new Date(nowIso) : new Date();
    if (Number.isNaN(b.getTime())) return null;
    let age = n.getFullYear() - b.getFullYear();
    const m = n.getMonth() - b.getMonth();
    if (m < 0 || (m === 0 && n.getDate() < b.getDate())) age -= 1;
    return age >= 0 ? age : null;
}

/** Минимальная госпитализация для окон admission-modal.js (заявка на выписку, лечащий врач, стол). */
export function admissionForModals(ov) {
    const a = ov.admission || {}; const p = ov.patient || {};
    return {
        id: a.id, admission_no: a.admission_no, department: a.department, status: a.status,
        attending_doctor_id: a.attending_doctor_id || null, discharge_recommendations: '',
        patients: { full_name: p.full_name || '', mrn: p.mrn || '' },
    };
}

// ---------------------------------------------------------------------------
// Шапка — общая для «Обзора» и «Документов»
// ---------------------------------------------------------------------------
/**
 * @param {object} ov ответ admission_overview
 * @param {{active?: 'overview'|'documents', onNavigate?: function, onReload?: function, actions?: Node[]}} opts
 */
export function caseHead(ov, { active = 'overview', onNavigate = null, onReload = null, actions = [] } = {}) {
    const a = ov.admission || {}; const p = ov.patient || {}; const n = ov.neighbours || {};
    const nav = (view, payload) => {
        const fn = onNavigate || (typeof window !== 'undefined' && window.easymed && window.easymed.navigate);
        if (fn) fn(view, payload);
    };
    const toDocs = (kind) => nav('case-file', kind ? { admissionId: a.id, kind } : { admissionId: a.id });
    const toOverview = () => nav('case-overview', { admissionId: a.id });
    const inBed = IN_BED_STATUSES.includes(a.status);
    const age = ageOf(p.date_of_birth, ov.now);
    const who = [genderWord(p.gender), age !== null ? trf('{n} лет', { n: age }) : null, p.mrn].filter(Boolean).join(' · ');

    const tone = a.status === 'discharging' ? 'warn' : (inBed ? 'ok' : '');
    const chip = Tag(admissionStatusLabel(a.status), { kind: tone, dot: true });
    const dayTag = a.days ? h('span', { class: 'co-day' }, trf('{n}-й день', { n: a.days })) : null;

    // Пациент — ЯКОРЬ и дверь в документы: «when patient pressed it should open a cabinet like documents section».
    const avatar = h('button', {
        class: 'co-av', type: 'button', title: tr('Открыть историю болезни'),
        style: { background: avColor(p.full_name || '?') }, onclick: () => toDocs(null),
    }, initials(p.full_name || '?'));
    const nameBtn = h('button', { class: 'co-name', type: 'button', onclick: () => toDocs(null) }, p.full_name || '—');

    // Стрелки по соседям — «navigation between the patients for the doctors».
    const prev = n.prev; const next = n.next;
    const navBox = h('div', { class: 'co-nav' },
        h('button', { class: 'btn btn-sm', type: 'button', disabled: prev ? null : '', title: prev ? prev.full_name : '',
            onclick: () => { if (prev) nav('case-overview', { admissionId: prev.id }); } }, Icon('ChevronLeft', { size: 14 })),
        h('span', { class: 'co-nav-count' },
            n.total ? trf('{i} из {n}', { i: (n.index >= 0 ? n.index + 1 : 0), n: n.total }) : '',
            n.mine ? h('small', null, ' · ' + tr('мои пациенты')) : null),
        h('button', { class: 'btn btn-sm', type: 'button', disabled: next ? null : '', title: next ? next.full_name : '',
            onclick: () => { if (next) nav('case-overview', { admissionId: next.id }); } }, Icon('ChevronRight', { size: 14 })));

    const allergy = p.allergies
        ? h('div', { class: 'co-allergy' }, Icon('Warning', { size: 14 }), ' ', trf('Аллергия: {what}', { what: p.allergies }))
        : null;

    const hf = (label, value, sub) => h('div', { class: 'co-hf' },
        h('div', { class: 'co-hf-l' }, tr(label)),
        h('div', { class: 'co-hf-v' }, value || '—'),
        sub ? h('div', { class: 'co-hf-s' }, sub) : null);
    const place = [a.department, [a.ward_name, a.bed_code].filter(Boolean).join(' · ')].filter(Boolean).join(' · ');
    const attending = a.attending_name
        ? hf('Лечащий врач', a.attending_name)
        : h('div', { class: 'co-hf' }, h('div', { class: 'co-hf-l' }, tr('Лечащий врач')),
            h('button', { class: 'btn btn-sm btn-outline', type: 'button',
                onclick: () => openAdmissionAttendingModal({ admission: admissionForModals(ov), onDone: async () => { if (onReload) await onReload(); } }),
            }, tr('Назначить')));

    // Главное действие — «main action → opens the documents to fill for the doctor».
    const nextKind = ov.docs && ov.docs.next_kind;
    const mainLabel = nextKind ? trf('Заполнить: {doc}', { doc: caseDocTitle(nextKind) }) : tr('Заполнить историю болезни');
    const primary = h('button', { class: 'btn btn-primary btn-sm co-main', type: 'button', onclick: () => toDocs(nextKind || null) },
        Icon('Edit', { size: 14 }), ' ', mainLabel);

    const tab = (id, label, icon, onclick) => h('button', {
        class: 'reg-tab' + (active === id ? ' on' : ''), type: 'button', role: 'tab',
        'aria-selected': active === id ? 'true' : 'false', onclick,
    }, Icon(icon, { size: 14 }), ' ', tr(label));

    return h('div', { class: 'co-head card' },
        h('div', { class: 'co-head-row' },
            avatar,
            h('div', { class: 'co-pat' },
                h('div', { class: 'co-name-row' }, nameBtn, chip, dayTag),
                h('div', { class: 'co-sub muted' }, who || '—'),
                allergy),
            navBox),
        h('div', { class: 'co-fields' },
            hf('№ истории', a.admission_no),
            hf('Поступление', a.admitted_at && inBed ? dt(a.admitted_at) : (a.admitted_at && a.status === 'discharged' ? dt(a.admitted_at) : '—')),
            hf('Отделение · койка', place),
            attending,
            hf('Плановая выписка', a.planned_discharge_at ? dt(a.planned_discharge_at) : (a.discharged_at ? tr('выписан') + ' ' + dt(a.discharged_at) : '—'))),
        h('div', { class: 'co-bar' },
            h('div', { class: 'reg-tabs co-tabs', role: 'tablist', 'aria-label': tr('История болезни') },
                tab('overview', 'Обзор', 'Activity', toOverview),
                tab('documents', 'Документы', 'Doc', () => toDocs(null))),
            h('div', { class: 'co-actions' }, primary,
                h('button', { class: 'btn btn-sm', type: 'button', onclick: () => goToMarSheet(a.id, onNavigate) }, Icon('Pill', { size: 13 }), ' ', tr('Лист назначений')),
                ...actions.filter(Boolean))));
}

// ---------------------------------------------------------------------------
// Экран «Обзор»
// ---------------------------------------------------------------------------
export async function renderCaseOverview(container, { payload, onNavigate } = {}) {
    const admissionId = Number(payload && (payload.admissionId || payload.admission_id || payload.id)) || null;
    clear(container);
    const root = h('div', { class: 'fade-in co' });
    container.appendChild(root);
    if (!admissionId) {
        root.appendChild(h('div', { class: 'card', style: { padding: '22px' } },
            h('div', { style: { fontSize: '15px', fontWeight: '600', color: 'var(--ink-900)' } }, tr('Госпитализация не выбрана')),
            h('div', { class: 'muted', style: { fontSize: '13.5px', marginTop: '6px' } },
                tr('Обзор открывают из списка пациентов в разделе «Стационар».'))));
        return;
    }
    state.admissionId = admissionId;
    await load();
    paint(root, onNavigate);
}

export async function loadCaseOverview(admissionId) {
    const { data, error } = await supabase.rpc('admission_overview', { admission_id: admissionId });
    return error ? null : data;
}

async function load() {
    const { data, error } = await supabase.rpc('admission_overview', { admission_id: state.admissionId });
    if (error) { state.failed = (error && error.message) || 'error'; state.ov = null; return; }
    state.failed = null;
    state.ov = data;
}

function block(title, icon, body, { link = null, tone = '' } = {}) {
    return h('div', { class: 'card co-block' + (tone ? ' co-' + tone : '') },
        h('div', { class: 'co-block-h' },
            h('span', { class: 'co-block-ic' }, Icon(icon, { size: 14 })),
            h('span', { class: 'co-block-t' }, tr(title)),
            h('span', { class: 'grow' }),
            link ? h('button', { class: 'btn-plain co-link', type: 'button', onclick: link.onclick }, link.label, ' ', Icon('ArrowRight', { size: 12 })) : null),
        h('div', { class: 'co-block-b' }, ...[].concat(body).filter(Boolean)));
}
const kv = (k, v, cls = '') => h('div', { class: 'co-kv' + (cls ? ' ' + cls : '') }, h('span', { class: 'co-k' }, k), h('span', { class: 'co-v' }, v || '—'));
const line = (text, cls = '') => h('div', { class: 'co-line' + (cls ? ' ' + cls : '') }, text);

function paint(root, onNavigate) {
    clear(root);
    if (state.failed) {
        root.appendChild(h('div', { class: 'card', style: { padding: '22px' } },
            h('div', { style: { fontSize: '15px', fontWeight: '600', color: 'var(--crit-700)' } }, tr('Обзор не загрузился')),
            h('div', { class: 'muted', style: { fontSize: '13.5px', marginTop: '6px' } }, state.failed),
            h('button', { class: 'btn btn-outline btn-sm', type: 'button', style: { marginTop: '12px' },
                onclick: async () => { await load(); paint(root, onNavigate); } }, tr('Повторить'))));
        return;
    }
    const ov = state.ov;
    const a = ov.admission || {};
    const reload = async () => { await load(); paint(root, onNavigate); };
    const nav = (view, payload) => {
        const fn = onNavigate || (typeof window !== 'undefined' && window.easymed && window.easymed.navigate);
        if (fn) fn(view, payload);
    };
    const toDocs = (kind) => nav('case-file', kind ? { admissionId: a.id, kind } : { admissionId: a.id });
    const inBed = IN_BED_STATUSES.includes(a.status);
    const canRequest = ['admitted', 'examined', 'active'].includes(a.status);

    // «discharge button with generating the payments»
    const dischargeBtn = canRequest
        ? h('button', { class: 'btn btn-sm btn-outline', type: 'button',
            onclick: () => openAdmissionDischargeRequestModal({ admission: admissionForModals(ov), onDone: reload, generateBill: true }),
        }, Icon('Check', { size: 13 }), ' ', tr('Выписка'))
        : null;

    root.appendChild(caseHead(ov, { active: 'overview', onNavigate, onReload: reload, actions: [dischargeBtn] }));

    // ── статус ──────────────────────────────────────────────────────────────
    const d = ov.discharge || {};
    const statusBody = [
        kv(tr('Состояние'), admissionStatusLabel(a.status)),
        a.days ? kv(tr('В отделении'), trf('{n}-й день', { n: a.days })) : null,
        kv(tr('Вид госпитализации'), a.admission_type === 'emergency' ? tr('Экстренная') : tr('Плановая')),
        d.requested_at ? kv(tr('Заявка на выписку'), dt(d.requested_at)) : null,
        d.discharged_at ? kv(tr('Выписан'), dt(d.discharged_at)) : null,
    ];

    // ── диагноз ─────────────────────────────────────────────────────────────
    const dg = ov.diagnosis || {};
    const diagnosisBody = [
        kv(tr('При направлении'), dg.referral),
        dg.clinical ? kv(tr('Клинический'), dg.clinical) : kv(tr('Клинический'), h('span', { class: 'co-warn' }, tr('не установлен')), 'co-kv-warn'),
        dg.outcome ? kv(tr('Исход'), outcomeTitle(dg.outcome)) : null,
    ];

    // ── состояние при поступлении ───────────────────────────────────────────
    const ts = ov.title_sheet || {}; const s = ts.sheet || null;
    const stateBody = s ? [
        kv(tr('Температура'), s.temp_c !== null && s.temp_c !== undefined ? s.temp_c + ' °C' : ''),
        kv(tr('АД · пульс'), [s.bp_sys !== null && s.bp_sys !== undefined && s.bp_dia !== null && s.bp_dia !== undefined ? s.bp_sys + '/' + s.bp_dia : '', s.pulse_bpm !== null && s.pulse_bpm !== undefined ? s.pulse_bpm : ''].filter(Boolean).join(' · ')),
        kv(tr('Рост · вес · ИМТ'), [s.height_cm, s.weight_kg, ts.bmi].filter((x) => x !== null && x !== undefined && x !== '').join(' · ')),
        kv(tr('Группа крови и резус'), ov.patient && ov.patient.blood_type && ov.patient.blood_type !== 'unknown' ? ov.patient.blood_type : ''),
        ts.complete ? null : line(tr('Титульный лист заполнен не до конца.'), 'co-warn'),
    ] : [line(tr('Титульный лист не заполнен'), 'co-warn')];

    // ── питание ─────────────────────────────────────────────────────────────
    const diet = ov.diet || {}; const cur = diet.current; const meals = diet.meals_today || {};
    const mealsText = Object.keys(meals).length
        ? [['eaten', 'съедено'], ['partial', 'частично'], ['refused', 'отказ'], ['served', 'подано'], ['npo', 'НПО'], ['missed', 'пропущено'], ['waiting', 'ожидает']]
            .filter(([k]) => meals[k]).map(([k, w]) => tr(w) + ' ' + meals[k]).join(' · ')
        : tr('отметок нет');
    const dietBody = [
        cur ? kv(tr('Стол'), cur.name || cur.diet_code) : kv(tr('Стол'), h('span', { class: 'co-warn' }, tr('не назначен')), 'co-kv-warn'),
        cur && cur.since ? kv(tr('С какого времени'), dt(cur.since)) : null,
        kv(tr('Сегодня'), mealsText),
    ];

    // ── назначения ──────────────────────────────────────────────────────────
    const o = ov.orders || { active: 0, today: {}, list: [] };
    const t = o.today || {};
    const ordersBody = [
        kv(tr('Активных назначений'), String(o.active || 0)),
        kv(tr('Сегодня'), trf('введено {given} · назначено {due} · пропущено {missed} · отказ {refused}', {
            given: t.given || 0, due: t.due || 0, missed: t.missed || 0, refused: t.refused || 0 })),
        ...(o.list || []).map((r) => line([r.name, r.dose, r.route, r.prn ? tr('по требованию') : r.freq_code].filter(Boolean).join(' · '), 'co-item')),
    ];

    // ── услуги ──────────────────────────────────────────────────────────────
    const sv = ov.services || { count: 0, list: [] };
    const servicesBody = [
        kv(tr('Оказано'), String(sv.count || 0)),
        kv(tr('В счёте'), String(sv.billed || 0)),
        kv(tr('Не выставлено'), sv.unbilled ? trf('{n} на {sum}', { n: sv.unbilled, sum: sum(sv.sum_unbilled) }) : '0'),
        ...(sv.list || []).map((r) => line([r.name, r.quantity && r.quantity !== 1 ? '× ' + r.quantity : null, sum(r.total), r.invoiced ? tr('в счёте') : tr('не выставлено')].filter(Boolean).join(' · '), 'co-item')),
    ];

    // ── операция ────────────────────────────────────────────────────────────
    const op = ov.operation || { state: 'none' };
    const opWord = op.state === 'done' ? tr('Проведена') + (op.at ? ' · ' + dt(op.at) : '')
        : op.state === 'planned' ? tr('Запланирована') : tr('Не планируется');
    const operationBody = [
        kv(tr('Статус'), opWord),
        op.docs && op.docs.length ? kv(tr('Документы'), op.docs.map((k) => caseDocTitle(k)).join(', ')) : null,
        op.has_surgery_service ? line(tr('Операция есть в услугах госпитализации.')) : null,
    ];

    // ── счёт ────────────────────────────────────────────────────────────────
    const b = ov.bill || { invoices: [] }; const acc = b.accommodation;
    const billBody = [
        acc ? kv(tr('Койко-дней'), String(acc.stay_units || 0)) : null,
        acc && acc.current ? kv(tr('Проживание к оплате'), sum(acc.current.net)) : null,
        kv(tr('Счета'), trf('всего {total} · оплачено {paid} · долг {debt}', { total: sum(b.total), paid: sum(b.paid), debt: sum(b.debt) }), b.debt > 0 ? 'co-kv-warn' : ''),
        ...(b.invoices || []).map((i) => line([i.invoice_number, sum(i.total_amount), i.status].filter(Boolean).join(' · '), 'co-item')),
    ];

    // ── история болезни ─────────────────────────────────────────────────────
    const docs = ov.docs || { progress: {} }; const pr = docs.progress || {};
    const docsBody = [
        kv(tr('Оформлено'), trf('{done} из {total}', { done: pr.done || 0, total: pr.total || 0 })),
        pr.overdue ? kv(tr('Просрочено'), String(pr.overdue), 'co-kv-warn') : null,
        docs.next_kind ? kv(tr('Следующий шаг'), caseDocTitle(docs.next_kind)) : line(tr('Всё оформлено.')),
    ];

    // ── выписка ─────────────────────────────────────────────────────────────
    const dischargeBody = [
        d.status === 'discharged' ? kv(tr('Выписан'), [dt(d.discharged_at), d.outcome ? outcomeTitle(d.outcome) : ''].filter(Boolean).join(' · '))
            : d.status === 'discharging' ? kv(tr('Заявка подана'), [dt(d.requested_at), d.outcome ? outcomeTitle(d.outcome) : ''].filter(Boolean).join(' · '))
                : kv(tr('Заявка'), tr('не подана')),
        d.planned_at ? kv(tr('Плановая дата'), dt(d.planned_at)) : null,
        canRequest ? line(tr('Кнопка «Выписка» подаёт заявку и формирует счёт для кассы.')) : null,
    ];

    const grid = h('div', { class: 'co-grid' },
        block('Статус', 'Activity', statusBody),
        block('Диагноз', 'Stethoscope', diagnosisBody, { link: { label: tr('Документы'), onclick: () => toDocs(dg.clinical ? null : 'primary') }, tone: dg.clinical ? '' : 'warn' }),
        block('Состояние при поступлении', 'Thermo', stateBody, { link: { label: tr('Титульный лист'), onclick: () => toDocs('title') } }),
        block('Питание', 'Heart', dietBody, { link: inBed ? { label: tr('Назначить стол'), onclick: () => openAdmissionDietModal({ admission: admissionForModals(ov), current: cur, onDone: reload }) } : null }),
        block('Назначения', 'Pill', ordersBody, { link: { label: tr('Лист назначений'), onclick: () => goToMarSheet(a.id, onNavigate) } }),
        block('Услуги', 'Doc', servicesBody),
        block('Операция', 'Pulse', operationBody, { link: { label: tr('Документы'), onclick: () => toDocs('operation') } }),
        block('Счёт', 'Wallet', billBody, { tone: b.debt > 0 ? 'warn' : '' }),
        block('История болезни', 'Doc', docsBody, { link: { label: tr('Открыть'), onclick: () => toDocs(docs.next_kind || null) }, tone: pr.overdue ? 'warn' : '' }),
        block('Выписка', 'Check', dischargeBody, { link: canRequest ? { label: tr('Выписка'), onclick: () => openAdmissionDischargeRequestModal({ admission: admissionForModals(ov), onDone: reload, generateBill: true }) } : null }),
    );
    root.appendChild(grid);
}

export { goToCaseOverview };
