// Service workspace — the in-room screen the doctor / lab tech opens for a
// single service in their "My services" queue. 3-column layout:
//   left   = patient context (vitals, conditions, recent labs)
//   center = SOAP note / Diagnosis / Prescription / Lab orders / Follow-up
//   right  = Notes history · AI assistant · Refer to · Care team
//
// Opened from My services by clicking the patient name. Payload is a
// patient view-model (with optional `__service` info merged in by the caller).
// Falls back gracefully when fields are missing.

import { supabase } from '../../supabase.js';
import { h, Icon, Avatar, Tag, StatusTag, clear, toast } from '../ui.js';
import { tr, trf } from '../i18n.js';   // I18N_COVERAGE_V1 — перевод СНАЧАЛА, подстановка ПОТОМ
import { openServicePickerModal } from './service-picker-modal.js?v=aug17e';
import { openItemPickerModal } from './item-picker-modal.js?v=billoptin1';   // DISPENSE_ITEM_V1
import { logPatientActivity } from './activity-log.js';
import { canDelete as canDeleteRole, patientTabCanEdit } from '../permissions.js';
import { openAdmissionRegistrarModal } from './admission-modal.js?v=aug17e';
import { insertRow, currentUser } from '../data.js';   // AURORA_CONSULT_TOOLBAR_V1 + AURORA_CONSULT_TEMPLATES_V1
import { currentClinicId } from '../tenant-tables.js';   // AURORA_CONSULT_TOOLBAR_V1
import { BRANCH_BUCKET, signedUrl } from '../storage.js?v=aurora20b';   // SLICED2_PRINT_HEADER (dynamic company name + logo)
import { printableSheet, loadDocSettings } from './doc-settings.js?v=q3company1';   // UNIFY_PRINT_V1 — ?v=db9 must match in EVERY importer
import { renderDesignedVariant } from './doc-variants.js?v=labref19a';   // WYSIWYG_BLANK_V1 — stateless renderer, own ?v is safe (STAMP_ONLY_V1)
import { openVitalsDialog } from './patient-card.js?v=labshared1';   // CARD_SPEC_V1 — same URL as admin.js (one instance)
import { serviceGroupLabel } from './service-group.js?v=aug17e';   // SERVICE_GROUPS_V1 — chips must survive a NULL type_id
import { PRINT_FONT_FACE_CSS } from '../../shared/print-fonts.js';   // ONEST_TYPOGRAPHY_V1 — @font-face для печатных окон

// AURORA_REAL_VITALS_V1 — the vitals strip is filled async from patient_vitals (see vitalsStrip / loadVitals).

// AURORA_A4_PAGINATE_V1 — show «разрыв страницы» guides in the A4 sheet when the document
// is taller than one A4 page, breaking BETWEEN sections (never mid-section).
const A4_PAGE_H = 1000;            // ~A4 content height @96dpi (leaves room for page margins)
let _a4Sig = '';
function _a4NaturalSig(paper) {
    return Array.from(paper.children)
        .filter(el => !el.classList.contains('a4-pbreak'))
        .map(el => Math.round(el.offsetHeight)).join(',');
}
function makeA4Break(pg, fill) {
    return h('div', { class: 'a4-pbreak', contenteditable: 'false', style: { height: Math.round(fill) + 'px' } },
        h('span', { class: 'a4-pbreak-tag' }, 'Разрыв страницы · Sahifa ' + pg));   // i18n-exempt: метка листа ДОКУМЕНТА — двуязычная (ru+uz) по замыслу бланка
}
function paginateA4(paper) {
    if (!paper || !paper.isConnected) return;
    const sig = _a4NaturalSig(paper);
    if (sig === _a4Sig) return;     // real content unchanged — ignore our own break-induced resizes
    _a4Sig = sig;
    paper.querySelectorAll('.a4-pbreak').forEach(el => el.remove());
    let used = 0, pg = 1; const ops = [];
    for (const el of Array.from(paper.children)) {
        const cs = getComputedStyle(el);
        const h0 = el.offsetHeight + (parseFloat(cs.marginTop) || 0) + (parseFloat(cs.marginBottom) || 0);
        if (used > 0 && used + h0 > A4_PAGE_H) { pg++; ops.push({ before: el, fill: Math.max(A4_PAGE_H - used, 28), pg }); used = h0; }
        else { used += h0; }
    }
    for (const op of ops) paper.insertBefore(makeA4Break(op.pg, op.fill), op.before);
}
let _a4Obs = null, _a4Timer = null;
function setupA4Pagination(root) {
    const paper = root.querySelector('.a4-paper');
    if (!paper) return;
    const sched = () => { clearTimeout(_a4Timer); _a4Timer = setTimeout(() => paginateA4(paper), 200); };
    if (_a4Obs) { try { _a4Obs.disconnect(); } catch (e) {} _a4Obs = null; }
    if (typeof ResizeObserver !== 'undefined') { _a4Obs = new ResizeObserver(sched); _a4Obs.observe(paper); }
    paper.addEventListener('input', sched);
    setTimeout(() => paginateA4(paper), 350);   // catch async hydrate
    setTimeout(() => paginateA4(paper), 1200);  // catch EMR fill
}


// WS_RESPONSIVE_V1 — collapsible side panels + responsive grid for small monitors.
function wsLayoutState() {
    try { const raw = localStorage.getItem('em-ws-layout'); if (raw) return JSON.parse(raw); } catch (e) {}
    const wide = (typeof window !== 'undefined' ? (window.innerWidth || 1440) : 1440) >= 1180;
    return { left: wide, right: wide };
}
function saveWsLayout(st) { try { localStorage.setItem('em-ws-layout', JSON.stringify(st)); } catch (e) {} }
function ensureWsStyle() {
    if (typeof document === 'undefined' || document.getElementById('ws3-style')) return;
    const el = document.createElement('style'); el.id = 'ws3-style';
    el.textContent =
        '.ws3{display:grid;gap:16px;align-items:start;grid-template-columns:minmax(0,1fr) clamp(300px,26vw,400px);}' +
        '.ws3.ws3--nr{grid-template-columns:minmax(0,1fr);}' +
        '.ws3>.ws-hide{display:none!important;}' +
        '.a4-sec-add{display:none;}' +
        '.a4-sec-off>.a4-sec-tag,.a4-sec-off>.a4-sec-x,.a4-sec-off>.a4-input{display:none!important;}' +
        '.a4-sec-off>.a4-sec-add{display:block;width:100%;text-align:left;padding:8px 12px;margin:3px 0;border:1px dashed var(--ink-200);border-radius:8px;background:var(--ink-25);color:var(--ink-500);font:inherit;font-size:12px;font-weight:600;cursor:pointer;}' +
        '.a4-sec-off>.a4-sec-add:hover{border-color:var(--primary-300);color:var(--primary-700);}' +
        '.a4-sec-x{position:absolute;top:2px;right:2px;border:0;background:transparent;color:var(--ink-300);font-size:15px;line-height:1;cursor:pointer;padding:2px 6px;border-radius:6px;z-index:2;}' +
        '.a4-sec-x:hover{color:var(--crit-600);background:var(--ink-50);}' +
        '.ws-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end;}' +
        '.ws-tg{display:inline-flex;align-items:center;gap:6px;font:inherit;font-size:12.5px;font-weight:560;padding:6px 12px;border:1px solid var(--ink-200);border-radius:999px;background:var(--surface,#fff);color:var(--ink-700);cursor:pointer;transition:border-color .14s,background .14s,color .14s;}' +
        '.ws-tg:hover{border-color:var(--primary-300);}' +
        '.ws-tg.off{color:var(--ink-400);background:var(--ink-25);}' +
        '.ws-tg svg{width:14px;height:14px;}' +
        '.ws-topcard{padding:12px 16px;}' +
        '.ws-topbar-row{display:flex;align-items:center;gap:10px 24px;flex-wrap:wrap;justify-content:space-between;}' +
        '.ws-patient-block{display:flex;flex-direction:column;gap:4px;min-width:0;}' +
        '.ws-pb-row1{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;}' +
        '.ws-pb-row1>b{font-size:15px;color:var(--ink-900);}' +
        '.ws-pb-row2{display:flex;align-items:center;gap:6px 14px;flex-wrap:wrap;font-size:12.5px;color:var(--ink-700);}' +
        '.ws-topchip b{color:var(--ink-500);font-weight:600;}' +
        '.ws-topbtns{display:flex;align-items:center;gap:6px;flex-shrink:0;flex-wrap:wrap;}' +
        // WS_DOCBAR_RESPONSIVE_V1 — patient group + controls group each wrap; reflow by width
        '.ws-docbar-left{display:flex;align-items:center;flex-wrap:wrap;gap:8px 12px;min-width:0;flex:1 1 300px;}' +
        '.ws-docbar-right{display:flex;align-items:center;flex-wrap:wrap;gap:8px;justify-content:flex-end;flex:1 1 auto;}' +
        '.ws-doctype-lbl{font-size:12px;font-weight:600;color:var(--ink-700);white-space:nowrap;}' +
        '.ws-pb-row1>b{overflow-wrap:anywhere;}' +
        '.ws-patient-block{flex:1 1 auto;}' +
        '.doc-bar select{max-width:100%;}' +
        '.ws-rtab-body{margin-top:12px;padding-top:10px;border-top:1px solid var(--ink-100);max-height:300px;overflow:auto;}' +
        '.a4-scroll{padding:12px !important;}' +   // WS_TOPLINE_V1 — a little more room for the document
        '.ws-savemark{display:inline-flex;align-items:center;gap:4px;font-size:12px;font-weight:600;padding:3px 10px;border-radius:999px;white-space:nowrap;}' +
        '.ws-savemark.saved{color:var(--ok-700,#15803d);background:var(--ok-50,#f0fdf4);}' +
        '.ws-savemark.unsaved{color:var(--crit-700,#b91c1c);background:var(--crit-50,#fef2f2);}' +
        '.ws-savemark svg{width:13px;height:13px;}' +
        '@media(max-width:900px){.ws3,.ws3.ws3--nl,.ws3.ws3--nr{grid-template-columns:minmax(0,1fr)!important;}.ws3>*{position:static!important;}}';
    document.head.appendChild(el);
}
function wsToggleChip(gridEl, side, label) {
    const st = wsLayoutState();
    const chip = h('button', { class: 'ws-tg' + (st[side] ? '' : ' off'), type: 'button',
        title: st[side] ? tr('Скрыть боковую панель') : tr('Показать боковую панель') },
        Icon(side === 'left' ? 'ChevronLeft' : 'ChevronRight', { size: 14 }), label);
    chip.addEventListener('click', function () {
        const s2 = wsLayoutState(); s2[side] = !s2[side]; saveWsLayout(s2);
        gridEl.classList.toggle('ws3--nl', !s2.left);
        gridEl.classList.toggle('ws3--nr', !s2.right);
        const panel = gridEl.querySelector('[data-ws-' + side + ']');
        if (panel) panel.classList.toggle('ws-hide', !s2[side]);
        chip.classList.toggle('off', !s2[side]);
        chip.title = s2[side] ? tr('Скрыть боковую панель') : tr('Показать боковую панель');
    });
    return chip;
}

export function renderServiceWorkspace(container, { onNavigate, payload }) {
    clear(container);
    if (!payload) {
        container.appendChild(h('div', { class: 'empty', style: { padding: '60px' } },
            h('p', null, 'Пациент не выбран.'),
            h('p', { class: 'muted', style: { fontSize: '12.5px' } },
                'Откройте строку из «Мои услуги», чтобы начать.'),
            h('button', {
                class: 'btn btn-outline', style: { marginTop: '14px' },
                onclick: () => onNavigate && onNavigate('consultation'),
            }, '← К моим услугам'),
        ));
        return;
    }
    const p = payload;
    const ctx = {
        container,
        onNavigate,
        visitServiceId: p.__service?.id || null,
        visitId:        p.__service?.visitId || null,
        patient:        p,
    };
    // Reset the per-workspace cache so a navigation away + back can't show
    // someone else's history while we re-hydrate.
    wsState.payload = null;
    wsState.saved = false;
    wsState.docSections = new Set(DOC_SECTIONS_DEFAULT);   // WS_FLEX_DOC_V1
    wsState.sectionOrder = DOC_SECTIONS.map(sd => sd.field);   // WS_REORDER_V1 — default order per consultation
    wsState.ctx = ctx;                 // WS_PASTE_V1 — target for pasting results from the popup
    wsState.docPhone = true;           // DOC_PHONE_DEFAULT_V1 — doctor phone ON by default (toggle can remove it)
    wsState.docZoom = 1.3;             // DOC_ZOOM_V1 — default document zoom 130%
    wsState.wsDoctorPhone = '';         // DOC_PHONE_SOURCE_V1 — the CONSULTATION doctor's own phone (loaded async below)
    wsState.docDoctorInfo = true;       // DOC_DOCTOR_TOGGLE_V1 — doctor-info card in the header ON by default
    wsState.wsDoctorKnown = false;      // DOC_PHONE_SOURCE_V1 — was a consultation doctor resolved?

    // WS_FULLWIDTH_V1 — right sidebar removed: the document is full-width for a bigger, more
    // convenient view. Patient summary + Подсказки/Черновики/История live in a slim top bar; the
    // «Завершить приём» button moved to the doc bar (after «Сохранить»); «Пауза» removed.
    ensureWsStyle();
    const _wsGrid = h('div', { class: 'ws3 ws3--nr' }, soapForm(ctx));   // WS_TOPLINE_V1 — no separate top card; patient block is in the doc bar
    container.appendChild(h('div', { class: 'fade-in', style: { display: 'flex', flexDirection: 'column', gap: '16px' } },
        _wsGrid,
    ));
    setTimeout(() => { try { loadVitals(ctx); } catch (e) {} }, 0);

    _a4Sig = '';
    setupA4Pagination(container);
    wsState.docType = 'conclusion';   // DOCTYPE_FROM_DOCUMENTS_V1 — reset per consultation
    wsState.diagImages = [];          // DIAG_IMAGES_V1 — uploaded imaging photos (data URLs), reset per consultation
    // WS_TEMPLATE_SECTIONS_V1 — open in the clinic's #documents template with inline +/- section pills.
    setTimeout(() => setBlankMode(ctx, true), 0);
    // CLINICAL_DIAG_DEFAULT_V1 — resolve the service's department kind so a DIAGNOSTIC service
    // opens in the imaging conclusion blank (описание/заключение) and archives as doc_type='diag'.
    // (ctx otherwise carries no deptKind, so this also makes handleSignFinalize's diag detection reliable.)
    ctx.deptKind = '';
    if (ctx.visitServiceId) {
        supabase.from('visit_services')
            .select('services(service_types(name), departments(kind))')
            .eq('id', ctx.visitServiceId).single()
            .then(({ data }) => {
                ctx.deptKind = (data && data.services && data.services.departments && data.services.departments.kind) || '';
                ctx.typeName = ((data && data.services && data.services.service_types && data.services.service_types.name) || '').toLowerCase();
                if (ctx.deptKind === 'diagnostics' && wsState.docType !== 'diag') {
                    wsState.docType = 'diag';
                    const _sel = ctx.container && ctx.container.querySelector('[data-doctype]');
                    if (_sel) _sel.value = 'diag';
                    if (wsState.blank) renderBlank(ctx); else setBlankMode(ctx, true);
                }
            }).catch(() => {});
    }

    // Pull previously-saved fields + history from visit_services.notes.
    if (ctx.visitServiceId) hydrateWorkspace(ctx);
    // DOC_PHONE_SOURCE_V1 — load the CONSULTATION doctor's own phone (not the signed-in
    // user's — an admin may be viewing a doctor's document) and reflect it in the sheet.
    Promise.resolve(resolveWsDoctorId(ctx)).then((did) => {
        if (!did) return;
        wsState.wsDoctorKnown = true;
        return supabase.from('users').select('phone').eq('id', did).maybeSingle().then(({ data }) => {
            wsState.wsDoctorPhone = (data && data.phone) || '';
            try {
                const inp = ctx.container && ctx.container.querySelector('[data-field="doctor_phone"]');
                if (inp && !(inp.innerText || '').trim()) inp.textContent = wsState.wsDoctorPhone;
                renderBlank(ctx);
            } catch (e) {}
        });
    }).catch(() => {});
    // Async-load the full EMR for the patient (services + labs + diagnostics
    // across all visits) and paint it into the left-column EMR card.
    wsState.emr = null;
    wsState.emrFilter = 'all';
    loadPatientEmr(p).then(() => paintEmr());
}

// ---------------------------------------------------------------------------
function liveStrip(p, onNavigate) {
    const svc = p.__service || null;
    return h('div', { class: 'card', style: { overflow: 'hidden' } },
        h('div', {
            style: {
                padding: '14px 22px',
                background: 'linear-gradient(90deg, var(--info-50) 0%, white 60%)',
                borderBottom: '1px solid var(--ink-100)',
                display: 'flex', alignItems: 'center', gap: '14px',
            },
        },
            h('button', {
                class: 'btn btn-ghost btn-sm',
                onclick: () => onNavigate && onNavigate('consultation'),
                title: 'К моим услугам',
            }, Icon('ChevronLeft', { size: 14 }), ' Мои услуги'),
            h('span', { class: 'live-chip', style: { background: 'var(--info-50)', color: 'var(--info-700)', borderColor: '#bdd6fc' } },
                h('span', { class: 'dot', style: { background: 'var(--info-500)' } }), ' Live service'),
            svc && h('span', { class: 'muted', style: { fontSize: '12.5px' } },
                h('b', { style: { color: 'var(--ink-900)' } }, svc.name || 'Услуга'),
                svc.doctorName ? ' · ' + svc.doctorName : ''),
            h('span', { class: 'grow' }),
        ),
    );
}

function vitalsStrip() {
    // AURORA_REAL_VITALS_V1 — rendered empty (dashes); filled async by loadVitals() from patient_vitals.
    return h('div', {
        'data-vitals-strip': '', title: 'Витальные · последние',
        style: {
            display: 'grid', gridTemplateColumns: 'repeat(6, auto)', gap: '6px',
            padding: '6px 8px', background: 'var(--ink-25)',
            border: '1px solid var(--ink-100)', borderRadius: '10px',
            flex: '0 0 auto',
        },
    }, ...vitalChips(null));
}

// Build the 6 vital chips from a patient_vitals row (or all dashes when null).
function vitalChips(v) {
    const f = (x, d) => (x == null ? '—' : (Number.isInteger(Number(x)) ? String(Number(x)) : Number(x).toFixed(d)));
    const bp = (v && v.bp_sys != null) ? `${f(v.bp_sys, 0)}/${v.bp_dia != null ? f(v.bp_dia, 0) : '—'}` : '—';
    return [
        vitalChip('BP',   bp,                           'mmHg', 'warn'),
        vitalChip('HR',   v ? f(v.pulse_bpm, 0) : '—',  'bpm',  'ok'),
        vitalChip('Temp', v ? f(v.temp_c, 1)    : '—', '°C',   'ok'),
        vitalChip('SpO₂', v ? f(v.spo2, 0)      : '—', '%',    'ok'),
        vitalChip('Resp', v ? f(v.resp_rate, 0) : '—', '/min', 'ok'),
        vitalChip('Wt',   v ? f(v.weight_kg, 1) : '—', 'kg',   'ok'),
    ];
}

// AURORA_REAL_VITALS_V1 — load the patient's latest recorded vitals and paint the strip.
async function loadVitals(ctx) {
    const strip = ctx.container?.querySelector('[data-vitals-strip]');
    if (!strip || !ctx.patient?.id) return;
    try {
        const { data } = await supabase.from('patient_vitals')
            .select('bp_sys,bp_dia,pulse_bpm,temp_c,spo2,resp_rate,weight_kg,recorded_at')
            .eq('patient_id', ctx.patient.id)
            .order('recorded_at', { ascending: false }).limit(1);
        const v = (data && data[0]) || null;
        clear(strip);
        vitalChips(v).forEach(c => strip.appendChild(c));
        if (v && v.recorded_at) strip.title = trf('Витальные · {when}', { when: dateTimeShort(v.recorded_at) });
    } catch (e) { /* leave dashes */ }
}

function vitalChip(label, value, unit, status) {
    const c = status === 'warn' ? 'var(--warn-700)' : status === 'crit' ? 'var(--crit-700)' : 'var(--ok-700)';
    return h('div', { style: { padding: '4px 9px', textAlign: 'center', minWidth: '56px' } },
        h('div', { class: 'muted', style: { fontSize: '9.5px', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' } }, label),
        h('div', { class: 'num', style: { fontSize: '13.5px', fontWeight: 700, color: c, marginTop: '1px', lineHeight: 1 } },
            String(value),
            h('span', { style: { fontSize: '9.5px', color: 'var(--ink-500)', fontWeight: 500, marginLeft: '2px' } }, unit),
        ),
    );
}

// ---------------------------------------------------------------------------
// AURORA_CONSULT_EDITOR_V1 — left zone: 5 bespoke cards
// (PatientCard, DiagnosisCard, ServicesCard, RecsCard, RxCard) followed by the
// existing Patient EMR + Conditions cards (kept verbatim so paintEmr() still
// has its [data-emr-body] mount).
// AURORA_EMR_TOP_V1 — patient's previous completed services (grouped Все/Услуги/Лаб/Диаг),
// shown at the TOP of the center work area. Populated async by loadPatientEmr()/paintEmr()
// into [data-emr-body]; compact height so the document stays visible below.
// AURORA_EMR_BTN_V1 — «Карта приёмов» opens the patient's previous completed services
// (grouped Все/Услуги/Лаб/Диаг via loadPatientEmr/paintEmr) in a popup from the action bar.
function openEmrModal(ctx) {
    const overlay = h('div', { class: 'modal', style: { zIndex: '140' } });
    const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));
    overlay.appendChild(h('div', { class: 'modal-card', style: { width: '640px', maxWidth: 'calc(100vw - 32px)' } },
        h('header', { class: 'modal-head' },
            h('h2', null, Icon('Doc', { size: 16 }), ' Вставить результаты',
                h('span', { class: 'muted', style: { fontSize: '12px', fontWeight: '400', marginLeft: '8px' } }, 'выберите результат → «Вставить в документ»')),
            h('button', { class: 'modal-close', type: 'button', onclick: close }, '×')),
        h('div', { class: 'segmented', 'data-emr-tabs': '', style: { margin: '12px 14px 0', display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)' } },
            emrTabBtn('all',         'Все'),
            emrTabBtn('services',    'Услуги'),
            emrTabBtn('labs',        'Лаб.'),
            emrTabBtn('diagnostics', 'Диаг.'),
        ),
        h('div', { class: 'modal-body', 'data-emr-body': '', style: { padding: '0', maxHeight: '60vh', overflowY: 'auto' } },
            h('div', { class: 'muted', style: { padding: '14px 16px', fontSize: '12.5px' } }, 'Загрузка…'),
        ),
    ));
    document.body.appendChild(overlay);
    if (wsState.emr) paintEmr(); else loadPatientEmr(ctx.patient).then(() => paintEmr());
}

function leftColumn(ctx) {
    const p = ctx.patient;
    return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '16px', position: 'sticky', top: '88px' } },
        patientCard(ctx, p),
        diagnosisCard(ctx),
        servicesCard(ctx),
        recsCard(ctx),
        rxCard(ctx),
        prescriptionsClinicCard(ctx),   // RX_SEPARATE_V1 — «Назначения (в клинике)»
        // AURORA_EMR_TOP_V1 — the «Карта приёмов» card moved to the top of the center column.

        // Conditions
        h('div', { class: 'card' },
            h('div', { class: 'card-header' }, h('h3', null, Icon('Heart', { size: 15 }), ' Хронические состояния')),
            h('div', { style: { padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: '6px' } },
                (!p.conditions || p.conditions.length === 0)
                    ? h('span', { class: 'muted', style: { fontSize: '12.5px', padding: '4px 0' } }, 'Не указаны')
                    : (p.conditions || []).map(c => h('div', { class: 'row', style: { gap: '8px', padding: '8px 10px', background: 'var(--info-50)', border: '1px solid #c7dcfd', borderRadius: '7px' } },
                        Icon('Heart', { size: 13 }),
                        h('span', { style: { fontSize: '12.5px', fontWeight: 500, color: 'var(--ink-900)' } }, c),
                    )),
            ),
        ),
    );
}

// --- PatientCard «Карта пациента» -----------------------------------------
function patientCard(ctx, p) {
    const name = `${p.lastName || ''} ${p.firstName || ''} ${p.middle || ''}`.trim() || p.fullName || 'Пациент';
    const kv = (label, value) => h('div', { class: 'row', style: { gap: '8px', fontSize: '12.5px', padding: '3px 0' } },
        h('span', { class: 'muted', style: { minWidth: '92px', flex: '0 0 auto' } }, label),
        h('span', { style: { color: 'var(--ink-900)', fontWeight: 500 } }, value));
    return h('div', { class: 'card card-pad' },
        h('div', { class: 'row', style: { gap: '12px', marginBottom: '12px' } },
            Avatar({ initials: p.initials || '?', color: p.avColor || 'av-1', size: 'lg' }),
            h('div', { style: { flex: 1, minWidth: 0 } },
                h('div', { style: { fontSize: '15px', fontWeight: 600, color: 'var(--ink-900)', letterSpacing: '-0.01em' } }, name),
                h('div', { class: 'muted', style: { fontSize: '11.5px', marginTop: '2px' } }, 'ID ' + (p.mrn || p.id || '—')),
            ),
        ),
        h('div', { style: { display: 'flex', flexDirection: 'column' } },
            kv('Телефон', p.phone || '—'),
            kv('Дата рожд.', p.dob || p.birthDate || '—'),
            kv('Группа крови', p.blood || '—'),
        ),
        (p.allergies && p.allergies.length)
            ? h('div', { style: { marginTop: '10px', paddingTop: '10px', borderTop: '1px solid var(--ink-100)' } },
                h('div', { class: 'muted', style: { fontSize: '10.5px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '5px' } }, 'Аллергии'),
                Tag(p.allergies.join(', '), { kind: 'crit' }),
              )
            : null,
        ctx.onNavigate ? h('button', {
            class: 'btn btn-outline btn-sm', style: { width: '100%', marginTop: '12px', justifyContent: 'center' },
            onclick: () => ctx.onNavigate('patient-card', p),
        }, 'Карта пациента ', Icon('ArrowRight', { size: 13 })) : null,
    );
}

// --- DiagnosisCard «Диагноз» ----------------------------------------------
function diagnosisCard(ctx) {
    return h('div', { class: 'card' },
        h('div', { class: 'card-header' },
            h('h3', { style: { margin: 0 } }, Icon('Stethoscope', { size: 15 }), ' Диагноз',
                h('span', { class: 'h-count', 'data-dx-count': '', style: { marginLeft: '6px' } }, '')),
            patientTabCanEdit('overview') && h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: () => openDiagnosisModal(ctx) },
                Icon('Plus', { size: 12 }), ' Добавить'),
        ),
        h('div', { 'data-dx-list': '', style: { padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: '6px' } }),
    );
}

// --- ServicesCard «Услуги приёма» -----------------------------------------
function servicesCard(ctx) {
    return h('div', { class: 'card' },
        h('div', { class: 'card-header' },
            h('h3', { style: { margin: 0 } }, Icon('Flask', { size: 15 }), ' Услуги приёма',
                h('span', { class: 'h-count', 'data-own-svc-count': '', style: { marginLeft: '6px' } }, '')),
            patientTabCanEdit('services') && h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: () => openServicePickerModal({
                // SVC_WIZARD_V1 — open the full booking wizard (chips + СМЕТА + Оплата/Кто платит/Подтверждение),
                // patient pre-attached. No onPick → the wizard creates the visit + invoice itself.
                patient: ctx.patient,
                onBooked: () => { try { loadPatientEmr(ctx.patient).then(() => paintEmr()); } catch (e) {} },
            }) }, Icon('Plus', { size: 12 }), ' Добавить'),
        ),
        h('div', { 'data-own-services-list': '', style: { padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: '6px' } }),
    );
}

// --- RecsCard «Рекомендации» (reuses recommended_services machinery) ------
function recsCard(ctx) {
    return h('div', { class: 'card' },
        h('div', { class: 'card-header' },
            h('h3', { style: { margin: 0 } }, Icon('Flag', { size: 15 }), ' Рекомендации'),
            patientTabCanEdit('recommended') && h('button', { class: 'btn btn-outline btn-sm', type: 'button',
                onclick: () => openRecommendPickerModal(ctx) },   // RECS_FLAT_PICKER_V1
                Icon('Plus', { size: 12 }), ' Добавить'),
        ),
        h('div', { 'data-recommendations-list': '', style: { padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: '8px' } }),
        h('div', { class: 'muted', style: { padding: '0 14px 12px', fontSize: '11px' } },
            'Реферальный бонус начисляется при выполнении.'),
    );
}

// --- RxCard «Рецепт» (reuses prescriptions machinery) ---------------------
function rxCard(ctx) {
    return h('div', { class: 'card' },
        h('div', { class: 'card-header' },
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 } },
                h('h3', { style: { margin: 0 } }, Icon('Pill', { size: 15 }), ' Рецепт'),
                h('div', { class: 'rxsep-sub' }, 'Препараты, которые пациент покупает после приёма'),
            ),
            h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: () => openPrescriptionDialog(ctx, null) },
                Icon('Plus', { size: 12 }), ' Добавить'),
        ),
        h('div', { 'data-prescriptions-list': '', style: { padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: '8px' } }),
        h('div', { style: { padding: '0 14px 14px' } },
            h('button', {
                class: 'btn btn-outline', type: 'button',
                style: { width: '100%', justifyContent: 'center' },
                onclick: () => openRecipeModal(ctx),
            }, Icon('Print', { size: 13 }), ' Сформировать рецепт'),
        ),
    );
}

// RX_SEPARATE_V1 ------------------------------------------------------------
// «Назначения (в клинике)» — drugs / materials administered in the clinic and
// written off from stock. These are real visit_services rows (clinic_item_id
// set, service_id null) created by the dispense_visit_item RPC. This card
// shows the dispense action + the live list of dispensed lines for the visit,
// each voidable via void_dispensed_visit_item (returns stock, deletes line;
// RAISEs if already invoiced). Distinct from «Рецепт» (free-text take-home,
// payload.prescriptions). All free-text is rendered via h() text nodes (safe).
function prescriptionsClinicCard(ctx) {
    return h('div', { class: 'card' },
        h('div', { class: 'card-header' },
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 } },
                h('h3', { style: { margin: 0 } }, Icon('Pill', { size: 15 }), ' Назначения (в клинике)'),
                h('div', { class: 'rxsep-sub' }, 'Препараты и материалы, использованные в клинике (списываются со склада)'),
            ),
            // DISPENSE_ITEM_V1 — dispense a clinic product consumed during the visit.
            h('button', {
                class: 'btn btn-outline btn-sm', type: 'button',
                title: ctx.visitId ? 'Выдать препарат (списывает со склада)' : 'Откройте из «Мои услуги», чтобы выдать препарат',
                onclick: () => openDispenseConsultItem(ctx),
            }, Icon('Pill', { size: 12 }), ' Выдать препарат'),
        ),
        h('div', { 'data-dispensed-list': '', style: { padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: '8px' } }),
    );
}

// Load dispensed item lines for the current visit (clinic_item_id set).
// Mirrors visit-modal loadServices but filtered to item lines + keyed on
// ctx.visitId. Stored on wsState.dispensed.
async function loadDispensedItems(ctx) {
    wsState.dispensed = [];
    if (!ctx.visitId) return;
    const { data, error } = await supabase
        .from('visit_services')
        .select('id, quantity, unit_price, invoice_item_id, clinic_item_id, clinic_items(name, unit)')
        .eq('visit_id', ctx.visitId)
        .not('clinic_item_id', 'is', null);
    if (error) { console.warn('[workspace] loadDispensedItems:', error.message); wsState.dispensed = []; return; }
    wsState.dispensed = (data || []).map(r => {
        const qty   = Number(r.quantity ?? 1);
        const price = Number(r.unit_price ?? 0);
        return {
            id:           r.id,
            invoiced:     !!r.invoice_item_id,
            qty,
            price,
            total:        price * qty,
            name:         (r.clinic_items?.name || 'Препарат')
                          + (r.clinic_items?.unit ? ' (' + r.clinic_items.unit + ')' : ''),
        };
    });
}

// Paint the dispensed-items list into [data-dispensed-list]. Mirrors
// paintPrescriptions: empty-state + one row per dispensed line with a Void
// action. Free-text item name rendered via h() text node (auto-escaped).
function paintDispensed(ctx) {
    const listEl = ctx.container?.querySelector('[data-dispensed-list]');
    if (!listEl) return;
    clear(listEl);
    if (!ctx.visitId) {
        listEl.appendChild(h('div', {
            class: 'muted',
            style: {
                fontSize: '12.5px', padding: '10px 12px',
                background: 'var(--ink-25)', border: '1px dashed var(--ink-200)',
                borderRadius: '8px', textAlign: 'center',
            },
        }, 'Откройте из «Мои услуги», чтобы выдать препарат.'));
        return;
    }
    const items = wsState.dispensed || [];
    if (items.length === 0) {
        listEl.appendChild(h('div', {
            class: 'muted',
            style: {
                fontSize: '12.5px', padding: '10px 12px',
                background: 'var(--ink-25)', border: '1px dashed var(--ink-200)',
                borderRadius: '8px', textAlign: 'center',
            },
        }, 'Назначений нет.'));
        return;
    }
    for (const it of items) {
        listEl.appendChild(h('div', {
            class: 'row',
            style: { padding: '10px 12px', background: 'var(--primary-50)', borderRadius: '9px', border: '1px solid var(--primary-200)', gap: '12px' },
        },
            Icon('Pill', { size: 16 }),
            h('div', { style: { flex: 1, minWidth: 0 } },
                h('div', { style: { fontSize: '13.5px', fontWeight: 600, color: 'var(--ink-900)' } },
                    it.name,
                    h('span', { style: { color: 'var(--ink-500)', fontWeight: 500 } }, ' × ' + it.qty)),
                h('div', { class: 'muted', style: { fontSize: '11.5px' } },
                    it.total.toLocaleString('ru-RU') + ' UZS'
                    + (it.invoiced ? ' · в счёте' : '')),
            ),
            (it.invoiced
                ? h('span', { class: 'muted', style: { fontSize: '11px' }, title: 'Уже в счёте — отмена недоступна' }, Icon('Check', { size: 12 }))
                : (canDeleteRole('consultation')
                    ? h('button', {
                        class: 'btn btn-ghost btn-sm', type: 'button', title: 'Отменить (вернуть на склад)',
                        style: { color: 'var(--crit-700)' },
                        onclick: () => voidDispensedItemWs(ctx, it),
                      }, Icon('Trash', { size: 12 }), ' Отменить')
                    : null)),
        ));
    }
}

// Void a dispensed line — returns stock + deletes the row via the RPC, then
// reloads + repaints. RAISEs (toasted) if already invoiced.
async function voidDispensedItemWs(ctx, it) {
    if (!confirm(trf('Отменить «{name}»? Препарат вернётся на склад.', { name: it.name }))) return;
    try {
        const { error } = await supabase.rpc('void_dispensed_visit_item', { p_line: it.id });
        if (error) throw error;
        toast('Назначение отменено — остаток возвращён.');
        await loadDispensedItems(ctx);
        paintDispensed(ctx);
    } catch (err) {
        toast(err?.message || String(err), 'fail');
    }
}

function emrTabBtn(id, label) {
    return h('button', {
        type: 'button',
        'data-emr-tab': id,
        class: id === 'all' ? 'on' : '',
        onclick: (ev) => {
            const root = ev.currentTarget.closest('[data-emr-tabs]');
            if (!root) return;
            root.querySelectorAll('[data-emr-tab]').forEach(b => b.classList.toggle('on', b === ev.currentTarget));
            wsState.emrFilter = id;
            paintEmr();
        },
    }, label);
}

// ---------------------------------------------------------------------------
// AURORA_CONSULT_TOOLBAR_V1 — A2.3 rich-text toolbar + live auto-insert.
// Tracks the last-focused .a4-input so commands and inserts target the right
// section; auto-insert reads LIVE left-panel state (diagnoses / recommendations
// / prescriptions) and folds it into the document.
// ---------------------------------------------------------------------------
function installA4FocusTracker(ctx) {
    if (ctx.container.__a4FocusBound) return;
    ctx.container.__a4FocusBound = true;
    ctx.container.addEventListener('focusin', (e) => {
        const el = e.target.closest && e.target.closest('.a4-input');
        if (el) wsState.lastA4 = el;
    });
}
// Resolve the insert target: explicit field -> that section; else last-focused;
// else the first .a4-input. Returns the contentEditable element or null.
function a4Target(ctx, field) {
    if (field) {
        const el = ctx.container.querySelector(`.a4-input[data-field="${field}"]`);
        if (el) return el;
    }
    if (wsState.lastA4 && wsState.lastA4.isConnected) return wsState.lastA4;
    return ctx.container.querySelector('.a4-input');
}
// Revert the «Сохранить» button label to its unsaved state (mirrors onA4Edit).
function resetSaveBtn(ctx) {
    const btn = ctx.container.querySelector('[data-save-btn]');
    if (btn) { btn.textContent = ''; btn.appendChild(Icon('Check', { size: 14 })); btn.appendChild(document.createTextNode(' Сохранить')); }
    // SAVE_STATUS_COLOR_V1 — document edited → status pill turns red «Ещё не сохранено».
    const m = ctx.container.querySelector('[data-saved-marker]');
    if (m) { clear(m); m.classList.remove('saved'); m.classList.add('unsaved'); m.appendChild(Icon('Clock', { size: 12 })); m.appendChild(document.createTextNode(' Ещё не сохранено')); }
}
// Insert HTML at the caret inside the target A4 input (focus it first so the
// selection lands there), flip the saved-gate, and toast.
// EMR_PASTE_PICK_V1 — ask the doctor which document section a fetched result
// (lab / diagnostic / intervention) should be inserted into, instead of a fixed
// target. Highlights the type-appropriate default; choosing enables that section
// and inserts. Used by every «Вставить в документ» on a fetched result.
function _pastePickField(ctx, html, defaultField, okMsg) {
    if (!ctx) { toast('Откройте документ пациента, затем вставьте результат.', 'fail'); return; }
    const overlay = h('div', { class: 'modal', style: { zIndex: '160' } });
    const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));
    const list = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } });
    DOC_SECTIONS.forEach(sd => {
        const isDef = sd.field === defaultField;
        list.appendChild(h('button', {
            class: 'btn btn-outline', type: 'button',
            style: { justifyContent: 'flex-start', ...(isDef ? { borderColor: 'var(--primary-500)', color: 'var(--primary-700)', fontWeight: 700 } : {}) },
            onclick: () => { try { wsAddSection(ctx, sd.sec); } catch (e) {} a4InsertHtml(ctx, html, sd.field, okMsg || 'Вставлено в документ'); close(); },
        }, sd.label, isDef ? h('span', { class: 'muted', style: { marginLeft: 'auto', fontSize: '11px', fontWeight: 400 } }, 'рекомендуется') : null));
    });
    overlay.appendChild(h('div', { class: 'modal-card', style: { width: '400px', maxWidth: 'calc(100vw - 32px)' } },
        h('header', { class: 'modal-head' },
            h('h2', { style: { margin: 0, fontSize: '15px' } }, Icon('Plus', { size: 15 }), ' Куда вставить?'),
            h('button', { class: 'modal-close', onclick: close }, '×')),
        h('div', { class: 'modal-body' },
            h('div', { class: 'muted', style: { fontSize: '12px', marginBottom: '10px' } }, 'Выберите раздел документа для вставки результата'),
            list),
    ));
    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKey);
}

function a4InsertHtml(ctx, html, field, okMsg) {
    const el = a4Target(ctx, field);
    if (!el) { toast('Не найдено поле для вставки', 'fail'); return; }
    const needsBreak = (el.innerHTML || '').trim().length > 0;
    // BLANK_PASTE_V1 — in blank/template mode the A4 source-of-truth is display:none, so
    // execCommand can't target it (the old code silently inserted nothing). Append straight
    // to the field's HTML, then re-render the blank (which reads back from these A4 fields).
    if (wsState.blank) {
        el.innerHTML = (el.innerHTML || '') + (needsBreak ? '<br>' : '') + html;
        wsState.saved = false;
        try { setTimeout(() => renderBlank(ctx), 0); } catch (e) {}
        resetSaveBtn(ctx);
        if (okMsg) toast(okMsg, 'ok');
        return;
    }
    // Form mode — insert at the caret inside the (visible) A4 input.
    el.focus();
    const sel = window.getSelection();
    const inside = sel && sel.rangeCount && el.contains(sel.anchorNode);
    if (!inside) {
        const r = document.createRange();
        r.selectNodeContents(el); r.collapse(false);
        sel.removeAllRanges(); sel.addRange(r);
    }
    document.execCommand('insertHTML', false, (needsBreak ? '<br>' : '') + html);
    wsState.saved = false;                       // document changed -> re-gate finish
    resetSaveBtn(ctx);
    try { setTimeout(() => renderBlank(ctx), 0); } catch (e) {}   // keep the (hidden) blank in sync
    if (okMsg) toast(okMsg, 'ok');
}
// Minimal HTML escape for values interpolated into innerHTML.
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// Tiny alignment glyph helper (no align icons in the registry).
function glyph(ch) { return h('span', { style: { fontSize: '13px' } }, ch); }

// A2.3 rich-text + auto-insert toolbar. Formatting buttons fire on MOUSEDOWN
// with preventDefault so the contentEditable keeps its selection/focus.
function fmtToolbar(ctx) {
    installA4FocusTracker(ctx);
    const exec = (cmd, val = null) => (e) => {
        e.preventDefault();
        const el = a4Target(ctx);
        if (el && document.activeElement !== el && !el.contains(document.activeElement)) el.focus();
        try { document.execCommand(cmd, false, val); } catch (_) {}
        wsState.saved = false; resetSaveBtn(ctx);
    };
    const fb = (tip, child, onmd) => h('button', { class: 'fmt-b', type: 'button', 'data-tip': tip, onmousedown: onmd }, child);
    const div = () => h('span', { class: 'fmt-div' });

    const undo = fb('Отменить (Ctrl+Z)', Icon('Refresh', { size: 15 }), exec('undo'));
    const redo = fb('Повторить (Ctrl+Y)', Icon('Repeat', { size: 15 }), exec('redo'));

    const styleSel = h('select', { class: 'fmt-sel', onmousedown: (e) => e.stopPropagation(),
        onchange: (e) => { const v = e.target.value; if (v) { const el = a4Target(ctx); if (el) el.focus(); document.execCommand('formatBlock', false, v); wsState.saved = false; resetSaveBtn(ctx); } e.target.selectedIndex = 0; } },
        h('option', { value: '' }, 'Стиль'),
        h('option', { value: 'p' }, 'Абзац'),
        h('option', { value: 'h1' }, 'Заголовок 1'),
        h('option', { value: 'h2' }, 'Заголовок 2'),
        h('option', { value: 'h3' }, 'Заголовок 3'),
    );
    const sizeSel = h('select', { class: 'fmt-sel', style: { width: '64px' }, onmousedown: (e) => e.stopPropagation(),
        onchange: (e) => { const el = a4Target(ctx); if (el) el.focus(); document.execCommand('fontSize', false, e.target.value); wsState.saved = false; resetSaveBtn(ctx); } },
        ...[['1', '10'], ['2', '12'], ['3', '14'], ['4', '16'], ['5', '18'], ['6', '24']].map(([v, l]) =>
            h('option', { value: v, selected: v === '3' ? '' : null }, l)),
    );

    const bold = fb('Полужирный (Ctrl+B)', h('b', { style: { fontSize: '14px' } }, 'Ж'), exec('bold'));
    const ital = fb('Курсив (Ctrl+I)', h('i', { style: { fontFamily: 'Georgia,serif', fontSize: '14px' } }, 'К'), exec('italic'));
    const under = fb('Подчёркнутый (Ctrl+U)', h('u', { style: { fontSize: '14px' } }, 'Ч'), exec('underline'));
    const strike = fb('Зачёркнутый', h('s', { style: { fontSize: '14px' } }, 'З'), exec('strikeThrough'));

    const TEXT_COLORS = ['var(--ink-900)', 'var(--primary-600)', 'var(--crit-600)', 'var(--ok-600)', 'var(--warn-700)'];
    const HL_COLORS = ['#fff3bf', '#d3f9d8', '#ffe3e3', '#d0ebff'];   // highlight tints — hiliteColor needs literal hex
    const swatch = (c, cmd) => h('button', { class: 'sw', type: 'button', style: { background: c }, onmousedown: exec(cmd, c) });
    const colorPop = h('div', { class: 'fmt-pop-wrap' },
        h('button', { class: 'fmt-b', type: 'button', 'data-tip': 'Цвет текста' }, h('span', { style: { fontWeight: '700', fontSize: '14px', color: 'var(--primary-600)' } }, 'A')),
        h('div', { class: 'fmt-pop' }, ...TEXT_COLORS.map(c => swatch(c, 'foreColor'))),
    );
    const hlPop = h('div', { class: 'fmt-pop-wrap' },
        h('button', { class: 'fmt-b', type: 'button', 'data-tip': 'Выделение цветом' }, h('span', { style: { background: '#fff3bf', padding: '0 4px', borderRadius: '3px', fontSize: '13px' } }, 'A')),
        h('div', { class: 'fmt-pop' }, ...HL_COLORS.map(c => swatch(c, 'hiliteColor'))),
    );

    const aL = fb('По левому краю', glyph('≡'), exec('justifyLeft'));
    const aC = fb('По центру', glyph('≡'), exec('justifyCenter'));
    const aR = fb('По правому краю', glyph('≡'), exec('justifyRight'));
    const aJ = fb('По ширине', glyph('≡'), exec('justifyFull'));
    const ul = fb('Маркированный список', h('span', null, '•≡'), exec('insertUnorderedList'));
    const ol = fb('Нумерованный список', h('span', { style: { fontWeight: '700' } }, '1.'), exec('insertOrderedList'));
    const outd = fb('Уменьшить отступ', h('span', null, '⇤'), exec('outdent'));
    const ind = fb('Увеличить отступ', h('span', null, '⇥'), exec('indent'));
    const quote = fb('Цитата', h('span', { style: { fontSize: '16px' } }, '“'), exec('formatBlock', 'blockquote'));
    const link = fb('Ссылка', h('span', null, '🔗'), (e) => { e.preventDefault(); const url = prompt('Ссылка (URL):', 'https://'); if (url) { document.execCommand('createLink', false, url); wsState.saved = false; resetSaveBtn(ctx); } });
    const clearF = fb('Очистить форматирование', h('span', null, '⌫'), exec('removeFormat'));

    // AUTO_CHIPS_REMOVED_V1 — top insert chips (Рекомендации/Рецепт/Диагноз/Функц. иссл./Лучевая/
    // Лаборатория) removed on request. Formatting stays available via the selection bubble
    // (WS_BLOCK_FMT_V1). installA4FocusTracker above is kept for caret tracking.
    return h('div', { class: 'fmt-bar', style: { display: 'none' } });
}

// --- Auto-insert: build formatted HTML from LIVE left-panel data -----------
// Диагноз -> primary_diagnosis band. Source: wsState.payload.diagnoses[].
function insertDxBlock(ctx) {
    const list = wsState.payload?.diagnoses || [];
    if (!list.length) { toast('Раздел пуст', 'warn'); return; }
    const rows = list.map(d => {
        const t = DX_TYPE_RU[d.type] ? ` (${DX_TYPE_RU[d.type].toLowerCase()})` : '';
        return `<div><b>${esc(d.code || '')}</b> — ${esc(d.name || '')}${t}</div>`;
    }).join('');
    // i18n-exempt: HTML вставляется В ДОКУМЕНТ приёма — содержимое бланка, не текст интерфейса
    const html = `<div><b>Диагноз (МКБ-10):</b></div>${rows}`;
    a4InsertHtml(ctx, html, 'primary_diagnosis', 'Вставлено в документ');
}
// Рекомендации -> recommendations_text section. Source: wsState.recommendations[].
function insertRecsBlock(ctx) {
    const list = wsState.recommendations || [];
    if (!list.length) { toast('Раздел пуст', 'warn'); return; }
    const rows = list.map(r => {
        const parts = [r.__service_name, (r.__doctor_name && r.__doctor_name !== '(unknown)') ? r.__doctor_name : null, r.notes].filter(Boolean);
        return `<li>${esc(parts.join(', '))}</li>`;
    }).join('');
    // i18n-exempt: HTML вставляется В ДОКУМЕНТ приёма
    const html = `<div><b>Рекомендовано:</b></div><ul>${rows}</ul>`;
    a4InsertHtml(ctx, html, 'recommendations_text', 'Вставлено в документ');
}
// Рецепт -> therapy_text section. Source: wsState.payload.prescriptions[].
/* i18n-exempt-start: HTML вставляется В ДОКУМЕНТ приёма (назначения) */
function insertRxBlock(ctx) {
    const list = wsState.payload?.prescriptions || [];
    if (!list.length) { toast('Раздел пуст', 'warn'); return; }
    const rows = list.map((rx) => {
        const tail = [rx.dose, rx.freq, rx.dur, rx.notes].filter(Boolean).join(', ');
        return `<li><b>${esc(rx.name || '(без названия)')}</b>${tail ? ' — ' + esc(tail) : ''}</li>`;
    }).join('');
    const html = `<div><b>Назначения:</b></div><ol>${rows}</ol>`;
    a4InsertHtml(ctx, html, 'therapy_text', 'Вставлено в документ');
}
/* i18n-exempt-end */

// ---------------------------------------------------------------------------
// AURORA_CONSULT_EDITOR_V1 — center zone: an A4 contentEditable document.
// Each .a4-input carries a data-field key (legacy SOAP keys reused where they
// exist). collectFields/applyFields bridge innerHTML <-> notes JSON.
// ---------------------------------------------------------------------------
function a4Section(ctx, { sec, ru, uz, field, ph }) {
    return h('div', { class: 'a4-sec' + (wsSectionOn(sec) ? '' : ' a4-sec-off'), 'data-sec': sec, style: { position: 'relative' } },
        h('button', { class: 'a4-sec-add', type: 'button', onclick: () => wsAddSection(ctx, sec) }, trf('+ Добавить: {name}', { name: ru })),
        h('span', { class: 'a4-sec-tag' }, `${ru} · ${uz}`),   // i18n-exempt: подпись раздела ДОКУМЕНТА — двуязычная (ru+uz) по замыслу бланка
        h('button', { class: 'a4-sec-x', type: 'button', title: 'Убрать раздел', onclick: () => wsRemoveSection(ctx, sec) }, '×'),
        h('div', {
            class: 'a4-input', 'data-field': field, contentEditable: 'true',
            'data-ph': ph, oninput: () => onA4Edit(ctx, sec),
        }),
    );
}

// Reset-on-edit hook: clear the error ring, and if a required section is
// edited after a successful save, flip wsState.saved back to false.
function onA4Edit(ctx, sec) {
    const secEl = ctx.container.querySelector(`.a4-sec[data-sec="${sec}"]`);
    secEl?.classList.remove('a4-err');
    if (['complaints', 'exam', 'recommendations'].includes(sec) && wsState.saved) {
        wsState.saved = false;
        const btn = ctx.container.querySelector('[data-save-btn]');
        if (btn) { btn.textContent = ''; btn.appendChild(Icon('Check', { size: 14 })); btn.appendChild(document.createTextNode(' Сохранить')); }
    }
}

function soapForm(ctx) {
    const p   = ctx.patient || {};
    const svc = p.__service || {};
    const patientName = `${p.lastName || ''} ${p.firstName || ''} ${p.middle || ''}`.trim() || p.fullName || 'Пациент';
    const _clinic = (typeof window !== 'undefined' && window.CLINIC) || {};
    const clinicName  = _clinic.name_ru || _clinic.name || _clinic.title || 'Клиника';
    const clinicLegal = _clinic.legal_name || '';
    const clinicAddr  = _clinic.address || '';
    const clinicLogo  = _clinic.logo_url || '';
    const today = new Date().toLocaleDateString('ru-RU');

    const savedMarker = h('span', { class: 'ws-savemark unsaved', 'data-saved-marker': '' },
        Icon('Clock', { size: 12 }), ' Ещё не сохранено');

    // Doctype select — only the default is functional this slice.
    // DOCTYPE_FROM_DOCUMENTS_V1 — the clinic's document templates (as configured in
    // #documents). «Заключение» is the editable consultation document; the rest render
    // as a live read-only preview of that template (their data comes from other modules).
    const doctypeSel = h('select', {
        'data-doctype': '',
        style: { height: '34px', padding: '0 10px', border: '1px solid var(--ink-200)', borderRadius: 'var(--r-sm)', background: 'var(--white)', fontFamily: 'inherit', fontSize: '13px', color: 'var(--ink-900)' },
        onchange: (ev) => {
            wsState.docType = ev.currentTarget.value || 'conclusion';
            if (!wsState.blank) setBlankMode(ctx, true);
            else renderBlank(ctx);
        },
    },
        // AURORA_DOCTYPE_GROUPS_V1 — clinical-first grouping (matches the reference's clinical focus).
        h('optgroup', { label: 'Клинические' },
            h('option', { value: 'conclusion' }, 'Приём (осмотр, консультация)'),
            h('option', { value: 'lab' }, 'Анализы (лаборатория)'),
            h('option', { value: 'diag' }, 'Диагностика (МРТ · КТ · УЗИ)'),
        ),
        h('optgroup', { label: 'Финансовые' },
            h('option', { value: 'invoice' }, 'Счёт за услуги'),
            h('option', { value: 'check' }, 'Чек (квитанция)'),
            h('option', { value: 'fiscal' }, 'Фискальный чек'),
        ),
    );

    const draftBtn = h('button', { class: 'btn btn-outline', type: 'button', onclick: async (ev) => {
        ev.currentTarget.disabled = true;
        try { await handleSaveDraft(ctx); }
        finally { if (ev.currentTarget?.isConnected) ev.currentTarget.disabled = false; }
    } }, Icon('Clock', { size: 13 }), ' Черновик');

    const printBtn = h('button', { class: 'btn btn-outline', type: 'button', onclick: () => handlePrint(ctx) },
        Icon('Print', { size: 13 }), ' Печать');

    // CARD_SPEC_V1 — записать витальные показатели прямо из приёма.
    const vitalsBtn = h('button', { class: 'btn btn-outline', type: 'button', onclick: () => openVitalsDialog(ctx.patient, ctx.visitId, () => { toast('Показатели записаны'); loadVitals(ctx); }) },
        Icon('Pulse', { size: 13 }), ' Витальные');

    // PAPER_ACTIONS_TOOLBAR_V1 removed — «Повторный визит» + «Заявка на госпитализацию» now live on
    // the document itself (a4-actions under Рекомендации + injected into the «Черновик» sheet), so the
    // toolbar copies are redundant.


    // AURORA_CONSULT_TEMPLATES_V1 — open the «Шаблоны заключений» library.
    const tplBtn = h('button', { class: 'btn btn-outline', type: 'button', onclick: () => openTemplateLibraryModal(ctx) },
        Icon('Doc', { size: 13 }), ' Шаблоны');

    // AURORA_EMR_BTN_V1 — «Карта приёмов»: previous-results popup.
    const emrBtn = h('button', { class: 'btn btn-outline', type: 'button', onclick: () => openEmrModal(ctx) },
        Icon('Doc', { size: 13 }), ' Вставить результаты');

    // WS_DOCPHONE_V1 — optional doctor-phone line in the document footer.
    const phoneBtn = h('button', { class: 'btn btn-outline', type: 'button', onclick: () => {
        wsState.docPhone = !wsState.docPhone;
        const el = ctx.container.querySelector('[data-docphone]');
        if (el) el.classList.toggle('a4-sec-off', !wsState.docPhone);
        const inp = el && el.querySelector('[data-field="doctor_phone"]');
        if (wsState.docPhone && inp) { if (!(inp.innerText || '').trim()) inp.textContent = (wsState.wsDoctorKnown ? (wsState.wsDoctorPhone || '') : (me().phone || '')); inp.focus(); }
        try { setTimeout(() => renderBlank(ctx), 0); } catch (e) {}
    } }, Icon('Phone', { size: 13 }), ' Тел. врача');

    const saveBtn = h('button', { class: 'btn btn-primary', type: 'button', 'data-save-btn': '', onclick: async (ev) => {
        ev.currentTarget.disabled = true;
        try { await handleSave(ctx, ev.currentTarget); }
        finally { if (ev.currentTarget?.isConnected) ev.currentTarget.disabled = false; }
    } }, Icon('Check', { size: 14 }), ' Сохранить');

    // WS_FULLWIDTH_V1 — «Завершить приём» (close consultation) moved to the doc bar, right after «Сохранить».
    const finishBtn = h('button', { class: 'btn btn-primary', type: 'button', 'data-ws-finish': '',
        style: { background: 'var(--ok-600, #16a34a)', borderColor: 'var(--ok-600, #16a34a)' },
        onclick: () => tryFinish(ctx) }, Icon('Check', { size: 14 }), ' Завершить приём');

    // DOC_ZOOM_V1 — document zoom control (− 100% +).
    const _zoomBtn = (sym, tip, delta) => h('button', { class: 'btn btn-outline btn-sm', type: 'button', title: tip,
        style: { minWidth: '30px', fontWeight: 700, fontSize: '15px', lineHeight: '1' },
        onclick: () => { wsState.docZoom = Math.min(2, Math.max(0.5, Math.round(((wsState.docZoom || 1) + delta) * 10) / 10)); applyDocZoom(ctx); } }, sym);
    const zoomCtl = h('div', { title: 'Масштаб документа', style: { display: 'inline-flex', alignItems: 'center', gap: '3px' } },
        _zoomBtn('−', 'Уменьшить документ', -0.1),
        h('span', { 'data-zoom-label': '', style: { fontSize: '12px', fontWeight: 600, color: 'var(--ink-700)', minWidth: '42px', textAlign: 'center' } }, Math.round((wsState.docZoom || 1) * 100) + '%'),
        _zoomBtn('+', 'Увеличить документ', 0.1));

    const pcell = (label, value) => h('div', { class: 'a4-pcell' }, h('b', null, label), value);

    // WS_TOPLINE_V1 — patient block + История/Карта пациента share the doc bar's single line with the
    // document controls; the separate top card is removed so the document sits higher and larger.
    const _p = ctx.patient || {};
    const _pName = `${_p.lastName || ''} ${_p.firstName || ''} ${_p.middle || ''}`.trim() || _p.fullName || 'Пациент';
    const _pchip = (label, value) => h('span', { class: 'ws-topchip' }, h('b', null, label + ': '), value);
    const _rtabBody = h('div', { 'data-rtab-body': '', class: 'ws-rtab-body', style: { display: 'none' } });
    const _histBtn = h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: (ev) => {
        const open = _rtabBody.style.display !== 'none';
        if (open) { _rtabBody.style.display = 'none'; ev.currentTarget.classList.remove('on'); return; }
        wsState.rtab = 'history'; ev.currentTarget.classList.add('on'); _rtabBody.style.display = ''; paintRtab(ctx);
    } }, 'История');
    const _patientBlock = h('div', { class: 'ws-patient-block' },
        h('div', { class: 'ws-pb-row1' }, h('b', null, _pName), _pchip('ID', String(_p.mrn || _p.id || '—'))),
        h('div', { class: 'ws-pb-row2' }, _pchip('Тел', _p.phone || '—'), _pchip('Дата рожд', _p.dob || _p.birthDate || '—')),
    );
    const _patientBtns = h('div', { class: 'ws-topbtns' }, _histBtn,
        ctx.onNavigate ? h('button', { class: 'btn btn-amber btn-sm', type: 'button', onclick: () => ctx.onNavigate('patient-card', _p) }, 'Карта пациента ', Icon('ArrowRight', { size: 12 })) : null);

    return h('div', { class: 'card', 'data-print-root': '', style: { overflow: 'hidden' } },
        // Doc bar — patient block (left) + document controls (right), one line (WS_TOPLINE_V1)
        // WS_DOCBAR_RESPONSIVE_V1 — two groups (patient / controls) that wrap independently and
        // reflow by screen width; long names wrap instead of overflowing.
        h('div', { class: 'doc-bar', style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: '10px 16px' } },
            h('div', { class: 'ws-docbar-left' }, _patientBlock, _patientBtns),
            h('div', { class: 'ws-docbar-right' },
                h('span', { class: 'ws-doctype-lbl' }, 'Тип документа'),
                doctypeSel,
                zoomCtl,
                tplBtn, draftBtn, printBtn, saveBtn, finishBtn,
            ),
            // SAVE_STATUS_COLOR_V1 + SAVE_STATUS_MERGED_V1 — the status pill lives
            // INSIDE the doc-bar (same background, no separate strip below); still
            // right-aligned under «Завершить приём» on its own wrapped row.
            h('div', { style: { flexBasis: '100%', display: 'flex', justifyContent: 'flex-end', margin: '-4px 0 0' } }, savedMarker),
        ),
        _rtabBody,
        // AURORA_CONSULT_TOOLBAR_V1 — live formatting + auto-insert toolbar
        h('div', { class: 'a4-toolbar-slot', 'data-toolbar-slot': '', style: { display: 'none' } }, fmtToolbar(ctx)),
        h('div', { class: 'a4-blank-wrap', 'data-blank-wrap': '', style: { display: 'none', background: 'var(--ink-50, #eef2f1)', padding: '0' } }),
        // A4 sheet
        h('div', { class: 'a4-scroll' },
            h('div', { class: 'a4-paper' },
                h('div', { class: 'a4-band-top' }),
                // Clinic header
                h('div', { class: 'a4-head' },
                    h('div', { class: 'a4-clinic-wrap' },
                        clinicLogo ? h('img', { class: 'a4-logo', src: clinicLogo, alt: '' }) : null,
                        h('div', { class: 'a4-clinic' }, clinicName,
                            clinicLegal ? h('small', null, clinicLegal) : null,
                            clinicAddr ? h('small', null, clinicAddr) : null,
                        ),
                    ),
                    h('div', { class: 'a4-doctitle' }, 'Приём (осмотр, консультация)',
                        h('small', null, 'Qabul (ko\'rik, konsultatsiya)'),
                        h('div', { class: 'a4-datebox' }, 'ДАТА · SANA: ' + today),   // i18n-exempt: шапка ДОКУМЕНТА — двуязычная (ru+uz) по замыслу бланка
                    ),
                ),
                // PAPER_PATIENT_LINE_V1 — patient details on a single long line
                h('div', { class: 'a4-pline' },
                    h('span', null, h('b', null, 'ФИО / Bemor: '), patientName),
                    h('span', { class: 'a4-pline-sep' }, '·'),
                    h('span', null, h('b', null, 'ID: '), String(p.mrn || p.id || '—')),
                    h('span', { class: 'a4-pline-sep' }, '·'),
                    h('span', null, h('b', null, 'Дата рожд. / Tug\'ilgan: '), p.dob || p.birthDate || '—'),
                    h('span', { class: 'a4-pline-sep' }, '·'),
                    h('span', null, h('b', null, 'Тел. / Telefon: '), p.phone || '—'),
                ),
                // Sections 1-5
                a4Section(ctx, { sec: 'complaints',   ru: 'ЖАЛОБЫ',           uz: 'SHIKOYATLAR',   field: 'chief_complaint',    ph: 'Опишите жалобы пациента…' }),
                a4Section(ctx, { sec: 'anamnesis',    ru: 'АНАМНЕЗ',          uz: 'ANAMNEZ',       field: 'hpi',                ph: 'Анамнез заболевания…' }),
                // Diagnosis band
                // DX_PLAIN_SECTION_V1 — Диагноз looks like every other box (standard
                // a4-sec band, not the dark a4-dx banner); the single МКБ-10 button below
                // remains the structured picker.
                h('div', { class: 'a4-sec' + (wsSectionOn('diagnosis') ? '' : ' a4-sec-off'), 'data-sec': 'diagnosis', style: { position: 'relative' } },
                    h('button', { class: 'a4-sec-add', type: 'button', onclick: () => wsAddSection(ctx, 'diagnosis') }, '+ Добавить: ДИАГНОЗ'),
                    h('span', { class: 'a4-sec-tag' }, 'ДИАГНОЗ · TASHXIS'),
                    h('button', { class: 'a4-sec-x', type: 'button', title: 'Убрать раздел', onclick: () => wsRemoveSection(ctx, 'diagnosis') }, '×'),
                    h('div', {
                        class: 'a4-input', 'data-field': 'primary_diagnosis', contentEditable: 'true',
                        'data-ph': 'Впишите основной диагноз или выберите из МКБ-10…', oninput: () => onA4Edit(ctx, 'diagnosis'),
                    }),
                    // PAPER_DX_MKB_V1 — diagnosis lives only on the sheet: type it above, or pick from
                    // the МКБ-10 catalogue (reuses openDiagnosisModal). Picks render in the list below.
                    h('div', { class: 'a4-dx-tools no-print' },
                        patientTabCanEdit('overview') && h('button', { class: 'btn btn-outline btn-sm', type: 'button', style: { background: '#fef9c3', borderColor: '#e6c74c', color: '#854d0e' }, onclick: () => openDiagnosisModal(ctx) },   // ICD_BTN_YELLOW_V1
                            Icon('Plus', { size: 12 }), ' Выбрать из МКБ-10'),
                        h('span', { class: 'h-count', 'data-dx-count': '', style: { color: 'var(--ink-600)', fontSize: '12px' } }, ''),
                    ),
                    h('div', { 'data-dx-list': '', class: 'no-print', style: { display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '8px' } }),
                ),
                // Sections 7-8
                a4Section(ctx, { sec: 'therapy',         ru: 'ТЕРАПИЯ',      uz: 'DAVOLASH',   field: 'therapy_text',         ph: 'Назначенная терапия…' }),
                a4Section(ctx, { sec: 'recommendations', ru: 'РЕКОМЕНДАЦИИ', uz: 'TAVSIYALAR', field: 'recommendations_text', ph: 'Рекомендации пациенту…' }),
                // RX_IN_FORM_V1 — read-only prescription table on the editable sheet (mirrors the Бланк rx table)
                h('div', { 'data-rx-doc': '', class: 'a4-sec a4-sec-off', 'data-sec': 'rx', style: { position: 'relative' } }),
                // PAPER_ACTIONS_V1 — «Повторный визит» + «Заявка на госпитализацию» on the sheet, under Рекомендации (screen-only)
                h('div', { class: 'a4-actions no-print' },
                    h('button', { class: 'btn btn-outline btn-sm', type: 'button', 'data-revisit-btn': '', onclick: () => openRevisitModal(ctx) },
                        Icon('Repeat', { size: 13 }), ' Повторный визит',
                        h('span', { class: 'ws-ba-sub', style: { marginLeft: '6px', fontSize: '11px', color: 'var(--ink-600)' } })),
                    h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: () => openHospitalizationRequestModal(ctx) },
                        Icon('Bed', { size: 13 }), ' Заявка на госпитализацию'),
                ),
                // Doctor footer
                h('div', { class: 'a4-foot' },
                    h('div', null, h('b', null, 'ВРАЧ · SHIFOKOR'),
                        h('div', { class: 'a4-foot-name' }, svc.doctorName || me().full_name || '—'),
                        h('div', null, 'Врач-специалист'),
                        h('div', { 'data-docphone': '', class: (wsState.docPhone ? '' : 'a4-sec-off'), style: { marginTop: '3px', fontSize: '12px' } },
                            h('b', null, 'Тел.: '),
                            h('span', { class: 'a4-input', 'data-field': 'doctor_phone', contentEditable: 'true', 'data-ph': 'телефон врача', style: { display: 'inline-block', minWidth: '120px' }, oninput: () => { wsState.saved = false; } }))),
                    h('div', { style: { textAlign: 'right' } }, h('b', null, 'КОНТАКТ'),
                        h('div', null, 'medion.uz')),
                ),
                h('div', { class: 'a4-band-bottom' }),
            ),
        ),
        // WS_PAPER_TOOLS_V1 removed — «Услуги приёма», «Рецепт», «Рекомендации» card stack deleted from
        // the document; their functions live as buttons in the «Черновик» sheet action bar
        // (PAPER_SVC_BTN_V1 / PAPER_RX_BTN_V1 / PAPER_RECSVC_BTN_V1). «Рекомендации» also stays in the rail.
        // Hidden legacy controls (follow_up / referral) — preserve save/print round-trip.
        h('div', { style: { display: 'none' } },
            h('select', { 'data-field': 'follow_up' },
                h('option', null, 'In 4 weeks'),
                h('option', null, 'In 8 weeks'),
                h('option', null, 'In 3 months'),
                h('option', null, 'Custom…'),
            ),
            h('input', { 'data-field': 'icd10', value: '' }),
            h('select', { 'data-field': 'referral' },
                h('option', null, 'None'),
                h('option', null, 'Ophthalmology · DM screening'),
                h('option', null, 'Nutrition counseling'),
                h('option', null, 'Cardiology'),
            ),
        ),
    );
}

// Lightweight section: a 3px coloured rail down the left of the title,
// a single-line section name, and the form rows underneath. Replaces the
// old big-coloured-square + subtitle layout which ate vertical space
// without telling the doctor anything they didn't already know.
function soapBlock(title, color, ...children) {
    return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
        h('div', {
            style: {
                display: 'flex', alignItems: 'center', gap: '8px',
                fontSize: '13px', fontWeight: 600, color: 'var(--ink-900)',
                paddingLeft: '8px',
                borderLeft: `3px solid ${color}`,
                lineHeight: '1.1',
            },
        }, title),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } }, ...children),
    );
}

// WS_CONSOLIDATE_V1 — «Хронические состояния» card (moved out of the removed left column).
function conditionsCard(ctx) {
    const p = ctx.patient || {};
    return h('div', { class: 'card' },
        h('div', { class: 'card-header' }, h('h3', null, Icon('Heart', { size: 15 }), ' Хронические состояния')),
        h('div', { style: { padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: '6px' } },
            (!p.conditions || p.conditions.length === 0)
                ? h('span', { class: 'muted', style: { fontSize: '12.5px', padding: '4px 0' } }, 'Не указаны')
                : (p.conditions || []).map(c => h('div', { class: 'row', style: { gap: '8px', padding: '8px 10px', background: 'var(--info-50)', border: '1px solid #c7dcfd', borderRadius: '7px' } },
                    Icon('Heart', { size: 13 }),
                    h('span', { style: { fontSize: '12.5px', fontWeight: 500, color: 'var(--ink-900)' } }, c),
                )),
        ),
    );
}

// WS_FULLWIDTH_V1 — slim top bar (replaces the right sidebar): patient summary line +
// Подсказки/Черновики/История as toggle buttons that reveal a collapsible body (keeps paintRtab).
function topBar(ctx) {
    const p = ctx.patient || {};
    const name = `${p.lastName || ''} ${p.firstName || ''} ${p.middle || ''}`.trim() || p.fullName || 'Пациент';
    const chip = (label, value) => h('span', { class: 'ws-topchip' }, h('b', null, label + ': '), value);
    const rtabBody = h('div', { 'data-rtab-body': '', class: 'ws-rtab-body', style: { display: 'none' } });
    const btnsWrap = h('div', { class: 'ws-topbtns' });
    const tabBtn = (id, label) => h('button', { class: 'btn btn-outline btn-sm', type: 'button', 'data-rtab': id,
        onclick: (ev) => {
            const isOpen = rtabBody.style.display !== 'none' && wsState.rtab === id;
            btnsWrap.querySelectorAll('[data-rtab]').forEach(b => b.classList.remove('on'));
            if (isOpen) { rtabBody.style.display = 'none'; return; }
            wsState.rtab = id; ev.currentTarget.classList.add('on');
            rtabBody.style.display = ''; paintRtab(ctx);
        } }, label);
    const btns = [tabBtn('history', 'История')];   // patient block buttons: История + Карта пациента
    if (ctx.onNavigate) btns.push(h('button', { class: 'btn btn-amber btn-sm', type: 'button', onclick: () => ctx.onNavigate('patient-card', p) },
        'Карта пациента ', Icon('ArrowRight', { size: 12 })));
    btnsWrap.append(...btns);
    return h('div', { class: 'card ws-topcard' },
        h('div', { class: 'ws-topbar-row' },
            // Patient detail block — two compact rows, separate from the buttons.
            h('div', { class: 'ws-patient-block' },
                h('div', { class: 'ws-pb-row1' }, h('b', null, name), chip('ID', String(p.mrn || p.id || '—'))),
                h('div', { class: 'ws-pb-row2' },
                    chip('Тел', p.phone || '—'),
                    chip('Дата рожд', p.dob || p.birthDate || '—'),
                ),
            ),
            btnsWrap,   // all buttons/dropdowns on one line
        ),
        rtabBody,
    );
}

// ---------------------------------------------------------------------------
// AURORA_CONSULT_EDITOR_V1 — right zone: Timer card, big action buttons, tabs.
function rightColumn(ctx) {
    const wrap = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '16px' } },
        // AURORA_CONSULT_NO_TIMER_V1 — visit-action row (timer removed):
        // «Пауза» = step away (save draft, leave the visit in-progress, back to «Мои услуги»);
        // «Завершить приём» = sign + finalize.
        h('div', { style: { display: 'flex', gap: '8px' } },
            h('button', { class: 'btn btn-outline', type: 'button', 'data-ws-pause': '',
                style: { minHeight: '34px', fontSize: '13px' }, onclick: () => pauseAndLeave(ctx) },
                Icon('Pause', { size: 13 }), ' Пауза'),
            h('button', { class: 'ws-bigaction is-finish', type: 'button', 'data-ws-finish': '',
                style: { flex: '1', minHeight: '34px', fontSize: '13px' }, onclick: () => tryFinish(ctx) },
                Icon('Check', { size: 14 }), ' Завершить приём'),
        ),

        // WS_PATIENTCARD_PANEL_V1 — patient info card right after the main actions (no vitals).
        patientCard(ctx, ctx.patient),

        // WS_PAPER_TOOLS_V1 — everything moved onto the document (see soapForm). «Рекомендации»
        // (Рекомендовать услугу) and «Назначения (в клинике)» (Выдать препарат) are now buttons on
        // the sheet action bar, so their rail cards are removed too. Rail = patient card + tabs.

        // Tabs: Подсказки / Черновики / История
        h('div', { class: 'card' },
            h('div', { class: 'segmented', 'data-rtab-bar': '', style: { margin: '12px', display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)' } },
                rtabBtn(ctx, 'hints',   'Подсказки'),
                rtabBtn(ctx, 'drafts',  'Черновики'),
                rtabBtn(ctx, 'history', 'История'),
            ),
            h('div', { 'data-rtab-body': '' }),
        ),
    );
    // Paint the default tab after mount; load the patient's latest vitals.
    setTimeout(() => { paintRtab(ctx); loadVitals(ctx); }, 0);
    return wrap;
}

function rtabBtn(ctx, id, label) {
    return h('button', {
        type: 'button', 'data-rtab': id,
        class: (wsState.rtab === id) ? 'on' : '',
        onclick: (ev) => {
            const bar = ev.currentTarget.closest('[data-rtab-bar]');
            if (bar) bar.querySelectorAll('[data-rtab]').forEach(b => b.classList.toggle('on', b === ev.currentTarget));
            wsState.rtab = id;
            paintRtab(ctx);
        },
    }, label);
}

// Repaint the active right-column tab body.
function paintRtab(ctx) {
    const body = ctx.container.querySelector('[data-rtab-body]');
    if (!body) return;
    clear(body);
    const tab = wsState.rtab || 'hints';
    if (tab === 'hints') {
        body.appendChild(h('div', { class: 'muted', style: { padding: '14px 16px', fontSize: '12.5px', lineHeight: '1.55' } },
            'Здесь будут появляться подсказки по приёму.'));
    } else if (tab === 'drafts') {
        const drafts = (wsState.payload?.history || []).filter(e => e.kind === 'draft');
        if (drafts.length === 0) {
            body.appendChild(h('div', { class: 'muted', style: { padding: '14px 16px', fontSize: '12.5px' } }, 'Нет временно сохранённых форм.'));
        } else {
            drafts.forEach(e => body.appendChild(h('div', {
                class: 'row', style: { gap: '10px', alignItems: 'center', padding: '10px 14px', borderTop: '1px solid var(--ink-100)' },
            },
                h('div', { style: { width: '26px', height: '26px', borderRadius: '7px', background: 'var(--primary-50)', color: 'var(--primary-700)', display: 'grid', placeItems: 'center', flex: '0 0 auto' } }, Icon('Doc', { size: 13 })),
                h('div', { style: { flex: 1, minWidth: 0 } },
                    h('div', { style: { fontSize: '12.5px', fontWeight: 600, color: 'var(--ink-900)' } }, 'Черновик'),
                    h('div', { class: 'muted', style: { fontSize: '11px' } }, dateTimeShort(e.savedAt)),
                ),
                h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: () => { applyFields(ctx, e.fields); toast('Черновик загружен', 'ok'); } },
                    Icon('Repeat', { size: 12 }), ' Возобновить'),
            )));
        }
    } else {
        // AURORA_PATIENT_DOCS_V1 — «История» = the patient's documents across ALL visits.
        const head = h('div', { class: 'card-header', style: { borderTop: '1px solid var(--ink-100)' } }, h('h3', null, Icon('Doc', { size: 15 }), ' История документов'));
        const histBody = h('div', { 'data-history-body': '', style: { maxHeight: '360px', overflowY: 'auto' } },
            h('div', { class: 'muted', style: { padding: '14px 16px', fontSize: '12.5px' } }, 'Загрузка…'));
        body.appendChild(head);
        body.appendChild(histBody);
        paintPatientDocs(ctx);
    }
}

// typeNames are matched substring-style (case-insensitive) against
// service_types.name so the picker can auto-select the right type.
const REFERRAL_TARGETS = [
    { key: 'consultation', label: 'Консультация', icon: 'Stethoscope', typeNames: ['consultation', 'consult'] },
    { key: 'laboratory',   label: 'Лаборатория',  icon: 'Flask',       typeNames: ['lab', 'laboratory'] },
    { key: 'diagnostics',  label: 'Диагностика',  icon: 'Activity',    typeNames: ['diagnostic', 'imaging'] },
    { key: 'inpatient',    label: 'Стационар',    icon: 'Bed',         typeNames: ['inpatient', 'stationary', 'hospitalization', 'admission'] },
];

function aiSuggestion(kind, iconName, text) {
    const c  = kind === 'warn' ? 'var(--warn-700)' : kind === 'info' ? 'var(--info-700)' : 'var(--ok-700)';
    const bg = kind === 'warn' ? 'var(--warn-50)'  : kind === 'info' ? 'var(--info-50)'  : 'var(--ok-50)';
    return h('div', { style: { display: 'flex', gap: '8px', padding: '8px 10px', background: bg, borderRadius: '7px' } },
        h('span', { style: { color: c, marginTop: '1px', flex: '0 0 auto' } }, Icon(iconName, { size: 13 })),
        h('span', { style: { fontSize: '12px', color: 'var(--ink-800)', lineHeight: '1.4' } }, text),
    );
}

// ===========================================================================
// AURORA_CONSULT_TOOLBAR_V1 — A3.2 Revisit (follow-up) scheduling.
// Books a REAL follow-up visit mirroring appointments.js createVisit:
// a direct visits insert + a visit_services consultation line.
// ===========================================================================
const RV_REASONS = ['Контроль после лечения', 'Оценка результатов анализов', 'Продолжение лечения', 'Повторный осмотр', 'Перевязка', 'Другое'];
const RV_MONTHS  = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const RV_WEEK    = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

function rvPad(n) { return String(n).padStart(2, '0'); }
function rvIso(y, m, d) { return `${y}-${rvPad(m + 1)}-${rvPad(d)}`; }   // m is 0-based

// AURORA_WS_DOCTOR_RESOLVE_V1 — the acting doctor for revisit / hospitalization:
// the service's doctor → the visit's doctor → the logged-in user if they're a doctor.
async function resolveWsDoctorId(ctx) {
    let id = ctx.patient?.__service?.doctorId || null;
    if (!id && ctx.visitId) {
        try { const { data } = await supabase.from('visits').select('doctor_id').eq('id', ctx.visitId).maybeSingle(); id = data?.doctor_id || null; } catch (e) {}
    }
    if (!id) { const u = currentUser(); if (u && u.is_doctor) id = u.id; }
    return id;
}

// AURORA_HOSP_REQUEST_V1 — «Заявка на госпитализацию»: create a 'requested' admission the
// inpatient / registrator desk picks up. Uses the request_admission SECURITY DEFINER RPC because
// a plain doctor cannot insert into admissions directly (RLS is admin-only).
async function openHospitalizationRequestModal(ctx) {
    const patientId = ctx.patient?.id;
    if (!patientId) { toast('Нет контекста пациента.', 'fail'); return; }
    const doctorId = await resolveWsDoctorId(ctx);

    const ccEl = ctx.container?.querySelector('.a4-input[data-field="chief_complaint"]');
    const dxList = wsState.payload?.diagnoses || [];
    const mainDx = dxList.find(d => d.type === 'main') || dxList[0] || null;

    const overlay = h('div', { class: 'modal', style: { zIndex: '140' } });
    const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));

    const pathwaySel = h('select', { style: { width: '100%' } },
        h('option', { value: 'therapy' }, 'Терапевтическая'),
        h('option', { value: 'surgical' }, 'Хирургическая'));
    const dxInput = h('input', { style: { width: '100%' }, placeholder: 'Диагноз направления' });
    dxInput.value = mainDx ? `${mainDx.code || ''} ${mainDx.name || ''}`.trim() : '';
    const ccInput = h('textarea', { rows: '3', style: { width: '100%' }, placeholder: 'Повод для госпитализации / жалобы' });
    ccInput.value = ((ccEl && ccEl.innerText) || '').trim();

    const fld = (label, el) => h('div', { class: 'field', style: { marginBottom: '10px' } }, h('label', null, label), el);
    const submit = h('button', { class: 'btn btn-primary', onclick: async (ev) => {
        ev.currentTarget.disabled = true;
        try {
            const { error } = await supabase.rpc('request_admission', {
                p_patient_id: patientId, p_doctor_id: doctorId,
                p_pathway: pathwaySel.value,
                p_chief_complaint: ccInput.value.trim() || null,
                p_diagnosis: dxInput.value.trim() || null,
            });
            if (error) throw error;
            // PAPER_ACTIONS_NOTE_V1 — mirror the inpatient request into the document as a recommendation.
            const _pw = pathwaySel.value === 'surgical' ? 'хирургическая' : 'терапевтическая';
            const _dx = dxInput.value.trim(); const _cc = ccInput.value.trim();
            // i18n-exempt: HTML вставляется В ДОКУМЕНТ приёма
            noteInRecommendations(ctx, `<div><b>Рекомендована госпитализация в стационар</b> (${esc(_pw)})${_dx ? '. Диагноз направления: ' + esc(_dx) : ''}${_cc ? '. Повод: ' + esc(_cc) : ''}.</div>`);
            toast('Заявка на госпитализацию оформлена', 'ok');
            close();
        } catch (e) { toast(trf('Не удалось оформить заявку: {msg}', { msg: e.message || e }), 'fail'); }
        finally { if (ev.currentTarget && ev.currentTarget.isConnected) ev.currentTarget.disabled = false; }
    } }, Icon('Bed', { size: 14 }), ' Оформить заявку');

    overlay.appendChild(h('div', { class: 'modal-card', style: { width: '480px', maxWidth: 'calc(100vw - 32px)' } },
        h('header', { class: 'modal-head' }, h('h2', null, Icon('Bed', { size: 16 }), ' Заявка на госпитализацию'),
            h('button', { class: 'modal-close', onclick: close }, '×')),
        h('div', { class: 'modal-body' },
            fld('Тип', pathwaySel), fld('Диагноз направления', dxInput), fld('Повод / жалобы', ccInput),
            h('div', { class: 'muted', style: { fontSize: '11.5px' } }, 'Заявка появится в стационаре для оформления.')),
        h('footer', { class: 'modal-foot' }, h('button', { class: 'btn', onclick: close }, 'Отмена'), submit)));
    document.body.appendChild(overlay);
}

async function openRevisitModal(ctx) {
    const patientId = ctx.patient?.id;
    if (!patientId) { toast('Нет контекста пациента.', 'fail'); return; }
    const doctorId = await resolveWsDoctorId(ctx);   // NULL_DOCTOR_GUARD_A23
    if (!doctorId) { toast('Не удалось определить врача для повторного визита', 'fail'); return; }

    const cid = currentClinicId();
    // CONSULT_PER_DOCTOR_V1 — consultations are per-doctor: load the clinic's active
    // types, then keep only the ones THIS doctor offers, priced/named per doctor.
    let consultTypes = [], docConsult = {};
    if (cid) {
        const [{ data: ctData }, { data: dcData }] = await Promise.all([
            supabase.from('consultation_types')
                .select('id, name_ru, name_uz, sort_order, active')
                .eq('company_id', cid).eq('active', true).order('sort_order', { ascending: true }),
            supabase.from('doctor_consultation_prices')
                .select('consultation_type_id, price, is_free, available, name_ru, name_uz')
                .eq('company_id', cid).eq('doctor_id', doctorId),
        ]);
        for (const r of (dcData || [])) docConsult[r.consultation_type_id] = r;
        consultTypes = (ctData || []).filter(ct => { const r = docConsult[ct.id]; return r && r.available !== false; });
    }
    const consultLabel = (ct) => { const r = docConsult[ct.id]; return (r && (r.name_ru || r.name_uz)) || ct.name_ru || ct.name_uz || 'Консультация'; };
    const consultPrice = (ct) => { const r = docConsult[ct.id]; return r ? (r.is_free ? 0 : Number(r.price || 0)) : 0; };

    const overlay = h('div', { class: 'modal', style: { zIndex: '140' } });
    const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));

    // --- form fields ---
    const reasonSel = h('select', null, ...RV_REASONS.map(r => h('option', { value: r }, r)));
    const svcSel = h('select', null,
        ...(consultTypes.length
            ? consultTypes.map(ct => h('option', { value: ct.id }, consultLabel(ct)))
            : [h('option', { value: '' }, 'Консультация')]));
    const commentInput = h('textarea', { rows: '2', placeholder: 'Например: с результатами анализов' });

    // --- calendar state ---
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const state = { y: today.getFullYear(), m: today.getMonth(), sel: null /* {y,m,d} */, slot: null };

    const slotsWrap = h('div', { class: 'rv-slots-wrap' });
    const calWrap   = h('div', { class: 'rv-cal' });
    const footSel   = h('div', { class: 'rv-foot-sel muted' }, 'Слот не выбран');
    const bookBtn   = h('button', { class: 'btn btn-primary', disabled: '', onclick: () => doBook() },
        Icon('Check', { size: 14 }), ' Записать');

    function refreshFootBtn() {
        clear(footSel);
        if (state.sel && state.slot) {
            const dl = `${RV_WEEK[(new Date(state.sel.y, state.sel.m, state.sel.d).getDay() + 6) % 7]}, ${state.sel.d} ${RV_MONTHS[state.sel.m].toLowerCase()}`;
            footSel.className = 'rv-foot-sel';
            footSel.append(Icon('Check', { size: 13 }), document.createTextNode(` ${dl} · ${state.slot}`));
            bookBtn.removeAttribute('disabled');
        } else {
            footSel.className = 'rv-foot-sel muted';
            footSel.textContent = tr('Слот не выбран');
            bookBtn.setAttribute('disabled', '');
        }
    }

    function renderCal() {
        clear(calWrap);
        const atMinMonth = (state.y === today.getFullYear() && state.m === today.getMonth());
        const nav = h('div', { class: 'rv-calnav' },
            h('button', { class: 'btn btn-ghost btn-sm', ...(atMinMonth ? { disabled: '' } : {}),
                onclick: () => { if (atMinMonth) return; state.m--; if (state.m < 0) { state.m = 11; state.y--; } renderCal(); } }, Icon('ChevronLeft', { size: 14 })),
            h('span', { style: { fontWeight: '600' } }, `${RV_MONTHS[state.m]} ${state.y}`),
            h('button', { class: 'btn btn-ghost btn-sm', onclick: () => { state.m++; if (state.m > 11) { state.m = 0; state.y++; } renderCal(); } }, Icon('ChevronRight', { size: 14 })),
        );
        const quick = h('div', { class: 'rv-quick' },
            ...[['+1 мес', 1], ['+3 мес', 3], ['+6 мес', 6]].map(([lbl, n]) =>
                h('button', { class: 'rv-chip', type: 'button', onclick: () => { const dt = new Date(today.getFullYear(), today.getMonth() + n, 1); state.y = dt.getFullYear(); state.m = dt.getMonth(); renderCal(); } }, lbl)));
        const grid = h('div', { class: 'rv-grid' }, ...RV_WEEK.map((w, i) => h('div', { class: 'rv-gh' + (i >= 5 ? ' we' : '') }, w)));
        const first = new Date(state.y, state.m, 1);
        const lead = (first.getDay() + 6) % 7;            // Monday-first
        const daysIn = new Date(state.y, state.m + 1, 0).getDate();
        for (let i = 0; i < lead; i++) grid.appendChild(h('div'));
        for (let dd = 1; dd <= daysIn; dd++) {
            const cellDate = new Date(state.y, state.m, dd);
            const isPast = cellDate < today;
            const isToday = cellDate.getTime() === today.getTime();
            const dow = (cellDate.getDay() + 6) % 7;
            const cls = ['rv-cell', dow >= 5 ? 'we' : '', isToday ? 'today' : '',
                (state.sel && state.sel.y === state.y && state.sel.m === state.m && state.sel.d === dd) ? 'on' : ''].filter(Boolean).join(' ');
            const cell = h('button', { class: cls, type: 'button', ...(isPast ? { disabled: '' } : {}),
                onclick: () => { state.sel = { y: state.y, m: state.m, d: dd }; state.slot = null; renderCal(); renderSlots(); refreshFootBtn(); } }, String(dd));
            grid.appendChild(cell);
        }
        calWrap.append(nav, quick, grid);
    }

    async function renderSlots() {
        clear(slotsWrap);
        if (!state.sel) {
            slotsWrap.appendChild(h('div', { class: 'rv-pickhint muted' }, Icon('Calendar', { size: 16 }), ' Выберите день, чтобы увидеть свободное время'));
            return;
        }
        slotsWrap.appendChild(h('div', { class: 'muted', style: { fontSize: '12px', padding: '6px 0' } }, 'Загрузка…'));
        const booked = await loadBookedSlots(doctorId, state.sel.y, state.sel.m, state.sel.d);
        clear(slotsWrap);
        // 20-min slots 08:00–19:00, lunch 13:00–14:00 disabled.
        const slots = [];
        for (let hh = 8; hh < 19; hh++) for (let mm = 0; mm < 60; mm += 20) {
            const label = `${rvPad(hh)}:${rvPad(mm)}`;
            const lunch = hh === 13;
            const _past = (() => { const n = new Date(); return new Date(state.sel.y, state.sel.m, state.sel.d).toDateString() === n.toDateString() && (hh * 60 + mm) <= (n.getHours() * 60 + n.getMinutes()); })(); slots.push({ label, busy: lunch || _past || booked.has(label), lunch, past: _past });
        }
        const free = slots.filter(s => !s.busy).length;
        slotsWrap.appendChild(h('div', { class: 'rv-slotcount', style: { color: free ? 'var(--ok-700)' : 'var(--crit-700)' } }, trf('Свободно: {n}', { n: free })));
        const grid = h('div', { class: 'rv-slots' });
        slots.forEach(s => {
            const cls = ['rv-slot', s.busy ? 'busy' : '', state.slot === s.label ? 'on' : ''].filter(Boolean).join(' ');
            grid.appendChild(h('button', { class: cls, type: 'button', title: s.lunch ? 'Перерыв' : s.past ? 'Прошло' : s.busy ? 'Занято' : 'Свободно',
                ...(s.busy ? { disabled: '' } : {}),
                onclick: () => { state.slot = s.label; renderSlots(); refreshFootBtn(); } }, s.label));
        });
        slotsWrap.appendChild(grid);
    }

    async function doBook() {
        bookBtn.setAttribute('disabled', '');
        try {
            const isoDate = rvIso(state.sel.y, state.sel.m, state.sel.d);
            const visitDate = new Date(`${isoDate}T${state.slot}:00`).toISOString();
            const reason  = reasonSel.value;
            const comment = commentInput.value.trim();
            const notes = [reason, comment].filter(Boolean).join(' — ') || 'Повторный визит';
            const ctId = svcSel.value || null;
            const ct = consultTypes.find(c => String(c.id) === String(ctId)) || null;
            const price = ct ? consultPrice(ct) : 0;

            // visits insert — MIRRORS appointments.js createVisit (direct insert,
            // no insertRow → no auto created_by/company_id). visit_kind 'repeat'.
            const { data: visit, error } = await supabase.from('visits').insert({
                patient_id:       patientId,
                doctor_id:        doctorId,
                service_id:       null,            // consultation-primary → null (CONSULT_BOOKING_V1)
                visit_date:       visitDate,
                duration_minutes: 20,
                visit_kind:       'repeat',
                visit_type:       'outpatient',
                status:           'scheduled',
                notes,
            }).select().single();
            if (error) throw error;

            // visit_services consultation line — MIRRORS createVisit __consult branch.
            if (ctId) { const { error: vsErr } = await insertRow('visit_services', {
                visit_id:             visit.id,
                consultation_type_id: ctId,
                service_id:           null,
                doctor_id:            doctorId,
                quantity:             1,
                unit_price:           price,
                total:                price,
            });
            if (vsErr) console.warn('[revisit] visit_services not attached:', vsErr.message); }

            // best-effort activity log
            try {
                await logPatientActivity({
                    patientId, visitId: visit.id, entityType: 'visit', entityId: visit.id,
                    entityLabel: 'Повторный визит', action: 'scheduled',
                    summary: `Повторный визит: ${isoDate} ${state.slot}`,   // i18n-exempt: запись в журнал действий (БД) — хранимая запись
                    detail: { reason, comment, consultation_type_id: ctId },
                });
            } catch (_) {}

            const dl = `${RV_WEEK[(new Date(state.sel.y, state.sel.m, state.sel.d).getDay() + 6) % 7]}, ${state.sel.d} ${RV_MONTHS[state.sel.m].toLowerCase()}`;
            // RV_NO_CONFIRM_V1 — no confirmation screen: the toast + the note in
            // recommendations are enough; just close so the doctor keeps working.
            close();
            markRevisitBooked(ctx, `${dl} · ${state.slot}`);
            // PAPER_ACTIONS_NOTE_V1 — mirror the scheduled revisit into the document.
            // i18n-exempt: HTML вставляется В ДОКУМЕНТ приёма
            noteInRecommendations(ctx, `<div><b>Повторный визит:</b> ${esc(dl)} · ${esc(state.slot)}${reason ? ' — ' + esc(reason) : ''}</div>`);
            toast('Пациент записан на повторный визит', 'ok');
        } catch (e) {
            toast(trf('Не удалось записать: {msg}', { msg: e?.message || e }), 'fail');
            bookBtn.removeAttribute('disabled');
        }
    }

    // step 2: confirmation
    function renderDone(when, p, reason, service, comment) {
        const name = `${p.lastName || ''} ${p.firstName || ''} ${p.middle || ''}`.trim() || p.fullName || 'Пациент';
        clear(body);
        body.appendChild(h('div', { class: 'rv-confirm' },
            h('div', { class: 'rv-confirm-ic' }, Icon('Check', { size: 28 })),
            h('div', { class: 'rv-confirm-t' }, 'Пациент записан на повторный визит'),
            h('div', { class: 'rv-confirm-card' },
                rvKv('Пациент', name),
                rvKv('Дата и время', when),
                rvKv('Причина', reason),
                rvKv('Услуга', service),
                comment ? rvKv('Комментарий', comment) : null,
            ),
        ));
        clear(foot);
        foot.appendChild(h('button', { class: 'btn btn-primary', onclick: close }, Icon('Check', { size: 14 }), ' Готово'));
    }
    function rvKv(label, val) { return h('div', { class: 'rv-cc-row' }, h('span', null, label), h('b', null, val || '—')); }

    // --- assemble step 1 ---
    const body = h('div', { class: 'modal-body', style: { padding: '16px 18px', display: 'block' } },
        h('div', { class: 'rv-form' },
            h('div', { class: 'field' }, h('label', null, 'Причина визита'), reasonSel),
            h('div', { class: 'field' }, h('label', null, 'Услуга'), svcSel),
            h('div', { class: 'field rv-f-wide' }, h('label', null, 'Комментарий'), commentInput),
        ),
        h('div', { class: 'rv-cols' },
            h('div', { class: 'rv-col-cal' }, calWrap),
            h('div', { class: 'rv-col-slots' }, slotsWrap),
        ),
    );
    const foot = h('footer', { class: 'modal-foot' }, footSel, h('button', { class: 'btn', onclick: close }, 'Отмена'), bookBtn);

    const card = h('div', { class: 'modal-card', style: { width: '760px', maxWidth: 'calc(100vw - 32px)' } },
        h('header', { class: 'modal-head' },
            h('h2', { style: { margin: 0 } }, Icon('Repeat', { size: 16 }), ' Повторный визит'),
            h('button', { class: 'modal-close', onclick: close }, '×'),
        ),
        body, foot,
    );
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKey);
    renderCal(); renderSlots();
}

// REAL availability: booked slots for a doctor on a given day. Mirrors the
// loadCalendarAppts query (visits by doctor + day range). Returns a Set of
// 'HH:MM' labels covered by any scheduled visit's [start, start+duration).
async function loadBookedSlots(doctorId, y, m, d) {
    const set = new Set();
    if (!doctorId) return set;
    const start = new Date(y, m, d, 0, 0, 0);
    const end   = new Date(y, m, d + 1, 0, 0, 0);
    const { data, error } = await supabase.from('visits')
        .select('visit_date, duration_minutes, status')
        .eq('doctor_id', doctorId)
        .gte('visit_date', start.toISOString())
        .lt('visit_date', end.toISOString());
    if (error) { console.warn('[revisit] booked-slots query failed:', error.message); return set; }
    for (const v of (data || [])) {
        if (v.status === 'cancelled' || v.status === 'no_show') continue;
        const vd = new Date(v.visit_date);
        const dur = Number(v.duration_minutes || 20);
        let t = new Date(vd);
        const stop = new Date(vd.getTime() + dur * 60000);
        t.setMinutes(Math.floor(t.getMinutes() / 20) * 20, 0, 0);   // snap to 20-min grid
        while (t < stop) {
            set.add(`${rvPad(t.getHours())}:${rvPad(t.getMinutes())}`);
            t = new Date(t.getTime() + 20 * 60000);
        }
    }
    return set;
}

// Flip the «Повторный визит» button to its booked state.
function markRevisitBooked(ctx, when) {
    // PAPER_ACTIONS_TOOLBAR_V1 — revisit button exists in both the toolbar and the sheet; flip all.
    const btns = ctx.container.querySelectorAll('[data-revisit-btn]');
    btns.forEach((btn) => {
        btn.classList.add('booked');
        const sub = btn.querySelector('.ws-ba-sub');
        if (sub) sub.textContent = trf('Запланировано: {when}', { when });
    });
}

// PAPER_ACTIONS_NOTE_V1 — mirror a scheduled revisit / inpatient request into the document's
// РЕКОМЕНДАЦИИ section (turned on first), so it prints on the conclusion.
function noteInRecommendations(ctx, html) {
    try {
        wsAddSection(ctx, 'recommendations');   // ensure the section is visible + printed
        a4InsertHtml(ctx, html, 'recommendations_text', null);
    } catch (e) { console.warn('[doc note]', e); }
}

// ===========================================================================
// Patient EMR — every service the patient ever booked (visit_services join
// services join service_types), bucketed by type into Services / Labs /
// Diagnostics. Lab results, when present, fold under the matching order.
// ---------------------------------------------------------------------------
async function loadPatientEmr(patient) {
    const patientId = patient?.id || patient?.patientId;
    if (!patientId) { wsState.emr = { services: [], labs: [], diagnostics: [] }; return; }
    const { data, error } = await supabase
        .from('visit_services')
        .select(`
            id, status, quantity, unit_price, total, created_at, visit_id, service_id, doctor_id,
            services(name, code, type_id, service_types(name), departments(kind)),
            users:doctor_id(full_name, specialty),
            visits!inner(visit_date, patient_id)
        `)
        .eq('visits.patient_id', patientId)
        .eq('status', 'completed')
        .order('created_at', { ascending: false })
        .limit(200);
    if (error) {
        console.warn('[workspace EMR] load failed:', error.message);
        wsState.emr = { services: [], labs: [], diagnostics: [] };
        return;
    }
    const rows = (data || []).map(r => ({
        id:          r.id,
        status:      r.status,
        visitId:     r.visit_id,
        visitDate:   r.visits?.visit_date || r.created_at,
        createdAt:   r.created_at,
        serviceName: r.services?.name || '—',
        serviceCode: r.services?.code || '',
        typeName:    (r.services?.service_types?.name || '').toLowerCase(),
        deptKind:    (r.services?.departments?.kind || ''),   // DEPT_KIND_ROUTING_V1
        doctorName:  r.users?.full_name || '',
        total:       Number(r.total || 0),
    }));
    const isLab        = (t) => /\blab|laborator|анализ|лаборатор/i.test(t);
    const isDiagnostic = (t) => /diagn|imag|radio|usg|ultrasound|x[- ]?ray|mri|ct|эхо|узи|рентген|диагност|cardiogram|екг|ekg|ecg/i.test(t);
    const services = [], labs = [], diagnostics = [];
    // DEPT_KIND_ROUTING_V1 — the service's DEPARTMENT KIND is the primary router
    // (laboratory / diagnostics / procedure); the type-name regex stays as fallback
    // for services without a department.
    for (const r of rows) {
        if      (r.deptKind === 'laboratory')   labs.push(r);
        else if (r.deptKind === 'diagnostics')  diagnostics.push(r);
        else if (r.deptKind === 'procedure')    services.push(r);
        else if (isLab(r.typeName))             labs.push(r);
        else if (isDiagnostic(r.typeName))      diagnostics.push(r);
        else                                    services.push(r);
    }
    wsState.emr = { services, labs, diagnostics };
}

function paintEmr() {
    if (!wsState.payload && !wsState.emr) return;
    // The body lives inside the workspace container that's still mounted.
    const body = document.querySelector('[data-emr-body]');
    if (!body) return;
    clear(body);
    const emr = wsState.emr;
    if (!emr) {
        body.appendChild(h('div', { class: 'muted', style: { padding: '14px 16px', fontSize: '12.5px' } }, 'Загрузка…'));
        return;
    }
    const filter = wsState.emrFilter || 'all';
    let groups = [];
    if (filter === 'all') {
        groups = [
            { id: 'services',    label: 'Услуги',    icon: 'Stethoscope', rows: emr.services },
            { id: 'labs',        label: 'Лаб. анализы',   icon: 'Flask',       rows: emr.labs },
            { id: 'diagnostics', label: 'Диагностика', icon: 'Activity',    rows: emr.diagnostics },
        ];
    } else if (filter === 'services')    groups = [{ id: 'services',    label: 'Услуги',    icon: 'Stethoscope', rows: emr.services }];
    else if (filter === 'labs')          groups = [{ id: 'labs',        label: 'Лаб. анализы',   icon: 'Flask',       rows: emr.labs }];
    else if (filter === 'diagnostics')   groups = [{ id: 'diagnostics', label: 'Диагностика', icon: 'Activity',    rows: emr.diagnostics }];

    const totalRows = groups.reduce((s, g) => s + g.rows.length, 0);
    if (totalRows === 0) {
        body.appendChild(h('div', {
            style: { padding: '28px 16px', textAlign: 'center', color: 'var(--ink-400)' },
        },
            Icon('Folder', { size: 24 }),
            h('div', { style: { fontSize: '12.5px', marginTop: '6px', fontWeight: 500 } }, 'Завершённых записей пока нет'),
            h('div', { class: 'muted', style: { fontSize: '11.5px', marginTop: '2px' } },
                'Записи появятся после подписания услуги.'),
        ));
        return;
    }
    for (const g of groups) {
        if (g.rows.length === 0 && filter !== 'all') continue;
        const accent = g.id === 'labs' ? 'var(--info-600)'
                     : g.id === 'diagnostics' ? 'var(--purple-500)'
                     : 'var(--primary-600)';
        body.appendChild(h('div', {
            style: {
                padding: '10px 14px 8px',
                background: 'var(--ink-25)',
                borderTop: '1px solid var(--ink-100)',
                display: 'flex', alignItems: 'center', gap: '8px',
            },
        },
            h('span', {
                style: { width: '22px', height: '22px', borderRadius: '6px',
                         background: 'white', border: '1px solid var(--ink-100)',
                         color: accent, display: 'grid', placeItems: 'center', flex: '0 0 auto' },
            }, Icon(g.icon, { size: 13 })),
            h('span', {
                style: { fontSize: '11px', fontWeight: 700, color: 'var(--ink-800)',
                         letterSpacing: '0.05em', textTransform: 'uppercase' },
            }, g.label),
            h('span', { class: 'grow' }),
            h('span', {
                class: 'num',
                style: { fontSize: '11px', fontWeight: 700, color: accent,
                         padding: '1px 8px', background: 'white',
                         border: '1px solid var(--ink-100)', borderRadius: '999px' },
            }, String(g.rows.length)),
        ));
        if (g.rows.length === 0) {
            body.appendChild(h('div', { class: 'muted', style: { padding: '10px 14px', fontSize: '11.5px' } }, 'Нет'));
            continue;
        }
        g.rows.forEach(r => body.appendChild(emrRow(r, accent, g.id)));
    }
}

function emrRow(r, accent, groupId) {
    const d = r.visitDate ? new Date(r.visitDate) : null;
    const dateLabel = d && !isNaN(d.getTime())
        ? d.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: '2-digit' })
        : '—';
    return h('div', {
        role: 'button',
        tabindex: '0',
        title: 'Открыть заключение / результаты',
        onclick: () => openEmrResultModal(r, groupId),
        onkeydown: (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openEmrResultModal(r, groupId); } },
        onmouseenter: (ev) => { ev.currentTarget.style.background = 'var(--ink-25)'; },
        onmouseleave: (ev) => { ev.currentTarget.style.background = 'transparent'; },
        style: {
            padding: '10px 14px', gap: '10px',
            borderTop: '1px solid var(--ink-100)',
            display: 'flex', alignItems: 'flex-start',
            cursor: 'pointer', transition: 'background 120ms ease', outline: 'none',
        },
    },
        h('span', {
            style: { width: '6px', alignSelf: 'stretch', borderRadius: '3px', background: accent, flex: '0 0 auto', marginTop: '2px' },
        }),
        h('div', { style: { flex: 1, minWidth: 0 } },
            h('div', {
                style: { fontSize: '12.5px', fontWeight: 600, color: 'var(--ink-900)',
                         lineHeight: '1.35', wordBreak: 'break-word' },
                title: r.serviceName,
            }, r.serviceName),
            h('div', { class: 'row', style: { gap: '8px', marginTop: '4px', fontSize: '11px', color: 'var(--ink-600)', flexWrap: 'wrap' } },
                h('span', null, Icon('Calendar', { size: 10 }), ' ', dateLabel),
                r.doctorName && h('span', null, Icon('Stethoscope', { size: 10 }), ' ', r.doctorName),
            ),
        ),
        h('div', { style: { flex: '0 0 auto', textAlign: 'right', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '2px' } },
            r.total > 0 && h('div', {
                class: 'num',
                style: { fontSize: '11px', color: 'var(--ink-700)', fontWeight: 600, whiteSpace: 'nowrap' },
            }, r.total.toLocaleString('ru-RU'), h('span', { class: 'muted', style: { fontWeight: 500 } }, ' UZS')),
            h('span', { class: 'muted', style: { fontSize: '10.5px' } }, Icon('ArrowRight', { size: 10 })),
        ),
    );
}

// ---------------------------------------------------------------------------
// Result modal: opens the conclusion (SOAP) for a service row, or the lab
// parameters for a labs / diagnostics row. Both paths share the same shell.
// ---------------------------------------------------------------------------
async function openEmrResultModal(row, groupId) {
    const overlay = h('div', { class: 'modal', style: { zIndex: '140' } });
    const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));

    const body = h('div', { class: 'modal-body' },
        h('div', { class: 'muted', style: { padding: '8px 0', fontSize: '12.5px' } },
            Icon('Clock', { size: 12 }), ' Загрузка…'));

    // WS_PASTE_V1 — paste this result into the current appointment document.
    const _pasteField = (groupId === 'labs') ? 'labs_text' : (groupId === 'diagnostics') ? 'instrumental_text' : 'physical_exam';
    const _pasteSecByField = { labs_text: 'labs', instrumental_text: 'instrumental', physical_exam: 'exam' };
    let _pasteHtml = null;
    const pasteBtn = h('button', { class: 'btn btn-primary', type: 'button', disabled: '', onclick: () => {
        if (!_pasteHtml || !wsState.ctx) return;
        // EMR_PASTE_PICK_V1 — let the doctor choose the target section.
        _pastePickField(wsState.ctx, _pasteHtml, _pasteField, 'Результат вставлен в документ');
        close();
    } }, Icon('Plus', { size: 13 }), ' Вставить в документ');
    const d = row.visitDate ? new Date(row.visitDate) : null;
    const dateLabel = d && !isNaN(d.getTime())
        ? d.toLocaleString(undefined, { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
        : '—';
    const card = h('div', { class: 'modal-card', style: { width: '600px', maxWidth: 'calc(100vw - 32px)' } },
        h('header', { class: 'modal-head' },
            h('div', null,
                h('h2', { style: { margin: 0 } }, Icon(groupId === 'labs' ? 'Flask' : groupId === 'diagnostics' ? 'Activity' : 'Stethoscope', { size: 16 }), ' ', row.serviceName),
                h('div', { class: 'muted', style: { fontSize: '11.5px', marginTop: '3px' } },
                    dateLabel, row.doctorName ? ' · ' + row.doctorName : ''),
            ),
            h('button', { class: 'modal-close', onclick: close }, '×'),
        ),
        body,
        h('footer', { class: 'modal-foot' }, pasteBtn, h('button', { class: 'btn', onclick: close }, 'Закрыть')),
    );
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKey);

    // Branch by group. Labs + diagnostics use the same lab_results table.
    try {
        let _res;
        if (groupId === 'labs' || groupId === 'diagnostics') {
            _res = await fillLabResults(body, row);
        } else {
            _res = await fillServiceConclusion(body, row);
        }
        _pasteHtml = _res && _res.html;
        if (_pasteHtml) pasteBtn.disabled = null;
    } catch (err) {
        clear(body);
        body.appendChild(h('div', { class: 'muted', style: { padding: '14px 0', fontSize: '12.5px', color: 'var(--crit-700)' } },
            trf('Не удалось загрузить результаты: {msg}', { msg: err?.message || err })));
    }
}

// ---------------------------------------------------------------------------
// AURORA_CONSULT_TOOLBAR_V1 — Study-history picker. Lists the patient's REAL
// completed studies from wsState.emr; selecting one inserts a formatted block
// into the focused A4 section. mode: 'func'|'rad' (diagnostics) | 'lab' (labs).
// NOTE: the EMR bucketer only tags labs + diagnostics — func and rad both list
// wsState.emr.diagnostics (just different titles/icons/insert targets).
// ---------------------------------------------------------------------------
async function openStudyHistoryModal(ctx, mode) {
    const META = {
        func: { title: 'Функциональные исследования', icon: 'Activity', bucket: 'diagnostics' },
        rad:  { title: 'Лучевая диагностика',         icon: 'Scan',     bucket: 'diagnostics' },
        lab:  { title: 'Лабораторные исследования',   icon: 'Flask',    bucket: 'labs' },
    };
    const meta = META[mode] || META.lab;
    const studies = (wsState.emr && wsState.emr[meta.bucket]) || [];

    const overlay = h('div', { class: 'modal', style: { zIndex: '140' } });
    const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));

    const prev = h('div', { class: 'st-prev' },
        h('div', { class: 'muted', style: { padding: '12px', fontSize: '12.5px' } }, 'Выберите исследование'));

    const listEl = h('div', { class: 'st-list' });
    if (!studies.length) {
        listEl.appendChild(h('div', { class: 'muted', style: { padding: '10px', fontSize: '12.5px' } }, 'Нет исследований'));
    } else {
        studies.forEach((s) => {
            const d = s.visitDate ? new Date(s.visitDate) : null;
            const dateLabel = d && !isNaN(d) ? d.toLocaleDateString('ru-RU') : '';
            const item = h('button', { class: 'st-item', type: 'button', onclick: () => {
                listEl.querySelectorAll('.st-item.on').forEach(x => x.classList.remove('on'));
                item.classList.add('on');
                renderStudyPreview(ctx, prev, s, mode, close);
            } },
                h('span', { class: 'st-item-n' }, s.serviceName || '—'),
                h('span', { class: 'sub' }, [dateLabel, s.doctorName].filter(Boolean).join(' · ')),
            );
            listEl.appendChild(item);
        });
    }

    const card = h('div', { class: 'modal-card', style: { width: '720px', maxWidth: 'calc(100vw - 32px)' } },
        h('header', { class: 'modal-head' },
            h('h2', { style: { margin: 0 } }, Icon(meta.icon, { size: 16 }), ' ', meta.title),
            h('button', { class: 'modal-close', onclick: close }, '×'),
        ),
        h('div', { class: 'modal-body', style: { padding: '16px 18px' } },
            h('div', { class: 'st-body' }, listEl, prev),
        ),
        h('footer', { class: 'modal-foot' },
            h('span', { class: 'muted', style: { fontSize: '11.5px', marginRight: 'auto' } }, 'Выберите фрагмент и вставьте его в текущий приём'),
            h('button', { class: 'btn', onclick: close }, 'Закрыть'),
        ),
    );
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKey);
}

// Render the right preview pane for a selected study. Lab → checkbox result
// table (lazy-loaded from lab_results); diagnostics → conclusion text + insert.
async function renderStudyPreview(ctx, prev, study, mode, close) {
    clear(prev);
    const isLab = mode === 'lab';
    const d = study.visitDate ? new Date(study.visitDate) : null;
    const dateLabel = d && !isNaN(d) ? d.toLocaleDateString('ru-RU') : '';
    prev.appendChild(h('div', { class: 'st-prev-t' }, study.serviceName || '—'));
    prev.appendChild(h('div', { class: 'sub', style: { marginBottom: '10px' } }, [study.doctorName, dateLabel].filter(Boolean).join(' · ')));

    if (!isLab) {
        // Diagnostics: imaging conclusions are stored the same way (lab_results
        // table keyed by visit_service_id). Build a free-text block and insert.
        const loading = h('div', { class: 'muted', style: { fontSize: '12.5px' } }, 'Загрузка…');
        prev.appendChild(loading);
        const { data } = await supabase.from('lab_results')
            .select('parameter, value, unit, reference_range, flag').eq('visit_service_id', study.id);
        loading.remove();
        const results = data || [];
        const bodyText = results.length
            ? results.map(r => `${esc(r.parameter)}: ${esc(r.value)}${r.unit ? ' ' + esc(r.unit) : ''}`).join('; ')
            : '—';
        prev.appendChild(h('div', { style: { fontSize: '13px', color: 'var(--ink-800)', lineHeight: '1.5' } }, bodyText));
        prev.appendChild(h('button', { class: 'btn btn-primary btn-sm', style: { marginTop: '12px' }, onclick: () => {
            // i18n-exempt: HTML вставляется В ДОКУМЕНТ приёма
            const html = `<div><b>${esc(study.serviceName)} от ${dateLabel}.</b> ${bodyText}</div>`;
            _pastePickField(ctx, html, 'instrumental_text', 'Вставлено в документ');
            close && close();
        } }, Icon('Plus', { size: 13 }), ' Вставить в документ'));
        return;
    }

    // Lab mode: checkbox row selection from lab_results.
    const loading = h('div', { class: 'muted', style: { fontSize: '12.5px' } }, 'Загрузка…');
    prev.appendChild(loading);
    const { data } = await supabase.from('lab_results')
        .select('parameter, value, unit, reference_range, flag').eq('visit_service_id', study.id);
    loading.remove();
    const rows = data || [];
    if (!rows.length) { prev.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px' } }, 'Результаты не внесены')); return; }
    const checked = rows.map(() => true);
    const tbody = h('tbody');
    rows.forEach((r, i) => {
        const flagColor = r.flag === 'low' ? 'var(--primary-700)' : r.flag === 'high' ? 'var(--crit-700)' : 'var(--ink-800)';
        const cb = h('input', { type: 'checkbox', checked: '', style: { pointerEvents: 'none' } });
        const tr = h('tr', { class: 'on', onclick: () => { checked[i] = !checked[i]; tr.classList.toggle('on', checked[i]); cb.checked = checked[i]; } });
        tr.append(
            h('td', { style: { width: '30px' } }, cb),
            h('td', null, esc(r.parameter)),
            h('td', { style: { fontWeight: '600', color: flagColor } }, `${esc(r.value)}${r.unit ? ' ' + esc(r.unit) : ''}`),
            h('td', { class: 'sub' }, r.reference_range || '—'),
        );
        tbody.appendChild(tr);
    });
    prev.appendChild(h('table', { class: 'st-tbl' },
        h('thead', null, h('tr', null, h('th', null, ''), h('th', null, 'Показатель'), h('th', null, 'Результат'), h('th', null, 'Норма'))),
        tbody,
    ));
    prev.appendChild(h('button', { class: 'btn btn-primary btn-sm', style: { marginTop: '12px' }, onclick: () => {
        const chosen = rows.filter((_, i) => checked[i]);
        if (!chosen.length) { toast('Выберите хотя бы один показатель', 'warn'); return; }
        const lines = chosen.map(r => `<tr><td>${esc(r.parameter)}</td><td>${esc(r.value)}${r.unit ? ' ' + esc(r.unit) : ''}</td><td>${esc(r.reference_range || '—')}</td></tr>`).join('');
        /* i18n-exempt-start: HTML вставляется В ДОКУМЕНТ приёма (таблица результатов) */
        const html = `<div><b>${esc(study.serviceName)} от ${dateLabel}:</b></div>`
            + `<table class="a4-restbl"><thead><tr><th>Показатель</th><th>Результат</th><th>Норма</th></tr></thead><tbody>${lines}</tbody></table>`;
        /* i18n-exempt-end */
        _pastePickField(ctx, html, 'labs_text', 'Вставлено в документ');
        close && close();
    } }, Icon('Plus', { size: 14 }), ' Вставить результаты в документ'));
}

async function fillServiceConclusion(body, row) {
    const { data, error } = await supabase
        .from('visit_services')
        .select('notes')
        .eq('id', row.id)
        .maybeSingle();
    clear(body);
    if (error) throw error;
    let payload = null;
    try { payload = data?.notes ? JSON.parse(data.notes) : null; } catch {}
    const history = payload?.history || [];
    // Prefer the most recent signed entry; fall back to latest draft.
    const signed = [...history].reverse().find(it => it.kind === 'signed');
    const latest = signed || [...history].reverse().find(it => it.kind === 'draft');

    if (!latest) {
        body.appendChild(h('div', { class: 'muted', style: { padding: '14px 0', fontSize: '12.5px' } },
            'Заключение по этой услуге не записано.'));
        return { html: null };
    }
    if (signed) {
        body.appendChild(h('div', {
            style: { marginBottom: '12px', padding: '8px 10px', background: 'var(--ok-50)',
                     border: '1px solid #c7e8d2', borderRadius: '8px',
                     fontSize: '11.5px', color: 'var(--ok-700)', fontWeight: 600,
                     display: 'flex', alignItems: 'center', gap: '6px' },
        }, Icon('Check', { size: 12 }), ' Подписано · ', dateTimeShort(signed.savedAt)));
    } else {
        body.appendChild(h('div', {
            style: { marginBottom: '12px', padding: '8px 10px', background: 'var(--warn-50)',
                     border: '1px solid #f0d29b', borderRadius: '8px',
                     fontSize: '11.5px', color: 'var(--warn-700)', fontWeight: 600 },
        }, 'Черновик (не подписан)'));
    }
    const f = latest.fields || {};
    body.append(
        snapshotKv('Жалобы',            f.chief_complaint   || '—', true),
        snapshotKv('Анамнез',           f.hpi               || '—', true),
        snapshotKv('Осмотр',            f.physical_exam     || '—', true),
        h('div', { class: 'row', style: { gap: '12px', marginTop: '6px' } },
            h('div', { style: { flex: 2 } }, snapshotKv('Основной диагноз', f.primary_diagnosis || '—')),
            h('div', { style: { flex: 1 } }, snapshotKv('МКБ-10',           f.icd10             || '—')),
        ),
        h('div', { class: 'row', style: { gap: '12px' } },
            h('div', { style: { flex: 1 } }, snapshotKv('Контроль',    f.follow_up || '—')),
            h('div', { style: { flex: 1 } }, snapshotKv('Направление', f.referral  || '—')),
        ),
    );
    const _parts = [];
    /* i18n-exempt-start: HTML сводки уходит В ДОКУМЕНТ, не в интерфейс */
    if (f.physical_exam)        _parts.push('Осмотр: ' + esc(f.physical_exam));
    if (f.primary_diagnosis)    _parts.push('Диагноз: ' + esc(f.primary_diagnosis));
    if (f.recommendations_text) _parts.push('Рекомендации: ' + esc(f.recommendations_text));
    /* i18n-exempt-end */
    return { html: _parts.length ? '<div>' + _parts.join('. ') + '</div>' : null };
}

async function fillLabResults(body, row) {
    const { data, error } = await supabase
        .from('lab_results')
        .select('parameter, value, unit, reference_range, flag')
        .eq('visit_service_id', row.id);
    clear(body);
    if (error) throw error;
    const results = data || [];
    if (results.length === 0) {
        body.appendChild(h('div', { class: 'muted', style: { padding: '14px 0', fontSize: '12.5px' } },
            'Результаты по этому назначению ещё не внесены.'));
        return { html: null };
    }
    const flagged = results.filter(r => r.flag && r.flag !== 'normal').length;
    if (flagged > 0) {
        body.appendChild(h('div', {
            style: { marginBottom: '12px', padding: '8px 10px',
                     background: 'var(--warn-50)', border: '1px solid #f0d29b',
                     borderRadius: '8px', fontSize: '11.5px', color: 'var(--warn-700)', fontWeight: 600 },
        }, Icon('Warning', { size: 12 }), ' ', String(flagged), ' показатель(ей) вне нормы'));
    }
    const tbl = h('table', { class: 'tbl', style: { fontSize: '12.5px' } },
        h('thead', null, h('tr', null,
            h('th', null, 'Параметр'),
            h('th', { style: { textAlign: 'right' } }, 'Значение'),
            h('th', null, 'Ед.'),
            h('th', null, 'Норма'),
            h('th', null, 'Флаг'),
        )),
        h('tbody', null, ...results.map(r => {
            const flagColor = r.flag === 'critical' ? 'var(--crit-700)'
                            : r.flag === 'high' || r.flag === 'low' || r.flag === 'abnormal' ? 'var(--warn-700)'
                            : 'var(--ink-500)';
            return h('tr', null,
                h('td', { class: 'cell-strong' }, r.parameter || '—'),
                h('td', { class: 'num cell-strong', style: { textAlign: 'right', color: flagColor } },
                    r.value != null ? String(r.value) : '—'),
                h('td', { class: 'muted' }, r.unit || '—'),
                h('td', { class: 'muted num', style: { fontSize: '11.5px' } }, r.reference_range || '—'),
                h('td', null, r.flag && r.flag !== 'normal'
                    ? h('span', {
                        style: { fontSize: '10.5px', fontWeight: 700, color: flagColor,
                                 padding: '1px 7px', borderRadius: '999px',
                                 background: 'color-mix(in oklab, ' + flagColor + ' 10%, white)',
                                 textTransform: 'uppercase', letterSpacing: '0.04em' },
                    }, r.flag)
                    : h('span', { class: 'muted', style: { fontSize: '11px' } }, '—')),
            );
        })),
    );
    body.appendChild(tbl);
    const _pasteHtml = '<div><b>' + esc(row.serviceName || 'Результаты') + '.</b> ' +
        results.map(r => esc(r.parameter || '') + ': ' + esc(r.value != null ? String(r.value) : '—') + (r.unit ? ' ' + esc(r.unit) : '')).join('; ') + '</div>';
    return { html: _pasteHtml };
}

// ===========================================================================
// Persistence — JSON blob inside visit_services.notes
// ---------------------------------------------------------------------------
// Shape:
//   {
//     __service_workspace_v1: 1,
//     current: { ...latest SOAP fields... },          // hydrates the form
//     history: [
//       { kind: 'draft'|'signed'|'referral', savedAt, fields?, department?, departmentLabel?, reason? }
//     ]
//   }
// `current` is what the form prefills with on reload; `history` is the
// chronological audit trail shown in the right-column "Conclusions" card.
// `wsState` caches the parsed payload between save/refer cycles so each
// click only writes (no extra read round-trip).
// ===========================================================================
const DRAFT_TAG = '__service_workspace_v1';
const wsState = { payload: null, recommendations: [], emr: null, emrFilter: 'all', saved: false, rtab: 'hints', lastA4: null, dispensed: [], docType: 'conclusion', blank: false, diagImages: [] };  // RX_SEPARATE_V1 · DIAG_IMAGES_V1
// AURORA_CONSULT_TEMPLATES_V1 — template library («Шаблоны заключений») module state + helpers.
// In-memory cache of the last load (re-initialised on each openTemplateLibraryModal call).
let tplState = { rows: [], filter: 'all', q: '', selId: null, mode: 'view', draft: null };
// The ONLY safe template body keys — a4Section .a4-input fields. EXCLUDES the auto-synced
// primary_diagnosis and the hidden non-document controls (icd10 / follow_up / referral).
const TPL_BODY_KEYS = [
    'chief_complaint',      // ЖАЛОБЫ
    'hpi',                  // АНАМНЕЗ
    'labs_text',            // ЛАБОРАТОРНЫЕ
    'instrumental_text',    // ИНСТРУМЕНТАЛЬНЫЕ
    'physical_exam',        // ОСМОТР
    'therapy_text',         // ТЕРАПИЯ
    'recommendations_text', // РЕКОМЕНДАЦИИ
];
const TPL_LABELS = {
    chief_complaint: 'Жалобы', hpi: 'Анамнез', labs_text: 'Лабораторные',
    instrumental_text: 'Инструментальные', physical_exam: 'Осмотр',
    therapy_text: 'Терапия', recommendations_text: 'Рекомендации',
};
// DOC_TPL_DIAG_V1 — templates can also target the imaging «Диагностика» document.
const TPL_DIAG_KEYS = ['instrumental_text', 'primary_diagnosis'];
const TPL_DIAG_LABELS = { instrumental_text: 'Описание', primary_diagnosis: 'Заключение' };
const TPL_TYPES = [
    { dt: 0, label: 'Приём (осмотр, консультация)', keys: TPL_BODY_KEYS, labels: TPL_LABELS },
    { dt: 1, label: 'Диагностика (описание, заключение)', keys: TPL_DIAG_KEYS, labels: TPL_DIAG_LABELS },
];
function tplTypeOf(dt) { return TPL_TYPES.find(t => t.dt === (Number(dt) || 0)) || TPL_TYPES[0]; }
const me = () => currentUser() || {};
const myId = () => me().id || null;
const myName = () => me().full_name || me().username || 'доктор';

function emptyPayload() {
    return { [DRAFT_TAG]: 1, current: null, history: [] };
}

// Collect every [data-field] element under the page root into a flat object.
// contentEditable A4 fields carry their value in innerHTML; plain
// inputs/selects/textareas in .value. (AURORA_CONSULT_EDITOR_V1)
function collectFields(ctx) {
    const root = ctx.container;
    const out  = {};
    for (const el of root.querySelectorAll('[data-field]')) {
        if (el.closest('.a4-sec-off')) continue;   // WS_FLEX_DOC_V1 — removed sections don't save/print
        const k = el.getAttribute('data-field');
        if (el.classList.contains('a4-input')) {
            out[k] = (el.innerHTML || '').trim();
        } else {
            out[k] = (el.value ?? '').trim();
        }
    }
    return out;
}

function applyFields(ctx, fields) {
    try { setTimeout(() => renderBlank(ctx), 0); } catch (e) {}   // WYSIWYG_BLANK_V1
    if (!fields) return;
    const root = ctx.container;
    for (const el of root.querySelectorAll('[data-field]')) {
        const k = el.getAttribute('data-field');
        if (fields[k] == null) continue;
        if (el.classList.contains('a4-input')) {
            const v = fields[k];
            // Old notes were saved as plain text and may contain "<" (e.g. "SpO2 <95%").
            // Only treat the value as HTML when it actually carries markup; otherwise set
            // textContent so legacy plain text survives round-trip without mangling.
            // SECURITY (H7): notes JSON is client-authored and may be viewed by a
            // different clinician on the same tenant, so any markup MUST be sanitized
            // before it re-enters the live DOM — otherwise a stored SOAP field is a
            // stored-XSS sink. (STORED_XSS_HARDEN_V1)
            if (/<[a-z!\/]/i.test(v)) el.innerHTML = sanitizeRichHtml(v); else el.textContent = v;
        } else {
            el.value = fields[k];
        }
    }
    // WS_FLEX_DOC_V1 — reveal any section that has saved content on re-open.
    try {
        ensureDocSections();
        for (const sdef of DOC_SECTIONS) {
            const v = fields[sdef.field];
            if (v != null && String(v).trim()) wsState.docSections.add(sdef.sec);
        }
        const _dp = fields['doctor_phone'];
        if (_dp != null && String(_dp).trim()) {
            wsState.docPhone = true;
            const _el = ctx.container.querySelector('[data-docphone]');
            if (_el) _el.classList.remove('a4-sec-off');
        }
        syncSections(ctx);
    } catch (e) {}
}

function updateSavedMarker(ctx, label) {
    const m = ctx.container.querySelector('[data-saved-marker]');
    if (!m) return;
    clear(m);
    // SAVE_STATUS_COLOR_V1 — saved/signed → green status pill.
    m.classList.remove('unsaved'); m.classList.add('saved');
    m.appendChild(Icon('Check', { size: 12 }));
    m.appendChild(document.createTextNode(' ' + label));
}

function shortTime(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}
function dateOnly(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined, { day: '2-digit', month: 'short' });
}
function dateTimeShort(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return dateOnly(iso) + ' ' + shortTime(iso);
}

async function readPayload(ctx) {
    if (!ctx.visitServiceId) return emptyPayload();
    const { data, error } = await supabase
        .from('visit_services').select('notes').eq('id', ctx.visitServiceId).maybeSingle();
    if (error) { console.warn('[workspace] read failed:', error.message); return emptyPayload(); }
    if (!data?.notes) return emptyPayload();
    let parsed = null;
    try { parsed = JSON.parse(data.notes); } catch { return emptyPayload(); }
    if (!parsed || parsed[DRAFT_TAG] !== 1) return emptyPayload();
    if (!Array.isArray(parsed.history)) parsed.history = [];
    return parsed;
}

async function writePayload(ctx, payload, extraUpdate = {}) {
    if (!ctx.visitServiceId) return false;
    const { error } = await supabase.from('visit_services')
        .update({ notes: JSON.stringify(payload), ...extraUpdate })
        .eq('id', ctx.visitServiceId);
    if (error) { toast(trf('Не удалось сохранить: {msg}', { msg: error.message }), 'fail'); return false; }
    wsState.payload = payload;
    return true;
}

async function hydrateWorkspace(ctx) {
    try {
        const payload = await readPayload(ctx);
        wsState.payload = payload;
        wsState.diagImages = Array.isArray(payload.diagImages) ? payload.diagImages.slice() : [];   // DIAG_IMAGES_V1 — restore uploaded images
        if (payload.current) applyFields(ctx, payload.current);
        paintHistoryList(ctx);
        paintPrescriptions(ctx);
        paintDispensed(ctx);                          // RX_SEPARATE_V1 — show empty/guard state immediately
        loadDispensedItems(ctx).then(() => paintDispensed(ctx));  // then fill async
        paintDiagnoses(ctx);
        paintOwnServices(ctx);
        await loadRecommendations(ctx);
        paintRecommendations(ctx);
        const last = payload.history[payload.history.length - 1];
        if (last) {
            const label = last.kind === 'signed' ? 'Подписано' : last.kind === 'referral' ? 'Последняя активность' : 'Черновик загружен';
            updateSavedMarker(ctx, `${label} · ${dateTimeShort(last.savedAt)}`);
        }
    } catch (e) { console.warn('[workspace] hydrate exception:', e); }
}

// ---------------------------------------------------------------------------
// Prescriptions — free-text entries the doctor types in via a popup.
// Persisted under payload.prescriptions on the visit_services.notes JSON.
// ---------------------------------------------------------------------------
// RX_IN_FORM_V1 — render prescriptions as a read-only table on the editable sheet.
function paintRxDoc(ctx) {
    const els = ctx.container ? ctx.container.querySelectorAll('[data-rx-doc]') : null;
    if (!els || !els.length) return;
    const list = (wsState.payload && wsState.payload.prescriptions || []).filter(r => r && r.name);
    const th = { textAlign: 'left', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '.04em', color: 'var(--ink-500,#6b7285)', fontWeight: '700', padding: '0 8px 5px 0', borderBottom: '1.5px solid var(--ink-200,#e3e6ec)' };
    const td = { padding: '6px 8px 6px 0', borderBottom: '1px solid var(--ink-100,#eef0f4)', fontSize: '13px', verticalAlign: 'top' };
    for (const el of els) {
        el.replaceChildren();
        if (!list.length) { el.classList.add('a4-sec-off'); continue; }
        el.classList.remove('a4-sec-off');
        el.appendChild(h('span', { class: 'a4-sec-tag' }, 'РЕЦЕПТ · RETSEPT'));
        el.appendChild(h('table', { style: { width: '100%', borderCollapse: 'collapse', marginTop: '4px' } },
            h('thead', null, h('tr', null,
                h('th', { style: Object.assign({}, th, { width: '22px' }) }, '№'),
                h('th', { style: th }, 'Препарат'),
                h('th', { style: th }, 'Доза'),
                h('th', { style: th }, 'Режим приёма'),
                h('th', { style: th }, 'Длительность'))),
            h('tbody', null, list.map((r, i) => h('tr', null,
                h('td', { style: Object.assign({}, td, { color: 'var(--primary-600,#167873)', fontWeight: '700' }) }, String(i + 1)),
                h('td', { style: Object.assign({}, td, { fontWeight: '600' }) }, r.name, r.notes ? h('div', { style: { fontWeight: '400', fontStyle: 'italic', color: '#7a8290', fontSize: '11.5px', marginTop: '2px' } }, r.notes) : null, r.nurse ? h('div', { style: { fontWeight: '400', color: '#7a8290', fontSize: '11.5px', marginTop: '2px' } }, trf('Медсестре: {name}', { name: r.nurse })) : null),
                h('td', { style: td }, r.dose || '—'),
                h('td', { style: td }, r.freq || '—'),
                h('td', { style: td }, r.dur || '—'))))));
    }
}

function paintPrescriptions(ctx) {
    try { setTimeout(() => renderBlank(ctx), 0); } catch (e) {}   // WYSIWYG_BLANK_V1
    try { paintRxDoc(ctx); } catch (e) {}   // RX_IN_FORM_V1
    const listEl = ctx.container?.querySelector('[data-prescriptions-list]');
    if (!listEl) return;
    clear(listEl);
    const items = (wsState.payload?.prescriptions || []);
    if (items.length === 0) {
        listEl.appendChild(h('div', {
            class: 'muted',
            style: {
                fontSize: '12.5px', padding: '10px 12px',
                background: 'var(--ink-25)', border: '1px dashed var(--ink-200)',
                borderRadius: '8px', textAlign: 'center',
            },
        }, 'Рецептов пока нет — нажмите «Добавить».'));
        return;
    }
    for (let i = 0; i < items.length; i++) {
        const rx = items[i];
        const meta = [rx.freq, rx.dur, rx.notes].filter(Boolean).join(' · ');
        listEl.appendChild(h('div', {
            class: 'row',
            style: { padding: '10px 12px', background: 'var(--primary-50)', borderRadius: '9px', border: '1px solid var(--primary-200)', gap: '12px' },
        },
            Icon('Pill', { size: 16 }),
            h('div', { style: { flex: 1, minWidth: 0 } },
                h('div', { style: { fontSize: '13.5px', fontWeight: 600, color: 'var(--ink-900)' } },
                    rx.name || '(без названия)',
                    rx.dose ? h('span', { style: { color: 'var(--ink-500)', fontWeight: 500 } }, ' · ' + rx.dose) : null),
                meta && h('div', { class: 'muted', style: { fontSize: '11.5px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, meta),
                rx.nurse && h('div', { style: { fontSize: '11.5px', color: 'var(--warn-700, #b45309)', marginTop: '2px' } }, trf('Медсестре: {name}', { name: rx.nurse })),
            ),
            h('button', { class: 'btn btn-ghost btn-sm', type: 'button', title: 'Изменить', onclick: () => openPrescriptionDialog(ctx, i) }, Icon('Edit', { size: 12 })),
            canDeleteRole('consultation') && h('button', { class: 'btn btn-ghost btn-sm', type: 'button', title: 'Удалить', style: { color: 'var(--crit-700)' }, onclick: () => removePrescription(ctx, i) }, Icon('Trash', { size: 12 })),
        ));
    }
}

function openPrescriptionDialog(ctx, editIndex) {
    const existing = (editIndex != null) ? (wsState.payload?.prescriptions || [])[editIndex] : null;

    const overlay = h('div', { class: 'modal', style: { zIndex: '130' } });
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: () => overlay.remove() }));

    // RX_MULTI_V1 — one editable drug row; read() returns the entry, el is the DOM.
    function drugRow(seed, removable, onRemove) {
        const nameInput  = h('input', { value: seed?.name  || '', placeholder: 'напр. Метформин' });
        const doseInput  = h('input', { value: seed?.dose  || '', placeholder: 'напр. 500 мг' });
        const freqInput  = h('input', { value: seed?.freq  || '', placeholder: 'напр. 2 раза в день во время еды' });
        const durInput   = h('input', { value: seed?.dur   || '', placeholder: 'напр. 90 дней' });
        const notesInput = h('textarea', { rows: '2', placeholder: 'Необязательно — указания, предупреждения…' });
        if (seed?.notes) notesInput.value = seed.notes;
        const nurseInput = h('textarea', { rows: '2', placeholder: 'напр. в/м 2 раза в день, после еды; контроль АД…' });
        if (seed?.nurse) nurseInput.value = seed.nurse;
        const el = h('div', { style: { border: '1px solid var(--ink-150, #e3e6ec)', borderRadius: '10px', padding: '12px 12px 4px', marginBottom: '10px', position: 'relative' } },
            removable ? h('button', { class: 'btn btn-ghost btn-sm', type: 'button', title: 'Убрать препарат', style: { position: 'absolute', top: '7px', right: '7px', color: 'var(--crit-700)' }, onclick: onRemove }, Icon('Trash', { size: 12 })) : null,
            h('div', { class: 'field' },
                h('label', null, 'Название препарата ', h('span', { style: { color: 'var(--crit-500)' } }, '*')),
                nameInput),
            h('div', { class: 'field-row', style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' } },
                h('div', { class: 'field' }, h('label', null, 'Доза'),        doseInput),
                h('div', { class: 'field' }, h('label', null, 'Длительность'), durInput)),
            h('div', { class: 'field' }, h('label', null, 'Частота / указания'), freqInput),
            h('div', { class: 'field' }, h('label', null, 'Примечания'),        notesInput),
            h('div', { class: 'field' }, h('label', null, 'Инструкция для медсестры (стационар)'), nurseInput),
        );
        return { el, read: () => ({ name: nameInput.value.trim(), dose: doseInput.value.trim(), freq: freqInput.value.trim(), dur: durInput.value.trim(), notes: notesInput.value.trim(), nurse: nurseInput.value.trim() }) };
    }

    const rows = [];
    const rowsWrap = h('div', {});
    function addRow(seed) {
        const r = drugRow(seed, (editIndex == null), () => { const i = rows.indexOf(r); if (i >= 0) { rows.splice(i, 1); r.el.remove(); } });
        rows.push(r);
        rowsWrap.appendChild(r.el);
        return r;
    }
    // RX_MANAGE_V1 — «Рецепт» opens the WHOLE current prescription so any drug can be
    // edited or removed (корзина), and new ones added; single-drug edit still works.
    const _seed = existing ? [existing] : ((wsState.payload && wsState.payload.prescriptions || []).filter(x => x && x.name));
    if (_seed.length) _seed.forEach(sd => addRow(sd));
    else addRow();

    // Only in «new» mode can you stack several drugs.
    const addBtn = existing ? null : h('button', { class: 'btn btn-outline', type: 'button', style: { marginBottom: '6px' }, onclick: () => { const r = addRow(); const inp = r.el.querySelector('input'); if (inp) inp.focus(); } },
        Icon('Plus', { size: 13 }), ' Добавить препарат');

    const card = h('div', { class: 'modal-card', style: { width: '540px', maxHeight: '86vh', display: 'flex', flexDirection: 'column' } },
        h('header', { class: 'modal-head' },
            h('h2', null, Icon('Pill', { size: 16 }), ' ', existing ? 'Изменить рецепт' : (_seed.length ? 'Рецепт — редактирование' : 'Новый рецепт')),
            h('button', { class: 'modal-close', onclick: () => overlay.remove() }, '×'),
        ),
        h('div', { class: 'modal-body', style: { overflowY: 'auto' } },
            rowsWrap,
            addBtn,
        ),
        h('footer', { class: 'modal-foot' },
            h('button', { class: 'btn', onclick: () => overlay.remove() }, 'Отмена'),
            h('button', { class: 'btn btn-primary', onclick: async (ev) => {
                ev.currentTarget.disabled = true;
                try {
                    const entries = rows.map(r => r.read()).filter(e => e.name);
                    const payload = wsState.payload || await readPayload(ctx);
                    payload.prescriptions = Array.isArray(payload.prescriptions) ? payload.prescriptions : [];
                    if (editIndex != null) {
                        if (!entries.length) { toast('Укажите название препарата.', 'fail'); return; }
                        payload.prescriptions[editIndex] = entries[0];
                    } else {
                        if (!entries.length && payload.prescriptions.length && !confirm(tr('Удалить все препараты из рецепта?'))) return;
                        payload.prescriptions = entries;   // RX_MANAGE_V1 — the dialog is the full list
                    }
                    if (!await writePayload(ctx, payload)) return;
                    paintPrescriptions(ctx);
                    overlay.remove();
                    toast(existing ? 'Рецепт обновлён.' : 'Рецепт сохранён.');
                } finally {
                    if (ev.currentTarget?.isConnected) ev.currentTarget.disabled = false;
                }
            } }, Icon('Check', { size: 14 }), ' Сохранить рецепт'),
        ),
    );
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    setTimeout(() => { const first = rowsWrap.querySelector('input'); if (first) first.focus(); }, 30);

    document.addEventListener('keydown', function onKey(e) {
        if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', onKey); }
    });
}

async function removePrescription(ctx, index) {
    const payload = wsState.payload || await readPayload(ctx);
    const items = Array.isArray(payload.prescriptions) ? payload.prescriptions : [];
    const entry = items[index];
    if (!entry) return;
    if (!confirm(trf('Удалить {name}?', { name: entry.name || tr('этот препарат') }))) return;
    items.splice(index, 1);
    payload.prescriptions = items;
    if (!await writePayload(ctx, payload)) return;
    paintPrescriptions(ctx);
    toast('Удалено.');
}

// ---------------------------------------------------------------------------
// Recommended services — list of pending recommended_services rows for the
// current patient. The doctor adds entries via the Refer-to panel on the right;
// the list re-renders here in the Plan block as well as on the patient card.
// ---------------------------------------------------------------------------
async function loadRecommendations(ctx) {
    if (!ctx.patient?.id) { wsState.recommendations = []; return; }
    console.debug('[workspace] loadRecommendations for patient', ctx.patient.id);
    let { data, error } = await supabase
        .from('recommended_services')
        .select('*, services(name, price), users:recommended_by(full_name, specialty)')
        .eq('patient_id', ctx.patient.id)
        .eq('status', 'pending')
        .order('created_at', { ascending: false });
    if (error) {
        console.warn('[workspace recs] join failed, retrying flat:', error.message);
        const flat = await supabase.from('recommended_services').select('*')
            .eq('patient_id', ctx.patient.id).eq('status', 'pending')
            .order('created_at', { ascending: false });
        if (flat.error) {
            console.error('[workspace recs] flat select also failed:', flat.error);
            wsState.recommendations = [];
            if (/relation .* does not exist/i.test(flat.error.message) ||
                /could not find the table/i.test(flat.error.message) ||
                /schema cache/i.test(flat.error.message)) {
                toast('Сначала примените миграцию 009_recommended_services.sql.', 'fail');
            } else {
                toast('Recommendations load failed: ' + flat.error.message, 'fail');
            }
            return;
        }
        data = flat.data;
    }
    console.debug(`[workspace] recommendations loaded: ${data?.length || 0}`);
    wsState.recommendations = (data || []).map(r => ({
        ...r,
        __service_name: r.services?.name || r.service_name || '—',
        __doctor_name:  r.users?.full_name || r.recommended_by_name || '(unknown)',
        __price:        r.services?.price,
    }));
}

function paintRecommendations(ctx) {
    try { setTimeout(() => renderBlank(ctx), 0); } catch (e) {}   // WYSIWYG_BLANK_V1
    // PAPER_RECS_DUAL_V1 — «Рекомендации» card now lives in BOTH the side panel and the
    // document tools; paint every list instance (querySelector only found the first).
    const wraps = ctx.container?.querySelectorAll('[data-recommendations-list]');
    if (!wraps || !wraps.length) return;
    const recs = wsState.recommendations || [];
    const buildEmpty = () => h('div', {
        class: 'muted',
        style: {
            fontSize: '12.5px', padding: '10px 12px',
            background: 'var(--ink-25)', border: '1px dashed var(--ink-200)',
            borderRadius: '8px', textAlign: 'center',
        },
    }, 'Рекомендаций пока нет — нажмите «Добавить».');
    const buildRow = (rec) => {
        const isThisVisit = rec.source_visit_id && ctx.visitId && rec.source_visit_id === ctx.visitId;
        return h('div', {
            class: 'row',
            style: {
                padding: '10px 12px',
                background: isThisVisit ? 'var(--info-50)' : 'white',
                border: '1px solid var(--info-200, #c7dcfd)',
                borderRadius: '9px',
                gap: '12px',
            },
        },
            h('span', { style: { color: 'var(--info-700)' } }, Icon('Heart', { size: 14 })),
            h('div', { style: { flex: 1, minWidth: 0 } },
                h('div', { style: { fontSize: '13.5px', fontWeight: 600, color: 'var(--ink-900)' } },
                    rec.__service_name,
                    isThisVisit && h('span', {
                        style: { marginLeft: '6px', fontSize: '10px', fontWeight: 700, color: 'var(--info-700)', background: 'white', padding: '1px 6px', borderRadius: '999px', letterSpacing: '0.05em' },
                    }, 'СЕЙЧАС'),
                ),
                h('div', { class: 'muted', style: { fontSize: '11.5px' } },
                    'Рекомендовал ', h('b', { style: { color: 'var(--info-700)' } }, rec.__doctor_name),
                    rec.notes ? ' · ' + rec.notes : '',
                    rec.__price != null ? ' · ' + Number(rec.__price).toLocaleString('ru-RU') + ' UZS' : '',
                ),
            ),
            canDeleteRole('consultation') && h('button', {
                class: 'btn btn-ghost btn-sm', type: 'button',
                title: 'Удалить эту рекомендацию',
                style: { color: 'var(--crit-700)' },
                onclick: () => removeWorkspaceRec(ctx, rec.id),
            }, Icon('Trash', { size: 12 })),
        );
    };
    wraps.forEach((wrap) => {
        clear(wrap);
        if (recs.length === 0) { wrap.appendChild(buildEmpty()); return; }
        for (const rec of recs) wrap.appendChild(buildRow(rec));
    });
}

async function removeWorkspaceRec(ctx, id) {
    if (!confirm(tr('Удалить эту рекомендацию?'))) return;
    // Snapshot the row before flipping its status so the log shows what
    // was cancelled, not just a bare id.
    const rec = (wsState.recommendations || []).find(r => r.id === id);
    const { error } = await supabase.from('recommended_services')
        .update({ status: 'cancelled', closed_at: new Date().toISOString() })
        .eq('id', id);
    if (error) { toast(error.message, 'fail'); return; }
    await logPatientActivity({
        patientId:   ctx.patient?.id,
        visitId:     ctx.visitId || null,
        entityType:  'recommendation',
        entityId:    id,
        entityLabel: rec?.__service_name || rec?.service_name || '(recommendation)',
        action:      'cancelled',
        summary:     `Cancelled recommendation: ${rec?.__service_name || rec?.service_name || '(unnamed)'}`,
    });
    await loadRecommendations(ctx);
    paintRecommendations(ctx);
    toast('Рекомендация удалена.');
}

// Repaint the Conclusions card in the right column from wsState.payload.
// AURORA_PATIENT_DOCS_V1 — list the patient's documents across all visits (the same
// visit_documents archive the patient card reads), newest first.
async function paintPatientDocs(ctx) {
    const body = ctx.container?.querySelector('[data-history-body]');
    if (!body || !ctx.patient?.id) return;
    let rows = [];
    try {
        const { data } = await supabase.from('visit_documents')
            .select('id, title, doc_type, created_at, file_path')
            .eq('patient_id', ctx.patient.id)
            .order('created_at', { ascending: false }).limit(50);
        rows = data || [];
    } catch (e) {}
    clear(body);
    if (!rows.length) {
        body.appendChild(h('div', { class: 'muted', style: { padding: '14px 16px', fontSize: '12.5px' } }, 'У пациента ещё нет документов.'));
        return;
    }
    const DOC_LABEL = { protocol: 'Заключение приёма', diag: 'Заключение диагностики', lab: 'Лабораторный результат', file: 'Документ' };
    rows.forEach((d, i) => body.appendChild(h('div', {
        class: 'row', style: { gap: '10px', alignItems: 'center', padding: '10px 14px', borderTop: i === 0 ? '0' : '1px solid var(--ink-100)' },
    },
        h('div', { style: { width: '26px', height: '26px', borderRadius: '7px', background: 'var(--primary-50)', color: 'var(--primary-700)', display: 'grid', placeItems: 'center', flex: '0 0 auto' } }, Icon('Doc', { size: 13 })),
        h('div', { style: { flex: 1, minWidth: 0 } },
            h('div', { style: { fontSize: '12.5px', fontWeight: 600, color: 'var(--ink-900)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, d.title || DOC_LABEL[d.doc_type] || 'Документ'),
            h('div', { class: 'muted', style: { fontSize: '11px' } }, dateTimeShort(d.created_at)),
        ),
        h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: () => openPatientDoc(ctx, d) }, Icon('ArrowRight', { size: 12 }), ' Открыть'),
    )));
}

// Open a stored document — the full viewer (files + structured conclusions) lives in the
// patient card's Documents tab.
function openPatientDoc(ctx, d) {
    if (ctx.onNavigate) ctx.onNavigate('patient-card', ctx.patient);
    else toast('Документ доступен в карте пациента', 'info');
}

function paintHistoryList(ctx) {
    const body = ctx.container.querySelector('[data-history-body]');
    if (!body) return;
    const history = wsState.payload?.history || [];
    clear(body);
    if (history.length === 0) {
        body.appendChild(h('div', {
            class: 'muted',
            style: { padding: '14px 16px', fontSize: '12.5px' },
        }, 'No saved notes yet. Click ', h('b', null, 'Save draft'), ' below.'));
        return;
    }
    // Newest first. We keep the original index so the delete handler can
    // splice the right entry out of the chronological array.
    const items = history.map((it, originalIdx) => ({ it, originalIdx })).reverse();
    items.forEach(({ it, originalIdx }, displayIdx) =>
        body.appendChild(historyRow(it, displayIdx === 0, ctx, originalIdx)));
}

function historyRow(item, isFirst, ctx, originalIdx) {
    const meta = historyMeta(item);
    // Drafts and referrals can be deleted; signed conclusions stay as audit.
    // Editor-level roles never see delete actions (no delete buttons anywhere).
    const canDelete = (item.kind === 'draft' || item.kind === 'referral') && canDeleteRole('consultation');

    // Nested inside a div-row (not a button) so a nested <button> is valid
    // HTML; the row uses onclick on the div.
    const trashBtn = canDelete ? h('button', {
        type: 'button',
        title: item.kind === 'referral' ? 'Удалить направление' : 'Удалить черновик',
        onclick: (ev) => { ev.stopPropagation(); handleDeleteEntry(ctx, originalIdx); },
        onmouseenter: (ev) => { ev.currentTarget.style.background = 'var(--crit-50)'; ev.currentTarget.style.color = 'var(--crit-700)'; },
        onmouseleave: (ev) => { ev.currentTarget.style.background = 'transparent'; ev.currentTarget.style.color = 'var(--ink-400)'; },
        style: {
            border: 'none', background: 'transparent',
            color: 'var(--ink-400)', cursor: 'pointer',
            padding: '4px', borderRadius: '6px',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            flex: '0 0 auto',
        },
    }, Icon('Trash', { size: 14 })) : null;

    const row = h('div', {
        role: 'button',
        tabindex: '0',
        onclick: () => openSnapshotModal(ctx, item),
        onkeydown: (ev) => {
            if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openSnapshotModal(ctx, item); }
        },
        title: 'Open saved snapshot',
        style: {
            display: 'flex', gap: '10px', alignItems: 'flex-start',
            padding: '10px 14px',
            borderTop: isFirst ? '0' : '1px solid var(--ink-100)',
            cursor: 'pointer',
            transition: 'background 120ms ease',
            outline: 'none',
        },
        onmouseenter: (ev) => { ev.currentTarget.style.background = 'var(--ink-25)'; },
        onmouseleave: (ev) => { ev.currentTarget.style.background = 'transparent'; },
    },
        h('div', {
            style: {
                width: '26px', height: '26px', borderRadius: '7px',
                background: meta.bg, color: meta.fg,
                display: 'grid', placeItems: 'center', flex: '0 0 auto',
            },
        }, Icon(meta.icon, { size: 13 })),
        h('div', { style: { flex: 1, minWidth: 0 } },
            h('div', { style: { fontSize: '12.5px', fontWeight: 600, color: 'var(--ink-900)' } }, meta.title),
            meta.subtitle && h('div', {
                class: 'muted',
                style: { fontSize: '11.5px', marginTop: '1px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                title: meta.subtitle,
            }, meta.subtitle),
        ),
        h('div', { style: { flex: '0 0 auto', textAlign: 'right' } },
            h('div', { class: 'num', style: { fontSize: '11.5px', color: 'var(--ink-700)', fontWeight: 600, whiteSpace: 'nowrap' } }, shortTime(item.savedAt)),
            h('div', { class: 'muted num', style: { fontSize: '10.5px', whiteSpace: 'nowrap' } }, dateOnly(item.savedAt)),
        ),
        trashBtn,
        h('span', {
            style: { color: 'var(--ink-400)', flex: '0 0 auto', marginLeft: '2px', alignSelf: 'center' },
        }, Icon('ChevronRight', { size: 14 })),
    );
    return row;
}

function historyMeta(item) {
    if (item.kind === 'signed') {
        return {
            icon: 'Check', bg: 'var(--ok-50)', fg: 'var(--ok-700)',
            title: item.byName ? trf('Подписано · {name} и завершено', { name: item.byName }) : tr('Подписано и завершено'),
            subtitle: (item.fields?.primary_diagnosis || '').trim() || null,
        };
    }
    if (item.kind === 'referral') {
        // Prefer the picked service + doctor (new format). Fall back to the
        // free-text reason kept on legacy entries.
        let subtitle = null;
        if (item.service?.name) {
            subtitle = item.service.name +
                       (item.doctor?.name ? ' · ' + item.doctor.name : '');
        } else if (item.reason) {
            subtitle = item.reason;
        }
        return {
            icon: 'ArrowRight', bg: 'var(--info-50)', fg: 'var(--info-700)',
            title: 'Referral · ' + (item.departmentLabel || item.department || '—'),
            subtitle,
        };
    }
    // draft
    return {
        icon: 'Doc', bg: 'var(--primary-50)', fg: 'var(--primary-700)',
        title: 'Draft saved',
        subtitle: (item.fields?.chief_complaint || '').trim() || null,
    };
}

// ===========================================================================
// AURORA_CONSULT_EDITOR_V1 — finish-gate, diagnoses, own services, timer.
// ===========================================================================

// --- Finish-gate (A3.1) ---------------------------------------------------
// WS_FLEX_DOC_V1 — nothing is mandatory; the doctor adds only the sections they need.
const REQUIRED_SECS = [];

// The appointment document's sections (added/removed via the section bar).
const DOC_SECTIONS = [
    { sec: 'complaints',      label: 'Жалобы',           field: 'chief_complaint' },
    { sec: 'anamnesis',       label: 'Анамнез',          field: 'hpi' },
    { sec: 'diagnosis',       label: 'Диагноз',          field: 'primary_diagnosis' },
    { sec: 'therapy',         label: 'Терапия',          field: 'therapy_text' },
    { sec: 'recommendations', label: 'Рекомендации',     field: 'recommendations_text' },
];
const DOC_SECTIONS_DEFAULT = [];   // SECTIONS_ON_DEMAND_V1 — EVERY section (incl. Жалобы/Осмотр/Диагноз) starts collapsed as «+ Добавить: …» and opens on press; drafts with content re-open their sections on load
function ensureDocSections() { if (!wsState.docSections) wsState.docSections = new Set(DOC_SECTIONS_DEFAULT); }
function wsSectionOn(sec) { return wsState.docSections ? wsState.docSections.has(sec) : DOC_SECTIONS_DEFAULT.includes(sec); }
function wsAddSection(ctx, sec) { ensureDocSections(); wsState.docSections.add(sec); syncSections(ctx); }
function wsRemoveSection(ctx, sec) { ensureDocSections(); wsState.docSections.delete(sec); syncSections(ctx); }
function wsMoveSection(ctx, field, dir) {   // WS_REORDER_V1
    if (!wsState.sectionOrder) wsState.sectionOrder = DOC_SECTIONS.map(sd => sd.field);
    const arr = wsState.sectionOrder;
    const i = arr.indexOf(field); if (i < 0) return;
    const j = i + dir; if (j < 0 || j >= arr.length) return;
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    wsState.saved = false; try { resetSaveBtn(ctx); } catch (e) {}
    if (wsState.blank) { try { renderBlank(ctx); } catch (e) {} } else { try { setupA4Pagination(ctx.container); } catch (e) {} }
}
function syncSections(ctx) {
    const root = ctx.container; if (!root) return;
    ensureDocSections();
    for (const sdef of DOC_SECTIONS) {
        const el = root.querySelector('[data-sec="' + sdef.sec + '"]');
        if (el) el.classList.toggle('a4-sec-off', !wsState.docSections.has(sdef.sec));
    }
    const bar = root.querySelector('[data-sec-manager]');
    if (bar) paintSectionManager(ctx, bar);
    try { setupA4Pagination(root); } catch (e) {}
    if (wsState.blank) { try { renderBlank(ctx); } catch (e) {} }
}
function paintSectionManager(ctx, bar) {
    ensureDocSections(); clear(bar);
    bar.appendChild(h('span', { style: { fontSize: '11px', fontWeight: 700, color: 'var(--ink-500)', textTransform: 'uppercase', letterSpacing: '0.04em', marginRight: '2px' } }, 'Разделы'));
    for (const sdef of DOC_SECTIONS) {
        if (!wsState.docSections.has(sdef.sec)) continue;
        bar.appendChild(h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '4px', padding: '3px 5px 3px 10px', background: 'var(--info-50)', border: '1px solid #c7dcfd', borderRadius: '999px', fontSize: '12px', fontWeight: 560, color: 'var(--ink-800)' } },
            sdef.label,
            h('button', { type: 'button', title: 'Убрать раздел', style: { border: '0', background: 'transparent', cursor: 'pointer', color: 'var(--ink-500)', fontSize: '15px', lineHeight: '1', padding: '0 2px' }, onclick: () => wsRemoveSection(ctx, sdef.sec) }, '×')));
    }
    const inactive = DOC_SECTIONS.filter(sd => !wsState.docSections.has(sd.sec));
    if (inactive.length) {
        const sel = h('select', { style: { height: '28px', padding: '0 8px', border: '1px dashed var(--ink-300)', borderRadius: '999px', fontSize: '12px', color: 'var(--primary-700, #1a7f77)', background: 'var(--surface, #fff)', cursor: 'pointer' },
            onchange: (e) => { const v = e.target.value; if (v) wsAddSection(ctx, v); } },
            h('option', { value: '' }, '+ Добавить раздел'),
            ...inactive.map(sd => h('option', { value: sd.sec }, sd.label)));
        bar.appendChild(sel);
    }
}
function wsSectionManager(ctx) {
    const bar = h('div', { 'data-sec-manager': '', style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '7px', margin: '0 0 12px', padding: '10px 12px', background: 'var(--ink-25)', border: '1px solid var(--ink-100)', borderRadius: '10px' } });
    setTimeout(() => paintSectionManager(ctx, bar), 0);
    return bar;
}

// The validating «Сохранить» path. Validates required sections, marks
// wsState.saved=true, flips the button label.
async function handleSave(ctx, btnEl) {
    const root = ctx.container;
    root.querySelectorAll('.a4-sec.a4-err').forEach(s => s.classList.remove('a4-err'));
    const missing = [];
    let firstBad = null;
    for (const r of REQUIRED_SECS) {
        const secEl = root.querySelector(`.a4-sec[data-sec="${r.sec}"]`);
        const input = secEl?.querySelector('.a4-input');
        const txt = (input?.innerText || '').trim();
        if (!txt) { missing.push(r.label); try { if (!wsSectionOn(r.sec)) wsAddSection(ctx, r.sec); } catch (e) {} secEl?.classList.add('a4-err'); if (!firstBad) firstBad = secEl; }   // SECTIONS_ON_DEMAND_V1 — auto-open collapsed required sections on failed save
    }
    if (missing.length) {
        wsState.saved = false;
        toast(trf('Заполните обязательные поля: {fields}', { fields: missing.join(', ') }), 'fail');
        firstBad?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
    }
    if (!await handleSaveDraft(ctx, { silent: true })) return;  // handleSaveDraft toasts on failure
    wsState.saved = true;
    if (btnEl) { btnEl.textContent = ''; btnEl.appendChild(Icon('Check', { size: 14 })); btnEl.appendChild(document.createTextNode(' Сохранено ✓')); }
    toast('Документ сохранён', 'ok');
}

// AUTO_SAVE_ON_FINISH_V1 — «Завершить приём» сам сохраняет документ: врач не
// обязан нажимать «Сохранить» отдельно. handleSave валидирует обязательные
// поля (и сам показывает, чего не хватает); если сохранение не прошло —
// финализация не запускается.
async function tryFinish(ctx) {
    if (!wsState.saved) {
        const btn = ctx.container ? ctx.container.querySelector('[data-save-btn]') : null;
        try { await handleSave(ctx, btn); } catch (e) { /* handleSave/handleSaveDraft уже показали ошибку */ }
        if (!wsState.saved) return;   // не сохранилось (пустые обязательные поля / сбой) — остаёмся в приёме
    }
    await handleSignFinalize(ctx);
}

// --- Diagnoses (payload.diagnoses[] — additive notes JSON key) ------------
const DX_TYPE_TAG = { main: 'tag-teal', concomitant: 'tag-info', complication: 'tag-warn', background: 'tag-purple' };
const DX_TYPE_RU  = { main: 'Основной', concomitant: 'Сопутствующий', complication: 'Осложнение', background: 'Фоновый' };

// Bundled ICD-10 seed (real 2026 ICD-10-CM codes, RU/EN names). Used when the
// search box is empty or to filter offline; the picker also accepts manual
// free-text so it never blocks the doctor.
/* i18n-exempt-start: ICD_SEED — двуязычный (ru·en) запасной справочник МКБ-10, данные каталога как в БД */
const ICD_SEED = [
    { code: 'K64.9', name: 'Геморрой неуточнённый · Unspecified hemorrhoids' },
    { code: 'K64.1', name: 'Геморрой второй степени · Second degree hemorrhoids' },
    { code: 'K64.0', name: 'Геморрой первой степени · First degree hemorrhoids' },
    { code: 'K64.2', name: 'Геморрой третьей степени · Third degree hemorrhoids' },
    { code: 'K64.3', name: 'Геморрой четвёртой степени · Fourth degree hemorrhoids' },
    { code: 'K64.5', name: 'Перианальный венозный тромбоз · Perianal venous thrombosis' },
    { code: 'K62.5', name: 'Кровотечение из заднего прохода и прямой кишки · Hemorrhage of anus and rectum' },
    { code: 'K62.6', name: 'Язва заднего прохода и прямой кишки · Ulcer of anus and rectum' },
    { code: 'K62.3', name: 'Выпадение прямой кишки · Rectal prolapse' },
    { code: 'K62.1', name: 'Полип прямой кишки · Rectal polyp' },
    { code: 'K60.2', name: 'Анальная трещина неуточнённая · Anal fissure, unspecified' },
    { code: 'K60.3', name: 'Анальный свищ · Anal fistula' },
];
/* i18n-exempt-end */

function paintDiagnoses(ctx) {
    const list = ctx.container?.querySelector('[data-dx-list]');
    const items = wsState.payload?.diagnoses || [];
    const countEl = ctx.container?.querySelector('[data-dx-count]');
    if (countEl) countEl.textContent = items.length ? String(items.length) : '';
    if (list) {
        clear(list);
        if (items.length === 0) {
            list.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px', padding: '6px 0' } }, 'Диагноз не указан'));
        } else {
            items.forEach((d, i) => list.appendChild(h('div', { class: 'cn-dx-row' },
                h('span', { class: 'cn-dx-code' }, d.code || '—'),
                h('span', { class: 'cn-dx-name' }, d.name || '—'),
                Tag(DX_TYPE_RU[d.type] || d.type || '', { kind: (DX_TYPE_TAG[d.type] || 'tag-teal').replace('tag-', '') }),
                patientTabCanEdit('overview') && h('button', {   // AURORA_DX_DELETE_GATE_V1 — the doctor can remove a dx they added
                    class: 'btn btn-ghost btn-sm', type: 'button', title: 'Удалить', style: { color: 'var(--crit-700)' },
                    onclick: () => removeDiagnosis(ctx, i),
                }, '×'),
            )));
        }
    }
    syncDiagnosisToDoc(ctx);
}

// Mirror the main diagnosis into the legacy primary_diagnosis band + icd10.
function syncDiagnosisToDoc(ctx) {
    try { setTimeout(() => renderBlank(ctx), 0); } catch (e) {}   // WYSIWYG_BLANK_V1
    const main = (wsState.payload?.diagnoses || []).find(d => d.type === 'main');
    // DX_SAVE_FIX_V1 — the diagnosis section starts collapsed; collectFields skips collapsed
    // sections, so a picked diagnosis got dropped on save. Open the section when a dx is set.
    if (main) { ensureDocSections(); if (!wsState.docSections.has('diagnosis')) { wsState.docSections.add('diagnosis'); try { syncSections(ctx); } catch (e) {} } }
    const band = ctx.container?.querySelector('.a4-input[data-field="primary_diagnosis"]');
    if (band) band.innerHTML = main ? `${main.code} — ${main.name}` : '';
    const icd = ctx.container?.querySelector('[data-field="icd10"]');
    if (icd && 'value' in icd) icd.value = main ? (main.code || '') : '';
}

async function addDiagnosis(ctx, { code, name, type }) {
    const payload = wsState.payload || await readPayload(ctx);
    if (!Array.isArray(payload.diagnoses)) payload.diagnoses = [];
    if (type === 'main') payload.diagnoses.forEach(d => { if (d.type === 'main') d.type = 'concomitant'; });
    payload.diagnoses.push({ code, name, type });
    if (!await writePayload(ctx, payload)) return;
    paintDiagnoses(ctx);
    syncDiagnosisToConditions(ctx, { code, name });   // AURORA_DX_SYNC_V1 — land it on the patient card
}

// AURORA_DX_SYNC_V1 — mirror a workspace diagnosis into patient_conditions so it shows on the
// patient card (overview). Deduped by patient_id + code among active conditions; non-fatal.
async function syncDiagnosisToConditions(ctx, { code, name }) {
    if (!ctx.patient?.id || !code) return;
    try {
        const { data: ex } = await supabase.from('patient_conditions')
            .select('id').eq('patient_id', ctx.patient.id).eq('code', code).eq('status', 'active').limit(1);
        if (ex && ex.length) return;
        await supabase.from('patient_conditions').insert({
            patient_id: ctx.patient.id,
            company_id: currentClinicId() || null,
            code, label: name || code, status: 'active',
            since_date: new Date().toISOString().slice(0, 10),
        });
    } catch (e) { /* the diagnosis is still saved on the visit */ }
}

async function removeDiagnosis(ctx, idx) {
    const payload = wsState.payload || await readPayload(ctx);
    if (!Array.isArray(payload.diagnoses)) return;
    const removed = payload.diagnoses[idx];
    payload.diagnoses.splice(idx, 1);
    if (!await writePayload(ctx, payload)) return;
    paintDiagnoses(ctx);
    // AURORA_DX_SYNC_V1 — drop the matching active condition from the patient card.
    if (removed && removed.code && ctx.patient?.id) {
        try {
            await supabase.from('patient_conditions').delete()
                .eq('patient_id', ctx.patient.id).eq('code', removed.code).eq('status', 'active');
        } catch (e) {}
    }
}

// МКБ-10 picker modal.
function openDiagnosisModal(ctx) {
    const existing = wsState.payload?.diagnoses || [];
    let selectedType = existing.some(d => d.type === 'main') ? 'concomitant' : 'main';

    const backdrop = h('div', { class: 'modal-backdrop' });
    const modal = h('div', { class: 'modal' });
    const close = () => { backdrop.remove(); modal.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    backdrop.addEventListener('click', close);

    const resultsEl = h('div', { class: 'dx-list', 'data-dx-results': '' });
    const countEl   = h('span', { class: 'muted' }, 'Найдено: 0');
    const searchIn  = h('input', { class: 'dx-typebar', placeholder: 'Поиск по коду или названию…' });

    const segBtns = ['main', 'concomitant', 'complication', 'background'].map(t =>
        h('button', { type: 'button', 'data-seg': t, class: (t === selectedType ? 'on' : ''), onclick: (ev) => {
            selectedType = t;
            modal.querySelectorAll('[data-seg]').forEach(b => b.classList.toggle('on', b === ev.currentTarget));
        } }, DX_TYPE_RU[t]));

    function rowFor(it) {
        const already = (wsState.payload?.diagnoses || []).some(d => d.code === it.code);
        const row = h('div', { class: 'dx-item' + (already ? ' added' : '') },
            h('span', { class: 'dx-item-code' }, it.code),
            h('span', { class: 'dx-item-name' }, it.name),
            already
                // DX_MODAL_TOGGLE_V1 — an added diagnosis can be un-added right from the picker.
                ? h('button', { class: 'btn btn-ghost btn-sm', type: 'button', style: { color: 'var(--crit-700)' }, onclick: async () => {
                    const arr = wsState.payload?.diagnoses || [];
                    const idx = arr.findIndex(d => d.code === it.code);
                    if (idx >= 0) await removeDiagnosis(ctx, idx);
                    toast('Диагноз убран', 'ok');
                    row.classList.remove('added');
                    runSearch(searchIn.value);
                } }, Icon('Trash', { size: 12 }), ' Убрать')
                : h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: async () => {
                    await addDiagnosis(ctx, { code: it.code, name: it.name, type: selectedType });
                    toast('Диагноз добавлен', 'ok');
                    row.classList.add('added');
                    runSearch(searchIn.value);
                } }, Icon('Plus', { size: 12 }), ' Добавить'),
        );
        return row;
    }

    let _dxToken = 0;
    async function runSearch(q) {
        const query = (q || '').trim();
        const my = ++_dxToken;
        clear(resultsEl);
        if (!query) {
            // BROWSE_ICD_V1 — the FULL МКБ-10 catalogue (14 000+ codes) lives in the
            // icd10 table; browse its start instead of the 12-code starter seed so
            // it's obvious the whole base is searchable.
            countEl.textContent = tr('Загрузка…');
            try {
                const { data, error, count } = await supabase.from('icd10')
                    .select('code,name', { count: 'exact' }).order('code').limit(50);
                if (error) throw error;
                if (my !== _dxToken) return;
                clear(resultsEl);
                (data || []).forEach(it => resultsEl.appendChild(rowFor(it)));
                countEl.textContent = trf('В справочнике {n} кодов МКБ-10 — введите код или название', { n: count ? count.toLocaleString('ru-RU') : '14 000+' });
            } catch (e) {
                clear(resultsEl);
                ICD_SEED.forEach(it => resultsEl.appendChild(rowFor(it)));
                countEl.textContent = trf('Найдено: {n}', { n: ICD_SEED.length });
            }
            return;
        }
        countEl.textContent = tr('Поиск…');
        let list = [];
        try {
            const term = query.replace(/[,()%*]/g, ' ').trim();
            const { data, error } = await supabase.from('icd10')
                .select('code,name')
                .or('code.ilike.' + term + '%,name.ilike.%' + term + '%')
                .limit(50);
            if (error) throw error;
            list = data || [];
        } catch (e) {
            console.warn('[icd10] search failed, using seed:', e && e.message);
            const ql = query.toLowerCase();
            list = ICD_SEED.filter(it => it.code.toLowerCase().includes(ql) || it.name.toLowerCase().includes(ql));
        }
        if (my !== _dxToken) return;
        clear(resultsEl);
        if (list.length === 0) {
            const isCode = /^[a-z]\d/i.test(query);
            resultsEl.appendChild(h('div', { style: { padding: '14px' } },
                h('div', { class: 'muted', style: { fontSize: '12.5px', marginBottom: '8px' } }, 'Ничего не найдено.'),
                h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: async () => {
                    const code = isCode ? query.toUpperCase() : '—';
                    await addDiagnosis(ctx, { code, name: query, type: selectedType });
                    toast('Диагноз добавлен', 'ok');
                    searchIn.value = '';
                    runSearch('');
                } }, Icon('Plus', { size: 12 }), ' ', trf('Добавить вручную: «{q}»', { q: query })),
            ));
            countEl.textContent = tr('Найдено: 0');
            return;
        }
        list.forEach(it => resultsEl.appendChild(rowFor(it)));
        countEl.textContent = trf('Найдено: {n}', { n: String(list.length) + (list.length >= 50 ? '+' : '') });
    }
    let debounce = null;
    searchIn.addEventListener('input', () => { clearTimeout(debounce); debounce = setTimeout(() => runSearch(searchIn.value), 250); });

    const card = h('div', { class: 'modal-card', style: { width: '620px', maxWidth: 'calc(100vw - 32px)' } },
        h('header', { class: 'modal-head' },
            h('h2', { style: { margin: 0 } }, Icon('Stethoscope', { size: 16 }), ' Добавить диагноз (МКБ-10)'),
            h('button', { class: 'modal-close', type: 'button', onclick: close }, '×'),
        ),
        h('div', { class: 'modal-body' },
            h('div', { class: 'segmented', style: { marginBottom: '10px', display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)' } }, ...segBtns),
            searchIn,
            resultsEl,
        ),
        h('footer', { class: 'modal-foot' },
            countEl,
            h('span', { class: 'grow' }),
            h('button', { class: 'btn btn-primary', type: 'button', onclick: close }, 'Готово'),
        ),
    );
    modal.appendChild(card);
    document.body.appendChild(backdrop);
    document.body.appendChild(modal);
    document.addEventListener('keydown', onKey);
    runSearch('');
    setTimeout(() => searchIn.focus(), 30);
}

// ===========================================================================
// AURORA_CONSULT_TEMPLATES_V1 — «Шаблоны заключений» (consultation template
// library). Master-detail modal: pick a saved заключение and fill the A4 doc,
// or save the current document as a reusable template (private / shared).
// Mirrors openDiagnosisModal's two-element backdrop+modal pattern; appends to
// document.body; z-index from .modal (100); Escape + backdrop close.
// CRUD on public.consultation_templates (migration 068). RLS scopes SELECT to
// my clinic's shared rows + my own private rows; INSERT/UPDATE/DELETE only on
// my own rows (or any clinic row if admin). DB fills company_id/author_id —
// the client NEVER sends them.
// ===========================================================================

async function tplLoad() {
    const { data, error } = await supabase
        .from('consultation_templates')
        .select('*')
        .order('updated_at', { ascending: false });
    if (error) { toast('Не удалось загрузить шаблоны', 'fail'); return []; }
    return data || [];
}

// Client-side filter (RLS already scoped server-side):
//   all → everything returned · mine → author_id===myId() · shared → scope==='shared'
function tplVisible() {
    const q = (tplState.q || '').trim().toLowerCase();
    return tplState.rows.filter(t =>
        (t.name || '').toLowerCase().includes(q) &&
        (tplState.filter === 'all'
            || (tplState.filter === 'mine' && myId() && t.author_id === myId())
            || (tplState.filter === 'shared' && t.scope === 'shared'))
    );
}
const isMine = (t) => !!t && !!myId() && t.author_id === myId();

function tplDate(ts) { try { return new Date(ts).toLocaleDateString('ru-RU'); } catch (e) { return ''; } }

function scopePill(scope) {
    return scope === 'shared'
        ? h('span', { class: 'tplm-scope shared' }, Icon('Globe', { size: 11 }), ' Общий')
        : h('span', { class: 'tplm-scope private' }, Icon('User', { size: 11 }), ' Личный');
}

function tplBlankBody(dt) { const o = {}; for (const k of tplTypeOf(dt).keys) o[k] = ''; return o; }
function tplEmptyDraft() { const dt = (typeof wsState !== 'undefined' && wsState.docType === 'diag') ? 1 : 0; return { id: null, name: '', scope: 'private', doc_type: dt, body: tplBlankBody(dt) }; }
function tplDraftFrom(t) {
    const body = tplBlankBody(t.doc_type);
    for (const k of tplTypeOf(t.doc_type).keys) body[k] = (t.body && t.body[k]) || '';
    return { id: t.id, name: t.name || '', scope: t.scope || 'private', doc_type: t.doc_type || 0, body };
}
// Collect the current A4 document's safe sections only (omits primary_diagnosis/icd10/follow_up/referral).
function tplCollectDocBody(ctx, dt) {
    const all = collectFields(ctx);
    const out = {};
    for (const k of tplTypeOf(dt).keys) { const v = (all[k] || '').trim(); if (v) out[k] = v; }
    return out;
}

function openTemplateLibraryModal(ctx) {
    tplState = { rows: [], filter: 'all', q: '', selId: null, mode: 'view', draft: null };

    const backdrop = h('div', { class: 'modal-backdrop' });
    const modal    = h('div', { class: 'modal' });
    const close = () => { backdrop.remove(); modal.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    backdrop.addEventListener('click', close);

    const listEl   = h('div', { class: 'tplm-list' });
    const detailEl = h('div', { class: 'tplm-detail' });
    const footEl   = h('footer', { class: 'modal-foot' });

    const searchIn = h('input', { class: 'tplm-search-in', placeholder: 'Поиск по названию…',
        oninput: () => { tplState.q = searchIn.value; paintList(); } });

    const segBtns = [['all', 'Все'], ['mine', 'Мои'], ['shared', 'Общие']].map(([k, ru]) =>
        h('button', { type: 'button', 'data-seg': k, class: (k === tplState.filter ? 'on' : ''),
            onclick: () => {
                tplState.filter = k;
                modal.querySelectorAll('[data-seg]').forEach(b => b.classList.toggle('on', b.getAttribute('data-seg') === k));
                paintList();
            } }, ru));

    const newBtn = h('button', { class: 'btn btn-outline btn-sm', type: 'button',
        onclick: () => { tplState.mode = 'new'; tplState.draft = tplEmptyDraft(); paintDetail(); paintFoot(); } },
        Icon('Plus', { size: 14 }), ' Новый шаблон');

    const card = h('div', { class: 'modal-card tplm-card' },
        h('header', { class: 'modal-head' },
            h('h2', { style: { margin: 0 } }, Icon('Doc', { size: 16 }), ' Шаблоны заключений'),
            h('button', { class: 'modal-close', type: 'button', onclick: close }, '×'),
        ),
        h('div', { class: 'tplm-bar' },
            h('div', { class: 'tplm-search' }, Icon('Search', { size: 14 }), searchIn),
            h('div', { class: 'segmented tplm-seg' }, ...segBtns),
            h('span', { class: 'grow' }),
            newBtn,
        ),
        h('div', { class: 'tplm-split' }, listEl, detailEl),
        footEl,
    );
    modal.appendChild(card);
    document.body.appendChild(backdrop);
    document.body.appendChild(modal);
    document.addEventListener('keydown', onKey);

    // ---- paint: LEFT list ------------------------------------------------
    function paintList() {
        clear(listEl);
        const rows = tplVisible();
        if (!rows.length) {
            listEl.appendChild(h('div', { class: 'tplm-empty' }, tplState.rows.length ? 'Ничего не найдено' : 'Пока нет шаблонов'));
            return;
        }
        for (const t of rows) {
            const mine = isMine(t);
            const rowact = mine ? h('div', { class: 'tplm-rowact' },
                h('button', { class: 'icon-btn sm', type: 'button', title: 'Изменить',
                    onclick: (e) => { e.stopPropagation(); tplState.selId = t.id; tplState.mode = 'edit'; tplState.draft = tplDraftFrom(t); paintList(); paintDetail(); paintFoot(); } },
                    Icon('Edit', { size: 14 })),
                h('button', { class: 'icon-btn sm danger', type: 'button', title: 'Удалить',
                    onclick: (e) => { e.stopPropagation(); tplConfirmDelete(t); } },
                    Icon('Trash', { size: 14 })),
            ) : null;
            const item = h('div', { class: 'tplm-item' + (t.id === tplState.selId ? ' on' : ''),
                onclick: () => { tplState.selId = t.id; tplState.mode = 'view'; tplState.draft = null; paintList(); paintDetail(); paintFoot(); } },
                h('div', { class: 'tplm-item-main' },
                    h('div', { class: 'tplm-name' }, t.name || '—'),
                    h('div', { class: 'tplm-by' }, (t.author_name || '—') + ' · ' + tplDate(t.updated_at)),
                    h('div', { class: 'tplm-meta' }, scopePill(t.scope), h('span', { class: 'muted', style: { fontSize: '11px', marginLeft: '6px' } }, tplTypeOf(t.doc_type).dt === 1 ? '· Диагностика' : '· Приём')),
                ),
                rowact,
            );
            listEl.appendChild(item);
        }
    }

    // ---- paint: RIGHT detail (view | new | edit) -------------------------
    function paintDetail() {
        clear(detailEl);
        if (tplState.mode === 'new' || tplState.mode === 'edit') { paintForm(); return; }
        const sel = tplState.rows.find(r => r.id === tplState.selId);
        if (!sel) { detailEl.appendChild(h('div', { class: 'tplm-empty' }, 'Выберите шаблон слева')); return; }
        const mine = isMine(sel);

        const acts = h('div', { style: { display: 'flex', gap: '8px', flexShrink: 0 } },
            h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => tplUse(sel) },
                Icon('Plus', { size: 14 }), ' Использовать'),
            mine ? h('button', { class: 'btn btn-outline btn-sm', type: 'button',
                onclick: () => { tplState.mode = 'edit'; tplState.draft = tplDraftFrom(sel); paintDetail(); paintFoot(); } },
                Icon('Edit', { size: 14 }), ' Изменить') : null,
            mine ? h('button', { class: 'btn btn-outline btn-sm', type: 'button',
                style: { color: 'var(--crit-700)' }, onclick: () => tplConfirmDelete(sel) },
                Icon('Trash', { size: 14 }), ' Удалить') : null,
        );

        detailEl.appendChild(h('div', { class: 'tplm-detail-head' },
            h('div', { style: { minWidth: 0 } },
                h('div', { class: 'tplm-view-name' }, sel.name || '—'),
                h('div', { class: 'tplm-meta' }, scopePill(sel.scope),
                    h('span', { class: 'muted', style: { fontSize: '12px' } }, (sel.author_name || '—') + ' · ' + tplDate(sel.updated_at))),
            ),
            acts,
        ));

        const secWrap = h('div', { class: 'tplm-secs' });
        let any = false;
        for (const k of tplTypeOf(sel.doc_type).keys) {
            const v = (sel.body && sel.body[k]) || '';
            if (!String(v).trim()) continue;
            any = true;
            const body = h('div', { class: 'tplm-sec-b' });
            body.innerHTML = esc(v);   // INERT — stored HTML shown as escaped text
            secWrap.appendChild(h('div', { class: 'tplm-sec' },
                h('div', { class: 'tplm-sec-l' }, tplTypeOf(sel.doc_type).labels[k] || k),
                body,
            ));
        }
        detailEl.appendChild(any ? secWrap : h('div', { class: 'tplm-empty' }, 'Шаблон пуст'));
    }

    // ---- paint: form (new | edit) ----------------------------------------
    function paintForm() {
        const d = tplState.draft;
        const nameIn = h('input', { class: 'tplm-input', value: d.name,
            placeholder: 'Например: Контрольный осмотр после операции',
            oninput: () => { d.name = nameIn.value; } });

        const scopeBtn = (val, ru, ic) => h('button', { type: 'button',
            class: 'tplm-scopebtn' + (d.scope === val ? ' on' : ''),
            onclick: () => { d.scope = val; modal.querySelectorAll('.tplm-scopebtn').forEach(b => b.classList.toggle('on', b.getAttribute('data-sv') === val)); },
            'data-sv': val }, Icon(ic, { size: 14 }), ' ' + ru);

        const secFields = h('div', { class: 'tplm-form-secs' });
        function paintSecFields() {
            clear(secFields);
            const _T = tplTypeOf(d.doc_type);
            for (const k of _T.keys) {
                const ta = h('textarea', { class: 'tplm-textarea', placeholder: 'Текст секции…',
                    oninput: (e) => { d.body[k] = e.currentTarget.value; } });
                ta.value = d.body[k] || '';
                secFields.appendChild(h('div', { class: 'tplm-field' },
                    h('label', null, _T.labels[k] || k), ta));
            }
        }
        paintSecFields();

        const fromDoc = h('button', { class: 'btn btn-outline btn-sm', type: 'button',
            onclick: () => { d.body = { ...tplBlankBody(d.doc_type), ...tplCollectDocBody(ctx, d.doc_type) }; paintSecFields(); toast('Заполнено из текущего документа', 'ok'); } },
            Icon('Doc', { size: 14 }), ' Из текущего документа');

        detailEl.appendChild(h('div', { class: 'tplm-form' },
            h('b', { style: { fontSize: '14px', color: 'var(--ink-900)' } }, d.id ? 'Изменение шаблона' : 'Новый шаблон'),
            h('div', { class: 'tplm-field' },
                h('label', null, 'Название'), nameIn),
            h('div', { class: 'tplm-field' },
                h('label', null, 'Видимость'),
                h('div', { class: 'tplm-scopepick' },
                    scopeBtn('shared', 'Общий для всех врачей', 'Globe'),
                    scopeBtn('private', 'Только я', 'User'),
                )),
            h('div', { class: 'tplm-field' },
                h('label', null, 'Тип документа'),
                h('div', { class: 'tplm-scopepick' }, TPL_TYPES.map(_T => h('button', { type: 'button',
                    class: 'tplm-scopebtn' + (d.doc_type === _T.dt ? ' on' : ''), 'data-dt': String(_T.dt),
                    onclick: () => {
                        if (d.doc_type === _T.dt) return;
                        const nb = tplBlankBody(_T.dt);
                        for (const k of Object.keys(nb)) if (d.body[k] != null) nb[k] = d.body[k];
                        d.doc_type = _T.dt; d.body = nb;
                        modal.querySelectorAll('.tplm-scopepick [data-dt]').forEach(b => b.classList.toggle('on', b.getAttribute('data-dt') === String(_T.dt)));
                        paintSecFields();
                    } }, Icon('Doc', { size: 13 }), ' ' + _T.label)))),
            h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
                fromDoc,
                h('span', { class: 'muted', style: { fontSize: '12px' } }, 'или заполните секции вручную')),
            secFields,
        ));
    }

    // ---- footer ----------------------------------------------------------
    function paintFoot() {
        clear(footEl);
        if (tplState.mode === 'new' || tplState.mode === 'edit') {
            footEl.appendChild(h('span', { class: 'grow' }));
            footEl.appendChild(h('button', { class: 'btn btn-ghost', type: 'button',
                onclick: () => { tplState.mode = 'view'; tplState.draft = null; paintDetail(); paintFoot(); } }, 'Отмена'));
            footEl.appendChild(h('button', { class: 'btn btn-primary', type: 'button', onclick: tplSave },
                Icon('Check', { size: 14 }), ' Сохранить шаблон'));
            return;
        }
        footEl.appendChild(h('span', { class: 'muted', style: { display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px' } },
            trf('{n} шаблон(ов)', { n: tplState.rows.length }), ' · ', Icon('Globe', { size: 12 }), ' общие видны всем врачам клиники'));
        footEl.appendChild(h('span', { class: 'grow' }));
        footEl.appendChild(h('button', { class: 'btn btn-ghost', type: 'button', onclick: close }, 'Закрыть'));
    }

    // ---- «Использовать» — fill A4 + re-gate finish -----------------------
    function tplUse(t) {
        // Sanitize cross-authored (esp. shared) template HTML before it enters the live editor.
        const _src = t.body || {}, _clean = {};
        for (const _k of Object.keys(_src)) _clean[_k] = sanitizeRichHtml(_src[_k]);
        applyFields(ctx, _clean);
        wsState.saved = false;
        resetSaveBtn(ctx);
        toast('Шаблон вставлен', 'ok');
        close();
    }

    // ---- save (INSERT new / UPDATE existing) -----------------------------
    async function tplSave() {
        const d = tplState.draft;
        if (!d || !d.name.trim()) { toast('Укажите название шаблона', 'warn'); return; }
        const body = {};
        for (const k of tplTypeOf(d.doc_type).keys) { const v = (d.body[k] || '').trim(); if (v) body[k] = v; }
        if (d.id) {
            // UPDATE — only these 4 columns, by id. NEVER company_id/author_id.
            const { error } = await supabase.from('consultation_templates')
                .update({ name: d.name.trim(), scope: d.scope, body, doc_type: d.doc_type })
                .eq('id', d.id);
            if (error) { toast('Не удалось сохранить', 'fail'); return; }
            toast('Шаблон обновлён', 'ok');
        } else {
            // INSERT — ONLY name/scope/doc_type/body/author_name. DB fills company_id + author_id.
            const { data, error } = await supabase.from('consultation_templates')
                .insert({ name: d.name.trim(), scope: d.scope, doc_type: d.doc_type, body, author_name: myName() })
                .select('id').maybeSingle();
            if (error) { toast('Не удалось сохранить', 'fail'); return; }
            toast('Шаблон сохранён', 'ok');
            if (data && data.id) tplState.selId = data.id;
        }
        tplState.rows = await tplLoad();
        tplState.mode = 'view'; tplState.draft = null;
        paintList(); paintDetail(); paintFoot();
    }

    // ---- delete (confirm overlay inside the card) ------------------------
    function tplConfirmDelete(t) {
        const bg = h('div', { class: 'tplm-confirm-bg' },
            h('div', { class: 'tplm-confirm' },
                h('div', { class: 'tplm-confirm-t' }, 'Удалить шаблон?'),
                h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '2px' } }, 'Действие нельзя отменить.'),
                h('div', { class: 'tplm-confirm-acts' },
                    h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => bg.remove() }, 'Отмена'),
                    h('button', { class: 'btn btn-danger btn-sm', type: 'button', onclick: async () => {
                        const { error } = await supabase.from('consultation_templates').delete().eq('id', t.id);
                        if (error) { toast('Не удалось удалить', 'fail'); return; }
                        bg.remove();
                        if (tplState.selId === t.id) tplState.selId = null;
                        toast('Шаблон удалён', 'ok');
                        tplState.rows = await tplLoad();
                        if (tplState.rows.length && !tplState.selId) tplState.selId = tplState.rows[0].id;
                        tplState.mode = 'view'; tplState.draft = null;
                        paintList(); paintDetail(); paintFoot();
                    } }, 'Удалить'),
                ),
            ),
        );
        card.appendChild(bg);
    }

    // ---- initial load ----------------------------------------------------
    (async () => {
        listEl.appendChild(h('div', { class: 'tplm-empty' }, 'Загрузка…'));
        tplState.rows = await tplLoad();
        if (tplState.rows.length && !tplState.selId) tplState.selId = tplState.rows[0].id;
        paintList(); paintDetail(); paintFoot();
        setTimeout(() => searchIn.focus(), 30);
    })();
}
// END AURORA_CONSULT_TEMPLATES_V1

// --- Own services (payload.services[] — display-only additive key) --------
function paintOwnServices(ctx) {
    const list = ctx.container?.querySelector('[data-own-services-list]');
    const items = wsState.payload?.services || [];
    const countEl = ctx.container?.querySelector('[data-own-svc-count]');
    if (countEl) countEl.textContent = items.length ? String(items.length) : '';
    if (!list) return;
    clear(list);
    if (items.length === 0) {
        list.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px', padding: '6px 0' } }, 'Доп. услуги не добавлены'));
        return;
    }
    items.forEach((svc, i) => list.appendChild(h('div', { class: 'cn-dx-row' },
        h('span', { class: 'cn-dx-name' }, svc.name || '—'),
        h('span', { class: 'num', style: { fontSize: '12px', color: 'var(--ink-700)', whiteSpace: 'nowrap' } },
            (svc.price != null ? Number(svc.price).toLocaleString('ru-RU') : '—'), ' сум'),
        patientTabCanEdit('services') && h('button', {   // AURORA_DX_DELETE_GATE_V1 — the doctor can remove a service they added
            class: 'btn btn-ghost btn-sm', type: 'button', title: 'Удалить', style: { color: 'var(--crit-700)' },
            onclick: () => removeOwnService(ctx, i),
        }, '×'),
    )));
}

async function addOwnService(ctx, svc) {
    if (!svc) return;
    // AURORA_SVC_SYNC_V1 — create a REAL visit_services line so the service shows on the patient
    // card (Услуги/Визиты) and the invoice. Consultation pseudo-services carry a
    // consultation_type_id; catalog services carry a real service_id. insertRow stamps created_by.
    let vsId = null;
    if (ctx.visitId) {
        try {
            const price = svc.price != null ? Number(svc.price) : 0;
            const row = {
                visit_id:   ctx.visitId,
                company_id: currentClinicId() || null,
                doctor_id:  svc.__consultDoctorId || ctx.patient?.__service?.doctorId || null,
                quantity:   1, unit_price: price, total: price, status: 'added',
            };
            if (svc.__consult) row.consultation_type_id = svc.consultation_type_id || null;
            else row.service_id = svc.id || null;
            const { data, error } = await insertRow('visit_services', row);
            if (error) throw error;
            vsId = data?.id || null;
        } catch (e) { console.warn('[workspace] visit_services sync failed:', e?.message || e); }
    }
    // Keep the workspace's own JSON list (drives the left-column display + print).
    const payload = wsState.payload || await readPayload(ctx);
    if (!Array.isArray(payload.services)) payload.services = [];
    payload.services.push({ name: svc.name, price: svc.price, vsId });
    if (!await writePayload(ctx, payload)) return;
    paintOwnServices(ctx);
    toast('Услуга добавлена в приём', 'ok');
}

async function removeOwnService(ctx, idx) {
    const payload = wsState.payload || await readPayload(ctx);
    if (!Array.isArray(payload.services)) return;
    const removed = payload.services[idx];
    payload.services.splice(idx, 1);
    if (!await writePayload(ctx, payload)) return;
    paintOwnServices(ctx);
    // AURORA_SVC_SYNC_V1 — drop the real visit_services line too (un-bill it).
    if (removed && removed.vsId) {
        try { await supabase.from('visit_services').delete().eq('id', removed.vsId); } catch (e) {}
    }
}

// --- AURORA_CONSULT_NO_TIMER_V1 — «Пауза» = step away ----------------------
// Save the current form as a draft (so the doctor can resume), then return to
// «Мои услуги». The visit_service status is left unchanged (in-progress), so it
// stays in the queue and reopening it re-hydrates the saved draft.
async function pauseAndLeave(ctx) {
    if (ctx.visitServiceId) { try { await handleSaveDraft(ctx, { silent: true }); } catch (e) {} }
    toast('Приём приостановлен — продолжите его из «Мои услуги».', 'info');
    if (ctx.onNavigate) ctx.onNavigate('consultation');
}

// ---------------------------------------------------------------------------
// Save draft  — at most one draft entry survives in the history. Saving a
// new draft (or signing) wipes any prior drafts so the list stays clean.
// ---------------------------------------------------------------------------
async function handleSaveDraft(ctx, opts = {}) {
    if (!ctx.visitServiceId) { toast('Услуга не привязана — откройте из «Мои услуги».', 'fail'); return false; }
    const fields = collectFields(ctx);
    const entry  = { kind: 'draft', savedAt: new Date().toISOString(), fields };
    const payload = wsState.payload || await readPayload(ctx);
    payload.current = fields;
    payload.diagImages = (wsState.diagImages || []).slice();   // DIAG_IMAGES_V1 — survive draft reopen
    payload.history = payload.history.filter(e => e.kind !== 'draft');
    payload.history.push(entry);
    if (!await writePayload(ctx, payload)) return false;
    paintHistoryList(ctx);
    if (wsState.rtab === 'drafts') paintRtab(ctx);
    updateSavedMarker(ctx, trf('Сохранено · {time}', { time: shortTime(entry.savedAt) }));
    if (!opts.silent) toast('Черновик сохранён', 'ok');
    return true;
}

// ---------------------------------------------------------------------------
// Sign & finalize — promotes the current draft to a signed entry. Any
// outstanding draft is auto-pruned (signed snapshot supersedes it).
// ---------------------------------------------------------------------------
async function handleSignFinalize(ctx) {
    if (!ctx.visitServiceId) { toast('Услуга не привязана — откройте из «Мои услуги».', 'fail'); return; }
    const fields = collectFields(ctx);
    // CLINICAL_SIGN_GATE_V1 — warn before signing an empty document.
    const _hasText = [fields.chief_complaint, fields.hpi, fields.physical_exam, fields.instrumental_text, fields.primary_diagnosis, fields.therapy_text, fields.recommendations_text]
        .some(x => String(x || '').replace(/<[^>]*>/g, '').trim());
    const _actor = (typeof window !== 'undefined' && window.easymed && window.easymed.state && window.easymed.state.user) || {};
    // DOC_AMEND_AUDIT_V1 — re-signing an already-signed document creates a NEW version (the
    // prior signed entry stays in history). Only the original author or a clinic admin/owner
    // may amend; every version is stamped with its signer + timestamp.
    const _prevSigned = (((wsState.payload && wsState.payload.history) || []).filter(e => e.kind === 'signed'));
    const _last = _prevSigned.length ? _prevSigned[_prevSigned.length - 1] : null;
    const _isOwner = _actor.is_super_admin === true || (_actor.is_admin === true && !!_actor.company_id);
    if (_last && _last.by && _last.by !== _actor.id && !_isOwner) {
        toast(trf('Документ подписан другим сотрудником ({name}). Изменить может только автор или администратор.', { name: _last.byName || '—' }), 'fail');
        return;
    }
    const _signMsg = _prevSigned.length
        ? (_last && _last.byName ? trf('Документ уже подписан ({name}).\n\nСоздать НОВУЮ версию (изменение)? Предыдущая версия останется в истории.', { name: _last.byName }) : tr('Документ уже подписан.\n\nСоздать НОВУЮ версию (изменение)? Предыдущая версия останется в истории.'))
        : (_hasText
            ? 'Подписать и завершить приём?\n\nУслуга будет отмечена выполненной, а пациент покинет вашу очередь.'
            : 'Документ выглядит ПУСТЫМ.\n\nВсё равно подписать и завершить приём?');
    if (!confirm(_signMsg)) return;
    const entry  = { kind: 'signed', savedAt: new Date().toISOString(), fields, by: _actor.id || null, byName: _actor.full_name || '' };
    const payload = wsState.payload || await readPayload(ctx);
    payload.current = fields;
    payload.diagImages = (wsState.diagImages || []).slice();   // DIAG_IMAGES_V1
    payload.history = payload.history.filter(e => e.kind !== 'draft');
    payload.history.push(entry);
    if (!await writePayload(ctx, payload, { status: 'completed' })) return;

    // CLINICAL_DOCTYPE_V1 — archive the signed document as a self-contained, render-ready
    // SNAPSHOT (buildBlankData → the shape the print/preview templates consume) so it can be
    // reopened from the patient card. Diagnostics archive as doc_type='diag' (imaging
    // conclusion: описание/заключение), consultations as 'protocol'. Dedup deletes BOTH so a
    // prior mis-archive on a diagnostic service is cleaned up on re-sign.
    try {
        const _isDiag       = (ctx.deptKind === 'diagnostics') || (wsState.docType === 'diag');
        const _archiveType  = _isDiag ? 'diag' : 'protocol';
        const _snap = buildBlankData(ctx); _snap.__editor = false;
        const _docData = _isDiag ? {
            __editor: false,
            patientName: _snap.patientName, mrn: _snap.mrn, dob: _snap.dob, sex: _snap.sex,
            doctorName: _snap.doctorName, doctorSpec: _snap.doctorSpec, service: _snap.service,
            radiologist: _snap.doctorName, radiologistSpec: _snap.doctorSpec, issueDate: _snap.issueDate,
            description: _snap.instrumental || '', conclusion: _snap.dx || '',
            images: (wsState.diagImages || []).slice(),   // DIAG_IMAGES_V1 — persist snapshots with the signed doc
        } : _snap;
        // DOC_AMEND_AUDIT_V1 — attestation stamp on the archived snapshot (signer / when / version).
        _docData.meta = { signedBy: _actor.full_name || '', signedAt: entry.savedAt, version: _prevSigned.length + 1 };
        const _archiveTitle = (_isDiag ? 'Заключение' : 'Протокол осмотра')
            + (ctx.serviceName && ctx.serviceName !== '—' ? ' · ' + ctx.serviceName : '');
        await supabase.from('visit_documents').delete()
            .eq('visit_service_id', ctx.visitServiceId).in('doc_type', ['protocol', 'diag']);
        await supabase.from('visit_documents').insert({
            visit_service_id: ctx.visitServiceId || null,
            visit_id:         ctx.visitId || null,
            patient_id:       (ctx.patient && ctx.patient.id) || null,
            doc_type:         _archiveType,
            title:            _archiveTitle,
            body:             _docData,
        });
    } catch (e) { console.warn('[visit_documents] persist:', e.message); }

    // Mirror onto the parent visit so the scheduling calendar recolors and
    // the patient leaves the queue. The visit only becomes "completed" once
    // every service on it is done — otherwise it stays in_progress so a
    // pending lab/diagnostic doesn't get prematurely closed out.
    const visitCompleted = await syncVisitStatus(ctx.visitId);

    paintHistoryList(ctx);
    updateSavedMarker(ctx, trf('Подписано · {time}', { time: shortTime(entry.savedAt) }));
    toast(visitCompleted ? 'Документ подписан. Приём пациента завершён.' : 'Документ подписан. Услуга отмечена выполненной.');

    // Bounce back to the My services list so the queue refreshes.
    if (ctx.onNavigate) setTimeout(() => ctx.onNavigate('consultation'), 600);
}

// Recompute the parent visit's status from its services. The visit is marked
// 'completed' once every non-cancelled service on it is completed; while any
// service is still queued/in_progress the visit stays 'in_progress'. Returns
// true if the visit ended up completed. Best-effort — failures are logged.
async function syncVisitStatus(visitId) {
    if (!visitId) return false;
    const { data, error } = await supabase
        .from('visit_services')
        .select('status')
        .eq('visit_id', visitId);
    if (error) { console.warn('[workspace] visit status sync read failed:', error.message); return false; }
    const services = data || [];
    const active = services.filter(s => s.status !== 'cancelled');
    const allDone = active.length > 0 && active.every(s => s.status === 'completed');
    const newStatus = allDone ? 'completed' : 'in_progress';
    const { error: vErr } = await supabase.from('visits')
        .update({ status: newStatus }).eq('id', visitId);
    if (vErr) { console.warn('[workspace] visit status update failed:', vErr.message); return false; }
    return allDone;
}

// ---------------------------------------------------------------------------
// Delete a Conclusions entry by its index in the chronological history array.
// Drafts and referrals can be deleted; signed conclusions remain as audit.
// ---------------------------------------------------------------------------
async function handleDeleteEntry(ctx, originalIdx) {
    const payload = wsState.payload || await readPayload(ctx);
    const entry = payload.history[originalIdx];
    if (!entry || (entry.kind !== 'draft' && entry.kind !== 'referral')) {
        toast('Эту запись нельзя удалить.', 'fail');
        return;
    }
    const label = entry.kind === 'referral' ? 'referral' : 'draft';
    if (!confirm(tr('Удалить эту запись?'))) return;
    payload.history.splice(originalIdx, 1);
    if (!await writePayload(ctx, payload)) return;
    paintHistoryList(ctx);
    toast(label.charAt(0).toUpperCase() + label.slice(1) + ' deleted.');
}

// ---------------------------------------------------------------------------
// Snapshot viewer — opened by clicking a row in the Conclusions card.
// Read-only view of what was saved at that moment, with an optional
// "Load into form" action that copies a SOAP snapshot back into the
// live editor (the user still has to press Save draft to persist it).
// ---------------------------------------------------------------------------
function openSnapshotModal(ctx, item) {
    const overlay = h('div', { class: 'modal', style: { zIndex: '140' } });
    const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));

    const meta = historyMeta(item);
    const when = dateTimeShort(item.savedAt);

    const body = h('div', { class: 'modal-body' });
    if (item.kind === 'referral') {
        const svcLine = item.service
            ? item.service.name + (item.service.price ? ` · ${Number(item.service.price).toLocaleString('ru-RU')} UZS` : '')
            : null;
        body.append(...[
            snapshotKv('Отделение', item.departmentLabel || item.department || '—'),
            svcLine          && snapshotKv('Услуга', svcLine, true),
            item.doctor?.name && snapshotKv('Врач', item.doctor.name),
            item.reason       && snapshotKv('Причина',  item.reason, true),
        ].filter(Boolean));
    } else {
        const f = item.fields || {};
        body.append(
            snapshotKv('Жалобы',            f.chief_complaint  || '—', true),
            snapshotKv('Анамнез',           f.hpi              || '—', true),
            snapshotKv('Осмотр',            f.physical_exam    || '—', true),
            h('div', { class: 'row', style: { gap: '12px', marginTop: '6px' } },
                h('div', { style: { flex: '2' } }, snapshotKv('Основной диагноз', f.primary_diagnosis || '—')),
                h('div', { style: { flex: '1' } }, snapshotKv('МКБ-10',           f.icd10             || '—')),
            ),
            h('div', { class: 'row', style: { gap: '12px' } },
                h('div', { style: { flex: '1' } }, snapshotKv('Контроль',    f.follow_up || '—')),
                h('div', { style: { flex: '1' } }, snapshotKv('Направление', f.referral  || '—')),
            ),
        );
    }

    const footer = h('footer', { class: 'modal-foot' },
        h('button', { class: 'btn', onclick: close }, 'Закрыть'),
    );

    // Allow restoring a SOAP snapshot back into the live editor.
    if (item.kind !== 'referral' && item.fields) {
        footer.insertBefore(h('span', { class: 'grow' }), footer.firstChild.nextSibling);
        footer.appendChild(h('button', {
            class: 'btn btn-primary',
            title: 'Скопировать эти значения в форму. Они не сохранятся, пока вы не нажмёте «Сохранить черновик».',
            onclick: () => {
                applyFields(ctx, item.fields);
                close();
                toast('Данные загружены в форму. Нажмите «Сохранить черновик», чтобы сохранить.');
            },
        }, Icon('ArrowDown', { size: 13 }), ' Загрузить в форму'));
    }

    const card = h('div', { class: 'modal-card', style: { width: '540px', maxWidth: 'calc(100vw - 32px)' } },
        h('header', { class: 'modal-head' },
            h('div', { class: 'row', style: { gap: '10px', alignItems: 'center' } },
                h('div', {
                    style: {
                        width: '28px', height: '28px', borderRadius: '8px',
                        background: meta.bg, color: meta.fg,
                        display: 'grid', placeItems: 'center', flex: '0 0 auto',
                    },
                }, Icon(meta.icon, { size: 14 })),
                h('div', null,
                    h('h2', { style: { margin: 0 } }, meta.title),
                    h('div', { class: 'muted num', style: { fontSize: '11.5px', marginTop: '2px' } }, when),
                ),
            ),
            h('button', { class: 'modal-close', onclick: close }, '×'),
        ),
        body,
        footer,
    );

    overlay.appendChild(card);
    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKey);
}

function snapshotKv(label, value, block) {
    return h('div', { style: { marginBottom: '12px' } },
        h('div', {
            class: 'muted',
            style: { fontSize: '10.5px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '4px' },
        }, label),
        h('div', {
            style: {
                fontSize: '13px', color: 'var(--ink-900)',
                padding: block ? '8px 10px' : '0',
                background: block ? 'var(--ink-25)' : 'transparent',
                border: block ? '1px solid var(--ink-100)' : 0,
                borderRadius: block ? '7px' : 0,
                whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            },
        }, value),
    );
}

// ---------------------------------------------------------------------------
// Referrals — open the shared service picker in locked-type / no-category
// mode, then append the picked service as a history entry.
// ---------------------------------------------------------------------------
function openReferralPicker(ctx, target) {
    if (!ctx.visitServiceId) {
        toast('Услуга не привязана — откройте из «Мои услуги».', 'fail');
        return;
    }
    openServicePickerModal({
        title:           trf('Направить: {label}', { label: tr(target.label) }),
        titleIcon:       target.icon,
        confirmLabel:    'Отправить направление',
        confirmIcon:     'ArrowRight',
        lockedTypeNames: target.typeNames,
        onPick: ({ service, doctor }) => sendReferral(ctx, target, service, doctor),
    });
}

// DISPENSE_ITEM_V1 ----------------------------------------------------------
// Dispense a clinic product during the consultation. Calls the SECURITY
// DEFINER RPC dispense_visit_item (atomic visit_services item line +
// negative 'issue' stock movement). The RPC validates the caller's
// clinic+branch and RAISEs human-readable messages, surfaced as toasts. The
// dispensed line is billed later from the visit modal's Services tab.
function openDispenseConsultItem(ctx) {
    if (!ctx.visitId) {
        toast('Визит не привязан — откройте из «Мои услуги», чтобы выдать препараты.', 'fail');
        return;
    }
    openItemPickerModal({
        title:        'Выдать препарат',
        confirmLabel: 'Выдать',
        // DISPENSE_MULTI_V1 — the picker returns an array of lines; dispense each
        // with its own atomic RPC, then refresh once. Throws only if the whole
        // batch failed (keeps the dialog open); partial success toasts a summary.
        onConfirm: async (lines) => {
            let ok = 0; const fails = [];
            for (const { item, qty } of lines) {
                try {
                    const { data, error } = await supabase.rpc('dispense_visit_item', {
                        p_visit_id:  ctx.visitId,
                        p_item_id:   item.id,
                        p_qty:       Number(qty),
                        p_doctor_id: ctx.patient?.__service?.doctorId || null,
                    });
                    if (error) throw error;
                    const res = Array.isArray(data) ? data[0] : data;
                    const name = res?.item_name || item.name;
                    ok++;
                    if (res && Number(res.on_hand) <= 0) {
                        toast(trf('Внимание: остаток {name} теперь {n} (мало/в минусе).', { name, n: Number(res.on_hand).toLocaleString('ru-RU') }), 'fail');
                    }
                    // Log the dispense to the patient timeline (best-effort).
                    try {
                        await logPatientActivity({
                            patientId:   ctx.patient?.id,
                            visitId:     ctx.visitId,
                            entityType:  'item',
                            entityId:    res?.visit_service_id || item.id,
                            entityLabel: name,
                            action:      'dispensed',
                            summary:     `Dispensed ${name} × ${Number(qty)}`,
                            detail:      { item_id: item.id, qty: Number(qty), on_hand: res?.on_hand ?? null },
                        });
                    } catch (e) { /* logging never blocks dispensing */ }
                } catch (err) { fails.push(`${item.name}: ${err?.message || err}`); }
            }
            // RX_SEPARATE_V1 — refresh the «Назначения» list with the new lines.
            try { await loadDispensedItems(ctx); paintDispensed(ctx); } catch (e) { /* non-blocking */ }
            if (ok === 0) throw new Error(fails[0] || 'Не удалось выдать товары');
            toast(trf('Выдано позиций: {n}', { n: ok }) + (fails.length ? ' · ' + trf('ошибок: {n}', { n: fails.length }) : ''));
            if (fails.length) toast(fails.join('; '), 'fail');
        },
    });
}

// RECS_FLAT_PICKER_V1 — плоский пикер рекомендаций: одна строка поиска, чипы
// групп и список услуг с мгновенной кнопкой «Рекомендовать» (как в мастере
// записи). Врач-исполнитель не выбирается: реферер — текущий врач (ctx).
async function openRecommendPickerModal(ctx) {
    const overlay = h('div', { class: 'modal' });
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: () => overlay.remove() }));
    const card = h('div', { class: 'modal-card', style: { width: '780px', maxWidth: 'calc(100vw - 32px)', maxHeight: 'calc(100vh - 60px)', display: 'flex', flexDirection: 'column' } });
    overlay.appendChild(card);
    card.appendChild(h('header', { class: 'modal-head' },
        h('h2', null, Icon('Flag', { size: 16 }), ' Рекомендовать услугу'),
        h('button', { class: 'modal-close', onclick: () => overlay.remove() }, '×')));

    const st = { q: '', type: 'all', services: [], types: [], added: new Set() };
    const searchInp = h('input', { class: 'tp-input', type: 'search', placeholder: 'Поиск услуги…', style: { width: '100%' },
        oninput: (e) => { st.q = e.target.value; paintList(); } });
    const chipsEl = h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', margin: '10px 0' } });
    const listEl  = h('div', { style: { flex: '1 1 auto', overflow: 'auto', display: 'flex', flexDirection: 'column', gap: '6px', minHeight: '240px' } });
    card.appendChild(h('div', { class: 'modal-body', style: { display: 'flex', flexDirection: 'column', overflow: 'hidden' } },
        searchInp, chipsEl, listEl));
    card.appendChild(h('footer', { class: 'modal-foot' },
        h('span', { class: 'muted', style: { fontSize: '12px' } }, 'Каждая кнопка добавляет рекомендацию сразу.'),
        h('span', { class: 'grow' }),
        h('button', { class: 'btn btn-primary', onclick: () => overlay.remove() }, 'Готово')));
    document.body.appendChild(overlay);

    listEl.appendChild(h('div', { class: 'empty', style: { padding: '30px' } }, 'Загрузка услуг…'));
    // SERVICE_GROUPS_V1 — `type`, `is_lab` and `active` are now selected too.
    //   * type/is_lab: the chip rail grouped ONLY by the service_types embed,
    //     which resolves through services.type_id — NULL on every service — so
    //     every row fell into «Прочее» and the rail had exactly two chips.
    //   * active: the filter below tested `s.active !== false` on a column that
    //     was never selected, so it was always `undefined` and the filter a
    //     no-op — retired services were offered as recommendations.
    const [{ data, error }, typesRes] = await Promise.all([
        supabase.from('services')
            .select('id, name, price, duration_minutes, active, type, is_lab, type_id, service_types(name)')
            .eq('active', true).order('name'),
        supabase.from('service_types').select('id, name').eq('active', true).order('name'),
    ]);
    if (error) { clear(listEl); listEl.appendChild(h('div', { class: 'empty' }, trf('Не удалось загрузить услуги: {msg}', { msg: error.message }))); return; }
    st.types = typesRes && typesRes.data ? typesRes.data : [];
    st.services = data || [];

    const typeName = (s) => serviceGroupLabel(s, st.types);
    function paintChips() {
        clear(chipsEl);
        const counts = {};
        st.services.forEach(s => { const t = typeName(s); counts[t] = (counts[t] || 0) + 1; });
        const mk = (val, label) => h('button', { type: 'button',
            class: 'btn btn-sm' + (st.type === val ? ' btn-primary' : ' btn-outline'),
            style: { borderRadius: '999px' },
            onclick: () => { st.type = val; paintChips(); paintList(); } }, label);
        chipsEl.appendChild(mk('all', trf('Все · {n}', { n: st.services.length })));
        Object.keys(counts).sort().forEach(t => chipsEl.appendChild(mk(t, tr(t) + ' · ' + counts[t])));
    }
    function paintList() {
        clear(listEl);
        const q = st.q.trim().toLowerCase();
        const rows = st.services.filter(s =>
            (st.type === 'all' || typeName(s) === st.type) &&
            (!q || String(s.name || '').toLowerCase().includes(q)));
        if (!rows.length) { listEl.appendChild(h('div', { class: 'empty', style: { padding: '26px' } }, 'Ничего не найдено.')); return; }
        for (const s of rows.slice(0, 200)) {
            const isAdded = st.added.has(s.id);
            const btn = h('button', { type: 'button',
                class: 'btn btn-sm ' + (isAdded ? 'btn-outline' : 'btn-primary'),
                disabled: isAdded ? true : null,
                onclick: async (ev) => {
                    ev.currentTarget.disabled = true;
                    await sendReferral(ctx, REFERRAL_TARGETS[0], s, null);
                    st.added.add(s.id);
                    paintList();
                } }, isAdded ? '✓ Добавлено' : '+ Рекомендовать');
            listEl.appendChild(h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px', padding: '9px 12px', background: 'var(--white)', border: '1px solid var(--ink-100)', borderRadius: '10px' } },
                h('div', { style: { flex: '1 1 auto', minWidth: 0 } },
                    h('div', { style: { fontWeight: 600, fontSize: '13px' } }, s.name),
                    h('div', { class: 'muted', style: { fontSize: '11.5px' } },
                        typeName(s) + (s.duration_minutes ? ' · ' + trf('{n} мин', { n: s.duration_minutes }) : ''))),
                h('div', { class: 'cell-mono', style: { whiteSpace: 'nowrap', fontWeight: 600 } }, Number(s.price || 0).toLocaleString('ru-RU'), ' сум'),
                btn));
        }
        if (rows.length > 200) listEl.appendChild(h('div', { class: 'muted', style: { padding: '8px', fontSize: '11.5px' } }, 'Показаны первые 200 — уточните поиск.'));
    }
    paintChips(); paintList();
}

async function sendReferral(ctx, target, service, doctor) {
    // Referrals live in `recommended_services` only — they do NOT get pushed
    // into the visit's notes-history payload. The patient card's Recommended
    // tab and the visit modal's Services tab are the single source of truth.
    if (!ctx.patient?.id) { toast('Нет контекста пациента.', 'fail'); return; }
    if (!service?.id)     { toast('Выберите услугу для направления.', 'fail'); return; }

    const refDoctorId   = ctx.patient.__service?.doctorId   || null;
    const refDoctorName = ctx.patient.__service?.doctorName || null;
    // i18n-exempt: note пишется В БАЗУ (recommended_services) — хранимая запись
    const note = target.label + (doctor ? ` — выполняет ${doctor.full_name || doctor.name}` : '');
    const insertRow = {
        patient_id:          ctx.patient.id,
        service_id:          service.id,
        service_name:        service.name,
        recommended_by:      refDoctorId,
        recommended_by_name: refDoctorName,
        source_visit_id:     ctx.visitId || null,
        notes:               note,
        status:              'pending',
    };
    console.debug('[sendReferral] inserting recommendation:', insertRow);
    const { data, error } = await supabase.from('recommended_services').insert(insertRow).select().single();
    if (error) {
        console.error('[sendReferral] insert failed:', error);
        if (/relation .* does not exist/i.test(error.message) || /could not find the table/i.test(error.message) || /schema cache/i.test(error.message)) {
            toast('Сначала примените миграцию 009_recommended_services.sql.', 'fail');
        } else {
            toast(trf('Не удалось отправить направление: {msg}', { msg: error.message }), 'fail');
        }
        return;
    }
    console.debug('[sendReferral] saved row:', data);
    await logPatientActivity({
        patientId:   ctx.patient.id,
        visitId:     ctx.visitId || null,
        entityType:  'recommendation',
        entityId:    data?.id || null,
        entityLabel: service.name,
        action:      'sent',
        summary:     `Направление (${target.label}): ${service.name}` + (doctor ? ` — ${doctor.full_name || doctor.name}` : ''),   // i18n-exempt: журнал действий (БД) — хранимая запись
        detail:      { target: target.label, doctor_id: doctor?.id || null, doctor_name: doctor?.full_name || doctor?.name || null },
    });

    // Refresh the in-Plan recommendations list immediately so the doctor
    // sees what they just sent without leaving the page.
    await loadRecommendations(ctx);
    paintRecommendations(ctx);

    toast(trf('Направление отправлено: {label}', { label: tr(target.label) }) +
          (service?.name ? ' (' + service.name + ').' : '.'));
}

// Print: spawn a new window with a print-friendly render of the current form
// state. window.print() on the live page works too, but the side columns and
// sidebar get in the way; a dedicated window gives a cleaner sheet.
async function handlePrint(ctx) {
    const p = ctx.patient || {};
    const svc = p.__service || {};
    const f = collectFields(ctx);
    const patientName = `${p.lastName || ''} ${p.firstName || ''} ${p.middle || ''}`.trim() || p.fullName || 'Patient';
    const today = new Date().toLocaleDateString(undefined, { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });

    // SLICED2_PRINT_HEADER: dynamic clinic name + (optional) logo, null-safe.
    // window.CLINIC is the current company row (may be null in single-tenant dev).
    const _clinic = (typeof window !== 'undefined' && window.CLINIC) ? window.CLINIC : {};
    const _clinicName = _clinic.name_ru || _clinic.name || '';
    let _logoTag = '';
    if (_clinic.logo_url) {
        // SLICED_PUBLIC_LOGO: logo_url is now a permanent public URL (company-logos bucket) — use directly.
        _logoTag = `<img class="clinic-logo" src="${escapeHtml(_clinic.logo_url)}" alt="" style="max-height:56px;max-width:160px;object-fit:contain">`;
    }
    const _clinicHeader = (_clinicName || _logoTag)
        ? `<div class="clinic-head">${_logoTag}<div class="clinic-name">${escapeHtml(_clinicName)}</div></div>`
        : '';

    // Pull fresh data so the printout reflects whatever's just been added.
    if (!wsState.payload) wsState.payload = await readPayload(ctx);
    await loadRecommendations(ctx);
    const prescriptions = (wsState.payload?.prescriptions || []);
    const recs = (wsState.recommendations || []);

    /* i18n-exempt-start: HTML заключения (назначения) — содержимое ДОКУМЕНТА */
    const rxBlock = prescriptions.length === 0
        ? `<dd class="muted">Препараты не назначены.</dd>`
        : prescriptions.map(rx => `
            <div class="rx-row">
              <div class="rx-name">${escapeHtml(rx.name || '(без названия)')}${rx.dose ? ' · <span class="muted">' + escapeHtml(rx.dose) + '</span>' : ''}</div>
              <div class="muted small">${escapeHtml([rx.freq, rx.dur, rx.notes].filter(Boolean).join(' · ') || '—')}</div>
              ${rx.nurse ? '<div class="muted small">Медсестре: ' + escapeHtml(rx.nurse) + '</div>' : ''}
            </div>`).join('');

    /* i18n-exempt-start: HTML заключения — содержимое ДОКУМЕНТА, не текст интерфейса */
    const recsBlock = recs.length === 0
        ? `<dd class="muted">Дополнительные услуги не рекомендованы.</dd>`
        : recs.map(rec => `
            <div class="rx-row">
              <div class="rx-name">${escapeHtml(rec.__service_name)}</div>
              <div class="muted small">Рекомендовал ${escapeHtml(rec.__doctor_name || '—')}${rec.notes ? ' · ' + escapeHtml(rec.notes) : ''}</div>
            </div>`).join('');
    /* i18n-exempt-end */

    // UNIFY_PRINT_V2 — print the consultation via the single conclusion renderer (data, not bodyHtml),
    // so the doctor's printout == the #documents «Заключение» preview.
    const stripHtml = (x) => String(x || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li)>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\n{3,}/g, '\n\n').trim();
    const data = {
        title: 'Заключение приёма',
        patientName, mrn: p.mrn || '', phone: p.phone || '', dob: p.dob || p.birth_date || '', sex: p.gender || p.sex || '',
        doctorName: svc.doctorName || me().full_name || '', doctorSpec: svc.doctorSpec || me().specialty || '', service: svc.name || '',   // DOC_DOCTOR_FALLBACK_V1 — no assigned doctor → use the signed-in clinician's profile (matches the phone source)
        complaint: stripHtml(f.chief_complaint), hpi: stripHtml(f.hpi), labs: stripHtml(f.labs_text),
        instrumental: stripHtml(f.instrumental_text), exam: stripHtml(f.physical_exam),
        dx: stripHtml(f.primary_diagnosis) || _mainDxText(), icd10: stripHtml(f.icd10), therapy: stripHtml(f.therapy_text),   // DX_SAVE_FIX_V1
        recsText: stripHtml(f.recommendations_text),
        doctorPhone: wsState.docPhone ? (stripHtml(f.doctor_phone) || (wsState.wsDoctorKnown ? wsState.wsDoctorPhone : (me().phone || ''))) : '',   // DOC_PHONE_SOURCE_V1
        showDoctor: wsState.docDoctorInfo !== false,   // DOC_DOCTOR_TOGGLE_V1
        prescriptions: prescriptions.map(rx => ({ name: rx.name, dose: rx.dose, freq: rx.freq, dur: rx.dur, notes: rx.notes, nurse: rx.nurse })),
        diagnoses: (wsState.payload && wsState.payload.diagnoses || []).map(x => ({ code: x.code, name: x.name, type: x.type, typeLabel: DX_TYPE_RU[x.type] || '' })),   // DX_ALL_IN_DOC_V1
        referrals: recs.map(rec => ({ name: rec.__service_name, note: rec.__doctor_name || '' })),
    };
    try {
        const _dt = wsState.docType || 'conclusion';   // DOCTYPE_FROM_DOCUMENTS_V1
        // DIAG_PRINT_REALDATA_V1 — for «Диагностика» the print/finalize path used
        // to pass data:null, so renderDesignedVariant fell back to sampleImaging()
        // and printed the canned «Рахимов Жасур · МРТ» sample instead of the real
        // study. Build the diag-shaped payload (Описание ← instrumental, Заключение
        // ← diagnosis), mirroring the on-screen blank in renderBlank().
        let _data = null;
        if (_dt === 'conclusion') _data = data;
        else if (_dt === 'diag') _data = {
            patientName, mrn: p.mrn || '', dob: p.dob || p.birth_date || '', sex: p.gender || p.sex || '',
            doctorName: svc.doctorName || me().full_name || '', doctorSpec: svc.doctorSpec || me().specialty || '', service: svc.name || '',   // DOC_DOCTOR_FALLBACK_V1 — no assigned doctor → use the signed-in clinician's profile (matches the phone source)
            radiologist: svc.doctorName || '', radiologistSpec: svc.doctorSpec || '',
            description: data.instrumental || '', conclusion: data.dx || '',
            images: wsState.diagImages || [],   // DIAG_IMAGES_V1
        };
        // i18n-exempt: печатное заключение — печатный документ
        printableSheet({ type: _dt, data: _data, title: 'Заключение · ' + patientName, idLine: p.mrn || '', settings: loadDocSettings() });
    } catch (e) {
        console.error('[ws print]', e);
        toast('Не удалось открыть печать.', 'fail');
    }
}

// AURORA_RECIPE_V1 — separate printable «Рецепт» sheet (Latin Rp. format).
// Reads the SAME payload.prescriptions the RxCard shows; does NOT refetch
// from another source. All medication free-text is escaped via escapeHtml
// before entering the on-screen modal AND the print-window HTML.
async function openRecipeModal(ctx) {
    // Read fresh — payload may be null/stale at click time (mirrors handlePrint).
    if (!wsState.payload) wsState.payload = await readPayload(ctx);
    const items = (wsState.payload?.prescriptions || []);
    if (!items.length) {
        toast('Нет назначений для рецепта', 'info');
        return;
    }

    const p   = ctx.patient || {};
    const svc = p.__service || {};
    const patientName = `${p.lastName || ''} ${p.firstName || ''} ${p.middle || ''}`.trim() || p.fullName || 'Пациент';
    /* i18n-exempt-start: «Рецепт» — печатный бланк (Rp., ru+uz), содержимое документа */
    const ageStr = (p.age != null && p.age !== '') ? (String(p.age) + ' лет') : '—';
    const sexStr = (p.gender === 'M' ? 'Муж.' : p.gender === 'F' ? 'Жен.' : (p.gender || '—'));
    const dob = p.dob || p.birthDate || '—';
    const recId = String(p.mrn || p.id || '—');
    const doctorName = svc.doctorName || '—';
    const _clinic = (typeof window !== 'undefined' && window.CLINIC) || {};
    const clinicName  = _clinic.name_ru || _clinic.name || _clinic.title || 'Клиника';
    const clinicLegal = _clinic.legal_name || '';
    const clinicAddr  = _clinic.address || '';
    const _logoTag    = _clinic.logo_url ? `<img src="${escapeHtml(_clinic.logo_url)}" alt="" style="max-height:48px;max-width:150px;object-fit:contain;display:block;margin-bottom:4px">` : '';
    const today = new Date().toLocaleDateString('ru-RU');

    // Build one Latin Rp. block per prescription (escaped). Reused for both
    // the on-screen modal and the print window via buildRxLinesHtml().
    function buildRxLinesHtml() {
        return items.map((rx, i) => {
            const name = escapeHtml(rx.name || '(без названия)');
            const dose = rx.dose ? (' ' + escapeHtml(rx.dose)) : '';
            const sLine = rx.freq ? escapeHtml(rx.freq) : '—';
            const durLine = rx.dur ? `<div class="rx-recipe-sub">Курс: ${escapeHtml(rx.dur)}</div>` : '';
            const noteLine = rx.notes ? `<div class="rx-recipe-sub">Примечание: ${escapeHtml(rx.notes)}</div>` : '';
            return `
              <div class="rx-recipe-item">
                <div class="rx-recipe-rp"><b>Rp.:</b> <span class="rx-recipe-drug">${name}${dose}</span></div>
                <div class="rx-recipe-s"><b>S.:</b> ${sLine}</div>
                ${durLine}
                ${noteLine}
              </div>`;
        }).join('');
    }

    const rxLinesHtml = buildRxLinesHtml();

    // -------- on-screen sheet (lives inside .modal-card .modal-body) --------
    const sheet = h('div', { class: 'rx-recipe-sheet' });
    sheet.innerHTML = `
      <div class="rx-recipe-head">
        <div class="rx-recipe-clinic">
          ${_logoTag}
          <b>${escapeHtml(clinicName)}</b>
          ${clinicLegal ? `<i>${escapeHtml(clinicLegal)}</i>` : ''}
          ${clinicAddr ? `<span>${escapeHtml(clinicAddr)}</span>` : ''}
        </div>
        <div class="rx-recipe-title">
          <b>РЕЦЕПТ</b><i>RETSEPT</i>
          <span>№ ${escapeHtml(recId)} · ${escapeHtml(today)}</span>
        </div>
      </div>
      <div class="rx-recipe-pat">
        <div><span>Пациент / Bemor</span><b>${escapeHtml(patientName)}</b></div>
        <div><span>Возраст / Yosh</span><b>${escapeHtml(ageStr)} · ${escapeHtml(sexStr)}</b></div>
        <div><span>Дата рождения / Tug'ilgan sana</span><b>${escapeHtml(dob)}</b></div>
        <div><span>Дата / Sana</span><b>${escapeHtml(today)}</b></div>
      </div>
      <div class="rx-recipe-body">
        ${rxLinesHtml}
      </div>
      <div class="rx-recipe-foot">
        <div class="rx-recipe-sign">
          <span>Врач / Shifokor</span>
          <b>${escapeHtml(doctorName)}</b>
          <span class="rx-recipe-line">подпись</span>
        </div>
        <div class="rx-recipe-seal">М.П.</div>
      </div>`;

    // -------- print window (self-contained HTML, escaped, reuses handlePrint mechanism) --------
    function printRecipe() {
        const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>Рецепт · ${escapeHtml(patientName)}</title>
<style>
${PRINT_FONT_FACE_CSS}
  * { box-sizing: border-box; }
  body { font: 13px/1.5 'Onest', -apple-system, "Segoe UI", Roboto, sans-serif; color: #111; margin: 18mm 16mm; }
  .rh { display: flex; justify-content: space-between; align-items: flex-start; gap: 24px;
        border-bottom: 2px solid #167873; padding-bottom: 10px; margin-bottom: 14px; }
  .rh-clinic b { display: block; font-size: 15px; color: #0b1418; }
  .rh-clinic i { display: block; font-style: italic; color: #55636d; font-size: 12px; }
  .rh-clinic span { display: block; color: #55636d; font-size: 11.5px; margin-top: 2px; }
  .rh-title { text-align: right; }
  .rh-title b { display: block; font-size: 18px; letter-spacing: 1px; color: #167873; }
  .rh-title i { display: block; font-style: italic; color: #55636d; font-size: 12px; }
  .rh-title span { display: block; color: #55636d; font-size: 11.5px; margin-top: 4px; }
  .rp { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 24px; margin-bottom: 16px; }
  .rp > div { font-size: 12.5px; }
  .rp span { display: block; text-transform: uppercase; letter-spacing: 0.04em;
             font-size: 10px; color: #55636d; }
  .rp b { color: #0b1418; font-size: 13px; }
  .rx-item { padding: 9px 0; border-bottom: 1px dashed #d3d9de; }
  .rx-item:last-child { border-bottom: none; }
  .rx-rp { font-size: 14px; color: #0b1418; }
  .rx-rp b { font-family: Georgia, "Times New Roman", serif; }
  .rx-drug { font-weight: 600; }
  .rx-s { margin-top: 3px; color: #1f2d34; }
  .rx-s b { font-family: Georgia, "Times New Roman", serif; }
  .rx-sub { font-size: 12px; color: #55636d; margin-top: 2px; padding-left: 26px; }
  .rf { display: flex; justify-content: space-between; align-items: flex-end; margin-top: 32px; }
  .rf-sign span { display: block; text-transform: uppercase; letter-spacing: 0.04em;
                  font-size: 10px; color: #55636d; }
  .rf-sign b { display: block; margin: 4px 0; color: #0b1418; }
  .rf-line { border-top: 1px solid #0b1418; width: 200px; padding-top: 2px;
             font-size: 10px; color: #55636d; text-transform: none; letter-spacing: 0; }
  .rf-seal { width: 96px; height: 96px; border: 1.5px dashed #167873; border-radius: 50%;
             display: flex; align-items: center; justify-content: center;
             color: #167873; font-size: 13px; font-weight: 600; }
  @media print { body { margin: 14mm; -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
</style></head><body>
  <div class="rh">
    <div class="rh-clinic">
      ${_logoTag}
      <b>${escapeHtml(clinicName)}</b>
      ${clinicLegal ? `<i>${escapeHtml(clinicLegal)}</i>` : ''}
      ${clinicAddr ? `<span>${escapeHtml(clinicAddr)}</span>` : ''}
    </div>
    <div class="rh-title">
      <b>РЕЦЕПТ</b><i>RETSEPT</i>
      <span>№ ${escapeHtml(recId)} · ${escapeHtml(today)}</span>
    </div>
  </div>
  <div class="rp">
    <div><span>Пациент / Bemor</span><b>${escapeHtml(patientName)}</b></div>
    <div><span>Возраст / Yosh</span><b>${escapeHtml(ageStr)} · ${escapeHtml(sexStr)}</b></div>
    <div><span>Дата рождения / Tug'ilgan sana</span><b>${escapeHtml(dob)}</b></div>
    <div><span>ID</span><b>${escapeHtml(recId)}</b></div>
  </div>
  <div class="rx-body">
    ${items.map((rx) => {
        const name = escapeHtml(rx.name || '(без названия)');
        const dose = rx.dose ? (' ' + escapeHtml(rx.dose)) : '';
        const sLine = rx.freq ? escapeHtml(rx.freq) : '—';
        const durLine = rx.dur ? `<div class="rx-sub">Курс: ${escapeHtml(rx.dur)}</div>` : '';
        const noteLine = rx.notes ? `<div class="rx-sub">Примечание: ${escapeHtml(rx.notes)}</div>` : '';
        return `<div class="rx-item">
          <div class="rx-rp"><b>Rp.:</b> <span class="rx-drug">${name}${dose}</span></div>
          <div class="rx-s"><b>S.:</b> ${sLine}</div>
          ${durLine}${noteLine}
        </div>`;
    }).join('')}
  </div>
  <div class="rf">
    <div class="rf-sign">
      <span>Врач / Shifokor</span>
      <b>${escapeHtml(doctorName)}</b>
      <div class="rf-line">подпись</div>
    </div>
    <div class="rf-seal">М.П.</div>
  </div>
  <script>window.onload = () => { (document.fonts&&document.fonts.ready?document.fonts.ready:Promise.resolve()).then(() => { window.focus(); window.print(); }); };</script>
</body></html>`;

        const w = window.open('', '_blank', 'width=860,height=1024');
        if (!w) { toast('Браузер заблокировал окно печати. Разрешите всплывающие окна для этого сайта.', 'fail'); return; }
        w.document.open();
        w.document.write(html);
        w.document.close();
    }
    /* i18n-exempt-end */

    // -------- modal chassis (canonical openPrescriptionDialog pattern) --------
    const overlay = h('div', { class: 'modal', style: { zIndex: '130' } });
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: () => overlay.remove() }));

    const card = h('div', { class: 'modal-card rx-recipe-card', style: { width: '720px', maxWidth: 'calc(100vw - 32px)' } },
        h('header', { class: 'modal-head' },
            h('h2', null, Icon('Pill', { size: 16 }), ' Рецепт'),
            h('button', { class: 'modal-close', type: 'button', onclick: () => overlay.remove() }, '×'),
        ),
        h('div', { class: 'modal-body' }, sheet),
        h('footer', { class: 'modal-foot' },
            h('button', { class: 'btn', type: 'button', onclick: () => overlay.remove() }, 'Закрыть'),
            h('button', { class: 'btn btn-primary', type: 'button', onclick: () => printRecipe() },
                Icon('Print', { size: 14 }), ' Печать'),
        ),
    );
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    document.addEventListener('keydown', function onKey(e) {
        if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', onKey); }
    });
}


function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, ch => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
    ));
}

// Sanitize doctor-authored rich text (the A4 contentEditable SOAP fields are
// stored/printed as raw innerHTML). The print document is written into a
// same-origin window.open(''), so any <script>/on*=/javascript: a doctor
// pastes would execute with the app's origin. We parse in an inert document,
// drop dangerous nodes/attrs, and serialize the cleaned HTML. (PRINT_XSS_SANITIZE_V1)
function sanitizeRichHtml(input) {
    // Like sanitizeHtml but KEEPS inline style (preserves doctor formatting: colour/highlight/bold).
    // Strips script/dangerous elements, on* handlers, dangerous style values, and js:/data:/vbscript: URLs.
    // Used when a (possibly cross-authored, esp. shared) template body enters the live editor.
    const raw = String(input ?? '');
    if (!raw) return '';
    let doc;
    try { doc = new DOMParser().parseFromString('<div id="__sx_rsani">' + raw + '</div>', 'text/html'); }
    catch (e) { return escapeHtml(raw); }
    const root = doc.getElementById('__sx_rsani');
    if (!root) return escapeHtml(raw);
    const BAD_TAGS = new Set(['SCRIPT','STYLE','IFRAME','OBJECT','EMBED','LINK','META','BASE','FORM','INPUT','BUTTON','TEXTAREA','SVG','MATH']);
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null);
    const kill = [];
    let node = walker.nextNode();
    while (node) {
        if (BAD_TAGS.has(node.tagName)) { kill.push(node); }
        else {
            for (const attr of Array.from(node.attributes)) {
                const name = attr.name.toLowerCase();
                const val = (attr.value || '').replace(/\s/g, '').toLowerCase();
                if (name.startsWith('on')) { node.removeAttribute(attr.name); continue; }
                if (name === 'style') { if (/(javascript|vbscript|expression|url\()/i.test(val)) node.removeAttribute(attr.name); continue; }
                if ((name === 'href' || name === 'src' || name === 'xlink:href' || name === 'formaction') && /^(javascript|data|vbscript):/.test(val)) node.removeAttribute(attr.name);
            }
        }
        node = walker.nextNode();
    }
    kill.forEach(n => n.remove());
    return root.innerHTML;
}

function sanitizeHtml(input) {
    const raw = String(input ?? '');
    if (!raw) return '';
    let doc;
    try {
        doc = new DOMParser().parseFromString('<div id="__sx_sani_root">' + raw + '</div>', 'text/html');
    } catch (e) {
        return escapeHtml(raw);
    }
    const root = doc.getElementById('__sx_sani_root');
    if (!root) return escapeHtml(raw);
    const BAD_TAGS = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META', 'BASE', 'FORM', 'INPUT', 'BUTTON', 'TEXTAREA', 'SVG', 'MATH']);
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null);
    const kill = [];
    let node = walker.nextNode();
    while (node) {
        if (BAD_TAGS.has(node.tagName)) {
            kill.push(node);
        } else {
            for (const attr of Array.from(node.attributes)) {
                const name = attr.name.toLowerCase();
                const val  = (attr.value || '').replace(/[\s\u0000-\u001f]/g, '').toLowerCase();
                if (name.startsWith('on') ||
                    name === 'style' ||
                    ((name === 'href' || name === 'src' || name === 'xlink:href' || name === 'formaction') &&
                     /^(javascript|data|vbscript):/.test(val))) {
                    node.removeAttribute(attr.name);
                }
            }
        }
        node = walker.nextNode();
    }
    kill.forEach(n => n.remove());
    return root.innerHTML;
}


// ===========================================================================
// WYSIWYG_BLANK_V1 — live-template editor («Бланк»).
// The clinic's SELECTED conclusion template (renderDesignedVariant) renders in
// an iframe; its data-field regions are made contentEditable by the PARENT
// (templates contain no scripts) and every edit is written back into the
// hidden .a4-input form fields — which remain the single source of truth for
// save / draft / sign / print. The form stays in the DOM, only visually hidden.
// ===========================================================================
const _BLANK_FIELD_MAP = [
    ['chief_complaint', 'complaint'], ['hpi', 'hpi'], ['labs_text', 'labs'],
    ['instrumental_text', 'instrumental'], ['physical_exam', 'exam'],
    ['primary_diagnosis', 'dx'], ['therapy_text', 'therapy'], ['recommendations_text', 'recsText'],
];
function _blankStrip(x) {
    return String(x || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li)>/gi, '\n')
        .replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\n{3,}/g, '\n\n').trim();
}
function _mainDxText() {
    const m = (wsState.payload && wsState.payload.diagnoses || []).find(d => d && d.type === 'main');
    return m ? ((m.code ? m.code + ' — ' : '') + (m.name || '')).trim() : '';
}
function buildBlankData(ctx) {
    const f = collectFields(ctx);
    const p = ctx.patient || {};
    const svc = p.__service || {};
    const data = {
        __editor: true,
        title: 'Заключение приёма',
        patientName: `${p.lastName || ''} ${p.firstName || ''} ${p.middle || ''}`.trim() || p.fullName || '',
        mrn: p.mrn || '', phone: p.phone || '',
        dob: p.dob || p.birth_date || '',
        sex: (p.gender === 'M' ? 'Муж.' : p.gender === 'F' ? 'Жен.' : (p.gender || p.sex || '')),
        doctorName: svc.doctorName || me().full_name || '', doctorSpec: svc.doctorSpec || me().specialty || '', service: svc.name || '',   // DOC_DOCTOR_FALLBACK_V1 — no assigned doctor → use the signed-in clinician's profile (matches the phone source)
        issueDate: new Date().toLocaleDateString('ru-RU'),
        prescriptions: (wsState.payload && wsState.payload.prescriptions || []).map(rx => ({ name: rx.name, dose: rx.dose, freq: rx.freq, dur: rx.dur, notes: rx.notes, nurse: rx.nurse })),
        // DX_ALL_IN_DOC_V1 — every diagnosis (incl. сопутствующие/осложнения/фоновые)
        diagnoses: (wsState.payload && wsState.payload.diagnoses || []).map(x => ({ code: x.code, name: x.name, type: x.type, typeLabel: DX_TYPE_RU[x.type] || '' })),
        referrals: (wsState.recommendations || []).map(rec => ({ id: rec.id, name: rec.__service_name, note: rec.__doctor_name || '' })),   // REC_RM_INLINE_V1 — id lets the editor delete a line
    };
    data.complaint = _blankStrip(f.chief_complaint); data.hpi = _blankStrip(f.hpi);
    data.labs = _blankStrip(f.labs_text); data.instrumental = _blankStrip(f.instrumental_text);
    data.exam = _blankStrip(f.physical_exam); data.dx = _blankStrip(f.primary_diagnosis) || _mainDxText();   // DX_SAVE_FIX_V1
    data.icd10 = _blankStrip(f.icd10); data.therapy = _blankStrip(f.therapy_text);
    data.recsText = _blankStrip(f.recommendations_text);
    // WS_DOCPHONE_V1 — doctor phone shows on the sheet only when «Тел. врача» is toggled on.
    data.doctorPhone = wsState.docPhone ? (_blankStrip(f.doctor_phone) || (wsState.wsDoctorKnown ? wsState.wsDoctorPhone : (me().phone || ''))) : '';   // DOC_PHONE_SOURCE_V1 — consultation doctor's own phone
    data.showDoctor = wsState.docDoctorInfo !== false;   // DOC_DOCTOR_TOGGLE_V1
    data.activeFields = DOC_SECTIONS.filter(sd => wsSectionOn(sd.sec)).map(sd => sd.field);   // WS_TEMPLATE_SECTIONS_V1
    data.sectionOrder = (wsState.sectionOrder && wsState.sectionOrder.slice()) || DOC_SECTIONS.map(sd => sd.field);   // WS_REORDER_V1
    return data;
}
function setBlankMode(ctx, on) {
    const root = ctx.container;
    const scroll = root.querySelector('.a4-scroll');
    const tslot = root.querySelector('[data-toolbar-slot]');
    const wrap = root.querySelector('[data-blank-wrap]');
    const btn = root.querySelector('[data-blank-btn]');
    if (!scroll || !wrap) return;
    wsState.blank = !!on;
    try { localStorage.setItem('easymed_ws_blank', on ? '1' : '0'); } catch (e) {}
    scroll.style.display = on ? 'none' : '';
    if (tslot) tslot.style.display = 'none';   // AUTO_CHIPS_REMOVED_V1 — insert toolbar removed; keep the slot hidden
    wrap.style.display = on ? '' : 'none';
    if (btn) { clear(btn); btn.append(Icon(on ? 'Edit' : 'Doc', { size: 13 }), on ? ' Форма' : ' Бланк'); }
    if (on) renderBlank(ctx);
}
function renderBlank(ctx) {
    if (!wsState.blank) return;
    const wrap = ctx.container && ctx.container.querySelector('[data-blank-wrap]');
    if (!wrap || wrap.style.display === 'none') return;
    const s = loadDocSettings();
    const type = wsState.docType || 'conclusion';
    // DOCTYPE_FROM_DOCUMENTS_V1 — data per template type: «Заключение» edits the
    // consultation fields; «Диагностика» previews them read-only (description ←
    // инструментальные, заключение ← диагноз/рекомендации); lab/billing types show
    // the template with sample data (they are produced by their own modules).
    let data = null;
    if (type === 'conclusion') data = buildBlankData(ctx);
    else if (type === 'diag') {
        // DIAG_EDITABLE_V1 — editable imaging report: «Описание» ↔ instrumental_text,
        // «Заключение» ↔ primary_diagnosis (the same record the conclusion document edits).
        const base = buildBlankData(ctx);
        data = {
            __editor: true,
            patientName: base.patientName, mrn: base.mrn, dob: base.dob, sex: base.sex,
            doctorName: base.doctorName, doctorSpec: base.doctorSpec, service: base.service,
            radiologist: base.doctorName, radiologistSpec: base.doctorSpec,
            description: base.instrumental || '', conclusion: base.dx || '',
            images: wsState.diagImages || [],   // DIAG_IMAGES_V1
        };
    }
    const html = renderDesignedVariant(type, (s.variant && s.variant[type]) || 'classic', s, data);
    if (!html) { wrap.textContent = tr('Шаблон недоступен.'); return; }
    let frame = wrap.querySelector('iframe');
    if (!frame) {
        frame = h('iframe', { style: { width: '100%', border: '0', display: 'block', minHeight: '900px', background: 'white', borderRadius: '8px', boxShadow: '0 4px 18px rgba(0,0,0,.08)' } });
        wrap.appendChild(frame);
    }
    const doc = frame.contentDocument;
    doc.open(); doc.write(html); doc.close();
    if (type === 'conclusion' || type === 'diag') _wireBlankEditing(ctx, frame);   // DIAG_EDITABLE_V1
    else _wireBlankPreview(ctx, frame);
}

// Read-only template preview (non-conclusion types): banner + autosize + page bands.
function _wireBlankPreview(ctx, frame) {
    const doc = frame.contentDocument;
    const st = doc.createElement('style');
    st.textContent = '.bk-pagesep{position:relative;display:block;}' +
        '.bk-pageedge{position:absolute;left:-60px;right:-60px;height:26px;background:#dde5e3;box-shadow:inset 0 7px 7px -7px rgba(0,0,0,.3), inset 0 -7px 7px -7px rgba(0,0,0,.3);text-align:center;font:700 8.5px/26px "Onest",Arial,sans-serif;letter-spacing:.14em;color:#7b908c;}' +
        '@media print{.bk-pagesep{display:none !important;}.bk-preview-note{display:none;}}' +
        '.bk-preview-note{background:#fff7e6;border:1px solid #f0d9a8;color:#8a6d1f;font:600 11px/1.45 "Onest",Arial,sans-serif;padding:8px 12px;border-radius:8px;margin:10px;}';
    doc.head.appendChild(st);
    const note = doc.createElement('div');
    note.className = 'bk-preview-note';
    note.textContent = tr('Предпросмотр шаблона клиники. Документ этого типа формируется в своём модуле (касса, лаборатория) — поля приёма редактируются в типе «Заключение приёма».');
    doc.body.insertBefore(note, doc.body.firstChild);
    const fit = () => { try { _paginateBlank(doc, null); frame.style.height = Math.max(600, doc.documentElement.scrollHeight + 24) + 'px'; } catch (e) {} };
    fit(); setTimeout(fit, 250);
}
// DIAG_IMAGES_V1 — read one image File, downscale it via canvas (max 1400px on
// the long edge, JPEG q0.82) so the base64 stored in visit_documents.body stays
// small, and resolve a data URL. Falls back to the raw data URL if canvas fails.
function _compressImage(file, maxDim, quality) {
    return new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onerror = () => reject(new Error('read failed'));
        fr.onload = () => {
            const img = new Image();
            img.onerror = () => resolve(fr.result);   // non-decodable → keep original
            img.onload = () => {
                try {
                    let w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
                    const scale = Math.min(1, maxDim / Math.max(w, h || 1));
                    w = Math.max(1, Math.round(w * scale)); h = Math.max(1, Math.round(h * scale));
                    const cv = document.createElement('canvas');
                    cv.width = w; cv.height = h;
                    cv.getContext('2d').drawImage(img, 0, 0, w, h);
                    resolve(cv.toDataURL('image/jpeg', quality));
                } catch (e) { resolve(fr.result); }
            };
            img.src = fr.result;
        };
        fr.readAsDataURL(file);
    });
}
async function _diagAddImages(ctx, fileList) {
    const files = [...(fileList || [])].filter(f => /^image\//.test(f.type));
    if (!files.length) return;
    const MAX = 12;
    for (const f of files) {
        if ((wsState.diagImages || []).length >= MAX) { toast(trf('Максимум {n} изображений.', { n: MAX }), 'warn'); break; }
        try { wsState.diagImages.push(await _compressImage(f, 1400, 0.82)); }
        catch (e) { console.warn('[diag image]', e); toast('Не удалось обработать изображение.', 'fail'); }
    }
    wsState.saved = false;
    resetSaveBtn(ctx);
    renderBlank(ctx);
}

// DOC_ZOOM_V1 — zoom the document view (blank «Черновик» iframe + structured A4 paper).
function applyDocZoom(ctx) {
    const z = wsState.docZoom || 1;
    try { ctx.container.querySelectorAll('.a4-paper').forEach(el => { el.style.zoom = z; }); } catch (e) {}
    try {
        const fr = ctx.container.querySelector('[data-blank-wrap] iframe');
        if (fr && fr.contentDocument && fr.contentDocument.body) {
            fr.contentDocument.body.style.zoom = z;
            const d = fr.contentDocument;
            fr.style.height = Math.max(600, d.documentElement.scrollHeight + 24) + 'px';
        }
    } catch (e) {}
    const lbl = ctx.container.querySelector('[data-zoom-label]');
    if (lbl) lbl.textContent = Math.round(z * 100) + '%';
}

function _wireBlankEditing(ctx, frame) {
    const doc = frame.contentDocument;
    // editor affordances injected by the parent (templates ship without scripts)
    const st = doc.createElement('style');
    st.textContent = '.sec{border:1px solid #e2e8f0;border-radius:8px;padding:9px 12px 10px;background:#fff;transition:border-color .12s,box-shadow .12s;}' +   // LINKED_SECTION_V1 — header + writing area = one block
        '.sec:focus-within{border-color:var(--accent,#1a7f77);box-shadow:0 0 0 2px rgba(22,120,115,.14);}' +
        '.sec-h{margin-bottom:6px;}' +
        '[data-field]{min-height:3.2em;padding:2px 0;transition:background .12s;outline:none;}' +
        '[data-field]:empty::before{content:"' + tr('Нажмите, чтобы заполнить…') + '";color:#9fb3b0;font-style:italic;}' +
        '.bk-pagesep{position:relative;display:block;}' +
        '.bk-pageedge{position:absolute;left:-60px;right:-60px;height:26px;background:#dde5e3;box-shadow:inset 0 7px 7px -7px rgba(0,0,0,.3), inset 0 -7px 7px -7px rgba(0,0,0,.3);text-align:center;font:700 8.5px/26px "Onest",Arial,sans-serif;letter-spacing:.14em;color:#7b908c;}' +
        '@media print{.bk-pagesep{display:none !important;}}' +
        '.dx .dh{display:flex;align-items:baseline;}' +
        '.bk-rm{margin-left:auto;border:0;background:transparent;color:#c3ccd6;font-size:14px;line-height:1;cursor:pointer;padding:0 2px 0 8px;}' +
        '.bk-rm:hover{color:#dc2626;}' +
        '.bk-add{display:block;width:100%;text-align:left;margin:7px 0;padding:8px 12px;border:1px dashed #cbd5e1;border-radius:8px;background:#f8fafc;color:#64748b;font:600 11px/1.2 "Onest","Helvetica Neue",Arial,sans-serif;cursor:pointer;}' +
        '.bk-add:hover{border-color:var(--accent,#1a7f77);color:var(--accent,#1a7f77);}' +
        '.bk-ctl{margin-left:auto;display:inline-flex;align-items:center;gap:1px;}' +
        '.bk-up,.bk-dn{border:0;background:transparent;color:#9aa4b0;cursor:pointer;padding:2px 3px;border-radius:5px;display:inline-flex;align-items:center;}' +
        '.bk-up:hover,.bk-dn:hover{color:var(--accent,#1a7f77);background:#eef2f7;}' +
        'body{padding-top:8px !important;}' +
        // PAPER_A4_KEEP_V1 — keep the full A4 page (no min-height override); buttons stack vertically.
        '[data-ws-actions]{display:flex;flex-direction:row;flex-wrap:wrap;align-items:center;gap:8px;margin:16px 0 4px;}' +
        '[data-ws-actions] .ws-actbreak{flex-basis:100%;height:0;margin:0;}' +   // forces «Тел. врача» onto its own line
        '[data-ws-actions] button{display:inline-flex;align-items:center;gap:6px;padding:8px 13px;border:1px solid #a7f3d0;border-radius:8px;background:#ecfdf5;color:#065f46;font:600 12px/1 "Onest","Helvetica Neue",Arial,sans-serif;cursor:pointer;}' +
        '[data-ws-actions] button svg{width:15px;height:15px;flex:0 0 auto;}' +
        '[data-ws-actions] button:hover{border-color:#34d399;background:#d1fae5;}' +
        // DX_PLAIN_SECTION_V1 — in the editor the Диагноз block looks like every
        // other section: same white box, neutral header (no red), same focus ring.
        '.dx{background:#fff !important;border:1px solid #e2e8f0 !important;border-left:1px solid #e2e8f0 !important;border-radius:8px !important;padding:9px 12px 10px !important;margin:8px 0 !important;}' +
        '.dx:focus-within{border-color:var(--accent,#1a7f77) !important;box-shadow:0 0 0 2px rgba(22,120,115,.14);}' +
        '.dx .dh .ru,.dx .dh{color:#334155 !important;}' +
        '.bk-icd{display:inline-flex;align-items:center;gap:6px;margin-top:7px;padding:7px 12px;border:1px dashed #e6c74c;border-radius:8px;background:#fef9c3;color:#854d0e;font:600 11.5px/1.2 "Onest","Helvetica Neue",Arial,sans-serif;cursor:pointer;}' + /* ICD_BTN_YELLOW_V1 */
        '.bk-icd:hover{border-color:#ca8a04;background:#fef08a;color:#713f12;}' +
        '.bk-recrm{margin-left:auto;border:0;background:transparent;color:#dc2626;font:600 11px/1 "Onest","Helvetica Neue",Arial,sans-serif;cursor:pointer;padding:2px 6px;border-radius:6px;opacity:.75;white-space:nowrap;}' +
        '.svc .si,.recs li{display:flex;align-items:baseline;gap:6px;}' +   // REC_RM_INLINE_V1 — «Удалить» stays on the SAME line, pinned right
        '.recs li::before{content:"•";color:var(--accent,#1a7f77);}' +
        '.bk-recrm:hover{background:#fee2e2;opacity:1;}' +
        '@media print{.bk-add,.bk-rm,.bk-ctl,.bk-icd,.bk-recrm,[data-ws-actions]{display:none !important;}}';
    doc.head.appendChild(st);
    try { doc.body.style.zoom = wsState.docZoom || 1; } catch (e) {}   // DOC_ZOOM_V1 — keep zoom across re-renders
    for (const el of doc.querySelectorAll('[data-field]')) {
        el.setAttribute('contenteditable', 'true');
        el.addEventListener('input', () => _syncBlankField(ctx, el));
    }
    // DX_PLAIN_SECTION_V1 — one-click МКБ-10 picker inside the document editor;
    // picks re-render the sheet via syncDiagnosisToDoc -> renderBlank.
    // REC_RM_INLINE_V1 — «Удалить» on each recommended-service line (editor only)
    for (const b of doc.querySelectorAll('[data-rec-rm]')) {
        b.addEventListener('click', async (e) => {
            e.preventDefault(); e.stopPropagation();
            await removeWorkspaceRec(ctx, b.getAttribute('data-rec-rm'));
            renderBlank(ctx);
        });
    }
    const _dxField = doc.querySelector('[data-field="primary_diagnosis"]');
    if (_dxField && !doc.querySelector('.bk-icd')) {
        const _icdBtn = doc.createElement('button');
        _icdBtn.type = 'button'; _icdBtn.className = 'bk-icd';
        _icdBtn.textContent = tr('+ Выбрать из МКБ-10');
        _icdBtn.addEventListener('click', (e) => { e.preventDefault(); try { openDiagnosisModal(ctx); } catch (err) { console.warn('[dx icd]', err); } });
        const _host = _dxField.closest('.dx') || _dxField.parentElement;
        _host.appendChild(_icdBtn);
    }
    // AUTO_FOCUS_SECTION_V1 — after «+ Добавить» opens a section, drop the caret straight into it.
    if (wsState._focusField) {
        const _fld = wsState._focusField; wsState._focusField = null;
        setTimeout(() => { try {
            const f = doc.querySelector('[data-field="' + _fld + '"]');
            if (f) { f.focus(); const r = doc.createRange(); r.selectNodeContents(f); r.collapse(false); const s = doc.getSelection(); s.removeAllRanges(); s.addRange(r); }
        } catch (e) {} }, 90);
    }
    // WS_TEMPLATE_SECTIONS_V1 — wire the template's inline +/- section pills.
    const _f2s = (f) => { const m = DOC_SECTIONS.find(x => x.field === f); return m ? m.sec : null; };
    for (const b of doc.querySelectorAll('[data-rm]')) b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); const sc = _f2s(b.getAttribute('data-rm')); if (sc) wsRemoveSection(ctx, sc); });
    for (const b of doc.querySelectorAll('[data-add]')) b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); const field = b.getAttribute('data-add'); const sc = _f2s(field); if (sc) { wsState._focusField = field; wsAddSection(ctx, sc); } });
    for (const b of doc.querySelectorAll('[data-up]')) b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); wsMoveSection(ctx, b.getAttribute('data-up'), -1); });
    for (const b of doc.querySelectorAll('[data-dn]')) b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); wsMoveSection(ctx, b.getAttribute('data-dn'), 1); });
    // DIAG_IMAGES_V1 — imaging photo upload (+/- like the text sections). Only in
    // «Диагностика» mode; the add/remove controls exist only when the diag blank
    // renders with __editor:true.
    for (const b of doc.querySelectorAll('[data-img-add]')) b.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        const inp = document.createElement('input');
        inp.type = 'file'; inp.accept = 'image/*'; inp.multiple = true; inp.style.display = 'none';
        inp.addEventListener('change', () => { _diagAddImages(ctx, inp.files); inp.remove(); });
        document.body.appendChild(inp); inp.click();
    });
    for (const b of doc.querySelectorAll('[data-img-rm]')) b.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        const i = Number(b.getAttribute('data-img-rm'));
        if (i >= 0 && i < (wsState.diagImages || []).length) {
            wsState.diagImages.splice(i, 1); wsState.saved = false; resetSaveBtn(ctx); renderBlank(ctx);
        }
    });
    // WS_BLOCK_FMT_V1 — floating formatting bar shown on text selection inside a section block.
    if (!doc.querySelector('[data-bk-fmt]')) {
        const fbar = doc.createElement('div');
        fbar.setAttribute('data-bk-fmt', '');
        fbar.style.cssText = 'position:absolute;display:none;z-index:99999;background:#111827;border-radius:8px;padding:3px;box-shadow:0 6px 18px rgba(0,0,0,.28);white-space:nowrap;';
        const fbBtn = (cmd, label, val) => `<button type="button" data-cmd="${cmd}"${val ? ` data-val="${val}"` : ''} style="border:0;background:transparent;color:#fff;font:600 13px/1 Arial,sans-serif;cursor:pointer;padding:5px 8px;border-radius:5px;">${label}</button>`;
        fbar.innerHTML =
            fbBtn('bold', tr('<b>Ж</b>')) + fbBtn('italic', tr('<i>К</i>')) + fbBtn('underline', tr('<u>Ч</u>')) + fbBtn('strikeThrough', tr('<s>З</s>')) +
            fbBtn('foreColor', '<span style="color:#4dabf7">A</span>', '#1971c2') +
            fbBtn('hiliteColor', '<span style="background:#fff3bf;color:#111;padding:0 3px;border-radius:2px">A</span>', '#fff3bf') +
            fbBtn('fontSize:5', 'A+', '') + fbBtn('fontSize:2', 'A-', '') +
            fbBtn('insertUnorderedList', '•') + fbBtn('insertOrderedList', '1.') + fbBtn('removeFormat', '⌫');
        doc.body.appendChild(fbar);
        fbar.addEventListener('mousedown', (e) => {
            const b = e.target.closest('[data-cmd]'); if (!b) return;
            e.preventDefault();
            const raw = b.getAttribute('data-cmd');
            try {
                if (raw.indexOf('fontSize:') === 0) doc.execCommand('fontSize', false, raw.split(':')[1]);
                else doc.execCommand(raw, false, b.getAttribute('data-val') || null);
            } catch (_) {}
            const sel = doc.getSelection(); const n = sel && sel.anchorNode;
            const host = n && (n.nodeType === 1 ? n : n.parentElement);
            const fld = host && host.closest('[data-field]');
            if (fld) _syncBlankField(ctx, fld);
        });
        let _fbHideT = null;
        const showFbar = (fld) => {
            const r = fld.getBoundingClientRect();
            const sx = doc.documentElement.scrollLeft || doc.body.scrollLeft || 0;
            const sy = doc.documentElement.scrollTop || doc.body.scrollTop || 0;
            fbar.style.display = 'block';
            fbar.style.left = Math.max(6, r.left + sx) + 'px';
            fbar.style.top = Math.max(6, r.top + sy - 38) + 'px';
        };
        doc.addEventListener('focusin', (e) => {
            const fld = e.target && e.target.closest && e.target.closest('[data-field]');
            if (fld) { clearTimeout(_fbHideT); showFbar(fld); }
        });
        doc.addEventListener('focusout', () => { _fbHideT = setTimeout(() => { fbar.style.display = 'none'; }, 250); });
        fbar.addEventListener('mousedown', () => { clearTimeout(_fbHideT); }, true);
        doc.addEventListener('scroll', () => { const a = doc.activeElement; const fld = a && a.closest && a.closest('[data-field]'); if (fld && fbar.style.display !== 'none') showFbar(fld); }, true);
    }
    // PAPER_ACTIONS_BLANK_V1 — inject «Повторный визит» + «Заявка на госпитализацию» into the WYSIWYG
    // sheet, right under the last section (recommendations), just above the signature/М.П. block.
    try {
        if (!doc.querySelector('[data-ws-actions]')) {
            const bar = doc.createElement('div');
            bar.setAttribute('data-ws-actions', '');
            // MINIMAL_ICONS_V1 — clean stroke SVG icons (Feather/Lucide style) instead of emoji.
            const _svg = (p) => '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + p + '</svg>';
            const _ic = {
                recommend: _svg('<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/>'),
                revisit: _svg('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>'),
                recipe: _svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>'),
                results: _svg('<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/>'),
                service: _svg('<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/>'),
                dispense: _svg('<path d="M10.5 20.5 3.5 13.5a5 5 0 0 1 7-7l7 7a5 5 0 0 1-7 7Z"/><path d="m8.5 8.5 7 7"/>'),
                hospital: _svg('<path d="M2 4v16"/><path d="M2 8h18a2 2 0 0 1 2 2v10"/><path d="M2 17h20"/><path d="M6 8v9"/>'),
                phone: _svg('<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>'),
                docinfo: _svg('<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>'),
            };
            const mk = (icon, label, onClick) => {
                const b = doc.createElement('button');
                b.type = 'button';
                b.innerHTML = icon + '<span>' + label + '</span>';
                b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); onClick(); });
                return b;
            };
            // PAPER_ACTIONS_ROW_V1 — one wrapping row, ordered per request; «Тел. врача» on its own line.
            if (patientTabCanEdit('recommended')) bar.appendChild(mk(_ic.recommend, 'Рекомендовать услугу', () => openServicePickerModal({
                title: 'Рекомендовать услугу', titleIcon: 'Flag',
                confirmLabel: 'Добавить в рекомендации', confirmIcon: 'Plus',
                onPick: ({ service, doctor }) => sendReferral(ctx, REFERRAL_TARGETS[0], service, doctor),
            })));
            bar.appendChild(mk(_ic.revisit, 'Повторный визит', () => openRevisitModal(ctx)));
            bar.appendChild(mk(_ic.recipe, 'Рецепт', () => openPrescriptionDialog(ctx, null)));
            bar.appendChild(mk(_ic.results, 'Вставить результаты', () => openEmrModal(ctx)));
            if (patientTabCanEdit('services')) bar.appendChild(mk(_ic.service, 'Услуги приёма', async () => {
                const svc = ctx.patient?.__service || {};
                const did = await resolveWsDoctorId(ctx);
                openServicePickerModal({
                    patient: ctx.patient,
                    lockedDoctor: did ? { id: did, name: svc.doctorName || '', spec: svc.doctorSpec || '' } : null,
                    onBooked: () => { try { loadPatientEmr(ctx.patient).then(() => paintEmr()); } catch (e) {} },
                });
            }));
            bar.appendChild(mk(_ic.dispense, 'Выдать препарат', () => openDispenseConsultItem(ctx)));
            bar.appendChild(mk(_ic.hospital, 'Заявка на госпитализацию', () => openHospitalizationRequestModal(ctx)));
            const _brk = doc.createElement('div'); _brk.className = 'ws-actbreak'; bar.appendChild(_brk);   // «Тел. врача» wraps to its own line
            bar.appendChild(mk(_ic.phone, 'Тел. врача', () => {
                wsState.docPhone = !wsState.docPhone;
                const el = ctx.container.querySelector('[data-docphone]');
                if (el) el.classList.toggle('a4-sec-off', !wsState.docPhone);
                const inp = el && el.querySelector('[data-field="doctor_phone"]');
                if (wsState.docPhone && inp) { if (!(inp.innerText || '').trim()) inp.textContent = (wsState.wsDoctorKnown ? (wsState.wsDoctorPhone || '') : (me().phone || '')); inp.focus(); }
                try { setTimeout(() => renderBlank(ctx), 0); } catch (e) {}
            }));
            bar.appendChild(mk(_ic.docinfo, 'Инфо о враче', () => {
                wsState.docDoctorInfo = !wsState.docDoctorInfo;
                try { setTimeout(() => renderBlank(ctx), 0); } catch (e) {}
            }));
            const signoff = doc.querySelector('.signoff');
            if (signoff && signoff.parentNode) signoff.parentNode.insertBefore(bar, signoff);
            else doc.body.appendChild(bar);
        }
    } catch (e) { console.warn('[blank actions]', e); }
    const fit = () => { try { _paginateBlank(doc, ctx); frame.style.height = Math.max(900, doc.documentElement.scrollHeight + 24) + 'px'; } catch (e) {} };
    fit(); setTimeout(fit, 250); setTimeout(fit, 900);
    let _pgT = null;
    doc.addEventListener('input', () => { clearTimeout(_pgT); _pgT = setTimeout(fit, 700); });
}
function _syncBlankField(ctx, el) {
    const key = el.getAttribute('data-field') || el.getAttribute('data-cont-of');
    if (!key) return;
    // A4_TEXT_SPLIT_V1 — the field may be split across pages: join every part in order.
    const doc = el.ownerDocument;
    const parts = [...doc.querySelectorAll('[data-field="' + key + '"], [data-cont-of="' + key + '"]')];
    const txt = parts.map(p => String(p.innerText || '')).join('\n').replace(/\u00a0/g, ' ').replace(/\n{3,}/g, '\n\n');
    const root = (ctx && ctx.container) || document;   // continuations created by the paginator pass ctx=null
    const host = root.querySelector(`.a4-input[data-field="${key}"]`) || root.querySelector(`[data-field="${key}"]`);
    if (host) {
        if (host.classList && host.classList.contains('a4-input')) host.innerHTML = escapeHtml(txt.trim()).replace(/\n/g, '<br>');
        else host.value = txt.trim();
    }
    wsState.saved = false;
    if (ctx) resetSaveBtn(ctx);
    else { const b = document.querySelector('[data-save-btn]'); if (b) { wsState.saved = false; } }
}


// BLANK_PAGINATE_V1 — A4 page-break bands inside the blank, mirroring the form
// editor's paginateA4: flatten the sheet's flow blocks (classic keeps sections in
// .body, compact at top level), accumulate heights, and insert a visual
// «разрыв страницы» band wherever content crosses an A4 page boundary.
// Hidden in print (@media print) — real printing paginates via @page rules.
// ===========================================================================
// A4_TEXT_SPLIT_V1 — exact A4 pages WITH text flow: a long editable section
// SPLITS at the page boundary (the lines that fit stay; the rest continues on
// the next page in a [data-cont-of] block that edits the same field). Merge →
// re-split on every run keeps it idempotent; the caret is saved and restored.
// Non-text blocks transfer whole; absolutes (watermark/stamp) are ignored.
// ===========================================================================
const _A4 = { PAGE: 1123, MB: 48, MT: 56 };

function _blankSaveCaret(doc) {
    try {
        const sel = doc.getSelection();
        if (!sel || !sel.rangeCount || !sel.anchorNode) return null;
        const el = (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement);
        const fieldEl = el && el.closest && el.closest('[data-field],[data-cont-of]');
        if (!fieldEl) return null;
        const key = fieldEl.getAttribute('data-field') || fieldEl.getAttribute('data-cont-of');
        // global text offset across all parts of this field
        const parts = [...doc.querySelectorAll('[data-field="' + key + '"], [data-cont-of="' + key + '"]')];
        let off = 0, found = false;
        for (const part of parts) {
            const walker = doc.createTreeWalker(part, 4 /* TEXT */);
            let n;
            while ((n = walker.nextNode())) {
                if (n === sel.anchorNode) { off += sel.anchorOffset; found = true; break; }
                off += (n.textContent || '').length;
            }
            if (found) break;
            off += 1;   // the implied \n between parts
        }
        return found ? { key, off } : null;
    } catch (e) { return null; }
}
function _blankRestoreCaret(doc, caret) {
    if (!caret) return;
    try {
        const parts = [...doc.querySelectorAll('[data-field="' + caret.key + '"], [data-cont-of="' + caret.key + '"]')];
        let off = caret.off;
        for (const part of parts) {
            const walker = doc.createTreeWalker(part, 4);
            let n, last = null;
            while ((n = walker.nextNode())) {
                last = n;
                const len = (n.textContent || '').length;
                if (off <= len) {
                    const r = doc.createRange();
                    r.setStart(n, Math.max(0, Math.min(off, len))); r.collapse(true);
                    const sel = doc.getSelection(); sel.removeAllRanges(); sel.addRange(r);
                    return;
                }
                off -= len;
            }
            if (!parts.length) return;
            off -= 1;   // implied \n between parts
            if (off < 0 && last) {
                const r = doc.createRange(); r.selectNodeContents(last); r.collapse(false);
                const sel = doc.getSelection(); sel.removeAllRanges(); sel.addRange(r);
                return;
            }
        }
    } catch (e) { /* caret restore is best-effort */ }
}

function _blankFlowBlocks(sheet) {
    const out = [];
    for (const ch of [...sheet.children]) {
        if (ch.classList && ch.classList.contains('body')) out.push(...ch.children);
        else out.push(ch);
    }
    return out;
}

function _paginateBlank(doc, ctx) {
    const sheet = doc.querySelector('.sheet');
    if (!sheet) return;
    const caret = _blankSaveCaret(doc);
    // 1) merge continuations back into their primary field, drop separators
    for (const cont of [...doc.querySelectorAll('[data-cont-wrap]')]) {
        const key = cont.getAttribute('data-cont-wrap');
        const contB = cont.querySelector('[data-cont-of]');
        const primary = doc.querySelector('[data-field="' + key + '"]');
        const t = contB ? String(contB.innerText || '') : '';
        if (primary && t) primary.innerText = String(primary.innerText || '') + '\n' + t;
        cont.remove();
    }
    for (const g of [...doc.querySelectorAll('.bk-pagesep')]) g.remove();

    // 2) multi-pass split/transfer until stable (long docs need page 3, 4, …)
    const view = doc.defaultView;
    for (let pass = 0; pass < 6; pass++) {
        if (!_blankPaginatePass(doc, sheet, view)) break;
    }
    _blankRestoreCaret(doc, caret);
}

function _blankPaginatePass(doc, sheet, view) {
    const { PAGE, MB, MT } = _A4;
    const _z = wsState.docZoom || 1;   // DOC_ZOOM_V1 — getBoundingClientRect is in zoomed px; divide to get layout px so page breaks match the real page bottom
    let page = 1, changed = false;
    for (const b of _blankFlowBlocks(sheet)) {
        if (b.classList && b.classList.contains('bk-pagesep')) continue;
        const cs = view.getComputedStyle(b);
        if (cs.position === 'absolute' || cs.position === 'fixed' || cs.display === 'none') continue;
        const sr = sheet.getBoundingClientRect();
        const r = b.getBoundingClientRect();
        const top = (r.top - sr.top) / _z;
        const bh = (r.height || 0) / _z;
        let contentBottom = page * PAGE - MB;
        while (top >= contentBottom) { page += 1; contentBottom = page * PAGE - MB; }
        if (top + bh <= contentBottom) continue;

        // ---- the block crosses the boundary ----
        const field = b.querySelector ? b.querySelector('[data-field]') : null;
        const fieldKey = field && field.getAttribute('data-field');
        const lines = field ? String(field.innerText || '').split('\n') : [];
        const avail = contentBottom - top;
        if (field && fieldKey && fieldKey !== 'primary_diagnosis' && lines.length > 1 && avail > 70) {
            // split: keep the lines that fit, continue the rest on the next page
            const all = lines.slice();
            let lo = 1, hi = all.length - 1, k = 0;
            while (lo <= hi) {
                const mid = (lo + hi) >> 1;
                field.innerText = all.slice(0, mid).join('\n');
                const hNow = b.getBoundingClientRect().height / _z;
                if (top + hNow <= contentBottom) { k = mid; lo = mid + 1; } else { hi = mid - 1; }
            }
            if (k >= 1) {
                field.innerText = all.slice(0, k).join('\n');
                const rest = all.slice(k).join('\n');
                const wrap = doc.createElement('div');
                wrap.setAttribute('data-cont-wrap', fieldKey);
                wrap.className = b.className;   // same .sec look
                const contB = doc.createElement('div');
                contB.className = field.className;   // .sec-b styling
                contB.setAttribute('data-cont-of', fieldKey);
                contB.setAttribute('contenteditable', 'true');
                contB.innerText = rest;
                contB.addEventListener('input', () => _syncBlankField(null, contB));
                wrap.appendChild(contB);
                const realBottom = (b.getBoundingClientRect().bottom - sheet.getBoundingClientRect().top) / _z;
                const fill = Math.max(0, contentBottom - realBottom);
                const sep = _blankMakeSep(doc, fill, page + 1);
                b.parentNode.insertBefore(sep, b.nextSibling);
                sep.parentNode.insertBefore(wrap, sep.nextSibling);
                page += 1; changed = true;
                continue;
            }
            field.innerText = all.join('\n');   // nothing fit — fall through to transfer
        }
        if (bh > PAGE - MB - MT - 80) {   // unsplittable oversize: let it flow
            while (top + bh > page * PAGE - MB) page += 1;
            continue;
        }
        if (top > (page - 1) * PAGE) {    // transfer the whole block
            const fill = Math.max(0, contentBottom - top);
            const sep = _blankMakeSep(doc, fill, page + 1);
            b.parentNode.insertBefore(sep, b);
            page += 1; changed = true;
        }
    }
    return changed;
}

function _blankMakeSep(doc, fill, pageNo) {
    const { MB, MT } = _A4;
    const sep = doc.createElement('div');
    sep.className = 'bk-pagesep';
    sep.setAttribute('contenteditable', 'false');
    sep.style.height = (fill + MB + MT) + 'px';
    const edge = doc.createElement('div');
    edge.className = 'bk-pageedge';
    edge.style.top = (fill + MB - 13) + 'px';
    edge.textContent = 'СТРАНИЦА ' + pageNo;   // i18n-exempt: край листа ДОКУМЕНТА — часть бланка
    sep.appendChild(edge);
    return sep;
}
