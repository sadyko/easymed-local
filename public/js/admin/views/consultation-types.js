// Consultation types — DOCTOR-CENTRIC (CONSULTATION_TYPES_MATRIX_V2):
//   • a collapsed "Consultation types" card manages the shared type list (prices are per-doctor)
//   • the main surface is a list of the clinic's doctors, with:
//       - a BRANCH filter (All branches + each branch; matches primary branch_id OR user_branches)
//       - real-time SEARCH (name / specialty, debounced)
//       - an EDIT button per doctor -> a DIALOG (modal) to set availability/price/free for every type
//
// Schema (migration 067):
//   consultation_types(id, company_id, name_ru/uz/en, default_price, sort_order, active)
//   doctor_consultation_prices(id, company_id, doctor_id->users,
//     consultation_type_id->consultation_types, price numeric NULL,
//     available bool default true, is_free bool default false,
//     UNIQUE(doctor_id, consultation_type_id))
// No row for a (doctor,type) = defaults: available, not free, price = type default.

import { h, Icon, PageHead, clear, toast, initials, avColor } from '../ui.js';
import { supabase } from '../../supabase.js';
import { currentClinicId } from '../tenant-tables.js';

const PAGE = 20;

function typeName(t) { return t.name_ru || t.name_uz || t.name_en || '—'; }
function num(v) { return (v === '' || v == null) ? null : Number(v); }
function key(doctorId, typeId) { return doctorId + '|' + typeId; }

export async function renderConsultationTypes(container, ctx = {}) {
    clear(container);

    const cid = currentClinicId();
    const root = h('div', { class: 'fade-in' });
    container.appendChild(root);

    root.appendChild(PageHead({
        title: 'Doctor consultations',
        subtitle: "Set each doctor's availability & price for every consultation type",
    }));

    if (!cid) {
        root.appendChild(h('div', { class: 'empty', style: { padding: '24px' } }, 'No clinic in context.'));
        return;
    }

    const status = h('div', { class: 'muted', style: { fontSize: '12.5px', margin: '4px 0 14px' } }, 'Loading…');
    root.appendChild(status);

    // --- Load everything scoped to the current clinic -----------------------
    let types = [], doctors = [], priceMap = {}, branches = [], branchOf = {};
    try {
        const [tRes, dRes, pRes, bRes, ubRes] = await Promise.all([
            supabase.from('consultation_types').select('id, name_ru, name_uz, name_en, default_price, duration_minutes, sort_order, active')
                .eq('company_id', cid).order('sort_order', { ascending: true }),
            supabase.from('users').select('id, full_name, specialty, branch_id, company_id, role, is_doctor, license_number')
                .eq('active', true).order('full_name', { ascending: true }),
            supabase.from('doctor_consultation_prices').select('doctor_id, consultation_type_id, price, available, is_free, name_ru, name_uz, name_en')
                .eq('company_id', cid),
            supabase.from('branches').select('id, name_ru, name')
                .eq('company_id', cid).order('name_ru', { ascending: true }),
            supabase.from('user_branches').select('user_id, branch_id')
                .eq('company_id', cid),
        ]);
        if (tRes.error) throw tRes.error;
        types = tRes.data || [];
        if (dRes.error) console.warn('[consultation-types] doctors:', dRes.error.message);
        // Mirror loadDoctors(): RLS scopes to the clinic; detect doctors by role/flag/specialty/license,
        // then keep only the current company (defensive — handles super-admins who see all companies).
        else doctors = (dRes.data || [])
            .filter(u => (u.role || '').toLowerCase() === 'doctor' || u.is_doctor === true
                || (u.specialty || '').length > 0 || (u.license_number || '').length > 0)
            .filter(u => !cid || !u.company_id || u.company_id === cid);
        if (pRes.error) console.warn('[consultation-types] prices:', pRes.error.message);
        else for (const r of (pRes.data || [])) {
            priceMap[key(r.doctor_id, r.consultation_type_id)] = { price: r.price, available: r.available, is_free: r.is_free, name_ru: r.name_ru, name_uz: r.name_uz, name_en: r.name_en };
        }
        if (!bRes.error) branches = bRes.data || [];
        // doctorId -> Set(branchIds): primary branch_id + every user_branches row
        for (const d of doctors) { branchOf[d.id] = new Set(); if (d.branch_id) branchOf[d.id].add(d.branch_id); }
        if (!ubRes.error) for (const r of (ubRes.data || [])) {
            (branchOf[r.user_id] = branchOf[r.user_id] || new Set()).add(r.branch_id);
        }
    } catch (e) {
        console.warn('[consultation-types] load:', e.message);
        status.remove();
        root.appendChild(h('div', { style: { padding: '20px', color: '#b91c1c' } }, 'Could not load: ' + (e.message || e)));
        return;
    }
    status.remove();

    const branchName = {};
    for (const b of branches) branchName[b.id] = b.name_ru || b.name || '—';

    // ===== Doctors (branch filter + search + edit dialog) ===================
    root.appendChild(renderDoctors(types, doctors, priceMap, cid, branches, branchOf, branchName));
}

// ---------------------------------------------------------------------------
// Section ① — Consultation types (collapsible card: the shared type list, prices per-doctor)
// ---------------------------------------------------------------------------
function renderDefaults(types, cid) {
    const card = h('div', { class: 'card', style: { marginBottom: '18px', overflow: 'hidden' } });

    const chevron = h('span', { style: { transition: 'transform 150ms ease', transform: 'rotate(-90deg)', color: 'var(--ink-400)' } }, Icon('ChevronDown', { size: 16 }));
    const bodyWrap = h('div', { style: { padding: '4px 14px 14px', display: 'none' } });
    let open = false;
    const head = h('button', {
        type: 'button',
        style: {
            width: '100%', display: 'flex', alignItems: 'center', gap: '12px',
            padding: '14px 16px', border: '0', background: 'transparent', cursor: 'pointer',
            textAlign: 'left', fontFamily: 'inherit',
        },
        onclick: () => {
            open = !open;
            bodyWrap.style.display = open ? '' : 'none';
            chevron.style.transform = open ? '' : 'rotate(-90deg)';
        },
    },
        h('div', { style: { width: '32px', height: '32px', borderRadius: '8px', display: 'grid', placeItems: 'center', background: 'var(--primary-50)', color: 'var(--primary-700)', flex: '0 0 32px' } }, Icon('Stethoscope', { size: 17 })),
        h('div', { style: { flex: 1, minWidth: 0 } },
            h('div', { style: { fontSize: '13.5px', fontWeight: 700, color: 'var(--ink-900)' } }, 'Consultation types'),
            h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '1px' } }, 'Shared list of consultation kinds — prices are set per doctor'),
        ),
        chevron,
    );
    card.appendChild(head);
    card.appendChild(bodyWrap);

    if (!types.length) {
        bodyWrap.appendChild(h('div', { class: 'muted', style: { padding: '16px', fontSize: '13.5px', textAlign: 'center' } },
            'No consultation types yet for this clinic.'));
        return card;
    }

    const inpStyle = { height: '32px', padding: '0 10px', border: '1px solid var(--ink-200)', borderRadius: '8px', fontSize: '13.5px', background: 'white', fontFamily: 'inherit' };
    const edits = {};
    const tb = h('tbody');
    for (const t of types) {
        // CONSULT_NAMES_TRI_V1 — names editable in all three languages.
        edits[t.id] = { name_ru: t.name_ru || '', name_uz: t.name_uz || '', name_en: t.name_en || '', default_price: t.default_price, duration_minutes: (t.duration_minutes != null ? t.duration_minutes : 30), active: t.active !== false };
        const nameI = h('input', { type: 'text', value: t.name_ru || '', style: { ...inpStyle, width: '100%' },
            oninput: (e) => { edits[t.id].name_ru = e.currentTarget.value; } });
        const nameUzI = h('input', { type: 'text', value: t.name_uz || '', style: { ...inpStyle, width: '100%' },
            oninput: (e) => { edits[t.id].name_uz = e.currentTarget.value; } });
        const nameEnI = h('input', { type: 'text', value: t.name_en || '', style: { ...inpStyle, width: '100%' },
            oninput: (e) => { edits[t.id].name_en = e.currentTarget.value; } });
        const durI = h('input', { type: 'number', min: '5', step: '5', value: (t.duration_minutes != null ? t.duration_minutes : 30), style: { ...inpStyle, width: '90px' },
            oninput: (e) => { edits[t.id].duration_minutes = e.currentTarget.value; } });
        const activeI = h('input', { type: 'checkbox', checked: t.active !== false,
            onchange: (e) => { edits[t.id].active = e.currentTarget.checked; } });
        tb.appendChild(h('tr', null,
            h('td', { class: 'muted', style: { fontSize: '12.5px', width: '40px' } }, String(t.sort_order ?? '')),
            h('td', null, nameI),
            h('td', null, nameUzI),
            h('td', null, nameEnI),
            h('td', { style: { width: '110px' } }, durI),
            h('td', { style: { width: '70px', textAlign: 'center' } }, activeI),
        ));
    }
    bodyWrap.appendChild(h('table', { class: 'tbl', style: { width: '100%' } },
        h('thead', null, h('tr', null,
            h('th', { style: { width: '40px' } }, '#'),
            h('th', null, 'Name (RU)'),
            h('th', null, 'Name (UZ)'),
            h('th', null, 'Name (EN)'),
            h('th', null, 'Длительность (мин)'),
            h('th', { style: { textAlign: 'center' } }, 'Active'),
        )),
        tb));

    const saveBtn = h('button', { class: 'btn btn-primary btn-sm', type: 'button' }, Icon('Check', { size: 14 }), ' Save types');
    saveBtn.onclick = async () => {
        saveBtn.disabled = true; const orig = saveBtn.textContent; saveBtn.textContent = 'Saving…';
        try {
            for (const t of types) {
                const e = edits[t.id];
                const { error } = await supabase.from('consultation_types')
                    .update({ name_ru: e.name_ru.trim() || null, name_uz: e.name_uz.trim() || null, name_en: e.name_en.trim() || null, duration_minutes: parseInt(e.duration_minutes, 10) || 30, active: !!e.active })
                    .eq('id', t.id).eq('company_id', cid);
                if (error) throw error;
                t.name_ru = e.name_ru.trim(); t.name_uz = e.name_uz.trim(); t.name_en = e.name_en.trim(); t.duration_minutes = parseInt(e.duration_minutes, 10) || 30; t.active = !!e.active;
            }
            toast('Consultation types saved', 'info');
        } catch (err) {
            console.warn('[consultation-types] save defaults:', err.message);
            toast('Save failed: ' + (err.message || err), 'fail');
        }
        saveBtn.disabled = false; saveBtn.textContent = orig;
    };
    bodyWrap.appendChild(h('div', { style: { marginTop: '12px', display: 'flex', justifyContent: 'flex-end' } }, saveBtn));

    return card;
}

// ---------------------------------------------------------------------------
// Section ② — Doctors (branch filter + real-time search; Edit -> dialog)
// ---------------------------------------------------------------------------
function renderDoctors(types, doctors, priceMap, cid, branches, branchOf, branchName) {
    const wrap = h('div', null);
    wrap.appendChild(h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', margin: '4px 0 12px' } },
        h('h2', { style: { fontSize: '17px', margin: 0, fontWeight: 700 } }, 'Doctors'),
        h('span', { class: 'muted', style: { fontSize: '12.5px' } }, doctors.length + ' total'),
    ));

    if (!doctors.length) {
        wrap.appendChild(h('div', { class: 'empty', style: { padding: '24px' } }, 'No doctors yet. Add doctors under Employees.'));
        return wrap;
    }
    if (!types.length) {
        wrap.appendChild(h('div', { class: 'muted', style: { padding: '16px', fontSize: '13.5px' } },
            'Add consultation types above before setting per-doctor availability.'));
        return wrap;
    }

    let branchFilter = '', q = '', offset = 0;

    // Branch filter
    const selStyle = { height: '34px', padding: '0 10px', border: '1px solid var(--ink-200)', borderRadius: '10px', fontSize: '13.5px', background: 'white', fontFamily: 'inherit', cursor: 'pointer' };
    const branchSel = h('select', { style: selStyle },
        h('option', { value: '' }, 'All branches'),
        ...branches.map(b => h('option', { value: b.id }, b.name_ru || b.name || '—')),
    );
    branchSel.onchange = () => { branchFilter = branchSel.value; offset = 0; paint(); };

    // Real-time search
    const searchI = h('input', { placeholder: 'Search doctors…', style: { height: '34px', padding: '0 10px 0 32px', border: '1px solid var(--ink-200)', borderRadius: '10px', fontSize: '13.5px', background: 'white', width: '260px', fontFamily: 'inherit', outline: 'none' } });
    const searchWrap = h('div', { style: { position: 'relative', display: 'inline-flex', alignItems: 'center' } },
        h('span', { style: { position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', color: 'var(--ink-400)', pointerEvents: 'none' } }, Icon('Search', { size: 14 })),
        searchI,
    );

    wrap.appendChild(h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginBottom: '12px' } },
        h('span', { class: 'muted', style: { fontSize: '12.5px', display: 'inline-flex', alignItems: 'center', gap: '5px' } }, Icon('Filter', { size: 13 }), 'Branch'),
        branchSel,
        searchWrap,
    ));

    const listEl = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } });
    wrap.appendChild(listEl);

    const pageInfo = h('div', { class: 'muted', style: { fontSize: '12.5px' } }, '');
    const prevBtn = h('button', { class: 'btn btn-outline btn-sm', type: 'button' }, '‹ Prev');
    const nextBtn = h('button', { class: 'btn btn-outline btn-sm', type: 'button' }, 'Next ›');
    wrap.appendChild(h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginTop: '12px' } }, prevBtn, nextBtn, pageInfo));

    const filtered = () => {
        const t = q.trim().toLowerCase();
        return doctors.filter(d => {
            if (branchFilter && !(branchOf[d.id] && branchOf[d.id].has(branchFilter))) return false;
            if (t && !((d.full_name || '').toLowerCase().includes(t) || (d.specialty || '').toLowerCase().includes(t))) return false;
            return true;
        });
    };

    function paint() {
        clear(listEl);
        const rows = filtered();
        const total = rows.length;
        if (offset >= total) offset = Math.max(0, (Math.ceil(total / PAGE) - 1) * PAGE);
        const slice = rows.slice(offset, offset + PAGE);
        if (!slice.length) {
            listEl.appendChild(h('div', { class: 'empty', style: { padding: '20px' } }, 'No doctors match.'));
        } else {
            for (const d of slice) listEl.appendChild(doctorRow(d, types, priceMap, cid, branchOf, branchName, paint));
        }
        const totalPages = Math.max(1, Math.ceil(total / PAGE));
        const page = Math.floor(offset / PAGE) + 1;
        pageInfo.textContent = total ? (page + ' / ' + totalPages + '  ·  ' + total + ' doctor' + (total === 1 ? '' : 's')) : '';
        prevBtn.disabled = offset <= 0;
        nextBtn.disabled = offset + PAGE >= total;
    }

    let timer = null;
    searchI.oninput = () => { clearTimeout(timer); timer = setTimeout(() => { q = searchI.value; offset = 0; paint(); }, 200); };
    prevBtn.onclick = () => { if (offset > 0) { offset = Math.max(0, offset - PAGE); paint(); } };
    nextBtn.onclick = () => { if (offset + PAGE < filtered().length) { offset += PAGE; paint(); } };

    paint();
    return wrap;
}

// One doctor row with branch + price summary + an Edit button that opens the dialog.
function doctorRow(d, types, priceMap, cid, branchOf, branchName, repaint) {
    const ids = Array.from(branchOf[d.id] || []);
    const branchLabel = ids.length ? ids.map(id => branchName[id] || '—').join(', ') : 'No branch';
    const configured = types.filter(t => priceMap[key(d.id, t.id)]).length;

    const editBtn = h('button', { class: 'btn btn-outline btn-sm', type: 'button' }, Icon('Edit', { size: 13 }), ' Edit');
    editBtn.onclick = () => openDoctorPricesModal(d, types, priceMap, cid, repaint);

    return h('div', { class: 'card', style: { display: 'flex', alignItems: 'center', gap: '12px', padding: '12px 14px' } },
        h('div', { class: 'avatar ' + avColor(d.id), style: { flex: '0 0 36px', width: '36px', height: '36px' } }, initials(d.full_name)),
        h('div', { style: { flex: 1, minWidth: 0 } },
            h('div', { style: { fontSize: '13.5px', fontWeight: 600, color: 'var(--ink-900)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, d.full_name || '—'),
            h('div', { class: 'muted', style: { fontSize: '12.5px', display: 'flex', gap: '10px', flexWrap: 'wrap', marginTop: '1px' } },
                d.specialty ? h('span', null, d.specialty) : null,
                h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '4px' } }, Icon('Building', { size: 11 }), branchLabel),
            ),
        ),
        h('span', { class: 'muted', style: { fontSize: '12.5px', whiteSpace: 'nowrap' } },
            configured ? (configured + '/' + types.length + ' set') : 'defaults'),
        editBtn,
    );
}

// ---------------------------------------------------------------------------
// Edit dialog — per-doctor matrix of availability / price / free per type.
// ---------------------------------------------------------------------------
function openDoctorPricesModal(d, types, priceMap, cid, repaint) {
    const overlay = h('div', { class: 'modal', style: { zIndex: '140' } });
    const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));

    // Local editable state per type, seeded from priceMap (or pure defaults).
    const state = {};
    for (const t of types) {
        const row = priceMap[key(d.id, t.id)];
        state[t.id] = row
            ? { available: row.available !== false, price: (row.price == null ? '' : String(row.price)), is_free: row.is_free === true,
                name_ru: row.name_ru || '', name_uz: row.name_uz || '', name_en: row.name_en || '' }
            : { available: true, price: '', is_free: false, name_ru: '', name_uz: '', name_en: '' };
    }

    const inpStyle = { height: '30px', width: '140px', padding: '0 8px', border: '1px solid var(--ink-200)', borderRadius: '7px', fontSize: '13.5px', background: 'white', fontFamily: 'inherit' };
    const tb = h('tbody');
    for (const t of types) {
        const s = state[t.id];
        const availI = h('input', { type: 'checkbox', checked: s.available,
            onchange: (e) => { s.available = e.currentTarget.checked; } });
        const priceI = h('input', { type: 'number', step: '0.01', value: s.price, placeholder: '0', style: inpStyle,
            oninput: (e) => { s.price = e.currentTarget.value; } });
        const freeI = h('input', { type: 'checkbox', checked: s.is_free,
            onchange: (e) => {
                s.is_free = e.currentTarget.checked;
                priceI.disabled = s.is_free;
                priceI.style.opacity = s.is_free ? '0.5' : '';
            } });
        if (s.is_free) { priceI.disabled = true; priceI.style.opacity = '0.5'; }

        // CONSULT_DOC_NAMES_V1 — per-doctor name (blank = the type's label; placeholder shows it).
        const nameStyle = { height: '28px', width: '100%', padding: '0 7px', border: '1px solid var(--ink-200)', borderRadius: '6px', fontSize: '12.5px', background: 'white', fontFamily: 'inherit' };
        const nmRu = h('input', { type: 'text', value: s.name_ru, placeholder: t.name_ru || 'RU', style: nameStyle, oninput: (e) => { s.name_ru = e.currentTarget.value; } });
        const nmUz = h('input', { type: 'text', value: s.name_uz, placeholder: t.name_uz || 'UZ', style: nameStyle, oninput: (e) => { s.name_uz = e.currentTarget.value; } });
        const nmEn = h('input', { type: 'text', value: s.name_en, placeholder: t.name_en || 'EN', style: nameStyle, oninput: (e) => { s.name_en = e.currentTarget.value; } });

        tb.appendChild(h('tr', null,
            h('td', null,
                h('div', { style: { fontWeight: 500, fontSize: '12.5px', marginBottom: '5px' } }, typeName(t)),
                h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '5px' } }, nmRu, nmUz, nmEn),
                h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '3px' } }, 'Название для этого врача · RU / UZ / EN (пусто = название типа)')),
            h('td', { style: { width: '90px', textAlign: 'center', verticalAlign: 'top' } }, availI),
            h('td', { style: { width: '156px', verticalAlign: 'top' } }, priceI),
            h('td', { style: { width: '64px', textAlign: 'center', verticalAlign: 'top' } }, freeI),
        ));
    }

    const saveBtn = h('button', { class: 'btn btn-primary', type: 'button' }, Icon('Check', { size: 14 }), ' Save');
    saveBtn.onclick = async () => {
        saveBtn.disabled = true; const orig = saveBtn.textContent; saveBtn.textContent = 'Saving…';
        try {
            // Reconcile: delete this doctor's rows, then insert one per type.
            const del = await supabase.from('doctor_consultation_prices').delete().eq('doctor_id', d.id).eq('company_id', cid);
            if (del.error) throw del.error;
            const rows = types.map(t => {
                const s = state[t.id];
                return {
                    company_id: cid,
                    doctor_id: d.id,
                    consultation_type_id: t.id,
                    price: s.is_free ? null : num(s.price),
                    available: !!s.available,
                    is_free: !!s.is_free,
                    name_ru: (s.name_ru || '').trim() || null,
                    name_uz: (s.name_uz || '').trim() || null,
                    name_en: (s.name_en || '').trim() || null,
                };
            });
            if (rows.length) {
                const ins = await supabase.from('doctor_consultation_prices').insert(rows);
                if (ins.error) throw ins.error;
            }
            for (const t of types) {
                const s = state[t.id];
                priceMap[key(d.id, t.id)] = { price: s.is_free ? null : num(s.price), available: !!s.available, is_free: !!s.is_free, name_ru: (s.name_ru || '').trim() || null, name_uz: (s.name_uz || '').trim() || null, name_en: (s.name_en || '').trim() || null };
            }
            toast('Saved ' + (d.full_name || 'doctor'), 'info');
            close();
            if (repaint) repaint();
        } catch (err) {
            console.warn('[consultation-types] save doctor:', err.message);
            toast('Save failed: ' + (err.message || err), 'fail');
            saveBtn.disabled = false; saveBtn.textContent = orig;
        }
    };

    const card = h('div', { class: 'modal-card', style: { width: '660px', maxWidth: 'calc(100vw - 32px)' } },
        h('header', { class: 'modal-head' },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 } },
                h('div', { class: 'avatar ' + avColor(d.id), style: { flex: '0 0 32px', width: '32px', height: '32px' } }, initials(d.full_name)),
                h('div', { style: { minWidth: 0 } },
                    h('div', { style: { fontWeight: 700, fontSize: '15px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, d.full_name || 'Doctor'),
                    h('div', { class: 'muted', style: { fontSize: '12.5px' } }, 'Consultation availability & price'),
                ),
            ),
            h('button', { class: 'modal-close', onclick: close }, '×'),
        ),
        h('div', { class: 'modal-body' },
            h('table', { class: 'tbl', style: { width: '100%' } },
                h('thead', null, h('tr', null,
                    h('th', null, 'Consultation type'),
                    h('th', { style: { textAlign: 'center' } }, 'Available'),
                    h('th', null, 'Price'),
                    h('th', { style: { textAlign: 'center' } }, 'Free'),
                )),
                tb),
            h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '8px' } },
                'Цена и название — для этого врача. «Free» = бесплатно. Пустое название = название типа.'),
        ),
        h('footer', { class: 'modal-foot' },
            h('button', { class: 'btn btn-outline', type: 'button', onclick: close }, 'Cancel'),
            saveBtn,
        ),
    );
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKey);
}
