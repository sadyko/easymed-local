// Документы — branch-wide clinical document archive (CLINICAL_DOCS_ARCHIVE_V1).
// ONE workplace surface for BOTH doctors and laborants: every signed conclusion,
// diagnostic report, lab result and uploaded file in the branch (RLS already scopes
// visit_documents to the user's branch/company), searchable + filterable by kind.
// Opens each via the shared print/preview engine (body-only snapshots) or a signed
// Storage URL (uploaded files). Read-only archive — editing happens in the workspace.
import { supabase } from '../../supabase.js';
import { h, Icon, clear, toast, fmtDate } from '../ui.js';
import { printableSheet, loadDocSettings } from './doc-settings.js?v=noqr1';   // ONE shared instance — ?v=db9

const _DOC_TEMPLATE = { protocol: 'conclusion', conclusion: 'conclusion', diag: 'diag', lab: 'lab' };
const _KINDS = [
    ['all',          'Все'],
    ['Консультация', 'Консультации'],
    ['Диагностика',  'Диагностика'],
    ['Лаборатория',  'Лаборатория'],
    ['Пациент',      'Файлы пациента'],
];

const state = { docs: [], q: '', kind: 'all', loaded: false };
let _listEl = null;

function _docKind(d) {
    const k = d.__deptKind || '';
    if (k === 'laboratory'  || d.doc_type === 'lab')  return 'Лаборатория';
    if (k === 'diagnostics' || d.doc_type === 'diag') return 'Диагностика';
    if (d.visit_id || d.visit_service_id)             return 'Консультация';
    return 'Пациент';
}

async function openDoc(d) {
    if (d.file_path) {
        try { const { data } = await supabase.storage.from('patient-docs').createSignedUrl(d.file_path, 3600); if (data && data.signedUrl) { window.open(data.signedUrl, '_blank', 'noopener'); return; } } catch (e) {}
    }
    if (d.body) {
        const type = _DOC_TEMPLATE[d.doc_type] || 'conclusion';
        try { printableSheet({ type, data: d.body, title: d.title || 'Документ', settings: loadDocSettings() }); return; }
        catch (e) { console.warn('[docs-archive] render', e && e.message); }
    }
    toast(d.title || 'Документ', 'info');
}

async function loadDocs() {
    let docs = [];
    try {
        const { data, error } = await supabase.from('visit_documents')
            .select('id, title, file_name, file_path, file_size, content_type, doc_type, visit_id, visit_service_id, patient_id, body, created_at')
            .order('created_at', { ascending: false }).limit(400);
        if (error) console.warn('[docs-archive]', error.message); else docs = data || [];
    } catch (e) { console.warn('[docs-archive]', e.message); }

    const pids = [...new Set(docs.map(d => d.patient_id).filter(Boolean))];
    const pm = {};
    if (pids.length) { try { const { data } = await supabase.from('patients').select('id, full_name, first_name, last_name, mrn').in('id', pids); for (const p of (data || [])) pm[p.id] = { name: p.full_name || [p.last_name, p.first_name].filter(Boolean).join(' ') || '—', mrn: p.mrn || '' }; } catch (e) {} }

    const vsids = [...new Set(docs.map(d => d.visit_service_id).filter(Boolean))];
    const km = {};
    if (vsids.length) { try { const { data } = await supabase.from('visit_services').select('id, services(name, departments(kind))').in('id', vsids); for (const k of (data || [])) km[k.id] = { kind: (k.services && k.services.departments && k.services.departments.kind) || '', svc: (k.services && k.services.name) || '' }; } catch (e) {} }

    // DOCS_DOCTOR_COL_V1 — resolve the visit's doctor for each document
    const vids = [...new Set(docs.map(d => d.visit_id).filter(Boolean))];
    const vm = {};
    if (vids.length) { try { const { data } = await supabase.from('visits').select('id, users:doctor_id(full_name)').in('id', vids); for (const v of (data || [])) vm[v.id] = (v.users && v.users.full_name) || ''; } catch (e) {} }

    for (const d of docs) {
        const pinfo = pm[d.patient_id] || {};
        const kinfo = (d.visit_service_id && km[d.visit_service_id]) || {};
        d.__patient = pinfo.name || '—';
        d.__mrn = pinfo.mrn || '';
        d.__deptKind = kinfo.kind || '';
        d.__svc = kinfo.svc || '';
        d.__doctor = (d.visit_id && vm[d.visit_id]) || '';
        d.__kind = _docKind(d);
    }
    state.docs = docs;
    state.loaded = true;
}

function _filtered() {
    const q = state.q.trim().toLowerCase();
    return state.docs.filter(d => {
        if (state.kind !== 'all' && d.__kind !== state.kind) return false;
        if (!q) return true;
        return [d.title, d.__patient, d.__mrn, d.__svc, d.__doctor, fmtDate(d.created_at)].some(x => String(x || '').toLowerCase().includes(q));
    });
}

function repaintList() {
    if (!_listEl) return;
    clear(_listEl);
    const docs = _filtered();
    if (!docs.length) { _listEl.appendChild(h('div', { class: 'empty', style: { padding: '40px 20px' } }, state.loaded ? 'Документы не найдены.' : 'Загрузка…')); return; }
    const tb = h('tbody');
    for (const d of docs) {
        tb.appendChild(h('tr', null,
            h('td', { style: { fontWeight: 500 } }, Icon('Doc', { size: 14 }), ' ', d.title || d.file_name || 'Документ'),
            h('td', null, d.__patient + (d.__mrn ? ' · ' + d.__mrn : '')),
            h('td', { class: 'muted', style: { fontSize: '12.5px' } }, d.__doctor || '—'),
            h('td', { class: 'muted', style: { fontSize: '12.5px' } }, h('span', { class: d.__kind === 'Пациент' ? 'tag' : 'tag tag-info' }, d.__kind)),
            h('td', { class: 'muted', style: { fontSize: '12.5px' } }, fmtDate(d.created_at)),
            h('td', { style: { textAlign: 'right' } }, h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: () => openDoc(d) }, Icon('Doc', { size: 12 }), ' Открыть'))));
    }
    _listEl.appendChild(h('table', { class: 'tbl', style: { width: '100%' } },
        h('thead', null, h('tr', null, h('th', null, 'Документ'), h('th', null, 'Пациент'), h('th', null, 'Врач'), h('th', null, 'Тип'), h('th', null, 'Дата'), h('th', { style: { textAlign: 'right' } }, ''))),
        tb));
}

export async function renderDocsArchive(container, ctx) {
    clear(container);
    state.q = ''; state.kind = 'all'; state.loaded = false; state.docs = [];

    const search = h('input', { type: 'search', placeholder: 'Поиск: пациент, MRN, услуга, название…',
        style: { height: '36px', padding: '0 12px', border: '1px solid var(--ink-200)', borderRadius: '8px', fontSize: '13.5px', minWidth: '280px', fontFamily: 'inherit' },
        oninput: (e) => { state.q = e.target.value; repaintList(); } });

    const chips = h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } });
    function paintChips() {
        clear(chips);
        for (const [k, lbl] of _KINDS) chips.appendChild(h('button', { type: 'button', class: 'btn btn-sm ' + (state.kind === k ? 'btn-primary' : 'btn-outline'),
            onclick: () => { state.kind = k; paintChips(); repaintList(); } }, lbl));
    }
    paintChips();

    _listEl = h('div', { class: 'card', style: { marginTop: '12px', padding: '6px 10px' } });
    container.appendChild(h('div', { class: 'view', style: { padding: '18px 22px' } },
        h('div', null,
            h('h2', { style: { margin: '0 0 2px' } }, 'Документы'),
            h('div', { class: 'muted', style: { fontSize: '12.5px' } }, 'Архив заключений, результатов и файлов клиники')),
        h('div', { style: { marginTop: '12px' } }, chips),
        h('div', { style: { marginTop: '10px' } }, search),
        _listEl));

    repaintList();
    await loadDocs();
    repaintList();
}
