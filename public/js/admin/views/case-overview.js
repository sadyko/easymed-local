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
import { news2Score, NEWS_BANDS, VITAL_NORMS, CONSCIOUSNESS, vitalError } from '../../shared/news2.js';   // VITALS_NEWS_V1
import { inpatientModal, patientAnchor } from './inpatient-modal.js';   // VITALS_NEWS_V1 — окно «Добавить измерение»
import { field } from '../ui.js';

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
    // CASE_HEAD_TRIM_V1 — пациент ведёт на другой экран пары: с обзора — в
    // документы, из документов — обратно в обзор. Вкладок в шапке больше нет
    // (владелец: «remove this 2 buttons»), это единственная дверь между ними.
    const toOther = () => (active === 'documents' ? toOverview() : toDocs(null));
    const otherTitle = active === 'documents' ? tr('Открыть обзор госпитализации') : tr('Открыть историю болезни');
    const inBed = IN_BED_STATUSES.includes(a.status);
    const age = ageOf(p.date_of_birth, ov.now);
    const who = [genderWord(p.gender), age !== null ? trf('{n} лет', { n: age }) : null, p.mrn].filter(Boolean).join(' · ');

    const tone = a.status === 'discharging' ? 'warn' : (inBed ? 'ok' : '');
    const chip = Tag(admissionStatusLabel(a.status), { kind: tone, dot: true });
    const dayTag = a.days ? h('span', { class: 'co-day' }, trf('{n}-й день', { n: a.days })) : null;

    // Пациент — ЯКОРЬ и дверь в документы: «when patient pressed it should open a cabinet like documents section».
    const avatar = h('button', {
        class: 'co-av', type: 'button', title: otherTitle,
        'aria-label': otherTitle + ': ' + (p.full_name || ''),   // инициалы читалке ничего не говорят
        style: { background: avColor(p.full_name || '?') }, onclick: toOther,
    }, initials(p.full_name || '?'));
    const nameBtn = h('button', { class: 'co-name', type: 'button', title: otherTitle, onclick: toOther }, p.full_name || '—');

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

    // CASE_HEAD_TIDY_V1 / CASE_HEAD_ACTION_V2 — владелец: «tidy up this section
    // and make discharge main button in the header» → «discharge should be in
    // the header's right bottom». Главное действие стоит в ПРАВОМ НИЖНЕМ углу
    // шапки — в конце строки фактов, прижатое вправо; стрелки по соседям —
    // справа вверху. Полоса фактов — компактная строка без отдельного «подвала».
    const acts = actions.filter(Boolean);
    return h('div', { class: 'co-head card' },
        h('div', { class: 'co-head-row' },
            avatar,
            h('div', { class: 'co-pat' },
                h('div', { class: 'co-name-row' }, nameBtn, chip, dayTag),
                h('div', { class: 'co-sub muted' }, who || '—'),
                allergy),
            h('div', { class: 'co-head-side' }, navBox)),
        h('div', { class: 'co-fields' },
            hf('№ истории', a.admission_no),
            hf('Поступление', a.admitted_at && inBed ? dt(a.admitted_at) : (a.admitted_at && a.status === 'discharged' ? dt(a.admitted_at) : '—')),
            hf('Отделение · койка', place),
            // ADMITTING_DOCTOR_V1 — приёмный врач стоит рядом с лечащим: пока
            // лечащего нет, именно его ждут с осмотром при поступлении.
            a.admitting_name ? hf('Приёмный врач', a.admitting_name) : null,
            attending,
            hf('Плановая выписка', a.planned_discharge_at ? dt(a.planned_discharge_at) : (a.discharged_at ? tr('выписан') + ' ' + dt(a.discharged_at) : '—')),
            acts.length ? h('div', { class: 'co-fields-act co-actions' }, ...acts) : null));
}

// ---------------------------------------------------------------------------
// Экран «Обзор»
// ---------------------------------------------------------------------------
export async function renderCaseOverview(container, { payload, onNavigate } = {}) {
    // CASE_ROUTE_SUB_V1 — номер госпитализации едет и в адресе (#case-overview/123,
    // payload.sub). Владелец: «sometimes this error occurs» — «Госпитализация
    // не выбрана» появлялась после перезагрузки страницы: адрес помнил экран,
    // но не пациента. Теперь адрес помнит обоих, а без номера обзор не
    // рисует тупик, а уводит в список пациентов стационара.
    const admissionId = Number(payload && (payload.admissionId || payload.admission_id || payload.id || payload.sub)) || null;
    clear(container);
    const root = h('div', { class: 'fade-in co' });
    container.appendChild(root);
    if (!admissionId) {
        const fn = onNavigate || (typeof window !== 'undefined' && window.easymed && window.easymed.navigate);
        root.appendChild(h('div', { class: 'card', style: { padding: '22px' } },
            h('div', { style: { fontSize: '15px', fontWeight: '600', color: 'var(--ink-900)' } }, tr('Госпитализация не выбрана')),
            h('div', { class: 'muted', style: { fontSize: '13.5px', marginTop: '6px' } },
                tr('Обзор открывают из списка пациентов в разделе «Стационар».')),
            h('button', { class: 'btn btn-primary', type: 'button', style: { marginTop: '12px' },
                onclick: () => { if (fn) fn('admissions', { sub: 'patients' }); } },
                ic('Bed', 14), ' ', tr('К списку пациентов'))));
        if (fn) setTimeout(() => fn('admissions', { sub: 'patients' }), 0);
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
function tile({ label, value, unit = '', meta = '', tone = '', onclick = null, text = false }) {
    const inner = [
        h('div', { class: 'stat-label' }, tr(label)),
        // Слово в плитке — не цифра: 24px для «Стол №1 (щадящий)» кричал бы, 17px читается.
        h('div', { class: 'stat-value co-tile-v' + (text ? ' co-tile-v-text' : '') }, value, unit ? h('span', { class: 'unit' }, unit) : null),
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

    // CASE_HEAD_TIDY_V1 — «make discharge main button … with pulsating»: выписка
    // — главное действие обзора, поэтому она первичная и «дышит» (btn-pulse:
    // мягкое кольцо; при «меньше движения» — просто обводка, без анимации).
    const dischargeBtn = canRequest
        ? h('button', { class: 'btn btn-primary btn-pulse', type: 'button', onclick: openDischarge, title: tr('Подать заявку на выписку и выставить счёт') }, ic('Check', 14), ' ', tr('Выписка'))
        : null;
    // CASE_HEAD_ACTION_V2 — «discharge should be in the header's right bottom»:
    // кнопка выписки — в правом нижнем углу шапки (конец строки фактов).
    root.appendChild(caseHead(ov, { active: 'overview', onNavigate, onReload: reload, actions: [dischargeBtn] }));

    // ── 0. Показатели и NEWS (VITALS_NEWS_V1) — во всю ширину над сеткой ────
    root.appendChild(vitalsPanel(ov, {
        onAdd: () => openVitalsModal({ admission: admissionForModals(ov), onDone: reload }),
    }));

    // ── 1. Пациент сейчас ───────────────────────────────────────────────────
    const dg = ov.diagnosis || {};
    const ts = ov.title_sheet || {}; const sh = ts.sheet || null;
    const d = ov.discharge || {};
    const vital = (label, value) => h('div', { class: 'co-vital' },
        h('div', { class: 'co-vital-l' }, tr(label)),
        h('div', { class: 'co-vital-v' }, value || '—'));
    // VITALS_NEWS_V1 — температура, АД и пульс переехали в панель показателей
    // (там они в динамике); здесь остаётся антропометрия и группа крови.
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
                vital('ИМТ', ts.bmi !== null && ts.bmi !== undefined ? String(ts.bmi) : ''),
                vital('Рост · вес', hw),
                vital('Группа крови', pt.blood_type && pt.blood_type !== 'unknown' ? pt.blood_type : ''))
                : note(tr('Титульный лист не заполнен — измерений при поступлении нет.'), 'warn'),
            sh && !ts.complete ? note(tr('Титульный лист заполнен не до конца.'), 'warn') : null,
        ] });

    // ── 2. Выписка и счёт ───────────────────────────────────────────────────
    const b = ov.bill || { invoices: [] }; const acc = b.accommodation;
    const sv = ov.services || { count: 0, list: [] };
    // DEBT_FLOW_V1 — «Долг» только когда он ОФОРМЛЕН (счёт со статусом debt);
    // пока пациент лежит, неоплаченный счёт — «К оплате», и это не тревога.
    const big = b.total > 0
        ? (b.debt_marked > 0
            ? { label: 'Долг', value: sum(b.debt_marked), tone: 'crit' }
            : b.debt > 0
                ? { label: 'К оплате', value: sum(b.debt), tone: 'warn' }
                : { label: 'Оплачено полностью', value: sum(b.paid), tone: 'ok' })
        : { label: 'Счетов пока нет', value: sv.sum_unbilled > 0 ? sum(sv.sum_unbilled) : '—', tone: '' , sub: sv.sum_unbilled > 0 ? tr('не выставлено') : '' };
    const billPanel = panel('Выписка и счёт', { icon: 'Wallet', area: 'bill', tone: b.debt_marked > 0 ? 'crit' : (b.debt > 0 ? 'warn' : ''),
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
        tile({ label: 'Стол', value: cur ? (cur.name || cur.diet_code) : tr('не назначен'), text: true,
            meta: cur ? mealsText : (inBed ? tr('Назначить стол') : ''), tone: cur ? '' : 'warn',
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

// ---------------------------------------------------------------------------
// VITALS_NEWS_V1 — панель «Показатели»: балл NEWS2, динамика, плитки.
//
// Владелец (2026-09-08): «dashboard like this» — скриншот: баннер риска с
// баллом, рекомендацией и чипами по параметрам; справа динамика NEWS; ниже
// пять плиток (температура, АД, пульс, ЧДД, SpO₂) с искоркой и нормой;
// кнопка «Добавить измерение». Шкала и нормы — shared/news2.js: та же, что
// считает сервер, так что цифра на экране совпадает с цифрой в ответе RPC.
// ---------------------------------------------------------------------------
const VT_TILES = [
    { key: 'temp_c',    label: 'Температура', icon: 'Thermo',   norm: VITAL_NORMS.temp_c,    fmt: (v) => String(v).replace('.', ',') + ' °C' },
    { key: 'bp',        label: 'АД',          icon: 'Activity', norm: VITAL_NORMS.bp,        fmt: (v, r) => r.bp_sys + '/' + r.bp_dia, series: (r) => r.bp_sys, points: (n) => n.parts.bp_sys },
    { key: 'pulse_bpm', label: 'Пульс',       icon: 'Heart',    norm: VITAL_NORMS.pulse_bpm, fmt: (v) => v + ' ' + tr('уд') },
    { key: 'resp_rate', label: 'ЧДД',         icon: 'Pulse',    norm: VITAL_NORMS.resp_rate, fmt: (v) => v + ' /' + tr('мин') },
    { key: 'spo2',      label: 'SpO₂',        icon: 'Flask',    norm: VITAL_NORMS.spo2,      fmt: (v) => v + ' %' },
];
const CONSCIOUSNESS_RU = { alert: 'ясное', confused: 'спутанное', voice: 'реагирует на голос', pain: 'реагирует на боль', unresponsive: 'без сознания' };
const isNumV = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));

/** Искорка: SVG-ломаная по значениям (последние точки). Одна точка — кружок. */
function sparkline(values, { w = 120, hgt = 34 } = {}) {
    const pts = values.filter(isNumV).map(Number);
    if (!pts.length) return h('svg', { class: 'vt-spark', viewBox: '0 0 ' + w + ' ' + hgt, 'aria-hidden': 'true' });
    const min = Math.min(...pts), max = Math.max(...pts);
    const span = max - min || 1;
    const x = (i) => (pts.length === 1 ? w / 2 : 4 + (i * (w - 8)) / (pts.length - 1));
    const y = (v) => hgt - 4 - ((v - min) / span) * (hgt - 8);
    const d = pts.map((v, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1)).join(' ');
    const lastX = x(pts.length - 1), lastY = y(pts[pts.length - 1]);
    return h('svg', { class: 'vt-spark', viewBox: '0 0 ' + w + ' ' + hgt, 'aria-hidden': 'true' },
        pts.length > 1 ? h('path', { d, fill: 'none', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }) : null,
        h('circle', { cx: lastX.toFixed(1), cy: lastY.toFixed(1), r: '3' }));
}

const pointsTone = (p) => (p === null || p === undefined ? '' : p >= 3 ? 'crit' : p === 2 ? 'warn2' : p === 1 ? 'warn' : 'ok');
const trendText = (t) => (t > 0 ? '▲ ' + trf('ухудшение +{n} за период', { n: t }) : t < 0 ? '▼ ' + trf('улучшение {n} за период', { n: t }) : tr('без изменений за период'));

export function vitalsPanel(ov, { onAdd } = {}) {
    const v = ov.vitals || { series: [], last: null, prev: null, news: news2Score({}), trend: 0, can_add: false, count: 0 };
    const last = v.last;
    const news = (last && last.news) || v.news || news2Score({});
    const band = NEWS_BANDS[news.band] || NEWS_BANDS.none;
    const addBtn = v.can_add
        ? h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: onAdd }, ic('Plus', 13), ' ', tr('Добавить измерение'))
        : null;
    const when = last && last.measured_at ? fmtDateTime(last.measured_at) : '';
    const who = last && last.source === 'title' ? tr('при поступлении (титульный лист)') : (last && last.measured_by_name) || '';
    const head = h('div', { class: 'vt-head' },
        h('div', { class: 'vt-title' }, tr('Показатели'),
            when ? h('span', { class: 'vt-title-m' }, ' · ' + tr('последнее измерение') + ' ' + when + (who ? ' · ' + who : '')) : null),
        h('span', { class: 'grow' }),
        addBtn);

    if (!last) {
        return h('section', { class: 'card vt-card vt-empty', 'aria-label': tr('Показатели') }, head,
            h('div', { class: 'vt-none' },
                h('div', { class: 'vt-none-t' }, tr('Измерений ещё нет')),
                h('div', { class: 'co-muted' }, v.can_add
                    ? tr('Первое измерение открывает динамику: температура, АД, пульс, ЧДД и SpO₂ — и балл NEWS по ним.')
                    : tr('Измерения вносят, пока пациент на койке.'))));
    }

    // Чипы по параметрам: значение и очки. Порядок — как на скриншоте.
    const chip = (label, value, pts) => h('span', { class: 'vt-chip' + (pts ? ' vt-' + pointsTone(pts) : ''), title: label },
        label + ' ' + value + ' (' + (pts > 0 ? '+' + pts : '0') + ')');
    const p = news.parts || {};
    const chips = [
        isNumV(last.resp_rate) ? chip(tr('ЧДД'), last.resp_rate, p.resp_rate) : null,
        isNumV(last.spo2) ? chip('SpO₂', last.spo2, p.spo2) : null,
        isNumV(last.temp_c) ? chip(tr('Темп'), String(last.temp_c).replace('.', ','), p.temp_c) : null,
        isNumV(last.bp_sys) ? chip(tr('АД'), last.bp_sys, p.bp_sys) : null,
        isNumV(last.pulse_bpm) ? chip(tr('Пульс'), last.pulse_bpm, p.pulse_bpm) : null,
        last.consciousness ? chip(tr('Сознание'), tr(CONSCIOUSNESS_RU[last.consciousness] || last.consciousness), p.consciousness) : null,
        h('span', { class: 'vt-chip' + (p.on_oxygen ? ' vt-warn2' : '') }, 'O₂ ' + (last.on_oxygen ? tr('да') : tr('нет')) + ' (' + (p.on_oxygen ? '+2' : '0') + ')'),
    ].filter(Boolean);
    const totals = (v.series || []).map((r) => (r.news ? r.news.total : null));
    const banner = h('div', { class: 'vt-banner vt-band-' + news.band },
        h('div', { class: 'vt-score' }, h('b', null, String(news.total)), h('small', null, 'NEWS')),
        h('div', { class: 'vt-band' },
            h('div', { class: 'vt-band-t' }, tr(band.label), news.complete ? null : h('span', { class: 'vt-partial' }, ' · ' + tr('измерение неполное'))),
            h('div', { class: 'vt-band-a' }, tr(band.advice)),
            h('div', { class: 'vt-chips' }, ...chips)),
        h('div', { class: 'vt-trend' },
            h('div', { class: 'vt-trend-l' }, tr('Динамика NEWS')),
            sparkline(totals, { w: 120, hgt: 30 }),
            h('div', { class: 'vt-trend-v ' + (v.trend > 0 ? 'vt-worse' : v.trend < 0 ? 'vt-better' : '') }, trendText(v.trend || 0))));

    const tiles = h('div', { class: 'vt-tiles' }, ...VT_TILES.map((t) => {
        const getVal = t.key === 'bp' ? (r) => (isNumV(r.bp_sys) && isNumV(r.bp_dia) ? r.bp_sys : null) : (r) => r[t.key];
        const pts = t.points ? t.points(news) : p[t.key];
        const cur = getVal(last);
        const has = isNumV(cur);
        const series = (v.series || []).map(t.series || getVal);
        return h('div', { class: 'vt-tile' + (has ? ' vt-' + pointsTone(pts) : ' vt-none') },
            h('div', { class: 'vt-tile-top' },
                h('span', { class: 'vt-tile-ic' }, ic(t.icon, 15)),
                h('span', { class: 'vt-pts' }, has && pts !== null && pts !== undefined ? (pts > 0 ? '+' + pts : '0') : '—')),
            h('div', { class: 'vt-val' }, has ? t.fmt(cur, last) : '—'),
            h('div', { class: 'vt-lab' }, tr(t.label)),
            sparkline(series),
            h('div', { class: 'vt-norm' }, tr('норма') + ' ' + t.norm));
    }));

    return h('section', { class: 'card vt-card', 'aria-label': tr('Показатели') }, head, banner, tiles);
}

// ── Окно «Добавить измерение» ─────────────────────────────────────────────
function nowLocalInput() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}
function localToIso(value) {
    if (!value) return null;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 19) + 'Z';
}

export function openVitalsModal({ admission, onDone } = {}) {
    if (!admission || !admission.id) { toast(tr('Госпитализация не выбрана.'), 'fail'); return null; }
    const p = admission.patients || {};
    const numInput = (key, ph, step = '1') => h('input', { type: 'number', step, inputmode: 'decimal', placeholder: ph, class: 'vt-in', 'data-key': key });
    const temp = numInput('temp_c', '36,6', '0.1');
    const sys = numInput('bp_sys', '120');
    const dia = numInput('bp_dia', '80');
    const pulse = numInput('pulse_bpm', '72');
    const resp = numInput('resp_rate', '16');
    const spo2 = numInput('spo2', '98');
    const oxygen = h('input', { type: 'checkbox' });
    const consc = h('select', null, ...CONSCIOUSNESS.map((c) => h('option', { value: c }, tr(CONSCIOUSNESS_RU[c]))));
    const at = h('input', { type: 'datetime-local', value: nowLocalInput() });
    const noteInput = h('input', { placeholder: tr('Например: после капельницы') });
    const preview = h('div', { class: 'vt-preview' }, '');

    const read = () => ({
        temp_c: temp.value, bp_sys: sys.value, bp_dia: dia.value, pulse_bpm: pulse.value,
        resp_rate: resp.value, spo2: spo2.value, on_oxygen: !!oxygen.checked, consciousness: consc.value || 'alert',
    });
    const repaint = () => {
        const vals = read();
        const s = news2Score(vals);
        const band = NEWS_BANDS[s.band] || NEWS_BANDS.none;
        // Сознание выбрано всегда — балл показываем, только когда есть хоть одно число.
        const any = ['temp_c', 'bp_sys', 'pulse_bpm', 'resp_rate', 'spo2'].some((k) => isNumV(vals[k]));
        preview.textContent = any
            ? 'NEWS ' + s.total + ' · ' + tr(band.label) + (s.complete ? '' : ' · ' + tr('измерение неполное'))
            : tr('Внесите хотя бы один показатель — балл посчитается сразу.');
        preview.className = 'vt-preview vt-band-' + s.band;
    };
    for (const el of [temp, sys, dia, pulse, resp, spo2, oxygen, consc]) el.addEventListener('input', repaint);
    for (const el of [oxygen, consc]) el.addEventListener('change', repaint);
    repaint();

    const row = (...els) => h('div', { class: 'vt-form-row' }, ...els);
    return inpatientModal(tr('Добавить измерение'), 'Activity', [
        patientAnchor(p.full_name || '', [p.mrn, admission.admission_no].filter(Boolean).join(' · ')),
        row(field(tr('Температура, °C'), temp), field(tr('Пульс, уд/мин'), pulse), field(tr('ЧДД, /мин'), resp)),
        row(field(tr('АД систолическое'), sys), field(tr('АД диастолическое'), dia), field('SpO₂, %', spo2)),
        row(field(tr('Сознание'), consc), h('label', { class: 'vt-check' }, oxygen, ' ', tr('Дополнительный кислород'))),
        row(field(tr('Время измерения'), at), field(tr('Примечание'), noteInput)),
        preview,
    ], tr('Записать'), async () => {
        const vals = read();
        for (const key of ['temp_c', 'bp_sys', 'bp_dia', 'pulse_bpm', 'resp_rate', 'spo2']) {
            const err = vitalError(key, vals[key]);
            if (err) { toast(tr('Проверьте значение') + ': ' + err, 'fail'); return false; }
        }
        // Время — из поля; пустое или испорченное поле означает «сейчас» (как и на сервере).
        const measuredAt = localToIso(at.value) || new Date().toISOString().slice(0, 19) + 'Z';
        const { data, error } = await supabase.rpc('admission_vitals_add', Object.assign({}, vals, {
            admission_id: admission.id, measured_at: measuredAt, note: noteInput.value || '',
        }));
        if (error || !data) { toast((error && error.message) || tr('Не удалось записать измерение.'), 'fail'); return false; }
        const s = (data.vital && data.vital.news) || news2Score(vals);
        const band = NEWS_BANDS[s.band] || NEWS_BANDS.none;
        toast(trf('Измерение записано. NEWS {n} — {band}.', { n: s.total, band: tr(band.label) }), s.band === 'high' || s.band === 'medium' ? 'warn' : 'ok');
        if (onDone) await onDone();
        return true;
    }, { width: 640 });
}
