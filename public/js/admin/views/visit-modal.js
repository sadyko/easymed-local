// Visit details modal — opened when clicking a visit row (patient card) or
// an appointment block on the scheduling calendar.
//
// Header shows the current status pill + quick-action buttons that drive the
// workflow: scheduled → confirmed → arrived (waiting) → in_progress → completed.
// Invoice generation is gated: only allowed once the patient has at least
// arrived. The optional `onChange` callback fires after any DB-changing action
// so the caller (e.g. the calendar) can refresh.

import { supabase } from '../../supabase.js';
import { tr } from '../i18n.js';   // I18N_COVERAGE_V1 — sink-обёртки: textContent/confirm не проходят через h()
import { currentUser } from '../data.js';
import { h, Icon, Tag, StatusTag, statusLabel, toast, clear } from '../ui.js';
import { canDelete } from '../permissions.js';
import { openServicePickerModal } from './service-picker-modal.js?v=aug17e';
import { openItemPickerModal } from './item-picker-modal.js?v=billoptin1';   // DISPENSE_ITEM_V1
import { creditCashbackOnPaid } from './cashback.js?v=cb1';
import { openCancelInvoiceDialog, logInvoiceAction as _logInvoiceAction } from './invoice-actions.js?v=ia3';
import { logPatientActivity } from './activity-log.js';
import { printableSheet } from './doc-settings.js?v=noqr1';   // must match every other importer (one module instance)

let active = null;

export function openVisitModal({ visit, patient, doctor, service, onChange, onStatusChange } = {}) {
    closeActive();
    const state = {
        visit:    visit    || {},
        patient:  patient  || {},
        doctor:   doctor   || null,
        service:  service  || null,
        tab:      'services',
        services:        [],
        recommendations: [],   // pending recs for this patient (loaded async)
        invoice:         null,
        invoiceLogs:     [],   // invoice_audit_log rows for this visit
        onChange:       onChange       || (() => {}),
        onStatusChange: onStatusChange || null,    // fast in-place block recolor
    };

    const overlay = h('div', { class: 'modal' });
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: () => close() }));

    const card = h('div', { class: 'modal-card modal-grouped', style: { width: '1240px', maxWidth: 'calc(100vw - 32px)', maxHeight: 'calc(100vh - 60px)', display: 'flex', flexDirection: 'column' } });
    overlay.appendChild(card);

    // ---- Header (re-renders on status change) ----
    const headerEl = h('header', { class: 'modal-head', style: { gap: '12px', flexWrap: 'wrap' } });
    card.appendChild(headerEl);

    // ---- Tabs ----
    const tabBar = h('div', { class: 'tabs', style: { padding: '0 22px', background: 'var(--ink-25)', borderBottom: '1px solid var(--ink-100)' } });
    card.appendChild(tabBar);

    // ---- Body ----
    const body = h('div', { style: { flex: 1, overflowY: 'auto', padding: '20px 22px' } });
    card.appendChild(body);

    // ---- Footer ----
    const saveBtn = h('button', { class: 'btn btn-primary', onclick: async (ev) => {
        ev.currentTarget.disabled = true;
        try {
            const ok = await saveDetails(card, state);
            if (ok) {
                state.onChange();
                close();
            }
        } finally {
            if (saveBtn.isConnected) ev.currentTarget.disabled = false;
        }
    } }, Icon('Check', { size: 14 }), ' Save changes');

    // Editor-level roles cannot delete; the button is hidden entirely.
    const deleteBtn = canDelete('patients') ? h('button', {
        class: 'btn btn-danger',
        title: 'Delete this visit (and any unbilled services).',
        onclick: async (ev) => {
            ev.currentTarget.disabled = true;
            try {
                const ok = await deleteVisit(state);
                if (ok) {
                    state.onChange();
                    close();
                }
            } finally {
                if (deleteBtn.isConnected) ev.currentTarget.disabled = false;
            }
        },
    }, Icon('Trash', { size: 14 }), ' Delete visit') : null;

    // BTNS_RIGHT_V1 + VISIT_CANCEL_FOOTER_V1 — footer Close removed (the red
    // labeled Close lives top-right); cancelling the visit happens down here,
    // next to Save, with a confirm.
    const cancelVisitBtn = h('button', {
        class: 'btn btn-danger',
        onclick: async (ev) => {
            const st = state.visit?.status || 'scheduled';
            if (!state.visit?.id) { toast('Визит ещё не сохранён.', 'fail'); return; }
            if (['completed', 'cancelled', 'no_show'].includes(st)) { toast('Визит уже закрыт.', 'fail'); return; }
            if (!confirm(tr('Отменить визит?'))) return;
            ev.currentTarget.disabled = true;
            try {
                await setVisitStatus(state, 'cancelled');
                renderHeader(); renderBody();
                toast('Визит отменён');
            } catch (e) { toast(e.message || String(e), 'fail'); }
            finally { if (ev.target.isConnected) ev.target.disabled = false; }
        },
    }, Icon('X', { size: 14 }), ' Cancel visit');
    card.appendChild(h('footer', { class: 'modal-foot' },
        h('span', { class: 'grow' }),
        deleteBtn,
        cancelVisitBtn,
        saveBtn,
    ));

    function renderHeader() {
        clear(headerEl);
        headerEl.append(
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px' } },
                h('h2', null, 'Visit · ', formatDate(state.visit?.visit_date || state.visit?.date)),
                h('div', { class: 'muted', style: { fontSize: '12.5px' } },
                    [state.visit?.__doctor_name, state.visit?.dept].filter(Boolean).join(' · '),
                ),
            ),
            h('span', { class: 'grow' }),
            statusActionsEl(state, () => { renderHeader(); renderBody(); }),
            h('button', { class: 'modal-close', onclick: () => close(), title: 'Close', style: { marginLeft: '8px' } }, '×'),   // CLOSE_RED_V2 — label comes from the global style
        );
    }

    function renderTabs() {
        clear(tabBar);
        const arrived = ['arrived', 'in_progress', 'completed'].includes(state.visit?.status);
        const tabs = [
            { id: 'services', label: 'Services', icon: 'Activity', count: state.services.length },
            { id: 'invoice',  label: 'Invoice',  icon: 'Wallet', locked: !arrived },
            { id: 'details',  label: 'Details',  icon: 'Doc' },
        ];
        for (const t of tabs) {
            tabBar.appendChild(h('button', {
                class: 'tab' + (state.tab === t.id ? ' on' : ''),
                onclick: () => { state.tab = t.id; renderTabs(); renderBody(); },
                title: t.locked ? 'Invoice unlocks once the patient arrives' : '',
                style: t.locked ? { opacity: 0.6 } : {},
            }, Icon(t.icon, { size: 14 }), ' ', t.label,
                t.count != null && h('span', { class: 'tab-count' }, String(t.count)),
                t.locked && h('span', { class: 'muted', style: { marginLeft: '6px', fontSize: '12.5px', textTransform: 'uppercase', letterSpacing: '0.05em' } }, 'locked'),
            ));
        }
    }

    function renderBody() {
        clear(body);
        if (state.tab === 'details')  body.appendChild(detailsForm(state));
        if (state.tab === 'services') body.appendChild(servicesPane(state, () => { Promise.all([loadServices(state), loadRecommendations(state)]).then(() => { renderTabs(); renderBody(); }); }));
        if (state.tab === 'invoice')  body.appendChild(invoicePane(state, () => { Promise.all([loadInvoice(state), loadInvoiceLogs(state)]).then(() => renderBody()); }));
    }

    function close() {
        overlay.remove();
        document.removeEventListener('keydown', onKey);
        active = null;
    }
    function onKey(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey);

    renderHeader();
    renderTabs();
    renderBody();
    document.body.appendChild(overlay);
    active = overlay;

    if (state.visit?.id) {
        loadServices(state).then(() => { renderTabs(); if (state.tab === 'services') renderBody(); });
        Promise.all([loadInvoice(state), loadInvoiceLogs(state)]).then(() => { if (state.tab === 'invoice' || state.tab === 'services') renderBody(); });
        loadRecommendations(state).then(() => { if (state.tab === 'services') renderBody(); });
    }
    // Who registered the patient + any caution note — async, repaints details.
    loadPatientMeta(state).then(() => { if (state.tab === 'details') renderBody(); });
}

// Fetch the patient's registrar (created_by → full_name) and behaviour note so
// the Details pane can show "Registered by …" and a caution banner. Tolerates a
// DB where created_by / behavior_note (migration 025) aren't present yet.
async function loadPatientMeta(state) {
    const pid = state.patient?.id;
    if (!pid) return;
    let { data, error } = await supabase
        .from('patients').select('behavior_note, creator:created_by(full_name)').eq('id', pid).maybeSingle();
    if (error && /behavior_note|created_by|creator/i.test(error.message || '')) {
        // Older schema — skip the unknown columns.
        ({ data, error } = await supabase.from('patients').select('id').eq('id', pid).maybeSingle());
        data = data ? {} : null;
    }
    if (error) { console.warn('[patient meta]', error.message); return; }
    state.patientCreatedByName = data?.creator?.full_name || '';
    state.patientBehaviorNote  = data?.behavior_note || '';
}

export function closeActive() {
    if (active) { active.remove(); active = null; }
}

// ---------------------------------------------------------------------------
// Service + Doctor + When banner — shown at the top of every tab so the
// registrar / call-center agent immediately sees what the appointment is for.
// ---------------------------------------------------------------------------
function visitInfoBanner(state) {
    const v = state.visit || {};
    const p = state.patient || {};

    // Pull data from whichever shape we got. Prefer the explicit objects
    // passed in by the caller (state.doctor / state.service from the picker),
    // fall back to nested joins (v.services / v.users) or flat fields.
    const svc = state.service || v.services || {};
    const doc = state.doctor  || v.users    || {};
    const serviceName     = svc.name || v.__service_name || '—';
    const servicePrice    = svc.price;
    const serviceDuration = svc.duration_minutes || v.duration_minutes || 30;
    const doctorName      = doc.name || doc.full_name || v.__doctor_name || '—';
    const doctorSpec      = doc.specialty || '';
    const patientName     = displayPatientName(v.patients || p);
    const patientMeta     = [v.patients?.mrn || p.mrn, v.patients?.phone || p.phone].filter(Boolean).join(' · ');

    const dt = v.visit_date ? new Date(v.visit_date) : null;
    const timeStr = dt && !isNaN(dt.getTime())
        ? `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`
        : '';
    const dateStr = dt && !isNaN(dt.getTime())
        ? dt.toLocaleDateString(undefined, { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' })
        : '';

    return h('div', {
        style: {
            display: 'grid',
            gridTemplateColumns: '1.4fr 1.2fr 1fr 0.9fr',
            gap: '14px',
            padding: '14px 16px',
            marginBottom: '18px',
            background: 'linear-gradient(135deg, var(--primary-50) 0%, #ffffff 60%, var(--info-50) 100%)',
            border: '1px solid var(--primary-200)',
            borderRadius: '12px',
        },
    },
        bannerCol('Service', Icon('Activity', { size: 16 }),
            serviceName,
            [servicePrice != null ? formatMoney(servicePrice) : null, `${serviceDuration} min`].filter(Boolean).join(' · ')),
        bannerCol('Doctor', Icon('Stethoscope', { size: 16 }),
            doctorName,
            doctorSpec),
        bannerCol('Patient', Icon('User', { size: 16 }),
            patientName,
            patientMeta),
        bannerCol('When', Icon('Calendar', { size: 16 }),
            timeStr || '—',
            dateStr),
    );
}

function bannerCol(label, icon, value, meta) {
    return h('div', { style: { minWidth: 0 } },
        h('div', { class: 'muted', style: { fontSize: '12.5px', textTransform: 'uppercase', letterSpacing: '0.07em', fontWeight: 700, color: 'var(--ink-500)', marginBottom: '6px' } }, label),
        h('div', { class: 'row', style: { gap: '8px', minWidth: 0 } },
            h('span', { style: { color: 'var(--primary-700)', flex: '0 0 auto' } }, icon),
            h('div', { style: { minWidth: 0 } },
                h('div', { style: { fontSize: '13.5px', fontWeight: 600, color: 'var(--ink-900)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, value || '—'),
                meta && h('div', { class: 'muted', style: { fontSize: '12.5px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, meta),
            ),
        ),
    );
}

function displayPatientName(p) {
    if (!p) return '—';
    // Patient objects reach this code from three places that each use a
    // different naming convention: the DB row (snake_case), the patients
    // list view (camelCase via data.js mapping), and the create-visit modal
    // (mixed). Accept both so the invoice header doesn't read "(unnamed)"
    // when a perfectly good name is sitting on the object.
    const last   = p.last_name   ?? p.lastName   ?? '';
    const first  = p.first_name  ?? p.firstName  ?? '';
    const middle = p.middle_name ?? p.middle     ?? '';
    const fromParts = [last, first, middle].filter(Boolean).join(' ').trim();
    return fromParts || p.full_name || p.fullName || p.name || '(unnamed)';
}

function formatMoney(n) {
    const v = Number(n || 0);
    if (!Number.isFinite(v)) return '—';
    return v.toLocaleString(undefined, { maximumFractionDigits: 0 }) + ' UZS';
}

// A visit spans exactly its own calendar day. Services may be attached up to
// 23:59 of that day; once the day is over the visit is "ended" and no further
// services can be added — the patient needs a fresh visit for the new day.
// Returns false when there's no usable date so we never block on bad data.
function isVisitEnded(visit) {
    const raw = visit?.visit_date || visit?.date;
    if (!raw) return false;
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return false;
    const endOfDay = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
    return new Date() > endOfDay;
}

const VISIT_ENDED_MSG = 'This visit has ended — a service can only be added on the visit day (until 23:59). Create a new visit for today instead.';

// ---------------------------------------------------------------------------
// Status pill + quick action buttons
// ---------------------------------------------------------------------------
function statusActionsEl(state, onAfterChange) {
    const status = state.visit?.status || 'scheduled';
    const pill = StatusTag(status);

    const wrap = h('div', { class: 'row', style: { gap: '6px', flexWrap: 'wrap' } }, pill);

    if (!state.visit?.id) return wrap;   // demo / unsaved visit: no actions

    const set = (newStatus, label) => h('button', {
        class: 'btn btn-sm ' + buttonKindForStatus(newStatus),
        onclick: async (ev) => {
            ev.currentTarget.disabled = true;
            try {
                await setVisitStatus(state, newStatus);
                onAfterChange();    // re-render modal header + body with new status
                // Note: setVisitStatus already fires onStatusChange for the
                // calendar block recolor. We deliberately don't call the
                // heavier `state.onChange` here — no need to refetch when only
                // the status changed.
                toast(`Status: ${statusLabel(newStatus)}`);
            } catch (e) {
                toast(e.message || String(e), 'fail');
            } finally { ev.currentTarget.disabled = false; }
        },
    }, label);

    // Registrar / call-center actions only. The clinical transitions
    // (Start consult → in_progress, Complete → completed) belong to the
    // doctor's consultation workspace, so they are intentionally omitted here.
    if (status === 'scheduled') {
        wrap.append(
            set('confirmed', h('span', null, Icon('Check', { size: 12 }), ' Confirm')),
            set('arrived',   h('span', null, Icon('User',  { size: 12 }), ' Arrived')),
        );
    } else if (status === 'confirmed') {
        wrap.append(set('arrived', h('span', null, Icon('User', { size: 12 }), ' Arrived')));
    }

    // VISIT_CANCEL_FOOTER_V1 — the Cancel action moved to the footer (next to
    // Save); the header keeps the status pill + forward transitions only.

    return wrap;
}

function buttonKindForStatus(s) {
    if (s === 'confirmed')   return 'btn-outline';     // call-center action
    if (s === 'arrived')     return 'btn-warning';     // registrar action
    if (s === 'in_progress') return 'btn-primary';
    if (s === 'completed')   return 'btn-success';
    if (s === 'cancelled' || s === 'no_show') return 'btn-danger';
    return 'btn-outline';
}

async function setVisitStatus(state, newStatus) {
    const { error } = await supabase.from('visits').update({ status: newStatus }).eq('id', state.visit.id);
    if (error) {
        // The 'confirmed' status requires migration 008. Give a clearer hint.
        if (newStatus === 'confirmed' && /check constraint/i.test(error.message)) {
            throw new Error('Apply migration 008_visit_statuses.sql in Supabase first — "confirmed" is not in the allowed list yet.');
        }
        throw error;
    }
    state.visit.status = newStatus;
    // Fast in-place block recolor on the calendar — runs synchronously, no
    // network. The block stays put, only the color (and data-status attr)
    // change.
    if (state.onStatusChange) {
        try { state.onStatusChange(newStatus); }
        catch (e) {
            console.error('[visit-modal] onStatusChange failed:', e);
            toast('Calendar refresh failed: ' + (e.message || e), 'fail');
        }
    }
}

// ---------------------------------------------------------------------------
// DETAILS pane — trimmed form (only the essentials from the Russian screenshot)
// ---------------------------------------------------------------------------
function detailsForm(state) {
    const v = state.visit;
    const p = state.patient;
    const ref = referralPickerPair(v);

    return h('div', null,
        state.patientBehaviorNote && h('div', {
            style: {
                margin: '0 0 16px', padding: '10px 14px',
                border: '1px solid #f0d29b', background: 'var(--warn-50)',
                borderRadius: '10px', display: 'flex', gap: '8px', alignItems: 'flex-start',
            },
        },
            h('span', { style: { color: 'var(--warn-700)', flex: '0 0 auto', marginTop: '1px' } }, Icon('Warning', { size: 15 })),
            h('div', null,
                h('div', { style: { fontSize: '12.5px', fontWeight: 700, color: 'var(--warn-700)', textTransform: 'uppercase', letterSpacing: '0.04em' } }, 'Behaviour caution'),
                h('div', { style: { fontSize: '13.5px', color: 'var(--ink-800)', marginTop: '2px' } }, state.patientBehaviorNote),
            ),
        ),
        h('div', { class: 'vd-form', style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px 28px' } },
        labeled('Patient', readOnly(`${p.lastName || p.last_name || ''} ${p.firstName || p.first_name || ''}${p.mrn ? ' · ' + p.mrn : ''}`.trim() || p.full_name || '—')),
        labeled('Registered by', readOnly(state.patientCreatedByName || '—')),
        labeled('Date', dateInput('visit_date', (v.visit_date || v.date || '').slice(0, 10))),

        labeled('Patient type', radioRow('visit_type', [
            ['outpatient', 'Outpatient'],
            ['emergency',  'Emergency'],
            ['inpatient',  'Inpatient'],
        ], v.visit_type || 'outpatient')),

        labeled('Visit type', segmentRow('visit_kind', [
            ['first',     'First visit'],
            ['repeat',    'Repeat'],
            ['follow_up', 'Follow-up'],
            ['secondary', 'Secondary'],
        ], v.visit_kind || 'first')),

        // Cascading referral category → referral source
        labeled('Referral category', ref.categorySelect),
        labeled('Referral source',   ref.sourceSelect),

        labeled('Coverage type', selectRow('coverage_type', [
            ['patient',    'Patient (self-pay)'],
            ['insurance',  'Insurance'],
            ['corporate',  'Corporate'],
            ['state',      'State program'],
        ], v.coverage_type || 'patient')),

        labeled('Discount (%)', h('input', { type: 'number', name: 'discount_percentage', step: '0.01', value: v.discount_percentage ?? '0', class: 'num' })),

        h('div', { style: { gridColumn: '1 / -1' } },
            h('div', { style: { fontSize: '12.5px', color: 'var(--ink-700)', fontWeight: 500, marginBottom: '4px' } }, 'Visit comment'),
            h('textarea', { name: 'notes', rows: '3', style: { width: '100%' } }, v.notes || ''),
        ),
        ),
    );
}

// ---------------------------------------------------------------------------
// Referral picker — category narrows the source list. Only `referral_source_id`
// is persisted on the visit row; category is derived from whichever source is
// chosen, so we don't need a new DB column.
// ---------------------------------------------------------------------------
export function referralPickerPair(v) {
    const categorySelect = h('select', { id: 'vd-ref-cat' }, h('option', { value: '' }, 'Loading…'));
    const sourceSelect   = h('select', { name: 'referral_source_id', id: 'vd-ref-src' }, h('option', { value: '' }, 'Loading…'));

    let categories = [];
    let sources = [];
    let currentCatId = '';

    function paintSources() {
        clear(sourceSelect);
        sourceSelect.appendChild(h('option', { value: '' }, '—'));
        const filterCat = currentCatId;
        for (const s of sources) {
            if (filterCat && s.category_id !== filterCat) continue;
            sourceSelect.appendChild(h('option', { value: s.id, selected: v.referral_source_id === s.id }, s.name || s.id));
        }
    }

    (async () => {
        const [{ data: cats }, { data: srcs }] = await Promise.all([
            supabase.from('referral_source_categories').select('id, name').eq('active', true).order('name'),
            supabase.from('referral_sources').select('id, name, category_id').eq('active', true).order('name'),
        ]);
        categories = cats || [];
        sources    = srcs || [];

        // Derive starting category from the existing source's category_id.
        const initialSource = sources.find(s => s.id === v.referral_source_id);
        currentCatId = initialSource?.category_id || '';

        clear(categorySelect);
        categorySelect.appendChild(h('option', { value: '' }, 'All categories'));
        for (const c of categories) {
            categorySelect.appendChild(h('option', { value: c.id, selected: c.id === currentCatId }, c.name || c.id));
        }
        paintSources();
    })();

    categorySelect.addEventListener('change', () => {
        currentCatId = categorySelect.value;
        // If the previously-selected source isn't in the new category, clear it.
        const stillValid = sources.find(s => s.id === sourceSelect.value && (!currentCatId || s.category_id === currentCatId));
        paintSources();
        if (!stillValid) sourceSelect.value = '';
    });

    return { categorySelect, sourceSelect };
}

// ---------------------------------------------------------------------------
// SERVICES pane — list with selection checkboxes + Generate invoice
// ---------------------------------------------------------------------------
function servicesPane(state, onReload) {
    if (!state.visit?.id) {
        return h('div', { class: 'empty' }, 'Save the visit first to attach services.');
    }
    // PAYER_COVERED_LOCK_V1 — on a payer/insurance visit, services the booking wizard
    // released for the payer (status released, never invoiced) are covered by the Акт
    // and must NOT be billed to the patient. Lock them out of invoice selection.
    // PAYER_COVERED_LOCK_V2 — the explicit payer_covered flag (set by the wizard's «Кто платит» split,
    // now that the column exists + legacy rows are backfilled) is authoritative. The old status heuristic
    // ("any released service on a payer visit is covered") wrongly stranded patient-allocated rows once a
    // provider advanced their status (#8/#16) — dropped.
    const isCovered = (r) => !r.invoice_item_id && !!r.payer_covered;
    // Default: unbilled (and not payer-covered) services are pre-selected for invoicing.
    const unbilled = (state.services || []).filter(r => !r.invoice_item_id && !isCovered(r));
    const validIds = new Set(unbilled.map(r => r.id));

    // Prune stale ids — if the user deleted a service and re-added it (new
    // uuid), the old id would linger in _selectedForInvoice and silently
    // poison the subtotal calculation. Always start fresh if our Set has
    // drifted from the current rows.
    let selected = state._selectedForInvoice;
    if (!selected || [...selected].some(id => !validIds.has(id))) {
        selected = new Set(unbilled.map(r => r.id));
    }
    state._selectedForInvoice = selected;

    // Robust price: prefer the persisted unit_price on visit_services, then
    // the joined service catalogue price, then 0. The row total is derived
    // the same way so the displayed sum and the actual insert payload can't
    // disagree.
    const rowAmount = (r) => {
        const price = Number(r.price ?? r.unit_price ?? r.services?.price ?? 0);
        const qty   = Number(r.qty   ?? r.quantity   ?? 1);
        return price * qty;
    };
    const selectedTotal = (state.services || [])
        .filter(r => selected.has(r.id))
        .reduce((s, r) => s + rowAmount(r), 0);

    return h('div', null,
        // ---- Recommended (pending) services for this patient ----
        // Shown FIRST so the registrar sees what the doctor previously asked
        // for (lab orders, follow-ups, referrals) and can attach them in one
        // click. Removable if the patient declines.
        recommendationsSection(state, onReload),

        h('div', { class: 'row', style: { marginBottom: '12px', gap: '8px' } },
            h('h3', { style: { margin: 0, fontSize: '13.5px', fontWeight: 600, color: 'var(--ink-900)' } },
                'Services in this visit'),
            h('span', { class: 'grow' }),
            h('div', { class: 'num', style: { fontWeight: 700, fontSize: '13.5px', color: 'var(--ink-900)' } },
                selected.size > 0
                    ? `${selected.size} selected · ${selectedTotal.toLocaleString('ru-RU')} UZS`
                    : `Total ${(state.services || []).reduce((s,r) => s + Number(r.price||0)*(r.qty||1), 0).toLocaleString('ru-RU')} UZS`),
            h('button', {
                class: 'btn btn-outline btn-sm',
                title: isVisitEnded(state.visit) ? VISIT_ENDED_MSG : 'Attach a service to this visit',
                onclick: () => {
                    if (isVisitEnded(state.visit)) { toast(VISIT_ENDED_MSG, 'fail'); return; }
                    // ATTACH_CATALOG_V1 — same catalog + смета UI as the booking
                    // wizard (search, group chips, cart) instead of the old
                    // 3-column cascade. No visit is created: the смета CTA hands
                    // each cart row to onPick below, which appends it to THIS visit.
                    const _p = state.patient || {};
                    openServicePickerModal({
                        attachMode:     true,
                        title:          'Добавить услуги к визиту',
                        patient: {
                            id:        state.visit.patient_id || _p.id || null,
                            fullName:  _p.full_name || _p.fullName
                                       || [_p.last_name, _p.first_name].filter(Boolean).join(' ').trim() || '',
                            lastName:  _p.last_name || _p.lastName || '',
                            firstName: _p.first_name || _p.firstName || '',
                            mrn:       _p.mrn || '',
                            phone:     _p.phone || '',
                        },
                        visitDoctorId:  state.visit.doctor_id || state.doctor?.id || null,
                        showSchedule:   true,
                        patientId:      state.visit.patient_id || state.patient?.id || null,
                        initialDateIso: (state.visit?.visit_date || state.visit?.date || '').slice(0, 10) || null,
                        // Already-attached services render disabled in the picker
                        // so the same service can't be added to this visit twice.
                        excludeServiceIds: (state.services || []).map(s => s.service_id).filter(Boolean),
                        onPick: (pick) => addServiceFromPicker(state, pick, onReload),
                        // X on a session row → delete the matching visit_services
                        // row and refresh the list.
                        onUndo: async (pick) => {
                            const { error } = await supabase
                                .from('visit_services')
                                .delete()
                                .eq('visit_id', state.visit.id)
                                .eq('service_id', pick.service.id);
                            if (error) throw error;
                            await onReload();
                            toast(`Removed: ${pick.service.name}`);
                        },
                    });
                },
            }, Icon('Plus', { size: 13 }), ' Add service'),
            // DISPENSE_ITEM_V1 — dispense a clinic product (medication/consumable)
            // consumed during this visit. Calls dispense_visit_item (atomic line
            // insert + stock decrement). Blocked once the visit day has ended.
            h('button', {
                class: 'btn btn-outline btn-sm',
                title: isVisitEnded(state.visit) ? VISIT_ENDED_MSG : 'Dispense a product (decrements stock)',
                onclick: () => {
                    if (isVisitEnded(state.visit)) { toast(VISIT_ENDED_MSG, 'fail'); return; }
                    openDispenseItem(state, onReload);
                },
            }, Icon('Pill', { size: 13 }), ' Dispense item'),
            h('button', {
                class: 'btn btn-primary btn-sm',
                disabled: unbilled.length === 0 || selected.size === 0 ? '' : null,
                title: unbilled.length === 0 ? 'All services are already invoiced' : 'Create an invoice from the selected services',
                onclick: () => generateInvoiceFromSelection(state, selected, onReload),
            }, Icon('Wallet', { size: 13 }), ' Generate invoice'),
        ),
        h('div', { style: { overflowX: 'auto' } },
        h('table', { class: 'tbl' },
            h('thead', null, h('tr', null,
                h('th', { style: { width: '32px' } },
                    h('input', { type: 'checkbox',
                        checked: unbilled.length > 0 && unbilled.every(r => selected.has(r.id)),
                        onclick: (e) => {
                            if (e.target.checked) for (const r of unbilled) selected.add(r.id);
                            else for (const r of unbilled) selected.delete(r.id);
                            onReload();  // re-render
                        },
                    }),
                ),
                h('th', null, 'Service'),
                h('th', null, 'Doctor'),
                h('th', null, 'Service registrar'),
                h('th', null, 'Creation date'),
                h('th', null, 'Done date'),
                h('th', { style: { textAlign: 'right' } }, 'Amount'),
                h('th', null, 'Invoice created'),
                h('th', null, 'Service status'),
                h('th', null, 'Payment status'),
                h('th', { style: { width: '100px', textAlign: 'right' } }, ''),
            )),
            h('tbody', null, ...(state.services || []).map(r => h('tr', null,
                h('td', null,
                    r.invoice_item_id
                        ? h('span', { title: 'Already invoiced', style: { color: 'var(--ink-300)' } }, '—')
                        : isCovered(r)
                        ? h('span', { title: 'Покрывается плательщиком — счёт пациенту не выставляется', style: { color: 'var(--ink-300)' } }, '—')
                        : h('input', { type: 'checkbox',
                            checked: selected.has(r.id),
                            onclick: (e) => {
                                if (e.target.checked) selected.add(r.id);
                                else selected.delete(r.id);
                                onReload();
                            },
                        }),
                ),
                h('td', { class: 'cell-strong' }, r.__service_name || '—'),
                h('td', null, r.__doctor_name || '—'),
                h('td', { class: 'muted', style: { fontSize: '12.5px' } }, r.__created_by_name || '—'),
                h('td', { class: 'muted', style: { fontSize: '12.5px', whiteSpace: 'nowrap' } }, r.created_at ? formatDateTime(r.created_at) : '—'),
                h('td', { class: 'muted', style: { fontSize: '12.5px', whiteSpace: 'nowrap' } }, r.completed_at ? formatDateTime(r.completed_at) : '—'),
                h('td', { class: 'num cell-strong', title: `${r.qty || r.quantity || 1} × ${Number(r.price ?? r.unit_price ?? r.services?.price ?? 0).toLocaleString('ru-RU')} UZS` },
                    rowAmount(r).toLocaleString('ru-RU') + ' UZS'),
                h('td', null,
                    r.invoice_item_id
                        ? h('span', { class: 'cell-mono', style: { fontSize: '12.5px' }, title: 'Invoice generated for this service' },
                            state.invoice?.invoice_number || 'Created')
                        : h('span', { class: 'muted', style: { fontSize: '12.5px' } }, 'Not yet')),
                h('td', null, StatusTag(r.__service_status || 'added')),
                h('td', null,
                    r.invoice_item_id
                        ? StatusTag(state.invoice?.status || 'unpaid')
                        : isCovered(r)
                        ? h('span', { class: 'tag tag-info', style: { fontSize: '12.5px' } }, 'Покрывается плательщиком')
                        : h('span', { class: 'muted', style: { fontSize: '12.5px' } }, '—')),
                h('td', { style: { textAlign: 'right' } },
                    // DISPENSE_ITEM_V1: item lines void via the RPC (writes a
                    // compensating 'return' movement + deletes the line). The RPC
                    // RAISEs if the line is already invoiced.
                    r.__is_item && !r.invoice_item_id && canDelete('patients')
                        ? h('button', {
                            class: 'btn btn-ghost btn-sm',
                            style: { color: 'var(--crit-700)' },
                            title: 'Void this dispensed item (returns stock)',
                            onclick: () => voidDispensedItem(r, state, onReload),
                          }, Icon('Trash', { size: 13 }), ' Void')
                    : !r.invoice_item_id && canDelete('patients')
                        ? h('button', {
                            class: 'btn btn-ghost btn-sm',
                            style: { color: 'var(--crit-700)' },
                            title: 'Remove this service from the visit',
                            onclick: () => removeService(r.id, state, onReload),
                          }, Icon('Trash', { size: 13 }), ' Remove')
                        : !r.invoice_item_id
                        ? null
                        : h('span', { class: 'muted', style: { fontSize: '12.5px' }, title: 'Already invoiced — void the invoice to remove.' }, 'invoiced'),
                ),
            ))),
        ),
        ),
        (!state.services || state.services.length === 0) && h('div', { class: 'empty' },
            'No services attached to this visit yet — click + Add service.'),
    );
}

// ---------------------------------------------------------------------------
// Recommendations section — pending recommended_services for this patient.
// Renders at the top of the Services tab. Each row has Add (to visit) and
// Remove (mark cancelled) actions.
// ---------------------------------------------------------------------------
function recommendationsSection(state, onReload) {
    const recs = state.recommendations || [];
    if (recs.length === 0) return h('span');     // empty placeholder

    return h('div', {
        style: {
            marginBottom: '18px',
            border: '1px solid var(--info-200, #c7dcfd)',
            borderRadius: '10px',
            overflow: 'hidden',
        },
    },
        h('div', {
            style: {
                padding: '10px 14px',
                background: 'var(--info-50)',
                borderBottom: '1px solid var(--info-200, #c7dcfd)',
                display: 'flex', alignItems: 'center', gap: '8px',
            },
        },
            h('span', { style: { color: 'var(--info-700)' } }, Icon('Heart', { size: 14 })),
            h('div', { style: { fontSize: '13.5px', fontWeight: 600, color: 'var(--info-700)' } },
                `Recommended for this patient · ${recs.length}`),
            h('span', { class: 'grow' }),
            h('div', { class: 'muted', style: { fontSize: '12.5px' } },
                'From previous consultations — add what the patient wants done today.'),
        ),
        h('div', null, ...recs.map(rec => recommendationRow(rec, state, onReload))),
    );
}

function recommendationRow(rec, state, onReload) {
    const price = rec.__service_price;
    return h('div', {
        style: {
            display: 'grid', gridTemplateColumns: '1fr auto auto auto',
            alignItems: 'center', gap: '12px',
            padding: '10px 14px',
            borderBottom: '1px solid var(--info-100, #dbeafe)',
            background: 'white',
        },
    },
        h('div', { style: { minWidth: 0 } },
            h('div', { class: 'cell-strong', style: { fontSize: '13.5px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } },
                rec.__service_name),
            h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '2px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } },
                'Recommended by ',
                h('b', { style: { color: 'var(--info-700)' } }, rec.__doctor_name),
                rec.__doctor_spec ? ` (${rec.__doctor_spec})` : '',
                ' · ',
                new Date(rec.created_at).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' }),
            ),
        ),
        price != null
            ? h('div', { class: 'num', style: { fontWeight: 600, color: 'var(--ink-900)' } },
                Number(price).toLocaleString('ru-RU') + ' UZS')
            : h('span', { class: 'muted', style: { fontSize: '12.5px' } }, 'price not set'),
        h('button', {
            class: 'btn btn-primary btn-sm',
            onclick: () => openAttachRecommendationModal(state, rec, onReload),
            title: 'Review the recommendation and pick the performing doctor',
        }, Icon('Plus', { size: 12 }), ' Add to visit'),
        canDelete('patients') && h('button', {
            class: 'btn btn-ghost btn-sm',
            style: { color: 'var(--crit-700)' },
            onclick: () => removeRecommendation(state, rec, onReload),
            title: 'Remove from recommendations (patient declined)',
        }, Icon('Trash', { size: 12 })),
    );
}

// Open a review popup before attaching the recommendation. Shows the
// recommendation context (who recommended it, when, original notes, price)
// and lets the registrar pick the performing doctor — defaults to the doctor
// who recommended it.
function openAttachRecommendationModal(state, rec, onReload) {
    if (isVisitEnded(state.visit)) { toast(VISIT_ENDED_MSG, 'fail'); return; }
    if (!rec.service_id) {
        toast('Recommendation has no linked service — cannot attach.', 'fail');
        return;
    }
    // Duplicate guard up-front so the user doesn't waste time in the modal.
    if ((state.services || []).some(s => s.service_id === rec.service_id)) {
        toast(`"${rec.__service_name}" is already in this visit.`, 'fail');
        return;
    }

    const overlay = h('div', { class: 'modal', style: { zIndex: '140' } });
    const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));

    const doctorSelect = h('select', null, h('option', { value: '' }, 'Loading doctors…'));
    // Populate the doctor dropdown async. Falls back to "no doctor" when the
    // users table is empty / unreachable. Preselects the original recommender.
    (async () => {
        const { data, error } = await supabase.from('users')
            .select('id, full_name, specialty, role, is_doctor')
            .eq('active', true)
            .order('full_name');
        if (error) { console.warn('[attach-rec] doctor load failed:', error.message); }
        const all = data || [];
        const list = all.filter(u =>
            u.is_doctor === true || (u.role || '').toLowerCase() === 'doctor' || (u.specialty || '').length > 0   // ADMIN_DOCTOR_LIST_V1
        );
        const final = list.length ? list : all;
        clear(doctorSelect);
        doctorSelect.appendChild(h('option', { value: '' }, '— No doctor —'));
        for (const d of final) {
            doctorSelect.appendChild(h('option', {
                value: d.id,
                selected: d.id === rec.recommended_by ? true : null,
            }, d.full_name + (d.specialty ? ' · ' + d.specialty : '')));
        }
        if (rec.recommended_by) doctorSelect.value = rec.recommended_by;
    })();

    const price = rec.__service_price;
    const created = rec.created_at ? new Date(rec.created_at) : null;
    const createdLabel = created && !isNaN(created.getTime())
        ? created.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' })
        : '—';

    const card = h('div', { class: 'modal-card', style: { width: '500px' } },
        h('header', { class: 'modal-head' },
            h('h2', null, Icon('Plus', { size: 16 }), ' Add recommendation to visit'),
            h('button', { class: 'modal-close', onclick: close }, '×'),
        ),
        h('div', { class: 'modal-body' },
            h('div', {
                style: {
                    padding: '12px 14px',
                    background: 'var(--info-50)',
                    border: '1px solid var(--info-200, #c7dcfd)',
                    borderRadius: '10px',
                    marginBottom: '16px',
                },
            },
                h('div', { class: 'cell-strong', style: { fontSize: '15px', color: 'var(--ink-900)', marginBottom: '6px' } },
                    rec.__service_name || '—'),
                h('div', { class: 'muted', style: { fontSize: '12.5px', marginBottom: price != null ? '6px' : '0' } },
                    'Recommended by ',
                    h('b', { style: { color: 'var(--info-700)' } }, rec.__doctor_name),
                    rec.__doctor_spec ? ` (${rec.__doctor_spec})` : '',
                    ' · ', createdLabel),
                price != null && h('div', { class: 'num', style: { fontSize: '13.5px', fontWeight: 600, color: 'var(--ink-800)' } },
                    Number(price).toLocaleString('ru-RU') + ' UZS'),
                rec.notes && h('div', {
                    style: {
                        fontSize: '12.5px', color: 'var(--ink-700)',
                        marginTop: '10px', padding: '8px 10px',
                        background: 'white', border: '1px solid var(--ink-100)',
                        borderRadius: '6px', whiteSpace: 'pre-wrap',
                    },
                }, rec.notes),
            ),
            h('div', { class: 'field' },
                h('label', null, 'Assigned doctor (editable)'),
                doctorSelect,
                h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '4px' } },
                    'Defaults to the doctor who recommended it — change if someone else will perform it.'),
            ),
        ),
        h('footer', { class: 'modal-foot' },
            h('button', { class: 'btn', onclick: close }, 'Cancel'),
            h('button', { class: 'btn btn-primary', onclick: async (ev) => {
                ev.currentTarget.disabled = true;
                try {
                    const chosenDoctorId = doctorSelect.value || null;
                    await attachRecommendation(state, rec, chosenDoctorId, onReload);
                    close();
                } finally {
                    if (ev.currentTarget?.isConnected) ev.currentTarget.disabled = false;
                }
            } }, Icon('Check', { size: 14 }), ' Add to visit'),
        ),
    );
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKey);
}

// Convert recommendation → visit_service for the current visit, then mark
// the recommendation as 'done' so it stops appearing.
async function attachRecommendation(state, rec, chosenDoctorId, onReload) {
    if (isVisitEnded(state.visit)) { toast(VISIT_ENDED_MSG, 'fail'); return; }
    if (!rec.service_id) {
        toast('Recommendation has no linked service — cannot attach.', 'fail');
        return;
    }
    // Defensive duplicate check (the popup also guards before opening).
    if ((state.services || []).some(s => s.service_id === rec.service_id)) {
        toast(`"${rec.__service_name}" is already in this visit.`, 'fail');
        return;
    }
    const price = Number(rec.__service_price || 0);
    const { error: insErr } = await insertVisitServiceRow({
        visit_id:   state.visit.id,
        service_id: rec.service_id,
        doctor_id:  chosenDoctorId || rec.recommended_by || null,
        quantity:   1,
        unit_price: price,
        total:      price,
    });
    if (insErr) { toast('Could not attach: ' + insErr.message, 'fail'); return; }
    await activateVisitIfPending(state);

    const { error: upErr } = await supabase.from('recommended_services')
        .update({ status: 'done', closed_at: new Date().toISOString() })
        .eq('id', rec.id);
    if (upErr) console.warn('[recommendation status]', upErr.message);

    toast('Added to visit.');
    onReload();
}

async function removeRecommendation(state, rec, onReload) {
    if (!confirm(`Remove "${rec.__service_name}" from recommendations?`)) return;
    const { error } = await supabase.from('recommended_services')
        .update({ status: 'cancelled', closed_at: new Date().toISOString() })
        .eq('id', rec.id);
    if (error) { toast(error.message, 'fail'); return; }
    toast('Recommendation removed.');
    onReload();
}

// If the visit is still in a pre-arrival state (scheduled / confirmed),
// attaching a service is the natural signal that the patient is now
// actively being worked up — promote it to 'arrived' so the modal header,
// the calendar block colour, and any downstream queries reflect that the
// visit is active. Already-arrived / in-progress / completed visits are
// left alone — we never move backwards.
async function activateVisitIfPending(state) {
    const v = state.visit;
    if (!v?.id) return;
    if (!['scheduled', 'confirmed'].includes(v.status)) return;
    const { error } = await supabase.from('visits').update({ status: 'arrived' }).eq('id', v.id);
    if (error) { console.warn('[visit auto-arrive]', error.message); return; }
    const prev = v.status;
    v.status = 'arrived';
    await logPatientActivity({
        patientId:   v.patient_id || state.patient?.id,
        visitId:     v.id,
        entityType:  'visit',
        entityId:    v.id,
        action:      'status_change',
        summary:     `Visit moved to Arrived (was ${prev || 'scheduled'}) — service added`,
        detail:      { from: prev, to: 'arrived', trigger: 'service_attached' },
    });
    // Nudge the parent (calendar block colour, badges) without forcing a
    // full reload — onStatusChange is the fast in-place repaint hook.
    if (typeof state.onStatusChange === 'function') {
        try { state.onStatusChange('arrived'); } catch (e) { console.warn('[onStatusChange]', e); }
    }
}

// DISPENSE_ITEM_V1 ----------------------------------------------------------
// Open the item picker and, on confirm, call dispense_visit_item — the
// SECURITY DEFINER RPC that atomically inserts a visit_services item line
// (clinic_item_id set, service_id null) and writes a negative 'issue' stock
// movement. The RPC validates the caller's clinic+branch and RAISEs a
// human-readable message on any error; we surface it via the picker's toast.
function openDispenseItem(state, onReload) {
    openItemPickerModal({
        title:        'Dispense item to visit',
        confirmLabel: 'Dispense',
        // DISPENSE_MULTI_V1 — dispense each cart line with its own atomic RPC.
        onConfirm: async (lines) => {
            let ok = 0; const fails = [];
            for (const { item, qty } of lines) {
                try {
                    const { data, error } = await supabase.rpc('dispense_visit_item', {
                        p_visit_id: state.visit.id,
                        p_item_id:  item.id,
                        p_qty:      Number(qty),
                        p_doctor_id: state.visit.doctor_id || state.doctor?.id || null,
                    });
                    if (error) throw error;
                    const res = Array.isArray(data) ? data[0] : data;
                    const name = res?.item_name || item.name;
                    ok++;
                    if (res && Number(res.on_hand) <= 0) {
                        toast(`Warning: ${name} stock is now ${Number(res.on_hand).toLocaleString('ru-RU')} (low/negative).`, 'fail');
                    }
                } catch (err) { fails.push(`${item.name}: ${err?.message || err}`); }
            }
            if (ok === 0) throw new Error(fails[0] || 'Dispense failed');
            await activateVisitIfPending(state);
            await onReload();
            toast(`Dispensed: ${ok}` + (fails.length ? ` · failed: ${fails.length}` : ''));
            if (fails.length) toast(fails.join('; '), 'fail');
        },
    });
}

// Void a dispensed item line — returns stock and deletes the line via
// void_dispensed_visit_item. RAISEs if the line is already invoiced.
async function voidDispensedItem(row, state, onReload) {
    if (!confirm(`Void "${row.__service_name}"? This returns the stock.`)) return;
    try {
        const { error } = await supabase.rpc('void_dispensed_visit_item', { p_line: row.id });
        if (error) throw error;
        toast('Item voided — stock returned.');
        await onReload();
    } catch (err) {
        toast(err?.message || String(err), 'fail');
    }
}

async function addServiceFromPicker(state, pick, onReload) {
    const { service, doctor, startISO } = pick || {};
    // The visit day is over — refuse even if the picker was opened earlier.
    if (isVisitEnded(state.visit)) { toast(VISIT_ENDED_MSG, 'fail'); return; }
    // Reject duplicates — the same service can't be attached to the same
    // visit twice. The picker may close before this check; we surface the
    // reason with a toast.
    if ((state.services || []).some(s => s.service_id === service.id)) {
        toast(`"${service.name}" is already in this visit.`, 'fail');
        return;
    }
    const price = Number(service.price || 0);
    const { error } = await insertVisitServiceRow({
        visit_id:     state.visit.id,
        service_id:   service.id,
        doctor_id:    doctor?.id || null,
        quantity:     1,
        unit_price:   price,
        total:        price,
        scheduled_at: startISO || null,
    });
    if (error) { toast(error.message, 'fail'); return; }
    await activateVisitIfPending(state);
    await logPatientActivity({
        patientId:   state.visit?.patient_id || state.patient?.id,
        visitId:     state.visit?.id,
        entityType:  'service',
        entityId:    service.id,
        entityLabel: service.name,
        action:      'created',
        summary:     `Added "${service.name}"${doctor ? ` — ${doctor.full_name || doctor.name}` : ''}${startISO ? ` · ${formatDateTime(startISO)}` : ''}`,
        detail:      { price, doctor_id: doctor?.id || null, scheduled_at: startISO || null },
    });
    toast(`Added: ${service.name}`);
    onReload();
}

async function generateInvoiceFromSelection(state, selectedIds, onReload) {
    if (selectedIds.size === 0) { toast('Tick at least one service.', 'fail'); return; }
    // PAYER_COVERED_LOCK_V2 — never invoice payer-covered services; they belong to the insurer's Акт,
    // not the patient's cashier invoice. Trust the explicit payer_covered flag (set by the wizard's
    // «Кто платит» split); dropped the old status heuristic that mis-flagged released patient services (#8/#16).
    const lineItems = (state.services || []).filter(r => selectedIds.has(r.id) && !r.invoice_item_id
        && !r.payer_covered);
    if (lineItems.length === 0) { toast('All selected services are already invoiced.', 'fail'); return; }

    // Defensive price calculation — try unit_price first, then catalog price,
    // then 0. Mirrors how the row total is rendered so the on-screen number
    // and the persisted subtotal always agree.
    const priceOf = (r) => Number(r.price ?? r.unit_price ?? r.services?.price ?? 0);
    const qtyOf   = (r) => Number(r.qty   ?? r.quantity   ?? 1);

    const subtotal = lineItems.reduce((s, r) => s + priceOf(r) * qtyOf(r), 0);

    if (!state.visit?.id) {
        toast('No visit attached — cannot create an invoice.', 'fail');
        return;
    }
    if (!state.visit?.patient_id && !state.patient?.id) {
        toast('Visit has no patient linked — cannot create an invoice.', 'fail');
        console.error('[generateInvoice] missing patient_id on visit:', state.visit);
        return;
    }

    const insertPayload = {
        visit_id:        state.visit.id,
        patient_id:      state.visit.patient_id || state.patient.id,
        coverage_type:   state.visit.coverage_type || 'patient',
        // BOOK_WIZARD_V1 — stamp the visit's payer onto the invoice (was never
        // written, leaving the insurance tab's per-policy «used» permanently 0).
        payer_id:        state.visit.payer_id || null,
        payer_policy_id: state.visit.payer_policy_id || null,
        subtotal,
        total_amount:    subtotal,
        paid_amount:     0,
        status:          'unpaid',
        created_by:      currentUser()?.id || null,
    };
    console.debug('[generateInvoice] inserting:', insertPayload, 'from', lineItems.length, 'line items');

    // 1. Create the invoice row (status defaults to 'unpaid' per migration 004).
    const { data: inv, error: invErr } = await supabase.from('invoices').insert(insertPayload).select().single();
    if (invErr) {
        console.error('[generateInvoice] insert failed:', invErr);
        toast('Invoice create failed: ' + invErr.message, 'fail');
        return;
    }
    console.debug('[generateInvoice] created invoice', inv.invoice_number || inv.id, 'subtotal=', subtotal);

    // 2. Insert invoice_items + link them back into visit_services.invoice_item_id.
    let itemsCreated = 0;
    for (const r of lineItems) {
        const unit = priceOf(r);
        const qty  = qtyOf(r);
        const total = unit * qty;
        // DISPENSE_ITEM_V1: an item line (clinic_item_id set, service_id null)
        // invoices with item_id + the product name, mirroring how service lines
        // set service_id + the service name. So item charges stay traceable.
        const isItem = !!r.clinic_item_id;
        const { data: item, error: itemErr } = await supabase.from('invoice_items').insert({
            invoice_id:  inv.id,
            service_id:  isItem ? null : r.service_id,
            item_id:     isItem ? r.clinic_item_id : null,
            description: r.__service_name || (isItem ? 'Item' : 'Service'),
            quantity:    qty,
            unit_price:  unit,
            total,
        }).select().single();
        if (itemErr) { console.warn('[invoice_items]', itemErr); continue; }
        await supabase.from('visit_services').update({ invoice_item_id: item.id }).eq('id', r.id);
        itemsCreated++;
    }
    console.debug('[generateInvoice]', itemsCreated, 'of', lineItems.length, 'line items linked');
    await logInvoiceAction(state, inv, {
        action: 'created',
        fromStatus: null,
        toStatus:   'unpaid',
        amount:     subtotal,
        notes:      `${lineItems.length} line item${lineItems.length === 1 ? '' : 's'}`,
    });
    await logPatientActivity({
        patientId:   state.visit?.patient_id || state.patient?.id,
        visitId:     state.visit?.id,
        entityType:  'invoice',
        entityId:    inv.id,
        entityLabel: inv.invoice_number || inv.id.slice(0, 8),
        action:      'created',
        summary:     `Invoice for ${subtotal.toLocaleString('ru-RU')} UZS · ${lineItems.length} service${lineItems.length === 1 ? '' : 's'}`,
    });
    toast(`Invoice ${inv.invoice_number || inv.id.slice(0, 8)} created — sent to cashier.`);
    state._selectedForInvoice = new Set();
    // Tell the parent (calendar, patient card) to refresh so the visit
    // status / billed indicator updates immediately.
    state.onChange?.();
    // Pop up a print-ready invoice for the patient. The DB rows above are
    // already saved — this just renders a printable copy in a new window
    // (or an inline preview if pop-ups are blocked).
    openInvoicePrintWindow(state, inv, lineItems);
    // Close the visit modal — the registrar's work here is done. The
    // invoice now lives on the Cashier screen; keeping the modal open
    // forced the user to manually close it every time and obscured the
    // print window underneath.
    closeActive();
}

// ---------------------------------------------------------------------------
// Printable invoice — opens a new window with a formatted invoice sheet and
// auto-triggers the browser print dialog. Used right after invoice creation
// and from the "Print receipt" button in the Invoice pane.
// ---------------------------------------------------------------------------
function openInvoicePrintWindow(state, inv, lineItems) {
    if (!inv) { toast('No invoice to print yet.', 'fail'); return; }
    const v = state.visit || {};
    const p = state.patient || v.patients || {};
    const patientName = displayPatientName(v.patients || p);
    const patientMRN = p.mrn || v.patients?.mrn || '';
    const patientPhone = p.phone || v.patients?.phone || '';

    // Prefer the explicit line items handed in by the caller (right after
    // generation we have them in memory). Otherwise fall back to the billed
    // visit_services rows already loaded into state.
    const items = (lineItems && lineItems.length)
        ? lineItems
        : (state.services || []).filter(r => r.invoice_item_id);

    // Build the structured line items the documented invoice template
    // (doc-settings.js → invoiceBody) expects. Doctor name is folded into the
    // service label so we keep that info without breaking the branded grid.
    const lineRows = items.map((r, i) => {
        const qty    = Number(r.qty   || r.quantity   || 1);
        const price  = Number(r.price || r.unit_price || 0);
        const svc    = r.__service_name || r.description || '—';
        const doctor = r.__doctor_name ? ` · ${r.__doctor_name}` : '';
        return { name: svc + doctor, qty, price, _alt: i % 2 === 1 };
    });

    const subtotal = Number(inv.subtotal      || 0) || Number(inv.total_amount || 0);
    const total    = Number(inv.total_amount  || 0);
    const paid     = Number(inv.paid_amount   || 0);
    const invoiceNo = inv.invoice_number || (inv.id ? inv.id.slice(0, 8) : '');
    const statusLabel = (inv.status || 'unpaid').toUpperCase();

    // Hand structured `data` (NOT raw bodyHtml) so the print routes through
    // the branded, fully-styled invoice template configured in Documents —
    // single source of truth for everything we hand the patient.
    const data = {
        title:     'Outpatient services',
        docNo:     invoiceNo,
        issueDate: `Issued ${formatDate(v.visit_date || v.date) || new Date().toLocaleDateString()}`,
        status:    statusLabel,
        patient: [
            ['Full name', patientName || '—'],
            ['MRN',       patientMRN  || '—'],
            ['Phone',     patientPhone || '—'],
            ['Visit date', formatDate(v.visit_date || v.date) || '—'],
        ],
        billing: [
            ['Issue date', new Date().toLocaleDateString()],
            ['Due',        paid >= total && total > 0 ? 'Paid' : 'On receipt'],
            ['Payer',      'Self-pay'],
        ],
        items:    lineRows,
        subtotal, total, paid,
    };

    return printableSheet({ type: 'invoice', idLine: invoiceNo, data });
}

// In-page iframe with a print button — used when the browser blocks
// window.open(). Layered above the visit modal so the user can review the
// invoice and print it without losing context.
function openInlinePrintPreview(html) {
    const overlay = h('div', { class: 'modal', style: { zIndex: '160' } });
    const close = () => overlay.remove();
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));

    const iframe = h('iframe', {
        style: { width: '100%', height: 'calc(80vh - 60px)', border: '1px solid var(--ink-100)', borderRadius: '8px', background: 'white' },
    });

    overlay.appendChild(h('div', { class: 'modal-card', style: { width: '900px', maxWidth: 'calc(100vw - 32px)', height: '85vh', display: 'flex', flexDirection: 'column' } },
        h('header', { class: 'modal-head' },
            h('h2', null, Icon('Print', { size: 16 }), ' Invoice preview'),
            h('button', { class: 'modal-close', onclick: close }, '×'),
        ),
        h('div', { class: 'modal-body', style: { flex: 1, overflow: 'hidden' } }, iframe),
        h('footer', { class: 'modal-foot' },
            h('span', { class: 'grow' }),   // BTNS_RIGHT_V1
            h('button', { class: 'btn', onclick: close }, 'Close'),
            h('button', { class: 'btn btn-primary', onclick: () => {
                try {
                    iframe.contentWindow.focus();
                    iframe.contentWindow.print();
                } catch (e) { console.warn('[print] iframe print failed:', e); }
            } }, Icon('Print', { size: 14 }), ' Print'),
        ),
    ));

    document.body.appendChild(overlay);

    // Write the document AFTER the iframe is attached so contentDocument
    // exists. Strip the auto-print <script> from the HTML since we drive
    // printing manually via the button in the modal footer.
    const cleaned = html.replace(/<script>[\s\S]*?<\/script>/g, '');
    const doc = iframe.contentDocument || iframe.contentWindow?.document;
    if (doc) {
        doc.open();
        doc.write(cleaned);
        doc.close();
    }
}


// ---------------------------------------------------------------------------
// INVOICE pane — gated on patient having arrived. Once an invoice exists,
// Paid / Partial / Debt buttons drive the cashier workflow.
// ---------------------------------------------------------------------------
function invoicePane(state, onReload) {
    const inv = state.invoice;
    const status = state.visit?.status || 'scheduled';
    const arrivedOrLater = ['arrived', 'in_progress', 'completed'].includes(status);

    if (!arrivedOrLater) {
        return h('div', { style: { textAlign: 'center', padding: '40px 20px' } },
            h('div', {
                style: { width: '52px', height: '52px', borderRadius: '14px', background: 'var(--warn-50)', color: 'var(--warn-700)',
                         display: 'grid', placeItems: 'center', margin: '0 auto 12px' },
            }, h('span', { html: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>' })),
            h('h3', { style: { margin: '0 0 6px', fontSize: '15px', fontWeight: 600, color: 'var(--ink-900)' } },
                'Invoice locked until the patient arrives'),
            h('p', { class: 'muted', style: { margin: 0, fontSize: '13.5px', maxWidth: '420px', marginLeft: 'auto', marginRight: 'auto' } },
                'Current status: ', h('b', { style: { color: 'var(--ink-700)' } }, statusLabel(status)),
                '. Use the ', h('b', null, 'Arrived'), ' button in the header once the patient checks in at reception.'),
        );
    }

    if (!inv) {
        return h('div', null,
            h('div', { class: 'empty', style: { padding: '40px 20px' } },
                h('p', null, 'No invoice yet for this visit.'),
                h('p', { class: 'muted', style: { fontSize: '12.5px', maxWidth: '420px', margin: '8px auto 0' } },
                    'Open the ', h('b', null, 'Services'), ' tab, tick the services to charge for, then click ',
                    h('b', null, '+ Generate invoice'), '. The invoice will appear here and on the cashier screen.'),
            ),
            invoiceLogCard(state),
        );
    }

    const total = Number(inv.total_amount || 0);
    const paid  = Number(inv.paid_amount  || 0);
    const owed  = Math.max(total - paid, 0);
    const cancellable = !['void', 'refunded'].includes(inv.status);

    return h('div', null,
        // Summary card
        h('div', { class: 'card', style: { padding: '16px 18px', marginBottom: '16px' } },
            h('div', { class: 'row', style: { gap: '24px', flexWrap: 'wrap' } },
                kv('Invoice #', h('span', { class: 'cell-mono cell-strong', style: { fontSize: '13.5px' } }, inv.invoice_number || inv.id.slice(0, 8))),
                kv('Total', h('span', { class: 'num cell-strong', style: { fontSize: '15px' } }, total.toLocaleString('ru-RU') + ' UZS')),
                kv('Paid',  h('span', { class: 'num', style: { fontSize: '13.5px', color: 'var(--ok-700)' } }, paid.toLocaleString('ru-RU') + ' UZS')),
                kv('Debt',  h('span', { class: 'num cell-strong', style: { fontSize: '13.5px', color: owed > 0 ? 'var(--crit-700)' : 'var(--ink-500)' } }, owed.toLocaleString('ru-RU') + ' UZS')),
                kv('Status', StatusTag(inv.status || 'unpaid')),
                kv('Created', formatDate(inv.created_at)),
            ),
        ),

        // Action area
        inv.status === 'paid'
            ? h('div', { class: 'row', style: { gap: '8px', padding: '12px 14px', background: 'var(--ok-50)', borderRadius: '10px', color: 'var(--ok-700)', fontWeight: 600 } },
                Icon('Check', { size: 16 }), ' Fully paid on ', formatDate(inv.paid_at))
            : inv.status === 'void' || inv.status === 'refunded'
            ? h('div', { class: 'row', style: { padding: '12px 14px', background: 'var(--ink-25)', borderRadius: '10px', color: 'var(--ink-600)' } },
                'Invoice ', inv.status, '. ', cancelledMetaText(state))
            : paymentControls(state, inv, onReload),

        h('div', { class: 'row', style: { gap: '8px', marginTop: '14px', flexWrap: 'wrap' } },
            h('button', {
                class: 'btn btn-outline btn-sm',
                onclick: () => openInvoicePrintWindow(state, inv, null),
            }, Icon('Print', { size: 13 }), ' Print receipt'),
            cancellable && h('button', {
                class: 'btn btn-outline btn-sm',
                style: { color: 'var(--crit-700)', borderColor: 'var(--crit-200, #fecaca)' },
                title: paid > 0 ? 'Cancel invoice and refund the paid amount' : 'Cancel this unpaid invoice',
                onclick: () => openCancelInvoiceDialog(inv, { onDone: onReload }),
            }, Icon('X', { size: 13 }), ' ', paid > 0 ? 'Cancel & refund' : 'Cancel invoice'),
        ),

        // Per-visit invoice activity log — always rendered, even when empty
        // so the user knows the section exists for future actions.
        invoiceLogCard(state),
    );
}

// Pulls the most recent void/refund row from the log so a cancelled invoice
// shows "by Name · reason" inline rather than just "Invoice void.".
function cancelledMetaText(state) {
    const lastCancel = (state.invoiceLogs || []).find(l => l.action === 'void' || l.action === 'refunded');
    if (!lastCancel) return '';
    const who = lastCancel.actor_name || 'unknown';
    const when = formatDate(lastCancel.created_at);
    const reason = lastCancel.reason ? ' · ' + lastCancel.reason : '';
    return `by ${who} · ${when}${reason}`;
}

// PAYMENT_METHOD_QUICKPAY - method picker shared by the quick-pay panel + partial dialog.
// Mirrors the Kassa methods; the chosen value is written to payments.method (was hardcoded 'cash').
function paymentMethodSelect(pm) {
    const METHODS = [['cash', 'Cash'], ['card', 'Card'], ['online', 'Online / acquiring'], ['insurance', 'Insurance'], ['transfer', 'Bank transfer']];
    return h('select', {
        class: 'input',
        style: { height: '34px', padding: '0 10px', border: '1px solid var(--ink-200)', borderRadius: '8px', fontSize: '13.5px', background: '#fff' },
        onchange: (e) => { pm.method = e.target.value; },
    }, ...METHODS.map(([v, l]) => h('option', { value: v }, l)));
}

function paymentControls(state, inv, onReload) {
    const total = Number(inv.total_amount || 0);
    const paid  = Number(inv.paid_amount  || 0);
    const owed  = Math.max(total - paid, 0);
    const pm    = { method: 'cash' };   // PAYMENT_METHOD_QUICKPAY

    return h('div', { style: { padding: '14px 16px', background: 'var(--ink-25)', borderRadius: '10px', border: '1px solid var(--ink-100)' } },
        h('div', { style: { fontSize: '12.5px', color: 'var(--ink-600)', marginBottom: '10px' } },
            'Outstanding: ', h('b', { class: 'num', style: { color: 'var(--crit-700)' } }, owed.toLocaleString('ru-RU') + ' UZS')),
        h('div', { class: 'row', style: { gap: '8px', alignItems: 'center', marginBottom: '10px' } },
            h('label', { style: { fontSize: '12.5px', color: 'var(--ink-600)' } }, 'Payment method'),
            paymentMethodSelect(pm)),
        h('div', { class: 'row', style: { gap: '8px', flexWrap: 'wrap' } },
            h('button', {
                class: 'btn btn-success', onclick: () => takePayment(state, inv, owed, 'paid', onReload, pm.method),
            }, Icon('Check', { size: 14 }), ' Mark paid (full)'),
            h('button', {
                class: 'btn btn-outline', onclick: () => openPartialPaymentDialog(state, inv, onReload),
            }, Icon('Wallet', { size: 14 }), ' Partial payment…'),
            h('button', {
                class: 'btn btn-warning', onclick: () => markAsDebt(state, inv, onReload),
            }, Icon('Warning', { size: 14 }), ' Mark as debt'),
        ),
    );
}

// Full or partial payment: insert payments row, recompute paid_amount + status.
async function takePayment(state, inv, amount, finalStatus, onReload, method = 'cash') {
    if (!amount || amount <= 0) { toast('Amount must be > 0.', 'fail'); return; }
    const { error: payErr } = await supabase.from('payments').insert({
        invoice_id: inv.id,
        amount,
        method,
        cashier_id: (typeof window !== 'undefined' && window.easymed?.state?.user?.id) || null,   // SHIFT_CASHIER_ID_V1 — so the payment lands in the cashier's shift stats
    });
    if (payErr) { toast('Payment insert failed: ' + payErr.message, 'fail'); return; }
    const newPaid = Math.min(Number(inv.paid_amount || 0) + amount, Number(inv.total_amount || 0));
    const total   = Number(inv.total_amount || 0);
    const status  = newPaid >= total ? 'paid' : finalStatus || (newPaid > 0 ? 'partial' : 'unpaid');
    const update  = { paid_amount: newPaid, status };
    if (status === 'paid') update.paid_at = new Date().toISOString();
    const { error: updErr } = await supabase.from('invoices').update(update).eq('id', inv.id);
    if (updErr) { toast('Invoice update failed: ' + updErr.message, 'fail'); return; }
    await releaseServicesForInvoice(inv.id);
    await logInvoiceAction(state, inv, {
        action: status === 'paid' ? 'paid' : 'partial',
        fromStatus: inv.status,
        toStatus:   status,
        amount,
    });
    await logPatientActivity({
        patientId:   inv.patient_id || state.visit?.patient_id || state.patient?.id,
        visitId:     state.visit?.id,
        entityType:  'invoice',
        entityId:    inv.id,
        entityLabel: inv.invoice_number || inv.id.slice(0, 8),
        action:      status === 'paid' ? 'paid' : 'partial',
        summary:     `${status === 'paid' ? 'Paid in full' : 'Partial payment'} — ${amount.toLocaleString('ru-RU')} UZS`,
    });
    toast(`Payment recorded: ${amount.toLocaleString('ru-RU')} UZS.`);
    if (status === 'paid' && inv.status !== 'paid') {
        const cb = await creditCashbackOnPaid(inv.id);
        if (cb) toast(`Cashback ${cb.toLocaleString('ru-RU')} UZS credited to the patient.`);
    }
    onReload();
}

// "Mark as debt" — invoice stays open at its current paid_amount; status becomes
// 'partial' if anything's paid, else 'unpaid'. This makes the outstanding sum a
// debt against the patient until they come back to pay.
async function markAsDebt(state, inv, onReload) {
    const paid = Number(inv.paid_amount || 0);
    const status = paid > 0 ? 'partial' : 'unpaid';
    const { error } = await supabase.from('invoices').update({ status }).eq('id', inv.id);
    if (error) { toast(error.message, 'fail'); return; }
    await releaseServicesForInvoice(inv.id);
    await logInvoiceAction(state, inv, {
        action: 'debt',
        fromStatus: inv.status,
        toStatus:   status,
    });
    await logPatientActivity({
        patientId:   inv.patient_id || state.visit?.patient_id || state.patient?.id,
        visitId:     state.visit?.id,
        entityType:  'invoice',
        entityId:    inv.id,
        entityLabel: inv.invoice_number || inv.id.slice(0, 8),
        action:      'debt',
        summary:     `Outstanding balance left as debt (${(Number(inv.total_amount || 0) - paid).toLocaleString('ru-RU')} UZS owed)`,
    });
    toast('Marked as debt — outstanding balance will show on the cashier screen.');
    onReload();
}

// Cashier has acknowledged the invoice (paid in full, partial, or debt).
// Promote any still-pending services to 'queued' so they show up in the
// service-provider's "My services" queue. Anything already moved past
// queued is left alone.
async function releaseServicesForInvoice(invoiceId) {
    const { data: items, error: itemsErr } = await supabase
        .from('invoice_items').select('id').eq('invoice_id', invoiceId);
    if (itemsErr) { console.warn('[visit-modal] invoice_items lookup failed:', itemsErr); return; }
    const ids = (items || []).map(i => i.id);
    if (!ids.length) {
        console.warn('[visit-modal] release: no invoice_items for invoice', invoiceId);
        return;
    }
    // Same rule as the cashier: flip everything to 'queued' EXCEPT rows
    // a provider has already moved past (in_progress / completed). Covers
    // status='added', 'awaiting_payment', NULL, and re-billed cycles.
    const { data: updated, error } = await supabase
        .from('visit_services')
        .update({ status: 'queued' })
        .in('invoice_item_id', ids)
        .not('status', 'in', '(in_progress,completed)')
        .select('id, status, invoice_item_id');
    if (error) {
        console.warn('[visit-modal] visit_services release failed:', error);
        return;
    }
    console.debug(`[visit-modal] released ${updated?.length || 0} visit_service rows to status=queued (invoice ${invoiceId.slice(0, 8)})`);
}

function openPartialPaymentDialog(state, inv, onReload) {
    const owed = Number(inv.total_amount || 0) - Number(inv.paid_amount || 0);
    const pmDlg = { method: 'cash' };
    const overlay = h('div', { class: 'modal', style: { zIndex: '140' } });
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: () => overlay.remove() }));
    const amountInput = h('input', { type: 'number', step: '0.01', min: '0', max: String(owed), value: String(owed), class: 'num',
        style: { width: '100%', height: '38px', padding: '0 12px', border: '1px solid var(--ink-200)', borderRadius: '8px', fontSize: '15px' } });
    const card = h('div', { class: 'modal-card', style: { width: '420px' } },
        h('header', { class: 'modal-head' },
            h('h2', null, Icon('Wallet', { size: 16 }), ' Take payment'),
            h('button', { class: 'modal-close', onclick: () => overlay.remove() }, '×'),
        ),
        h('div', { class: 'modal-body' },
            h('div', { style: { padding: '10px 12px', background: 'var(--ink-25)', borderRadius: '8px', marginBottom: '14px' } },
                h('div', { class: 'muted', style: { fontSize: '12.5px', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 } }, 'Outstanding'),
                h('div', { class: 'num', style: { fontSize: '20px', fontWeight: 700, color: 'var(--crit-700)' } }, owed.toLocaleString('ru-RU') + ' UZS'),
            ),
            h('div', { class: 'field' },
                h('label', null, 'Amount the patient is paying now'),
                amountInput,
                h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '4px' } },
                    'Whatever stays unpaid becomes a debt on this invoice. Patient can pay it later.'),
            ),
            h('div', { class: 'field' },
                h('label', null, 'Payment method'),
                paymentMethodSelect(pmDlg)),
        ),
        h('footer', { class: 'modal-foot' },
            h('button', { class: 'btn', onclick: () => overlay.remove() }, 'Cancel'),
            h('button', { class: 'btn btn-primary', onclick: async (ev) => {
                ev.target.disabled = true;
                try {
                    const amt = Number(amountInput.value);
                    if (!amt || amt <= 0 || amt > owed) { toast('Amount must be between 0 and ' + owed.toLocaleString('ru-RU'), 'fail'); return; }
                    // If it covers the whole debt, mark paid. Otherwise partial.
                    await takePayment(state, inv, amt, amt >= owed ? 'paid' : 'partial', onReload, pmDlg.method);
                    overlay.remove();
                } finally { ev.target.disabled = false; }
            } }, Icon('Check', { size: 14 }), ' Confirm payment'),
        ),
    );
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    setTimeout(() => amountInput.focus(), 30);
}

// ---------------------------------------------------------------------------
// Field helpers
// ---------------------------------------------------------------------------
function labeled(label, input) {
    return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
        h('label', { style: { fontSize: '12.5px', color: 'var(--ink-700)', fontWeight: 500 } }, label),
        input,
    );
}
function readOnly(value) {
    return h('div', { style: { padding: '8px 10px', background: 'var(--ink-25)', border: '1px solid var(--ink-100)', borderRadius: '7px', fontSize: '13.5px', color: 'var(--ink-900)', fontWeight: 500 } }, value);
}
function dateInput(name, value) { return h('input', { type: 'date', name, value: value || '' }); }
function selectRow(name, options, current) {
    const sel = h('select', { name });
    for (const [val, lbl] of options) sel.appendChild(h('option', { value: val, selected: String(current) === val }, lbl));
    return sel;
}
function radioRow(name, options, current) {
    return h('div', { class: 'pr-radio-group', style: { height: 'auto' } }, ...options.map(([val, lbl]) =>
        h('label', { class: 'pr-radio' },
            h('input', { type: 'radio', name, value: val, ...(String(current) === val ? { checked: true } : {}) }),
            lbl,
        ),
    ));
}
function segmentRow(name, options, current) {
    const wrap = h('div', { class: 'segmented' });
    function repaint(cur) {
        clear(wrap);
        for (const [val, lbl] of options) {
            wrap.appendChild(h('button', {
                type: 'button',
                class: cur === val ? 'on' : '',
                onclick: () => { wrap.dataset.value = val; repaint(val); },
            }, lbl));
        }
    }
    wrap.dataset.name = name;
    wrap.dataset.value = current;
    repaint(current);
    return wrap;
}
function kv(k, v) {
    return h('div', null,
        h('div', { class: 'muted', style: { fontSize: '12.5px', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 } }, k),
        h('div', { style: { fontSize: '13.5px', color: 'var(--ink-900)', marginTop: '2px' } }, v),
    );
}
function fkSelect(name, table, currentId, allowBlank) {
    const sel = h('select', { name });
    if (allowBlank) sel.appendChild(h('option', { value: '' }, '—'));
    sel.appendChild(h('option', { value: currentId || '', selected: true }, currentId ? '(current)' : '—'));
    (async () => {
        const { data, error } = await supabase.from(table).select('id, name').order('name').limit(500);
        if (error) return;
        clear(sel);
        if (allowBlank) sel.appendChild(h('option', { value: '' }, '—'));
        for (const r of (data || [])) {
            sel.appendChild(h('option', { value: r.id, selected: currentId === r.id }, r.name || r.id));
        }
    })();
    return sel;
}
function formatDate(d) {
    if (!d) return '—';
    const s = String(d).slice(0, 10);
    const dt = new Date(s);
    return Number.isNaN(dt.getTime()) ? s : dt.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
}

// ---------------------------------------------------------------------------
// Save / load
// ---------------------------------------------------------------------------
// Delete the visit row. Blocked if an invoice already exists for it —
// invoices are an accounting record, not something we want to orphan.
// `visit_services` rows cascade-delete via the FK.
async function deleteVisit(state) {
    if (!state.visit?.id) {
        toast('Demo visit — nothing to delete.', 'fail');
        return false;
    }

    // Safety: refuse if an invoice exists.
    const { data: inv, error: invErr } = await supabase
        .from('invoices').select('id, invoice_number, status').eq('visit_id', state.visit.id).limit(1);
    if (invErr) { toast('Could not check invoices: ' + invErr.message, 'fail'); return false; }
    if (inv && inv.length > 0) {
        const live = inv.find(i => !['void', 'refunded'].includes(i.status));
        if (live) {
            toast(`Cannot delete: invoice ${live.invoice_number || ''} (${live.status}) is attached. Cancel/refund it first.`, 'fail');
            return false;
        }
        // All invoices on this visit are already void/refunded — let the
        // delete go through. The audit log rows survive because their
        // visit_id FK is `on delete set null`.
    }

    // Confirm
    const ok = confirm(
        `Delete this visit?\n\n` +
        `• Any services attached will also be removed.\n` +
        `• This action cannot be undone.`
    );
    if (!ok) return false;

    const { error } = await supabase.from('visits').delete().eq('id', state.visit.id);
    if (error) { toast('Delete failed: ' + error.message, 'fail'); return false; }
    toast('Visit deleted.');
    return true;
}

async function saveDetails(card, state) {
    if (!state.visit?.id) { toast('Demo visit — saving disabled.', 'fail'); return false; }
    const form = card.querySelector('.vd-form');
    if (!form) return false;
    const payload = {};
    for (const inp of form.querySelectorAll('input[name], select[name], textarea[name]')) {
        const n = inp.getAttribute('name');
        if (!n || n.startsWith('__')) continue;
        if (inp.type === 'radio') { if (inp.checked) payload[n] = inp.value; continue; }
        if (inp.type === 'number') { payload[n] = inp.value === '' ? null : Number(inp.value); continue; }
        if (n === 'visit_date') {
            // A bare date string ("2026-05-22") would otherwise be stored as
            // midnight UTC, blowing away the appointment's time and pushing the
            // calendar block off-screen. Combine the picked date with the
            // existing time so only the day changes.
            const newDate = inp.value;
            if (!newDate) { payload[n] = null; continue; }
            const orig = state.visit?.visit_date ? new Date(state.visit.visit_date) : null;
            const hh = String(orig && !isNaN(orig.getTime()) ? orig.getHours()   : 10).padStart(2, '0');
            const mm = String(orig && !isNaN(orig.getTime()) ? orig.getMinutes() :  0).padStart(2, '0');
            payload[n] = new Date(`${newDate}T${hh}:${mm}:00`).toISOString();
            continue;
        }
        payload[n] = inp.value || null;
    }
    for (const seg of form.querySelectorAll('.segmented[data-name]')) {
        payload[seg.dataset.name] = seg.dataset.value;
    }
    const { error } = await supabase.from('visits').update(payload).eq('id', state.visit.id);
    if (error) { toast(error.message, 'fail'); return false; }
    // Mirror what we just saved into local state so subsequent reads (and the
    // banner) reflect it without waiting for the calendar refresh.
    Object.assign(state.visit, payload);
    toast('Visit saved.');
    return true;
}

// Insert a visit_services row, stamping the registrar who added it
// (created_by). Tolerates a database where a column isn't in PostgREST's schema
// cache yet — scheduled_at (migration 020) or created_by (migration 025): if
// the insert is rejected for an unknown column, drop it and retry. Keeps the
// app usable while migrations catch up. Returns { error }.
async function insertVisitServiceRow(row) {
    const uid = currentUser()?.id || null;
    let payload = { ...row };
    if (uid && payload.created_by === undefined) payload.created_by = uid;
    for (let i = 0; i < 4; i++) {
        const res = await supabase.from('visit_services').insert(payload);
        if (!res.error) return res;
        const msg = res.error.message || '';
        const m = /(scheduled_at|created_by)/i.exec(msg);
        if (m && (/does not exist/i.test(msg) || /schema cache/i.test(msg) || /could not find/i.test(msg)) && m[1] in payload) {
            console.warn(`[visit_services] column "${m[1]}" missing — inserting without it. Apply the matching migration.`);
            delete payload[m[1]];
            continue;
        }
        return res;
    }
    return await supabase.from('visit_services').insert(payload);
}

async function loadServices(state) {
    if (!state.visit?.id) return;
    // DISPENSE_ITEM_V1: join clinic_items so dispensed-item lines (clinic_item_id
    // set, service_id null) resolve a real name/unit. Service lines keep services(name).
    const SEL_FULL = '*, services(name), clinic_items(name, unit), users:doctor_id(full_name), creator:created_by(full_name)';
    let { data, error } = await supabase
        .from('visit_services')
        .select(SEL_FULL)
        .eq('visit_id', state.visit.id);
    // created_by may not exist yet (migration 025) — retry without the join.
    if (error && /created_by|creator/i.test(error.message || '')) {
        ({ data, error } = await supabase
            .from('visit_services')
            .select('*, services(name), clinic_items(name, unit), users:doctor_id(full_name)')
            .eq('visit_id', state.visit.id));
    }
    if (error) { console.warn('[visit_services]', error.message); state.services = []; return; }
    state.services = (data || []).map(r => ({
        ...r,
        qty:               r.quantity,
        price:             r.unit_price,
        __service_status:  r.status || 'added',                    // real lifecycle status from the DB
        status:            r.invoice_item_id ? 'billed' : 'pending', // derived billing flag (legacy callers)
        // DISPENSE_ITEM_V1: an item line has clinic_item_id set + service_id null.
        __is_item:         !!r.clinic_item_id,
        __service_name:    r.clinic_item_id
            ? ((r.clinic_items?.name || 'Item') + (r.clinic_items?.unit ? ' (' + r.clinic_items.unit + ')' : ''))
            : (r.services?.name || '—'),
        __doctor_name:     r.users?.full_name || '',
        __created_by_name: formatRegistrar(r.creator?.full_name),
    }));
}

async function loadInvoice(state) {
    if (!state.visit?.id) return;
    // #5 — a visit can legitimately have >1 invoice (the cashier split creates a sibling), and there is no
    // unique constraint. .maybeSingle() 406'd on >1 row → the Invoice tab silently went empty. Take the
    // newest instead of erroring (deleteVisit already treats multiple-invoices-per-visit as possible).
    const { data, error } = await supabase.from('invoices').select('*').eq('visit_id', state.visit.id)
        .order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (error) { console.warn('[invoices]', error.message); return; }
    state.invoice = data || null;
}

// All invoice activity for this visit (created / payments / debt / void /
// refund), newest first. Joined to users so we can show the actor's name
// even if a later edit changed it.
async function loadInvoiceLogs(state) {
    if (!state.visit?.id) { state.invoiceLogs = []; return; }
    const { data, error } = await supabase
        .from('invoice_audit_log')
        .select('*, users:actor_user_id(full_name, role)')
        .eq('visit_id', state.visit.id)
        .order('created_at', { ascending: false });
    if (error) {
        // Schema cache often hasn't seen the new table the first time around —
        // surface it explicitly so the user knows to run migration 010.
        if (/relation .* does not exist|invoice_audit_log/i.test(error.message)) {
            console.warn('[invoice_audit_log] table missing — apply migration 010_invoice_audit_log.sql');
        } else {
            console.warn('[invoice_audit_log]', error.message);
        }
        state.invoiceLogs = [];
        return;
    }
    state.invoiceLogs = (data || []).map(r => ({
        ...r,
        __actor_name: r.users?.full_name || r.actor_name || 'Unknown',
        __actor_role: r.users?.role      || r.actor_role || '',
    }));
}

// Thin wrapper around the shared logger so existing call sites in this
// file don't have to be touched — they still pass `state` first, we just
// pluck visit_id out for the shared helper.
async function logInvoiceAction(state, inv, opts) {
    return _logInvoiceAction(inv, { ...opts, visitId: state.visit?.id || null });
}

// ---------------------------------------------------------------------------
// Invoice activity log card — sits at the bottom of the Invoice tab. One row
// per audit entry: action pill, who, when, amount/refund, reason.
// ---------------------------------------------------------------------------
function invoiceLogCard(state) {
    const logs = state.invoiceLogs || [];
    return h('div', { class: 'card', style: { padding: '14px 16px', marginTop: '20px' } },
        h('div', { class: 'row', style: { alignItems: 'center', marginBottom: '10px' } },
            h('h3', { style: { margin: 0, fontSize: '13.5px', fontWeight: 600, color: 'var(--ink-700)' } },
                Icon('Doc', { size: 13 }), ' Invoice activity'),
            h('span', { class: 'grow' }),
            h('span', { class: 'muted', style: { fontSize: '12.5px' } },
                logs.length === 0 ? 'No entries yet.' : `${logs.length} entr${logs.length === 1 ? 'y' : 'ies'}`),
        ),
        logs.length === 0
            ? h('div', { class: 'muted', style: { fontSize: '12.5px', padding: '8px 0' } },
                'Every payment, debt mark, cancel, and refund for this visit will appear here with the user and reason.')
            : h('table', { class: 'tbl', style: { fontSize: '12.5px' } },
                h('thead', null, h('tr', null,
                    h('th', { style: { width: '155px' } }, 'When'),
                    h('th', { style: { width: '90px' } }, 'Action'),
                    h('th', null, 'Who'),
                    h('th', { style: { width: '120px', textAlign: 'right' } }, 'Amount'),
                    h('th', null, 'Detail'),
                )),
                h('tbody', null, ...logs.map(logRow)),
            ),
    );
}

function logRow(l) {
    const stamp = formatDateTime(l.created_at);
    const tag = logActionTag(l.action);
    const amount = Number(l.refund_amount || 0) > 0
        ? h('span', { class: 'num', style: { color: 'var(--crit-700)' } }, '−' + Number(l.refund_amount).toLocaleString('ru-RU') + ' UZS')
        : Number(l.amount || 0) > 0
            ? h('span', { class: 'num', style: { color: 'var(--ok-700)' } }, Number(l.amount).toLocaleString('ru-RU') + ' UZS')
            : h('span', { class: 'muted' }, '—');

    const transition = (l.from_status && l.to_status && l.from_status !== l.to_status)
        ? `${l.from_status} → ${l.to_status}`
        : (l.to_status || '');

    const detail = [];
    if (l.reason) detail.push(l.reason);
    if (l.notes)  detail.push(l.notes);
    if (!detail.length && transition) detail.push(transition);

    return h('tr', null,
        h('td', { class: 'muted', style: { fontSize: '12.5px' } }, stamp),
        h('td', null, tag),
        h('td', null,
            h('div', { style: { fontWeight: 600, fontSize: '12.5px', color: 'var(--ink-800)' } }, l.__actor_name || 'Unknown'),
            l.__actor_role && h('div', { class: 'muted', style: { fontSize: '12.5px' } }, l.__actor_role),
        ),
        h('td', { style: { textAlign: 'right' } }, amount),
        h('td', { style: { fontSize: '12.5px', color: 'var(--ink-700)' } }, detail.join(' · ') || h('span', { class: 'muted' }, '—')),
    );
}

function logActionTag(action) {
    const map = {
        created:  { kind: 'info',  text: 'Created'  },
        paid:     { kind: 'ok',    text: 'Paid'     },
        partial:  { kind: 'warn',  text: 'Partial'  },
        debt:     { kind: 'warn',  text: 'Debt'     },
        void:     { kind: 'crit',  text: 'Cancelled'},
        refunded: { kind: 'crit',  text: 'Refunded' },
    };
    const m = map[action] || { kind: 'muted', text: action };
    return h('span', { class: 'tag tag-' + m.kind }, m.text);
}

function formatDateTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    // Date and time joined with a plain space (no locale comma between them).
    const datePart = d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: '2-digit' });
    const timePart = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    return `${datePart} ${timePart}`;
}

// Registrar display: "Surname F.M." — surname shown in full, every other name
// part reduced to an initial. full_name is stored as "<last> <first> <middle>"
// (migration 026), so the first token is the surname.
function formatRegistrar(fullName) {
    const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return '';
    const surname = parts[0];
    const initials = parts.slice(1).map(p => p[0].toUpperCase() + '.').join(' ');
    return initials ? `${surname} ${initials}` : surname;
}

// Pending recommendations for this visit's patient — created by a doctor in
// a previous consultation (lab orders, referrals, follow-up procedures).
async function loadRecommendations(state) {
    const pid = state.visit?.patient_id || state.patient?.id;
    if (!pid) { state.recommendations = []; return; }
    const { data, error } = await supabase
        .from('recommended_services')
        .select('*, services(name, price, duration_minutes), users:recommended_by(full_name, specialty)')
        .eq('patient_id', pid)
        .eq('status', 'pending')
        .order('created_at', { ascending: false });
    if (error) { console.warn('[recommendations]', error.message); state.recommendations = []; return; }
    state.recommendations = (data || []).map(r => ({
        ...r,
        __service_name:     r.services?.name || r.service_name || '—',
        __service_price:    r.services?.price,
        __service_duration: r.services?.duration_minutes,
        __doctor_name:      r.users?.full_name || r.recommended_by_name || '(unknown)',
        __doctor_spec:      r.users?.specialty || '',
    }));
}

// (addService was replaced by addServiceFromPicker — uses the 4-column
// service-picker-modal instead of a prompt())

async function removeService(id, state, onReload) {
    if (!confirm('Remove this service from the visit?')) return;
    // Snapshot the row before deleting so the log has a real name.
    const svc = (state.services || []).find(s => s.id === id);
    const { error } = await supabase.from('visit_services').delete().eq('id', id);
    if (error) { toast(error.message, 'fail'); return; }
    await logPatientActivity({
        patientId:   state.visit?.patient_id || state.patient?.id,
        visitId:     state.visit?.id,
        entityType:  'service',
        entityId:    svc?.service_id || null,
        entityLabel: svc?.__service_name || '(service)',
        action:      'deleted',
        summary:     `Removed "${svc?.__service_name || '(service)'}" from the visit`,
    });
    toast('Removed.');
    onReload();
}
