// Generic CRUD view for one section defined in sections.js.
// Renders a list (with search + add) and per-row edit/delete via modal.
// Adapted from the previous Settings view, but lives at one route per section
// because top-nav menu items map 1:1 to sections.

import { supabase } from '../../supabase.js';
import { SECTIONS, FK_LABEL_COLUMN, FK_EXTRA_COLUMNS } from '../sections.js?v=rolecmp1';
import { permissionGroups, allPermissionKeys, canEdit, canDelete, PATIENT_TABS } from '../permissions.js';
import { hashPassword } from '../auth.js?v=admdoc3';
import { BRANCH_BUCKET, uploadFile, signedUrl, removeFile } from '../storage.js?v=aurora20b';
import { h, Icon, Tag, PageHead, toast, clear } from '../ui.js';
import { tr, trf } from '../i18n.js';
import { isClinicScopedTable, currentClinicId } from '../tenant-tables.js';
import { branchScope, branchFilterActive, BRANCH_PATHS } from '../branch-filter.js?v=bf4';   // BRANCH_ISOLATION_V2
import { getSelectedBranchIds, isBranchRestricted, getAvailableBranchIds, soleBranchId } from '../branch-context.js?v=bc3';   // soleBranchId: SOLE_BRANCH_V1
import { gw } from '../gateway.js';
import { clinicFlags, clinicFlagsSync } from '../clinic-flags.js';   // CUSTOM_CLINIC_V1
import {
    hasImporter,
    openSectionImporter,
    downloadSectionSample,
    exportRowsToExcel,
} from './section-import-export.js?v=aug17e';
import { openEmployeeEditor } from './employee-editor.js?v=multirole3';
import { renderItemsLedger } from './items-ledger.js?v=ledger3';   // ITEMS_LEDGER_V1
import { phoneInput, isCodeOnly } from '../phone-input.js?v=ph1';

const state = {
    sectionKey:    null,
    rows:          [],
    fkCache:       {},
    search:        '',
    columnFilters: {},                    // { [columnKey]: filterTerm }
    selectedIds:   new Set(),
    // PAGED_LIST_V1 — см. loadRows(): список читается СТРАНИЦАМИ с сервера.
    page:          0,                     // 0-based
    total:         0,                     // всего строк под текущими фильтрами
    paged:         false,                 // раздел читается страницами (большая таблица)
};

// PAGED_LIST_V1 — раньше список тянул ВСЮ таблицу (`select('*')` без limit) и
// рисовал по <tr> на каждую строку. На 70 000 пациентов это 52 МБ JSON, ~34 с
// на запрос и десятки тысяч узлов DOM — вкладка просто вставала. Теперь с
// сервера приходит одна страница, а поиск и фильтры колонок уходят в SQL.
const PAGE_SIZE = 40;
// Разделы меньше этого порога грузятся целиком и работают ровно как раньше
// (услуги ~500, сотрудники ~30, справочники — единицы). Страницы включаются
// только там, где выборка действительно большая.
const PAGE_ALL_MAX = 2000;

// The RBAC permission key for the section currently being edited. Settings
// sub-sections are keyed 'settings:<sectionKey>' (see permissions.js); top-level
// modules use the bare key. Drives whether Edit/Delete are offered.
function currentPermKey() {
    const k = state.sectionKey;
    if (!k) return null;
    return SECTIONS[k] ? 'settings:' + k : k;
}

// Active services + service types for the doctor "services performed" widget.
// Loaded on demand (with type_id so the widget can filter by type), cached.
let dsServices = null;   // [{ id, name, type_id, price }]
let dsTypes = null;      // [{ id, name }]
let dsBranches = null;   // [{ id, name }]
async function loadDoctorServiceData() {
    if (dsServices && dsTypes && dsBranches) return;
    const [svc, typ, br] = await Promise.all([
        (currentClinicId()
            ? supabase.from('services').select('id, name, type_id, price, active').eq('active', true).eq('company_id', currentClinicId()).order('name')
            : supabase.from('services').select('id, name, type_id, price, active').eq('active', true).order('name')),
        supabase.from('service_types').select('id, name, active').eq('active', true).order('name'),
        supabase.from('branches').select('id, name, active').eq('active', true).order('name'),
    ]);
    if (svc.error) console.warn('[doctor services] services load:', svc.error.message);
    if (typ.error) console.warn('[doctor services] types load:', typ.error.message);
    if (br.error)  console.warn('[doctor services] branches load:', br.error.message);
    dsServices = svc.data || [];
    dsTypes = typ.data || [];
    dsBranches = br.data || [];
}

// TAB_STATE_SYNC_V1 — admin.js opens each settings section as a cached TAB and
// switching tabs does not re-render, while this module keeps ONE shared `state`.
// Without syncing, every handler that reads `state` at click time (the Add button,
// row edit/delete, search, export) acted on whichever section rendered LAST —
// e.g. «Add service» opened the Add-employee dialog. Each container owns a
// snapshot of the mutable state; pointerdown/focusin in CAPTURE phase swap the
// module state to the tab being touched before any click handler runs.
let stateOwner = null;
function _crudSnapshot() {
    return { sectionKey: state.sectionKey, rows: state.rows, search: state.search,
             columnFilters: state.columnFilters, selectedIds: state.selectedIds };
}
function _crudRestore(snap) {
    state.sectionKey = snap.sectionKey; state.rows = snap.rows; state.search = snap.search;
    state.columnFilters = snap.columnFilters; state.selectedIds = snap.selectedIds;
}
function bindStateOwnership(container) {
    container.__crudSnap = _crudSnapshot();
    stateOwner = container;
    if (container.__crudSyncBound) return;
    const sync = () => {
        if (stateOwner === container) { container.__crudSnap = _crudSnapshot(); return; }
        if (stateOwner) stateOwner.__crudSnap = _crudSnapshot();
        _crudRestore(container.__crudSnap);
        stateOwner = container;
    };
    container.addEventListener('pointerdown', sync, true);
    container.addEventListener('focusin', sync, true);
    container.__crudSyncBound = true;
}

export async function renderSectionCrud(container, { sectionKey, onNavigate }) {
    state.sectionKey    = sectionKey;
    state.search        = '';
    state.columnFilters = {};
    state.selectedIds   = new Set();        // reset selection between sections
    bindStateOwnership(container);          // TAB_STATE_SYNC_V1
    const def = SECTIONS[sectionKey];
    if (!def) {
        clear(container);
        container.appendChild(h('div', { class: 'empty' }, 'Section not found.'));
        return;
    }
    if (sectionKey === 'services') { try { await clinicFlags(); } catch (e) {} }   // CUSTOM_CLINIC_V4 — warm for header + form
    paintShell(container, onNavigate);
    await loadRows(container, onNavigate);
}

function paintShell(container, onNavigate) {
    const def = SECTIONS[state.sectionKey];
    clear(container);

    // Excel import + sample download — only shown for sections that have an
    // import config registered in section-import-export.js.
    const extraButtons = [];
    // CUSTOM_CLINIC_V4 — a custom clinic still can pull services from the shared
    // medcore catalog, alongside creating its own via "+ Add service".
    if (state.sectionKey === 'services' && clinicFlagsSync().custom_services_enabled) {
        extraButtons.push(h('button', {
            class: 'btn btn-outline',
            title: 'Добавить услуги из общего каталога medcore',
            onclick: () => openAddServiceModal(container, onNavigate),
        }, Icon('Download', { size: 14 }), ' Из каталога'));
    }
    if (hasImporter(state.sectionKey)) {
        extraButtons.push(
            h('button', {
                class: 'btn btn-outline',
                title: 'Download a sample Excel template you can fill in',
                onclick: () => downloadSectionSample(state.sectionKey),
            }, Icon('Download', { size: 14 }), ' Sample'),
            h('button', {
                class: 'btn btn-outline',
                title: 'Import many rows from an .xlsx / .csv file',
                onclick: () => openSectionImporter({
                    sectionKey: state.sectionKey,
                    onImported: () => loadRows(container, onNavigate),
                }),
            }, Icon('Plus', { size: 14 }), ' Import Excel'),
        );
    }

    // ITEMS_LEDGER_V1 — Приход-расход report for the drugs/products catalog (Товары).
    if (state.sectionKey === 'clinic_items') {
        extraButtons.push(h('button', {
            class: 'btn btn-outline',
            title: 'Приход-расход: поступление и расход по себестоимости',
            onclick: () => renderItemsLedger(container, { onBack: () => renderSectionCrud(container, { sectionKey: 'clinic_items', onNavigate }) }),
        }, Icon('Coins', { size: 14 }), ' Приход-расход'));
    }

    container.appendChild(h('div', { class: 'fade-in' },
        PageHead({
            title: tr(def.label),
            subtitle: 'Manage records in this section.',
            right: [
                h('div', { style: { position: 'relative' } },
                    h('input', {
                        id: 'crud-search',
                        placeholder: tr('Search…'),
                        style: { height: '34px', padding: '0 12px', border: '1px solid var(--ink-200)', borderRadius: '8px', fontSize: '13px', minWidth: '240px' },
                        value: state.search,
                        oninput: (e) => { state.search = e.target.value; onFilterChanged(container, onNavigate); },
                    }),
                ),
                ...extraButtons,
                canEdit(currentPermKey()) && h('button', { class: 'btn btn-primary', onclick: () => openEditor(container, onNavigate, null) },
                    Icon('Plus', { size: 14 }), state.sectionKey === 'services' ? ' Add service' : ' Add'),
            ].filter(Boolean),
        }),
        // Optional KPI strip — sections opt in by defining `headerStats`.
        // Re-computed after loadRows.
        h('div', { id: 'crud-stats-strip' }),
        // Bulk action bar — sits above the list card. Hidden by paintBulkBar
        // when nothing is selected.
        h('div', { id: 'crud-bulk-bar', style: { display: 'none' } }),
        h('div', { class: 'card', id: 'crud-list-card' },
            h('div', { class: 'empty' }, 'Loading…'),
        ),
    ));
}

// Render a section's headerStats above the list. Skips when the section
// hasn't defined any.
function paintHeaderStats(container) {
    const def = SECTIONS[state.sectionKey];
    const slot = container.querySelector('#crud-stats-strip');
    if (!slot) return;
    clear(slot);
    const stats = def.headerStats;
    if (!Array.isArray(stats) || stats.length === 0) return;
    slot.style.marginBottom = '14px';
    const grid = h('div', { style: {
        display: 'grid',
        gridTemplateColumns: `repeat(${stats.length}, 1fr)`,
        gap: '12px',
    } });
    for (const s of stats) {
        let value;
        try { value = s.compute(state.rows); }
        catch (e) { console.warn('[stats]', s.label, e); value = '—'; }
        grid.appendChild(h('div', { style: {
            padding: '14px 16px',
            border: '1px solid var(--ink-100)',
            borderRadius: '12px',
            background: 'white',
            display: 'flex', flexDirection: 'column', gap: '6px',
        } },
            h('div', { class: 'row', style: { gap: '8px', color: s.color || 'var(--ink-700)' } },
                s.icon && Icon(s.icon, { size: 16 }),
                h('span', { style: { fontSize: '12px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' } }, tr(s.label)),
            ),
            h('div', { class: 'num', style: { fontSize: '22px', fontWeight: 700, color: 'var(--ink-900)', letterSpacing: '-0.02em' } }, String(value)),
        ));
    }
    slot.appendChild(grid);
}

async function loadRows(container, onNavigate) {
    const def = SECTIONS[state.sectionKey];
    // BRANCH_ISOLATION_V2 — a restricted staffer with NO assigned branch sees nothing on a
    // branch-scoped section. Short-circuit before querying and show a clear empty-state.
    if (def.branchScoped && isBranchRestricted() && getAvailableBranchIds().length === 0) {
        state.rows = [];
        const listCard = container.querySelector('#crud-list-card');
        if (listCard) {
            clear(listCard);
            listCard.appendChild(h('div', { class: 'empty' },
                'Вам не назначен филиал. Обратитесь к администратору клиники, чтобы получить доступ к этому разделу.'));
        }
        paintHeaderStats(container);
        return;
    }
    if (def.fkLookups && def.fkLookups.length) {
        await Promise.all(def.fkLookups.map(t => primeFkCache(t)));
    }
    // BRANCH_ISOLATION_V2 — embed-filtered sections (rooms via floors, beds via wards) need the
    // parent inner-joined into the select so PostgREST can filter on `<rel>.branch_id`. But the
    // inner join also DROPS rows whose FK is null (e.g. a floorless room), so only add it when
    // branchScope() will actually filter (restricted staff, or owner narrowed to a subset).
    // When nobody is filtering, a plain `*` keeps null-FK rows visible. BRANCH_PATHS is the
    // single source of truth for the relation + column (no hardcoded floors/wards here).
    const _path = BRANCH_PATHS[def.table];
    const _embedSelect = (def.branchScoped && _path && _path.kind === 'embed' && branchFilterActive())
        ? `*, ${_path.rel}!inner(${_path.col})`
        : '*';
    // Базовый запрос без сортировки/страницы — используется и для замера размера,
    // и для самой выборки, чтобы область видимости (клиника, филиал) была одна.
    const baseQuery = (opts = {}) => {
        let q0 = supabase.from(def.table).select(opts.columns || _embedSelect, opts.count ? { count: 'exact' } : undefined);
        const cid = currentClinicId();   // TENANT_SCOPE_V2: each clinic sees only its own settings rows
        if (cid && isClinicScopedTable(def.table)) q0 = q0.eq('company_id', cid);
        if (def.table === 'users') {
            q0 = q0.not('is_super_admin', 'is', true);   // TENANT_LOCK_V1 — platform super-admins are never clinic staff
            if (!isClinicOwner()) q0 = q0.neq('role', 'admin').not('branch_id', 'is', null);   // BRANCH_STAFF_VISIBILITY_V1 — non-owners never see the owner or untagged staff
        }
        if (def.branchScoped) q0 = branchScope(q0, def.table);   // BRANCH_ISOLATION_V2 — per-branch sections
        return q0;
    };

    // PAGED_LIST_V1 — сколько строк в разделе ВООБЩЕ. Дешёвый COUNT(*) (без
    // выборки), зато решает главное: маленькие разделы (услуги, сотрудники,
    // справочники) читаются целиком и ведут себя ровно как раньше, а большие
    // (пациенты) переходят на страницы + фильтрацию на стороне SQL.
    let sizeProbe = { count: null, error: null };
    try { sizeProbe = await baseQuery({ columns: 'id', count: true }).limit(1); } catch (e) { /* деградируем в старый путь */ }
    const paged = Number.isFinite(sizeProbe.count) && sizeProbe.count > PAGE_ALL_MAX;
    state.paged = paged;

    let q = baseQuery({ count: paged });
    // Поиск и фильтры колонок считает SQL — иначе для этого пришлось бы сначала
    // выкачать всю таблицу в браузер (ради чего всё и затевалось).
    if (paged) q = applyListFilters(q, def);
    if (def.orderBy) q = q.order(def.orderBy.column, { ascending: def.orderBy.ascending !== false });
    if (paged) {
        // Устойчивый порядок: без вторичного ключа строки с одинаковым created_at
        // могут перескакивать между страницами (и теряться при листании).
        if (!def.orderBy || def.orderBy.column !== 'id') q = q.order('id', { ascending: false });
        const from = state.page * PAGE_SIZE;
        q = q.range(from, from + PAGE_SIZE - 1);
    }
    const { data, error, count } = await q;
    const listCard = container.querySelector('#crud-list-card');
    if (!listCard) return;
    if (error) {
        clear(listCard);
        listCard.appendChild(h('div', { class: 'error-state' },
            'Could not load data from Supabase: ', h('code', null, error.message), '. ',
            'Check the table ', h('code', null, def.table), ' exists.'));
        return;
    }
    state.rows = data || [];
    state.total = paged ? (Number.isFinite(count) ? count : state.rows.length) : state.rows.length;
    // Страница уехала за конец списка (строку удалили, фильтр сузил выборку) —
    // отступаем на последнюю существующую, иначе виден пустой экран.
    if (paged && state.rows.length === 0 && state.page > 0 && state.total > 0) {
        state.page = Math.max(0, Math.ceil(state.total / PAGE_SIZE) - 1);
        return loadRows(container, onNavigate);
    }
    // BRANCH_STAFF_VISIBILITY_V1 — a non-owner Employees list hides PEER staff-managers
    // (roles granting settings:users/roles) so every visible row is actually manageable.
    if (def.table === 'users' && !isClinicOwner() && state.rows.length) {
        try {
            const _cid = (window.easymed && window.easymed.state && window.easymed.state.user && window.easymed.state.user.company_id) || null;
            const { data: _rs } = await supabase.from('roles').select('id, permissions').eq('company_id', _cid);
            const _mgr = new Set((_rs || []).filter(r => { const s = (r.permissions && r.permissions.sections) || []; return s.includes('settings:users') || s.includes('settings:roles'); }).map(r => String(r.id)));
            if (_mgr.size) state.rows = state.rows.filter(u => !_mgr.has(String(u.role_id)));
        } catch (e) { /* non-fatal */ }
    }
    paintHeaderStats(container);
    paintList(container, onNavigate);
}

// PAGED_LIST_V1 — переносит «Поиск…» и фильтры колонок в SQL. Правило одно:
// серверное условие не должно быть СТРОЖЕ клиентского из filterRows(), иначе со
// страницы пропадут строки, которые раньше показывались. Поэтому bool-фильтр
// «inactive» пропускает и NULL, а типы, которые нельзя выразить точно, просто не
// уходят на сервер — их дофильтрует прежний клиентский проход.
function applyListFilters(q, def) {
    // Запятая и точка — разделители в PostgREST-строке .or(); экранировать их
    // нечем, поэтому такой запрос отдаём клиентскому фильтру целиком.
    const orSafe = (s) => !/[,()]/.test(s);

    const raw = (state.search || '').trim();
    // Запятая/скобки ломают разбор .or(), поэтому от такого запроса берём самый
    // длинный безопасный кусок: он ЗАВЕДОМО ШИРЕ исходного, и точный отбор
    // доделает клиентский filterRows() — строки при этом не теряются.
    const term = orSafe(raw) ? raw : raw.split(/[,()]+/).sort((a, b) => b.length - a.length)[0] || '';
    if (term) {
        const cols = (def.searchColumns && def.searchColumns.length)
            ? def.searchColumns
            : def.columns.map(c => c.key);
        // Значение уходит в LIKE как есть (db-client не переводит PostgREST '*'),
        // поэтому подстановочный знак пишем сразу SQL-ный.
        if (cols.length) q = q.or(cols.map(c => `${c}.ilike.%${term}%`).join(','));
    }

    for (const [key, raw] of Object.entries(state.columnFilters || {})) {
        const f = String(raw || '').trim();
        if (!f) continue;
        const col = def.columns.find(c => c.key === key);
        // showIf-колонки (EMP_APPT_DOCTOR_ONLY_V1) зависят от строки — только клиент.
        if (!col || typeof col.showIf === 'function') continue;

        if (col.type === 'bool') {
            const lc = f.toLowerCase();
            if (['active', 'true', 'yes', '1', 'on'].includes(lc)) q = q.eq(col.key, true);
            // «Неактивен» у клиента — это !v, то есть и 0, и NULL.
            else if (['inactive', 'false', 'no', '0', 'off'].includes(lc) && orSafe(col.key)) {
                q = q.or(`${col.key}.eq.false,${col.key}.is.null`);
            }
            continue;
        }
        if (col.lookup) {
            // Клиент сравнивает с ПОДПИСЬЮ связанной строки — переводим её в id.
            const labelCol = FK_LABEL_COLUMN[col.lookup] || 'name';
            const ids = (state.fkCache[col.lookup] || [])
                .filter(r => String(r[labelCol] || r.full_name || r.name || '').toLowerCase().includes(f.toLowerCase()))
                .map(r => r.id);
            q = ids.length ? q.in(col.key, ids) : q.eq(col.key, -1);   // ничего не совпало → пустой список
            continue;
        }
        if (col.type === 'enum_label' && Array.isArray(col.options)) {
            const vals = col.options
                .filter(([val, label]) => String(label || val).toLowerCase().includes(f.toLowerCase()))
                .map(([val]) => val);
            q = vals.length ? q.in(col.key, vals) : q.eq(col.key, -1);
            continue;
        }
        q = q.ilike(col.key, `%${f}%`);
    }
    return q;
}

// PAGED_LIST_V1 — на страничном разделе поиск/фильтр меняет саму ВЫБОРКУ, а не
// только видимые строки, поэтому нужен новый запрос. Задержка — чтобы не слать
// его на каждую букву. Непагинированный раздел, как и раньше, фильтруется в
// памяти: мгновенно и без сети.
let _filterTimer = null;
function onFilterChanged(container, onNavigate) {
    if (!state.paged) { paintList(container, onNavigate); return; }
    state.page = 0;
    clearTimeout(_filterTimer);
    _filterTimer = setTimeout(() => loadRows(container, onNavigate), 250);
}

function paintList(container, onNavigate) {
    const def = SECTIONS[state.sectionKey];
    const listCard = container.querySelector('#crud-list-card');
    if (!listCard) return;
    const filtered = filterRows(state.rows, def, state.search);
    clear(listCard);

    // Drop stale selections when the row set changes (filter / reload).
    const filteredIds = new Set(filtered.map(r => r.id));
    for (const id of [...state.selectedIds]) {
        if (!filteredIds.has(id)) state.selectedIds.delete(id);
    }

    // EMPTY_FILTER_KEEPS_FILTERS_V2 — the table shell (header + filter row)
    // renders unconditionally: with zero matching rows AND with zero rows at
    // all. The empty message lives inside tbody, so the filter inputs never
    // vanish and a stuck filter can always be reset in place.

    const allChecked = filtered.every(r => state.selectedIds.has(r.id));
    const someChecked = !allChecked && filtered.some(r => state.selectedIds.has(r.id));

    const headerBox = h('input', {
        type: 'checkbox',
        title: allChecked ? 'Deselect all' : 'Select all',
        onchange: (ev) => {
            if (ev.target.checked) for (const r of filtered) state.selectedIds.add(r.id);
            else                   for (const r of filtered) state.selectedIds.delete(r.id);
            paintList(container, onNavigate);
        },
    });
    headerBox.checked = allChecked;
    headerBox.indeterminate = someChecked;

    const hasAnyColumnFilter = Object.values(state.columnFilters || {}).some(v => String(v || '').trim());

    listCard.appendChild(h('table', { class: 'list' },
        h('thead', null,
            h('tr', null,
                h('th', { style: { width: '36px' } }, headerBox),
                ...def.columns.map(c => h('th', null, tr(c.label || c.key))),
                h('th', { style: { width: '140px', textAlign: 'right' } }, 'Actions'),
            ),
            // Per-column filter row — instant in-memory narrowing without
            // re-querying the DB.
            h('tr', { class: 'filter-row', style: { background: 'var(--ink-25)' } },
                h('th', { style: { textAlign: 'center', verticalAlign: 'middle' } },
                    hasAnyColumnFilter
                        ? h('button', {
                            type: 'button',
                            title: 'Clear all column filters',
                            style: {
                                background: 'transparent', border: 0, padding: 0, cursor: 'pointer',
                                color: 'var(--crit-700)', fontSize: '14px', lineHeight: '1',
                            },
                            onclick: () => {
                                state.columnFilters = {};
                                onFilterChanged(container, onNavigate);
                            },
                        }, '×')
                        : h('span', { class: 'muted', style: { fontSize: '11px' } }, '⌕'),
                ),
                ...def.columns.map(c => h('th', null, columnFilterInput(c, container, onNavigate))),
                h('th'),
            ),
        ),
        h('tbody', null, ...(filtered.length ? [] : [
            // EMPTY_FILTER_KEEPS_FILTERS_V2 — zero rows to show: message (and a
            // reset button when filters are the cause) INSIDE the table so the
            // filter row above stays usable in every case.
            h('tr', null, h('td', { colspan: String(def.columns.length + 2), style: { textAlign: 'center', padding: '32px 16px' } },
                h('div', { class: 'muted', style: { fontSize: '13px', marginBottom: '10px' } },
                    state.rows.length
                        ? 'Ни одна строка не соответствует фильтрам.'
                        : (state.sectionKey === 'services'
                            ? 'Услуг пока нет — нажмите «Добавить услугу» или Import Excel.'
                            : 'Записей пока нет — нажмите + Add, чтобы создать.')),
                (state.rows.length || hasAnyColumnFilter || state.search) ? h('button', {
                    class: 'btn btn-outline btn-sm', type: 'button',
                    onclick: () => {
                        state.columnFilters = {};
                        state.search = '';
                        const searchInp = container.querySelector('#crud-search, .crud-search input, input[type="search"]');
                        if (searchInp) searchInp.value = '';
                        onFilterChanged(container, onNavigate);
                    },
                }, 'Сбросить фильтры') : null,
            )),
        ]), ...filtered.map(row => {
            const rowBox = h('input', {
                type: 'checkbox',
                onchange: (ev) => {
                    if (ev.target.checked) state.selectedIds.add(row.id);
                    else                   state.selectedIds.delete(row.id);
                    paintBulkBar(container, onNavigate, def);
                    // Re-sync the header checkbox state without rebuilding the table.
                    const all = filtered.every(r => state.selectedIds.has(r.id));
                    const some = !all && filtered.some(r => state.selectedIds.has(r.id));
                    headerBox.checked = all;
                    headerBox.indeterminate = some;
                },
            });
            if (state.selectedIds.has(row.id)) rowBox.checked = true;
            const mayEdit = canEdit(currentPermKey()) && !(def.table === 'roles' && row.locked);     // CASHIER_ROLE_LOCK_V1 — built-in roles are view-only
            const mayDelete = canDelete(currentPermKey()) && !(def.table === 'roles' && row.locked);
            return h('tr', null,
                h('td', null, rowBox),
                ...def.columns.map(c => h('td', null, renderCell(row, c))),
                h('td', { style: { textAlign: 'right' } },
                    h('div', { class: 'row', style: { justifyContent: 'flex-end', gap: '6px', alignItems: 'center' } },
                        (def.table === 'roles' && row.locked) ? h('span', { title: 'Built-in role - cannot be edited or deleted', style: { fontSize: '11px', color: 'var(--ink-500)', whiteSpace: 'nowrap' } }, 'Built-in') : null,
                        h('button', { class: 'btn btn-outline btn-sm',
                            onclick: () => openEditor(container, onNavigate, row) },
                            mayEdit ? 'Edit' : 'View'),
                        mayDelete && h('button', { class: 'btn btn-danger btn-sm', onclick: () => deleteRow(container, onNavigate, row) }, 'Del'),
                    ),
                ),
            );
        })),
    ));

    // PAGED_LIST_V1 — пейджер. Без него до 70 000 строк дальше первой полусотни
    // не добраться: показываем позицию и переходы, счётчик — с сервера.
    if (state.paged) {
        const pages = Math.max(1, Math.ceil(state.total / PAGE_SIZE));
        const first = state.total ? state.page * PAGE_SIZE + 1 : 0;
        const last  = Math.min(state.total, (state.page + 1) * PAGE_SIZE);
        const go = (label, target, disabled, title) => h('button', {
            class: 'btn btn-outline btn-sm', type: 'button',
            disabled: disabled ? true : null, title: title || '',
            style: disabled ? { opacity: '0.45', cursor: 'default' } : null,
            onclick: () => { if (disabled) return; state.page = target; loadRows(container, onNavigate); },
        }, label);
        listCard.appendChild(h('div', {
            class: 'row',
            style: { gap: '8px', alignItems: 'center', padding: '12px 4px 2px', flexWrap: 'wrap' },
        },
            h('span', { class: 'muted', style: { fontSize: '12.5px' } },
                state.total ? trf('{first}–{last} из {total}', { first, last, total: state.total }) : 'Ничего не найдено'),
            h('span', { class: 'grow' }),
            go('«', 0, state.page === 0, 'В начало'),
            go('‹ Назад', state.page - 1, state.page === 0),
            h('span', { style: { fontSize: '12.5px', fontWeight: 600, minWidth: '84px', textAlign: 'center' } },
                `${state.page + 1} / ${pages}`),
            go('Вперёд ›', state.page + 1, state.page >= pages - 1),
            go('»', pages - 1, state.page >= pages - 1, 'В конец'),
        ));
    }

    paintBulkBar(container, onNavigate, def);

    // Restore focus + caret to the filter input the user was typing in —
    // without this the column header input loses focus on every keystroke
    // because the table is rebuilt from scratch on each filter change.
    if (state._focusFilterKey) {
        const key = state._focusFilterKey;
        const pos = state._focusCaretPos;
        const inp = listCard.querySelector(`.filter-row [data-filter-key="${key}"]`);
        if (inp) {
            inp.focus();
            if (pos != null && typeof inp.setSelectionRange === 'function') {
                try { inp.setSelectionRange(pos, pos); } catch (_) {}
            }
        }
        // Single-shot — clear so unrelated re-renders don't steal focus.
        state._focusFilterKey = null;
        state._focusCaretPos  = null;
    }
}

// ---------------------------------------------------------------------------
// Bulk action bar — shown above the list card whenever at least one row is
// ticked. Carries selection count + Export to Excel + Delete actions.
// ---------------------------------------------------------------------------
function paintBulkBar(container, onNavigate, def) {
    const bar = container.querySelector('#crud-bulk-bar');
    if (!bar) return;
    const count = state.selectedIds.size;
    if (count === 0) {
        bar.style.display = 'none';
        clear(bar);
        return;
    }
    clear(bar);
    bar.style.display = '';
    bar.appendChild(h('div', {
        style: {
            display: 'flex', alignItems: 'center', gap: '10px',
            padding: '10px 14px', marginBottom: '12px',
            background: 'var(--primary-50)',
            border: '1px solid var(--primary-200)',
            borderRadius: '10px',
        },
    },
        h('span', { style: { color: 'var(--primary-700)' } }, Icon('Check', { size: 14 })),
        h('span', { style: { fontSize: '13px', color: 'var(--primary-700)', fontWeight: 600 } },
            String(count) + ' selected'),
        h('button', {
            class: 'btn btn-ghost btn-sm', type: 'button',
            style: { color: 'var(--primary-700)' },
            onclick: () => { state.selectedIds.clear(); paintList(container, onNavigate); },
        }, 'Clear'),
        h('span', { class: 'grow' }),
        h('button', {
            class: 'btn btn-outline',
            onclick: () => bulkExport(def),
        }, Icon('Download', { size: 14 }), ' Export to Excel'),
        canDelete(currentPermKey()) && h('button', {
            class: 'btn btn-danger',
            onclick: () => bulkDelete(container, onNavigate, def),
        }, Icon('Trash', { size: 14 }), ' Delete'),
    ));
}

async function bulkExport(def) {
    const ids = state.selectedIds;
    const rows = state.rows.filter(r => ids.has(r.id));
    if (rows.length === 0) { toast('Nothing to export.', 'fail'); return; }
    await exportRowsToExcel({
        filenameStem: state.sectionKey,
        sheetName:    def.label,
        rows,
        columns:      def.columns,
        fkLabelLookup: fkLabelText,
    });
    toast(`Exported ${rows.length} row${rows.length > 1 ? 's' : ''}.`);
}

// ROLE_ADMIN_ONLY_V1 — creating/editing roles (access levels) and assigning roles
// is the clinic OWNER's job alone. The DB enforces it (RLS on roles/users writes
// requires current_user_is_admin()); this client gate keeps the UI honest so a
// delegated staffer doesn't get a dead button + a raw "permission denied".
function isClinicOwner() {
    try {
        const u = (window.easymed && window.easymed.state && window.easymed.state.user) || {};
        return u.is_super_admin === true || (u.is_admin === true && !!u.company_id);
    } catch (e) { return false; }
}

// DELETE_INTEGRITY_V1 — deleting a role/position/department silently nulls the
// referencing users.*_id (FK ON DELETE SET NULL). A nulled role_id is worse than
// cosmetic: that user fails OPEN to full sidebar access on next login. So warn
// with the dependent count before deleting one of these.
async function staffDeleteWarning(table, ids) {
    const map = {
        roles:       { col: 'role_id',       noun: 'сотрудник(ов) с этой ролью' },
        positions:   { col: 'position_id',   noun: 'сотрудник(ов) на этой должности' },
        departments: { col: 'department_id', noun: 'сотрудник(ов) в этом отделе' },
    };
    const c = map[table];
    if (!c || !ids || !ids.length) return '';
    try {
        const { count } = await supabase.from('users').select('id', { count: 'exact', head: true }).in(c.col, ids);
        if (!count) return '';
        return fillWarn(count, c.noun);
    } catch (e) { return ''; }
}

// I18N_COVERAGE_V1 — предупреждение собирается вокруг числа и слова-существительного;
// перевод СНАЧАЛА (шаблон целиком — ключ словаря, noun переводится отдельным словом).
function fillWarn(count, noun) {
    return trf('Внимание: {count} {noun}. Удаление снимет у них эту привязку.', { count, noun: tr(noun) }) + '\n\n';
}

// DELETE_SOFT_FALLBACK_V1 — rows already referenced by history (e.g. a
// service used in visits) can't be hard-deleted: the FK protects the visit
// archive. When the table has an `active` flag we deactivate instead, and
// tell the user in plain words rather than dumping the raw gateway error.
function _hasActiveField(def) {
    return (def.fields || []).some(f => f.key === 'active');
}
function _cleanErr(msg) {
    const s = String(msg || '');
    if (/<\s*(!doctype|html)/i.test(s)) return 'Сервер отклонил удаление (ошибка шлюза).';
    return s.length > 300 ? s.slice(0, 300) + '…' : s;
}
async function _deleteOne(def, id) {
    // → { outcome: 'deleted' | 'deactivated', error? }
    if (def.gatewayCrud) {   // ITEMS_CRUD_WIRE_V1
        try { await gw('/crud/' + def.table + '/' + id, { method: 'DELETE' }); return { outcome: 'deleted' }; }
        catch (e) {
            if (_hasActiveField(def)) {
                try { await gw('/crud/' + def.table + '/' + id, { method: 'PATCH', body: { active: false } }); return { outcome: 'deactivated' }; }
                catch (e2) { return { error: _cleanErr(e2 && e2.message || e2) }; }
            }
            return { error: _cleanErr(e && e.message || e) };
        }
    }
    const { error } = await supabase.from(def.table).delete().eq('id', id);
    if (!error) return { outcome: 'deleted' };
    if (_hasActiveField(def) && (error.code === '23503' || /foreign key|referenced/i.test(error.message || ''))) {
        const { error: e2 } = await supabase.from(def.table).update({ active: false }).eq('id', id);
        if (!e2) return { outcome: 'deactivated' };
        return { error: _cleanErr(e2.message) };
    }
    return { error: _cleanErr(error.message) };
}
function _deleteSummaryToast(deleted, deactivated, firstError) {
    if (firstError && !deleted && !deactivated) { toast(firstError, 'fail'); return; }
    const parts = [];
    if (deleted)     parts.push(trf('удалено {n}', { n: deleted }));
    if (deactivated) parts.push(trf('{n} уже использовались — деактивированы (active=false)', { n: deactivated }));
    toast(parts.join('; ') + (firstError ? '; ' + trf('ошибка: {msg}', { msg: firstError }) : '.'), firstError ? 'fail' : 'ok');
}

async function bulkDelete(container, onNavigate, def) {
    const ids = [...state.selectedIds];
    if (ids.length === 0) return;
    if (!canDelete(currentPermKey())) { toast('Your role can’t delete here (Admin level required).', 'fail'); return; }
    const _warn = await staffDeleteWarning(def.table, ids);   // DELETE_INTEGRITY_V1
    if (!confirm(_warn + `Delete ${ids.length} ${def.label} row${ids.length > 1 ? 's' : ''}? This cannot be undone.`)) return;
    let deleted = 0, deactivated = 0, firstError = null;
    for (const _id of ids) {
        const res = await _deleteOne(def, _id);
        if (res.outcome === 'deleted') deleted++;
        else if (res.outcome === 'deactivated') deactivated++;
        else { firstError = res.error; break; }
    }
    _deleteSummaryToast(deleted, deactivated, firstError);
    state.selectedIds.clear();
    await loadRows(container, onNavigate);
}

// Per-column filter input rendered under the column header. Bool columns
// get a 3-state select (Any / Active / Inactive); everything else is a
// text input with a placeholder hinting at what to type. Lookup (FK)
// columns filter against the resolved human label via columnMatches().
function columnFilterInput(col, container, onNavigate) {
    const k = col.key;
    const cur = state.columnFilters[k] || '';
    const onInput = (e, val) => {
        // Remember which input was focused + caret position so the table
        // re-render that follows doesn't lose the user's typing context.
        state._focusFilterKey = k;
        state._focusCaretPos  = e.target.selectionStart ?? null;
        if (val) state.columnFilters[k] = val;
        else     delete state.columnFilters[k];
        onFilterChanged(container, onNavigate);
    };
    const baseStyle = {
        width: '100%', height: '28px', padding: '0 8px',
        borderRadius: '6px', border: '1px solid var(--ink-200)',
        background: 'white', fontSize: '12px', fontFamily: 'inherit',
        boxSizing: 'border-box',
    };

    // Bool — 3-state Any / Active / Inactive.
    if (col.type === 'bool') {
        return h('select', {
            dataset: { filterKey: k },
            style: baseStyle,
            onchange: (e) => onInput(e, e.target.value),
        },
            h('option', { value: '', selected: cur === '' }, 'Any'),
            h('option', { value: 'active',   selected: cur === 'active'   }, 'Active'),
            h('option', { value: 'inactive', selected: cur === 'inactive' }, 'Inactive'),
        );
    }

    // FK lookup (Type / Category / Department / Branch / …): pick from the
    // actual rows in that lookup table so the user doesn't have to remember
    // exact spelling. Sorted by label, "Any" wins by default.
    if (col.lookup) {
        const labelCol = FK_LABEL_COLUMN[col.lookup] || 'name';
        const rows = (state.fkCache[col.lookup] || [])
            .map(r => (r[labelCol] || r.full_name || r.name || r.id || '').trim())
            .filter(Boolean);
        const seen = new Set();
        const labels = rows.filter(l => { const k2 = l.toLowerCase(); if (seen.has(k2)) return false; seen.add(k2); return true; });
        labels.sort((a, b) => a.localeCompare(b));
        return h('select', {
            dataset: { filterKey: k },
            style: baseStyle,
            onchange: (e) => onInput(e, e.target.value),
        },
            h('option', { value: '', selected: cur === '' }, 'Any'),
            ...labels.map(l => h('option', { value: l.toLowerCase(), selected: cur === l.toLowerCase() }, l)),
        );
    }

    // Enum with a fixed set of (value, label) options — dropdown of labels.
    if (col.type === 'enum_label' && Array.isArray(col.options)) {
        return h('select', {
            dataset: { filterKey: k },
            style: baseStyle,
            onchange: (e) => onInput(e, e.target.value),
        },
            h('option', { value: '', selected: cur === '' }, 'Any'),
            ...col.options
                .filter(([val]) => val !== '')
                .map(([val, label]) => h('option', {
                    value: String(label || val).toLowerCase(),
                    selected: cur === String(label || val).toLowerCase(),
                }, label || val)),
        );
    }

    // Fallback — free-text substring filter.
    return h('input', {
        type: 'text',
        value: cur,
        placeholder: tr('Filter…'),
        dataset: { filterKey: k },
        style: baseStyle,
        oninput: (e) => onInput(e, e.target.value),
    });
}

function filterRows(rows, def, term) {
    let result = rows;

    // Global "Search…" box at the top — checks the section's searchColumns
    // (or every column if the section doesn't declare them).
    const t = (term || '').trim().toLowerCase();
    if (t) {
        const cols = (def.searchColumns && def.searchColumns.length) ? def.searchColumns : def.columns.map(c => c.key);
        result = result.filter(r => cols.some(k => {
            const v = r[k];
            return v != null && String(v).toLowerCase().includes(t);
        }));
    }

    // Per-column filter row under the table header. Each column gets its
    // own narrowing predicate so the user can type "Лаб" under Type, then
    // also "X07" under Code, etc. Empty filters are ignored.
    const colFilters = state.columnFilters || {};
    for (const [key, raw] of Object.entries(colFilters)) {
        const f = String(raw || '').trim().toLowerCase();
        if (!f) continue;
        const col = def.columns.find(c => c.key === key);
        if (!col) continue;
        result = result.filter(r => columnMatches(r, col, f));
    }

    return result;
}

// Per-column predicate. Lookup columns (Type, Category, Department, etc.)
// match against the resolved FK label so the user types human names, not
// uuids. Boolean columns accept "active"/"inactive"/"yes"/"no". Everything
// else is a substring match on the stringified cell value.
function columnMatches(row, col, f) {
    if (typeof col.showIf === 'function' && !col.showIf(row)) return false;   // EMP_APPT_DOCTOR_ONLY_V1
    const v = row[col.key];
    if (col.lookup) {
        if (v == null || v === '') return false;
        const label = String(fkLabelText(col.lookup, v) || '').toLowerCase();
        return label.includes(f);
    }
    if (col.type === 'bool') {
        const truthy = ['active', 'true', 'yes', '1', 'on'].includes(f);
        const falsy  = ['inactive', 'false', 'no', '0', 'off'].includes(f);
        if (truthy) return !!v;
        if (falsy)  return !v;
        return true;        // any other value = "Any" = don't filter
    }
    // enum_label — match against the visible label.
    if (col.type === 'enum_label' && Array.isArray(col.options)) {
        const opt = col.options.find(([val]) => String(val) === String(v));
        const label = (opt ? opt[1] : v) || '';
        return String(label).toLowerCase().includes(f);
    }
    if (v == null) return false;
    return String(v).toLowerCase().includes(f);
}

function renderCell(row, col) {
    if (typeof col.showIf === 'function' && !col.showIf(row)) return h('span', { class: 'muted' }, '—');   // EMP_APPT_DOCTOR_ONLY_V1 — per-row cell suppression
    const v = row[col.key];
    if (v == null || v === '') return h('span', { class: 'muted' }, '—');
    if (col.lookup)         return fkLabelText(col.lookup, v);
    if (col.type === 'bool') return v ? Tag('Active', { kind: 'ok' }) : Tag('Inactive', { kind: 'warn' });
    if (col.type === 'date') return new Date(v).toLocaleDateString();
    // Date with expiry colouring — red+bold when past today, amber within
    // 30 days, normal otherwise.
    if (col.type === 'date_expiry') {
        const d = new Date(v);
        if (Number.isNaN(d.getTime())) return String(v);
        const today = new Date(new Date().toDateString());
        const days = Math.floor((d.getTime() - today.getTime()) / 86400000);
        const text = d.toLocaleDateString();
        let style = {};
        if (days < 0)        style = { color: 'var(--crit-700)', fontWeight: 700 };
        else if (days <= 30) style = { color: 'var(--warn-700)', fontWeight: 600 };
        return h('span', { style }, text);
    }
    // Enum value rendered with its human label from the column's options.
    if (col.type === 'enum_label' && Array.isArray(col.options)) {
        const opt = col.options.find(([val]) => String(val) === String(v));
        // SVC_DOCTOR_TAG_COLOR_V1 — an option may carry its own tag kind as a
        // third tuple element: [value, label, kind]; falls back to col.tagKind.
        return opt ? Tag(opt[1], { kind: opt[2] || col.tagKind || '' }) : String(v);
    }
    if (col.type === 'money') {
        const n = Number(v);
        return Number.isFinite(n) ? n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : String(v);
    }
    if (Array.isArray(v)) return h('span', { class: 'muted' }, v.length ? v.join(', ') : '—');
    if (typeof v === 'object') return h('span', { class: 'muted' }, '⋯');
    return String(v) + (col.suffix || '');
}

function fkLabelText(table, id) {
    const labelCol = FK_LABEL_COLUMN[table] || 'name';
    const cached = state.fkCache[table];
    if (!cached) return '…';
    const row = cached.find(r => r.id === id);
    return row ? (row[labelCol] || row.full_name || row.name || row.id) : '—';
}

async function primeFkCache(table) {
    // Skip ONLY when the cache already has rows — an earlier empty/failed
    // load shouldn't poison the cache for the rest of the session, which
    // used to leave every FK column rendering as "—" until hard-refresh.
    const _branchScoped = !!BRANCH_PATHS[table];   // BRANCH_FK_SCOPE_V1 — floors/departments/etc. options follow the active branch
    if (!_branchScoped && state.fkCache[table]?.length) return;
    // LOOKUPS_CATALOG_V1 — service_types/service_categories are CORE-managed catalog
    // tables the browser can't read directly (service_role only); fetch via the gateway.
    if (table === 'service_types' || table === 'service_categories') {
        try {
            if (!state._catalogLk) state._catalogLk = await gw('/lookups/catalog');
            state.fkCache[table] = state._catalogLk[table] || [];
        } catch (e) { console.warn('[fk cache gw]', table, e.message); if (!state.fkCache[table]) state.fkCache[table] = []; }
        return;
    }
    const labelCol = FK_LABEL_COLUMN[table] || 'name';
    // Only the columns we actually need — asking for `full_name`/`code` on
    // tables that don't have them makes PostgREST reject the whole query
    // (HTTP 400 "column X does not exist"), which used to silently empty
    // the dropdown.
    const baseCols = `id, ${labelCol}`;
    // Some tables expose extra flag columns a form's `visibleWhen` reads
    // (e.g. service_types.requires_tube). Try with them, but fall back to the
    // base columns if they don't exist yet (migration not applied), so the
    // dropdown keeps working either way.
    const extra = FK_EXTRA_COLUMNS[table] || [];
    const _fkQ = (sel) => { let q = supabase.from(table).select(sel).limit(2000); if (_branchScoped) q = branchScope(q, table); return q; };   // BRANCH_FK_SCOPE_V1
    let { data, error } = await _fkQ(extra.length ? `${baseCols}, ${extra.join(', ')}` : baseCols);
    if (error && extra.length) {
        ({ data, error } = await _fkQ(baseCols));
    }
    if (error) {
        console.warn('[fk cache]', table, error.message);
        state.fkCache[table] = [];
        return;
    }
    state.fkCache[table] = data || [];
}

async function deleteRow(container, onNavigate, row) {
    const def = SECTIONS[state.sectionKey];
    if (!canDelete(currentPermKey())) { toast('Your role can’t delete here (Admin level required).', 'fail'); return; }
    const _warn = await staffDeleteWarning(def.table, [row.id]);   // DELETE_INTEGRITY_V1
    if (!confirm(_warn + `Delete this ${def.label} row?`)) return;
    const res = await _deleteOne(def, row.id);   // DELETE_SOFT_FALLBACK_V1
    if (res.error) { toast(res.error, 'fail'); return; }
    toast(res.outcome === 'deactivated'
        ? 'Запись уже использовалась в визитах — деактивирована (active=false) вместо удаления.'
        : 'Deleted.');
    await loadRows(container, onNavigate);
}

// ---------------------------------------------------------------------------
// Modal editor
// ---------------------------------------------------------------------------
// CUSTOM_CLINIC_V2 — flagged clinics own their services; the catalog-suffix
// hints in field labels would be misleading there.
function _customSvcLbl(lbl) {
    if (state.sectionKey === 'services' && clinicFlagsSync().custom_services_enabled) {
        return String(lbl).replace(/\s*\((из каталога|каталог|auto)\)/i, '');
    }
    return lbl;
}

async function openEditor(container, onNavigate, row, forceForm) {   // CUSTOM_CLINIC_V2
    const def = SECTIONS[state.sectionKey];

    // Employees use the dedicated, section-railed Edit Employee modal instead
    // of the generic grouped form. It saves to the same `users` schema.
    if (state.sectionKey === 'users') {
        openEmployeeEditor({
            row,
            readOnly: !canEdit(currentPermKey()),
            onSaved: () => loadRows(container, onNavigate),
        });
        return;
    }

    // SERVICE_REQUEST_V1: clinics can no longer create services directly.
    // Creating a NEW service (row === null) opens the "Request a service"
    // modal, which files a service_requests row for admin review. Editing an
    // existing service still uses the generic (price/operational-only) form.
    // CUSTOM_CLINIC_V2 — "Add service" opens the SAME catalog window for every
    // clinic (one shared structure across the platform). Clinics flagged
    // custom_services_enabled get an extra path from the wizard footer
    // (forceForm) into this generic form with all fields editable and
    // core_service_id left null.
    if (state.sectionKey === 'services') await clinicFlags();   // warm cache for formBody's sync reads
    if (state.sectionKey === 'services' && !row && !forceForm && !clinicFlagsSync().custom_services_enabled) {
        openAddServiceModal(container, onNavigate);   // ADD_SERVICE_CATALOG_V1 (shared clinics: catalog wizard)
        return;
    }
    const fkSources = new Set(def.fields.filter(f => f.type === 'fk' && f.source).map(f => f.source));
    // multi_fk fields also need their source cached.
    for (const f of def.fields) if (f.type === 'multi_fk' && f.source) fkSources.add(f.source);
    await Promise.all([...fkSources].map(primeFkCache));
    // DOCTOR_ROOM_V1: read-only «Врачи в кабинете» for the rooms section.
    let roomDoctors = [];
    if (state.sectionKey === 'rooms' && row?.id) {
        const { data, error } = await supabase
            .from('users')
            .select('full_name, specialty')
            .eq('room_id', row.id)
            .eq('is_doctor', true)
            .order('full_name');
        if (error) console.warn('[DOCTOR_ROOM_V1] roomDoctors load failed:', error.message);
        roomDoctors = data || [];
    }
    // The "services performed" widget needs the services + categories lists.
    if (def.fields.some(f => f.type === 'doctor_services')) await loadDoctorServiceData();
    if (def.fields.some(f => f.type === 'service_doctors')) await loadServiceDoctorData();

    // Pre-load existing junction rows so the multi-select shows ticks.
    const enrichedRow = { ...(row || {}) };
    if (row?.id) {
        for (const f of def.fields) {
            if (f.type !== 'multi_fk') continue;
            if (f.reverseFk) {   // REVERSE_FK_V1 — members come from a child table's FK column (e.g. users.department_id)
                const { data, error } = await supabase
                    .from(f.reverseFk.table).select('id').eq(f.reverseFk.fkCol, row.id);
                if (error) { console.warn('[reverse_fk] load failed:', error.message); continue; }
                enrichedRow[f.key] = (data || []).map(r => r.id);
                continue;
            }
            if (!f.junction) continue;
            const { data, error } = await supabase
                .from(f.junction.table)
                .select(f.junction.rightCol)
                .eq(f.junction.leftCol, row.id);
            if (error) { console.warn('[multi_fk] load failed:', error.message); continue; }
            enrichedRow[f.key] = (data || []).map(r => r[f.junction.rightCol]);
        }
    }

    const mayEdit = canEdit(currentPermKey()) && !(def.table === 'roles' && row && row.locked);   // ROLE_DELEGATION_V1 + CASHIER_ROLE_LOCK_V1 (built-in roles view-only)
    const overlay = h('div', { class: 'modal' });
    const card = h('div', { class: 'modal-card' + (def.groups ? ' modal-grouped has-groups' : '') },
        h('header', { class: 'modal-head' },
            h('h2', null, (state.sectionKey === 'services' && clinicFlagsSync().custom_services_enabled && !row)
                ? 'Своя услуга клиники'   // CUSTOM_CLINIC_V4
                : (!mayEdit ? `View ${tr(def.label)}` : row ? `Edit ${tr(def.label)}` : `Add ${tr(def.label)}`)),
            h('button', { class: 'modal-close', onclick: () => overlay.remove() }, '×'),
        ),
        formBody(def, enrichedRow),
        // DOCTOR_ROOM_V1 — read-only assigned-doctors panel (rooms section only).
        state.sectionKey === 'rooms' && row?.id && h('div', { class: 'docroom-panel' },
            h('h3', { class: 'docroom-panel-title' }, 'Врачи в кабинете'),
            roomDoctors.length
                ? h('ul', { class: 'docroom-doctors' },
                    ...roomDoctors.map(d => h('li', null,
                        d.full_name,
                        d.specialty && h('span', { class: 'muted' }, ' · ' + d.specialty))))
                : h('div', { class: 'muted docroom-empty' }, 'Нет назначенных врачей.')),
        h('footer', { class: 'modal-foot' },
            h('button', { class: 'btn', onclick: () => overlay.remove() }, mayEdit ? 'Cancel' : 'Close'),
            mayEdit && h('button', {
                class: 'btn btn-primary',
                onclick: async (e) => {
                    e.target.disabled = true;
                    try {
                        await saveRow(card, def, row);
                        toast('Saved.');
                        overlay.remove();
                        await loadRows(container, onNavigate);
                    } catch (err) {
                        toast(err.message || String(err), 'fail');
                    } finally { e.target.disabled = false; }
                },
            }, 'Save'),
        ),
    );
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: () => overlay.remove() }));
    overlay.appendChild(card);
    document.body.appendChild(overlay);
}

// SERVICE_REQUEST_V1 -----------------------------------------------------------
// "Request a service" modal. Clinics use this instead of directly creating a
// service row; it records the request in service_requests for admin review.
// Built with the same modal shell (h() + modal/modal-card/... classes) the
// generic editor above uses, so it looks native.
export function openServiceRequestModal() {
    // Bare inputs inside a .field wrapper with a plain <label> — the same
    // markup renderField() uses, so the generic modal CSS styles them.
    const nameInput  = h('input', { type: 'text', placeholder: 'e.g. Thyroid ultrasound', required: true });
    const catInput   = h('input', { type: 'text', placeholder: 'Optional' });
    const typeInput  = h('input', { type: 'text', placeholder: 'Optional' });
    const groupInput = h('input', { type: 'text', placeholder: 'Optional' });
    const noteInput  = h('textarea', { rows: 3, placeholder: 'Optional — anything that helps us set it up' });

    const field = (labelText, control) => h('div', { class: 'field' },
        h('label', null, labelText),
        control,
    );

    const overlay = h('div', { class: 'modal', style: { zIndex: '160' } });
    const body = h('form', { class: 'modal-body' },
        h('p', { style: { gridColumn: '1 / -1', margin: '0 0 4px', fontSize: '13px', color: 'var(--ink-500, #667)' } },
            "New services are added by our team. Tell us what you need and our team will set it up."),
        field('Service name *', nameInput),
        field('Category', catInput),
        field('Type', typeInput),
        field('Group', groupInput),
        field('Note', noteInput),
    );

    const submitBtn = h('button', {
        class: 'btn btn-primary',
        onclick: async (e) => {
            e.preventDefault();
            const name = nameInput.value.trim();
            if (!name) { toast('Service name is required.', 'fail'); nameInput.focus(); return; }
            const category = catInput.value.trim();
            const type     = typeInput.value.trim();
            const group    = groupInput.value.trim();
            const note     = noteInput.value.trim();
            e.target.disabled = true;
            try {
                const { error } = await supabase.from('service_requests').insert({
                    company_id: currentClinicId(),
                    name,
                    category: category || null,
                    type: type || null,
                    group_name: group || null,
                    note: note || null,
                });
                if (error) throw error;
                toast('Request sent. Our team will add this service shortly.');
                overlay.remove();
            } catch (err) {
                toast(err.message || String(err), 'fail');
            } finally { e.target.disabled = false; }
        },
    }, 'Send request');

    const card = h('div', { class: 'modal-card' },
        h('header', { class: 'modal-head' },
            h('h2', null, 'Request a service'),
            h('button', { class: 'modal-close', onclick: () => overlay.remove() }, '×'),
        ),
        body,
        h('footer', { class: 'modal-foot' },
            h('button', { class: 'btn', onclick: () => overlay.remove() }, 'Cancel'),
            submitBtn,
        ),
    );
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: () => overlay.remove() }));
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    setTimeout(() => nameInput.focus(), 0);
}

function formBody(def, values) {
    const body = h('form', { class: 'modal-body' });
    if (def.groups) {
        for (const g of def.groups) {
            const section = h('div', { class: 'mg-section' + (g.span === 'full' ? ' span-full' : '') },
                h('h3', null, g.title),
                h('div', { class: 'mg-grid' }, ...g.fields.map(fkey => {
                    const f = def.fields.find(x => x.key === fkey);
                    return f ? renderField(f, values) : null;
                }).filter(Boolean)),
            );
            body.appendChild(section);
        }
    } else {
        for (const f of def.fields) body.appendChild(renderField(f, values));
    }
    // Refresh conditional fields once on mount (handles initial values for an
    // existing row) and again whenever any input changes (handles UI toggles
    // like type_id → tube_color).
    setTimeout(() => refreshConditional(body, def), 0);
    body.addEventListener('change', () => refreshConditional(body, def));
    return body;
}

// Read the current form values into a plain object and toggle display on
// fields that opt into conditional visibility via `f.visibleWhen`. Returning
// false on the predicate hides the wrap; hidden wraps are skipped by saveRow
// so the underlying column is left untouched.
function refreshConditional(form, def) {
    const live = collectLiveValues(form, def);
    for (const f of def.fields) {
        if (typeof f.visibleWhen !== 'function') continue;
        const wrap = form.querySelector(`[data-field-key="${f.key}"]`);
        if (!wrap) continue;
        let show = true;
        try { show = !!f.visibleWhen(live, state.fkCache); } catch { show = true; }
        wrap.style.display = show ? '' : 'none';
        wrap.dataset.hidden = show ? '' : '1';
    }
}

function collectLiveValues(form, def) {
    const out = {};
    for (const wrap of form.querySelectorAll('[data-field-key]')) {
        const key = wrap.dataset.fieldKey;
        const type = wrap.dataset.fieldType;
        const inp = wrap.querySelector('input, select, textarea');
        if (!inp) continue;
        if (type === 'bool')      out[key] = inp.checked;
        else if (type === 'number') out[key] = inp.value === '' ? null : Number(inp.value);
        else if (type === 'phone')  out[key] = isCodeOnly(inp.value) ? null : inp.value;   // PHONE_INPUT_V1 — bare «+998» is not a value
        else                        out[key] = inp.value === '' ? null : inp.value;
    }
    return out;
}

// Searchable single-select (combobox). Used for `fk` fields, which can have
// long option lists (departments, services, IKPU codes…). The selected value
// lives in a hidden <input name=key> placed FIRST in the wrap, so the existing
// saveRow / collectLiveValues (`wrap.querySelector('input, select, textarea')`)
// read it unchanged. Choosing an option dispatches a bubbling `change` event so
// conditional fields (visibleWhen) still refresh.
function searchableSelect({ name, value, options, placeholder = 'Search…', onCreate = null }) {   // CUSTOM_CLINIC_V4
    const byId = new Map(options.map(o => [String(o.id), o.label]));
    const labelFor = (val) => (val !== '' && byId.has(String(val))) ? byId.get(String(val)) : '';

    const wrap   = h('div', { class: 'combo' });
    const hidden = h('input', { type: 'hidden', name, value: value != null ? value : '' });
    const search = h('input', { type: 'text', class: 'combo-input', autocomplete: 'off', placeholder, value: labelFor(value) });
    const menu   = h('div', { class: 'combo-menu', style: { display: 'none' } });
    wrap.append(hidden, search, menu);

    let isOpen = false;

    const position = () => {
        const r = search.getBoundingClientRect();
        const margin = 8;
        const spaceBelow = window.innerHeight - r.bottom - margin;
        const spaceAbove = r.top - margin;
        // Open upward when there isn't enough room below and there's more above —
        // otherwise the menu runs off the bottom of the screen and its lower
        // items become unreachable.
        const openUp = spaceBelow < 220 && spaceAbove > spaceBelow;
        const maxH = Math.max(140, Math.min(260, (openUp ? spaceAbove : spaceBelow)));
        menu.style.left = r.left + 'px';
        menu.style.width = r.width + 'px';
        menu.style.maxHeight = maxH + 'px';
        if (openUp) {
            menu.style.top = 'auto';
            menu.style.bottom = (window.innerHeight - r.top + 4) + 'px';
        } else {
            menu.style.bottom = 'auto';
            menu.style.top = (r.bottom + 4) + 'px';
        }
    };
    const optionRow = (label, id, selected) => h('div', {
        class: 'combo-opt' + (selected ? ' on' : ''),
        // mousedown (not click) + preventDefault keeps the input from blurring
        // before the choice registers.
        onmousedown: (e) => { e.preventDefault(); choose(id, label); },
    }, label);
    const renderMenu = () => {
        const t = search.value.trim().toLowerCase();
        // When the box still shows the selected label, list everything; once the
        // user types something different, filter by it.
        const showAll = !t || t === labelFor(hidden.value).toLowerCase();
        clear(menu);
        menu.appendChild(optionRow('—', '', hidden.value === ''));
        // CUSTOM_CLINIC_V4 — offer to create the typed value when it matches
        // nothing (custom clinic's own Type / Category / Department).
        const _typed = search.value.trim();
        if (onCreate && _typed && !options.some(o => String(o.label || '').trim().toLowerCase() === _typed.toLowerCase())) {
            const createRow = h('div', { class: 'combo-opt', style: { fontWeight: '600', color: 'var(--primary-700)' } }, trf('\uFF0B Создать «{name}»', { name: _typed }));
            createRow.addEventListener('mousedown', async (e) => {
                e.preventDefault();
                createRow.textContent = tr('Создание…');
                try {
                    const made = await onCreate(_typed);
                    if (made && made.id != null) {
                        const lbl = made.label != null ? made.label : _typed;
                        options.push({ id: made.id, label: lbl });
                        byId.set(String(made.id), lbl);
                        choose(made.id, lbl);
                    } else { createRow.textContent = trf('\uFF0B Создать «{name}»', { name: _typed }); }
                } catch (err) { createRow.textContent = trf('Ошибка: {msg}', { msg: (err && err.message) || err }); }
            });
            menu.appendChild(createRow);
        }
        const matches = showAll ? options : options.filter(o => o.label.toLowerCase().includes(t));
        const MAX = 100;   // keep the DOM light for large lists (IKPU codes etc.)
        if (!matches.length) menu.appendChild(h('div', { class: 'combo-empty' }, 'No matches'));
        else {
            for (const o of matches.slice(0, MAX)) menu.appendChild(optionRow(o.label, o.id, String(hidden.value) === String(o.id)));
            if (matches.length > MAX) menu.appendChild(h('div', { class: 'combo-empty' }, `+${matches.length - MAX} more — keep typing to narrow…`));
        }
    };
    const open = () => {
        if (isOpen) return;
        isOpen = true;
        menu.style.display = 'block';
        position();
        renderMenu();
        window.addEventListener('scroll', position, true);
        window.addEventListener('resize', position);
    };
    const close = () => {
        if (!isOpen) return;
        isOpen = false;
        menu.style.display = 'none';
        window.removeEventListener('scroll', position, true);
        window.removeEventListener('resize', position);
        search.value = labelFor(hidden.value);   // discard any unconfirmed typing
    };
    function choose(id, label) {
        hidden.value = id != null ? id : '';
        search.value = id === '' ? '' : label;
        close();
        hidden.dispatchEvent(new Event('change', { bubbles: true }));
    }

    // CREATABLE_COMBO_COMMIT_V1 — resolve a typed value (pick existing or
    // create) so the user can just type and move on. No-op when !onCreate.
    async function commitTyped() {
        if (!onCreate) return;
        const typed = search.value.trim();
        if (!typed) return;
        if (labelFor(hidden.value).trim().toLowerCase() === typed.toLowerCase()) return;
        const match = options.find(o => String(o.label || '').trim().toLowerCase() === typed.toLowerCase());
        if (match) { choose(match.id, match.label); return; }
        try {
            const made = await onCreate(typed);
            if (made && made.id != null) {
                const lbl = made.label != null ? made.label : typed;
                options.push({ id: made.id, label: lbl });
                byId.set(String(made.id), lbl);
                choose(made.id, lbl);
            }
        } catch (e) { /* keep the typed text so the user can retry */ }
    }
    search.addEventListener('focus', () => { open(); search.select(); });
    search.addEventListener('input', () => { open(); renderMenu(); });
    search.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { close(); search.blur(); }
        else if (e.key === 'Enter' && onCreate) { e.preventDefault(); commitTyped(); }
    });
    search.addEventListener('blur', () => setTimeout(() => { Promise.resolve(commitTyped()).then(close); }, 150));
    return wrap;
}

// Wide editors that need the full row inside a 2-col grouped modal grid,
// otherwise they'd be squeezed into a single column (~half the modal width).
const FULL_WIDTH_FIELD_TYPES = new Set(['section_picker', 'weekly_hours', 'doctor_services', 'service_doctors', 'multi_select', 'image', 'file_list', 'referral_rates']);   // REFERRAL_REWARDS_V1

function renderField(f, values) {
    const v = values[f.key];
    const wrap = h('div', { class: 'field', dataset: Object.assign({ fieldKey: f.key, fieldType: f.type || 'text' }, f.mirrorTo ? { mirrorTo: f.mirrorTo } : {}) },
        h('label', null, tr(_customSvcLbl(f.label || f.key))));   // CUSTOM_CLINIC_V2
    if (FULL_WIDTH_FIELD_TYPES.has(f.type)) wrap.style.gridColumn = '1 / -1';
    let input;
    switch (f.type) {
        case 'textarea': input = h('textarea', { name: f.key }, v != null ? v : ''); break;
        case 'referral_rates': {
            // REFERRAL_REWARDS_V1 — per-product-group % map, stored as jsonb
            // { service_type_id: percent }. Blank input = 0% for that group
            // (manual mode does NOT fall back to the general table).
            const cur = (v && typeof v === 'object') ? v : {};
            input = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
                h('div', { class: 'muted', style: { fontSize: '11.5px' } }, 'Загрузка групп услуг…'));
            (async () => {
                try {
                    const cid = currentClinicId();
                    let q = supabase.from('service_types').select('id, name').eq('active', true).order('name');
                    if (cid) q = q.eq('company_id', cid);
                    const { data, error } = await q;
                    if (error) { console.warn('[referral_rates]', error.message); return; }
                    clear(input);
                    if (!data || !data.length) { input.appendChild(h('div', { class: 'muted' }, 'Нет групп услуг.')); return; }
                    for (const t of data) {
                        input.appendChild(h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' } },
                            h('span', { style: { fontSize: '13px', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' } }, t.name),
                            h('span', { style: { flex: 'none' } },
                                h('input', { type: 'number', min: '0', max: '100', step: '0.1', 'data-rr-type': t.id,
                                    value: cur[t.id] != null ? String(cur[t.id]) : '', placeholder: '0',
                                    style: { width: '86px', textAlign: 'right' } }),
                                h('span', { class: 'muted', style: { marginLeft: '6px' } }, '%'))));
                    }
                    input.appendChild(h('div', { class: 'muted', style: { fontSize: '11px' } },
                        'Пусто = 0% для группы. Общие ставки в ручном режиме не подставляются.'));
                } catch (e) { console.warn('[referral_rates]', e.message); }
            })();
            break;
        }
        case 'number':   input = h('input', { type: 'number', name: f.key, step: f.step || '1', value: v != null ? v : (f.default != null ? f.default : '') }); break;
        case 'date':     input = h('input', { type: 'date', name: f.key, value: v ? String(v).slice(0, 10) : '' }); break;
        case 'email':    input = h('input', { type: 'email', name: f.key, value: v != null ? v : '' }); break;
        // PHONE_INPUT_V1 — country picker + grouping, defaulting to Uzbekistan.
        // The wrapper contains the real <input name=…>, so the generic value
        // readers below still find it; they normalize a bare «+998» to null.
        case 'phone':    input = phoneInput(f.key, f.placeholder || '+998 90 961 00 04', { value: v }); break;
        case 'bool': {
            input = h('input', { type: 'checkbox', name: f.key });
            if (v == null ? (f.default !== false) : !!v) input.checked = true;
            break;
        }
        case 'select': {
            input = h('select', { name: f.key });
            for (const [val, label] of (f.options || [])) {
                input.appendChild(h('option', { value: val, selected: String(v) === String(val) }, label));
            }
            break;
        }
        case 'fk': {
            const labelCol = FK_LABEL_COLUMN[f.source] || 'name';
            const opts = (state.fkCache[f.source] || []).map(row => ({
                id: row.id,
                label: row[labelCol] || row.full_name || row.name || row.id,
            }));
            // CUSTOM_CLINIC_V4 — a custom clinic owns its catalog, so Type/Category/
            // Department can be created inline. Types/categories are RLS-guarded,
            // so they go through the gateway create-or-get (company-scoped);
            // departments are company-local and inserted directly.
            let _onCreate = null;
            if (state.sectionKey === 'services' && clinicFlagsSync().custom_services_enabled) {
                if (f.source === 'service_types' || f.source === 'service_categories') {
                    _onCreate = async (nm) => {
                        const made = await gw('/lookups/catalog', { method: 'POST', body: { table: f.source, name: nm } });
                        if (made && made.id) {
                            (state.fkCache[f.source] = state.fkCache[f.source] || []).push({ id: made.id, name: made.name });
                            if (state._catalogLk && Array.isArray(state._catalogLk[f.source])) state._catalogLk[f.source].push({ id: made.id, name: made.name });
                            return { id: made.id, label: made.name };
                        }
                        return null;
                    };
                } else if (f.source === 'departments') {
                    _onCreate = async (nm) => {
                        const cid = currentClinicId();
                        const { data, error } = await supabase.from('departments').insert({ name: nm, company_id: cid, active: true }).select('id, name').single();
                        if (error) throw error;
                        (state.fkCache['departments'] = state.fkCache['departments'] || []).push({ id: data.id, name: data.name });
                        return { id: data.id, label: data.name };
                    };
                }
            }
            // SOLE_BRANCH_V1 — филиал в клинике один: подставляем его сам, чтобы
            // поле «Филиал» не оставалось пустым там, где выбирать не из чего.
            // Только для филиалов и только когда значения нет — остальные
            // справочники (врач, плательщик) угадывать нельзя.
            let _fkVal = v != null ? v : '';
            if (_fkVal === '' && f.source === 'branches' && soleBranchId() != null) _fkVal = soleBranchId();
            input = searchableSelect({ name: f.key, value: _fkVal, options: opts, onCreate: _onCreate,
                placeholder: _onCreate ? 'Выберите или впишите новую…' : undefined });
            break;
        }
        case 'multi_fk': {
            // Checkbox list — selected rows are written to f.junction by
            // saveRow after the main upsert.
            const selected = new Set(Array.isArray(v) ? v : []);
            const labelCol = FK_LABEL_COLUMN[f.source] || 'name';
            input = h('div', {
                class: 'multi-fk',
                style: {
                    display: 'flex', flexDirection: 'column', gap: '6px',
                    padding: '10px 12px', border: '1px solid var(--ink-200)',
                    borderRadius: '8px', maxHeight: '200px', overflow: 'auto',
                    background: 'var(--ink-25)',
                },
            });
            const opts = state.fkCache[f.source] || [];
            if (opts.length === 0) {
                input.appendChild(h('span', { class: 'muted', style: { fontSize: '12.5px' } },
                    'No ', f.source, ' to pick from.'));
            } else {
                for (const row of opts) {
                    const cb = h('input', { type: 'checkbox', value: row.id });
                    if (selected.has(row.id)) cb.checked = true;
                    input.appendChild(h('label', {
                        style: { display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '13px' },
                    },
                        cb,
                        h('span', null, row[labelCol] || row.full_name || row.name || row.id),
                    ));
                }
            }
            break;
        }
        case 'multi_select': {
            // Checkbox list with static options — selected values are
            // written as a text[] (or array) directly to the parent row.
            const selected = new Set(Array.isArray(v) ? v : []);
            input = h('div', {
                class: 'multi-select',
                style: {
                    display: 'flex', flexDirection: 'column', gap: '6px',
                    padding: '10px 12px', border: '1px solid var(--ink-200)',
                    borderRadius: '8px', maxHeight: '200px', overflow: 'auto',
                    background: 'var(--ink-25)',
                },
            });
            for (const [val, label] of (f.options || [])) {
                const cb = h('input', { type: 'checkbox', value: val });
                if (selected.has(val)) cb.checked = true;
                input.appendChild(h('label', {
                    style: { display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '13px' },
                },
                    cb,
                    h('span', null, label),
                ));
            }
            break;
        }
        case 'section_picker': {
            input = sectionPicker(v);
            break;
        }
        case 'password': {
            // Never prefill the hash. Blank on save = keep the existing one.
            input = h('input', {
                type: 'password', name: f.key, value: '',
                autocomplete: 'new-password',
                placeholder: 'Leave blank to keep current password',
            });
            break;
        }
        case 'image': {
            // SLICED2_FILE_FIELD: single private-bucket image. Stores the object
            // PATH (string) in data-file-value; preview via short-lived signed URL.
            input = imageFieldEditor(f, v);
            break;
        }
        case 'file_list': {
            // SLICED2_FILE_FIELD: jsonb array of { name, path, size } (e.g. certificates).
            input = fileListFieldEditor(f, v);
            break;
        }
        case 'weekly_hours': {
            input = weeklyHoursEditor(v);
            break;
        }
        case 'doctor_services': {
            input = doctorServicesEditor(v);
            break;
        }
        case 'service_doctors': {
            input = serviceDoctorsEditor(values);
            break;
        }
        default: input = h('input', { type: 'text', name: f.key, value: v != null ? v : (f.default != null ? f.default : '') });
    }
    const _fldRO = f.readOnly && !(state.sectionKey === 'services' && clinicFlagsSync().custom_services_enabled);   // CUSTOM_CLINIC_V1 — custom clinics edit all service fields
    if (_fldRO && input) {   // SERVICE_CATALOG_READONLY — value comes from the medcore catalog, not editable per-clinic
        try { input.disabled = true; } catch (e) {}
        try { input.style.opacity = '0.6'; input.style.cursor = 'not-allowed'; } catch (e) {}
        wrap.dataset.readonly = '1';
    }
    if (f.type === 'bool') {
        const lbl = wrap.querySelector('label');
        lbl.style.display = 'flex';
        lbl.style.flexDirection = 'row';
        lbl.style.alignItems = 'center';
        lbl.style.gap = '8px';
        lbl.prepend(input);
    } else {
        wrap.appendChild(input);
    }
    return wrap;
}

// ===== SLICED2_FILE_FIELD: private-bucket file editors (image + file_list) =====
// Both reuse storage.js (PRIVATE bucket -> object path stored in DB; display via
// short-lived signed URL). The current value is parked on the wrapper's
// data-file-value attribute and read back verbatim by saveRow.

// CLINIC_DOCS_PATH_V1 — the clinic-docs storage policies scope objects by their
// FIRST path segment (= company id). Generic editors must prefix uploads with the
// clinic id, otherwise every non-super-admin upload dies with an RLS violation.
function tenantPrefix(bucket, prefix) {
    const cid = currentClinicId();
    return (bucket === BRANCH_BUCKET && cid) ? (cid + '/' + (prefix || '')) : (prefix || '');
}

function imageFieldEditor(f, v) {
    const bucket = f.bucket || BRANCH_BUCKET;
    const isPublic = !!f.public;   // SLICED_PUBLIC_LOGO: public bucket -> store permanent public URL (not path)
    const wrap = h('div', { class: 'file-field' });
    wrap.dataset.fileValue = (v != null && v !== '') ? String(v) : '';
    const preview = h('div', { class: 'file-preview', style: { margin: '6px 0' } });
    const status  = h('span', { class: 'muted small', style: { fontSize: '12px' } }, '');
    const fileInput = h('input', { type: 'file', accept: 'image/*' });
    const clearBtn = h('button', {
        type: 'button', class: 'btn btn-outline', style: { display: v ? '' : 'none', marginLeft: '8px' },
        onclick: () => { wrap.dataset.fileValue = ''; preview.innerHTML = ''; clearBtn.style.display = 'none'; status.textContent = 'Removed (save to apply).'; },
    }, 'Remove');
    async function showPreview(path) {
        preview.innerHTML = '';
        if (!path) return;
        const url = isPublic ? path : await signedUrl(bucket, path);
        if (url) preview.appendChild(h('img', { src: url, alt: '', style: { maxHeight: '72px', maxWidth: '160px', borderRadius: '8px', border: '1px solid var(--ink-200)' } }));
        else preview.appendChild(h('span', { class: 'muted small' }, '(stored - preview unavailable)'));
    }
    fileInput.addEventListener('change', async () => {
        const file = fileInput.files && fileInput.files[0];
        if (!file) return;
        status.textContent = 'Uploading...';
        try {
            const meta = await uploadFile(bucket, file, tenantPrefix(bucket, f.prefix));
            const stored = isPublic ? (supabase.storage.from(bucket).getPublicUrl(meta.path).data.publicUrl) : meta.path;
            wrap.dataset.fileValue = stored;
            clearBtn.style.display = '';
            status.textContent = 'Uploaded.';
            await showPreview(stored);
        } catch (e) {
            status.textContent = 'Upload failed: ' + (e && e.message ? e.message : e);
            toast('Upload failed: ' + (e && e.message ? e.message : e), 'error');
        } finally { fileInput.value = ''; }
    });
    wrap.appendChild(h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } }, fileInput, clearBtn, status));
    wrap.appendChild(preview);
    if (v) showPreview(v);
    return wrap;
}

function fileListFieldEditor(f, v) {
    const bucket = f.bucket || BRANCH_BUCKET;
    const items = Array.isArray(v) ? v.slice() : [];
    const wrap = h('div', { class: 'file-list-field' });
    const listEl = h('div', { class: 'file-list', style: { display: 'flex', flexDirection: 'column', gap: '6px', margin: '6px 0' } });
    const status = h('span', { class: 'muted small', style: { fontSize: '12px' } }, '');
    function serialize() { wrap.dataset.fileValue = JSON.stringify(items); }
    function rowFor(it, idx) {
        const open = h('button', { type: 'button', class: 'btn btn-outline', onclick: async () => {
            const url = await signedUrl(bucket, it.path);
            if (url) window.open(url, '_blank', 'noopener'); else toast('File unavailable', 'error');
        } }, 'Open');
        const del = h('button', { type: 'button', class: 'btn btn-outline', onclick: () => {
            const removed = items.splice(idx, 1)[0];
            if (removed && removed.path) removeFile(bucket, removed.path);
            serialize(); redraw();
        } }, 'Remove');
        return h('div', { class: 'file-row', style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 8px', border: '1px solid var(--ink-200)', borderRadius: '8px' } },
            h('span', { style: { flex: 1, fontSize: '13px' } }, it.name || it.path || 'file'), open, del);
    }
    function redraw() {
        listEl.innerHTML = '';
        if (items.length === 0) listEl.appendChild(h('span', { class: 'muted small' }, 'No files yet.'));
        else items.forEach((it, idx) => listEl.appendChild(rowFor(it, idx)));
    }
    const fileInput = h('input', { type: 'file' });
    fileInput.addEventListener('change', async () => {
        const file = fileInput.files && fileInput.files[0];
        if (!file) return;
        status.textContent = 'Uploading...';
        try {
            const meta = await uploadFile(bucket, file, tenantPrefix(bucket, f.prefix));
            items.push(meta); serialize(); redraw();
            status.textContent = 'Added.';
        } catch (e) {
            status.textContent = 'Upload failed: ' + (e && e.message ? e.message : e);
            toast('Upload failed: ' + (e && e.message ? e.message : e), 'error');
        } finally { fileInput.value = ''; }
    });
    serialize(); redraw();
    wrap.appendChild(listEl);
    wrap.appendChild(h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } }, fileInput, status));
    return wrap;
}

// Days of the week. Keys match what the scheduling calendar reads from
// users.working_hours (sun/mon/tue/wed/thu/fri/sat).
const WEEKLY_DAYS = [
    ['mon', 'Monday'], ['tue', 'Tuesday'], ['wed', 'Wednesday'],
    ['thu', 'Thursday'], ['fri', 'Friday'], ['sat', 'Saturday'], ['sun', 'Sunday'],
];

// Weekly working-hours editor — the days + time windows a doctor accepts
// appointments. Renders one row per weekday with an on/off toggle, from/to
// time pickers, and a lunch-break window. Stored as JSONB:
//   { mon: { enabled:true, from:'09:00', to:'18:00',
//            lunchEnabled:true, lunchFrom:'13:00', lunchTo:'14:00' }, … }
// which the Scheduling calendar uses to shade off-hours (incl. lunch) and
// block bookings.
function weeklyHoursEditor(v) {
    const data = (v && typeof v === 'object' && !Array.isArray(v)) ? v : null;

    const container = h('div', {
        class: 'weekly-hours',
        style: {
            border: '1px solid var(--ink-200)', borderRadius: '10px',
            background: 'var(--ink-25)', padding: '10px 12px',
            display: 'flex', flexDirection: 'column', gap: '4px',
        },
    });

    const timeInput = (value, ds) => h('input', { type: 'time', value, dataset: ds,
        style: { height: '30px', border: '1px solid var(--ink-200)', borderRadius: '6px', padding: '0 6px', fontSize: '12.5px', fontFamily: 'inherit' } });

    const rows = [];   // [{ key, cb, fromInp, toInp, lunchCb, lunchFromInp, lunchToInp }]

    for (const [key, label] of WEEKLY_DAYS) {
        const slot = data ? data[key] : null;
        // New doctor (no stored hours) defaults to Mon–Fri 09:00–18:00.
        const defaultOn = ['mon', 'tue', 'wed', 'thu', 'fri'].includes(key);
        const enabled = slot ? (slot.enabled !== false) : (data ? false : defaultOn);
        const from = (slot && slot.from) || '09:00';
        const to   = (slot && slot.to)   || '18:00';
        const lunchEnabled = slot ? !!slot.lunchEnabled : false;
        const lunchFrom = (slot && slot.lunchFrom) || '13:00';
        const lunchTo   = (slot && slot.lunchTo)   || '14:00';

        const cb = h('input', { type: 'checkbox', dataset: { whEnabled: key } });
        cb.checked = enabled;
        const fromInp = timeInput(from, { whFrom: key });
        const toInp   = timeInput(to,   { whTo: key });
        const timeWrap = h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', marginLeft: 'auto' } },
            fromInp, h('span', { style: { color: 'var(--ink-400)', fontSize: '12px' } }, '–'), toInp);

        // Lunch break sub-row — indented under the day.
        const lunchCb = h('input', { type: 'checkbox', dataset: { whLunchEnabled: key } });
        lunchCb.checked = lunchEnabled;
        const lunchFromInp = timeInput(lunchFrom, { whLunchFrom: key });
        const lunchToInp   = timeInput(lunchTo,   { whLunchTo: key });
        const lunchTimeWrap = h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', marginLeft: 'auto' } },
            lunchFromInp, h('span', { style: { color: 'var(--ink-400)', fontSize: '12px' } }, '–'), lunchToInp);
        const lunchRow = h('label', {
            style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 0 8px 26px', cursor: 'pointer' },
        },
            lunchCb,
            h('span', { style: { fontSize: '12px', color: 'var(--ink-600)', minWidth: '78px' } }, 'Lunch break'),
            lunchTimeWrap,
        );

        const sync = () => {
            const on = cb.checked;
            fromInp.disabled = toInp.disabled = !on;
            timeWrap.style.opacity = on ? '1' : '0.4';
            // Lunch only relevant on a working day.
            lunchCb.disabled = !on;
            const lunchOn = on && lunchCb.checked;
            lunchFromInp.disabled = lunchToInp.disabled = !lunchOn;
            lunchRow.style.opacity = on ? '1' : '0.4';
            lunchTimeWrap.style.opacity = lunchOn ? '1' : '0.4';
        };
        cb.onchange = sync;
        lunchCb.onchange = sync;
        sync();

        container.appendChild(h('div', { style: { borderBottom: '1px solid var(--ink-100)', paddingBottom: '2px' } },
            h('label', {
                style: { display: 'flex', alignItems: 'center', gap: '10px', padding: '5px 0', cursor: 'pointer' },
            },
                cb,
                h('span', { style: { fontSize: '13px', fontWeight: 600, color: 'var(--ink-800)', minWidth: '92px' } }, label),
                timeWrap,
            ),
            lunchRow,
        ));
        rows.push({ key, cb, fromInp, toInp, lunchCb, lunchFromInp, lunchToInp });
    }

    // Convenience: copy the first enabled day's window (incl. lunch) to every
    // enabled day.
    container.appendChild(h('button', {
        type: 'button',
        style: {
            alignSelf: 'flex-start', marginTop: '6px', background: 'transparent',
            border: 0, padding: 0, cursor: 'pointer', fontFamily: 'inherit',
            color: 'var(--primary-700)', fontSize: '12px', fontWeight: 600,
        },
        onclick: () => {
            const src = rows.find(r => r.cb.checked) || rows[0];
            for (const r of rows) {
                if (!r.cb.checked) continue;
                r.fromInp.value = src.fromInp.value;
                r.toInp.value   = src.toInp.value;
                r.lunchCb.checked = src.lunchCb.checked;
                r.lunchFromInp.value = src.lunchFromInp.value;
                r.lunchToInp.value   = src.lunchToInp.value;
                r.lunchCb.dispatchEvent(new Event('change'));
            }
        },
    }, 'Copy first day’s hours to all enabled days'));

    return container;
}

// Doctor "services performed" editor. Lists active services, filterable by a
// service-TYPE dropdown and a search box, each tickable with a per-service % of
// salary. "Select all shown" + "Same % for all" act on the currently-visible
// services, so picking a type then setting one % applies it to that whole type.
// Saved as users.service_rates =
//   [{ service_id, price, percentage, branches:[branch_id,…] }].
// price = fixed UZS the doctor earns for the service · percentage = % of the
// after-tax revenue · branches = which branches the rate applies at (empty =
// all). `v` is that array; older rows may carry {percentage} or {mode,value}.
function doctorServicesEditor(v) {
    // service_id (string) -> { price, percentage, branches:string[] }
    const initial = new Map();
    if (Array.isArray(v)) for (const it of v) if (it && it.service_id != null) {
        let price      = Number(it.price) || 0;
        let percentage = Number(it.percentage) || 0;
        // Back-compat with the older {mode,value} shape.
        if (!price && it.mode === 'fixed' && it.value != null)       price = Number(it.value) || 0;
        if (!percentage && it.mode !== 'fixed' && it.value != null)  percentage = Number(it.value) || 0;
        const branches = Array.isArray(it.branches) ? it.branches.map(String) : [];
        initial.set(String(it.service_id), { price, percentage, branches });
    }

    const services = dsServices || [];
    const types = dsTypes || [];

    const container = h('div', { class: 'doc-svc', style: {
        border: '1px solid var(--ink-200)', borderRadius: '10px', background: 'var(--white)',
        maxHeight: '460px', overflowY: 'auto', position: 'relative',
    } });

    if (!services.length) {
        container.appendChild(h('div', { class: 'muted', style: { fontSize: '13px', padding: '16px' } },
            'No active services found. Add them under Settings → Service list first.'));
        return container;
    }

    const checkbox = (checked) => {
        const cb = h('input', { type: 'checkbox', style: { width: '16px', height: '16px', flex: '0 0 16px', margin: 0, cursor: 'pointer', accentColor: 'var(--primary-600)' } });
        cb.checked = !!checked;
        return cb;
    };
    const pctInput = (val) => h('input', {
        type: 'number', step: '0.01', min: '0', max: '100', placeholder: '0',
        value: val != null && val !== '' ? String(val) : '',
        style: { width: '60px', height: '30px', border: '1px solid var(--ink-200)', borderRadius: '6px',
                 padding: '0 8px', fontSize: '12.5px', fontFamily: 'inherit', textAlign: 'right' },
    });
    const pctCell = (input) => h('span', { style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'flex-end', gap: '5px', color: 'var(--ink-400)', fontSize: '12px' } },
        input, '%');
    // Doctor's fixed price for the service (UZS).
    const priceInput = (val) => h('input', {
        type: 'number', step: '1000', min: '0', placeholder: '0',
        value: val ? String(val) : '',
        style: { width: '96px', height: '30px', border: '1px solid var(--ink-200)', borderRadius: '6px',
                 padding: '0 8px', fontSize: '12.5px', fontFamily: 'inherit', textAlign: 'right' },
    });
    const unitLabel = (txt) => h('span', { style: { color: 'var(--ink-400)', fontSize: '12px' } }, txt);
    // Compact toggle chips for the branches a service's rate applies at
    // (empty selection = all branches).
    const branchList = dsBranches || [];
    const chipStyle = (on) => ({
        padding: '2px 8px', borderRadius: '999px', cursor: 'pointer', fontFamily: 'inherit',
        fontSize: '11px', fontWeight: 600, whiteSpace: 'nowrap',
        border: '1px solid ' + (on ? 'var(--primary-400)' : 'var(--ink-200)'),
        background: on ? 'var(--primary-50)' : 'var(--white)',
        color: on ? 'var(--primary-700)' : 'var(--ink-600)',
    });
    const branchChips = (sid, selected) => {
        const wrap = h('div', { style: { display: 'flex', gap: '4px', flexWrap: 'wrap', justifyContent: 'flex-end' } });
        if (!branchList.length) { wrap.appendChild(h('span', { class: 'muted', style: { fontSize: '11px' } }, 'All')); return wrap; }
        const sel = new Set((selected || []).map(String));
        for (const b of branchList) {
            const bid = String(b.id);
            const chip = h('button', { type: 'button', dataset: { dsBranch: sid, branchId: bid, on: sel.has(bid) ? '1' : '' }, title: b.name }, b.name);
            Object.assign(chip.style, chipStyle(sel.has(bid)));
            chip.addEventListener('click', () => {
                const next = chip.dataset.on !== '1';
                chip.dataset.on = next ? '1' : '';
                Object.assign(chip.style, chipStyle(next));
            });
            wrap.appendChild(chip);
        }
        return wrap;
    };

    // ---- Toolbar: search + type filter + bulk apply (sticky) --------------
    const search = h('input', {
        type: 'text', placeholder: 'Search services…', autocomplete: 'off',
        style: { height: '36px', width: '100%', padding: '0 12px', border: '1px solid var(--ink-200)',
                 borderRadius: '8px', fontSize: '13px', fontFamily: 'inherit', outline: 'none' },
    });
    const typeSel = h('select', {
        style: { height: '34px', width: '220px', border: '1px solid var(--ink-200)', borderRadius: '8px',
                 fontSize: '13px', fontFamily: 'inherit', background: 'var(--white)', padding: '0 30px 0 10px' },
    },
        h('option', { value: '' }, 'All types'),
        ...types.map(t => h('option', { value: String(t.id) }, t.name)),
    );
    const allCb  = checkbox(false);
    allCb.title = 'Tick every service shown';
    const bulkPct = pctInput('');

    const toolbar = h('div', { style: {
        position: 'sticky', top: '0', zIndex: 2, background: 'var(--white)',
        display: 'flex', flexDirection: 'column', gap: '10px',
        padding: '12px 14px', borderBottom: '1px solid var(--ink-100)',
    } },
        search,
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' } },
            typeSel,
            h('span', { style: { flex: 1, minWidth: '8px' } }),
            h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12.5px', color: 'var(--ink-700)', whiteSpace: 'nowrap', cursor: 'pointer' } },
                allCb, 'Select all'),
            h('span', { style: { width: '1px', height: '18px', background: 'var(--ink-200)' } }),
            h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '8px', whiteSpace: 'nowrap' } },
                h('span', { class: 'muted', style: { fontSize: '12.5px' } }, 'Set % for all'),
                pctCell(bulkPct),
            ),
        ),
    );
    container.appendChild(toolbar);

    // ---- Column header (flex, mirrors the row widths below) ---------------
    container.appendChild(h('div', { style: {
        display: 'flex', alignItems: 'center', gap: '10px', padding: '9px 14px 7px',
        fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--ink-500)',
    } },
        h('span', { style: { flex: '0 0 16px' } }),
        h('span', { style: { flex: '1 1 auto', minWidth: '0' } }, 'Service'),
        h('span', { style: { flex: '0 0 132px', textAlign: 'right' } }, 'Price'),
        h('span', { style: { flex: '0 0 80px',  textAlign: 'right' } }, '% of doctor'),
        h('span', { style: { flex: '0 0 200px', textAlign: 'right' } }, 'Branches'),
    ));

    // ---- Service rows (all rendered once; filters just hide them) ---------
    const listEl = h('div');
    container.appendChild(listEl);

    const refs = [];   // { typeId, cb, price, pct, rowEl, name }
    for (const s of services) {
        const sid = String(s.id);
        const has = initial.has(sid);
        const init = has ? initial.get(sid) : null;
        const cb  = checkbox(has);
        cb.dataset.dsService = sid;
        const price = priceInput(init ? init.price : '');
        price.dataset.dsPrice = sid;
        const pct = pctInput(init ? init.percentage : '');
        pct.dataset.dsPct = sid;
        const rowEl = h('div', { class: 'doc-svc-row', style: {
            display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'nowrap',
            padding: '8px 14px', borderTop: '1px solid var(--ink-100)',
        } },
            cb,
            h('span', { style: { flex: '1 1 auto', minWidth: '0', fontSize: '13px', color: 'var(--ink-800)',
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }, title: s.name }, s.name),
            h('span', { style: { flex: '0 0 132px', display: 'inline-flex', alignItems: 'center', justifyContent: 'flex-end', gap: '5px' } }, price, unitLabel('UZS')),
            h('span', { style: { flex: '0 0 80px',  display: 'inline-flex', alignItems: 'center', justifyContent: 'flex-end', gap: '5px' } }, pct, unitLabel('%')),
            h('span', { style: { flex: '0 0 200px', display: 'flex', justifyContent: 'flex-end' } }, branchChips(sid, init ? init.branches : [])),
        );
        listEl.appendChild(rowEl);

        const ref = { typeId: s.type_id != null ? String(s.type_id) : '', cb, price, pct, rowEl, name: (s.name || '').toLowerCase() };
        refs.push(ref);
        const sync = () => {
            const on = cb.checked;
            price.disabled = pct.disabled = !on;
            for (const el of [price, pct]) {
                el.style.background = on ? 'var(--white)' : 'var(--ink-50)';
                el.style.color = on ? 'var(--ink-900)' : 'var(--ink-400)';
            }
        };
        cb.addEventListener('change', () => { sync(); refreshAllCb(); });
        sync();
    }

    const visibleRefs = () => {
        const t = search.value.trim().toLowerCase();
        const ty = typeSel.value;
        return refs.filter(r => (!ty || r.typeId === ty) && (!t || r.name.includes(t)));
    };
    const applyFilter = () => {
        const vis = new Set(visibleRefs());
        for (const r of refs) r.rowEl.style.display = vis.has(r) ? '' : 'none';
        refreshAllCb();
    };
    function refreshAllCb() {
        const vis = visibleRefs();
        const checked = vis.filter(r => r.cb.checked);
        allCb.checked = vis.length > 0 && checked.length === vis.length;
        allCb.indeterminate = checked.length > 0 && checked.length < vis.length;
    }
    const setRow = (r, on) => {
        r.cb.checked = on;
        r.price.disabled = r.pct.disabled = !on;
        for (const el of [r.price, r.pct]) {
            el.style.background = on ? 'var(--white)' : 'var(--ink-50)';
            el.style.color = on ? 'var(--ink-900)' : 'var(--ink-400)';
        }
    };

    search.addEventListener('input', applyFilter);
    typeSel.addEventListener('change', applyFilter);
    // "Select all" ticks/unticks every currently-visible service.
    allCb.addEventListener('change', () => {
        for (const r of visibleRefs()) setRow(r, allCb.checked);
        refreshAllCb();
    });
    // "Set % for all" ticks every visible service and fills its %.
    bulkPct.addEventListener('input', () => {
        for (const r of visibleRefs()) { setRow(r, true); r.pct.value = bulkPct.value; }
        refreshAllCb();
    });

    applyFilter();
    return container;
}

// PATIENT_TAB_PERMS_V1 — Roles permission editor as a master-detail dialog:
// left rail = menu groups (modules + Settings sub-sections + «Карта пациента —
// вкладки»); right pane = per-item Чтение / Редактирование / Удаление toggles.
// Saves permissions JSONB { sections, levels, patient_tabs }.
function sectionPicker(v) {
    const allowed = new Set(Array.isArray(v && v.sections) ? v.sections : []);
    const levels  = (v && v.levels && typeof v.levels === 'object') ? v.levels : {};
    const ptabs   = (v && v.patient_tabs && typeof v.patient_tabs === 'object') ? v.patient_tabs : {};
    const levelFor = (key) => allowed.has(key) ? (levels[key] || 'editor') : 'none';

    const groups = permissionGroups();
    groups.push({ group: 'Карта пациента — вкладки', patientTabs: true, items: PATIENT_TABS.map(t => ({ key: t.id, label: t.label })) });

    const rail = h('div', { style: { flex: '0 0 252px', borderRight: '1px solid var(--ink-100)', overflowY: 'auto', maxHeight: 'min(64vh, 560px)', padding: '4px' } });
    const panesWrap = h('div', { style: { flex: 1, overflowY: 'auto', maxHeight: 'min(64vh, 560px)', padding: '8px 12px 12px 18px' } });

    function chk(label, checked, onChange) {
        const cb = h('input', { type: 'checkbox' });
        cb.checked = !!checked;
        cb.addEventListener('change', () => onChange(cb));
        return { cb, el: h('label', { class: 'row', style: { gap: '6px', alignItems: 'center', fontSize: '12px', cursor: 'pointer', userSelect: 'none' } }, cb, label) };
    }
    function moduleRow(it) {
        const lvl = levelFor(it.key);
        const read = chk('Чтение', lvl !== 'none', sync);
        const edit = chk('Редакт.', lvl === 'editor' || lvl === 'admin', sync);
        const del  = chk('Удаление', lvl === 'admin', sync);
        read.cb.dataset.permKey = it.key; read.cb.dataset.permLvl = 'read';
        edit.cb.dataset.permKey = it.key; edit.cb.dataset.permLvl = 'edit';
        del.cb.dataset.permKey  = it.key; del.cb.dataset.permLvl  = 'delete';
        function sync(src) {
            if (src === read.cb && !read.cb.checked) { edit.cb.checked = false; del.cb.checked = false; }
            if (src === edit.cb) { if (edit.cb.checked) read.cb.checked = true; else del.cb.checked = false; }
            if (src === del.cb && del.cb.checked) { edit.cb.checked = true; read.cb.checked = true; }
            recount();
        }
        const labelEl = it.soon
            ? h('span', { style: { fontSize: '13px', color: 'var(--ink-500)', display: 'inline-flex', alignItems: 'center', gap: '6px' } }, it.label,
                h('span', { style: { fontSize: '9.5px', fontWeight: '700', color: 'var(--ink-500)', background: 'var(--ink-100)', borderRadius: '4px', padding: '1px 6px', letterSpacing: '.04em', textTransform: 'uppercase' } }, 'Скоро'))   // ROLE_EDITOR_AVAIL_V1
            : h('span', { style: { fontSize: '13px', color: 'var(--ink-800)' } }, it.label);
        return h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 96px 96px 104px', alignItems: 'center', gap: '8px', padding: '9px 6px', borderTop: '1px solid var(--ink-100)' } },
            labelEl, read.el, edit.el, del.el);
    }
    function tabRow(it) {
        const lvl = ptabs[it.key];
        const read = chk('Видна', lvl == null ? true : lvl !== 'none', sync);
        const edit = chk('Редакт.', lvl == null ? true : (lvl === 'edit' || lvl === 'delete'), sync);
        const del  = chk('Удаление', lvl === 'delete', sync);
        read.cb.dataset.ptabKey = it.key; read.cb.dataset.ptabLvl = 'view';
        edit.cb.dataset.ptabKey = it.key; edit.cb.dataset.ptabLvl = 'edit';
        del.cb.dataset.ptabKey  = it.key; del.cb.dataset.ptabLvl  = 'delete';
        function sync(src) {
            if (src === read.cb && !read.cb.checked) { edit.cb.checked = false; del.cb.checked = false; }
            if (src === edit.cb) { if (edit.cb.checked) read.cb.checked = true; else del.cb.checked = false; }
            if (src === del.cb && del.cb.checked) { edit.cb.checked = true; read.cb.checked = true; }
        }
        return h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 96px 96px 104px', alignItems: 'center', gap: '8px', padding: '9px 6px', borderTop: '1px solid var(--ink-100)' } },
            h('span', { style: { fontSize: '13px', color: 'var(--ink-800)' } }, it.label), read.el, edit.el, del.el);
    }
    function select(gi) {
        for (const b of rail.querySelectorAll('[data-rail-idx]')) b.classList.toggle('active', b.dataset.railIdx === String(gi));
        for (const pane of panesWrap.querySelectorAll('[data-pane-idx]')) pane.style.display = pane.dataset.paneIdx === String(gi) ? 'block' : 'none';
    }
    function recount() {
        for (const badge of rail.querySelectorAll('[data-rail-count]')) {
            const gi = badge.dataset.railCount;
            const pane = panesWrap.querySelector('[data-pane-idx="' + gi + '"]');
            if (!pane) continue;
            const reads = [...pane.querySelectorAll('input[data-perm-lvl="read"], input[data-ptab-lvl="view"]')];
            const restr = pane.querySelector('input[data-ptab-lvl]') ? reads.filter(c => !c.checked).length : reads.filter(c => c.checked).length;
            badge.textContent = pane.querySelector('input[data-ptab-lvl]') ? (restr ? trf('{n} скрыто', { n: restr }) : tr('все')) : (restr + '/' + reads.length);
        }
    }
    groups.forEach((g, gi) => {
        rail.appendChild(h('button', { type: 'button', class: 'nav-item' + (gi === 0 ? ' active' : ''), dataset: { railIdx: String(gi) },
            style: { width: '100%', textAlign: 'left', fontSize: '12.5px' }, onclick: () => select(gi) },
            h('span', { style: { flex: 1 } }, g.group),
            h('span', { dataset: { railCount: String(gi) }, class: 'num', style: { fontSize: '10px', color: 'var(--primary-700)', background: 'var(--primary-50)', borderRadius: '999px', padding: '1px 7px' } })));
        panesWrap.appendChild(h('div', { dataset: { paneIdx: String(gi) }, style: { display: gi === 0 ? 'block' : 'none' } },
            h('div', { style: { fontSize: '11.5px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--ink-600)', padding: '2px 0 6px' } }, g.group),
            ...g.items.map(it => g.patientTabs ? tabRow(it) : moduleRow(it))));
    });
    setTimeout(recount, 0);
    return h('div', { class: 'section-picker', style: { width: '100%', boxSizing: 'border-box', border: '1px solid var(--ink-200)', borderRadius: '10px', background: 'white', display: 'flex', overflow: 'hidden', maxHeight: 'min(64vh, 560px)' } }, rail, panesWrap);
}

async function saveRow(card, def, original) {
    // ROLE_DELEGATION_V1 — roles editable by any role granted Roles (settings:roles); the
    // DB RLS + _guard_roles_delegation enforce the real boundary (no admin role / no self-edit).
    if (def.table === 'roles' && !canEdit('settings:roles')) { toast('У вашей роли нет прав на управление ролями.', 'fail'); throw new Error('forbidden: roles edit not permitted'); }
    const payload = {};
    // multi_fk fields go into a separate list — they don't write to the
    // main table, they sync rows in a junction table after the upsert.
    const multiUpdates = [];   // [{ field, ids }]
    // Raw (un-hashed) password captured when a `type: 'password'` field is
    // set — passed to admin_reset_user_password after the row save so the
    // Supabase Auth account stays in sync.
    let rawPasswordSet = null;
    let _svcDoctorIds = null;   // SERVICE_DOCTORS_V1 — ticked doctors, applied post-save

    for (const wrap of card.querySelectorAll('[data-field-key]')) {
        const key  = wrap.dataset.fieldKey;
        const type = wrap.dataset.fieldType;

        // Conditionally-hidden fields (visibleWhen → false) must not touch the
        // column. Skip them entirely so the DB keeps whatever was there.
        if (wrap.dataset.hidden === '1') continue;
        if (wrap.dataset.readonly === '1') continue;   // SERVICE_CATALOG_READONLY — never overwrite catalog-sourced fields

        if (type === 'service_doctors') {
            _svcDoctorIds = [...wrap.querySelectorAll('input[data-sd-doctor]')].filter(cb => cb.checked).map(cb => cb.dataset.sdDoctor);
            continue;
        }
        if (type === 'multi_fk') {
            const f = def.fields.find(x => x.key === key);
            if (!f || (!f.junction && !f.reverseFk)) continue;   // REVERSE_FK_V1
            const ids = [...wrap.querySelectorAll('input[type="checkbox"]')]
                .filter(cb => cb.checked).map(cb => cb.value);
            multiUpdates.push({ field: f, ids });
            // Optional: mirror the first selected id to a real column on the
            // parent table (e.g. `user_branches` → `users.branch_id`). Keeps
            // legacy joins-through-single-FK code working.
            if (f.mirrorTo) payload[f.mirrorTo] = ids[0] || null;
            continue;
        }

        if (type === 'multi_select') {
            // Collect ticked values into a plain array written to the parent
            // row (Postgres text[] column).
            payload[key] = [...wrap.querySelectorAll('input[type="checkbox"]')]
                .filter(cb => cb.checked).map(cb => cb.value);
            continue;
        }

        if (type === 'section_picker') {
            // PATIENT_TAB_PERMS_V1 — rebuild { sections, levels, patient_tabs } from the
            // read/edit/delete checkboxes (modules) + видна/редакт. checkboxes (patient tabs).
            const sections = []; const levels = {};
            const byKey = {};
            for (const cb of wrap.querySelectorAll('input[data-perm-key]')) {
                (byKey[cb.dataset.permKey] = byKey[cb.dataset.permKey] || {})[cb.dataset.permLvl] = cb.checked;
            }
            for (const k of Object.keys(byKey)) {
                const st = byKey[k];
                if (!st.read) continue;
                sections.push(k);
                levels[k] = st['delete'] ? 'admin' : st.edit ? 'editor' : 'viewer';
            }
            const patient_tabs = {};
            const byTab = {};
            for (const cb of wrap.querySelectorAll('input[data-ptab-key]')) {
                (byTab[cb.dataset.ptabKey] = byTab[cb.dataset.ptabKey] || {})[cb.dataset.ptabLvl] = cb.checked;
            }
            for (const k of Object.keys(byTab)) {
                const st = byTab[k];
                patient_tabs[k] = !st.view ? 'none' : st['delete'] ? 'delete' : st.edit ? 'edit' : 'view';
            }
            // ROLE_SAVE_PRESERVE_V1 — keep grants this editor did NOT render.
            // The picker rebuilds sections purely from its checkboxes, so a tab
            // loaded before a permission key existed (e.g. 'registration')
            // silently REVOKED that key on every save. Unknown keys and their
            // levels/patient-tab settings now carry over unchanged.
            const prevPerms = (original && original[key] && typeof original[key] === 'object') ? original[key] : {};
            const renderedKeys = new Set(Object.keys(byKey));
            for (const k of (Array.isArray(prevPerms.sections) ? prevPerms.sections : [])) {
                if (!renderedKeys.has(k) && !sections.includes(k)) {
                    sections.push(k);
                    if (prevPerms.levels && prevPerms.levels[k]) levels[k] = prevPerms.levels[k];
                }
            }
            const renderedTabs = new Set(Object.keys(byTab));
            for (const [k, v] of Object.entries((prevPerms.patient_tabs && typeof prevPerms.patient_tabs === 'object') ? prevPerms.patient_tabs : {})) {
                if (!renderedTabs.has(k) && patient_tabs[k] == null) patient_tabs[k] = v;
            }
            payload[key] = { sections, levels, patient_tabs };
            continue;
        }

        if (type === 'password') {
            // Synthetic field: hash the entered value into password_hash so the
            // legacy column stays consistent, AND remember the raw value so
            // the post-save step can hand it to admin_reset_user_password and
            // actually enable login via Supabase Auth. Blank = leave existing
            // password alone (no auth-side change).
            const val = wrap.querySelector('input')?.value || '';
            if (val) {
                payload.password_hash = await hashPassword(val);
                rawPasswordSet = val;
            }
            continue;   // never write a `password` column (doesn't exist)
        }

        if (type === 'referral_rates') {
            // REFERRAL_REWARDS_V1 — collect { service_type_id: percent }; blank
            // or non-numeric rows are dropped (→ 0% at calculation time).
            const obj = {};
            for (const inp of wrap.querySelectorAll('input[data-rr-type]')) {
                const raw = inp.value.trim();
                if (raw === '' || Number.isNaN(Number(raw))) continue;
                obj[inp.dataset.rrType] = Number(raw);
            }
            payload[key] = obj;
            continue;
        }

        if (type === 'doctor_services') {
            // Ticked services + their pay rule → users.service_rates JSONB. Each
            // entry: { service_id, price, percentage, branches }. Unticked rows
            // (incl. ones hidden by the search box) are simply not checked.
            const items = [];
            for (const cb of wrap.querySelectorAll('input[data-ds-service]')) {
                if (!cb.checked) continue;
                const sid      = cb.dataset.dsService;
                const priceEl  = wrap.querySelector(`[data-ds-price="${sid}"]`);
                const pctEl    = wrap.querySelector(`[data-ds-pct="${sid}"]`);
                const price      = priceEl && priceEl.value.trim() !== '' ? Number(priceEl.value) : 0;
                const percentage = pctEl   && pctEl.value.trim()   !== '' ? Number(pctEl.value)   : 0;
                const branches = [...wrap.querySelectorAll(`[data-ds-branch="${sid}"][data-on="1"]`)]
                    .map(el => el.dataset.branchId);
                items.push({ service_id: sid, price, percentage, branches });
            }
            payload[key] = items;
            continue;
        }

        if (type === 'weekly_hours') {
            // Collect each weekday's on/off + work window + lunch break into the
            // JSONB shape the scheduling calendar reads.
            const obj = {};
            for (const [dayKey] of WEEKLY_DAYS) {
                const en   = wrap.querySelector(`[data-wh-enabled="${dayKey}"]`)?.checked || false;
                const from = wrap.querySelector(`[data-wh-from="${dayKey}"]`)?.value || '09:00';
                const to   = wrap.querySelector(`[data-wh-to="${dayKey}"]`)?.value   || '18:00';
                const lunchEnabled = wrap.querySelector(`[data-wh-lunch-enabled="${dayKey}"]`)?.checked || false;
                const lunchFrom    = wrap.querySelector(`[data-wh-lunch-from="${dayKey}"]`)?.value || '13:00';
                const lunchTo      = wrap.querySelector(`[data-wh-lunch-to="${dayKey}"]`)?.value   || '14:00';
                obj[dayKey] = { enabled: en, from, to, lunchEnabled, lunchFrom, lunchTo };
            }
            payload[key] = obj;
            continue;
        }

        if (type === 'image') {
            // FILE_SAVE_FIX_V1 — the uploader parks the value on the INNER .file-field
            // element, not this outer [data-field-key] wrapper; reading the wrapper
            // returned undefined and every save silently wiped the column to NULL.
            const ff = wrap.querySelector('[data-file-value]') || wrap;
            const fv = ff.dataset.fileValue;
            payload[key] = (fv != null && fv !== '') ? fv : null;
            continue;
        }
        if (type === 'file_list') {
            const ff = wrap.querySelector('[data-file-value]') || wrap;
            let arr = [];
            try { arr = JSON.parse(ff.dataset.fileValue || '[]'); } catch (e) { arr = []; }
            payload[key] = Array.isArray(arr) ? arr : [];
            continue;
        }
        const input = wrap.querySelector('input, select, textarea');
        if (!input) continue;
        let v;
        if (type === 'bool')        v = input.checked;
        else if (type === 'number') v = input.value === '' ? null : Number(input.value);
        // PHONE_INPUT_V1 — the control pre-fills the dialling code, so a field
        // nobody typed into still reads «+998». Store that as null.
        else if (type === 'phone')  v = isCodeOnly(input.value) ? null : input.value;
        else if (input.value === '') v = null;
        else                         v = input.value;
        payload[key] = v;
        if (wrap.dataset.mirrorTo) payload[wrap.dataset.mirrorTo] = v;   // DEPT_LANG_V1 — RU name -> legacy NOT NULL `name`
    }

    // REQUIRES_DOCTOR_V1 — a service that needs a doctor must have at least one assigned.
    if (def.table === 'services' && payload.requires_doctor === true && (!_svcDoctorIds || _svcDoctorIds.length === 0)) {
        toast('Услуга требует врача — отметьте хотя бы одного врача в списке «Врачи, выполняющие услугу».', 'fail'); throw new Error('requires_doctor: no doctor selected');
    }
    // Main upsert. Capture the row id so we can sync junctions afterwards.
    let savedId;
    if (original) {
        let error;
        if (def.gatewayCrud) {   // ITEMS_CRUD_WIRE_V1
            try { await gw('/crud/' + def.table + '/' + original.id, { method: 'PATCH', body: payload }); error = null; }
            catch (e) { error = { message: (e && e.message) || String(e) }; }
        } else {
            ({ error } = await supabase.from(def.table).update(payload).eq('id', original.id));
        }
        if (error) throw error;
        savedId = original.id;
    } else {
        const _cidIns = currentClinicId();   // TENANT_SCOPE_V2: stamp the new row with the current clinic
        if (_cidIns && isClinicScopedTable(def.table)) payload.company_id = _cidIns;
        // BRANCH_CLINIC_V1 — default to the active branch, but ONLY for tables with a DIRECT
        // branch_id column. Embed-path tables (rooms→floors, beds→wards, …) carry no branch_id
        // of their own (branch comes via the parent), so stamping one is a 400. BRANCH_ROOMS_STAMP_FIX
        if (def.branchScoped && BRANCH_PATHS[def.table]?.kind === 'direct' && !payload.branch_id) {
            const _sel = getSelectedBranchIds();
            if (_sel.length === 1) payload.branch_id = _sel[0];
        }
        // ITEMS_CRUD_WIRE_V1 — gatewayCrud sections insert via the service-role gateway.
        let data, error;
        if (def.gatewayCrud) {
            try { const _r = await gw('/crud/' + def.table, { method: 'POST', body: [payload] }); data = (_r && _r[0]) || null; error = null; }
            catch (e) { data = null; error = { message: (e && e.message) || String(e) }; }
        } else {
            ({ data, error } = await supabase.from(def.table).insert(payload).select().single());
        }
        if (error) throw error;
        savedId = data?.id;
    }

    // Sync each multi_fk junction: delete all + reinsert the ticked ids.
    for (const u of multiUpdates) {
        if (!savedId) continue;
        if (u.field.reverseFk) {   // REVERSE_FK_V1 — clear this row's current members, then set the ticked ones
            const r = u.field.reverseFk;
            const { error: clrErr } = await supabase.from(r.table).update({ [r.fkCol]: null }).eq(r.fkCol, savedId);
            if (clrErr) { console.warn('[reverse_fk clear]', clrErr); continue; }
            if (u.ids.length) {
                const { error: setErr } = await supabase.from(r.table).update({ [r.fkCol]: savedId }).in('id', u.ids);
                if (setErr) console.warn('[reverse_fk set]', setErr);
            }
            continue;
        }
        const j = u.field.junction;
        const { error: delErr } = await supabase.from(j.table).delete().eq(j.leftCol, savedId);
        if (delErr) { console.warn('[multi_fk delete]', delErr); continue; }
        if (u.ids.length === 0) continue;
        const rows = u.ids.map(id => ({ [j.leftCol]: savedId, [j.rightCol]: id }));
        const { error: insErr } = await supabase.from(j.table).insert(rows);
        if (insErr) console.warn('[multi_fk insert]', insErr);
    }

    // SERVICE_DOCTORS_V1 — sync this service into the ticked doctors' service_rates.
    if (_svcDoctorIds != null && savedId) {
        try { await applyServiceDoctors(savedId, _svcDoctorIds); } catch (e) { console.warn('[service_doctors]', e.message || e); }
    }

    // BRANCH_AUTOPUBLISH_V1 — saving a branch upserts it to medcore right away (name/about/address x3,
    // district, working_hours, is_24_7, website, instagram_url, telegram_url, yandex map), so edits reach
    // Symptex without a separate bulk publish.
    if (def.table === 'branches' && savedId) {
        try { await gw('/identity/branch/' + savedId + '/publish', { method: 'POST' }); }
        catch (e) { console.warn('[branch autopublish]', e.message || e); toast('Сохранено, но не удалось опубликовать в Symptex — повторите.', 'fail'); }
    }

    // If this was a users row with a password set, wire the Supabase Auth side
    // too (provision new auth.users or rotate existing — both behind the same
    // admin_reset_user_password RPC). Without this, the user can't actually
    // sign in; only the legacy users.password_hash column gets touched.
    if (def.table === 'users' && rawPasswordSet && savedId) {
        const { error: authErr } = await supabase.rpc('admin_reset_user_password', {
            target_user_id: savedId,
            new_password:   rawPasswordSet,
        });
        if (authErr) {
            console.warn('[section-crud] auth provision failed:', authErr.message || authErr);
            throw new Error('Login could not be enabled: ' + (authErr.message || authErr));
        }
    }
}


// ADD_SERVICE_CATALOG_V1 — «Add service»: pick a service from the shared medcore
// catalog (gw /catalog/services), set this clinic's price + operational fields,
// optionally tick the doctors who perform it (appended to users.service_rates).
// The row is inserted into the clinic-local `services` table with core_service_id
// set (required by RLS for clinic-created services) and company_id pinned to the
// subdomain clinic — prices and settings stay per-clinic. Services missing from
// the catalog still go through openServiceRequestModal() (footer link).
// SERVICE_DOCTORS_V1 — on the service EDIT form, tick which doctors perform this service.
// Reverse of the employee-side `doctor_services`: the link lives in users.service_rates, so
// ticking a doctor appends this service to that doctor's service_rates (and unticking removes it).
let _serviceDoctorCache = null;
async function loadServiceDoctorData() {
    try {
        const cid = currentClinicId();
        // SERVICE_NURSE_PROVIDER_V1 — providers = doctors OR nurses.
        let q = supabase.from('users').select('id, full_name, specialty, service_rates, role, is_doctor').eq('active', true).order('full_name');
        if (cid) q = q.eq('company_id', cid);
        const { data } = await q;
        _serviceDoctorCache = data || [];   // SERVICE_PROVIDER_TOGGLE_V1 — all active staff; the «Врач» toggle splits them
    } catch (e) { _serviceDoctorCache = []; }
}
function serviceDoctorsEditor(values) {
    const wrap = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } });
    const sid = (values && values.id) ? String(values.id) : null;
    const all = _serviceDoctorCache || [];
    const isDoc = (u) => u.is_doctor === true || /doctor|врач/i.test(u.role || '') || String(u.specialty || '').length > 0;
    const svcHas = (u) => !!sid && Array.isArray(u.service_rates) && u.service_rates.some(x => x && String(x.service_id) === sid);
    const doctors = all.filter(isDoc);
    const others  = all.filter(u => !isDoc(u));
    const docChk = h('input', { type: 'checkbox' });
    // Open in the mode that matches who's already assigned (only-non-doctors → «other» mode).
    docChk.checked = !(sid && others.some(svcHas) && !doctors.some(svcHas));
    const listEl = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: '230px', overflowY: 'auto', border: '1px solid var(--ink-200)', borderRadius: '10px', padding: '8px 10px' } });
    function renderList() {
        listEl.replaceChildren();
        const src = docChk.checked ? doctors : others;
        if (!sid) listEl.appendChild(h('div', { class: 'muted', style: { fontSize: '11.5px', marginBottom: '2px' } }, 'Сначала сохраните услугу, затем откройте её снова, чтобы отметить исполнителей.'));
        if (!src.length) { listEl.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px' } }, docChk.checked ? 'Нет врачей.' : 'Нет других сотрудников.')); return; }
        for (const d of src) {
            const cb = h('input', { type: 'checkbox', 'data-sd-doctor': d.id });
            if (svcHas(d)) cb.checked = true;
            const sub = docChk.checked ? (d.specialty || '') : (d.role || '');
            listEl.appendChild(h('label', { style: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', cursor: 'pointer' } },
                cb, h('span', null, d.full_name || '—'), sub ? h('span', { class: 'muted', style: { fontSize: '11.5px' } }, '· ' + sub) : null));
        }
    }
    docChk.onchange = renderList;
    wrap.appendChild(h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: '8px', fontSize: '13px', cursor: 'pointer' } },
        docChk, h('span', null, 'Врач'), h('span', { class: 'muted', style: { fontSize: '11.5px' } }, '(снимите — медсёстры и другие сотрудники)')));
    wrap.appendChild(listEl);
    renderList();
    return wrap;
}
async function applyServiceDoctors(serviceId, pickedIds) {
    const picked = new Set((pickedIds || []).map(String));
    const cid = currentClinicId();
    let q = supabase.from('users').select('id, service_rates, role, is_doctor, specialty').eq('active', true);
    if (cid) q = q.eq('company_id', cid);
    const { data: docs } = await q;
    for (const doc of (docs || [])) {
        let rates = Array.isArray(doc.service_rates) ? doc.service_rates.slice() : [];
        const has = rates.some(x => x && String(x.service_id) === String(serviceId));
        if (picked.has(String(doc.id)) && !has) {
            rates.push({ service_id: serviceId, price: 0, percentage: 0, branches: [] });
            await supabase.from('users').update({ service_rates: rates }).eq('id', doc.id);
        } else if (!picked.has(String(doc.id)) && has) {
            rates = rates.filter(x => !(x && String(x.service_id) === String(serviceId)));
            await supabase.from('users').update({ service_rates: rates }).eq('id', doc.id);
        }
    }
}

async function openAddServiceModal(container, onNavigate) {
    const overlay = h('div', { class: 'modal' });
    let addedAny = false;
    const close = () => { overlay.remove(); if (addedAny) loadRows(container, onNavigate); };
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));

    let existingCores = new Set();
    let doctors = [];
    const cid = currentClinicId();
    try {
        let q = supabase.from('services').select('core_service_id');
        if (cid) q = q.eq('company_id', cid);
        const { data } = await q;
        existingCores = new Set((data || []).map(x => x.core_service_id).filter(Boolean));
    } catch (e) { /* fail-soft */ }
    try {
        let q = supabase.from('users').select('id, full_name, specialty, service_rates, role, is_doctor').eq('active', true).order('full_name');
        if (cid) q = q.eq('company_id', cid);
        const { data } = await q;
        doctors = data || [];
    } catch (e) { /* fail-soft */ }

    const searchInp = h('input', { placeholder: 'Поиск по каталогу услуг…', style: { width: '100%' } });
    const selStyle = { height: '34px', padding: '0 8px', border: '1px solid var(--ink-200)', borderRadius: '8px', fontFamily: 'inherit', fontSize: '12.5px', background: 'white', minWidth: '120px', flex: '1' };
    // CATALOG_TAXONOMY_V1 — Группа → Тип → Категория cascading filters (medcore taxonomy).
    const groupSel = h('select', { style: selStyle, onchange: () => { fillTypes(); fillCats(); runSearch(); } }, h('option', { value: '' }, 'Все группы'));
    const typeSel  = h('select', { style: selStyle, onchange: () => { fillCats(); runSearch(); } }, h('option', { value: '' }, 'Все типы'));
    const catSel   = h('select', { style: selStyle, onchange: () => runSearch() }, h('option', { value: '' }, 'Все категории'));
    let _tax = { groups: [], types: [], cats: [] };
    function fillTypes() {
        const g = groupSel.value;
        clear(typeSel); typeSel.appendChild(h('option', { value: '' }, 'Все типы'));
        for (const t of _tax.types.filter(t => !g || t.service_group_id === g)) typeSel.appendChild(h('option', { value: t.id }, t.name_ru || t.name_uz || t.slug || ''));
    }
    function fillCats() {
        const ty = typeSel.value, g = groupSel.value;
        const typeIds = ty ? [ty] : (g ? _tax.types.filter(t => t.service_group_id === g).map(t => t.id) : null);
        clear(catSel); catSel.appendChild(h('option', { value: '' }, 'Все категории'));
        for (const c of _tax.cats.filter(c => !typeIds || typeIds.includes(c.service_type_id))) catSel.appendChild(h('option', { value: c.id }, c.name_ru || c.name_uz || c.slug || ''));
    }
    (async () => {
        try {
            const [g, t, c] = await Promise.all([gw('/catalog/groups'), gw('/catalog/types'), gw('/catalog/categories')]);
            _tax = { groups: (g && g.data) || [], types: (t && t.data) || [], cats: (c && c.data) || [] };
            for (const x of _tax.groups) groupSel.appendChild(h('option', { value: x.id }, x.name_ru || x.name_uz || x.slug || ''));
            fillTypes(); fillCats();
        } catch (e) { console.warn('[add-service] taxonomy load:', e && e.message); }
    })();

    const listBox = h('div', { style: { marginTop: '8px', maxHeight: '440px', overflowY: 'auto', border: '1px solid var(--ink-100)', borderRadius: '10px' } });
    const fld = (label, input) => h('div', { class: 'field' }, h('label', null, label), input);

    // ADD_SERVICE_INLINE_V1 — each catalog row expands its own edit card; Add inserts it (company-scoped),
    // greys the row, and the dialog STAYS OPEN for the next service. Doctor required only if "оказывает врач".
    function renderRow(row) {
        const cat = row.service_categories || {};
        const sub = [cat.name_ru, cat.service_types && cat.service_types.name_ru].filter(Boolean).join(' · ');
        const wrap = h('div', { dataset: { svc: row.id }, style: { borderBottom: '1px solid var(--ink-100)' } });
        let card = null, open = false;
        const title = h('div', { style: { flex: 1, minWidth: 0 } },
            h('div', { style: { fontWeight: 500, fontSize: '13px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, row.name_ru || row.slug),
            sub && h('div', { class: 'muted', style: { fontSize: '11.5px' } }, sub));
        const actionWrap = h('span', { style: { flex: '0 0 auto' } });
        const header = h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', padding: '9px 12px' } }, title, actionWrap);
        function setAdded() {
            wrap.style.opacity = '0.55';
            clear(actionWrap); actionWrap.appendChild(h('span', { class: 'muted', style: { fontSize: '12px' } }, '✓ Добавлена'));
            if (card) { card.remove(); card = null; open = false; }
        }
        if (existingCores.has(row.id)) { wrap.appendChild(header); setAdded(); return wrap; }
        const addBtn = h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: () => {
            if (open) { card.remove(); card = null; open = false; return; }
            card = buildCard(row, setAdded); wrap.appendChild(card); open = true;
        } }, Icon('Plus', { size: 14 }), ' Добавить');
        actionWrap.appendChild(addBtn);
        wrap.appendChild(header);
        return wrap;
    }

    function buildCard(row, onAdded) {
        const priceInp = h('input', { type: 'number', step: '0.01', min: '0', placeholder: '150000', style: { width: '100%' } });
        const vatInp   = h('input', { type: 'number', step: '0.01', value: '12', style: { width: '100%' } });
        const durInp   = h('input', { type: 'number', value: String(row.avg_duration_min || 30), style: { width: '100%' } });
        const pctInp   = h('input', { type: 'number', step: '0.01', min: '0', placeholder: '30', style: { width: '100%' } });
        const reqDoc   = h('input', { type: 'checkbox' });
        const docChk   = h('input', { type: 'checkbox' }); docChk.checked = true;   // Врач on = doctors
        const picked   = new Set();
        const isDocU   = (u) => u.is_doctor === true || /doctor|врач/i.test(u.role || '') || String(u.specialty || '').length > 0;
        const docBox   = h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px', maxHeight: '150px', overflowY: 'auto' } });
        function renderDocBox() {
            docBox.replaceChildren(); picked.clear();
            const src = (doctors || []).filter(u => docChk.checked ? isDocU(u) : !isDocU(u));
            if (!src.length) { docBox.appendChild(h('span', { class: 'muted', style: { fontSize: '12.5px' } }, docChk.checked ? 'Нет врачей.' : 'Нет других сотрудников.')); return; }
            for (const doc of src) {
                const sub = docChk.checked ? (doc.specialty || '') : (doc.role || '');
                docBox.appendChild(h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px', border: '1px solid var(--ink-200)', borderRadius: '8px', padding: '5px 9px', fontSize: '12.5px', cursor: 'pointer' } },
                    h('input', { type: 'checkbox', onchange: (e) => { if (e.target.checked) picked.add(doc.id); else picked.delete(doc.id); } }),
                    doc.full_name + (sub ? ' · ' + sub : '')));
            }
        }
        docChk.onchange = renderDocBox;
        renderDocBox();
        const docField = h('div', { style: { display: 'none', marginTop: '10px' } },
            fld('Доля исполнителя по умолчанию, %', pctInp),
            h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: '8px', fontSize: '13px', padding: '4px 0 8px', cursor: 'pointer' } }, docChk, h('span', null, 'Врач'), h('span', { class: 'muted', style: { fontSize: '11.5px' } }, '(снимите — другие сотрудники)')),
            fld('Исполнители', docBox));
        reqDoc.onchange = () => { docField.style.display = reqDoc.checked ? '' : 'none'; };
        const addBtn = h('button', { class: 'btn btn-primary btn-sm', type: 'button' }, Icon('Check', { size: 14 }), ' Добавить услугу');
        addBtn.onclick = async () => {
            const price = Number(priceInp.value);
            if (!Number.isFinite(price) || price <= 0) { toast('Укажите цену услуги', 'warn'); priceInp.focus(); return; }
            if (reqDoc.checked && picked.size === 0) { toast('Отметьте хотя бы одного исполнителя (врача или медсестру).', 'warn'); return; }
            addBtn.disabled = true;
            try {
                const svc = { name: row.name_ru || row.slug, code: row.slug || null, price, tax_rate: Number(vatInp.value) || 0, duration_minutes: parseInt(durInp.value, 10) || 30, requires_doctor: !!reqDoc.checked, default_doctor_percent: Number(pctInp.value) || 0, active: true, core_service_id: row.id };
                if (cid) svc.company_id = cid;
                const { data, error } = await supabase.from('services').insert(svc).select().single();
                if (error) throw error;
                if (reqDoc.checked) for (const doc of doctors) {
                    if (!picked.has(doc.id)) continue;
                    const rates = Array.isArray(doc.service_rates) ? doc.service_rates.slice() : [];
                    if (!rates.some(x => x && String(x.service_id) === String(data.id))) {
                        rates.push({ service_id: data.id, price: 0, percentage: Number(pctInp.value) || 0, branches: [] });
                        const { error: uerr } = await supabase.from('users').update({ service_rates: rates }).eq('id', doc.id);
                        if (uerr) console.warn('[add-service] service_rates', uerr.message); else doc.service_rates = rates;
                    }
                }
                existingCores.add(row.id); addedAny = true;
                toast(trf('Услуга добавлена: {name}', { name: svc.name }));
                onAdded();
            } catch (e) {
                toast(trf('Не удалось добавить услугу: {msg}', { msg: e.message || e }), 'fail');
            } finally { addBtn.disabled = false; }
        };
        return h('div', { style: { padding: '4px 12px 14px', background: 'var(--ink-25)', borderTop: '1px dashed var(--ink-200)' } },
            h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '12px' } }, fld('Цена (сум)', priceInp), fld('НДС (%)', vatInp), fld('Длительность (мин)', durInp)),
            h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: '8px', fontSize: '13px', padding: '10px 0 0' } }, reqDoc, ' Услугу оказывает специалист (врач / медсестра)'),
            docField,
            h('div', { style: { textAlign: 'right', marginTop: '10px' } }, addBtn));
    }

    let timer = null;
    async function runSearch() {
        const term = (searchInp.value || '').trim();
        clear(listBox);
        listBox.appendChild(h('div', { class: 'muted', style: { padding: '12px' } }, 'Загрузка каталога…'));
        try {
            const params = new URLSearchParams({ q: term, limit: '50' });
            if (catSel.value) params.set('category_id', catSel.value);
            else if (typeSel.value) params.set('type_id', typeSel.value);
            else if (groupSel.value) params.set('group_id', groupSel.value);
            const res = await gw('/catalog/services?' + params.toString());
            const rows = (res && res.data) || [];
            clear(listBox);
            if (!rows.length) { listBox.appendChild(h('div', { class: 'muted', style: { padding: '12px' } }, 'Ничего не найдено. Если услуги нет в каталоге — запросите её (ссылка внизу).')); return; }
            const addedN = rows.filter(r => existingCores.has(r.id)).length;
            listBox.appendChild(h('div', { class: 'muted', style: { padding: '8px 12px', fontSize: '11.5px', borderBottom: '1px solid var(--ink-100)' } }, trf('{n} услуг · {added} уже добавлено', { n: rows.length, added: addedN })));
            for (const row of rows) listBox.appendChild(renderRow(row));
        } catch (e) {
            clear(listBox);
            listBox.appendChild(h('div', { class: 'muted', style: { padding: '12px', color: 'var(--crit-700, #b91c1c)' } }, trf('Каталог недоступен: {msg}', { msg: e.message || e })));
        }
    }
    searchInp.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(runSearch, 300); });

    const card = h('div', { class: 'modal-card', style: { width: '760px', maxWidth: 'calc(100vw - 32px)' } },
        h('header', { class: 'modal-head' }, h('h2', null, Icon('Plus', { size: 16 }), ' Добавить услуги из каталога'), h('button', { class: 'modal-close', onclick: close }, '×')),
        h('div', { class: 'modal-body', style: { maxHeight: '76vh', overflowY: 'auto', overflowX: 'hidden', gridTemplateColumns: 'minmax(0, 1fr)' } },
            h('div', { class: 'field' }, h('label', null, 'Каталог услуг ', h('span', { class: 'muted', style: { fontWeight: 400 } }, '— нажмите «Добавить» у услуги, укажите цену и настройки; окно остаётся открытым для следующей')), searchInp),
            h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '8px', margin: '8px 0 10px' } }, groupSel, typeSel, catSel),
            listBox),
        h('footer', { class: 'modal-foot', style: { justifyContent: 'space-between' } },
            (clinicFlagsSync().custom_services_enabled
                ? h('button', { class: 'btn btn-outline', onclick: () => { close(); openEditor(container, onNavigate, null, true); } },
                    Icon('Plus', { size: 13 }), ' Нет в каталоге? Добавить свою услугу')   // CUSTOM_CLINIC_V2
                : h('button', { class: 'btn btn-outline', onclick: () => { close(); openServiceRequestModal(); } }, 'Нет в каталоге? Запросить услугу')),
            h('button', { class: 'btn btn-primary', onclick: close }, 'Готово')));
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    setTimeout(() => searchInp.focus(), 30);
    runSearch();
}
