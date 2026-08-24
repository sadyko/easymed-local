// Laboratory (LIS) — LAB_HANDLING_V1 — the full lab handling workflow
// (design doc 2026-08-08), replacing the LABS_UI_V1 single-value stub.
//
// The state machine, on visit_services.status (TEXT, no CHECK — the two
// lab-only values 'collected' and 'resulted' are new to the local vocabulary):
//
//   added        «Ожидает оплату»   (invoice raised, cashier not paid yet)
//   queued       «Забор пробы»      → stamps sample_collected_at, prints label
//   collected    «В работу»         → status = in_progress
//   in_progress  «Результаты…»      → panel-driven entry modal → resulted
//   resulted     «Проверить и выдать» → verified_by/at on results + row,
//                                       status = completed, branded report
//   completed    static «Выдан» + reprint
//
// added→queued happens in the cashier (record_payment flips invoiced lines to
// 'queued'), so the lab queue lights up the moment the счёт is paid.
//
// Result entry is panel-driven: lab_panels.service_id links the billable
// service to its panel, lab_panel_analytes carries units, decimals and
// reference ranges (incl. sex-specific _m/_f). A lab service without a panel
// falls back to a single-value form fed by services.ref_low/high/ref_text.
// Each analyte writes ONE lab_results row (parameter = analyte name), with
// the resolved numeric range stored on the row (ref_low/ref_high, mig 041).
//
// Verified results reach the patient card automatically: the card's
// «Документы» tab derives «Результаты анализов» entries from lab_results
// (PATIENT_DOCS_CLINICAL_V1) — no duplicate visit_documents row is written.
//
// Accession barcodes: LAB-<visit_service id, 6 digits> via lab-barcode.js
// (Code128-B, CSP-safe); reports print through the branded printableSheet.

import { supabase } from '../../supabase.js';
import { h, Icon, clear, toast, Tag, fmtDate, fmtDateTime, field, avColor, initials } from '../ui.js';
import { printBarcodeLabel } from './lab-barcode.js';
import { printableSheet } from './doc-settings.js?v=q3company1';   // same URL as patient-card/service-workspace (one instance)
import { canDelete, canManageLabSettings } from '../permissions.js';   // LAB_PANELS_MODE_V1 — same right that opens Настройки → «Лаборатория и диагностика»
import { mountLabPanels } from './lab-panels.js';   // LAB_PANELS_MODE_V1 — the editor itself, shared with lab-settings.js
// ?v= is required here, not decorative: this module gained selectOptionsFor, and a
// browser holding the older cached copy would fail the named import and blank the view.
import { pluralRu, groupLabRows, selectOptionsFor } from './lab-grouping.js?v=labsel1';   // LAB_GROUP_V1 / LAB_SELECT_OPTIONS_V1 — pure helpers, unit-tested separately
import { isLabService, deptKindMap, typeNameMap } from './lab-service.js';
import { labFlagCell, labPosFor, fmtDMY, labSexRu, labRefText, matchResultsToAnalytes, labAccession, labIssueDates, labMaxDate,
         namedRangeCell, ageYears } from './lab-doc.js?v=labshared1';
import { analyteIndex, resolveAnalyte, resolveAnalyteWhy, nk } from './lab-analyte-index.js?v=labshared1';   // LAB_BLANK_DESIGNED_V1

function currentUser() {
    try { return (window.easymed && window.easymed.state && window.easymed.state.user) || {}; }
    catch (e) { return {}; }
}

// LAB_SHEET_HEAD_V1 — формат номера общий для лаборатории, карты и бота.
const accession = (vs) => labAccession(vs.id);
// Сколько ЗАКРЫТЫХ анализов держим в разделе. Открытые не ограничены вовсе.
const LAB_DONE_WINDOW = 2000;
const nowIso = () => new Date().toISOString().slice(0, 19) + 'Z';

const ST = {
    added:       { label: 'Ожидает оплату',     kind: '' },
    queued:      { label: 'Оплачен · к забору', kind: 'warn' },
    collected:   { label: 'Проба взята',        kind: 'info' },
    in_progress: { label: 'В работе',           kind: 'info' },
    resulted:    { label: 'Результаты внесены', kind: 'purple' },
    completed:   { label: 'Выдан',              kind: 'ok' },
};

const FILTERS = [
    { key: 'open',      label: 'Открытые',   match: (s) => s !== 'completed' },
    { key: 'collect',   label: 'Забор',      match: (s) => s === 'queued' },
    { key: 'work',      label: 'В работе',   match: (s) => s === 'collected' || s === 'in_progress' },
    { key: 'resulted',  label: 'Результаты', match: (s) => s === 'resulted' },
    { key: 'all',       label: 'Все',        match: () => true },
];

// Tube-colour pill (services.tube_color). Names follow common vacutainer caps.
const TUBES = {
    lavender: { hex: '#8b5cf6', label: 'ЭДТА' },
    purple:   { hex: '#8b5cf6', label: 'ЭДТА' },
    red:      { hex: '#dc2626', label: 'Сухая' },
    blue:     { hex: '#3b82f6', label: 'Цитрат' },
    green:    { hex: '#22c55e', label: 'Гепарин' },
    gray:     { hex: '#6b7280', label: 'Фторид' },
    grey:     { hex: '#6b7280', label: 'Фторид' },
    yellow:   { hex: '#eab308', label: 'Гель' },
};
function tubePill(color) {
    if (!color) return null;
    const t = TUBES[String(color).toLowerCase()] || { hex: '#9ca3af', label: color };
    return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '5px', fontSize: '11px', color: 'var(--ink-600)' } },
        h('span', { style: { width: '9px', height: '9px', borderRadius: '999px', background: t.hex, border: '1px solid rgba(0,0,0,0.15)', flex: 'none' } }),
        t.label);
}

const FLAG_KIND = { normal: 'ok', low: 'info', high: 'warn', abnormal: 'purple', critical: 'crit' };
const FLAG_RU = { normal: 'Норма', low: 'Ниже', high: 'Выше', abnormal: 'Аномально', critical: 'Критично' };
function flagTag(f) {
    if (!f) return h('span', { class: 'muted' }, '—');
    return Tag(FLAG_RU[f] || f, { kind: FLAG_KIND[f] || '', dot: true });
}

// -----------------------------------------------------------------------------
// State
// -----------------------------------------------------------------------------
const refs = { container: null, list: null, emptyEl: null, totalEl: null, filterWrap: null, searchInp: null, panelsHost: null, tabId: null };
const state = {
    rows: [],          // lab visit_services, newest first
    patientMap: {},    // visit_id -> { visit_date, patient }
    resultsByVs: {},   // visit_service_id -> lab_results rows (all analytes)
    panelByService: {},// service_id -> lab_panels row
    deptKindById: {},  // department_id -> kind   (LAB_SERVICE_ROUTING_V1)
    typeNameById: {},  // service_type_id -> name (LAB_SERVICE_ROUTING_V1)
    filter: 'open',
    search: '',
    mode: 'queue',     // LAB_PANELS_MODE_V1 — 'queue' | 'panels'
};

// LAB_PANELS_MODE_V1 — «Панели» is a MODE of Лаборатория, not a second sidebar
// entry: the technician stays in the section they already live in, and the
// module keeps one nav item and one tab.
const MODES = [
    { key: 'queue',  label: 'Очередь' },
    { key: 'panels', label: 'Панели'  },
];

export async function renderLaboratory(container, ctx = {}) {
    refs.container = container;
    refs.tabId = ctx.tabId || null;   // HASH_SUBROUTE_V1 — needed to report the mode back to the shell
    state.filter = 'open';
    state.search = '';
    // LAB_PANELS_MODE_V1 — the mode comes out of the URL: admin.js hands
    // '#labs/panels' over as payload.sub, so a reload or a pasted link opens the
    // mode it names instead of always dropping the user back on the queue.
    // Gated exactly like the switch itself — a role that may not manage panels
    // gets the queue no matter what the address bar asks for.
    const wantsPanels = !!(ctx.payload && ctx.payload.sub === 'panels');
    state.mode = (wantsPanels && canManageLabSettings()) ? 'panels' : 'queue';
    mount();
    await paintMode();
}

// Paints the body the current mode needs. The queue and the panel editor are
// two different screens sharing one page head, so nothing here is shared beyond
// that head — mount() decides which body exists, this decides what fills it.
async function paintMode() {
    if (state.mode === 'panels') await mountLabPanels(refs.panelsHost);
    else await fetchAndPaint();
}

// LAB_PANELS_MODE_V1 — switching mode rebuilds the head (the segmented control
// has to move its «on» state and the queue's search/filter/refresh have no
// meaning in the editor) and then repaints the body.
async function setMode(mode) {
    if (state.mode === mode) return;
    // Defence in depth: the button is not rendered for a role without the right,
    // but a mode setter that trusts its own UI is one refactor away from being
    // the hole. The permission is re-checked here too.
    if (mode === 'panels' && !canManageLabSettings()) return;
    state.mode = mode;
    syncModeUrl();
    mount();
    await paintMode();
}

// URL reflects state (web-interface-guidelines): the mode lives in the address,
// so F5 keeps it and a colleague can be sent straight to it. replaceState, not
// pushState — flipping a mode inside one screen is not a new place for the Back
// button to return to, and a technician toggling twice should not have to press
// Back three times to leave Лаборатория.
function syncModeUrl() {
    try {
        if (typeof history === 'undefined' || !history.replaceState) return;
        const panels = state.mode === 'panels';
        history.replaceState({ view: 'labs', payload: panels ? { sub: 'panels' } : null },
            '', '#labs' + (panels ? '/panels' : ''));
        // Tell the shell too: the address bar alone is not enough, because
        // navigate() rewrites the hash from the TAB's payload the next time
        // anyone routes to Лаборатория.
        if (typeof window !== 'undefined' && typeof window.easymedSetTabSub === 'function') {
            window.easymedSetTabSub(refs.tabId, panels ? 'panels' : null);
        }
    } catch (e) {
        // A hardened browser can refuse history writes; the mode still works,
        // it just stops being linkable. Never worth breaking the screen for.
    }
}

// LAB_PANELS_MODE_V1 — the two-way switch, rendered ONLY for a role that may
// manage lab settings. canManageLabSettings() is already true for any Lab role
// at edit level, which is the whole point of the plan: the technician gets panel
// editing without being handed the Settings hub (staff accounts, price lists,
// licence, danger zone). A read-only lab user sees no switch at all — not a
// disabled one, because there is nothing they could do to earn it here.
function modeSwitch() {
    if (!canManageLabSettings()) return null;
    const wrap = h('div', { class: 'segmented', role: 'group', 'aria-label': 'Режим раздела' });
    for (const m of MODES) {
        const on = state.mode === m.key;
        wrap.appendChild(h('button', {
            type: 'button',
            class: 'segmented-btn' + (on ? ' on' : ''),
            'aria-pressed': on ? 'true' : 'false',
            onclick: () => setMode(m.key),
        }, m.label));
    }
    return wrap;
}

// -----------------------------------------------------------------------------
// Shell
// -----------------------------------------------------------------------------
function mount() {
    clear(refs.container);

    // LAB_GROUP_V1 (local port) — one card per patient-visit (lq-card), not a
    // table: replaces the old flat one-row-per-order queue.
    refs.list = h('div', { id: 'lab-list' });
    refs.emptyEl = h('div', { class: 'empty', style: { display: 'none' } },
        'Заявок нет. Лабораторная услуга попадает сюда, как только добавлена к визиту; после оплаты счёта она встаёт в очередь на забор.');
    refs.totalEl = h('span', { class: 'muted', style: { fontSize: '12px' } }, '');
    refs.filterWrap = h('div', { class: 'segmented' });

    refs.searchInp = h('input', {
        type: 'text', placeholder: 'Поиск: пациент, тест, №…',
        style: {
            height: '34px', padding: '0 12px', width: '240px', maxWidth: '100%',
            border: '1px solid var(--ink-200)', borderRadius: '9px',
            fontSize: '12.5px', fontFamily: 'inherit',
        },
    });
    let tmr = null;
    refs.searchInp.addEventListener('input', () => {
        clearTimeout(tmr);
        tmr = setTimeout(() => { state.search = refs.searchInp.value; paintRows(); }, 180);
    });

    // LAB_PANELS_MODE_V1 — the editor gets its own host so switching modes swaps
    // one child instead of leaving the queue's card on screen behind it.
    refs.panelsHost = h('div');
    const panels = state.mode === 'panels';

    refs.container.appendChild(h('div', { class: 'fade-in' },
        h('div', { class: 'page-head' },
            // minWidth 0 — a flex child with a long subtitle must be allowed to
            // shrink, or the head actions get pushed off the right edge.
            h('div', { style: { minWidth: '0' } },
                h('h1', { class: 'page-title' }, 'Лаборатория'),
                h('p', { class: 'page-subtitle' }, panels
                    ? 'Панели исследований, показатели и референсные значения.'
                    : 'Очередь проб: забор → в работу → результаты → проверка и выдача.'),
            ),
            h('div', { class: 'page-head-actions', style: { display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' } },
                modeSwitch(),
                // The queue's own controls filter the queue — in the editor they
                // would point at nothing, so they are absent rather than inert.
                panels ? null : refs.searchInp,
                panels ? null : refs.filterWrap,
                panels ? null : h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: () => fetchAndPaint() },
                    Icon('Refresh', { size: 13 }), ' Обновить'),
            ),
        ),
        panels ? refs.panelsHost : h('div', { class: 'card' },
            refs.list,
            refs.emptyEl,
        ),
    ));
    if (!panels) paintFilters();
}

function paintFilters() {
    clear(refs.filterWrap);
    const counts = {};
    for (const f of FILTERS) counts[f.key] = state.rows.filter(r => f.match(r.status)).length;
    for (const f of FILTERS) {
        refs.filterWrap.appendChild(h('button', {
            type: 'button',
            class: state.filter === f.key ? 'on' : null,
            onclick: () => {
                if (state.filter === f.key) return;
                state.filter = f.key;
                paintFilters();
                paintRows();
            },
        }, f.label + (state.rows.length ? ` · ${counts[f.key]}` : '')));
    }
}

// -----------------------------------------------------------------------------
// Fetch
// -----------------------------------------------------------------------------
let lastFetchToken = 0;

async function fetchAndPaint() {
    const token = ++lastFetchToken;
    clear(refs.list);
    refs.list.appendChild(h('div', { class: 'empty' }, 'Загрузка…'));
    refs.emptyEl.style.display = 'none';

    try {
        const [{ data: vsOpen, error: vsErr }, { data: vsDone }, { data: panels }, deptsRes, typesRes] = await Promise.all([
            // LAB_QUEUE_NO_TRUNCATION_V1 — открытую работу НЕ обрезаем.
            //
            // Здесь стоял один запрос с .limit(400) по убыванию id, и этого
            // хватило ровно до 728-й строки: 400-я сверху оказалась id 352, а
            // всё, что ниже, в раздел не попадало ВООБЩЕ — ни фильтром «Все»,
            // ни поиском. 154 лабораторных заказа стали недостижимы, включая
            // готовые анализы пациентов, которые лаборатория ищет по фамилии.
            //
            // Теперь два запроса: незакрытая работа берётся целиком (это и есть
            // очередь — терять из неё строки нельзя ни при каком объёме), а
            // история закрытых ограничена окном. Раздел перестаёт зависеть от
            // того, сколько строк успели завести после нужной.
            supabase.from('visit_services')
                // department_id/type_id ride along so the lab-service rule can check
                // the department and catalogue-type branches (LAB_SERVICE_ROUTING_V1).
                .select('*, services(name,is_lab,type,department_id,type_id,result_unit,ref_low,ref_high,ref_text,specimen,tube_color)')
                .in('status', ['added', 'queued', 'collected', 'in_progress', 'resulted'])
                .order('id', { ascending: false })
                .limit(5000),
            supabase.from('visit_services')
                .select('*, services(name,is_lab,type,department_id,type_id,result_unit,ref_low,ref_high,ref_text,specimen,tube_color)')
                .eq('status', 'completed')
                .order('id', { ascending: false })
                .limit(LAB_DONE_WINDOW),
            // lab_panels has no service_id filter in the registry — the list is
            // small, so load active panels whole and match client-side.
            supabase.from('lab_panels').select('id, name, code, service_id, has_narrative').eq('active', true).limit(500),
            // Two small lookups; the compiler does one embed hop, so the server's
            // services(departments(kind), service_types(name)) becomes these instead.
            supabase.from('departments').select('id, name, kind').limit(200),
            supabase.from('service_types').select('id, name').limit(200),
        ]);
        if (token !== lastFetchToken) return;
        const vsData = (vsOpen || []).concat(vsDone || []);
        if (vsErr) { toast('Не удалось загрузить очередь: ' + (vsErr.message || vsErr), 'fail'); paintEmpty(); return; }

        state.panelByService = {};
        for (const p of (panels || [])) {
            if (p.service_id != null) state.panelByService[p.service_id] = p;
        }
        state.deptKindById = deptKindMap(deptsRes && deptsRes.data);
        state.typeNameById = typeNameMap(typesRes && typesRes.data);

        // LAB_SERVICE_ROUTING_V1 — the same rule the panel editor uses (lab-service.js),
        // ported from production easymed.uz: routing enum, laboratory DEPARTMENT, or a
        // laboratory-named catalogue TYPE — plus, locally, a linked panel. Checking
        // only the enum is what made a service the operator had routed to the lab
        // by department invisible here.
        const rows = (vsData || []).filter((r) => isLabService(r.services, {
            deptKindById: state.deptKindById,
            typeNameById: state.typeNameById,
            hasPanel: () => !!state.panelByService[r.service_id],
        }));

        // Patient info per visit (2-hop embeds are not supported → second read).
        const visitIds = [...new Set(rows.map(r => r.visit_id))];
        const patientMap = {};
        if (visitIds.length) {
            const { data: visitsData } = await supabase.from('visits')
                .select('id,visit_date,patients(id,full_name,mrn,gender,date_of_birth)')
                .in('id', visitIds);
            if (token !== lastFetchToken) return;
            for (const v of (visitsData || [])) patientMap[v.id] = { visit_date: v.visit_date, patient: v.patients || {} };
        }

        // ALL result rows per order (multi-analyte panels → many rows per vs).
        const vsIds = rows.map(r => r.id);
        const resultsByVs = {};
        if (vsIds.length) {
            // LAB_LIST_COLUMNS_V1 — только те колонки, которые экран реально
            // читает (см. историю: select('*') тянул 565 КБ на перезагрузку).
            //
            // LAB_RESULTS_NO_CAP_V1 — здесь стоял .limit(2000) на ВЕСЬ запрос.
            // Пока результатов в клинике было меньше двух тысяч, всё работало;
            // в день, когда их стало 2190, у ДВЕНАДЦАТИ свежих заказов строки
            // молча отрезались. Экран открывал бланк ввода ПУСТЫМ, лаборант
            // вводил заново, сохранение не находило прежней строки (prevId) и
            // ВСТАВЛЯЛО ДУБЛИКАТ — 89 лишних строк за один день, а на экране
            // по-прежнему пусто, потому что перезагрузка снова резала хвост.
            // Теперь id разбиваются на партии и каждая читается целиком:
            // потолка, о который клиника однажды ударится, больше нет.
            const CHUNK = 150;
            const chunks = [];
            for (let i = 0; i < vsIds.length; i += CHUNK) chunks.push(vsIds.slice(i, i + CHUNK));
            const parts = await Promise.all(chunks.map((ids) =>
                supabase.from('lab_results')
                    .select('id,visit_service_id,parameter,value,unit,flag,notes,entered_at')
                    .in('visit_service_id', ids).limit(100000)));
            if (token !== lastFetchToken) return;
            for (const part of parts) {
                for (const r of (part.data || [])) {
                    (resultsByVs[r.visit_service_id] = resultsByVs[r.visit_service_id] || []).push(r);
                }
            }
            for (const k of Object.keys(resultsByVs)) resultsByVs[k].sort((a, b) => a.id - b.id);
        }

        state.rows = rows;
        state.patientMap = patientMap;
        state.resultsByVs = resultsByVs;
        paintFilters();
        paintRows();
    } catch (e) {
        if (token !== lastFetchToken) return;
        toast('Не удалось загрузить очередь: ' + (e && e.message || e), 'fail');
        paintEmpty();
    }
}

function paintEmpty() {
    state.rows = [];
    state.patientMap = {};
    state.resultsByVs = {};
    paintFilters();
    paintRows();
}

// -----------------------------------------------------------------------------
// Rows — LAB_GROUP_V1 (local port): one lq-card per patient-visit, replacing
// the old flat one-row-per-order table (queueRow/paintRows). Grouping itself
// is a pure function (lab-grouping.js, unit-tested); this file only builds
// DOM from the groups it returns.
// -----------------------------------------------------------------------------
function paintRows() {
    clear(refs.list);
    const f = FILTERS.find(x => x.key === state.filter) || FILTERS[0];
    const q = state.search.trim().toLowerCase();
    const visible = state.rows.filter(r => {
        if (!f.match(r.status)) return false;
        if (!q) return true;
        const info = state.patientMap[r.visit_id] || {};
        const p = info.patient || {};
        return (p.full_name || '').toLowerCase().includes(q)
            || (p.mrn || '').toLowerCase().includes(q)
            || ((r.services && r.services.name) || '').toLowerCase().includes(q)
            || accession(r).toLowerCase().includes(q);
    });

    if (refs.totalEl) refs.totalEl.textContent = String(visible.length);
    if (!visible.length) { refs.emptyEl.style.display = ''; return; }
    refs.emptyEl.style.display = 'none';

    const groups = groupLabRows(visible, state.patientMap, accession);
    for (const g of groups) refs.list.appendChild(labGroupCard(g));
}

// Result summary cell — shared by the per-analysis card line (lqItem) below.
function resultsCell(r) {
    const results = state.resultsByVs[r.id] || [];
    if (!results.length) return h('span', { class: 'muted' }, '—');
    return h('span', { style: { fontSize: '12px' } },
        results.length === 1
            ? h('span', { class: 'num' }, (results[0].value != null ? String(results[0].value) : '—') + (results[0].unit ? ' ' + results[0].unit : ''))
            : h('span', { class: 'muted' }, results.length + ' показателей'),
        ' ',
        worstFlagTag(results));
}

// LAB_QUEUE_V2 (local port) — one line per analysis inside a patient card.
// Carries the SAME per-order action buttons the old flat table exposed
// (Забор пробы / В работу / Результаты… / Изменить + Проверить и выдать /
// Отчёт / этикетка) via the existing actionButtons() — the grouped card is a
// new way to reach these, not a replacement for them.
function lqItem(r, patient) {
    const svc = r.services || {};
    const results = state.resultsByVs[r.id] || [];
    const st = ST[r.status] || { label: r.status || '—', kind: '' };
    return h('div', { class: 'lq-item' },
        tubePill(svc.tube_color),
        h('div', { style: { flex: 1, minWidth: 0 } },
            h('div', { class: 'lq-name' }, svc.name || '—'),
            svc.specimen ? h('div', { class: 'lq-type' }, svc.specimen) : null,
        ),
        r.sample_collected_at ? h('span', { class: 'lq-collected' }, 'взято ' + fmtDateTime(r.sample_collected_at)) : null,
        results.length ? resultsCell(r) : null,
        Tag(st.label, { kind: st.kind, dot: true }),
        h('div', { class: 'row', style: { gap: '6px', flexWrap: 'wrap' } }, ...actionButtons(r, patient, results)),
    );
}

// One card per patient-visit: header (patient + accession №), group actions
// (bulk result entry / barcode / verify / report), and every analysis inside.
function labGroupCard(g) {
    const rows = g.rows;
    const total = rows.length;
    const done = rows.filter(r => (state.resultsByVs[r.id] || []).length > 0).length;
    const awaiting = rows.filter(r => r.status === 'queued').length;
    const critCount = rows.filter(r => (state.resultsByVs[r.id] || []).some(x => x.flag === 'critical')).length;
    const anyActive = rows.some(r => r.status !== 'added');   // 'added' = awaiting payment, mirrors server's 'unpaid'
    const anyResulted = rows.some(r => (state.resultsByVs[r.id] || []).length > 0);
    const anyToVerify = rows.some(r => r.status === 'resulted');
    const pct = total ? Math.round(done / total * 100) : 0;
    const allDone = total > 0 && done === total;
    const info = state.patientMap[g.visitId] || {};
    const patient = info.patient || {};

    const sexTxt = g.patientSex === 'male' ? 'М' : g.patientSex === 'female' ? 'Ж' : '';
    const age = ageYears(g.patientDob);
    const ageTxt = [age != null ? age + ' ' + pluralRu(age, 'год', 'года', 'лет') : '', g.patientDob ? fmtDate(g.patientDob) : '']
        .filter(Boolean).join(' · ');

    return h('div', { class: 'lq-card' },
        h('div', { class: 'lq-head' },
            h('div', { class: 'avatar ' + avColor(g.patientId || g.patientMrn || g.patientName) }, initials(g.patientName)),
            h('div', { style: { flex: 1, minWidth: '160px' } },
                h('div', { class: 'lq-title' }, g.patientName),
                h('div', { class: 'lq-sub' },
                    g.patientMrn ? h('span', { class: 'chip' }, 'ID · ' + g.patientMrn) : null,
                    sexTxt ? h('span', { class: 'chip' }, sexTxt) : null,
                    ageTxt ? h('span', { class: 'chip' }, ageTxt) : null,
                    h('span', { class: 'chip' }, total + ' ' + pluralRu(total, 'анализ', 'анализа', 'анализов')),
                    critCount ? h('span', { class: 'chip', style: { background: 'var(--crit-50)', borderColor: '#fecaca', color: 'var(--crit-700)' } }, '⚠ ' + critCount + ' критич.') : null,
                ),
            ),
            h('div', { class: 'lw-acc' }, h('div', { class: 'k' }, 'Образец №'), h('div', { class: 'v' }, g.accession || '—')),
        ),
        h('div', { class: 'lq-actions' },
            h('div', { class: 'lq-prog' },
                h('div', { class: 'lq-bar' }, h('i', { style: { width: pct + '%', background: allDone ? 'var(--ok-500)' : 'var(--primary-500)' } })),
                h('span', { class: 'lq-prog-txt' }, done + ' / ' + total + ' готово' + (awaiting ? ' · ' + awaiting + ' к забору' : '')),
            ),
            h('span', { style: { flex: 1 } }),
            anyActive ? h('button', {
                class: 'btn btn-primary btn-sm', type: 'button', title: 'Внести результаты всех анализов одним документом',
                onclick: () => openPatientWorksheet(g, patient),
            }, Icon('Flask', { size: 13 }), ' Внести результаты') : null,
            anyActive ? h('button', {
                class: 'btn btn-outline btn-sm', type: 'button', title: 'Печать штрих-кода образца',
                onclick: () => printLabel(rows[0], patient),
            }, Icon('Scan', { size: 13 }), ' Штрих-код') : null,
            anyToVerify ? h('button', {
                class: 'btn btn-success btn-sm', type: 'button', title: 'Подтвердить и выдать результаты',
                onclick: () => verifyGroup(g),
            }, Icon('Check', { size: 13 }), ' Подтвердить') : null,
            anyResulted ? h('button', {
                class: 'btn btn-outline btn-sm', type: 'button', title: 'Печать бланка: все анализы образца',
                // LAB_BLANK_ALL_PANELS_V1 — печатаем ВЕСЬ образец, а не одну строку.
                // Прежний код брал `rows.find(есть результаты)` и печатал ТОЛЬКО её:
                // из пяти анализов на бланк попадал один.
                onclick: () => printGroupReport(rows, patient),
            }, Icon('Print', { size: 13 }), ' Бланк') : null,
        ),
        h('div', { class: 'lq-list' }, ...rows.map(r => lqItem(r, patient))),
    );
}

function worstFlagTag(results) {
    const order = ['critical', 'abnormal', 'high', 'low', 'normal'];
    for (const f of order) {
        if (results.some(x => x.flag === f)) return flagTag(f);
    }
    return null;
}

function iconBtn(icon, title, onclick) {
    return h('button', {
        type: 'button', title, onclick,
        style: {
            width: '30px', height: '30px', borderRadius: '8px', cursor: 'pointer',
            border: '1px solid var(--ink-200)', background: 'var(--white, #fff)',
            color: 'var(--ink-600)', display: 'inline-grid', placeItems: 'center',
        },
    }, Icon(icon, { size: 13 }));
}

function actionButtons(r, patient, results) {
    const btns = [];
    const primary = (label, icon, onclick) => h('button', {
        class: 'btn btn-primary btn-sm', type: 'button', onclick,
    }, Icon(icon, { size: 13 }), ' ' + label);

    if (r.status === 'queued') {
        btns.push(primary('Забор пробы', 'Flask', () => collectDialog(r, patient)));
    } else if (r.status === 'collected') {
        btns.push(primary('В работу', 'Activity', () => advance(r, { status: 'in_progress' }, 'Проба в работе')));
    } else if (r.status === 'in_progress') {
        btns.push(primary('Результаты…', 'Edit', () => openResultsModal(r, patient)));
    } else if (r.status === 'resulted') {
        btns.push(primary('Проверить и выдать', 'Check', () => verifyDialog(r, patient, results)));
        btns.push(iconBtn('Edit', 'Изменить результаты', () => openResultsModal(r, patient)));
    } else if (r.status === 'completed') {
        btns.push(h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: () => printReport(r, patient, results) },
            Icon('Print', { size: 13 }), ' Отчёт'));
    }
    // label reprint once a sample exists (or is about to be taken)
    if (r.status !== 'added' && r.status !== 'queued') {
        btns.push(iconBtn('Scan', 'Печать этикетки', () => printLabel(r, patient)));
    }
    return btns;
}

async function advance(r, values, okMsg) {
    const { error } = await supabase.from('visit_services').update(values).eq('id', r.id);
    if (error) { toast(error.message || 'Не удалось обновить статус.', 'fail'); return false; }
    if (okMsg) toast(okMsg, 'ok');
    await fetchAndPaint();
    return true;
}

function printLabel(r, patient) {
    printBarcodeLabel({
        code: accession(r),
        patientName: patient.full_name || '',
        mrn: patient.mrn || '',
        dateStr: (r.sample_collected_at || nowIso()).slice(0, 16).replace('T', ' '),
    });
}

// -----------------------------------------------------------------------------
// LAB_GROUP_V1 (local port) — «Подтвердить»: verify + hand off every RESULTED
// (not yet completed) analysis of this patient-visit in one action. Mirrors
// verifyDialog's write (stamp verified_by/verified_at on every lab_results
// row of the panel, then flip its visit_services.status to 'completed'), just
// looped over every resulted panel in the group instead of one order.
//
// Gate: only rows with status === 'resulted' are touched — a row reaches
// 'resulted' ONLY via a successful save in openResultsModal / the worksheet,
// which both refuse to save with zero filled-in results. So this can never
// verify an order that has no results entered — the per-panel `if
// (!results.length) continue;` below is a redundant safety belt, not the
// actual gate.
// -----------------------------------------------------------------------------
async function verifyGroup(g) {
    const panels = g.rows.filter(r => r.status === 'resulted');
    if (!panels.length) { toast('Нет результатов для подтверждения.', 'fail'); return; }

    const allResults = [];
    for (const p of panels) allResults.push(...(state.resultsByVs[p.id] || []));
    const critical = allResults.filter(x => x.flag === 'critical');

    let prompt = `Подтвердить и выдать ${panels.length} ${pluralRu(panels.length, 'анализ', 'анализа', 'анализов')} для ${g.patientName}?\n\n`;
    if (critical.length) {
        prompt += `⚠ КРИТИЧЕСКИХ значений: ${critical.length}\n`;
        for (const x of critical.slice(0, 8)) prompt += `   • ${x.parameter}: ${x.value}${x.unit ? ' ' + x.unit : ''}\n`;
        prompt += `\nСообщите врачу ПЕРЕД подтверждением.\n\n`;
    }
    prompt += 'Это финально — результаты отправляются врачу. Продолжить?';
    if (!confirm(prompt)) return;

    try {
        const u = currentUser();
        const stamp = nowIso();
        for (const p of panels) {
            const results = state.resultsByVs[p.id] || [];
            if (!results.length) continue;
            for (const x of results) {
                const { error } = await supabase.from('lab_results')
                    .update({ verified_by: u.id || null, verified_at: stamp }).eq('id', x.id).select().single();
                if (error) throw error;
            }
            const { error: stErr } = await supabase.from('visit_services')
                .update({ status: 'completed', verified_by: u.id || null, verified_at: stamp }).eq('id', p.id);
            if (stErr) throw stErr;
        }
        toast(critical.length
            ? `Подтверждено — ${critical.length} критич. значений отмечено для врача.`
            : 'Подтверждено и выдано.', 'ok');
        await fetchAndPaint();
    } catch (e) {
        toast('Не удалось подтвердить: ' + (e && e.message || e), 'fail');
    }
}

// -----------------------------------------------------------------------------
// Modal chrome (local pattern — .modal / .modal-card, no shared helper in ui.js)
// -----------------------------------------------------------------------------
function labModal(title, subtitle, bodyEls, footEls, width = 520) {
    const overlay = h('div', { class: 'modal' });
    const close = () => overlay.remove();
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));
    overlay.appendChild(h('div', { class: 'modal-card modal-compact', style: { width: width + 'px', maxWidth: 'calc(100vw - 32px)' } },
        h('header', { class: 'modal-head' },
            h('div', null,
                h('h2', null, Icon('Flask', { size: 16 }), ' ', title),
                subtitle ? h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '2px' } }, subtitle) : null,
            ),
            h('button', { class: 'modal-close', onclick: close }, '×')),
        h('div', { class: 'modal-body' }, ...bodyEls),
        h('footer', { class: 'modal-foot' },
            h('button', { class: 'btn', type: 'button', onclick: close }, 'Отмена'),
            h('span', { class: 'grow' }),
            ...footEls),
    ));
    document.body.appendChild(overlay);
    return { close };
}

// -----------------------------------------------------------------------------
// «Забор пробы»
// -----------------------------------------------------------------------------
function collectDialog(r, patient) {
    const svc = r.services || {};
    const printCb = h('input', { type: 'checkbox', checked: true });
    const okBtn = h('button', { class: 'btn btn-primary', type: 'button' }, 'Проба взята');
    const m = labModal('Забор пробы · ' + accession(r),
        (patient.full_name || '—') + ' · ' + (svc.name || ''),
        [
            h('div', { class: 'row', style: { gap: '10px', marginBottom: '10px', alignItems: 'center' } },
                tubePill(svc.tube_color),
                svc.specimen ? h('span', { class: 'muted', style: { fontSize: '12.5px' } }, svc.specimen) : null,
            ),
            h('label', { style: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12.5px', color: 'var(--ink-700)', cursor: 'pointer' } },
                printCb, 'Распечатать этикетку со штрих-кодом'),
        ],
        [okBtn]);
    okBtn.addEventListener('click', async () => {
        okBtn.disabled = true;
        const stamp = nowIso();
        const ok = await advance(r, { status: 'collected', sample_collected_at: stamp }, 'Проба взята — ' + accession(r));
        if (!ok) { okBtn.disabled = false; return; }
        m.close();
        if (printCb.checked) {
            printBarcodeLabel({
                code: accession(r),
                patientName: patient.full_name || '',
                mrn: patient.mrn || '',
                dateStr: stamp.slice(0, 16).replace('T', ' '),
            });
        }
    });
}

// -----------------------------------------------------------------------------
// Results entry — panel-driven, sex-specific ranges, auto flags
// -----------------------------------------------------------------------------
function refFor(analyte, gender) {
    let low = analyte.ref_low, high = analyte.ref_high;
    if (gender === 'male' && (analyte.ref_low_m != null || analyte.ref_high_m != null)) {
        low = analyte.ref_low_m; high = analyte.ref_high_m;
    } else if (gender === 'female' && (analyte.ref_low_f != null || analyte.ref_high_f != null)) {
        low = analyte.ref_low_f; high = analyte.ref_high_f;
    }
    let text = '';
    if (low != null && high != null) text = `${low}–${high}`;
    else if (low != null) text = `≥ ${low}`;
    else if (high != null) text = `≤ ${high}`;
    else if (analyte.ref_text) text = analyte.ref_text;
    return { low, high, text };
}

function autoFlag(n, low, high) {
    if (!Number.isFinite(n)) return null;
    if (low != null && n < low) return 'low';
    if (high != null && n > high) return 'high';
    if (low == null && high == null) return null;   // no configured range → no flag, never guess «Норма»
    return 'normal';
}

// ageYears переехал в lab-doc.js (LAB_NAMED_RANGES_SHARED_V1) — им пользуется
// и карта пациента, а две копии возраста расходятся первыми.

// LAB_MULTI_REF_V1 — named ranges (cycle phases, pregnancy trimesters, age
// bands) live as JSON on lab_panel_analytes.ref_ranges. THIS reader discards
// label-only slots: they exist so the settings editor (normRanges in
// lab-settings.js, which KEEPS them) can show named rows with blank number
// boxes for the clinic to complete. The two readers are deliberately
// different — do NOT unify them (design doc 2026-08-08, «Why labelled empty
// slots work»): filter in settings and the seeded phases vanish before anyone
// can fill them; stop filtering here and empty phase labels print on reports.
function normRefRanges(raw) {
    let list = raw;
    if (typeof raw === 'string') {
        try { list = JSON.parse(raw || '[]'); } catch (e) { return []; }
    }
    if (!Array.isArray(list)) return [];
    return list.filter(x => x && (x.low != null || x.high != null || String(x.text || '').trim() !== ''));
}

// Sex/age-matched named ranges for display. SAFETY RULE (carried verbatim
// from the server implementation): a matched range only MARKS the likely row
// on screens and printouts — it must NEVER auto-flag a result, because the
// app cannot know cycle phase or pregnancy status. A hormone flagged «high»
// against the wrong phase is a misleading report.
function matchedNamedRanges(analyte, gender, age) {
    return normRefRanges(analyte.ref_ranges).filter(r =>
        (!r.sex || r.sex === gender) &&
        (r.age_min == null || (age != null && age >= r.age_min)) &&
        (r.age_max == null || (age != null && age <= r.age_max)));
}

function fmtNamedRange(r) {
    let v = '';
    if (r.low != null && r.high != null) v = `${r.low}–${r.high}`;
    else if (r.low != null) v = `≥ ${r.low}`;
    else if (r.high != null) v = `≤ ${r.high}`;
    else v = String(r.text || '').trim();
    return (r.label ? r.label + ': ' : '') + v;
}

// -----------------------------------------------------------------------------
// LAB_GROUP_V1 (local port) — analyte resolution + result persistence,
// factored out of the single-order modal so the combined worksheet can reuse
// them instead of a second implementation (per the port's local-differences
// note: results are keyed by lab_results.parameter — the analyte NAME, not an
// analyte id — and the NOT-NULL flag/notes rule below only has to be right in
// one place).
// -----------------------------------------------------------------------------

// Which analytes does this order need (from its panel, or the single-value
// fallback), sex/age-resolved reference ranges, and any already-saved
// lab_results overlaid by matching on PARAMETER NAME. Shared by
// openResultsModal and the worksheet — the one place that knows how to read
// an order's results.
// LAB_SVC_ANALYTE_FALLBACK_V1 — единицы и норма для услуги БЕЗ панели.
//
// «Д-димер» продаётся отдельной строкой прайса, панели у неё нет, а
// services.result_unit/ref_low/ref_high в базе пустые — поэтому в бланке
// колонки «Ед.» и «Норма» оставались пустыми. При этом сама клиника эти
// значения давно знает: показатель «Д-димер» лежит в справочнике
// (lab_analyte_templates, ng/ml) и внутри панели КОАГУЛОГРАММА (0–500).
// Знание было в системе — до бланка оно просто не доходило.
//
// Порядок источников: настройка услуги → справочник показателей → одноимённый
// показатель любой панели. Явно заданное на услуге всегда сильнее найденного
// по имени: если лаборатория переопределила норму для своей услуги, догадка
// не имеет права её перебить.
const _dictCache = new Map();

async function analyteDictLookup(name) {
    const key = String(name || '').trim().toLowerCase();
    if (!key) return null;
    if (_dictCache.has(key)) return _dictCache.get(key);

    let tpl = null, fromPanel = null;
    try {
        const { data } = await supabase.from('lab_analyte_templates')
            .select('*').ilike('name', name).limit(1);
        tpl = (data || [])[0] || null;
    } catch (e) { /* справочник недоступен — просто не подскажем */ }
    try {
        const { data } = await supabase.from('lab_panel_analytes')
            .select('*').ilike('name', name).limit(5);
        // Берём первый показатель, у которого ВООБЩЕ есть норма: одноимённые
        // строки могут лежать в нескольких панелях, и пустая из них бесполезна.
        fromPanel = (data || []).find(x => x.ref_low != null || x.ref_high != null || x.ref_text) || (data || [])[0] || null;
    } catch (e) { /* см. выше */ }

    const found = (tpl || fromPanel)
        ? {
            unit: (tpl && tpl.unit) || (fromPanel && fromPanel.unit) || '',
            value_type: (tpl && tpl.value_type) || (fromPanel && fromPanel.value_type) || 'numeric',
            value_options: (tpl && tpl.value_options) || (fromPanel && fromPanel.value_options) || null,
            decimals: (tpl && tpl.decimals != null) ? tpl.decimals : (fromPanel ? fromPanel.decimals : null),
            // Числовые границы живут ТОЛЬКО на показателях панелей — в
            // справочнике шаблонов таких колонок нет.
            ref_low: fromPanel ? fromPanel.ref_low : null,
            ref_high: fromPanel ? fromPanel.ref_high : null,
            ref_text: fromPanel ? fromPanel.ref_text : null,
            ref_low_m: fromPanel ? fromPanel.ref_low_m : null,
            ref_high_m: fromPanel ? fromPanel.ref_high_m : null,
            ref_low_f: fromPanel ? fromPanel.ref_low_f : null,
            ref_high_f: fromPanel ? fromPanel.ref_high_f : null,
        }
        : null;
    _dictCache.set(key, found);
    return found;
}

async function resolveAnalyteRows(r, patient) {
    const svc = r.services || {};
    const panel = state.panelByService[r.service_id] || null;
    const existing = state.resultsByVs[r.id] || [];
    const byParam = new Map(existing.map(x => [x.parameter, x]));
    const gender = (patient.gender || '').toLowerCase();
    const age = ageYears(patient.date_of_birth);

    let analytes = [];
    if (panel) {
        const { data } = await supabase.from('lab_panel_analytes')
            .select('*').eq('panel_id', panel.id).order('sort_order').limit(200);
        analytes = (data || []).filter(a => a.active !== 0);
    }
    if (!analytes.length) {
        // LAB_SVC_ANALYTE_FALLBACK_V1 — у услуги нет панели: собираем показатель
        // сами и недостающие единицы/норму берём из справочника по имени.
        const dict = await analyteDictLookup(svc.name);
        const pick = (own, found) => (own != null && own !== '' ? own : (found != null ? found : null));
        analytes = [{
            code: svc.name, name: svc.name || 'Результат',
            unit: pick(svc.result_unit, dict && dict.unit) || '',
            value_type: (dict && dict.value_type) || 'numeric',
            value_options: dict ? dict.value_options : null,
            decimals: (dict && dict.decimals != null) ? dict.decimals : 2,
            ref_low: pick(svc.ref_low, dict && dict.ref_low),
            ref_high: pick(svc.ref_high, dict && dict.ref_high),
            ref_text: pick(svc.ref_text, dict && dict.ref_text),
            ref_low_m: dict ? dict.ref_low_m : null, ref_high_m: dict ? dict.ref_high_m : null,
            ref_low_f: dict ? dict.ref_low_f : null, ref_high_f: dict ? dict.ref_high_f : null,
        }];
    }
    return analytes.map(a => {
        const ref = refFor(a, gender);
        const prev = byParam.get(a.name) || byParam.get(a.code) || null;
        const named = matchedNamedRanges(a, gender, age);
        return { a, ref, prev, named, seeded: true };
    });
}

// A blank ad-hoc row for the worksheet's "Добавить свой показатель" — not
// seeded from a panel, so its name/unit/reference are freeform text.
function blankAnalyteEntry() {
    return { a: { name: '', unit: '', value_type: 'numeric' }, ref: { low: null, high: null, text: '' }, prev: null, named: [], seeded: false, flag: 'normal' };
}

// THE write path for lab_results. LAB_SAVE_BATCH_V1 — ОДИН вызов на всю
// панель вместо запроса на каждый показатель.
//
// Раньше здесь стоял цикл с await на каждой строке: общий анализ крови из 28
// показателей давал 29 последовательных обращений к серверу. По сети клиники
// (RTT 15–40 мс) это 0.4–1.2 секунды ожидания там, где сама запись в базу
// занимает 0.06 мс на строку — отсюда и ощущение «подвисает, будто сервер не
// локальный». И главное: обрыв связи посередине оставлял панель наполовину
// записанной.
//
// Сервер (rpc/lab.js) пишет все строки и статус услуги в одной транзакции —
// либо сохраняется весь бланк, либо ничего. Правила flag/notes NOT NULL и
// привязка правки к своей услуге теперь тоже там, в одном месте.
async function saveAnalyteRows(order, rows, notes) {
    const { error } = await supabase.rpc('save_lab_results', {
        visit_service_id: order.id,
        notes: notes || '',
        rows: rows.map((row) => ({
            id: row.prevId || null,
            parameter: row.parameter,
            value: row.value,
            numeric_value: row.numericValue != null ? row.numericValue : null,
            unit: row.unit || null,
            reference_range: row.referenceRange || null,
            ref_low: row.refLow != null ? row.refLow : null,
            ref_high: row.refHigh != null ? row.refHigh : null,
            flag: row.flag || 'normal',
        })),
    });
    if (error) throw new Error(error.message || error);
}

async function openResultsModal(r, patient) {
    const svc = r.services || {};
    const panel = state.panelByService[r.service_id] || null;
    const existing = state.resultsByVs[r.id] || [];
    const gender = (patient.gender || '').toLowerCase();
    const resolved = await resolveAnalyteRows(r, patient);

    // One row of controls per analyte.
    const lines = resolved.map(({ a, ref, prev, named }) => {
        let input;
        if (a.value_type === 'select') {
            const opts = selectOptionsFor(a, prev);
            input = h('select', { style: { width: '100%' } },
                h('option', { value: '' }, '—'),
                ...opts.map(o => h('option', { value: o, selected: prev && prev.value === o }, o)));
        } else if (a.value_type === 'text') {
            input = h('input', { type: 'text', value: prev ? (prev.value || '') : '', style: { width: '100%' } });
        } else {
            input = h('input', {
                type: 'number', step: a.decimals ? String(1 / Math.pow(10, a.decimals)) : '1',
                value: prev ? (prev.value || '') : '', style: { width: '100%' },
            });
        }
        const flagEl = h('span', null, prev ? flagTag(prev.flag) : h('span', { class: 'muted' }, '—'));
        const recompute = () => {
            if (a.value_type !== 'numeric' && a.value_type !== '') return;
            const n = parseFloat(input.value);
            // Flags come from the clinic's own base/sex ranges ONLY — a matched
            // named range (phase/pregnancy) never flags (safety rule).
            const f = autoFlag(n, ref.low, ref.high);
            clear(flagEl);
            flagEl.appendChild(input.value.trim() === '' ? h('span', { class: 'muted' }, '—') : flagTag(f));
        };
        input.addEventListener('input', recompute);
        return { a, ref, prev, input, flagEl, named };
    });

    const grid = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px' } },
        h('div', { class: 'row', style: { gap: '10px', padding: '4px 0', fontSize: '10.5px', fontWeight: 800, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--ink-500)' } },
            h('span', { style: { flex: '1 1 40%' } }, 'Показатель'),
            h('span', { style: { flex: '0 0 110px' } }, 'Значение'),
            h('span', { style: { flex: '0 0 70px' } }, 'Ед.'),
            h('span', { style: { flex: '0 0 90px' } }, 'Референс'),
            h('span', { style: { flex: '0 0 86px' } }, 'Флаг'),
        ),
        ...lines.map(L => h('div', { style: { borderTop: '1px solid var(--ink-50)' } },
            h('div', { class: 'row', style: { gap: '10px', padding: L.named.length ? '7px 0 2px' : '7px 0', alignItems: 'center' } },
                h('span', { style: { flex: '1 1 40%', fontSize: '12.5px', fontWeight: 600, color: 'var(--ink-900)', minWidth: 0 } }, L.a.name || L.a.code || '—'),
                h('span', { style: { flex: '0 0 110px' } }, L.input),
                h('span', { class: 'muted', style: { flex: '0 0 70px', fontSize: '12px' } }, L.a.unit || ''),
                h('span', { class: 'muted num', style: { flex: '0 0 90px', fontSize: '12px' } }, L.ref.text || '—'),
                h('span', { style: { flex: '0 0 86px' } }, L.flagEl),
            ),
            // Named ranges (phase / pregnancy / age band) matched by sex+age —
            // shown as hints only, never fed into the flag (safety rule).
            L.named.length ? h('div', { class: 'muted', style: { fontSize: '10.5px', padding: '0 0 7px', lineHeight: 1.5 } },
                '▸ ' + L.named.map(fmtNamedRange).join(' · ')) : null,
        )),
    );

    const notesTa = h('textarea', { rows: '2', placeholder: 'Комментарий лаборатории (необязательно)' });
    const prevNote = existing.find(x => x.notes);
    if (prevNote) notesTa.value = prevNote.notes || '';

    const saveBtn = h('button', { class: 'btn btn-primary', type: 'button' }, 'Сохранить результаты');
    const m = labModal(
        (panel ? panel.name : (svc.name || 'Результаты')) + ' · ' + accession(r),
        (patient.full_name || '—') + (patient.mrn ? ' · ' + patient.mrn : '') + (gender ? ' · ' + (gender === 'male' ? 'муж' : gender === 'female' ? 'жен' : gender) : ''),
        [grid, field('Комментарий', notesTa)],
        [saveBtn], 640);

    saveBtn.addEventListener('click', async () => {
        const filled = lines.filter(L => String(L.input.value || '').trim() !== '');
        if (!filled.length) { toast('Внесите хотя бы один показатель.', 'fail'); return; }
        saveBtn.disabled = true;
        saveBtn.textContent = 'Сохраняем…';
        try {
            const rows = filled.map(L => {
                const raw = String(L.input.value).trim();
                const n = parseFloat(raw);
                const isNum = (L.a.value_type || 'numeric') === 'numeric' && Number.isFinite(n);
                return {
                    parameter: L.a.name || L.a.code || 'Результат',
                    value: raw,
                    numericValue: isNum ? n : null,
                    unit: L.a.unit || null,
                    referenceRange: L.ref.text || null,
                    refLow: L.ref.low,
                    refHigh: L.ref.high,
                    // Flag only when the clinic configured a range; named
                    // (phase/age) ranges NEVER flag — safety rule.
                    flag: (isNum ? autoFlag(n, L.ref.low, L.ref.high) : null) || 'normal',
                    prevId: L.prev ? L.prev.id : null,
                };
            });
            await saveAnalyteRows(r, rows, notesTa.value.trim());
            toast('Результаты сохранены — на проверку', 'ok');
            m.close();
            await fetchAndPaint();
        } catch (e) {
            toast('Не удалось сохранить: ' + (e && e.message || e), 'fail');
            saveBtn.disabled = false;
            saveBtn.textContent = 'Сохранить результаты';
        }
    });
}

// -----------------------------------------------------------------------------
// LAB_WORKSHEET_V1 (local port) — one worksheet for the whole patient-visit:
// every analysis as a section, results for all of them entered and saved in
// one action. Ported from the server's openPatientWorksheet / wsSection /
// easyRow, routed through resolveAnalyteRows + saveAnalyteRows above (the
// SAME data/save path openResultsModal uses) rather than a second implementation.
// -----------------------------------------------------------------------------

// Collect a single sample from inside the worksheet — keeps the same status
// transition collectDialog uses (local's state machine needs the explicit
// 'collected' status write; sample_collected_at alone isn't enough locally).
async function wsCollect(p, repaint) {
    const stamp = nowIso();
    const ok = await advance(p, { status: 'collected', sample_collected_at: stamp }, 'Проба собрана.');
    if (!ok) return;
    p.status = 'collected';
    p.sample_collected_at = stamp;
    repaint();
}

function wsRowPayload(e) {
    const raw = String((e.input && e.input.value) || '').trim();
    const n = parseFloat(raw.replace(',', '.'));
    const isNum = (e.a.value_type || 'numeric') === 'numeric' && Number.isFinite(n);
    return {
        parameter: e.a.name || e.a.code || 'Результат',
        value: raw,
        numericValue: isNum ? n : null,
        unit: e.a.unit || null,
        referenceRange: e.ref.text || null,
        refLow: e.ref.low,
        refHigh: e.ref.high,
        flag: e.flag || 'normal',
        prevId: e.prev ? e.prev.id : null,
    };
}

// LAB_ENTRY_V2 (local port) — one clean form line: parameter is a label when
// seeded from the clinic panel (the tech only types the value); an ad-hoc row
// is fully editable. The flag select auto-suggests from the value + range
// (same as openResultsModal's recompute) but a manual pick of
// abnormal/critical is never silently downgraded by further typing — same
// safety rule as the server's easyRow/maybeAutoFlag.
function wsAnalyteLine(e, onRemove) {
    const flagSel = h('select', {
        class: 'le-flag',
        onchange: (ev) => { e.flag = ev.target.value; applyFlag(); },
    },
        h('option', { value: 'normal' }, '🟢 Норма'),
        h('option', { value: 'high' }, '🟡 Высокий'),
        h('option', { value: 'low' }, '🟡 Низкий'),
        h('option', { value: 'abnormal' }, '🟠 Отклон.'),
        h('option', { value: 'critical' }, '🔴 Критич.'),
    );

    // LAB_SELECT_OPTIONS_V1 — the value control follows the analyte's value_type,
    // exactly like openResultsModal: «список» must be a dropdown of the clinic's
    // own answers (Прозрачная / Мутная, Rh+ / Rh-), not a free-text box. Typed
    // free text for a coded answer is a data-quality problem on the printed
    // report, so this branch is not cosmetic.
    const savedVal = e.prev ? (e.prev.value || '') : '';
    const valInp = e.a.value_type === 'select'
        ? h('select', {
            class: 'le-val le-val-sel',
            // 'change' rather than 'input': the flag hook only reacts to numbers
            // anyway, but a select's committed value is what the payload reads.
            onchange: () => maybeAutoFlag(),
        },
            h('option', { value: '' }, '—'),
            ...selectOptionsFor(e.a, e.prev).map(o => h('option', { value: o, selected: savedVal === o }, o)))
        : h('input', {
            class: 'le-val', type: 'text',
            inputmode: (e.a.value_type === 'text' ? 'text' : 'decimal'),
            value: savedVal, placeholder: '—',
            oninput: () => maybeAutoFlag(),
        });

    function maybeAutoFlag() {
        if (e.flag === 'critical' || e.flag === 'abnormal') return;
        const raw = String(valInp.value || '').trim().replace(',', '.');
        const n = parseFloat(raw);
        if (!Number.isFinite(n)) return;
        const f = autoFlag(n, e.ref.low, e.ref.high);
        if (f) { e.flag = f; flagSel.value = f; applyFlag(); }
    }

    const nameEl = e.seeded
        ? h('span', { class: 'le-name' }, e.a.name || e.a.code || '—')
        : h('input', { class: 'le-inp-sm', value: e.a.name || '', placeholder: 'Показатель',
            oninput: (ev) => { e.a.name = ev.target.value; } });
    // LAB_FILL_EMPTY_UNIT_V1 — известные единицы и норму показываем текстом
    // (их незачем править и опасно задеть случайно), а ПУСТЫЕ отдаём полем
    // ввода. Иначе лаборант видит дыру в бланке и ничего не может с ней
    // сделать: заполнить можно только в настройках, то есть не сейчас и не
    // здесь. Введённое сохраняется в самом результате (lab_results.unit /
    // reference_range) и попадает в печатный бланк.
    const unitEl = (e.seeded && e.a.unit)
        ? h('span', { class: 'le-unit' }, e.a.unit)
        : h('input', { class: 'le-inp-sm', tabindex: '-1', value: e.a.unit || '', placeholder: 'ед.',
            oninput: (ev) => { e.a.unit = ev.target.value; } });
    const refEl = (e.seeded && e.ref.text)
        ? h('span', { class: 'le-ref' }, e.ref.text)
        : h('input', { class: 'le-inp-sm', tabindex: '-1', value: e.ref.text || '', placeholder: 'норма',
            oninput: (ev) => { e.ref.text = ev.target.value; } });

    const row = h('div', { class: 'le-row' },
        nameEl, valInp, unitEl, refEl, flagSel,
        // LAB_TAB_NEXT_VALUE_V1 — кнопка удаления вне обхода Tab: действие
        // разрушительное, и попадать в него вслепую при быстром вводе нельзя.
        // Мышью доступна как прежде.
        canDelete('labs')
            ? h('button', { class: 'lw-del', type: 'button', tabindex: '-1', title: 'Удалить показатель', onclick: onRemove }, Icon('Trash', { size: 12 }))
            : h('span'),
    );
    function applyFlag() {
        const f = e.flag || 'normal';
        row.className = 'le-row' + (f === 'critical' ? ' crit' : f === 'normal' ? '' : ' out');
        flagSel.className = 'le-flag ' + (f === 'critical' ? 'flag-crit' : f === 'normal' ? 'flag-normal' : 'flag-high');
        if (flagSel.value !== (e.flag || 'normal')) flagSel.value = e.flag || 'normal';
    }
    e.flag = e.flag || (e.prev ? (e.prev.flag || 'normal') : 'normal');
    applyFlag();
    e.input = valInp;
    return row;
}

// One analysis = one section in the worksheet.
function wsSection(section) {
    const p = section.panel;
    const svc = p.services || {};
    const listEl = h('div', { class: 'le-list' });
    function renderRows() {
        clear(listEl);
        section.entries.forEach((e, i) => listEl.appendChild(wsAnalyteLine(e, () => { section.entries.splice(i, 1); renderRows(); })));
    }
    renderRows();

    const interpEl = h('textarea', { rows: '2', placeholder: 'Заключение по этой панели (необязательно)' });
    section.interpEl = interpEl;

    const st = ST[p.status] || { label: p.status || '—', kind: '' };
    const collectSlot = h('span');
    function paintCollect() {
        clear(collectSlot);
        if (p.status === 'added') {
            collectSlot.appendChild(h('span', { class: 'muted', style: { fontSize: '11.5px' } }, 'Ожидает кассу'));
        } else if (!p.sample_collected_at) {
            collectSlot.appendChild(h('button', {
                class: 'btn btn-primary btn-sm', type: 'button',
                onclick: () => wsCollect(p, paintCollect),
            }, Icon('Flask', { size: 13 }), ' Собрать образец'));
        } else {
            collectSlot.appendChild(h('span', { class: 'tag tag-ok', style: { fontSize: '11px' } }, 'Проба собрана'));
        }
    }
    paintCollect();

    return h('div', { class: 'lw-sec' },
        h('div', { class: 'lw-sec-head' },
            tubePill(svc.tube_color),
            h('div', { class: 'lw-sec-title' }, svc.name || '—'),
            Tag(st.label, { kind: st.kind, dot: true }),
            h('span', { style: { flex: 1 } }),
            collectSlot,
        ),
        h('div', { class: 'lw-sec-body' },
            h('div', { class: 'le-head' },
                h('span', null, 'Показатель'), h('span', { style: { textAlign: 'center' } }, 'Значение'),
                h('span', null, 'Ед.'), h('span', null, 'Норма'), h('span', { style: { textAlign: 'center' } }, 'Флаг'), h('span', null, ''),
            ),
            listEl,
            h('button', {
                class: 'lw-add', type: 'button',
                onclick: () => { section.entries.push(blankAnalyteEntry()); renderRows(); },
            }, Icon('Plus', { size: 13 }), ' Добавить свой показатель'),
            h('div', { class: 'lw-concl' }, h('label', null, 'Заключение по панели'), interpEl),
        ),
    );
}

async function openPatientWorksheet(g, patient) {
    const panels = g.rows;
    if (!panels.length) { toast('Нет анализов для этого пациента.', 'warn'); return; }

    const sections = [];
    for (const p of panels) {
        const entries = await resolveAnalyteRows(p, patient);
        sections.push({ panel: p, entries, interpEl: null });
    }

    const overlay = h('div', { class: 'modal' });
    const close = () => overlay.remove();
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));

    const body = h('div', { class: 'modal-body' });
    body.appendChild(h('div', { class: 'lw-patient' },
        h('div', { class: 'avatar ' + avColor(g.patientId || g.patientMrn || g.patientName) }, initials(g.patientName)),
        h('div', { style: { flex: 1, minWidth: '180px' } },
            h('div', { class: 'nm' }, g.patientName),
            h('div', { class: 'lw-meta' },
                ...[
                    g.patientMrn ? 'ID · ' + g.patientMrn : '',
                    g.patientSex === 'male' ? 'М' : g.patientSex === 'female' ? 'Ж' : '',
                    panels.length + ' ' + pluralRu(panels.length, 'анализ', 'анализа', 'анализов'),
                ].filter(Boolean).map(t => h('span', { class: 'chip' }, t))),
        ),
        h('div', { class: 'lw-acc' }, h('div', { class: 'k' }, 'Образец №'), h('div', { class: 'v' }, g.accession || '—')),
    ));

    for (const section of sections) body.appendChild(wsSection(section));

    // LAB_TAB_NEXT_VALUE_V1 — Tab ведёт к СЛЕДУЮЩЕМУ ПОКАЗАТЕЛЮ, а не к соседнему
    // контролу той же строки. В строке порядок DOM такой: значение → флаг →
    // «удалить», поэтому обычный Tab после каждого значения заходил в выпадающий
    // список флага и в кнопку удаления: чтобы внести 28 показателей ОАК, лаборант
    // жал Tab 84 раза и трижды рисковал попасть в «Удалить».
    // Флаг подставляется автоматически (maybeAutoFlag), править его нужно редко —
    // он остаётся доступен мышью, а Tab из него тоже уходит на следующее значение.
    // Обработчик делегирован на контейнер: строки перерисовываются (renderRows),
    // и вешать слушатель на каждое поле пришлось бы заново после каждой правки.
    // Enter / стрелки вниз-вверх работают как в таблице — привычно для ввода серии.
    body.addEventListener('keydown', (ev) => {
        const inField = ev.target && ev.target.closest && ev.target.closest('.le-val, .le-flag');
        if (!inField) return;
        const isTab = ev.key === 'Tab';
        // Enter в <select> открывает список — там его не перехватываем.
        const isEnter = ev.key === 'Enter' && ev.target.tagName !== 'SELECT';
        const isDown = ev.key === 'ArrowDown' && ev.target.tagName !== 'SELECT';
        const isUp = ev.key === 'ArrowUp' && ev.target.tagName !== 'SELECT';
        if (!isTab && !isEnter && !isDown && !isUp) return;

        const fields = [...body.querySelectorAll('.le-val')];
        if (fields.length < 2) return;
        // Из флага возвращаемся к значению его же строки, чтобы шаг был предсказуем.
        const origin = ev.target.classList.contains('le-flag')
            ? ev.target.closest('.le-row').querySelector('.le-val')
            : ev.target;
        const i = fields.indexOf(origin);
        if (i < 0) return;

        const back = isUp || (isTab && ev.shiftKey);
        const next = fields[back ? i - 1 : i + 1];
        // На краях списка не мешаем: Tab уходит из таблицы в кнопки формы.
        if (!next) return;
        ev.preventDefault();
        next.focus();
        if (typeof next.select === 'function') next.select();   // сразу перезаписать значение
    });

    async function saveAll() {
        let saved = 0;
        try {
            for (const section of sections) {
                const rows = section.entries
                    .filter(e => String((e.input && e.input.value) || '').trim() !== '')
                    .map(wsRowPayload);
                if (!rows.length) continue;
                await saveAnalyteRows(section.panel, rows, section.interpEl ? section.interpEl.value.trim() : '');
                saved++;
            }
            if (!saved) { toast('Добавьте хотя бы один результат.', 'warn'); return; }
            toast('Результаты сохранены — на проверку', 'ok');
            close();
            await fetchAndPaint();
        } catch (e) {
            toast('Не удалось сохранить: ' + (e && e.message || e), 'fail');
        }
    }

    overlay.appendChild(h('div', { class: 'modal-card lw-modal', style: { width: '1040px', maxWidth: 'calc(100vw - 32px)' } },
        h('header', { class: 'modal-head' },
            h('h2', null, Icon('Flask', { size: 16 }), ' Лаборатория · ', g.patientName),
            h('button', { class: 'modal-close', onclick: close }, '×')),
        body,
        h('footer', { class: 'modal-foot' },
            h('button', { class: 'btn', type: 'button', onclick: close }, 'Закрыть'),
            h('span', { class: 'grow' }),
            h('button', {
                class: 'btn btn-primary', type: 'button',
                onclick: async (ev) => {
                    ev.currentTarget.disabled = true;
                    try { await saveAll(); }
                    finally { if (ev.currentTarget && ev.currentTarget.isConnected) ev.currentTarget.disabled = false; }
                },
            }, Icon('Check', { size: 14 }), ' Сохранить всё'),
        ),
    ));
    document.body.appendChild(overlay);
    // LAB_TAB_NEXT_VALUE_V1 — курсор сразу в первое поле значения: ввод серии
    // начинается с клавиатуры, без обязательного клика мышью.
    const first = body.querySelector('.le-val');
    if (first) { first.focus(); if (typeof first.select === 'function') first.select(); }
}

// -----------------------------------------------------------------------------
// «Проверить и выдать»
// -----------------------------------------------------------------------------
function verifyDialog(r, patient, results) {
    if (!results.length) { toast('Сначала внесите результаты.', 'fail'); return; }
    const printCb = h('input', { type: 'checkbox', checked: true });
    const okBtn = h('button', { class: 'btn btn-primary', type: 'button' }, 'Подтвердить и выдать');

    const rows = results.map(x => h('div', { class: 'row', style: { gap: '10px', padding: '6px 0', borderBottom: '1px solid var(--ink-50)', fontSize: '12.5px' } },
        h('span', { style: { flex: 1, fontWeight: 600 } }, x.parameter || '—'),
        h('span', { class: 'num' }, [x.value, x.unit].filter(Boolean).join(' ')),
        h('span', { class: 'muted num', style: { flex: '0 0 90px' } }, x.reference_range || '—'),
        h('span', { style: { flex: '0 0 86px' } }, flagTag(x.flag)),
    ));

    const m = labModal('Проверка · ' + accession(r),
        (patient.full_name || '—') + (patient.mrn ? ' · ' + patient.mrn : ''),
        [
            ...rows,
            h('label', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginTop: '12px', fontSize: '12.5px', color: 'var(--ink-700)', cursor: 'pointer' } },
                printCb, 'Распечатать бланк результатов'),
            h('div', { class: 'muted', style: { fontSize: '11.5px', marginTop: '6px' } },
                'После подтверждения результаты появятся в карте пациента (вкладка «Документы»).'),
        ],
        [okBtn], 600);

    okBtn.addEventListener('click', async () => {
        okBtn.disabled = true;
        okBtn.textContent = 'Подтверждаем…';
        try {
            const u = currentUser();
            const stamp = nowIso();
            for (const x of results) {
                const { error } = await supabase.from('lab_results')
                    .update({ verified_by: u.id || null, verified_at: stamp }).eq('id', x.id).select().single();
                if (error) throw error;
            }
            const { error: stErr } = await supabase.from('visit_services')
                .update({ status: 'completed', verified_by: u.id || null, verified_at: stamp }).eq('id', r.id);
            if (stErr) throw stErr;
            toast('Результаты выданы — ' + accession(r), 'ok');
            m.close();
            if (printCb.checked) printReport(r, patient, results, { verifiedAt: stamp, verifiedBy: u.full_name || u.username || '' });
            await fetchAndPaint();
        } catch (e) {
            toast('Не удалось подтвердить: ' + (e && e.message || e), 'fail');
            okBtn.disabled = false;
            okBtn.textContent = 'Подтвердить и выдать';
        }
    });
}

// -----------------------------------------------------------------------------
// LAB_BLANK_DESIGNED_V1 — бланк печатается ШАБЛОНОМ ИЗ «Настройки → Документы»
// -----------------------------------------------------------------------------
// Раньше здесь собиралась собственная таблица и уходила в printableSheet как
// type:'results'. Типа с таким именем в renderDesignedVariant нет, поэтому
// документ рисовался СТАРОЙ обёрткой .sheet — а она display:flex с
// overflow:hidden. Chrome не разбивает flex-контейнер на страницы и обрезает
// лишнее: бланк на несколько анализов печатался одной страницей с обрубленным
// низом, а расставленные по секциям break-inside:avoid не работали вовсе —
// внутри flex-контейнера они игнорируются.
//
// Шаблон из «Документов» (doc-variants.js → labClassic/labCompact) — обычный
// блочный лист с @page A4: страницы делятся правильно, панель не рвётся
// пополам, и бланк выглядит так же, как в предпросмотре настроек. Он же
// двуязычный (ru/uz) и умеет несколько панелей одним документом (d.groups),
// что и требовалось от «Бланка».

// Правила флага, позиции метки и формата дат живут в lab-doc.js: тот же бланк
// печатает карта пациента, и разойтись эти правила не должны.

// Коды показателей и именованные диапазоны берём из панели услуги. Совпавший
// по полу/возрасту диапазон только ПОМЕЧАЕТСЯ (шаблон подсветит строку,
// начинающуюся с '•') и никогда не меняет флаг — то же правило безопасности,
// что и в форме ввода.
// LAB_NAME_MATCH_V1 — показатель ищется по имени БЕЗ учёта регистра и пробелов.
//
// В панели показатель называется «ферритин», а в результат записано «Ферритин».
// Ключ Map был чувствителен к регистру, поэтому поиск промахивался, и бланк
// терял СРАЗУ ВСЁ, что берётся из аналита: единицу измерения, референс и
// именованные диапазоны. Внешне это выглядело как «норма не задана», хотя она
// задана — просто с большой буквы в одном месте и с маленькой в другом.
// nk переехал в lab-analyte-index.js — нормализация имени должна быть одна
// на все места, иначе поиск показателя снова начнёт расходиться.

// LAB_ANALYTE_INDEX_V1 — поиск показателя вынесен в lab-analyte-index.js и
// используется ещё и картой пациента. Здесь остаётся только то, что знает
// именно лаборатория: показатели ПАНЕЛИ этой услуги (они важнее общего
// справочника) и коды для колонки рядом с названием.
async function labPanelHints(r) {
    const codeByName = new Map();
    const local = new Map();
    // LAB_PANEL_IS_TRUTH_V1 — показатели панели нужны и СПИСКОМ, в порядке
    // sort_order: по нему сопоставляются результаты, когда имена разошлись.
    let panelList = [];
    const panel = state.panelByService[r.service_id];
    if (panel) {
        try {
            const { data } = await supabase.from('lab_panel_analytes')
                .select('*').eq('panel_id', panel.id).order('sort_order').limit(200);
            panelList = data || [];
            for (const a of panelList) {
                if (a.name && a.code) codeByName.set(nk(a.name), a.code);
                if (a.name) local.set(nk(a.name), a);
                if (a.code) local.set(nk(a.code), a);
            }
        } catch (e) { /* бланк печатается и без подсказок */ }
    }
    return { codeByName, local, panelList, idx: await analyteIndex() };
}

async function labGroupFor(r, patient, results) {
    const svc = r.services || {};
    const { codeByName, local, panelList, idx } = await labPanelHints(r);
    const gender = (patient.gender || '').toLowerCase();
    const age = ageYears(patient.date_of_birth);

    // LAB_PANEL_IS_TRUTH_V1 — результаты заказа сопоставляются с показателями
    // панели ЕГО услуги: сначала по имени, остальные по порядку (см. lab-doc).
    // Правка имени в справочнике больше не отрывает нормы от старых заказов.
    const byPanelOrder = matchResultsToAnalytes(panelList, results.map((x) => x.parameter));

    const tests = results.map((x, xi) => {
        // Порядок источников: панель услуги (имя или позиция) -> справочник
        // точно -> справочник по словам -> норма самой услуги (одиночные
        // анализы без панели).
        const svc0 = r.services || {};
        const analyte = byPanelOrder[xi]
            || resolveAnalyte(idx, x.parameter, local)
            || (svc0.ref_low != null || svc0.ref_high != null || svc0.ref_text
                ? { ref_low: svc0.ref_low, ref_high: svc0.ref_high, ref_text: svc0.ref_text }
                : null);

        // Именованные диапазоны берём У НАЙДЕННОГО показателя, а не только у
        // панели этой услуги: иначе у ФСГ, найденного в общем справочнике,
        // пропадали все четыре фазы цикла, и женщине печаталась мужская норма.
        const named = namedRangeCell(analyte, gender, age);

        // Подходящая фаза уже помечена — пол не помечаем, чтобы жирной осталась
        // одна строка.
        const refText = labRefText(analyte, named.marked ? '' : gender, x.reference_range, named.texts);

        // При двух и более диапазонах автоматический флаг не ставится: фазу
        // цикла программа знать не может, решает врач.
        const manyRanges = named.count >= 2;

        return {
            name: x.parameter,
            code: codeByName.get(nk(x.parameter)) || '',
            value: x.value == null || x.value === '' ? '—' : String(x.value),
            unit: x.unit || (analyte && analyte.unit) || '',
            ref: refText,
            flag: manyRanges ? '' : labFlagCell(x),
            pos: manyRanges ? null : labPosFor(x),
        };
    });

    // LAB_BLANK_DIAG_V1 — короткий отчёт в консоль при каждой печати бланка.
    //
    // Спор «у меня нормы не печатаются» / «а у меня всё находится» неразрешим,
    // пока обе стороны смотрят в разные места. Здесь видно ровно то, что решила
    // программа для КАЖДОГО показателя: нашла ли, где нашла, что напечатает.
    // Открыть консоль (F12) -> нажать «Бланк» -> прислать эти строки.
    try {
        const diag = results.map((x, xi) => {
            const w = byPanelOrder[xi]
                ? { how: 'панель услуги', analyte: byPanelOrder[xi] }
                : resolveAnalyteWhy(idx, x.parameter, local);
            return {
                'показатель': x.parameter,
                'найден': w.how,
                'из справочника': w.analyte ? w.analyte.name : '',
                'напечатает': (tests[xi] || {}).ref || '',
            };
        });
        const ok = diag.filter((d) => d['напечатает'] && d['напечатает'] !== '—').length;
        console.groupCollapsed(`[бланк] ${svc.name || 'Анализ'} — норма есть у ${ok} из ${diag.length}`);
        console.table(diag);
        console.info('показателей в справочнике:', idx ? idx.exact.size : 0,
                     '| спорных имён:', idx ? idx.conflicts.size : 0,
                     '| показателей своей панели:', local ? local.size : 0);
        console.groupEnd();
    } catch (e) { /* диагностика не должна мешать печати */ }

    // Анализ без результатов ПЕЧАТАЕТСЯ ВСЁ РАВНО, строкой-заглушкой: бланк
    // перечисляет все назначенные анализы, иначе по нему не видно, что
    // что-то ещё не готово.
    if (!tests.length) {
        tests.push({ name: 'Результаты ещё не внесены', code: '', value: '—', unit: '', ref: '—', flag: 'N', pos: null });
    }

    // Номер образца в заголовке панели: у каждого анализа своя пробирка со
    // своим штрих-кодом, и на бланке он должен стоять рядом со своей таблицей.
    return { title: `${svc.name || 'Анализ'} · № ${accession(r)}`, tests };
}

async function buildLabDoc(rows, patient, opts = {}) {
    const groups = [];
    for (const r of rows) {
        groups.push(await labGroupFor(r, patient, state.resultsByVs[r.id] || []));
    }
    const first = rows[0] || {};
    // LAB_SHEET_HEAD_V1 — даты по общим правилам (lab-doc.js): «Приём» — забор
    // или день визита, «Выдан» — проверка или последний ввод. Раньше здесь
    // подставлялось «сегодня», и перепечатанный назавтра документ менял дату.
    const allResults = rows.flatMap((x) => state.resultsByVs[x.id] || []);
    const { dateIn, dateOut } = labIssueDates({
        visitDate: (state.patientMap[first.visit_id] || {}).visit_date,
        collectedAt: first.sample_collected_at,
        verifiedAt: opts.verifiedAt || first.verified_at,
        lastEnteredAt: labMaxDate(allResults, 'entered_at'),
    });
    return {
        // Одна панель — её номер в шапке. Несколько — номер у каждой свой, и
        // общей «заявки» у них нет: показывать чужой номер хуже, чем никакой.
        requestNo: rows.length === 1 ? accession(first) : '',
        dateIn,
        dateOut,
        patientName: patient.full_name || '—',
        dob: fmtDMY(patient.date_of_birth),
        sex: labSexRu(patient.gender),
        mrn: patient.mrn || '',
        labChief: opts.verifiedBy || '',
        labChiefSpec: opts.verifiedBy ? 'Проверил и выдал' : '',
        groups,
    };
}

// Один анализ («Отчёт» в строке) и весь образец («Бланк») печатаются ОДНИМ
// путём — различаются только списком строк.
async function printReport(r, patient, results, opts = {}) {
    return printGroupReport([r], patient, opts);
}

// LAB_BLANK_ALL_PANELS_V1 — «Бланк» печатает ВЕСЬ образец: раньше сюда уходила
// одна-единственная строка, поэтому пациент с пятью анализами получал бланк с
// одной панелью. Теперь каждая панель — своя группа одного документа.
async function printGroupReport(rows, patient, opts = {}) {
    const data = await buildLabDoc(rows, patient, opts);
    // type:'lab' — тот самый шаблон, что показывает предпросмотр в «Настройки →
    // Документы». Если groups пуст, renderDesignedVariant подставит ОБРАЗЕЦ с
    // выдуманным пациентом, поэтому пустой бланк не отправляем на печать.
    if (!data.groups.length) return toast('Нечего печатать: анализы не выбраны.', 'warn');
    printableSheet({ type: 'lab', title: 'Результаты анализов', data });
    return data;
}
