// Visits — VISITS_V1 — money-free scheduling view + "Book visit" modal.
// Local mode has no services catalog / billing yet, so this view only tracks
// WHO is coming WHEN: patient, doctor (optional), date & time, visit type,
// status. Mirrors public/js/admin/views/patients.js for structure (mount /
// fetchAndPaint / DOM-building via h()) and the modal chrome that
// patients.js's openMergeModal() uses (.modal / .modal-backdrop / .modal-card
// / .modal-head / .modal-close / .modal-body / .modal-foot — there is no
// shared modal() helper in ui.js, every view builds its own overlay with
// those classes). The registrar-header.js "Find existing patient" fan-out
// search in registration.js's runPatientSearch() is reused (the local client
// has no `.or()`, so each field gets its own `.ilike()` call, deduped by id).

import { supabase } from '../../supabase.js';
import { h, Icon, clear, toast, StatusTag, fmtDateTime, field } from '../ui.js';
import { openVisitBillModal } from './visit-bill.js';

const refs = {
    container: null,
    onNavigate: null,
    tbody:      null,
    emptyEl:    null,
    totalEl:    null,
};

// Resolved once per page session (first active branch) — see resolveBranchId().
let _cachedBranchId; // undefined = not resolved yet; null = none found

export async function renderVisits(container, { onNavigate } = {}) {
    refs.container  = container;
    refs.onNavigate = onNavigate;
    mount();
    await fetchAndPaint();
}

// -----------------------------------------------------------------------------
// MOUNT — static shell; fetchAndPaint() repaints just the tbody.
// -----------------------------------------------------------------------------
function mount() {
    clear(refs.container);

    refs.tbody = h('tbody');
    refs.emptyEl = h('div', { class: 'empty', style: { display: 'none' } },
        'No visits yet — book the first one.');
    refs.totalEl = h('span', { class: 'muted', style: { fontSize: '12.5px' } }, '');

    const bookBtn = h('button', {
        class: 'btn btn-primary btn-sm', type: 'button',
        onclick: () => openBookVisitModal(fetchAndPaint),
    }, Icon('Plus', { size: 14 }), ' Book visit');

    refs.container.appendChild(h('div', { class: 'fade-in' },
        h('div', { class: 'page-head' },
            h('div', null,
                h('h1', { class: 'page-title' }, 'Visits'),
                refs.totalEl,
            ),
            h('div', { class: 'page-head-actions' }, bookBtn),
        ),
        h('div', { class: 'card' },
            h('table', { class: 'tbl' },
                h('thead', null, h('tr', null,
                    h('th', null, 'Date/Time'),
                    h('th', null, 'Patient'),
                    h('th', null, 'Doctor'),
                    h('th', null, 'Type'),
                    h('th', null, 'Status'),
                )),
                refs.tbody,
            ),
            refs.emptyEl,
        ),
    ));
}

// -----------------------------------------------------------------------------
// FETCH + REPAINT
// -----------------------------------------------------------------------------
let lastFetchToken = 0;

async function fetchAndPaint() {
    const token = ++lastFetchToken;
    setLoadingRow();
    try {
        const { data, error, count } = await supabase.from('visits')
            .select('*, patients(full_name,mrn,phone), doctor(full_name)', { count: 'exact' })
            .order('visit_date', { ascending: true })
            .limit(200);
        if (token !== lastFetchToken) return;   // a newer fetch already landed
        if (error) {
            toast('Failed to load visits: ' + (error.message || error), 'fail');
            paintRows([]);
            return;
        }
        paintRows(data || []);
        if (refs.totalEl) refs.totalEl.textContent = count != null ? `${count} visit${count === 1 ? '' : 's'}` : '';
    } catch (e) {
        if (token !== lastFetchToken) return;
        toast('Failed to load visits: ' + (e && e.message || e), 'fail');
        paintRows([]);
    }
}

function setLoadingRow() {
    if (!refs.tbody) return;
    clear(refs.tbody);
    refs.tbody.appendChild(h('tr', null,
        h('td', { colspan: '5', style: { textAlign: 'center', padding: '24px', color: 'var(--ink-500)', fontSize: '12.5px' } }, 'Loading…'),
    ));
    refs.emptyEl.style.display = 'none';
}

function paintRows(rows) {
    clear(refs.tbody);
    if (!rows || rows.length === 0) {
        refs.emptyEl.style.display = '';
        return;
    }
    refs.emptyEl.style.display = 'none';
    for (const v of rows) refs.tbody.appendChild(visitRow(v));
}

function visitRow(v) {
    const p = v.patients;
    const doc = v.doctor;
    return h('tr', {
        class: 'row-click',
        style: { cursor: 'pointer' },
        onclick: () => openVisitBillModal(v, fetchAndPaint),
    },
        h('td', { class: 'num', style: { fontSize: '12.5px' } }, fmtDateTime(v.visit_date)),
        h('td', null,
            h('div', { class: 'cell-strong' }, p ? (p.full_name || '—') : '—'),
            p && p.mrn ? h('div', { class: 'muted', style: { fontSize: '12.5px' } }, p.mrn) : null,
        ),
        h('td', null, doc ? (doc.full_name || '—') : '—'),
        h('td', null, v.visit_type || '—'),
        h('td', null, StatusTag(v.status)),
    );
}

// -----------------------------------------------------------------------------
// BOOK VISIT MODAL
// -----------------------------------------------------------------------------
function currentUserId() {
    try { return (window.easymed && window.easymed.state && window.easymed.state.user && window.easymed.state.user.id) || null; }
    catch (e) { return null; }
}

async function resolveBranchId() {
    if (_cachedBranchId !== undefined) return _cachedBranchId;
    try {
        const { data, error } = await supabase.from('branches').select('id').eq('active', true).order('id').limit(1);
        _cachedBranchId = (!error && data && data[0]) ? data[0].id : null;
    } catch (e) {
        _cachedBranchId = null;
    }
    return _cachedBranchId;
}

// Fan-out patient search — same pattern as registration.js's runPatientSearch:
// the local client has no `.or()`, so each searchable column gets its own
// `.ilike()` call, results deduped by id.
async function searchPatients(term) {
    const t = (term || '').trim();
    if (t.length < 2) return [];
    const fields = ['full_name', 'phone', 'mrn'];
    const cols   = 'id, full_name, mrn, phone';
    const seen   = new Set();
    const rows   = [];
    await Promise.all(fields.map(async (f) => {
        try {
            const { data } = await supabase.from('patients').select(cols).ilike(f, '%' + t + '%').limit(8);
            for (const r of (data || [])) if (!seen.has(r.id)) { seen.add(r.id); rows.push(r); }
        } catch (e) { /* column/table hiccup — skip this field */ }
    }));
    return rows;
}

async function loadDoctorOptions(selectEl) {
    try {
        const { data, error } = await supabase.from('users')
            .select('id, full_name, username, role, is_active')
            .eq('role', 'doctor')
            .eq('is_active', true)
            .order('full_name');
        if (error) throw error;
        for (const u of (data || [])) {
            selectEl.appendChild(h('option', { value: u.id }, u.full_name || u.username || ('User ' + u.id)));
        }
    } catch (e) {
        console.warn('[visits] doctors load failed', e && e.message || e);
    }
}

// preselectPatient (optional): { id, full_name, mrn, ... } — when provided,
// the modal opens with that patient already locked in (patient search is
// hidden) so it can be launched from a patient's own Visits card, where who
// the visit is for is already known. When null, behaves exactly as before
// (the standalone Visits view's own "Book visit" button — search-based).
export function openBookVisitModal(onSaved, preselectPatient = null) {
    const dialogState = { patient: preselectPatient || null };

    const overlay = h('div', { class: 'modal' });
    const close = () => overlay.remove();
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));

    // ---- Patient search ----
    const searchInp = h('input', { type: 'text', autocomplete: 'off',
        placeholder: 'Search by name, phone, or MRN…' });
    const resultsEl = h('div', { style: {
        display: 'none', border: '1px solid var(--ink-200)', borderRadius: '8px',
        marginTop: '4px', maxHeight: '180px', overflowY: 'auto' } });
    const selectedEl = h('div', { style: {
        display: 'none', alignItems: 'center', gap: '8px',
        padding: '8px 12px', border: '1px solid var(--primary-300, #93c5fd)', borderRadius: '8px',
        background: 'var(--primary-50, #eff6ff)', marginTop: '4px' } });

    let searchTimer = null;
    searchInp.addEventListener('input', () => {
        clearTimeout(searchTimer);
        const term = searchInp.value;
        searchTimer = setTimeout(async () => {
            if (term.trim().length < 2) { clear(resultsEl); resultsEl.style.display = 'none'; return; }
            const rows = await searchPatients(term);
            clear(resultsEl);
            if (rows.length === 0) {
                resultsEl.appendChild(h('div', {
                    style: { padding: '10px 12px', fontSize: '12.5px', color: 'var(--ink-500)' },
                }, 'No matches.'));
            } else {
                for (const p of rows.slice(0, 10)) {
                    resultsEl.appendChild(h('button', {
                        type: 'button',
                        style: { display: 'block', width: '100%', textAlign: 'left', padding: '8px 12px',
                            border: '0', borderBottom: '1px solid var(--ink-100)', background: 'white', cursor: 'pointer' },
                        onclick: () => selectPatient(p),
                    }, [p.full_name || '—', p.mrn, p.phone].filter(Boolean).join(' · ')));
                }
            }
            resultsEl.style.display = '';
        }, 250);
    });

    function selectPatient(p) {
        dialogState.patient = p;
        searchInp.value = '';
        clear(resultsEl);
        resultsEl.style.display = 'none';
        clear(selectedEl);
        selectedEl.style.display = 'flex';
        selectedEl.append(
            h('span', null, [p.full_name || '—', p.mrn].filter(Boolean).join(' · ')),
            h('span', { class: 'grow' }),
            // Preselected flow: the patient is fixed (opened from their own
            // page) — no clear affordance, since the search box is hidden and
            // there'd be no way to pick a different patient afterwards.
            preselectPatient ? null : h('button', { type: 'button', class: 'icon-btn btn-sm', title: 'Clear', onclick: clearPatient }, Icon('X', { size: 12 })),
        );
    }
    function clearPatient() {
        dialogState.patient = null;
        selectedEl.style.display = 'none';
        clear(selectedEl);
    }

    // Patient fixed by the caller — lock it in and hide the search UI.
    if (preselectPatient) {
        selectPatient(preselectPatient);
        searchInp.style.display = 'none';
    }

    // ---- Doctor ----
    const doctorSelect = h('select', null,
        h('option', { value: '' }, '— Unassigned —'));
    loadDoctorOptions(doctorSelect);

    // ---- Date & time ----
    const dtInput = h('input', { type: 'datetime-local', required: true });

    // ---- Visit type ----
    const typeSelect = h('select', null,
        h('option', { value: 'outpatient', selected: true }, 'Outpatient'),
        h('option', { value: 'emergency' }, 'Emergency'),
        h('option', { value: 'inpatient' }, 'Inpatient'),
    );

    // ---- Notes ----
    const notesInput = h('textarea', { rows: '3', placeholder: 'Notes (optional)' });

    const saveBtn = h('button', { class: 'btn btn-primary', type: 'button' }, 'Book visit');
    saveBtn.addEventListener('click', save);

    async function save() {
        if (!dialogState.patient) { toast('Select a patient first.', 'fail'); return; }
        if (!dtInput.value)       { toast('Choose a date and time.', 'fail'); return; }

        saveBtn.disabled = true;
        const prevLabel = saveBtn.textContent;
        saveBtn.textContent = 'Booking…';
        try {
            const payload = {
                patient_id:       dialogState.patient.id,
                visit_date:       new Date(dtInput.value).toISOString(),
                duration_minutes: 30,
                visit_type:       typeSelect.value,
                status:           'scheduled',
            };
            if (doctorSelect.value) payload.doctor_id = Number(doctorSelect.value);
            if (notesInput.value.trim()) payload.notes = notesInput.value.trim();
            const branchId = await resolveBranchId();
            if (branchId != null) payload.branch_id = branchId;
            const uid = currentUserId();
            if (uid != null) payload.created_by = uid;

            const { error } = await supabase.from('visits').insert(payload).select().single();
            if (error) throw error;

            toast('Visit booked', 'ok');
            close();
            if (typeof onSaved === 'function') await onSaved();
        } catch (e) {
            toast('Failed to book visit: ' + (e && e.message || e), 'fail');
            saveBtn.disabled = false;
            saveBtn.textContent = prevLabel;
        }
    }

    overlay.appendChild(h('div', { class: 'modal-card modal-compact', style: { width: '480px', maxWidth: 'calc(100vw - 32px)' } },
        h('header', { class: 'modal-head' },
            h('h2', null, Icon('Calendar', { size: 16 }), ' Book visit'),
            h('button', { class: 'modal-close', onclick: close }, '×')),
        h('div', { class: 'modal-body' },
            field('Patient', h('div', null, searchInp, resultsEl, selectedEl)),
            field('Doctor', doctorSelect),
            field('Date & time', dtInput, { required: true }),
            field('Visit type', typeSelect),
            field('Notes', notesInput),
        ),
        h('footer', { class: 'modal-foot' },
            h('button', { class: 'btn', type: 'button', onclick: close }, 'Cancel'),
            h('span', { class: 'grow' }),
            saveBtn),
    ));
    document.body.appendChild(overlay);
    (preselectPatient ? dtInput : searchInp).focus();
}
