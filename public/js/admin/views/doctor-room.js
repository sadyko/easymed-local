// Doctor's room (Кабинет врача) — DOCTOR_ROOM_V1. The doctor's clinical
// workspace: their visit queue, then conduct the consultation — advance the
// visit status, write a conclusion/diagnosis, and order services (which flow to
// Bill & Pay / the Cashier). Money is NOT computed here; ordering only creates
// visit_services rows (priced authoritatively later by the billing RPC). A
// doctor sees only their own visits (scoped by doctor_id); admins/registrars
// see everyone. All writes go through the allow-list (/api/db): visits update
// (status/conclusion) and visit_services insert are permitted for the doctor.

import { supabase } from '../../supabase.js';
import { h, Icon, clear, toast, Tag, field, fmtDateTime, initials } from '../ui.js';

const VISIT_STATUSES = { scheduled: 'Scheduled', confirmed: 'Confirmed', arrived: 'Arrived', cancelled: 'Cancelled', no_show: 'No-show' };
const CONCLUSION_TYPES = [['consultation', 'Consultation'], ['diagnostic', 'Diagnostic']];

function me() { return (typeof window !== 'undefined' && window.easymed && window.easymed.state && window.easymed.state.user) || {}; }
function myId() { const u = me(); return u.id || null; }
function isAdminActor() { const u = me(); return !!(u.is_admin || u.is_super_admin); }
function scopeDoctorId() { const u = me(); if (isAdminActor()) return null; return u.is_doctor ? (u.id || null) : null; }
function fmtPrice(n) { const v = Math.round(Number(n) || 0); return (v < 0 ? '-' : '') + String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ' '); }

let state = { filter: 'all' };

export async function renderDoctorRoom(container) {
    clear(container);
    state = { filter: 'all' };
    const root = h('div', { class: 'fade-in' });
    container.appendChild(root);
    await paint(root);
}

async function paint(root) {
    clear(root);
    const scoped = scopeDoctorId();
    root.appendChild(h('div', { class: 'page-head' },
        h('div', null,
            h('h1', { class: 'page-title' }, "Doctor's room"),
            h('p', { class: 'page-subtitle' }, scoped ? 'Your consultation queue — see a patient, write a conclusion, order services.' : 'Consultation queue across all doctors.'),
        ),
        h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => newConsultationModal(root) }, Icon('Plus', { size: 14 }), ' New consultation'),
    ));

    let rows = [];
    try {
        let q = supabase.from('visits').select('*, patients(mrn, full_name), doctor(full_name)');
        if (scoped) q = q.eq('doctor_id', scoped);
        const { data, error } = await q.order('visit_date', { ascending: false }).limit(80);
        if (error) throw error;
        rows = data || [];
    } catch (e) {
        root.appendChild(h('div', { class: 'card', style: { padding: '18px' } }, h('div', { class: 'empty' }, 'Could not load: ' + ((e && e.message) || e))));
        return;
    }

    // Filter tabs
    const waiting = (v) => ['scheduled', 'confirmed', 'arrived'].includes(v.status);
    const seen = (v) => (v.conclusion || '').trim() !== '';
    const counts = { all: rows.length, waiting: rows.filter(waiting).length, seen: rows.filter(seen).length };
    const seg = h('div', { class: 'segmented', style: { marginBottom: '14px' } });
    for (const [key, label] of [['all', 'All'], ['waiting', 'Waiting'], ['seen', 'Seen']]) {
        seg.appendChild(h('button', { class: 'segmented-btn' + (state.filter === key ? ' on' : ''), type: 'button', onclick: () => { state.filter = key; paint(root); } }, label + ' · ' + counts[key]));
    }
    root.appendChild(seg);

    let shown = rows;
    if (state.filter === 'waiting') shown = rows.filter(waiting);
    else if (state.filter === 'seen') shown = rows.filter(seen);

    const admin = isAdminActor() || scoped === null;
    const tbody = h('tbody');
    const card = h('div', { class: 'card' },
        h('div', { class: 'card-header' }, h('h3', null, Icon('Stethoscope', { size: 16 }), ' Consultation queue')),
        h('table', { class: 'tbl' },
            h('thead', null, h('tr', null,
                h('th', null, 'When'), h('th', null, 'Patient'),
                admin ? h('th', null, 'Doctor') : null,
                h('th', null, 'Status'), h('th', null, 'Seen'), h('th', null, ''),
            )),
            tbody,
        ),
    );
    if (!shown.length) {
        tbody.appendChild(h('tr', null, h('td', { colspan: admin ? '6' : '5', style: { textAlign: 'center', padding: '22px', color: 'var(--ink-500)' } },
            rows.length ? 'Nothing in this filter.' : 'No visits yet — start one with “New consultation”.')));
    } else {
        for (const v of shown) {
            const p = v.patients || {};
            tbody.appendChild(h('tr', {
                class: 'row-click', style: { cursor: 'pointer' }, onclick: () => consultationModal(v, root),
            },
                h('td', null, fmtDateTime(v.visit_date)),
                h('td', null,
                    h('span', { style: { fontWeight: 600 } }, p.full_name || '—'),
                    p.mrn ? h('span', { class: 'muted', style: { fontSize: '11px', marginLeft: '6px' } }, p.mrn) : null),
                admin ? h('td', null, (v.doctor && v.doctor.full_name) || '—') : null,
                h('td', null, Tag(VISIT_STATUSES[v.status] || v.status, { kind: v.status === 'arrived' ? 'ok' : (v.status === 'cancelled' || v.status === 'no_show' ? 'crit' : ''), dot: true })),
                h('td', null, (v.conclusion || '').trim() ? Icon('Check', { size: 15 }) : h('span', { class: 'muted' }, '—')),
                h('td', { style: { textAlign: 'right' } }, h('button', { class: 'btn btn-outline btn-sm', type: 'button' }, 'Open')),
            ));
        }
    }
    root.appendChild(card);
}

// ---------------------------------------------------------------------------
// Consultation panel (per visit)
// ---------------------------------------------------------------------------
function consultationModal(visit, root) {
    const p = visit.patients || {};
    const overlay = h('div', { class: 'modal' });
    let dirty = false;   // set when status/conclusion changed → refresh the queue on close
    const close = () => { overlay.remove(); if (dirty) paint(root); };
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));

    // --- status controls ---
    const statusWrap = h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } });
    const setStatus = async (status) => {
        const { error } = await supabase.from('visits').update({ status }).eq('id', visit.id).select().single();
        if (error) { toast(error.message || 'Failed to update status.', 'fail'); return; }
        visit.status = status; toast('Status: ' + (VISIT_STATUSES[status] || status), 'ok');
        renderStatus(); dirty = true;
    };
    const renderStatus = () => {
        clear(statusWrap);
        statusWrap.appendChild(h('span', { class: 'muted', style: { fontSize: '12px', alignSelf: 'center' } }, 'Status: ', h('strong', null, VISIT_STATUSES[visit.status] || visit.status)));
        if (visit.status !== 'arrived') statusWrap.appendChild(h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: () => setStatus('arrived') }, 'Mark arrived'));
        if (visit.status !== 'no_show') statusWrap.appendChild(h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: () => setStatus('no_show') }, 'No-show'));
        if (visit.status !== 'cancelled') statusWrap.appendChild(h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: () => setStatus('cancelled') }, 'Cancel'));
    };
    renderStatus();

    // --- conclusion ---
    const typeSel = h('select', null, ...CONCLUSION_TYPES.map(([v, l]) => h('option', { value: v, selected: (visit.conclusion_type || 'consultation') === v }, l)));
    const conclInp = h('textarea', { rows: '4', style: { width: '100%', resize: 'vertical' }, placeholder: 'Conclusion / diagnosis…' });
    conclInp.value = visit.conclusion || '';
    const saveConcl = h('button', { class: 'btn btn-primary btn-sm', type: 'button' }, 'Save conclusion');
    saveConcl.addEventListener('click', async () => {
        saveConcl.disabled = true;
        const { error } = await supabase.from('visits').update({ conclusion: conclInp.value, conclusion_type: typeSel.value }).eq('id', visit.id).select().single();
        saveConcl.disabled = false;
        if (error) { toast(error.message || 'Failed to save.', 'fail'); return; }
        visit.conclusion = conclInp.value; visit.conclusion_type = typeSel.value;
        toast('Conclusion saved', 'ok'); dirty = true;
    });

    // --- ordered services ---
    const svcBody = h('tbody');
    const loadServices = async () => {
        clear(svcBody);
        svcBody.appendChild(h('tr', null, h('td', { colspan: '3', style: { textAlign: 'center', padding: '10px', color: 'var(--ink-500)' } }, 'Loading…')));
        const { data, error } = await supabase.from('visit_services').select('*, services(name)').eq('visit_id', visit.id).order('id');
        clear(svcBody);
        if (error) { svcBody.appendChild(h('tr', null, h('td', { colspan: '3', style: { color: 'var(--crit-600)', padding: '10px' } }, error.message))); return; }
        if (!data || !data.length) { svcBody.appendChild(h('tr', null, h('td', { colspan: '3', style: { textAlign: 'center', padding: '10px', color: 'var(--ink-500)' } }, 'No services ordered yet.'))); return; }
        for (const vs of data) {
            svcBody.appendChild(h('tr', null,
                h('td', null, (vs.services && vs.services.name) || ('#' + vs.service_id)),
                h('td', { style: { textAlign: 'right' } }, String(vs.quantity)),   // DOC_NO_MONEY_V1 — цены врачу не показываем
                h('td', null, Tag(vs.status || 'added', { dot: true })),
            ));
        }
    };

    const orderBtn = h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: () => orderServiceModal(visit, loadServices) }, Icon('Plus', { size: 13 }), ' Order service');

    overlay.appendChild(h('div', { class: 'modal-card', style: { width: '600px', maxWidth: 'calc(100vw - 32px)' } },
        h('header', { class: 'modal-head' },
            h('h2', null, Icon('Stethoscope', { size: 16 }), ' Consultation · ', p.full_name || 'Patient'),
            h('button', { class: 'modal-close', onclick: close }, '×')),
        h('div', { class: 'modal-body' },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px' } },
                h('span', { style: { width: '34px', height: '34px', borderRadius: '50%', background: 'var(--primary-600, #1f7a72)', color: '#fff', fontSize: '12px', fontWeight: 700, display: 'grid', placeItems: 'center' } }, initials(p.full_name || '?')),
                h('div', null, h('div', { style: { fontWeight: 700 } }, p.full_name || '—'), h('div', { class: 'muted', style: { fontSize: '11.5px' } }, (p.mrn ? p.mrn + ' · ' : '') + fmtDateTime(visit.visit_date))),
            ),
            statusWrap,
            h('div', { style: { borderTop: '1px solid var(--ink-100)', margin: '12px 0', paddingTop: '10px' } },
                h('div', { class: 'muted', style: { fontSize: '11px', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: '6px' } }, 'Conclusion'),
                field('Type', typeSel),
                conclInp,
                h('div', { style: { marginTop: '8px' } }, saveConcl),
            ),
            h('div', { style: { borderTop: '1px solid var(--ink-100)', margin: '12px 0', paddingTop: '10px' } },
                h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' } },
                    h('div', { class: 'muted', style: { fontSize: '11px', textTransform: 'uppercase', letterSpacing: '.04em' } }, 'Ordered services'),
                    orderBtn),
                h('table', { class: 'tbl' },
                    h('thead', null, h('tr', null, h('th', null, 'Service'), h('th', { style: { textAlign: 'right' } }, 'Qty'), h('th', null, 'Status'))),
                    svcBody),
            ),
        ),
        h('footer', { class: 'modal-foot' }, h('span', { class: 'grow' }), h('button', { class: 'btn', type: 'button', onclick: close }, 'Close')),
    ));
    document.body.appendChild(overlay);
    loadServices();
}

// Service picker — pick a catalog service to order onto the visit.
function orderServiceModal(visit, onOrdered) {
    const overlay = h('div', { class: 'modal' });
    const close = () => overlay.remove();
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));
    const searchInp = h('input', { type: 'text', placeholder: 'Search services…', autocomplete: 'off' });
    const listWrap = h('div', { style: { border: '1px solid var(--ink-100)', borderRadius: '8px', marginTop: '8px', maxHeight: '300px', overflow: 'auto' } });

    let all = [];
    const renderList = () => {
        const q = searchInp.value.trim().toLowerCase();
        const rows = q ? all.filter(s => (s.name || '').toLowerCase().includes(q)) : all;
        clear(listWrap);
        if (!rows.length) { listWrap.appendChild(h('div', { class: 'muted', style: { padding: '12px', textAlign: 'center' } }, 'No services.')); return; }
        for (const s of rows.slice(0, 100)) {
            listWrap.appendChild(h('div', {
                style: { display: 'flex', justifyContent: 'space-between', gap: '10px', padding: '8px 10px', cursor: 'pointer', borderBottom: '1px solid var(--ink-25)' },
                onmouseover: (e) => e.currentTarget.style.background = 'var(--ink-25)',
                onmouseout: (e) => e.currentTarget.style.background = 'transparent',
                onclick: () => order(s),
            },
                h('span', null, s.name, s.is_lab ? h('span', { class: 'muted', style: { fontSize: '10px', marginLeft: '6px' } }, 'lab') : null),
                ));   // DOC_NO_MONEY_V1 — без цены
        }
    };
    searchInp.addEventListener('input', renderList);

    const order = async (svc) => {
        const payload = {
            visit_id: visit.id, service_id: svc.id,
            doctor_id: visit.doctor_id || myId(),
            quantity: 1, unit_price: svc.price || 0, total: svc.price || 0,
            status: 'added', created_by: myId(),
        };
        const { error } = await supabase.from('visit_services').insert(payload).select().single();
        if (error) { toast(error.message || 'Failed to order.', 'fail'); return; }
        toast('Ordered: ' + svc.name, 'ok');
        close();
        if (typeof onOrdered === 'function') await onOrdered();
    };

    overlay.appendChild(h('div', { class: 'modal-card modal-compact', style: { width: '460px', maxWidth: 'calc(100vw - 32px)' } },
        h('header', { class: 'modal-head' }, h('h2', null, Icon('Flask', { size: 16 }), ' Order a service'), h('button', { class: 'modal-close', onclick: close }, '×')),
        h('div', { class: 'modal-body' }, searchInp, listWrap),
        h('footer', { class: 'modal-foot' }, h('span', { class: 'grow' }), h('button', { class: 'btn', type: 'button', onclick: close }, 'Close')),
    ));
    document.body.appendChild(overlay);
    supabase.from('services').select('id, name, price, is_lab').eq('active', 1).order('name').limit(500).then(({ data, error }) => {
        if (error) { listWrap.appendChild(h('div', { style: { color: 'var(--crit-600)', padding: '12px' } }, error.message)); return; }
        all = data || []; renderList();
    });
}

// ---------------------------------------------------------------------------
// New consultation — create a visit (walk-in) and open the consultation panel.
// ---------------------------------------------------------------------------
function newConsultationModal(root) {
    const overlay = h('div', { class: 'modal' });
    const close = () => overlay.remove();
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));

    let patientId = null;
    const searchInp = h('input', { type: 'text', placeholder: 'Search patient by name…', autocomplete: 'off' });
    const results = h('div', { style: { border: '1px solid var(--ink-100)', borderRadius: '8px', marginTop: '4px', maxHeight: '160px', overflow: 'auto', display: 'none' } });
    const chosen = h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '4px' } });
    let timer = null;
    searchInp.addEventListener('input', () => {
        patientId = null; chosen.textContent = '';
        clearTimeout(timer);
        const q = searchInp.value.trim();
        if (q.length < 2) { results.style.display = 'none'; return; }
        timer = setTimeout(async () => {
            const { data } = await supabase.from('patients').select('id, mrn, full_name').ilike('full_name', '%' + q + '%').eq('active', 1).limit(8);
            clear(results);
            if (!data || !data.length) { results.style.display = 'none'; return; }
            for (const pt of data) {
                results.appendChild(h('div', {
                    style: { padding: '7px 10px', cursor: 'pointer', fontSize: '13px' },
                    onmouseover: (e) => e.currentTarget.style.background = 'var(--ink-25)',
                    onmouseout: (e) => e.currentTarget.style.background = 'transparent',
                    onclick: () => { patientId = pt.id; searchInp.value = pt.full_name; chosen.textContent = 'Selected: ' + pt.full_name + (pt.mrn ? ' · ' + pt.mrn : ''); results.style.display = 'none'; },
                }, pt.full_name + (pt.mrn ? '  ·  ' + pt.mrn : '')));
            }
            results.style.display = '';
        }, 220);
    });

    // Doctor: self when the actor is a doctor; a picker for admin/registrar.
    const admin = !scopeDoctorId();
    const doctorSel = h('select', null, h('option', { value: '' }, '— doctor —'));
    if (admin) {
        supabase.from('users').select('id, full_name').eq('is_active', 1).eq('role', 'doctor').order('full_name').then(({ data }) => {
            for (const d of (data || [])) doctorSel.appendChild(h('option', { value: String(d.id) }, d.full_name));
        });
    }

    const startBtn = h('button', { class: 'btn btn-primary', type: 'button' }, 'Start consultation');
    startBtn.addEventListener('click', async () => {
        if (!patientId) { toast('Choose a patient.', 'fail'); return; }
        const doctorId = admin ? (doctorSel.value ? Number(doctorSel.value) : null) : myId();
        startBtn.disabled = true; startBtn.textContent = 'Starting…';
        const payload = {
            patient_id: patientId, visit_date: new Date().toISOString(),
            duration_minutes: 30, visit_type: 'outpatient', status: 'arrived',
        };
        if (doctorId) payload.doctor_id = doctorId;
        if (myId()) payload.created_by = myId();
        const { data, error } = await supabase.from('visits').insert(payload).select('*, patients(mrn, full_name), doctor(full_name)').single();
        if (error) { toast(error.message || 'Failed to start.', 'fail'); startBtn.disabled = false; startBtn.textContent = 'Start consultation'; return; }
        toast('Consultation started', 'ok');
        close();
        await paint(root);
        if (data) consultationModal(data, root);
    });

    overlay.appendChild(h('div', { class: 'modal-card modal-compact', style: { width: '440px', maxWidth: 'calc(100vw - 32px)' } },
        h('header', { class: 'modal-head' }, h('h2', null, Icon('Plus', { size: 16 }), ' New consultation'), h('button', { class: 'modal-close', onclick: close }, '×')),
        h('div', { class: 'modal-body' },
            field('Patient', h('div', null, searchInp, results, chosen), { required: true }),
            admin ? field('Doctor', doctorSel) : null,
        ),
        h('footer', { class: 'modal-foot' }, h('button', { class: 'btn', type: 'button', onclick: close }, 'Cancel'), h('span', { class: 'grow' }), startBtn),
    ));
    document.body.appendChild(overlay);
}
