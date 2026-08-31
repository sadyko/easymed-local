// Services — SERVICES_CATALOG_V1 — service/procedure price-list admin page.
// Mirrors public/js/admin/views/visits.js for structure (mount / fetchAndPaint
// / DOM-building via h()) and the modal chrome (.modal / .modal-backdrop /
// .modal-card / .modal-head / .modal-close / .modal-body / .modal-foot — there
// is no shared modal() helper in ui.js, every view builds its own overlay with
// those classes).
//
// services is CRUD via /api/db (server/db/schema-registry.js): admin may
// insert/update {name, code, price, tax_rate, duration_minutes,
// requires_doctor, active}; every staff role may read.
//
// SERVICE_DELETE_V1 — /api/db still grants DELETE on services to nobody, on
// purpose: removal goes through the `delete_service` RPC
// (server/services/rpc/catalog.js), which refuses any service that appears in a
// visit, invoice, admission, queue ticket, lab panel or CRM lead, and offers
// deactivation instead. Keeping the generic delete verb closed means there is
// no second path that skips that check.

import { supabase } from '../../supabase.js';
import { h, Icon, clear, toast, Tag, field, checkField } from '../ui.js';
import { tr, trf } from '../i18n.js';
import { importExportButtons } from './section-import-export.js?v=aug17e';   // DATA_TRANSFER_V1
import { ratesOf } from './doctor-pool.js?v=dp1';   // SVC_PERFORMERS_V1 — тот же разбор service_rates, что и в мастере визита

// SVC_PERFORMERS_V1 — кто выполняет услугу.
//
// Назначения живут в «Сотрудники → Услуги и ставки» (users.service_rates), и до
// сих пор увидеть их можно было только со стороны сотрудника: открыть карточку
// врача и просмотреть его список. Обратный вопрос — «а кто вообще делает эту
// процедуру?» — требовал обойти всех сотрудников подряд. Здесь тот же самый
// источник читается со стороны УСЛУГИ, ничего не дублируя.
let performersBySvc = new Map();   // service_id (строкой) -> [ФИО]

function buildPerformerIndex(staff) {
    const map = new Map();
    for (const u of staff || []) {
        const name = (u.full_name || u.username || '').trim();
        if (!name) continue;
        for (const r of ratesOf(u)) {
            const sid = r && (r.service_id != null ? r.service_id : r.serviceId);
            if (sid == null) continue;
            const k = String(sid);
            if (!map.has(k)) map.set(k, []);
            if (!map.get(k).includes(name)) map.get(k).push(name);
        }
    }
    for (const list of map.values()) list.sort((a, b) => a.localeCompare(b, 'ru'));
    return map;
}

async function fetchPerformers() {
    // Роль не фильтруем: услугу может выполнять и медсестра
    // (SERVICE_NURSE_PROVIDER_V1) — в список попадает тот, кому её отметили.
    const { data, error } = await supabase.from('users')
        .select('id, full_name, username, role, is_active, service_rates').eq('is_active', true);
    if (error) throw new Error(error.message || 'failed to load staff');
    return data || [];
}

// Routing type (раздел) — the fixed easymed set. Drives the «Услуги и ставки»
// type filter in the employee editor and where the service is grouped.
const SERVICE_TYPES = [['imaging', 'Диагностика'], ['radiology', 'Лучевая диагностика'], ['consultation', 'Консультации'], ['lab', 'Лаборатория'], ['procedure', 'Процедуры'], ['other', 'Хирургия']];
// A service with no explicit `type` still lands in a bucket (a lab test in
// «Лаборатория», everything else in «Консультации»). The column filter MUST use
// this same derivation, or filtering by the type shown in the row would drop it.
const typeKey = (s) => s.type || (s.is_lab ? 'lab' : 'consultation');
const typeLabel = (s) => (SERVICE_TYPES.find(t => t[0] === typeKey(s)) || ['', '—'])[1];

// SERVICE_DELETE_V1 — mirrors the RPC's own rule (server/services/rpc/catalog.js).
function isAdmin() {
    const u = (typeof window !== 'undefined' && window.easymed && window.easymed.state && window.easymed.state.user) || null;
    return !!u && (u.is_super_admin === true || u.is_admin === true || u.role === 'admin');
}

const refs = {
    container:  null,
    onNavigate: null,
    tbody:      null,
    emptyEl:    null,
    totalEl:    null,
    resetBtn:   null,
    capNote:    null,
};

// SVC_COL_FILTERS_V1 — a filter under every column (mirrors the staff roster).
// The whole catalog is loaded once and filtered IN MEMORY, so typing is instant
// and never re-queries. The filter row is built ONCE and never re-rendered:
// rebuilding it would recreate the field being typed into and steal focus.
let allServices = [];
const flt = {
    name: '', code: '', type: '',
    priceMin: '', priceMax: '', durMin: '', durMax: '',
    doctor: '', lab: '', active: '',
    performer: '',   // SVC_PERFORMERS_V1 — «какие услуги делает этот врач»
};
const clearFilters = () => Object.keys(flt).forEach((k) => { flt[k] = ''; });
const anyFilter = () => Object.values(flt).some((v) => String(v || '').trim());

// Rendering every row of a big catalogue costs more than it is worth; the cap
// is announced (never silent) so a truncated list can't read as a complete one.
const MAX_RENDERED = 1000;

const FILTER_STYLE = {
    width: '100%', height: '28px', padding: '0 8px', borderRadius: '6px',
    border: '1px solid var(--ink-200)', background: 'var(--white, #fff)',
    fontSize: '12.5px', fontFamily: 'inherit', boxSizing: 'border-box',
};
const YES_NO = [['', 'All'], ['yes', 'Yes'], ['no', 'No']];

// '' = no bound. A row with no numeric value cannot satisfy a bound, so it drops
// out once one is set — otherwise a service with no duration would answer to
// «from 0» as though it took no time, and a null price would look free.
// The null/'' guard is load-bearing: Number(null) and Number('') are both 0, so
// without it those rows silently pass any bound that includes zero.
function inRange(value, minRaw, maxRaw) {
    const min = String(minRaw).trim(), max = String(maxRaw).trim();
    if (!min && !max) return true;
    if (value === null || value === undefined || value === '') return false;
    const v = Number(value);
    if (!Number.isFinite(v)) return false;
    const lo = Number(min), hi = Number(max);
    if (min && Number.isFinite(lo) && v < lo) return false;
    if (max && Number.isFinite(hi) && v > hi) return false;
    return true;
}
const flagOk = (want, val) => !want || (want === 'yes' ? !!val : !val);

function matchesFilters(s) {
    const name = flt.name.trim().toLowerCase();
    if (name && !String(s.name || '').toLowerCase().includes(name)) return false;
    const code = flt.code.trim().toLowerCase();
    if (code && !String(s.code || '').toLowerCase().includes(code)) return false;
    if (flt.type && typeKey(s) !== flt.type) return false;
    if (!inRange(s.price, flt.priceMin, flt.priceMax)) return false;
    if (!inRange(s.duration_minutes, flt.durMin, flt.durMax)) return false;
    if (!flagOk(flt.doctor, s.requires_doctor)) return false;
    // SVC_PERFORMERS_V1 — обратный вопрос к колонке: показать всё, что делает
    // конкретный сотрудник. Ищем по тем же именам, что стоят в ячейке.
    const perf = flt.performer.trim().toLowerCase();
    if (perf) {
        const names = performersBySvc.get(String(s.id)) || [];
        if (!names.some((n) => n.toLowerCase().includes(perf))) return false;
    }
    if (!flagOk(flt.lab, s.is_lab)) return false;
    if (!flagOk(flt.active, s.active)) return false;
    return true;
}

export async function renderServices(container, { onNavigate } = {}) {
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
    clearFilters();   // a fresh visit to the page starts unfiltered

    refs.tbody = h('tbody');
    refs.emptyEl = h('div', { class: 'empty', style: { display: 'none' } },
        'No services yet — add the first one.');
    refs.totalEl = h('span', { class: 'muted', style: { fontSize: '12.5px' } }, '');
    refs.capNote = h('div', {
        class: 'muted',
        style: { display: 'none', padding: '8px 12px', fontSize: '12.5px', borderTop: '1px solid var(--ink-100)' },
    }, '');

    // SVC_COL_FILTERS_V1 — one control per column, wired to the shared `flt`.
    const textFilter = (key, ph) => h('input', {
        type: 'text', placeholder: ph, style: FILTER_STYLE,
        oninput: (e) => { flt[key] = e.target.value; renderRows(); },
    });
    const selectFilter = (key, options) => h('select', {
        style: FILTER_STYLE,
        onchange: (e) => { flt[key] = e.target.value; renderRows(); },
    }, ...options.map(([v, l]) => h('option', { value: v }, l)));
    const numFilter = (key, ph) => h('input', {
        type: 'number', min: '0', placeholder: ph,
        style: { ...FILTER_STYLE, padding: '0 5px', textAlign: 'right' },
        oninput: (e) => { flt[key] = e.target.value; renderRows(); },
    });
    const rangeFilter = (minKey, maxKey) => h('div', { style: { display: 'flex', gap: '4px' } },
        numFilter(minKey, 'from'), numFilter(maxKey, 'to'));

    const filterRow = h('tr', { class: 'filter-row', style: { background: 'var(--ink-25, #f6f8f9)' } },
        h('th', null, textFilter('name', 'Name')),
        h('th', null, textFilter('code', 'Code')),
        h('th', null, selectFilter('type', [['', 'All']].concat(SERVICE_TYPES))),
        h('th', null, rangeFilter('priceMin', 'priceMax')),
        h('th', null, rangeFilter('durMin', 'durMax')),
        h('th', null, selectFilter('doctor', YES_NO)),
        h('th', null, textFilter('performer', 'Doctor name')),   // SVC_PERFORMERS_V1
        h('th', null, selectFilter('lab', YES_NO)),
        h('th', null, selectFilter('active', YES_NO)),
    );

    // No spare column for a reset control, so it sits beside the count in the
    // page head — where the "N of M" it undoes is already shown.
    refs.resetBtn = h('button', {
        class: 'btn btn-outline btn-sm', type: 'button', title: 'Clear all filters',
        style: { display: 'none', padding: '2px 10px', fontSize: '12.5px', marginLeft: '8px' },
        onclick: () => {
            clearFilters();
            for (const el of filterRow.querySelectorAll('input, select')) el.value = '';
            renderRows();
        },
    }, 'Reset');

    const addBtn = h('button', {
        class: 'btn btn-primary btn-sm', type: 'button',
        onclick: () => openServiceModal(null, fetchAndPaint),
    }, Icon('Plus', { size: 14 }), ' Add service');

    refs.container.appendChild(h('div', { class: 'fade-in' },
        h('div', { class: 'page-head' },
            h('div', null,
                h('h1', { class: 'page-title' }, 'Services'),
                h('div', { style: { display: 'flex', alignItems: 'center' } }, refs.totalEl, refs.resetBtn),
            ),
            // DATA_TRANSFER_V1 — Шаблон / Импорт / Экспорт. Export re-reads the
            // whole table rather than reusing the painted rows, so it covers
            // services beyond the 500-row list cap.
            h('div', { class: 'page-head-actions' },
                ...importExportButtons({
                    sectionKey:   'services',
                    filenameStem: 'services',
                    fetchRows:    fetchAllServices,
                    onImported:   fetchAndPaint,
                }),
                addBtn),
        ),
        h('div', { class: 'card' },
            h('table', { class: 'tbl' },
                h('thead', null,
                    h('tr', null,
                        h('th', null, 'Name'),
                        h('th', null, 'Code'),
                        h('th', null, 'Type'),
                        h('th', null, 'Price'),
                        h('th', null, 'Duration'),
                        h('th', null, 'Doctor'),
                        h('th', null, 'Performers'),
                        h('th', null, 'Lab'),
                        h('th', null, 'Active'),
                    ),
                    filterRow,
                ),
                refs.tbody,
            ),
            refs.emptyEl,
            refs.capNote,
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
        // SVC_COL_FILTERS_V1 — the list used to stop at 500 rows. Filtering a
        // truncated list is worse than not filtering at all: "no results" would
        // really mean "no results among the first 500", with nothing on screen
        // saying so. The column filters search the WHOLE catalogue, so the whole
        // catalogue is what gets loaded (paged, like the export already did).
        // SVC_PERFORMERS_V1 — назначения грузим ВМЕСТЕ с каталогом, одним
        // ожиданием: две последовательные загрузки удваивали бы паузу на 519
        // услугах. Сбой списка сотрудников не должен прятать сам каталог —
        // колонка просто останется пустой.
        const [rows, staff] = await Promise.all([
            fetchAllServices(),
            fetchPerformers().catch((e) => { console.warn('[services] performers:', e && e.message); return []; }),
        ]);
        if (token !== lastFetchToken) return;   // a newer fetch already landed
        allServices = rows;
        performersBySvc = buildPerformerIndex(staff);
        renderRows();
    } catch (e) {
        if (token !== lastFetchToken) return;
        toast('Failed to load services: ' + (e && e.message || e), 'fail');
        allServices = [];
        renderRows();
    }
}

// DATA_TRANSFER_V1 — every service for the Excel export, paged past the
// list view's 500-row cap so an export is never a silent partial dump.
async function fetchAllServices() {
    const PAGE = 500;
    const out = [];
    for (let from = 0; ; from += PAGE) {
        const { data, error } = await supabase.from('services')
            .select('*').order('name', { ascending: true }).range(from, from + PAGE - 1);
        if (error) throw new Error(error.message || error);
        out.push(...(data || []));
        if (!data || data.length < PAGE) break;
    }
    return out;
}

function setLoadingRow() {
    if (!refs.tbody) return;
    clear(refs.tbody);
    refs.tbody.appendChild(h('tr', null,
        h('td', { colspan: '8', style: { textAlign: 'center', padding: '24px', color: 'var(--ink-500)', fontSize: '12.5px' } }, 'Loading…'),
    ));
    refs.emptyEl.style.display = 'none';
}

// Repaints the tbody from `allServices` through the current filters. Called on
// every keystroke — it touches only the body, never the filter row, so the
// field being typed into keeps its focus and caret.
function renderRows() {
    const filtering = anyFilter();
    if (refs.resetBtn) refs.resetBtn.style.display = filtering ? '' : 'none';

    const rows = allServices.filter(matchesFilters);
    const total = allServices.length;
    if (refs.totalEl) {
        refs.totalEl.textContent = filtering
            ? `${rows.length} of ${total}`
            : `${total} service${total === 1 ? '' : 's'}`;
    }

    clear(refs.tbody);
    if (!rows.length) {
        refs.emptyEl.style.display = '';
        refs.emptyEl.textContent = tr(total
            ? 'No services match the filters.'
            : 'No services yet — add the first one.');
        if (refs.capNote) refs.capNote.style.display = 'none';
        return;
    }
    refs.emptyEl.style.display = 'none';

    const shown = rows.slice(0, MAX_RENDERED);
    for (const s of shown) refs.tbody.appendChild(serviceRow(s));

    // Never let a cap pass for a complete list.
    if (refs.capNote) {
        const capped = rows.length > shown.length;
        refs.capNote.style.display = capped ? '' : 'none';
        if (capped) {
            refs.capNote.textContent =
                `${tr('Showing the first')} ${shown.length} ${tr('of')} ${rows.length} — ${tr('narrow the filters to see the rest.')}`;
        }
    }
}

// Thousands-separated price display, no currency symbol (e.g. 50000 -> "50 000").
function fmtPrice(n) {
    const v = Math.round(Number(n) || 0);
    const sign = v < 0 ? '-' : '';
    return sign + String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

// Имена переносятся по словам: «Утамуродова Манзура, Усмонкулов Шароф» в одну
// строку не помещается ни на одном экране, а обрезать многоточием нельзя —
// смысл колонки именно в том, чтобы увидеть, КТО.
function performerCell(s) {
    const names = performersBySvc.get(String(s.id)) || [];
    if (!names.length) {
        return h('td', { class: 'muted', style: { whiteSpace: 'nowrap' } },
            s.requires_doctor ? h('span', { style: { color: 'var(--warn-700, #a16207)' } }, 'не назначен') : '—');
    }
    return h('td', {
        title: names.join(', '),
        style: {
            whiteSpace: 'normal', wordBreak: 'break-word', lineHeight: '1.35',
            fontSize: '12.5px', minWidth: '170px', maxWidth: '260px',
        },
    }, names.join(', '));
}

function serviceRow(s) {
    const inactive = !s.active;
    return h('tr', {
        class: 'row-click',
        style: { cursor: 'pointer', opacity: inactive ? '0.55' : '' },
        onclick: () => openServiceModal(s, fetchAndPaint),
    },
        h('td', { class: 'cell-strong' }, s.name || '—'),
        h('td', { class: 'muted' }, s.code || '—'),
        h('td', null, typeLabel(s)),
        h('td', { class: 'num' }, fmtPrice(s.price)),
        h('td', null, s.duration_minutes != null ? (s.duration_minutes + ' min') : '—'),
        h('td', null, s.requires_doctor ? Tag('Yes', { kind: 'ok', dot: true }) : h('span', { class: 'muted' }, '—')),
        performerCell(s),
        h('td', null, s.is_lab ? Tag('Lab', { kind: 'info', dot: true }) : h('span', { class: 'muted' }, '—')),
        h('td', null, Tag(s.active ? 'Yes' : 'No', { kind: s.active ? 'ok' : '', dot: true })),
    );
}

// -----------------------------------------------------------------------------
// ADD / EDIT MODAL — shared: svc == null -> add (blank); svc set -> edit (prefilled).
// -----------------------------------------------------------------------------
function openServiceModal(svc, onSaved) {
    const isEdit = !!svc;

    const overlay = h('div', { class: 'modal' });
    const close = () => overlay.remove();
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));

    const nameInp  = h('input', { type: 'text', required: true, value: svc ? (svc.name || '') : '' });
    const codeInp  = h('input', { type: 'text', value: svc ? (svc.code || '') : '' });
    const typeSel  = h('select', null, ...SERVICE_TYPES.map(([v, l]) => h('option', { value: v, selected: (svc && svc.type ? svc.type : 'consultation') === v }, l)));
    const priceInp = h('input', { type: 'number', min: '0', step: 'any', required: true,
        value: (svc && svc.price != null) ? String(svc.price) : '' });
    const durInp   = h('input', { type: 'number', min: '0', step: '5',
        value: String((svc && svc.duration_minutes != null) ? svc.duration_minutes : 30) });
    const reqDocChk = h('input', { type: 'checkbox', checked: svc ? !!svc.requires_doctor : false });
    const activeChk = h('input', { type: 'checkbox', checked: svc ? !!svc.active : true });
    const isLabChk  = h('input', { type: 'checkbox', checked: svc ? !!svc.is_lab : false });

    // Lab-only fields — shown only while "Is lab test" is checked.
    const specimenInp  = h('input', { type: 'text', value: svc ? (svc.specimen || '') : '', placeholder: 'e.g. blood' });
    const resultUnitInp = h('input', { type: 'text', value: svc ? (svc.result_unit || '') : '', placeholder: 'e.g. mg/dL' });
    const refLowInp  = h('input', { type: 'number', step: 'any', value: (svc && svc.ref_low != null) ? String(svc.ref_low) : '' });
    const refHighInp = h('input', { type: 'number', step: 'any', value: (svc && svc.ref_high != null) ? String(svc.ref_high) : '' });
    const refTextInp = h('input', { type: 'text', value: svc ? (svc.ref_text || '') : '', placeholder: 'e.g. negative' });

    const labFieldsEl = h('div', { style: { display: isLabChk.checked ? 'flex' : 'none', flexDirection: 'column', gap: '14px' } },
        field('Specimen', specimenInp),
        field('Result unit', resultUnitInp),
        h('div', { class: 'row' },
            h('div', { class: 'grow' }, field('Ref low', refLowInp)),
            h('div', { class: 'grow' }, field('Ref high', refHighInp)),
        ),
        field('Ref text (non-numeric range)', refTextInp),
    );
    isLabChk.addEventListener('change', () => {
        labFieldsEl.style.display = isLabChk.checked ? 'flex' : 'none';
    });

    const saveBtn = h('button', { class: 'btn btn-primary', type: 'button' }, isEdit ? 'Save' : 'Add service');
    saveBtn.addEventListener('click', save);

    // SERVICE_DELETE_V1 — hard delete, but only for a service with no history.
    // Admin-only here because the RPC is admin-only; showing the button to
    // anyone else would just produce a 403 they can do nothing about.
    const deleteBtn = (isEdit && isAdmin())
        ? h('button', { class: 'btn btn-danger', type: 'button', onclick: confirmDelete },
            Icon('Trash', { size: 14 }), ' Удалить')
        : null;

    async function confirmDelete() {
        deleteBtn.disabled = true;
        try {
            // Ask first, so the dialog can say what will actually happen rather
            // than offering a delete that was never possible.
            const { data: chk, error } = await supabase.rpc('service_delete_check', { p_service_id: svc.id });
            if (error) throw error;

            if (!chk.deletable) {
                const where = chk.blocking.map(b => `${b.label}: ${b.count}`).join(', ');
                const ok = window.confirm(
                    trf('Услуга «{name}» уже используется ({where}).\n\nУдалить её нельзя — прошлые визиты и счёта ссылаются на неё по названию.\n\nОтключить её вместо удаления? Она исчезнет из списков выбора, а история останется целой.', { name: chk.name, where }));
                if (ok) await deactivate();
                return;
            }

            if (!window.confirm(trf('Удалить услугу «{name}» навсегда?\n\nОна нигде не использована, поэтому удаляется без следа.', { name: chk.name }))) return;
            const { error: delErr } = await supabase.rpc('delete_service', { p_service_id: svc.id });
            if (delErr) throw delErr;
            toast(trf('Услуга «{name}» удалена', { name: chk.name }), 'ok');
            close();
            if (typeof onSaved === 'function') await onSaved();
        } catch (e) {
            toast((e && e.message) || 'Не удалось удалить услугу.', 'fail');
        } finally {
            if (deleteBtn.isConnected) deleteBtn.disabled = false;
        }
    }

    async function deactivate() {
        const { error } = await supabase.from('services').update({ active: 0 }).eq('id', svc.id);
        if (error) throw error;
        toast('Услуга отключена — история сохранена', 'ok');
        close();
        if (typeof onSaved === 'function') await onSaved();
    }

    async function save() {
        const name  = nameInp.value.trim();
        const price = Number(priceInp.value);
        if (!name) { toast('Enter a service name.', 'fail'); return; }
        if (!Number.isFinite(price) || price < 0) { toast('Enter a valid price.', 'fail'); return; }

        saveBtn.disabled = true;
        const prevLabel = saveBtn.textContent;
        saveBtn.textContent = isEdit ? 'Saving…' : 'Adding…';
        try {
            const payload = {
                name,
                price,
                type:             typeSel.value,
                duration_minutes: Number(durInp.value) || 30,
                requires_doctor:  reqDocChk.checked ? 1 : 0,
                active:           activeChk.checked ? 1 : 0,
                is_lab:           isLabChk.checked ? 1 : 0,
            };
            const code = codeInp.value.trim();
            if (code) payload.code = code;

            if (isLabChk.checked) {
                const specimen   = specimenInp.value.trim();
                const resultUnit = resultUnitInp.value.trim();
                const refText    = refTextInp.value.trim();
                const refLow     = Number(refLowInp.value);
                const refHigh    = Number(refHighInp.value);
                if (specimen) payload.specimen = specimen;
                if (resultUnit) payload.result_unit = resultUnit;
                if (refText) payload.ref_text = refText;
                if (refLowInp.value !== '' && Number.isFinite(refLow)) payload.ref_low = refLow;
                if (refHighInp.value !== '' && Number.isFinite(refHigh)) payload.ref_high = refHigh;
            }

            const { error } = isEdit
                ? await supabase.from('services').update(payload).eq('id', svc.id).select().single()
                : await supabase.from('services').insert(payload).select().single();
            if (error) throw error;

            toast('Saved', 'ok');
            close();
            if (typeof onSaved === 'function') await onSaved();
        } catch (e) {
            toast((e && e.message) || 'Failed to save service.', 'fail');
            saveBtn.disabled = false;
            saveBtn.textContent = prevLabel;
        }
    }

    overlay.appendChild(h('div', { class: 'modal-card modal-compact', style: { width: '440px', maxWidth: 'calc(100vw - 32px)' } },
        h('header', { class: 'modal-head' },
            h('h2', null, Icon('Coins', { size: 16 }), ' ', isEdit ? 'Edit service' : 'Add service'),
            h('button', { class: 'modal-close', onclick: close }, '×')),
        h('div', { class: 'modal-body' },
            field('Name', nameInp, { required: true }),
            field('Code', codeInp),
            field('Тип услуги (раздел)', typeSel),
            field('Price', priceInp, { required: true }),
            field('Duration (minutes)', durInp),
            checkField('Requires doctor', reqDocChk),
            checkField('Active', activeChk),
            checkField('Is lab test', isLabChk),
            labFieldsEl,
        ),
        h('footer', { class: 'modal-foot' },
            deleteBtn,
            h('button', { class: 'btn', type: 'button', onclick: close }, 'Cancel'),
            h('span', { class: 'grow' }),
            saveBtn),
    ));
    document.body.appendChild(overlay);
    nameInp.focus();
}
