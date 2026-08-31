// Admission modal — the *registrar's* view of an inpatient stay.
// Visually modelled on visit-modal.js (Details / Services / Invoice tabs)
// so that staff who already know the outpatient flow feel at home when
// opening an admission from the patient card.
//
// What this modal does:
//   • Details   — read-only summary (ward, bed, attending, admitted_at,
//                 chief complaint, diagnosis, status).
//   • Services  — list of admission_services with tick-boxes; one click
//                 generates an invoice for the selected unbilled rows
//                 (admission_services.invoice_item_id is set; status flips
//                 to 'completed').
//   • Invoice   — every invoice already linked to this admission, with
//                 Mark paid / Partial / Mark as debt controls, exactly
//                 like the outpatient flow.
//
// Things this modal does NOT do (those live on the Ward & beds page):
//   transfers between rooms, bed status flips, admit modal. Footer carries
//   a Discharge button as a convenience since the registrar is the last
//   person to touch the file before the patient walks out.

import { supabase } from '../../supabase.js';
import { isAccommodationLine, ACCOMMODATION_LABEL } from '../../shared/accommodation-line.js';   // ACCOMMODATION_AS_SERVICE_V1
import { h, Icon, Tag, StatusTag, toast, clear, avColor, initials } from '../ui.js';
import { tr, trf } from '../i18n.js';   // I18N_COVERAGE_V1 — перевод СНАЧАЛА, подстановка ПОТОМ
import { openServicePickerModal } from './service-picker-modal.js?v=aug17e';
import { openItemPickerModal } from './item-picker-modal.js?v=billoptin1';   // DISPENSE_ITEM_V1
import { creditCashbackOnPaid } from './cashback.js?v=cb1';
import { canDelete } from '../permissions.js';

let active = null;

export function openAdmissionRegistrarModal({ admissionId, onChange } = {}) {
    if (!admissionId) { toast('No admission id.', 'fail'); return; }
    closeActive();
    const state = {
        admission:    null,
        services:     [],
        invoices:     [],
        selectedSvc:  new Set(),
        tab:          'details',
        onChange:     onChange || (() => {}),
    };

    const overlay = h('div', { class: 'modal' });
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: () => close() }));

    const card = h('div', { class: 'modal-card modal-grouped', style: {
        width: '920px', maxWidth: 'calc(100vw - 32px)',
        maxHeight: 'calc(100vh - 60px)', display: 'flex', flexDirection: 'column',
    } });
    overlay.appendChild(card);

    const headerEl = h('header', { class: 'modal-head', style: { gap: '12px', flexWrap: 'wrap' } },
        h('div', { class: 'muted', style: { fontSize: '12px' } }, 'Loading admission…'),
        h('button', { class: 'modal-close', onclick: () => close() }, '×'),
    );
    card.appendChild(headerEl);

    const tabBar = h('div', { class: 'tabs', style: { padding: '0 22px', background: 'var(--ink-25)', borderBottom: '1px solid var(--ink-100)' } });
    card.appendChild(tabBar);

    const body = h('div', { style: { flex: 1, overflowY: 'auto', padding: '20px 22px' } });
    card.appendChild(body);

    const dischargeBtn = h('button', {
        class: 'btn btn-success',
        title: 'Mark this admission discharged',
        onclick: () => doDischarge(),
    }, Icon('Check', { size: 14 }), ' Discharge');

    // BTNS_RIGHT_V1 — nothing sits bottom-left (the chat FAB lives there);
    // close is red and unmissable, Discharge is the right-most action.
    card.appendChild(h('footer', { class: 'modal-foot' },
        h('span', { class: 'grow' }),
        h('button', { class: 'btn', style: { background: '#dc2626', borderColor: '#dc2626', color: 'white', fontWeight: '700' }, onclick: () => close() }, '✕ Close'),
        dischargeBtn,
    ));

    function close() {
        overlay.remove();
        document.removeEventListener('keydown', onKey);
        active = null;
    }
    function onKey(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey);

    document.body.appendChild(overlay);
    active = overlay;

    // Async load + initial paint.
    (async () => {
        await Promise.all([loadAdmission(), loadServices(), loadInvoices()]);
        renderHeader();
        renderTabs();
        renderBody();
    })();

    // ---- Async data --------------------------------------------------
    async function loadAdmission() {
        const { data, error } = await supabase
            .from('admissions')
            .select(`
                id, admission_no, status, pathway, chief_complaint, admission_diagnosis,
                discharge_summary, admitted_at, discharged_at,
                bed_id, ward_id, home_bed_id, attending_doctor_id, patient_id,
                patients(full_name, last_name, first_name, mrn, phone, date_of_birth, gender),
                users:attending_doctor_id(full_name, specialty),
                wards(name, code, color),
                beds!admissions_bed_id_fkey(code, type)
            `)
            .eq('id', admissionId)
            .maybeSingle();
        if (error) { toast('Could not load admission: ' + error.message, 'fail'); return; }
        state.admission = data || null;
    }

    async function loadServices() {
        // DISPENSE_ITEM_V1: join clinic_items so dispensed-item lines (clinic_item_id
        // set, service_id null) resolve a real name/unit.
        const { data, error } = await supabase
            .from('admission_services')
            .select('*, services(name), clinic_items(name, unit), users:doctor_id(full_name), beds(code), wards(name)')
            .eq('admission_id', admissionId)
            .order('performed_at', { ascending: false });
        if (error) {
            console.warn('[admission-modal] services:', error.message);
            state.services = []; return;
        }
        state.services = (data || []).map(r => ({
            ...r,
            __is_item:      !!r.clinic_item_id,
            __is_accommodation: isAccommodationLine(r),
            // ACCOMMODATION_AS_SERVICE_V1 — у проживания нет строки в каталоге,
            // поэтому без своей подписи оно показывалось как «(removed)», то
            // есть как удалённая услуга: сумма есть, а за ней будто ничего.
            // Название переводится (ru/en/uz) — h() прогоняет текст через tr().
            __service_name: isAccommodationLine(r)
                ? ACCOMMODATION_LABEL
                : (r.clinic_item_id
                    ? ((r.clinic_items?.name || 'Item') + (r.clinic_items?.unit ? ' (' + r.clinic_items.unit + ')' : ''))
                    : (r.services?.name || '(removed)')),
            __doctor_name:  r.users?.full_name || '—',
            __bed_code:     r.beds?.code || '',
            __ward_name:    r.wards?.name || '',
            __billed:       !!r.invoice_item_id,
            __subtotal:     Number(r.unit_price || 0) * Number(r.quantity || 1),
        }));
        // Pre-select unbilled rows for invoicing.
        state.selectedSvc = new Set(state.services.filter(r => !r.__billed).map(r => r.id));
    }

    async function loadInvoices() {
        const { data, error } = await supabase
            .from('invoices')
            .select('id, invoice_number, total_amount, paid_amount, status, created_at, paid_at, notes')
            .eq('admission_id', admissionId)
            .order('created_at', { ascending: false });
        if (error) {
            console.warn('[admission-modal] invoices:', error.message);
            state.invoices = []; return;
        }
        state.invoices = data || [];
    }

    async function refreshAll() {
        await Promise.all([loadServices(), loadInvoices(), loadAdmission()]);
        renderHeader(); renderTabs(); renderBody();
        state.onChange();
    }

    // ---- Render ------------------------------------------------------
    function renderHeader() {
        clear(headerEl);
        const a = state.admission;
        if (!a) {
            headerEl.append(
                h('div', { class: 'muted' }, 'Loading…'),
                h('button', { class: 'modal-close', onclick: () => close() }, '×'),
            );
            return;
        }
        const p = a.patients || {};
        const name = displayName(p);
        headerEl.append(
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px' } },
                h('h2', null, 'Inpatient visit · ', a.admission_no || a.id.slice(0, 8)),
                h('div', { class: 'muted', style: { fontSize: '12px' } },
                    [a.wards?.name, a.beds?.code && 'Bed ' + a.beds.code,
                     a.users?.full_name].filter(Boolean).join(' · ')),
            ),
            h('span', { class: 'grow' }),
            statusTagFor(a.status),
            h('button', { class: 'modal-close', onclick: () => close(), title: 'Close', style: { marginLeft: '8px' } }, '×'),
        );
        dischargeBtn.style.display = a.status === 'active' ? '' : 'none';
    }

    function renderTabs() {
        clear(tabBar);
        const a = state.admission;
        const counts = { services: state.services.length, invoices: state.invoices.length };
        const tabs = [
            { id: 'details',  label: 'Details',  icon: 'Doc' },
            { id: 'services', label: 'Services', icon: 'Activity', count: counts.services },
            { id: 'invoice',  label: 'Invoice',  icon: 'Wallet',   count: counts.invoices || null },
            { id: 'meds',     label: 'Назначения', icon: 'Pill' },
        ];
        for (const t of tabs) {
            tabBar.appendChild(h('button', {
                class: 'tab' + (state.tab === t.id ? ' on' : ''),
                onclick: () => { state.tab = t.id; renderTabs(); renderBody(); },
            }, Icon(t.icon, { size: 14 }), ' ', t.label,
                t.count != null && h('span', { class: 'tab-count' }, String(t.count)),
            ));
        }
    }

    function renderBody() {
        clear(body);
        if (!state.admission) {
            body.appendChild(h('div', { class: 'empty', style: { padding: '40px' } }, 'Loading…'));
            return;
        }
        body.appendChild(banner(state.admission));
        if (state.tab === 'details')  body.appendChild(detailsTab(state.admission));
        if (state.tab === 'services') body.appendChild(servicesTab(state, refreshAll));
        if (state.tab === 'invoice')  body.appendChild(invoiceTab(state, refreshAll));
        if (state.tab === 'meds')     body.appendChild(medsTab(state));
    }

    async function doDischarge() {
        const a = state.admission;
        if (!a) return;
        if (!confirm(`Discharge ${displayName(a.patients)}?\n\nAll held beds will be flagged Cleaning.`)) return;
        const now = new Date().toISOString();
        const { error: aErr } = await supabase.from('admissions')
            .update({ status: 'discharged', discharged_at: now }).eq('id', a.id);
        if (aErr) { toast('Discharge failed: ' + aErr.message, 'fail'); return; }
        // BED_SYNC_GUARD_V2 — this path used to fire the bed writes and ignore
        // the outcome entirely, which is how a discharge from the patient card
        // left the bed board reading "Occupied · no admission link". Note that
        // an RLS rejection on UPDATE is not an error: the policy's USING clause
        // filters the row out, so the call returns 204 / error: null. Ask for
        // the row back — "no row" is the real failure signal.
        const ids = [a.bed_id, a.home_bed_id].filter((v, i, arr) => v && arr.indexOf(v) === i);
        const bedFails = [];
        for (const id of ids) {
            const { data: upd, error: bErr } = await supabase
                .from('beds').update({ status: 'cleaning' }).eq('id', id).select('id');
            if (bErr) { console.warn('[admission-modal] discharge bed update rejected:', bErr.message); bedFails.push(bErr.message); }
            else if (!upd || upd.length === 0) {
                console.warn('[admission-modal] discharge bed update matched 0 rows (RLS) for bed', id);
                bedFails.push('нет прав на изменение койки (RLS). Примените supabase/migrations/117_beds_rls_clinic_scope.sql');
            }
        }
        if (bedFails.length) toast(trf('Койка не освободилась — {msg}', { msg: bedFails[0] }), 'fail');
        await supabase.from('admission_transfers').insert({
            admission_id: a.id, from_bed_id: a.bed_id || null,
            from_ward_id: a.ward_id || null, kind: 'discharge',
        });
        toast('Discharged.');
        await refreshAll();
    }
}

export function closeActive() {
    if (active) { active.remove(); active = null; }
}

// ---------------------------------------------------------------------------
// BANNER — patient block shown on every tab.
// ---------------------------------------------------------------------------
function banner(a) {
    const p = a.patients || {};
    const name = displayName(p);
    const dob = p.date_of_birth ? new Date(p.date_of_birth) : null;
    const age = dob && !isNaN(dob.getTime()) ? Math.floor((Date.now() - dob.getTime()) / 31557600000) : null;
    return h('div', {
        style: {
            padding: '14px 16px', marginBottom: '18px',
            background: 'linear-gradient(135deg, var(--primary-50) 0%, white 60%, var(--info-50) 100%)',
            border: '1px solid var(--primary-200)',
            borderRadius: '12px',
            display: 'grid', gridTemplateColumns: '1.2fr 1fr 1fr', gap: '14px', alignItems: 'center',
        },
    },
        h('div', { class: 'row', style: { gap: '12px', alignItems: 'center', minWidth: 0 } },
            h('div', { class: 'avatar ' + avColor(a.patient_id || name) }, initials(name)),
            h('div', { style: { minWidth: 0 } },
                h('div', { class: 'cell-strong', style: { fontSize: '15px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, name),
                h('div', { class: 'muted', style: { fontSize: '12px' } },
                    [p.mrn, age != null ? age + ' y' : null,
                     p.gender === 'male' ? 'M' : p.gender === 'female' ? 'F' : null,
                     p.phone].filter(Boolean).join(' · ')),
            ),
        ),
        bannerKv('Admission #',  a.admission_no || '—'),
        bannerKv('Admitted',     formatDateTime(a.admitted_at) + (a.admitted_at ? ' · ' + lengthOfStay(a.admitted_at) : '')),
    );
}
function bannerKv(label, value) {
    return h('div', { style: { minWidth: 0 } },
        h('div', { class: 'muted', style: { fontSize: '10.5px', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 700 } }, label),
        h('div', { style: { fontSize: '13.5px', fontWeight: 600, color: 'var(--ink-900)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, value || '—'),
    );
}

// ---------------------------------------------------------------------------
// DETAILS TAB
// ---------------------------------------------------------------------------
function detailsTab(a) {
    const pathway = { surgical: 'Surgical', therapy: 'Therapy' }[a.pathway] || a.pathway || '—';
    return h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px 22px' } },
        readOnlyField('Ward',                a.wards?.name || '—'),
        readOnlyField('Bed',                 a.beds?.code  || '—'),
        readOnlyField('Pathway',             pathway),
        readOnlyField('Attending doctor',    a.users?.full_name || '—',
                                             a.users?.specialty ? ' (' + a.users.specialty + ')' : ''),
        readOnlyField('Admitted at',         formatDateTime(a.admitted_at)),
        readOnlyField('Discharged at',       a.discharged_at ? formatDateTime(a.discharged_at) : '—'),
        h('div', { style: { gridColumn: '1 / -1' } }, readOnlyField('Chief complaint',     a.chief_complaint     || '—', '', true)),
        h('div', { style: { gridColumn: '1 / -1' } }, readOnlyField('Admission diagnosis', a.admission_diagnosis || '—', '', true)),
        a.discharge_summary && h('div', { style: { gridColumn: '1 / -1' } },
            readOnlyField('Discharge summary', a.discharge_summary, '', true)),
    );
}
function readOnlyField(label, value, extra, block) {
    return h('div', { class: 'field' },
        h('label', null, label),
        h('div', {
            style: {
                padding: '8px 10px',
                background: 'var(--ink-25)', border: '1px solid var(--ink-100)',
                borderRadius: '7px', fontSize: '13.5px', color: 'var(--ink-900)',
                fontWeight: 500,
                whiteSpace: block ? 'pre-wrap' : 'nowrap',
                overflow: block ? 'visible' : 'hidden',
                textOverflow: block ? 'clip' : 'ellipsis',
                minHeight: '34px',
            },
        }, (value || '—') + (extra || '')),
    );
}

// ---------------------------------------------------------------------------
// SERVICES TAB — same pattern as visit-modal.js's servicesPane.
// ---------------------------------------------------------------------------
function servicesTab(state, onReload) {
    const rows = state.services;
    const unbilled = rows.filter(r => !r.__billed);
    const selected = state.selectedSvc;
    const selectedTotal = rows.filter(r => selected.has(r.id)).reduce((s, r) => s + Number(r.__subtotal || 0), 0);

    return h('div', null,
        h('div', { class: 'row', style: { marginBottom: '12px', gap: '8px' } },
            h('h3', { style: { margin: 0, fontSize: '14px', fontWeight: 600, color: 'var(--ink-900)' } },
                'Services performed during this stay'),
            h('span', { class: 'grow' }),
            h('div', { class: 'num', style: { fontWeight: 700, fontSize: '14px', color: 'var(--ink-900)' } },
                selected.size > 0
                    ? `${selected.size} selected · ${selectedTotal.toLocaleString('ru-RU')} UZS`
                    : `Total ${rows.reduce((s, r) => s + Number(r.__subtotal || 0), 0).toLocaleString('ru-RU')} UZS`),
            h('button', {
                class: 'btn btn-outline btn-sm',
                onclick: () => openServicePickerModal({
                    title: 'Add service to admission',
                    confirmLabel: 'Attach',
                    visitDoctorId: state.admission.attending_doctor_id || null,
                    onPick: async ({ service, doctor }) => {
                        const price = Number(service.price || 0);
                        const { error } = await supabase.from('admission_services').insert({
                            admission_id: state.admission.id,
                            service_id:   service.id,
                            doctor_id:    doctor?.id || state.admission.attending_doctor_id || null,
                            bed_id:       state.admission.bed_id,
                            ward_id:      state.admission.ward_id,
                            quantity:     1, unit_price: price, total: price,
                            status:       'added',
                        });
                        if (error) { toast(error.message, 'fail'); return; }
                        toast(`Added: ${service.name}`);
                        onReload();
                    },
                }),
            }, Icon('Plus', { size: 13 }), ' Add service'),
            // DISPENSE_ITEM_V1 — dispense a clinic product consumed during this
            // admission. Calls dispense_admission_item (atomic line + stock decrement).
            h('button', {
                class: 'btn btn-outline btn-sm',
                title: 'Dispense a product (decrements stock)',
                onclick: () => openDispenseAdmissionItem(state, onReload),
            }, Icon('Pill', { size: 13 }), ' Dispense item'),
            h('button', {
                class: 'btn btn-primary btn-sm',
                disabled: unbilled.length === 0 || selected.size === 0 ? '' : null,
                title: unbilled.length === 0 ? 'All services are already invoiced' : 'Create an invoice for the selected services',
                onclick: () => generateInvoice(state, onReload),
            }, Icon('Wallet', { size: 13 }), ' Generate invoice'),
        ),
        rows.length === 0
            ? h('div', { class: 'empty', style: { padding: '40px 20px' } },
                'No services attached yet — click + Add service.')
            : h('table', { class: 'tbl' },
                h('thead', null, h('tr', null,
                    h('th', { style: { width: '32px' } },
                        h('input', {
                            type: 'checkbox',
                            checked: unbilled.length > 0 && unbilled.every(r => selected.has(r.id)),
                            onclick: (e) => {
                                if (e.target.checked) for (const r of unbilled) selected.add(r.id);
                                else                  for (const r of unbilled) selected.delete(r.id);
                                onReload();
                            },
                        }),
                    ),
                    h('th', null, 'Service'),
                    h('th', null, 'Doctor'),
                    h('th', null, 'Where'),
                    h('th', null, 'When'),
                    h('th', null, 'Subtotal'),
                    h('th', null, 'Status'),
                    h('th', { style: { width: '90px', textAlign: 'right' } }, ''),
                )),
                h('tbody', null, ...rows.map(r => h('tr', null,
                    h('td', null,
                        r.__billed
                            ? h('span', { title: 'Already invoiced', style: { color: 'var(--ink-400)' } }, '🔒')
                            : h('input', { type: 'checkbox',
                                checked: selected.has(r.id),
                                onclick: (e) => {
                                    if (e.target.checked) selected.add(r.id);
                                    else                  selected.delete(r.id);
                                    onReload();
                                },
                            }),
                    ),
                    h('td', { class: 'cell-strong' }, r.__service_name),
                    h('td', null, r.__doctor_name),
                    h('td', null, r.__ward_name, r.__bed_code ? h('span', { class: 'muted' }, ' · ' + r.__bed_code) : ''),
                    h('td', { class: 'num muted' }, formatDateTime(r.performed_at)),
                    h('td', { class: 'num cell-strong' }, Number(r.__subtotal || 0).toLocaleString('ru-RU')),
                    h('td', null, r.__billed ? Tag('Billed', { kind: 'info' }) : Tag('Pending', { kind: 'warn' })),
                    h('td', { style: { textAlign: 'right' } },
                        r.__billed
                            ? h('span', { class: 'muted', style: { fontSize: '11.5px' } }, '🔒 invoiced')
                            // DISPENSE_ITEM_V1: item lines void via the RPC (returns
                            // stock + deletes the line; RAISEs if already invoiced).
                            : r.__is_item && canDelete('beds')
                            ? h('button', {
                                class: 'btn btn-ghost btn-sm',
                                style: { color: 'var(--crit-700)' },
                                title: 'Void this dispensed item (returns stock)',
                                onclick: () => voidDispensedAdmissionItem(r, onReload),
                            }, Icon('Trash', { size: 13 }))
                            : canDelete('beds') && h('button', {
                                class: 'btn btn-ghost btn-sm',
                                style: { color: 'var(--crit-700)' },
                                onclick: async () => {
                                    if (!confirm(`Remove ${r.__service_name}?`)) return;
                                    const { error } = await supabase.from('admission_services').delete().eq('id', r.id);
                                    if (error) { toast(error.message, 'fail'); return; }
                                    toast('Removed.');
                                    onReload();
                                },
                            }, Icon('Trash', { size: 13 })),
                    ),
                ))),
            ),
    );
}

// DISPENSE_ITEM_V1 ----------------------------------------------------------
// Open the item picker and, on confirm, call dispense_admission_item — the
// SECURITY DEFINER RPC that atomically inserts an admission_services item line
// (clinic_item_id set, service_id null) and writes a negative 'issue' stock
// movement. The RPC validates the caller's clinic+branch and RAISEs a
// human-readable message on any error; we surface it via the picker's toast.
function openDispenseAdmissionItem(state, onReload) {
    openItemPickerModal({
        title:        'Dispense item to admission',
        confirmLabel: 'Dispense',
        // DISPENSE_MULTI_V1 — dispense each cart line with its own atomic RPC.
        onConfirm: async (lines) => {
            let ok = 0; const fails = [];
            const u = (typeof window !== 'undefined' && window.easymed && window.easymed.state && window.easymed.state.user) || {};
            for (const { item, qty } of lines) {
                try {
                    const { data, error } = await supabase.rpc('dispense_admission_item', {
                        p_admission_id: state.admission.id,
                        p_item_id:      item.id,
                        p_qty:          Number(qty),
                        p_doctor_id:    state.admission.attending_doctor_id || null,
                    });
                    if (error) throw error;
                    const res = Array.isArray(data) ? data[0] : data;
                    const name = res?.item_name || item.name;
                    ok++;
                    // GIVE_DRUG_LOG_V1 — mirror the billed dispense into the nurse
                    // journal (med_administrations) so «Журнал выполнений» shows it.
                    try {
                        await supabase.from('med_administrations').insert({
                            admission_id: state.admission.id, patient_id: state.admission.patient_id,
                            med_name: name, instructions: 'x' + Number(qty),
                            administered_by: u.id || null,
                            administered_by_name: u.full_name || null,
                        });
                    } catch (e) { console.warn('[dispense] journal mirror', e); }
                    if (res && Number(res.on_hand) <= 0) {
                        toast(`Warning: ${name} stock is now ${Number(res.on_hand).toLocaleString('ru-RU')} (low/negative).`, 'fail');
                    }
                } catch (err) { fails.push(`${item.name}: ${err?.message || err}`); }
            }
            if (ok === 0) throw new Error(fails[0] || 'Dispense failed');
            await onReload();
            toast(`Dispensed: ${ok}` + (fails.length ? ` · failed: ${fails.length}` : ''));
            if (fails.length) toast(fails.join('; '), 'fail');
        },
    });
}

// Void a dispensed item line — returns stock and deletes the line via
// void_dispensed_admission_item. RAISEs if the line is already invoiced.
async function voidDispensedAdmissionItem(row, onReload) {
    if (!confirm(`Void "${row.__service_name}"? This returns the stock.`)) return;
    try {
        const { error } = await supabase.rpc('void_dispensed_admission_item', { p_line: row.id });
        if (error) throw error;
        toast('Item voided — stock returned.');
        await onReload();
    } catch (err) {
        toast(err?.message || String(err), 'fail');
    }
}

async function generateInvoice(state, onReload) {
    const rows = state.services.filter(r => state.selectedSvc.has(r.id) && !r.__billed);
    if (rows.length === 0) { toast('All selected services are already invoiced.', 'fail'); return; }
    const subtotal = rows.reduce((s, r) => s + Number(r.__subtotal || 0), 0);

    const { data: inv, error: invErr } = await supabase.from('invoices').insert({
        admission_id: state.admission.id,
        patient_id:   state.admission.patient_id,
        subtotal,
        total_amount: subtotal,
        paid_amount:  0,
        status:       'unpaid',
    }).select().single();
    if (invErr) { toast('Invoice create failed: ' + invErr.message, 'fail'); return; }

    for (const r of rows) {
        // DISPENSE_ITEM_V1: item lines (clinic_item_id set, service_id null)
        // invoice with item_id + the product name, mirroring service lines.
        const isItem = !!r.clinic_item_id;
        const { data: item, error: itemErr } = await supabase.from('invoice_items').insert({
            invoice_id:  inv.id,
            service_id:  isItem ? null : r.service_id,
            item_id:     isItem ? r.clinic_item_id : null,
            description: r.__service_name,
            quantity:    r.quantity || 1,
            unit_price:  Number(r.unit_price || 0),
            total:       Number(r.__subtotal || 0),
        }).select().single();
        if (itemErr) { console.warn('[admission-modal] invoice_items', itemErr); continue; }
        await supabase.from('admission_services').update({
            invoice_item_id: item.id, status: 'completed',
        }).eq('id', r.id);
    }

    toast(`Invoice ${inv.invoice_number || inv.id.slice(0, 8)} created — sent to cashier.`);
    state.tab = 'invoice';
    state.selectedSvc = new Set();
    onReload();
}

// ---------------------------------------------------------------------------
// INVOICE TAB — one section per linked invoice.
// ---------------------------------------------------------------------------
function invoiceTab(state, onReload) {
    if (state.invoices.length === 0) {
        return h('div', { class: 'empty', style: { padding: '40px 20px' } },
            h('p', null, 'No invoices yet for this admission.'),
            h('p', { class: 'muted', style: { fontSize: '12.5px', maxWidth: '420px', margin: '8px auto 0' } },
                'Open the ', h('b', null, 'Services'), ' tab, tick the services to bill, then click ',
                h('b', null, 'Generate invoice'), '.'),
        );
    }
    return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '14px' } },
        ...state.invoices.map(inv => invoiceCard(inv, onReload)),
    );
}

function invoiceCard(inv, onReload) {
    const total = Number(inv.total_amount || 0);
    const paid  = Number(inv.paid_amount  || 0);
    const owed  = Math.max(total - paid, 0);
    return h('div', { class: 'card', style: { padding: '16px 18px' } },
        h('div', { class: 'row', style: { gap: '24px', flexWrap: 'wrap' } },
            kv('Invoice #', h('span', { class: 'cell-mono cell-strong', style: { fontSize: '14px' } }, inv.invoice_number || inv.id.slice(0, 8))),
            kv('Total',    h('span', { class: 'num cell-strong', style: { fontSize: '15px' } }, total.toLocaleString('ru-RU') + ' UZS')),
            kv('Paid',     h('span', { class: 'num', style: { fontSize: '14px', color: 'var(--ok-700)' } }, paid.toLocaleString('ru-RU') + ' UZS')),
            kv('Debt',     h('span', { class: 'num cell-strong', style: { fontSize: '14px', color: owed > 0 ? 'var(--crit-700)' : 'var(--ink-500)' } }, owed.toLocaleString('ru-RU') + ' UZS')),
            kv('Status',   StatusTag(inv.status || 'unpaid')),
            kv('Created',  formatDateTime(inv.created_at)),
        ),
        h('div', { style: { marginTop: '12px' } },
            inv.status === 'paid'
                ? h('div', { class: 'row', style: { gap: '8px', padding: '12px 14px', background: 'var(--ok-50)', borderRadius: '10px', color: 'var(--ok-700)', fontWeight: 600 } },
                    Icon('Check', { size: 16 }), ' Fully paid on ', formatDateTime(inv.paid_at))
                : (inv.status === 'void' || inv.status === 'refunded')
                ? h('div', { class: 'row', style: { padding: '12px 14px', background: 'var(--ink-25)', borderRadius: '10px', color: 'var(--ink-600)' } },
                    'Invoice ', inv.status, '.')
                : paymentControls(inv, onReload),
        ),
    );
}

// PAYMENT_METHOD_QUICKPAY - method picker shared by the quick-pay panel + partial dialog.
// Mirrors the Kassa methods; the chosen value is written to payments.method (was hardcoded 'cash').
function paymentMethodSelect(pm) {
    const METHODS = [['cash', 'Cash'], ['card', 'Card'], ['online', 'Online / acquiring'], ['insurance', 'Insurance'], ['transfer', 'Bank transfer']];
    return h('select', {
        class: 'input',
        style: { height: '34px', padding: '0 10px', border: '1px solid var(--ink-200)', borderRadius: '8px', fontSize: '13px', background: '#fff' },
        onchange: (e) => { pm.method = e.target.value; },
    }, ...METHODS.map(([v, l]) => h('option', { value: v }, l)));
}

function paymentControls(inv, onReload) {
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
                class: 'btn btn-success',
                onclick: () => takePayment(inv, owed, 'paid', onReload, pm.method),
            }, Icon('Check', { size: 14 }), ' Mark paid (full)'),
            h('button', {
                class: 'btn btn-outline',
                onclick: () => openPartialDialog(inv, owed, onReload),
            }, Icon('Wallet', { size: 14 }), ' Partial payment…'),
            h('button', {
                class: 'btn btn-warning',
                onclick: () => markAsDebt(inv, onReload),
            }, Icon('Warning', { size: 14 }), ' Mark as debt'),
        ),
    );
}

async function takePayment(inv, amount, finalStatus, onReload, method = 'cash') {
    if (!amount || amount <= 0) { toast('Amount must be > 0.', 'fail'); return; }
    const { error: payErr } = await supabase.from('payments').insert({
        invoice_id: inv.id, amount, method,
        cashier_id: (typeof window !== 'undefined' && window.easymed?.state?.user?.id) || null,   // SHIFT_CASHIER_ID_V1 — so the payment lands in the cashier's shift stats
    });
    if (payErr) { toast('Payment failed: ' + payErr.message, 'fail'); return; }
    const newPaid = Math.min(Number(inv.paid_amount || 0) + amount, Number(inv.total_amount || 0));
    const total   = Number(inv.total_amount || 0);
    const status  = newPaid >= total ? 'paid' : finalStatus || (newPaid > 0 ? 'partial' : 'unpaid');
    const update  = { paid_amount: newPaid, status };
    if (status === 'paid') update.paid_at = new Date().toISOString();
    const { error: updErr } = await supabase.from('invoices').update(update).eq('id', inv.id);
    if (updErr) { toast('Invoice update failed: ' + updErr.message, 'fail'); return; }
    toast(`Payment recorded: ${amount.toLocaleString('ru-RU')} UZS.`);
    if (status === 'paid' && inv.status !== 'paid') {
        const cb = await creditCashbackOnPaid(inv.id);
        if (cb) toast(`Cashback ${cb.toLocaleString('ru-RU')} UZS credited to the patient.`);
    }
    onReload();
}
async function markAsDebt(inv, onReload) {
    const paid = Number(inv.paid_amount || 0);
    const status = paid > 0 ? 'partial' : 'unpaid';
    const { error } = await supabase.from('invoices').update({ status }).eq('id', inv.id);
    if (error) { toast(error.message, 'fail'); return; }
    toast('Marked as debt.');
    onReload();
}
function openPartialDialog(inv, owed, onReload) {
    const pmDlg = { method: 'cash' };
    const overlay = h('div', { class: 'modal', style: { zIndex: '140' } });
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: () => overlay.remove() }));
    const input = h('input', { type: 'number', step: '0.01', min: '0', max: String(owed), value: String(owed), class: 'num',
        style: { width: '100%', height: '38px', padding: '0 12px', border: '1px solid var(--ink-200)', borderRadius: '8px', fontSize: '15px' } });
    const card = h('div', { class: 'modal-card', style: { width: '420px' } },
        h('header', { class: 'modal-head' }, h('h2', null, Icon('Wallet', { size: 16 }), ' Take payment'),
            h('button', { class: 'modal-close', onclick: () => overlay.remove() }, '×')),
        h('div', { class: 'modal-body' },
            h('div', { style: { padding: '10px 12px', background: 'var(--ink-25)', borderRadius: '8px', marginBottom: '14px' } },
                h('div', { class: 'muted', style: { fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 } }, 'Outstanding'),
                h('div', { class: 'num', style: { fontSize: '20px', fontWeight: 700, color: 'var(--crit-700)' } }, owed.toLocaleString('ru-RU') + ' UZS')),
            h('div', { class: 'field' }, h('label', null, 'Amount paid now'), input),
            h('div', { class: 'field' }, h('label', null, 'Payment method'), paymentMethodSelect(pmDlg))),
        h('footer', { class: 'modal-foot' },
            h('button', { class: 'btn', onclick: () => overlay.remove() }, 'Cancel'),
            h('button', { class: 'btn btn-primary', onclick: async (e) => {
                e.target.disabled = true;
                try {
                    const amt = Number(input.value);
                    if (!amt || amt <= 0 || amt > owed) { toast('Amount must be between 0 and ' + owed.toLocaleString('ru-RU'), 'fail'); return; }
                    await takePayment(inv, amt, amt >= owed ? 'paid' : 'partial', onReload, pmDlg.method);
                    overlay.remove();
                } finally { e.target.disabled = false; }
            } }, Icon('Check', { size: 14 }), ' Confirm payment')),
    );
    overlay.appendChild(card); document.body.appendChild(overlay);
    setTimeout(() => input.focus(), 30);
}

// ---------------------------------------------------------------------------
// Small helpers (kept local so this file is drop-in independent).
// ---------------------------------------------------------------------------
function statusTagFor(s) {
    if (s === 'active')      return h('span', { class: 'tag tag-info' }, 'Active');
    if (s === 'discharged')  return h('span', { class: 'tag tag-ok' },   'Discharged');
    if (s === 'transferred') return h('span', { class: 'tag tag-warn' },'Transferred');
    if (s === 'cancelled')   return h('span', { class: 'tag tag-crit' },'Cancelled');
    return h('span', { class: 'tag' }, s || '—');
}
function kv(k, v) {
    return h('div', null,
        h('div', { class: 'muted', style: { fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 } }, k),
        h('div', { style: { fontSize: '14px', color: 'var(--ink-900)', marginTop: '2px' } }, v),
    );
}
function displayName(p) {
    if (!p) return '(unknown)';
    return [p.last_name, p.first_name].filter(Boolean).join(' ').trim() || p.full_name || '(unknown)';
}
function formatDateTime(d) {
    if (!d) return '—';
    const dt = new Date(d);
    if (isNaN(dt.getTime())) return '—';
    return dt.toLocaleDateString(undefined, { day: '2-digit', month: 'short' }) + ' ' +
           dt.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}
function lengthOfStay(admittedAt) {
    if (!admittedAt) return '';
    const ms = Date.now() - new Date(admittedAt).getTime();
    if (!Number.isFinite(ms) || ms < 0) return '';
    const h = ms / 3600000;
    if (h < 24) return Math.round(h) + ' h';
    return Math.floor(h / 24) + ' d';
}


// ===========================================================================
// DRUGS_NURSE_V1 — «Назначения» (для медсестры стационара).
// Left: the doctor's prescriptions for this patient (pulled from consultation
// payloads, latest first) with the stationary instruction. «Выполнено» records
// the administration in med_administrations; the journal renders below.
// ===========================================================================
function medsTab(state) {
    const adm = state.admission || {};
    const root = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '16px' } },
        h('div', { class: 'muted', style: { padding: '20px', textAlign: 'center' } }, 'Загрузка назначений…'));

    (async () => {
        const pid = adm.patient_id;
        let orders = [], log = [];
        // INPATIENT_RX_V1 — стационарные назначения, выписанные врачом прямо в
        // этом окне (admission_prescriptions, mig 105). Идут ПЕРВЫМИ в списке.
        try {
            const { data: apx, error: apxErr } = await supabase.from('admission_prescriptions')
                .select('id, name, dose, freq, dur, nurse_notes, prescribed_by_name, created_at')
                .eq('admission_id', adm.id).eq('active', true)
                .order('created_at', { ascending: false }).limit(100);
            if (!apxErr) for (const r of (apx || [])) orders.push({
                name: r.name, dose: r.dose, freq: [r.freq, r.dur].filter(Boolean).join(' · '),
                nurse: r.nurse_notes, srcDate: String(r.created_at || '').slice(0, 10),
                _apId: r.id, _by: r.prescribed_by_name,
            });
            else if (!/does not exist|schema cache/i.test(apxErr.message || '')) console.warn('[meds] admission_rx', apxErr.message);
        } catch (e) { console.warn('[meds] admission_rx', e.message); }
        try {
            const { data } = await supabase.from('visit_services')
                .select('notes, created_at, visits!inner(patient_id)')
                .eq('visits.patient_id', pid)
                .not('notes', 'is', null)
                .order('created_at', { ascending: false })
                .limit(50);
            for (const r of (data || [])) {
                try {
                    const p = JSON.parse(r.notes);
                    if (p && p.__service_workspace_v1 === 1 && Array.isArray(p.prescriptions)) {
                        for (const rx of p.prescriptions) {
                            if (rx && rx.name) orders.push({ ...rx, srcDate: String(r.created_at || '').slice(0, 10) });
                        }
                    }
                } catch (e) { /* not a workspace payload */ }
            }
        } catch (e) { console.warn('[meds] orders', e.message); }
        try {
            const { data } = await supabase.from('med_administrations')
                .select('*').eq('admission_id', adm.id)
                .order('administered_at', { ascending: false }).limit(100);
            log = data || [];
        } catch (e) { console.warn('[meds] log', e.message); }

        clear(root);
        // ---- doctor's orders ----
        const ordersCard = h('div', { class: 'card' });
        // INPATIENT_RX_V1 — «+ Назначение»: врач выписывает препарат прямо здесь.
        const addRxBtn = h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => {
            const f = {
                name:  h('input', { class: 'tp-input', placeholder: 'Препарат *', style: { width: '100%' } }),
                dose:  h('input', { class: 'tp-input', placeholder: 'Доза (напр. 500 мг)', style: { width: '100%' } }),
                freq:  h('input', { class: 'tp-input', placeholder: 'Частота (напр. 2 раза в день)', style: { width: '100%' } }),
                dur:   h('input', { class: 'tp-input', placeholder: 'Длительность (напр. 5 дней)', style: { width: '100%' } }),
                nurse: h('input', { class: 'tp-input', placeholder: 'Инструкция медсестре', style: { width: '100%' } }),
            };
            const ov2 = h('div', { class: 'modal', style: { zIndex: '180' } });
            ov2.appendChild(h('div', { class: 'modal-backdrop', onclick: () => ov2.remove() }));
            const save = async (btn) => {
                const name = f.name.value.trim();
                if (!name) { toast('Укажите препарат.', 'fail'); return; }
                btn.disabled = true;
                const u = (window.easymed && window.easymed.state && window.easymed.state.user) || {};
                const ins = {
                    admission_id: adm.id, patient_id: pid, name,
                    dose: f.dose.value.trim() || null, freq: f.freq.value.trim() || null,
                    dur: f.dur.value.trim() || null, nurse_notes: f.nurse.value.trim() || null,
                    prescribed_by: u.id || null, prescribed_by_name: u.full_name || null,
                    active: true,
                };
                if (window.CLINIC && window.CLINIC.id) ins.company_id = window.CLINIC.id;
                const { error } = await supabase.from('admission_prescriptions').insert(ins);
                if (error) {
                    const msg = /does not exist|schema cache/i.test(error.message || '') ? tr('Примените миграцию 105 в Supabase SQL editor.') : error.message;
                    toast(trf('Назначение не сохранено: {msg}', { msg }), 'fail'); btn.disabled = false; return;
                }
                toast(trf('Назначение добавлено: {name}', { name }));
                ov2.remove();
                clear(root); root.appendChild(medsTab(state));
            };
            ov2.appendChild(h('div', { class: 'modal-card', style: { width: '420px', maxWidth: 'calc(100vw - 32px)' } },
                h('header', { class: 'modal-head' }, h('h2', null, 'Новое назначение'),
                    h('button', { class: 'modal-close', onclick: () => ov2.remove() }, '×')),
                h('div', { class: 'modal-body', style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
                    f.name, f.dose, f.freq, f.dur, f.nurse),
                h('footer', { class: 'modal-foot' },
                    h('button', { class: 'btn', onclick: () => ov2.remove() }, 'Отмена'),
                    h('button', { class: 'btn btn-primary', onclick: (e) => save(e.currentTarget) }, 'Сохранить'))));
            document.body.appendChild(ov2);
            setTimeout(() => f.name.focus(), 50);
        } }, Icon('Plus', { size: 13 }), ' Назначение');
        ordersCard.appendChild(h('div', { class: 'card-header' },
            h('h3', null, Icon('Pill', { size: 15 }), ' Назначения врача'),
            h('span', { class: 'muted', style: { fontSize: '11.5px', marginLeft: 'auto' } }, 'стационарные и из консультаций'),
            addRxBtn));
        const ob = h('div', { class: 'card-pad', style: { display: 'flex', flexDirection: 'column', gap: '8px' } });
        if (!orders.length) {
            ob.appendChild(h('div', { class: 'empty', style: { padding: '24px' } },
                'Назначений нет — нажмите «+ Назначение» выше или добавьте в рабочем месте приёма (карточка «Рецепты»).'));
        } else {
            for (const rx of orders) {
                const doneBtn = h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: async (ev) => {
                    ev.currentTarget.disabled = true;
                    try {
                        const u = (typeof window !== 'undefined' && window.easymed && window.easymed.state && window.easymed.state.user) || {};
                        const { error } = await supabase.from('med_administrations').insert({
                            admission_id: adm.id, patient_id: pid,
                            med_name: rx.name, dose: rx.dose || null,
                            instructions: rx.nurse || rx.freq || null,
                            administered_by: u.id || null,
                            administered_by_name: u.full_name || 'Медсестра',
                        });
                        if (error) throw error;
                        toast(trf('Отмечено: {name}', { name: rx.name }));
                        clear(root);
                        root.appendChild(medsTab(state));   // re-render with fresh journal
                    } catch (e) {
                        toast(trf('Не удалось записать: {msg}', { msg: e.message || e }), 'fail');
                        if (ev.currentTarget?.isConnected) ev.currentTarget.disabled = false;
                    }
                } }, Icon('Check', { size: 13 }), ' Выполнено');
                // RX_DISPENSE_V1 — dispense this Rx from clinic stock: atomic
                // bill+stock via dispense_admission_item, then journal entry.
                const giveBtn = h('button', { class: 'btn btn-outline btn-sm', type: 'button',
                    title: 'Выдать со склада — спишет остаток и добавит в счёт', onclick: () => {
                    openItemPickerModal({
                        title: trf('Выдать: {name}', { name: rx.name }),
                        confirmLabel: 'Выдать',
                        initialSearch: rx.name,
                        // DISPENSE_MULTI_V1 — dispense each cart line (usually the
                        // one prefilled Rx item) with its own atomic RPC.
                        onConfirm: async (lines) => {
                            let ok = 0; const fails = [];
                            const u = (typeof window !== 'undefined' && window.easymed && window.easymed.state && window.easymed.state.user) || {};
                            for (const { item, qty } of lines) {
                                try {
                                    const { data, error } = await supabase.rpc('dispense_admission_item', {
                                        p_admission_id: adm.id, p_item_id: item.id, p_qty: Number(qty),
                                        p_doctor_id: adm.attending_doctor_id || null });
                                    if (error) throw error;
                                    const res = Array.isArray(data) ? data[0] : data;
                                    const nm = res?.item_name || item.name;
                                    ok++;
                                    try {
                                        await supabase.from('med_administrations').insert({
                                            admission_id: adm.id, patient_id: pid,
                                            med_name: nm, dose: rx.dose || null,
                                            instructions: rx.nurse || rx.freq || null,
                                            administered_by: u.id || null,
                                            administered_by_name: u.full_name || 'Медсестра',
                                        });
                                    } catch (e) { console.warn('[rx-dispense] journal', e); }
                                    if (res && Number(res.on_hand) <= 0) {
                                        toast(trf('Внимание: остаток теперь {n}.', { n: Number(res.on_hand).toLocaleString('ru-RU') }), 'fail');
                                    }
                                } catch (err) { fails.push(`${item.name}: ${err?.message || err}`); }
                            }
                            if (ok === 0) throw new Error(fails[0] || 'Не удалось выдать');
                            toast(trf('Выдано и записано: {n}', { n: ok }) + (fails.length ? ' · ' + trf('ошибок: {n}', { n: fails.length }) : ''));
                            if (fails.length) toast(fails.join('; '), 'fail');
                            clear(root);
                            root.appendChild(medsTab(state));
                        },
                    });
                } }, Icon('Pill', { size: 13 }), ' Выдать');
                // INPATIENT_RX_V1 — стационарные назначения можно отменить (active=false).
                const cancelBtn = rx._apId ? h('button', { class: 'btn btn-outline btn-sm', type: 'button', title: 'Отменить назначение',
                    style: { color: 'var(--crit-600, #dc2626)' },
                    onclick: async (ev) => {
                        ev.currentTarget.disabled = true;
                        const { error } = await supabase.from('admission_prescriptions').update({ active: false }).eq('id', rx._apId);
                        if (error) { toast(error.message, 'fail'); if (ev.currentTarget?.isConnected) ev.currentTarget.disabled = false; return; }
                        toast(trf('Назначение отменено: {name}', { name: rx.name }));
                        clear(root); root.appendChild(medsTab(state));
                    } }, '×') : null;
                ob.appendChild(h('div', { class: 'row', style: { padding: '10px 12px', background: 'var(--primary-50)', border: '1px solid var(--primary-200)', borderRadius: '9px', gap: '12px', alignItems: 'center' } },
                    Icon('Pill', { size: 15 }),
                    h('div', { style: { flex: 1, minWidth: 0 } },
                        h('div', { style: { fontWeight: 600, fontSize: '13px' } },
                            rx.name, rx.dose ? h('span', { class: 'muted', style: { fontWeight: 500 } }, ' · ' + rx.dose) : null,
                            h('span', { class: 'muted', style: { fontWeight: 400, fontSize: '11px', marginLeft: '8px' } }, rx.srcDate || ''),
                            rx._by ? h('span', { class: 'muted', style: { fontWeight: 400, fontSize: '11px', marginLeft: '6px' } }, '· ' + rx._by) : null),
                        rx.freq && h('div', { class: 'muted', style: { fontSize: '11.5px' } }, rx.freq),
                        rx.nurse && h('div', { style: { fontSize: '12px', color: 'var(--warn-700, #b45309)', marginTop: '2px', fontWeight: 600 } }, trf('Медсестре: {name}', { name: rx.nurse })),
                    ),
                    giveBtn, doneBtn, cancelBtn));
            }
        }
        ordersCard.appendChild(ob);
        root.appendChild(ordersCard);

        // ---- administration journal ----
        const logCard = h('div', { class: 'card' });
        logCard.appendChild(h('div', { class: 'card-header' },
            h('h3', null, Icon('Clock', { size: 15 }), ' Журнал выполнений'),
            h('span', { class: 'h-count' }, log.length ? String(log.length) : '')));
        const lb = h('div', { class: 'card-pad', style: { display: 'flex', flexDirection: 'column', gap: '6px' } });
        if (!log.length) {
            lb.appendChild(h('div', { class: 'muted', style: { padding: '14px', fontSize: '12.5px' } }, 'Пока ничего не выполнено.'));
        } else {
            for (const m of log) {
                const t = String(m.administered_at || '').replace('T', ' ').slice(0, 16);
                lb.appendChild(h('div', { class: 'row', style: { gap: '10px', padding: '7px 10px', borderBottom: '1px solid var(--ink-100)', fontSize: '12.5px', alignItems: 'baseline' } },
                    h('span', { class: 'muted', style: { flex: '0 0 auto', fontSize: '11.5px' } }, t),
                    h('span', { style: { fontWeight: 600 } }, m.med_name, m.dose ? ' · ' + m.dose : ''),
                    m.instructions && h('span', { class: 'muted', style: { fontSize: '11.5px' } }, m.instructions),
                    h('span', { class: 'muted', style: { marginLeft: 'auto', fontSize: '11.5px' } }, m.administered_by_name || '')));
            }
        }
        logCard.appendChild(lb);
        root.appendChild(logCard);
    })();

    return root;
}
