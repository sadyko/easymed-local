// Services — SERVICES_CATALOG_V1 — service/procedure price-list admin page.
// Mirrors public/js/admin/views/visits.js for structure (mount / fetchAndPaint
// / DOM-building via h()).
//
// SERVICES_ONE_EDITOR_V1 — create and edit go through the ONE service editor
// (views/service-editor.js, SERVICE_EDITOR_V1): «Создать» and the row click
// both call openServiceEditor exactly like section-crud.js does, and lab
// fields appear only when the editor's Раздел = Лаборатория.
//
// SERVICE_DELETE_V1 — /api/db still grants DELETE on services to nobody, on
// purpose: removal goes through the `delete_service` RPC
// (server/services/rpc/catalog.js), which refuses any service that appears in a
// visit, invoice, admission, queue ticket, lab panel or CRM lead, and offers
// deactivation instead. Keeping the generic delete verb closed means there is
// no second path that skips that check. This page keeps the ONE client path to
// a hard delete: the per-row trash button (admin-only, server-checked,
// confirm-first).
//
// SVC_LIST_V2 (2026-09-15) — the list the owner asked for, after the four
// previews: a toolbar (search · Активные/Отключённые/Все · type · reset ·
// Шаблон/Импорт/Экспорт · Таблица · Создать), a header with a filter box
// under every column label, five columns by default (Наименование, Категория,
// Тип, Цена, Статус) and a «Настройка таблицы» dialog that adds, removes and
// reorders columns (kept per browser). No price range, no visit-tier column —
// «we dont need price range and the prices by amount of visit». The table is
// laid out fixed from column weights, so it always fills the card: with the
// sidebar closed, on a small screen, with three columns or eleven.

import { supabase } from '../../supabase.js';
import { h, Icon, clear, toast, Tag } from '../ui.js';
import { tr, trf } from '../i18n.js';
import { importExportButtons, exportSectionRows } from './section-import-export.js?v=aug17e';   // DATA_TRANSFER_V1 + SERVICES_BULK_V1
import { ratesOf } from './doctor-pool.js?v=dp1';   // SVC_PERFORMERS_V1 — тот же разбор service_rates, что и в мастере визита
import { openServiceEditor } from './service-editor.js?v=svceditor1';   // SERVICES_ONE_EDITOR_V1
import { openTableSetup, readColPrefs, writeColPrefs, widthShare } from './table-setup.js';   // TABLE_SETUP_V1

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

// SVC_VOCAB_V1 (2026-09-15) — the owner's words, kept apart everywhere:
//   ГРУППА    — services.type, the fixed five (consultation, lab, diagnostics
//               = imaging, procedure, surgery = 'other'); routing and the
//               chips in the registration window follow it.
//   ТИП       — service_types, written by the clinic when it adds a service
//               (services.type_id, «Выберите или впишите новую…»).
//   КАТЕГОРИЯ — service_categories, the same way (services.category_id).
// «the group is 5 … the type and category is written by the clinic».
const SERVICE_GROUPS = [['imaging', 'Диагностика'], ['consultation', 'Консультации'], ['lab', 'Лаборатория'], ['procedure', 'Процедуры'], ['other', 'Хирургия']];   // SERVICE_TYPES_FIVE_V1 — the five; a legacy 'radiology' row reads as «Диагностика»
// A service with no explicit group still lands in a bucket (a lab test in
// «Лаборатория», everything else in «Консультации»). The filter MUST use this
// same derivation, or filtering by the group shown in the row would drop it.
const groupKey = (s) => (s.type === 'radiology' ? 'imaging' : s.type) || (s.is_lab ? 'lab' : 'consultation');
const groupLabel = (s) => (SERVICE_GROUPS.find(t => t[0] === groupKey(s)) || ['', '—'])[1];

// SERVICE_DELETE_V1 — mirrors the RPC's own rule (server/services/rpc/catalog.js).
function isAdmin() {
    const u = (typeof window !== 'undefined' && window.easymed && window.easymed.state && window.easymed.state.user) || null;
    return !!u && (u.is_super_admin === true || u.is_admin === true || u.role === 'admin');
}

// Thousands-separated price display, no currency symbol (e.g. 50000 -> "50 000").
function fmtPrice(n) {
    const v = Math.round(Number(n) || 0);
    const sign = v < 0 ? '-' : '';
    return sign + String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

// -----------------------------------------------------------------------------
// COLUMNS — SVC_COLUMNS_V1. One list describes every column the table can
// show: its label (a dictionary key), its weight for the width share, the text
// a filter box and the search match against, and (optionally) a richer cell.
// The five without `optional` are the default; the rest wait in «Настройка
// таблицы → Можно добавить».
// -----------------------------------------------------------------------------
const lookups = { types: new Map(), categories: new Map(), departments: new Map() };   // id (string) -> name
const nameOf = (map, id) => (id == null || id === '' ? '' : (map.get(String(id)) || ''));
const performerNames = (s) => performersBySvc.get(String(s.id)) || [];

const COLUMNS = [
    { key: 'name',       label: 'Наименование', w: 34, text: (s) => s.name || '',
      cell: (s) => h('td', { class: 'cell-strong' }, s.name || '—') },
    { key: 'category',   label: 'Категория',    w: 16, text: (s) => nameOf(lookups.categories, s.category_id) },
    { key: 'type',       label: 'Тип',          w: 14, text: (s) => nameOf(lookups.types, s.type_id) },
    { key: 'group',      label: 'Группа',       w: 12, optional: true, text: (s) => groupLabel(s) },
    { key: 'price',      label: 'Цена',         w: 10, num: true, text: (s) => fmtPrice(s.price) },
    { key: 'status',     label: 'Статус',       w: 12, text: (s) => (s.active ? 'Активна' : 'Отключена'),
      cell: (s) => h('td', null, Tag(s.active ? 'Активна' : 'Отключена', { kind: s.active ? 'ok' : '', dot: true })) },
    { key: 'code',       label: 'Код',          w: 9,  optional: true, text: (s) => s.code || '',
      cell: (s) => h('td', { class: 'muted svc-one-line' }, s.code || '—') },
    { key: 'department', label: 'Отделение',    w: 14, optional: true, text: (s) => nameOf(lookups.departments, s.department_id) },
    { key: 'duration',   label: 'Время',        w: 8,  optional: true, text: (s) => (s.duration_minutes != null ? trf('{n} мин', { n: s.duration_minutes }) : '') },
    { key: 'doctor',     label: 'Врач',         w: 8,  optional: true, text: (s) => (s.requires_doctor ? 'Да' : 'Нет'),
      cell: (s) => h('td', null, s.requires_doctor ? Tag('Да', { kind: 'ok', dot: true }) : h('span', { class: 'muted' }, '—')) },
    { key: 'performers', label: 'Исполнители',  w: 18, optional: true, text: (s) => performerNames(s).join(', '), cell: performerCell },
    { key: 'lab',        label: 'Лаб.',         w: 7,  optional: true, text: (s) => (s.is_lab ? 'Лаб.' : ''),
      cell: (s) => h('td', null, s.is_lab ? Tag('Лаб.', { kind: 'info', dot: true }) : h('span', { class: 'muted' }, '—')) },
    // SERVICE_NAMES_ONLINE_V1
    { key: 'name_uz',    label: 'Название (UZ)', w: 24, optional: true, text: (s) => s.name_uz || '' },
    { key: 'name_en',    label: 'Название (EN)', w: 24, optional: true, text: (s) => s.name_en || '' },
    { key: 'online',     label: 'Онлайн-запись', w: 9,  optional: true, text: (s) => (s.online_booking ? 'Да' : 'Нет'),
      cell: (s) => h('td', null, s.online_booking ? Tag('Да', { kind: 'ok', dot: true }) : h('span', { class: 'muted' }, '—')) },
];
const DEFAULT_COLS = COLUMNS.filter((c) => !c.optional).map((c) => c.key);
const COL_PREF_KEY = 'svc.tbl.cols.v1';   // SVC_TABLE_SETUP_V1 — per browser, like the reference's prefKey

const colByKey = (k) => COLUMNS.find((c) => c.key === k);
// What the cell shows, in the interface language — the filter boxes and the
// search match THIS, so typing what you see always finds the row.
const displayText = (col, s) => tr(col.text(s) || '');

function visibleColumns() {
    return (readColPrefs(COL_PREF_KEY, COLUMNS.map((c) => c.key)) || DEFAULT_COLS).map(colByKey);
}

// Имена переносятся по словам: «Утамуродова Манзура, Усмонкулов Шароф» в одну
// строку не помещается ни на одном экране, а обрезать многоточием нельзя —
// смысл колонки именно в том, чтобы увидеть, КТО.
function performerCell(s) {
    const names = performerNames(s);
    if (!names.length) {
        return h('td', { class: 'muted', style: { whiteSpace: 'nowrap' } },
            s.requires_doctor ? h('span', { style: { color: 'var(--warn-700, #a16207)' } }, 'не назначен') : '—');
    }
    return h('td', { title: names.join(', '), style: { whiteSpace: 'normal', wordBreak: 'break-word', lineHeight: '1.35' } }, names.join(', '));
}

// -----------------------------------------------------------------------------
// FILTERS — the whole catalogue is loaded once and filtered IN MEMORY, so
// typing is instant and never re-queries. Toolbar: search, status segment,
// type. Header: one box under every visible column. The toolbar and header
// are built ONCE and never re-rendered: rebuilding them would recreate the
// field being typed into and steal focus.
// -----------------------------------------------------------------------------
const refs = { container: null, onNavigate: null, card: null, tbody: null, emptyEl: null, totalEl: null, capNote: null, bulkBar: null, headBox: null, resetBtn: null, colInputs: {} };
let allServices = [];
const flt = { q: '', status: 'active', group: '', cols: {} };
const clearFilters = () => { flt.q = ''; flt.group = ''; flt.cols = {}; };
const anyFilter = () => !!(flt.q.trim() || flt.group || Object.values(flt.cols).some((v) => String(v || '').trim()));

// Rendering every row of a big catalogue costs more than it is worth; the cap
// is announced (never silent) so a truncated list can't read as a complete one.
const MAX_RENDERED = 1000;

function matchesFilters(s) {
    if (flt.status === 'active' && !s.active) return false;
    if (flt.status === 'off' && s.active) return false;
    if (flt.group && groupKey(s) !== flt.group) return false;
    const q = flt.q.trim().toLowerCase();
    if (q) {
        const hay = [s.name, s.name_uz, s.name_en, s.code, nameOf(lookups.types, s.type_id), nameOf(lookups.categories, s.category_id), tr(groupLabel(s)), ...performerNames(s)]
            .filter(Boolean).join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
    }
    for (const [key, raw] of Object.entries(flt.cols)) {
        const v = String(raw || '').trim().toLowerCase();
        if (!v) continue;
        const col = colByKey(key);
        if (col && !displayText(col, s).toLowerCase().includes(v)) return false;
    }
    return true;
}

export async function renderServices(container, { onNavigate } = {}) {
    refs.container  = container;
    refs.onNavigate = onNavigate;
    mount();
    await fetchAndPaint();
}

// -----------------------------------------------------------------------------
// MOUNT — static shell; paintTable() builds the card (again after «Настройка
// таблицы»); fetchAndPaint() repaints just the tbody.
// -----------------------------------------------------------------------------
function mount() {
    clear(refs.container);
    clearFilters();   // a fresh visit to the page starts unfiltered
    flt.status = 'active';

    refs.totalEl = h('span', { class: 'muted svc-count' }, '');

    // ---- toolbar ------------------------------------------------------------
    const searchInp = h('input', {
        type: 'search', id: 'svc-search', placeholder: tr('Поиск по названию, коду, типу, исполнителю…'),
        oninput: (e) => { flt.q = e.target.value; renderRows(); },
    });
    const segBtns = {};
    const segment = h('div', { class: 'segmented', role: 'group' },
        ...[['active', 'Активные'], ['off', 'Отключённые'], ['all', 'Все']].map(([v, label]) => (segBtns[v] = h('button', {
            type: 'button', class: flt.status === v ? 'on' : '',
            onclick: () => { flt.status = v; for (const [k, b] of Object.entries(segBtns)) b.className = k === v ? 'on' : ''; renderRows(); },
        }, label))));
    const groupSel = h('select', { id: 'svc-group', class: 'svc-type',
        onchange: (e) => { flt.group = e.target.value; renderRows(); } },
        h('option', { value: '' }, 'Все группы'),
        ...SERVICE_GROUPS.map(([v, l]) => h('option', { value: v }, l)));
    refs.resetBtn = h('button', {
        class: 'btn btn-ghost btn-sm svc-reset', type: 'button', title: tr('Сбросить поиск и фильтры'), disabled: true,
        onclick: () => {
            clearFilters();
            searchInp.value = ''; groupSel.value = '';
            for (const inp of Object.values(refs.colInputs)) inp.value = '';
            renderRows();
        },
    }, Icon('Refresh', { size: 14 }), ' ', tr('Сбросить'));

    // SERVICES_ONE_EDITOR_V1 — the same call section-crud.js makes: add and
    // edit both open the shared editor; readOnly mirrors the write grant
    // (insert/update on services are admin-only, like the editor's RPC).
    const addBtn = h('button', {
        class: 'btn btn-primary btn-sm', type: 'button',
        onclick: () => openServiceEditor({ row: null, readOnly: !isAdmin(), onSaved: fetchAndPaint }),
    }, Icon('Plus', { size: 14 }), ' ', tr('Создать'));
    const setupBtn = h('button', {
        class: 'btn btn-outline btn-sm', type: 'button', title: tr('Состав и порядок колонок таблицы'),
        onclick: openTableSetupForServices,
    }, Icon('Settings', { size: 14 }), ' ', tr('Таблица'));

    // Two groups: filters on the left, actions on the right. When the card is
    // too narrow for both (sidebar open on a laptop), the right group wraps to
    // its own line and stays right-aligned instead of spilling mid-row.
    const toolbar = h('div', { class: 'svc-toolbar' },
        h('div', { class: 'svc-tb-left' },
            h('label', { class: 'svc-search', for: 'svc-search' }, Icon('Search', { size: 15 }), searchInp),
            segment,
            groupSel,
            refs.resetBtn,
            refs.totalEl),
        h('div', { class: 'svc-tb-right' },
            // DATA_TRANSFER_V1 — Шаблон / Импорт / Экспорт. Export re-reads the
            // whole table rather than reusing the painted rows.
            ...importExportButtons({ sectionKey: 'services', filenameStem: 'services', fetchRows: fetchAllServices, onImported: fetchAndPaint }),
            setupBtn,
            addBtn),
    );

    // SERVICES_BULK_V1 — полоса действий над отмеченными строками (владелец:
    // «cannot select several patients and services at the same time»).
    refs.bulkBar = h('div', { id: 'svc-bulk-bar', style: { display: 'none' } });
    refs.card = h('div', { class: 'card svc-card' });
    refs.container.appendChild(h('div', { class: 'fade-in' },
        h('div', { class: 'page-head' },
            h('div', null, h('h1', { class: 'page-title' }, 'Services')),   // the shell lifts the title into the top bar
        ),
        toolbar,
        refs.bulkBar,
        refs.card,
    ));
    paintTable();
}

// The card's table for the current column choice: header (label + filter box
// per column), body, empty state. Widths are shares of the card, so any
// column set fills the width exactly — never a sideways scroll.
function paintTable() {
    const cols = visibleColumns();
    const share = widthShare(cols, 34 + (isAdmin() ? 44 : 0));

    refs.colInputs = {};
    refs.tbody = h('tbody');
    refs.emptyEl = h('div', { class: 'empty', style: { display: 'none' } }, 'Нет услуг — добавьте первую.');
    refs.capNote = h('div', { class: 'muted', style: { display: 'none', padding: '8px 12px', fontSize: '12.5px', borderTop: '1px solid var(--ink-100)' } }, '');
    refs.headBox = h('input', { type: 'checkbox', title: tr('Отметить все'),
        onchange: (ev) => { const rows = allServices.filter(matchesFilters); if (ev.target.checked) for (const r of rows) selected.add(r.id); else for (const r of rows) selected.delete(r.id); renderRows(); } });

    const headCell = (c) => {
        const inp = h('input', { type: 'text', class: 'svc-th-filter', id: 'svc-f-' + c.key, placeholder: tr('фильтр'), value: flt.cols[c.key] || '',
            'aria-label': trf('Фильтр: {col}', { col: tr(c.label) }),
            oninput: (e) => { flt.cols[c.key] = e.target.value; renderRows(); } });
        refs.colInputs[c.key] = inp;
        return h('th', { style: { width: share(c) }, class: c.num ? 'num' : null },
            h('div', { class: 'svc-th-label' }, c.label),
            inp);
    };

    clear(refs.card);
    refs.card.appendChild(h('table', { class: 'tbl svc-tbl' },
        h('thead', null,
            h('tr', null,
                h('th', { style: { width: '34px' } }, refs.headBox),
                ...cols.map(headCell),
                isAdmin() ? h('th', { style: { width: '44px' } }, '') : null,   // SERVICE_DELETE_V1
            )),
        refs.tbody));
    refs.card.appendChild(refs.emptyEl);
    refs.card.appendChild(refs.capNote);
    if (allServices.length) renderRows(); else setLoadingRow();
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
        // truncated list is worse than not filtering at all. The whole catalogue
        // is loaded (paged, like the export). SVC_PERFORMERS_V1 — assignments
        // load TOGETHER with the catalogue; a failure there leaves the column
        // empty, never hides the list. SVC_LIST_V2 — categories and departments
        // the same way: a name per id for the two lookup columns.
        const [rows, staff, typs, cats, deps] = await Promise.all([
            fetchAllServices(),
            fetchPerformers().catch((e) => { console.warn('[services] performers:', e && e.message); return []; }),
            fetchNames('service_types'),
            fetchNames('service_categories'),
            fetchNames('departments'),
        ]);
        if (token !== lastFetchToken) return;   // a newer fetch already landed
        allServices = rows;
        performersBySvc = buildPerformerIndex(staff);
        lookups.types = typs;
        lookups.categories = cats;
        lookups.departments = deps;
        renderRows();
    } catch (e) {
        if (token !== lastFetchToken) return;
        toast(trf('Не удалось загрузить услуги: {msg}', { msg: (e && e.message) || e }), 'fail');
        allServices = [];
        renderRows();
    }
}

async function fetchNames(table) {
    try {
        const { data } = await supabase.from(table).select('id, name').limit(2000);
        return new Map((data || []).map((r) => [String(r.id), r.name || '']));
    } catch (e) { console.warn('[services] ' + table + ':', e && e.message); return new Map(); }
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
        h('td', { colspan: String(visibleColumns().length + 1 + (isAdmin() ? 1 : 0)), style: { textAlign: 'center', padding: '24px', color: 'var(--ink-500)', fontSize: '12.5px' } }, 'Loading…'),
    ));
    refs.emptyEl.style.display = 'none';
}

// Repaints the tbody from `allServices` through the current filters. Called on
// every keystroke — it touches only the body, never the toolbar or header, so
// the field being typed into keeps its focus and caret.
function renderRows() {
    const filtering = anyFilter();
    if (refs.resetBtn) refs.resetBtn.disabled = !filtering;

    const rows = allServices.filter(matchesFilters);
    const total = allServices.length;
    const inStatus = flt.status === 'all' ? total : allServices.filter((s) => (flt.status === 'active' ? !!s.active : !s.active)).length;
    if (refs.totalEl) {
        refs.totalEl.textContent = filtering
            ? trf('{n} из {max}', { n: rows.length, max: inStatus })
            : trf('Услуг: {n}', { n: total }) + (flt.status === 'all' ? '' : ' · ' + trf('показано: {n}', { n: inStatus }));
    }

    clear(refs.tbody);
    if (!rows.length) {
        refs.emptyEl.style.display = '';
        refs.emptyEl.textContent = tr(total ? 'Ничего не найдено' : 'Нет услуг — добавьте первую.');
        if (refs.capNote) refs.capNote.style.display = 'none';
        syncSelection(rows);
        return;
    }
    refs.emptyEl.style.display = 'none';

    const cols = visibleColumns();
    const shown = rows.slice(0, MAX_RENDERED);
    for (const s of shown) refs.tbody.appendChild(serviceRow(s, cols));
    syncSelection(rows);

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

function serviceRow(s, cols) {
    const inactive = !s.active;
    const box = h('input', { type: 'checkbox',
        onclick: (e) => e.stopPropagation(),   // клик по ряду открывает редактор — галочка не должна
        onchange: (e) => { if (e.target.checked) selected.add(s.id); else selected.delete(s.id); syncSelection(allServices.filter(matchesFilters)); } });
    if (selected.has(s.id)) box.checked = true;
    return h('tr', {
        class: 'row-click',
        style: { cursor: 'pointer', opacity: inactive ? '0.55' : '' },
        // SERVICES_ONE_EDITOR_V1 — the row opens the shared editor (read-only
        // below admin, matching the services write grant).
        onclick: () => openServiceEditor({ row: s, readOnly: !isAdmin(), onSaved: fetchAndPaint }),
    },
        h('td', { onclick: (e) => e.stopPropagation() }, box),
        ...cols.map((c) => {
            if (c.cell) return c.cell(s);
            const txt = c.text(s);
            return h('td', { class: (c.num ? 'num' : 'svc-one-line'), title: txt || null }, txt || '—');
        }),
        deleteCell(s),
    );
}

// «Настройка таблицы» — SVC_TABLE_SETUP_V1, the shared dialog (table-setup.js).
function openTableSetupForServices() {
    openTableSetup({
        columns: COLUMNS.map((c) => ({ key: c.key, label: c.label })),
        visible: visibleColumns().map((c) => c.key),
        defaults: DEFAULT_COLS,
        onApply: (keys) => { writeColPrefs(COL_PREF_KEY, keys, DEFAULT_COLS); paintTable(); },
    });
}

// SERVICES_BULK_V1 — отмеченные услуги (id) и полоса действий над ними.
const selected = new Set();
function syncSelection(rows) {
    for (const id of [...selected]) if (!allServices.some((r) => r.id === id)) selected.delete(id);
    if (refs.headBox) {
        const all = rows.length > 0 && rows.every((r) => selected.has(r.id));
        refs.headBox.checked = all;
        refs.headBox.indeterminate = !all && rows.some((r) => selected.has(r.id));
    }
    paintBulkBar();
}
function paintBulkBar() {
    const bar = refs.bulkBar;
    if (!bar) return;
    clear(bar);
    const n = selected.size;
    if (!n) { bar.style.display = 'none'; return; }
    bar.style.display = '';
    const picked = () => allServices.filter((r) => selected.has(r.id));
    const setActive = async (active) => {
        const rows = picked();
        let ok = 0, bad = 0;
        for (const r of rows) {
            const { error } = await supabase.from('services').update({ active: active ? 1 : 0 }).eq('id', r.id);
            if (error) bad++; else ok++;
        }
        toast(active ? trf('Включено услуг: {n}', { n: ok }) : trf('Отключено услуг: {n}', { n: ok }), bad ? 'warn' : 'ok');
        selected.clear();
        await fetchAndPaint();
    };
    const removeAll = async () => {
        const rows = picked();
        if (!window.confirm(trf('Удалить услуг: {n}? Услуги, которые уже использовались, удалить нельзя — они будут отключены.', { n: rows.length }))) return;
        let deleted = 0, disabled = 0, bad = 0;
        for (const r of rows) {
            try {
                const { data: chk, error } = await supabase.rpc('service_delete_check', { p_service_id: r.id });
                if (error) throw error;
                if (chk && chk.deletable) {
                    const { error: delErr } = await supabase.rpc('delete_service', { p_service_id: r.id });
                    if (delErr) throw delErr;
                    deleted++;
                } else {
                    const { error: upErr } = await supabase.from('services').update({ active: 0 }).eq('id', r.id);
                    if (upErr) throw upErr;
                    disabled++;
                }
            } catch (e) { bad++; }
        }
        toast(trf('Удалено: {d}, отключено: {o}, не удалось: {b}', { d: deleted, o: disabled, b: bad }), bad ? 'warn' : 'ok');
        selected.clear();
        await fetchAndPaint();
    };
    bar.appendChild(h('div', { class: 'bulk-bar' },
        h('span', { style: { color: 'var(--primary-700)' } }, Icon('Check', { size: 14 })),
        h('span', { class: 'bulk-count' }, trf('Выбрано: {n}', { n })),
        h('button', { class: 'btn btn-ghost btn-sm', type: 'button', style: { color: 'var(--primary-700)' },
            onclick: () => { selected.clear(); renderRows(); } }, tr('Снять выделение')),
        h('span', { class: 'grow' }),
        h('button', { class: 'btn btn-outline btn-sm', type: 'button',
            onclick: () => exportSectionRows({ sectionKey: 'services', rows: picked(), filenameStem: 'services-selected' }) },
            Icon('Download', { size: 14 }), ' ', tr('Экспорт выбранных в Excel')),
        isAdmin() ? h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: () => setActive(true) }, Icon('Check', { size: 14 }), ' ', tr('Включить')) : null,
        isAdmin() ? h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: () => setActive(false) }, Icon('Pause', { size: 14 }), ' ', tr('Отключить')) : null,
        isAdmin() ? h('button', { class: 'btn btn-danger btn-sm', type: 'button', onclick: removeAll }, Icon('Trash', { size: 14 }), ' ', tr('Удалить')) : null,
    ));
}

// -----------------------------------------------------------------------------
// DELETE — SERVICE_DELETE_V1. The one client path to a hard delete (see the
// header comment): ask the server what is possible FIRST, so the dialog says
// what will actually happen rather than offering a delete that was never
// possible; a service with history gets a deactivate offer instead.
// -----------------------------------------------------------------------------
function deleteCell(s) {
    // Admin-only because the RPC is admin-only; showing the button to anyone
    // else would just produce a 403 they can do nothing about.
    if (!isAdmin()) return null;
    return h('td', { style: { textAlign: 'right', width: '1%' } },
        h('button', {
            class: 'icon-btn sm danger', type: 'button', title: 'Удалить', 'aria-label': 'Удалить',   // as in the settings register (LIST_ACTIONS_V1)
            onclick: async (e) => {
                e.stopPropagation();   // клик по ряду открывает редактор — не сюда
                const btn = e.currentTarget;
                btn.disabled = true;
                try { await confirmDelete(s); }
                finally { if (btn.isConnected) btn.disabled = false; }
            },
        }, Icon('Trash', { size: 14 })));
}

async function confirmDelete(svc) {
    try {
        const { data: chk, error } = await supabase.rpc('service_delete_check', { p_service_id: svc.id });
        if (error) throw error;

        if (!chk.deletable) {
            const where = chk.blocking.map(b => `${b.label}: ${b.count}`).join(', ');
            const ok = window.confirm(
                trf('Услуга «{name}» уже используется ({where}).\n\nУдалить её нельзя — прошлые визиты и счёта ссылаются на неё по названию.\n\nОтключить её вместо удаления? Она исчезнет из списков выбора, а история останется целой.', { name: chk.name, where }));
            if (ok) await deactivateService(svc);
            return;
        }

        if (!window.confirm(trf('Удалить услугу «{name}» навсегда?\n\nОна нигде не использована, поэтому удаляется без следа.', { name: chk.name }))) return;
        const { error: delErr } = await supabase.rpc('delete_service', { p_service_id: svc.id });
        if (delErr) throw delErr;
        toast(trf('Услуга «{name}» удалена', { name: chk.name }), 'ok');
        await fetchAndPaint();
    } catch (e) {
        toast((e && e.message) || 'Не удалось удалить услугу.', 'fail');
    }
}

async function deactivateService(svc) {
    const { error } = await supabase.from('services').update({ active: 0 }).eq('id', svc.id);
    if (error) throw error;
    toast('Услуга отключена — история сохранена', 'ok');
    await fetchAndPaint();
}
