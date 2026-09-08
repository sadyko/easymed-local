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
/** Декоративная иконка: рядом всегда есть слово, читалке она не нужна. */
function ic(name, size = 14) {
    const el = Icon(name, { size });
    if (el && typeof el.setAttribute === 'function') el.setAttribute('aria-hidden', 'true');
    return el;
}

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
        'aria-label': trf('Открыть историю болезни: {name}', { name: p.full_name || '' }),   // инициалы читалке ничего не говорят
        style: { background: avColor(p.full_name || '?') }, onclick: () => toDocs(null),
    }, initials(p.full_name || '?'));
    const nameBtn = h('button', { class: 'co-name', type: 'button', onclick: () => toDocs(null) }, p.full_name || '—');

    // Стрелки по соседям — «navigation between the patients for the doctors».
    const prev = n.prev; const next = n.next;
    const navBox = h('div', { class: 'co-nav' },
        h('button', { class: 'btn btn-sm', type: 'button', disabled: prev ? null : '', title: prev ? prev.full_name : '',
            'aria-label': prev ? trf('Предыдущий пациент: {name}', { name: prev.full_name }) : tr('Предыдущего пациента нет'),
            onclick: () => { if (prev) nav('case-overview', { admissionId: prev.id }); } }, ic('ChevronLeft')),
        h('span', { class: 'co-nav-count' },
            n.total ? trf('{i} из {n}', { i: (n.index >= 0 ? n.index + 1 : 0), n: n.total }) : '',
            n.mine ? h('small', null, ' · ' + tr('мои пациенты')) : null),
        h('button', { class: 'btn btn-sm', type: 'button', disabled: next ? null : '', title: next ? next.full_name : '',
            'aria-label': next ? trf('Следующий пациент: {name}', { name: next.full_name }) : tr('Следующего пациента нет'),
            onclick: () => { if (next) nav('case-overview', { admissionId: next.id }); } }, ic('ChevronRight')));

    const allergy = p.allergies
        ? h('div', { class: 'co-allergy', role: 'note' }, ic('Warning'), ' ', trf('Аллергия: {what}', { what: p.allergies }))
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
        ic('Edit'), ' ', mainLabel);

    const tab = (id, label, icon, onclick) => h('button', {
        class: 'reg-tab' + (active === id ? ' on' : ''), type: 'button', role: 'tab',
        'aria-selected': active === id ? 'true' : 'false', onclick,
    }, ic(icon), ' ', tr(label));

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
                h('button', { class: 'btn btn-sm', type: 'button', onclick: () => goToMarSheet(a.id, onNavigate) }, ic('Pill', 13), ' ', tr('Лист назначений')),
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

// ---------------------------------------------------------------------------
// Панели обзора — Z-схема владельца
// ---------------------------------------------------------------------------
//   1 Пациент сейчас        2 Выписка и счёт
//   3 Четыре плитки         4 Операция
//   5 Назначения и услуги   6 Следующий шаг →
//
// Взгляд идёт большим блоком слева → маленьким справа → полосой плиток →
// большим блоком → маленьким со стрелкой действия. На узком экране блоки
// складываются в том же порядке 1…6 (grid-template-areas в admin-views.css).
function panel(title, { icon, area, tone = '', link = null, children = [] }) {
    return h('section', { class: 'card co-panel' + (tone ? ' co-' + tone : ''), style: { gridArea: area }, 'aria-label': tr(title) },
        h('header', { class: 'co-panel-h' },
            h('span', { class: 'co-panel-ic' }, ic(icon)),
            h('h2', { class: 'co-panel-t' }, tr(title)),
            h('span', { class: 'grow' }),
            link ? h('button', { class: 'co-link', type: 'button', onclick: link.onclick }, link.label, ic('ArrowRight', 12)) : null),
        h('div', { class: 'co-panel-b' }, ...children.filter(Boolean)));
}
const kv = (k, v, cls = '') => h('div', { class: 'co-kv' + (cls ? ' ' + cls : '') }, h('span', { class: 'co-k' }, k), h('span', { class: 'co-v' }, v || '—'));
const note = (text, tone = '') => h('p', { class: 'co-note' + (tone ? ' co-' + tone : '') }, text);
const num = (v) => (v === null || v === undefined || v === '' ? null : String(v));

/** Плитка полосы 3: цифра крупно, подпись сверху, строка под ней. Кнопка — если есть куда идти. */
function tile({ label, value, unit = '', meta = '', tone = '', onclick = null }) {
    const inner = [
        h('div', { class: 'stat-label' }, tr(label)),
        h('div', { class: 'stat-value co-tile-v' }, value, unit ? h('span', { class: 'unit' }, unit) : null),
        meta ? h('div', { class: 'co-tile-m' + (tone ? ' co-' + tone : '') }, meta) : null,
    ];
    return onclick
        ? h('button', { class: 'co-tile co-tile-btn', type: 'button', onclick }, ...inner)
        : h('div', { class: 'co-tile' }, ...inner);
}

function paint(root, onNavigate) {
    clear(root);
    if (state.failed) {
        root.appendChild(h('div', { class: 'card', style: { padding: '22px' } },
            h('div', { style: { fontSize: '15px', fontWeight: '600', color: 'var(--crit-700)' } }, tr('Обзор не загрузился')),
            h('div', { class: 'muted', style: { fontSize: '13.5px', marginTop: '6px' } }, state.failed),
            h('div', { class: 'muted', style: { fontSize: '13.5px', marginTop: '4px' } }, tr('Нажмите «Повторить». Если не помогает — обновите страницу.')),
            h('button', { class: 'btn btn-outline btn-sm', type: 'button', style: { marginTop: '12px' },
                onclick: async () => { await load(); paint(root, onNavigate); } }, tr('Повторить'))));
        return;
    }
    const ov = state.ov;
    const a = ov.admission || {};
    const pt = ov.patient || {};
    const reload = async () => { await load(); paint(root, onNavigate); };
    const nav = (view, payload) => {
        const fn = onNavigate || (typeof window !== 'undefined' && window.easymed && window.easymed.navigate);
        if (fn) fn(view, payload);
    };
    const toDocs = (kind) => nav('case-file', kind ? { admissionId: a.id, kind } : { admissionId: a.id });
    const inBed = IN_BED_STATUSES.includes(a.status);
    const canRequest = ['admitted', 'examined', 'active'].includes(a.status);
    const openDischarge = () => openAdmissionDischargeRequestModal({ admission: admissionForModals(ov), onDone: reload, generateBill: true });

    const dischargeBtn = canRequest
        ? h('button', { class: 'btn btn-sm btn-outline', type: 'button', onclick: openDischarge }, ic('Check', 13), ' ', tr('Выписка'))
        : null;
    root.appendChild(caseHead(ov, { active: 'overview', onNavigate, onReload: reload, actions: [dischargeBtn] }));

    // ── 1. Пациент сейчас ───────────────────────────────────────────────────
    const dg = ov.diagnosis || {};
    const ts = ov.title_sheet || {}; const sh = ts.sheet || null;
    const d = ov.discharge || {};
    const vital = (label, value) => h('div', { class: 'co-vital' },
        h('div', { class: 'co-vital-l' }, tr(label)),
        h('div', { class: 'co-vital-v' }, value || '—'));
    const bp = sh && num(sh.bp_sys) && num(sh.bp_dia) ? sh.bp_sys + '/' + sh.bp_dia : '';
    const hw = sh ? [num(sh.height_cm), num(sh.weight_kg)].filter(Boolean).join(' · ') : '';
    const nowPanel = panel('Пациент сейчас', { icon: 'Activity', area: 'now', tone: dg.clinical ? '' : 'warn',
        link: { label: tr('История болезни'), onclick: () => toDocs(null) },
        children: [
            h('div', { class: 'co-status-row' },
                Tag(admissionStatusLabel(a.status), { kind: d.status === 'discharging' ? 'warn' : (inBed ? 'ok' : ''), dot: true }),
                a.days ? h('span', { class: 'co-muted' }, trf('{n}-й день', { n: a.days })) : null,
                h('span', { class: 'co-muted' }, a.admission_type === 'emergency' ? tr('Экстренная') : tr('Плановая')),
                a.admitted_at && inBed ? h('span', { class: 'co-muted' }, trf('с {when}', { when: dt(a.admitted_at) })) : null),
            h('div', { class: 'co-dx' },
                h('div', { class: 'co-dx-l' }, tr('Клинический диагноз')),
                dg.clinical
                    ? h('div', { class: 'co-dx-v' }, dg.clinical)
                    : h('div', { class: 'co-dx-v co-warn' }, tr('Не установлен — нужен первичный осмотр'),
                        ' ', h('button', { class: 'co-link', type: 'button', onclick: () => toDocs('primary') }, tr('Открыть осмотр'), ic('ArrowRight', 12))),
                dg.referral ? h('div', { class: 'co-dx-s' }, trf('При направлении: {dx}', { dx: dg.referral })) : null,
                dg.outcome ? h('div', { class: 'co-dx-s' }, trf('Исход: {outcome}', { outcome: outcomeTitle(dg.outcome) })) : null),
            sh ? h('div', { class: 'co-vitals' },
                vital('Температура', num(sh.temp_c) ? sh.temp_c + ' °C' : ''),
                vital('АД', bp),
                vital('Пульс', num(sh.pulse_bpm)),
                vital('ИМТ', ts.bmi !== null && ts.bmi !== undefined ? String(ts.bmi) : ''),
                vital('Рост · вес', hw),
                vital('Группа крови', pt.blood_type && pt.blood_type !== 'unknown' ? pt.blood_type : ''))
                : note(tr('Титульный лист не заполнен — измерений при поступлении нет.'), 'warn'),
            sh && !ts.complete ? note(tr('Титульный лист заполнен не до конца.'), 'warn') : null,
        ] });

    // ── 2. Выписка и счёт ───────────────────────────────────────────────────
    const b = ov.bill || { invoices: [] }; const acc = b.accommodation;
    const sv = ov.services || { count: 0, list: [] };
    const big = b.total > 0
        ? (b.debt > 0
            ? { label: 'Долг', value: sum(b.debt), tone: 'crit' }
            : { label: 'Оплачено полностью', value: sum(b.paid), tone: 'ok' })
        : { label: 'Счетов пока нет', value: sv.sum_unbilled > 0 ? sum(sv.sum_unbilled) : '—', tone: '' , sub: sv.sum_unbilled > 0 ? tr('не выставлено') : '' };
    const billPanel = panel('Выписка и счёт', { icon: 'Wallet', area: 'bill', tone: b.debt > 0 ? 'crit' : '',
        children: [
            h('div', { class: 'co-big' + (big.tone ? ' co-' + big.tone : '') },
                h('div', { class: 'stat-label' }, tr(big.label)),
                h('div', { class: 'stat-value co-big-v' }, big.value),
                big.sub ? h('div', { class: 'co-tile-m' }, big.sub) : null),
            b.total > 0 ? kv(tr('Счета'), trf('всего {total} · оплачено {paid}', { total: sum(b.total), paid: sum(b.paid) })) : null,
            acc ? kv(tr('Койко-дней'), acc.current && acc.current.net ? trf('{n} · к оплате {sum}', { n: acc.stay_units || 0, sum: sum(acc.current.net) }) : String(acc.stay_units || 0)) : null,
            sv.unbilled ? kv(tr('Не выставлено'), trf('{n} на {sum}', { n: sv.unbilled, sum: sum(sv.sum_unbilled) }), 'co-kv-warn') : null,
            d.planned_at ? kv(tr('Плановая выписка'), dt(d.planned_at)) : null,
            d.status === 'discharging' ? kv(tr('Заявка подана'), [dt(d.requested_at), d.outcome ? outcomeTitle(d.outcome) : ''].filter(Boolean).join(' · ')) : null,
            d.status === 'discharged' ? kv(tr('Выписан'), [dt(d.discharged_at), d.outcome ? outcomeTitle(d.outcome) : ''].filter(Boolean).join(' · ')) : null,
            canRequest
                ? h('button', { class: 'btn btn-primary co-wide', type: 'button', onclick: openDischarge }, ic('Check'), ' ', tr('Выписать и выставить счёт'))
                : null,
            canRequest ? note(tr('Заявка уйдёт старшей медсестре, счёт — в кассу: проживание по сегодняшний день и все услуги.')) : null,
        ] });

    // ── 3. Плитки ───────────────────────────────────────────────────────────
    const o = ov.orders || { active: 0, today: {}, list: [] }; const t = o.today || {};
    const docs = ov.docs || { progress: {} }; const pr = docs.progress || {};
    const diet = ov.diet || {}; const cur = diet.current; const meals = diet.meals_today || {};
    const mealsText = Object.keys(meals).length
        ? [['eaten', 'съедено'], ['partial', 'частично'], ['refused', 'отказ'], ['served', 'подано'], ['npo', 'НПО'], ['missed', 'пропущено'], ['waiting', 'ожидает']]
            .filter(([k]) => meals[k]).map(([k, w]) => tr(w) + ' ' + meals[k]).join(' · ')
        : tr('отметок нет');
    const tiles = h('div', { class: 'co-tiles', style: { gridArea: 'tiles' } },
        tile({ label: 'День в отделении', value: a.days ? String(a.days) : '—', meta: a.admitted_at && inBed ? trf('с {when}', { when: dateNumeric(a.admitted_at) }) : '' }),
        tile({ label: 'Дозы сегодня', value: String(t.given || 0), unit: trf('из {n}', { n: t.due || 0 }),
            meta: t.missed ? trf('пропущено {n}', { n: t.missed }) : trf('назначений: {n}', { n: o.active || 0 }), tone: t.missed ? 'warn' : '',
            onclick: () => goToMarSheet(a.id, onNavigate) }),
        tile({ label: 'Документы', value: String(pr.done || 0), unit: trf('из {n}', { n: pr.total || 0 }),
            meta: pr.overdue ? trf('просрочено {n}', { n: pr.overdue }) : tr('в срок'), tone: pr.overdue ? 'warn' : 'ok',
            onclick: () => toDocs(docs.next_kind || null) }),
        tile({ label: 'Стол', value: cur ? (cur.name || cur.diet_code) : tr('не назначен'), meta: cur ? mealsText : tr('Назначить стол'), tone: cur ? '' : 'warn',
            onclick: inBed ? () => openAdmissionDietModal({ admission: admissionForModals(ov), current: cur, onDone: reload }) : null }));

    // ── 4. Операция ─────────────────────────────────────────────────────────
    const op = ov.operation || { state: 'none' };
    const opWord = op.state === 'done' ? tr('Проведена') : op.state === 'planned' ? tr('Запланирована') : tr('Не планируется');
    const opPanel = panel('Операция', { icon: 'Pulse', area: 'op',
        link: op.state !== 'none' ? { label: tr('Протокол'), onclick: () => toDocs('operation') } : null,
        children: [
            h('div', { class: 'co-op' + (op.state === 'done' ? ' co-ok' : op.state === 'planned' ? ' co-warn' : '') }, opWord),
            op.at ? kv(tr('Когда'), dt(op.at)) : null,
            op.docs && op.docs.length ? h('div', { class: 'co-chips' }, ...op.docs.map((k) => Tag(caseDocTitle(k), { kind: 'teal' }))) : null,
            op.has_surgery_service ? note(tr('Операция есть в услугах госпитализации.')) : null,
            op.state === 'none' ? note(tr('Появится, когда будет осмотр анестезиолога, предоперационный эпикриз или операция в услугах.')) : null,
        ] });

    // ── 5. Назначения и услуги ──────────────────────────────────────────────
    const orderRow = (r) => h('div', { class: 'co-row' },
        h('div', { class: 'co-row-main' },
            h('div', { class: 'co-row-t' }, r.name),
            h('div', { class: 'co-row-m' }, [r.dose, r.route, r.prn ? tr('по требованию') : r.freq_code].filter(Boolean).join(' · '))));
    const serviceRow = (r) => h('div', { class: 'co-row' },
        h('div', { class: 'co-row-main' },
            h('div', { class: 'co-row-t' }, r.name),
            h('div', { class: 'co-row-m' }, [r.quantity && r.quantity !== 1 ? '× ' + r.quantity : null, r.performed_at ? dt(r.performed_at) : null].filter(Boolean).join(' · '))),
        h('div', { class: 'co-row-sum' }, sum(r.total)),
        Tag(r.invoiced ? tr('в счёте') : tr('не выставлено'), { kind: r.invoiced ? 'ok' : 'warn' }));
    const col = (title, count, sub, rows, empty, foot) => h('div', { class: 'co-col' },
        h('div', { class: 'co-col-h' }, h('h3', { class: 'co-col-t' }, tr(title)), Tag(String(count), { kind: 'teal' })),
        sub ? h('div', { class: 'co-col-s' }, sub) : null,
        rows.length ? h('div', { class: 'co-rows' }, ...rows) : note(tr(empty)),
        foot);
    const listsPanel = panel('Назначения и услуги', { icon: 'Pill', area: 'lists', children: [
        h('div', { class: 'co-cols' },
            col('Назначения', o.active || 0,
                trf('Сегодня введено {given} из {due} · пропущено {missed} · отказ {refused}', { given: t.given || 0, due: t.due || 0, missed: t.missed || 0, refused: t.refused || 0 }),
                (o.list || []).map(orderRow), 'Назначений нет',
                h('button', { class: 'co-link', type: 'button', onclick: () => goToMarSheet(a.id, onNavigate) }, tr('Открыть лист назначений'), ic('ArrowRight', 12))),
            col('Услуги', sv.count || 0,
                trf('В счёте {billed} · не выставлено {unbilled} на {sum}', { billed: sv.billed || 0, unbilled: sv.unbilled || 0, sum: sum(sv.sum_unbilled) }),
                (sv.list || []).map(serviceRow), 'Услуг пока нет', null)),
    ] });

    // ── 6. Следующий шаг → ──────────────────────────────────────────────────
    const pct = pr.total ? Math.round(((pr.done || 0) / pr.total) * 100) : 0;
    const nextPanel = panel('Следующий шаг', { icon: 'Doc', area: 'next', tone: pr.overdue ? 'warn' : '', children: [
        docs.next_kind
            ? h('div', { class: 'co-next-doc' }, caseDocTitle(docs.next_kind))
            : h('div', { class: 'co-next-doc co-ok' }, tr('Все документы оформлены')),
        h('div', { class: 'co-progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(pr.total || 0), 'aria-valuenow': String(pr.done || 0),
            'aria-label': tr('Оформлено документов') },
            h('span', { class: 'co-progress-fill', style: { width: pct + '%' } })),
        h('div', { class: 'co-tile-m' + (pr.overdue ? ' co-warn' : '') },
            trf('Оформлено {done} из {total}', { done: pr.done || 0, total: pr.total || 0 }),
            pr.overdue ? ' · ' + trf('просрочено {n}', { n: pr.overdue }) : ''),
        h('button', { class: 'btn btn-primary co-wide', type: 'button', onclick: () => toDocs(docs.next_kind || null) },
            docs.next_kind ? tr('Заполнить документ') : tr('Открыть документы'), ' ', ic('ArrowRight')),
    ] });

    root.appendChild(h('div', { class: 'co-z' }, nowPanel, billPanel, tiles, opPanel, listsPanel, nextPanel));
}

export { goToCaseOverview };
