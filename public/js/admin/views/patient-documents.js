// Clinical Documents — PATIENT_DOCUMENTS_V1 — pick a patient, then produce
// downloadable/printable BRANDED documents (lab report, consultation answer,
// diagnostic conclusion) to hand to the patient. Route 'patient-documents'.
//
// Distinct from two other, similarly-named things already in this codebase:
//   - views/documents-settings.js (route 'documents-settings') — the
//     clinic-wide letterhead/branding EDITOR for the `doc_settings` table
//     this view reads from. Settings hub calls that card "Document branding".
//   - views/documents.js (route 'documents') — the older, company-scoped
//     six-document-type template/variant designer. Untouched by this view.
//
// Data model (server/db/schema-registry.js):
//   - doc_settings (id=1) — clinic branding, loaded once and cached for the
//     lifetime of this module (branding rarely changes mid-session).
//   - visits — conclusion (free text) + conclusion_type ('consultation' |
//     'diagnostic') are writable by admin/registrar/doctor via /api/db.
//   - visit_services -> services (2-hop, no direct visits->lab_results embed):
//     a visit "has a lab report" once >=1 lab_results row exists for one of
//     its lab (services.is_lab) visit_services.
//
// Mirrors public/js/admin/views/visits.js / laboratory.js for structure
// (mount/fetchAndPaint via h()/Icon/clear/toast, the fan-out patient search —
// the local client has no `.or()`, so each searchable column gets its own
// `.ilike()` call, deduped by id — and the visit_services -> services embed +
// batched lab_results lookup) and settings-hub.js / laboratory.js for modal
// chrome (.modal / .modal-backdrop / .modal-card / .modal-head / .modal-close
// / .modal-body / .modal-foot).

import { supabase } from '../../supabase.js';
import { h, Icon, clear, toast, Tag, StatusTag, fmtDateTime, field } from '../ui.js';
// LAB_BLANK_ONE_TEMPLATE_V1 — печатаем шаблоном из «Настройки → Документы»,
// тем же, что лаборатория, карта пациента и Telegram-бот.
import { printableSheet } from './doc-settings.js?v=q3company1';
import { labFlagCell, labPosFor, fmtDMY, labSexRu, labRefLines, labRefText, matchResultsToAnalytes,
         namedRangeCell, ageYears, labAccession, labIssueDates, labMaxDate } from './lab-doc.js?v=labshared1';
import { analyteIndex, resolveAnalyte, analytesForService } from './lab-analyte-index.js?v=labshared1';

const refs = { container: null, onNavigate: null, bodyEl: null, docsWrap: null };

const state = {
    patient: null,   // selected patient row ({ id, full_name, mrn, phone, ... })
    docs:    { visits: [], labByVisit: {}, doctorMap: {} },
    brand:   null,
};

let brandCache = null;   // doc_settings — fetched once, reused across patients
let lastFetchToken = 0;

export async function renderPatientDocuments(container, { onNavigate } = {}) {
    refs.container  = container;
    refs.onNavigate = onNavigate;
    state.patient = null;
    state.docs = { visits: [], labByVisit: {}, doctorMap: {} };
    mount();
}

// -----------------------------------------------------------------------------
// MOUNT — static page head; repaintBody() swaps between the search view and
// the selected-patient documents view.
// -----------------------------------------------------------------------------
function mount() {
    clear(refs.container);
    refs.bodyEl = h('div');
    refs.container.appendChild(h('div', { class: 'fade-in' },
        h('div', { class: 'page-head' },
            h('div', null,
                h('h1', { class: 'page-title' }, 'Documents'),
                h('p', { class: 'page-subtitle' }, 'Printable lab, diagnostic & consultation documents for patients'),
            ),
        ),
        refs.bodyEl,
    ));
    repaintBody();
}

function repaintBody() {
    clear(refs.bodyEl);
    if (!state.patient) {
        // DOCS_FEED_V1 — поиск сверху, под ним лента всех готовых документов.
        // Поле поиска рисуется пустым, поэтому и фильтр ленты сбрасываем:
        // иначе лента осталась бы сужённой запросом, которого не видно.
        feed.q = '';
        // DOCS_TOOLBAR_V1 — период по умолчанию задаётся ДО отрисовки панели:
        // раньше это делал feedCard, но период теперь рисует searchCard, а он
        // монтируется первым.
        if (!feed.from && !feed.to) { feed.from = weekStart(); feed.to = ymdLocal(new Date()); }
        refs.bodyEl.appendChild(searchCard());
        refs.bodyEl.appendChild(feedCard());
        loadFeed({ reset: true });
        return;
    }
    refs.bodyEl.appendChild(selectedHeader());
    refs.docsWrap = h('div', { style: { marginTop: '16px' } });
    refs.bodyEl.appendChild(refs.docsWrap);
    loadAndPaintDocs();
}

function selectPatient(p) {
    state.patient = p;
    repaintBody();
}

function clearPatient() {
    state.patient = null;
    repaintBody();
}

// -----------------------------------------------------------------------------
// SEARCH — fan-out .ilike() across full_name/phone/mrn, deduped by id (same
// pattern as visits.js's searchPatients / registration.js's runPatientSearch;
// the local client has no `.or()`).
// -----------------------------------------------------------------------------
function searchCard() {
    // DOCS_TOOLBAR_V1 — один блок фильтров вместо двух: поиск, период и типы
    // живут вместе над лентой. Раньше период сидел внутри карточки «Готовые
    // документы», и сотрудник крутил взгляд между двумя карточками, чтобы
    // задать один вопрос («анализы Каримовой за эту неделю»).
    const searchInp = h('input', {
        type: 'search', autocomplete: 'off',
        placeholder: 'Пациент: имя, телефон или № карты — или название услуги…',
        style: {
            width: '100%', boxSizing: 'border-box',
            padding: '10px 14px 10px 38px', fontSize: '14px',
            border: '1px solid var(--ink-200)', borderRadius: '10px',
            background: 'var(--ink-25, #f8fafa)', outline: 'none',
        },
        onfocus: (e) => { e.currentTarget.style.background = '#fff'; e.currentTarget.style.borderColor = 'var(--primary-600, #0f766e)'; },
        onblur:  (e) => { e.currentTarget.style.background = 'var(--ink-25, #f8fafa)'; e.currentTarget.style.borderColor = 'var(--ink-200)'; },
    });
    const resultsEl = h('div', {
        style: {
            display: 'none', marginTop: '8px',
            border: '1px solid var(--ink-200)', borderRadius: '10px',
            maxHeight: '300px', overflowY: 'auto',
        },
    });

    // DOCS_FEED_V1 — одно поле, две работы: подсказывает пациентов (открыть
    // весь его архив) и одновременно сужает ленту документов снизу. Второе поле
    // поиска рядом с первым сотрудник всё равно читал бы как одно.
    let searchTimer = null;
    searchInp.addEventListener('input', () => {
        clearTimeout(searchTimer);
        const term = searchInp.value;
        searchTimer = setTimeout(async () => {
            // Ленту фильтруем любым непустым запросом, включая короткий:
            // «ОАК» — три буквы, и это осмысленный поиск.
            feed.q = term.trim();
            loadFeed({ reset: true });
            if (term.trim().length < 2) { clear(resultsEl); resultsEl.style.display = 'none'; return; }
            const rows = await searchPatients(term);
            paintResults(rows, resultsEl);
        }, 250);
    });

    // Лупа внутри поля — поле и так одно, отдельный заголовок «Find patient»
    // ему больше не нужен. flex 0 1: поле НЕ растягивается на всю ширину —
    // во всю строку оно отталкивало период за край экрана.
    const searchWrap = h('div', { style: { position: 'relative', flex: '0 1 320px', minWidth: '220px' } },
        h('span', { style: { position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: 'var(--ink-400)', pointerEvents: 'none', display: 'flex' } },
            Icon('Search', { size: 16 })),
        searchInp);

    // DOCS_TOOLBAR_V1 — период рядом с поиском, в той же строке.
    refs.periodRow = h('div', { class: 'row', style: { gap: '6px', alignItems: 'center', flexWrap: 'wrap', flex: '0 0 auto' } });
    paintPeriodRow();

    // DOCS_TYPE_TABS_V1 — регистратура ищет ПО ТИПУ: «Приёмы / Диагностика /
    // Анализы» стоят прямо у поиска, всегда, даже при нуле документов — кнопка,
    // которая появляется только когда есть что показать, выглядит как её
    // отсутствие. Раньше типы жили чипами ниже фильтра периода и прятались при
    // нуле; регистратура их просто не находила. Прочие типы (процедуры и
    // «прочее») дорисовываются только когда они есть — их не ищут нарочно.
    refs.typeRow = h('div', { class: 'row', style: { gap: '6px', alignItems: 'center', flexWrap: 'wrap', marginTop: '10px' } });
    paintTypeRow();

    return h('div', { class: 'card' },
        h('div', { style: { padding: '14px 16px' } },
            h('div', { class: 'row', style: { gap: '10px', alignItems: 'center', flexWrap: 'wrap' } },
                searchWrap, refs.periodRow),
            refs.typeRow,
            resultsEl),
    );
}

// DOCS_TOOLBAR_V1 — период как сегмент из дат и двух пресетов. Пресеты — те же
// чипы, что и типы ниже: два вида кнопок в одной панели читались бы как два
// разных механизма. Активный пресет подсвечен, ручная правка дат гасит оба.
function paintPeriodRow() {
    if (!refs.periodRow) return;
    clear(refs.periodRow);
    const today = ymdLocal(new Date());
    const chip = (on, label, onclick) =>
        h('button', { class: 'wzc-cat' + (on ? ' on' : ''), type: 'button', onclick }, label);
    const dateInp = (val, onset) => {
        const el = h('input', {
            type: 'date', value: val || '',
            style: {
                padding: '6px 8px', fontSize: '12.5px',
                border: '1px solid var(--ink-200)', borderRadius: '8px',
                background: '#fff', color: 'var(--ink-700)',
            },
        });
        el.addEventListener('change', () => { onset(el.value); paintPeriodRow(); reloadFeed(); });
        return el;
    };

    refs.periodRow.appendChild(h('span', { class: 'muted', style: { fontSize: '12px' } }, 'Период'));
    refs.periodRow.appendChild(dateInp(feed.from, (v) => { feed.from = v; }));
    refs.periodRow.appendChild(h('span', { class: 'muted', style: { fontSize: '12px' } }, '—'));
    refs.periodRow.appendChild(dateInp(feed.to, (v) => { feed.to = v; }));
    refs.periodRow.appendChild(chip(feed.from === today && feed.to === today, 'Сегодня', () => {
        feed.from = ymdLocal(new Date()); feed.to = ymdLocal(new Date());
        paintPeriodRow(); reloadFeed();
    }));
    // «Эта неделя» не подсвечивается, когда выбран «Сегодня», хотя сегодняшний
    // день формально внутри недели: пресет — это ровно тот диапазон, что стоит
    // в датах, а не «пересекается с ним».
    refs.periodRow.appendChild(chip(feed.from === weekStart() && feed.to === today && feed.from !== today, 'Эта неделя', () => {
        feed.from = weekStart(); feed.to = ymdLocal(new Date());
        paintPeriodRow(); reloadFeed();
    }));
    refs.periodRow.appendChild(chip(!feed.from && !feed.to, 'Всё время', () => {
        feed.from = ''; feed.to = '';
        paintPeriodRow(); reloadFeed();
    }));
}

// Всегда видимые три главных типа; счётчики подтягиваются после загрузки ленты.
const PRIMARY_TYPES = ['consultation', 'imaging', 'lab'];

function paintTypeRow() {
    if (!refs.typeRow) return;
    clear(refs.typeRow);
    const counts = Object.fromEntries((feed.byType || []).map((x) => [x.t, x.c]));
    const chip = (on, label, onclick) =>
        h('button', { class: 'wzc-cat' + (on ? ' on' : ''), type: 'button', onclick }, label);
    const toggle = (key) => () => {
        if (feed.types.has(key)) feed.types.delete(key); else feed.types.add(key);
        paintTypeRow();
        reloadFeed();
    };

    refs.typeRow.appendChild(chip(!feed.types.size, 'Все', () => { feed.types.clear(); paintTypeRow(); reloadFeed(); }));
    for (const key of PRIMARY_TYPES) {
        const c = counts[key];
        refs.typeRow.appendChild(chip(feed.types.has(key), DOC_TYPE_RU[key] + (c ? ' · ' + c : ''), toggle(key)));
    }
    for (const [key, label] of DOC_TYPES) {
        if (PRIMARY_TYPES.includes(key)) continue;
        if (!counts[key] && !feed.types.has(key)) continue;
        refs.typeRow.appendChild(chip(feed.types.has(key), label + ' · ' + (counts[key] || 0), toggle(key)));
    }
}

function paintResults(rows, resultsEl) {
    clear(resultsEl);
    if (rows.length === 0) {
        resultsEl.appendChild(h('div', {
            style: { padding: '12px 14px', fontSize: '12.5px', color: 'var(--ink-500)' },
        }, 'No matches.'));
    } else {
        for (const p of rows.slice(0, 10)) {
            resultsEl.appendChild(h('div', {
                class: 'row-click',
                style: { display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 14px', borderBottom: '1px solid var(--ink-100)', cursor: 'pointer' },
                onclick: () => selectPatient(p),
            },
                h('div', { style: { flex: 1, minWidth: 0 } },
                    h('div', { class: 'cell-strong' }, p.full_name || '—'),
                    h('div', { class: 'muted', style: { fontSize: '11.5px' } }, [p.mrn, p.phone].filter(Boolean).join(' · ') || '—'),
                ),
                h('span', { style: { color: 'var(--ink-400)' } }, Icon('ChevronRight', { size: 14 })),
            ));
        }
    }
    resultsEl.style.display = '';
}

async function searchPatients(term) {
    const t = (term || '').trim();
    if (t.length < 2) return [];
    const fields = ['full_name', 'phone', 'mrn'];
    const cols   = 'id, full_name, mrn, phone, gender, date_of_birth';
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

// -----------------------------------------------------------------------------
// SELECTED PATIENT HEADER
// -----------------------------------------------------------------------------
function selectedHeader() {
    const p = state.patient;
    return h('div', { class: 'card' },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px', padding: '14px 16px' } },
            h('div', { style: { flex: 1, minWidth: 0 } },
                h('div', { style: { fontWeight: '700', fontSize: '15px' } }, p.full_name || '—'),
                h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '2px' } },
                    [p.mrn ? ('MRN ' + p.mrn) : null, p.phone || null].filter(Boolean).join(' · ') || '—'),
            ),
            h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: clearPatient }, 'Change'),
        ),
    );
}

// -----------------------------------------------------------------------------
// FETCH + REPAINT — visits, then the visit_services -> services (lab) embed,
// then the batched lab_results lookup grouped back onto each visit, then an
// optional doctor-name lookup.
// -----------------------------------------------------------------------------
async function loadAndPaintDocs() {
    const token = ++lastFetchToken;
    clear(refs.docsWrap);
    refs.docsWrap.appendChild(h('div', { class: 'empty' }, 'Loading…'));
    try {
        const [brand, docs] = await Promise.all([getBrand(), fetchPatientDocs(state.patient.id)]);
        if (token !== lastFetchToken) return;
        state.brand = brand;
        state.docs = docs;
        paintDocs();
    } catch (e) {
        if (token !== lastFetchToken) return;
        toast('Failed to load documents: ' + ((e && e.message) || e), 'fail');
        clear(refs.docsWrap);
        refs.docsWrap.appendChild(h('div', { class: 'empty' }, 'Failed to load documents.'));
    }
}

async function getBrand() {
    if (brandCache) return brandCache;
    try {
        const { data, error } = await supabase.from('doc_settings').select('*').eq('id', 1).single();
        if (error) throw error;
        brandCache = data || {};
    } catch (e) {
        toast('Failed to load document branding — printed documents will use defaults.', 'fail');
        brandCache = {};
    }
    return brandCache;
}

async function fetchPatientDocs(patientId) {
    const { data: visitsData, error: visitsErr } = await supabase.from('visits')
        .select('id,visit_date,visit_type,status,conclusion,conclusion_type,doctor_id')
        .eq('patient_id', patientId)
        .order('visit_date', { ascending: false });
    if (visitsErr) {
        toast('Failed to load visits: ' + (visitsErr.message || visitsErr), 'fail');
        return { visits: [], labByVisit: {}, doctorMap: {} };
    }
    const visits = visitsData || [];
    const labByVisit = visits.length > 0 ? await fetchLabByVisit(visits.map(v => v.id)) : {};

    // Doctor names — optional, best-effort (no toast on failure: the document
    // still prints fine without a doctor name).
    const doctorMap = {};
    try {
        const { data: docData, error: docErr } = await supabase.from('users').select('id,full_name').eq('role', 'doctor');
        if (!docErr) for (const d of (docData || [])) doctorMap[d.id] = d.full_name;
    } catch (e) { /* optional */ }

    return { visits, labByVisit, doctorMap };
}

// DOCS_ROW_PRINT_V1 — вынесено из fetchPatientDocs без изменений, потому что
// печать из строки ленты обязана собирать данные ТЕМ ЖЕ кодом, что и архив
// пациента: две сборки одного документа неизбежно разошлись бы.
async function fetchLabByVisit(visitIds) {
    const labByVisit = {};
    {
        const { data: vsData, error: vsErr } = await supabase.from('visit_services')
            .select('id,visit_id,services(name,result_unit,ref_low,ref_high,ref_text,is_lab)')
            .in('visit_id', visitIds);
        if (vsErr) {
            toast('Failed to load lab orders: ' + (vsErr.message || vsErr), 'fail');
        } else {
            const labVs = (vsData || []).filter(r => r.services && r.services.is_lab);
            const labVsIds = labVs.map(r => r.id);
            if (labVsIds.length > 0) {
                const { data: lrData, error: lrErr } = await supabase.from('lab_results')
                    .select('*')
                    .in('visit_service_id', labVsIds);
                if (lrErr) {
                    toast('Failed to load lab results: ' + (lrErr.message || lrErr), 'fail');
                } else {
                    // LAB_DOC_ALL_ANALYTES_V1 — панель пишет ПО СТРОКЕ lab_results
                    // НА КАЖДЫЙ ПОКАЗАТЕЛЬ (см. laboratory.js: «Each analyte writes
                    // ONE lab_results row»). Прежний код оставлял одну строку с
                    // наибольшим id НА УСЛУГУ — то есть от ОАК с 28 показателями в
                    // документ попадал ровно ОДИН, а остальные 27 исчезали.
                    // «Текущий результат побеждает» относится к ПОВТОРНОМУ вводу
                    // того же показателя, а не к разным показателям панели,
                    // поэтому ключ — пара (услуга, параметр).
                    const latestByVsParam = new Map();
                    for (const r of (lrData || [])) {
                        const key = r.visit_service_id + '\0' + (r.parameter || '');
                        const prev = latestByVsParam.get(key);
                        if (!prev || r.id > prev.id) latestByVsParam.set(key, r);
                    }
                    const vsById = {};
                    for (const vs of labVs) vsById[vs.id] = vs;
                    // Порядок ввода = порядок показателей в панели: сортируем по id,
                    // иначе в документе они шли бы как попало из Map.
                    for (const result of [...latestByVsParam.values()].sort((a, b) => a.id - b.id)) {
                        const vs = vsById[result.visit_service_id];
                        if (!vs) continue;
                        const svc = vs.services || {};
                        const list = labByVisit[vs.visit_id] || (labByVisit[vs.visit_id] = []);
                        list.push({
                            // Показатель называем его именем, а услугу держим рядом:
                            // иначе 28 строк ОАК выглядели бы как 28 одинаковых «ОАК».
                            testName:        result.parameter || svc.name || 'Test',
                            panelName:       svc.name || '',
                            // LAB_SHEET_HEAD_V1 — заказ, услуга и даты нужны
                            // общей шапке (Заявка №, Приём/Выдан) и подбору
                            // показателя по панели услуги.
                            vsId:            result.visit_service_id,
                            serviceId:       vs.service_id,
                            enteredAt:       result.entered_at || null,
                            verifiedAt:      result.verified_at || null,
                            value:           result.value,
                            unit:            result.unit || svc.result_unit || '',
                            reference_range: result.reference_range || '',
                            ref_low:         svc.ref_low,
                            ref_high:        svc.ref_high,
                            ref_text:        svc.ref_text || '',
                            flag:            result.flag || '',
                        });
                    }
                }
            }
        }
    }
    return labByVisit;
}

// -----------------------------------------------------------------------------
// PAINT — one .card per visit with the branded-print action row.
// -----------------------------------------------------------------------------
function paintDocs() {
    clear(refs.docsWrap);
    const visits = state.docs.visits;
    if (!visits.length) {
        refs.docsWrap.appendChild(h('div', { class: 'empty' }, 'This patient has no visits yet.'));
        return;
    }
    for (const v of visits) refs.docsWrap.appendChild(visitCard(v));
}

function conclusionTag(v) {
    if (v.conclusion_type === 'diagnostic')   return Tag('Diagnostic conclusion', { kind: 'purple' });
    if (v.conclusion_type === 'consultation') return Tag('Consultation conclusion', { kind: 'info' });
    return Tag('No conclusion', { kind: '' });
}

function visitCard(v) {
    const labResults = state.docs.labByVisit[v.id] || [];
    const hasLab = labResults.length > 0;
    const doctorName = v.doctor_id ? (state.docs.doctorMap[v.doctor_id] || null) : null;

    const labBtn = hasLab ? h('button', {
        class: 'btn btn-outline btn-sm', type: 'button',
        onclick: () => printLabReport(v, labResults, state.brand, state.patient),
    }, Icon('Flask', { size: 13 }), ' Lab report') : null;

    const editBtn = h('button', {
        class: 'btn btn-outline btn-sm', type: 'button',
        onclick: () => openConclusionModal(v),
    }, Icon('Edit', { size: 13 }), ' Edit');

    const printBtn = h('button', {
        class: 'btn btn-outline btn-sm', type: 'button', disabled: !v.conclusion,
        onclick: () => printConclusion(v, state.brand, state.patient, doctorName),
    }, Icon('Print', { size: 13 }), ' Print');

    return h('div', { class: 'card', style: { marginTop: '12px' } },
        h('div', { class: 'card-header' },
            h('h3', null, fmtDateTime(v.visit_date)),
            h('div', { class: 'row', style: { gap: '8px', alignItems: 'center' } },
                h('span', { class: 'muted', style: { fontSize: '12px' } }, v.visit_type || '—'),
                StatusTag(v.status),
            ),
        ),
        h('div', { style: { padding: '12px 16px 16px', display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'center' } },
            labBtn, conclusionTag(v), editBtn, printBtn,
        ),
    );
}

// -----------------------------------------------------------------------------
// EDIT CONCLUSION MODAL
// -----------------------------------------------------------------------------
function openConclusionModal(v) {
    const overlay = h('div', { class: 'modal' });
    const close = () => overlay.remove();
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));

    const typeSel = h('select', null,
        h('option', { value: 'consultation', selected: v.conclusion_type !== 'diagnostic' }, 'Consultation'),
        h('option', { value: 'diagnostic', selected: v.conclusion_type === 'diagnostic' }, 'Diagnostic'));
    const conclusionTa = h('textarea', { rows: '7' }, v.conclusion || '');

    const saveBtn = h('button', { class: 'btn btn-primary', type: 'button' }, 'Save');
    saveBtn.addEventListener('click', async () => {
        saveBtn.disabled = true;
        const prevLabel = saveBtn.textContent;
        saveBtn.textContent = 'Saving…';
        try {
            const { error } = await supabase.from('visits').update({
                conclusion:      conclusionTa.value.trim(),
                conclusion_type: typeSel.value,
            }).eq('id', v.id).select().single();
            if (error) throw error;
            toast('Saved', 'ok');
            close();
            await loadAndPaintDocs();
        } catch (e) {
            toast((e && e.message) || 'Failed to save.', 'fail');
            saveBtn.disabled = false;
            saveBtn.textContent = prevLabel;
        }
    });

    overlay.appendChild(h('div', { class: 'modal-card modal-compact', style: { width: '480px', maxWidth: 'calc(100vw - 32px)' } },
        h('header', { class: 'modal-head' },
            h('h2', null, Icon('Doc', { size: 16 }), ' Edit conclusion'),
            h('button', { class: 'modal-close', onclick: close }, '×')),
        h('div', { class: 'modal-body' },
            field('Type', typeSel),
            field('Conclusion', conclusionTa),
        ),
        h('footer', { class: 'modal-foot' },
            h('button', { class: 'btn', type: 'button', onclick: close }, 'Cancel'),
            h('span', { class: 'grow' }),
            saveBtn),
    ));
    document.body.appendChild(overlay);
    conclusionTa.focus();
}

// =============================================================================
// BRANDED PRINT — the core deliverable. Every dynamic string is HTML-escaped
// via esc() before it lands in the print document string; the logo is used
// only as an <img src> data URL (safe). On-screen DOM above uses h()'s
// textContent path exclusively — never innerHTML.
// =============================================================================
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }




// labReferenceText удалён (LAB_SHEET_HEAD_V1): референс собирает labRefText
// из lab-doc.js — общий для лаборатории, карты, бота и этого раздела.

// LAB_BLANK_ONE_TEMPLATE_V1 — бланк из «Настройки → Документы», а не свой.
//
// Здесь была ЧЕТВЁРТАЯ вёрстка результатов: своя таблица, своё окно печати
// (docShell + openPrintWindow), заголовок «Laboratory Report» и флаги
// «High/Low» по-английски, без узбекского, без номеров образцов, без печати и
// QR — и, что хуже всего, мимо выбора варианта в настройках. Один и тот же
// анализ выглядел по-разному в лаборатории, в карте пациента, в боте и здесь.
//
// Теперь все четыре места зовут printableSheet({ type: 'lab' }) и получают тот
// шаблон, который клиника выбрала в «Настройки → Документы».
async function printLabReport(visit, results, brand, patient) {
    // LAB_SHEET_HEAD_V1 + LAB_PANEL_IS_TRUTH_V1 — тот же чертёж, что у
    // лаборатории, карты пациента и бота. Раньше этот раздел собирал шапку
    // по-своему: «Выдан» получал СЕГОДНЯШНЮЮ дату (перепечатка назавтра меняла
    // документ), номер заявки не печатался, а показатель искался только по
    // сохранённой строке — нормы, заведённые после сдачи, сюда не доходили.
    //
    // Секции — по ЗАКАЗАМ (vsId): у каждой пробирки свой номер и своя таблица.
    const byOrder = new Map();
    for (const r of (results || [])) {
        const key = r.vsId != null ? 'vs' + r.vsId : (r.panelName || '');
        if (!byOrder.has(key)) byOrder.set(key, []);
        byOrder.get(key).push(r);
    }
    const idx = await analyteIndex();
    const gender = String((patient && patient.gender) || '').toLowerCase();
    const age = ageYears(patient && patient.date_of_birth);

    const groups = [...byOrder.values()].map((list) => {
        const vsId = list[0].vsId;
        const panelList = analytesForService(idx, list[0].serviceId);
        const byPos = matchResultsToAnalytes(panelList, list.map((r) => r.testName));
        return {
            title: (list[0].panelName || 'Анализ') + (vsId != null ? ' · № ' + labAccession(vsId) : ''),
            tests: list.map((r, ri) => {
                const analyte = byPos[ri]
                    || resolveAnalyte(idx, r.testName, null)
                    || (r.ref_low != null || r.ref_high != null || r.ref_text
                        ? { ref_low: r.ref_low, ref_high: r.ref_high, ref_text: r.ref_text }
                        : null);
                const named = namedRangeCell(analyte, gender, age);
                const manyRanges = named.count >= 2;
                return {
                    name: r.testName,
                    code: '',
                    value: r.value == null || r.value === '' ? '—' : String(r.value),
                    unit: r.unit || (analyte && analyte.unit) || '',
                    ref: labRefText(analyte, named.marked ? '' : gender, r.reference_range, named.texts),
                    flag: manyRanges ? '' : labFlagCell(r),
                    pos: manyRanges ? null : labPosFor(r),
                };
            }),
        };
    });
    if (!groups.length) return toast('Результатов нет — печатать нечего.', 'info');

    const vsIds = [...new Set((results || []).map((r) => r.vsId).filter((v) => v != null))];
    const { dateIn, dateOut } = labIssueDates({
        visitDate: visit.visit_date,
        verifiedAt: labMaxDate(results, 'verifiedAt'),
        lastEnteredAt: labMaxDate(results, 'enteredAt'),
    });
    const doctorName = visit.doctor_id ? (state.docs.doctorMap[visit.doctor_id] || '') : '';
    printableSheet({
        type: 'lab',
        title: 'Результаты анализов',
        data: {
            requestNo: vsIds.length === 1 ? labAccession(vsIds[0]) : '',
            dateIn,
            dateOut,
            patientName: patient && patient.full_name ? patient.full_name : '—',
            dob: fmtDMY(patient && patient.date_of_birth),
            sex: labSexRu(patient && patient.gender),
            mrn: (patient && patient.mrn) || '',
            labChief: doctorName,
            labChiefSpec: doctorName ? 'Лечащий врач' : '',
            groups,
        },
    });
}

// LAB_BLANK_ONE_TEMPLATE_V1 — заключение тоже печатается шаблоном из настроек.
//
// visits.conclusion — это СВОБОДНЫЙ ТЕКСТ (в базе клиники сейчас 0 таких
// визитов: кабинет врача подписывает структурированные документы в
// visit_documents). Поэтому текст кладём в раздел, который у шаблона есть:
// диагностика — в «Заключение» шаблона diag, приём — в «Осмотр» шаблона
// conclusion. Прежний docShell печатал его заголовком «Consultation Report»
// по-английски и мимо всех настроек бренда.
function printConclusion(visit, brand, patient, doctorName) {
    const text = String(visit.conclusion || '').trim();
    if (!text) return toast('Заключение пустое — печатать нечего.', 'info');

    const head = {
        patientName: (patient && patient.full_name) || '—',
        mrn: (patient && patient.mrn) || '',
        dob: fmtDMY(patient && patient.date_of_birth),
        sex: labSexRu(patient && patient.gender),
        doctorName: doctorName || '',
        issueDate: fmtDMY(visit.visit_date),
    };
    if (visit.conclusion_type === 'diagnostic') {
        printableSheet({ type: 'diag', title: 'Заключение диагностики', data: { ...head, conclusion: text } });
        return;
    }
    printableSheet({
        type: 'conclusion', title: 'Заключение врача',
        // sectionOrder работает начиная с CONCL_SECTIONS_KEEP_V1: до него
        // «Осмотр» отфильтровывался и текст пропал бы молча.
        data: { ...head, exam: text, sectionOrder: ['physical_exam'], activeFields: ['physical_exam'] },
    });
}

// -----------------------------------------------------------------------------
// DOCS_FEED_V1 — лента готовых документов по всей клинике
// -----------------------------------------------------------------------------
// Раздел умел только одно: найти пациента и собрать бланк ему. На вопрос «что
// вообще готово за эту неделю» ответа не было — приходилось перебирать
// пациентов по одному, и пустая страница с одной строкой поиска этого никак не
// подсказывала.
//
// Лента показывает КАЖДУЮ услугу, по которой есть результат или подписанный
// документ: анализ, снимок, заключение. Одна услуга — одна строка (пациент с
// пятью анализами занимает пять), иначе фильтр по типу услуги теряет смысл.
//
// Поиск сверху остался тем же и работает на два фронта: подсказывает пациентов
// (чтобы открыть его полный архив) и одновременно сужает ленту.

const DOC_TYPES = [
    ['lab', 'Анализы'],
    ['imaging', 'Диагностика'],
    ['procedure', 'Процедуры'],
    ['consultation', 'Приёмы'],
    ['other', 'Прочее'],
];
const DOC_TYPE_RU = Object.fromEntries(DOC_TYPES);
const FEED_PAGE = 20;

// Понедельник текущей недели. Клиника считает неделями календарными (та же
// причина, что в CRM_PERIOD_WEEK_V1): «последние 7 дней» в четверг начинаются
// с прошлой пятницы, и сравнить такой период не с чем.
function ymdLocal(d) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function weekStart() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    // getDay(): воскресенье = 0, поэтому сдвигаем, иначе в воскресенье неделя
    // начиналась бы сегодня и показывала один день.
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return ymdLocal(d);
}

const feed = {
    from: '', to: '', types: new Set(), q: '',
    rows: [], total: 0, byType: [], nextOffset: 0, hasMore: false, loading: false,
};

// DOCS_TOOLBAR_V1 — все фильтры (период, типы, поиск) живут в верхней панели
// (searchCard); эта карточка — только лента.
function feedCard() {
    refs.feedList = h('div');
    refs.feedFoot = h('div', { style: { padding: '12px 16px' } });

    return h('div', { class: 'card', style: { marginTop: '16px', padding: '0' } },
        h('div', { class: 'card-header' },
            h('h3', null, Icon('Doc', { size: 16 }), ' Готовые документы'),
            h('span', { class: 'grow', style: { flex: '1' } }),
            refs.feedCount = h('span', { class: 'muted', style: { fontSize: '12.5px' } }, '')),
        refs.feedList, refs.feedFoot);
}

function reloadFeed() { loadFeed({ reset: true }); }

async function loadFeed({ reset = false } = {}) {
    if (feed.loading) return;
    feed.loading = true;
    if (reset) { feed.rows = []; feed.nextOffset = 0; clear(refs.feedList); }

    const args = {
        from: feed.from || null, to: feed.to || null,
        types: [...feed.types], q: feed.q,
        limit: FEED_PAGE, offset: feed.nextOffset,
    };
    let res;
    try {
        const { data, error } = await supabase.rpc('documents_feed', args);
        if (error) throw new Error(error.message || 'Не удалось загрузить документы.');
        res = data;
    } catch (e) {
        feed.loading = false;
        clear(refs.feedFoot);
        refs.feedFoot.appendChild(h('div', { class: 'empty', style: { padding: '20px' } }, e.message));
        return;
    }

    feed.rows = feed.rows.concat(res.rows || []);
    feed.total = res.total || 0;
    feed.byType = res.by_type || [];
    feed.nextOffset = res.next_offset || feed.rows.length;
    feed.hasMore = !!res.has_more;
    feed.loading = false;

    for (const r of (res.rows || [])) refs.feedList.appendChild(feedRow(r));
    paintFeedFoot();
    paintTypeRow();   // DOCS_TYPE_TABS_V1 — счётчики у кнопок типов обновляются вместе с лентой
    if (refs.feedCount) refs.feedCount.textContent = feed.total
        ? `показано ${feed.rows.length} из ${feed.total}` : '';
    if (!feed.rows.length) {
        refs.feedList.appendChild(h('div', { class: 'empty', style: { padding: '34px', textAlign: 'center' } },
            h('div', { style: { fontWeight: '600' } }, 'За этот период документов нет'),
            h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '4px' } },
                'Документ появляется, когда по услуге внесён результат или подписано заключение.')));
    }
}

function paintFeedFoot() {
    clear(refs.feedFoot);
    if (!feed.hasMore) return;
    const left = feed.total - feed.rows.length;
    const btn = h('button', {
        class: 'btn btn-outline', type: 'button', style: { width: '100%' },
        onclick: () => { btn.disabled = true; loadFeed(); },
    }, `Показать ещё ${Math.min(FEED_PAGE, left)}`);
    refs.feedFoot.appendChild(btn);
}

function feedRow(r) {
    const date = String(r.visit_date || '').slice(0, 10).split('-').reverse().join('.');
    const done = r.status === 'completed' || !!r.verified_at;

    // DOCS_FEED_ANSWERS_V1 — ответы прямо в строке: регистратура диктует
    // результат по телефону, не открывая архив. Отклонения — красным, тем же
    // словарём флагов, что печатный бланк (всё, что не 'normal' и не пусто).
    const answers = (r.results || []).length ? h('div', {
        style: { fontSize: '11.5px', marginTop: '2px', lineHeight: '1.5' },
    }, ...(r.results.map((res, i) => {
        const abnormal = res.flag && res.flag !== 'normal';
        return h('span', { style: { color: abnormal ? 'var(--crit-600, #dc2626)' : 'var(--ink-500)', fontWeight: abnormal ? '600' : '400' } },
            (i ? ' · ' : '') + res.parameter + ' ' + (res.value === '' ? '—' : res.value) + (res.unit ? ' ' + res.unit : ''));
    }))) : null;

    // DOCS_ROW_PRINT_V1 — печать, не покидая ленту: кнопка в конце строки
    // печатает ВСЕ анализы этого ВИЗИТА одним бланком (пациент уходит с одной
    // бумагой, а не с пятью). Прежний запрет «второй печатной кнопки» снят
    // честно: она зовёт тот же printLabReport через тот же fetchLabByVisit,
    // что и архив пациента, — расходиться нечему.
    //
    // span, а не button: сама строка — <button>, а <button> внутри <button> —
    // невалидный HTML, и клики по вложенной кнопке ведут себя непредсказуемо.
    const printBtn = r.result_count ? h('span', {
        class: 'btn btn-outline btn-sm', role: 'button', title: 'Печать всех результатов визита',
        onclick: (e) => { e.stopPropagation(); printVisitFromFeed(r, e.currentTarget); },
    }, Icon('Print', { size: 13 }), ' Печать') : null;

    return h('button', {
        type: 'button',
        // Строка по-прежнему ведёт в архив пациента — там заключения, правка
        // и остальные его документы.
        onclick: () => selectPatient({ id: r.patient_id, full_name: r.patient_name, mrn: r.mrn }),
        style: {
            display: 'flex', alignItems: 'center', gap: '12px', width: '100%', textAlign: 'left',
            padding: '10px 16px', border: 'none', borderBottom: '1px solid var(--ink-50, #f1f4f5)',
            background: 'transparent', cursor: 'pointer', fontFamily: 'inherit',
        },
        onmouseenter: (e) => { e.currentTarget.style.background = 'var(--ink-25, #f8fafa)'; },
        onmouseleave: (e) => { e.currentTarget.style.background = 'transparent'; },
    },
        h('div', { style: { width: '74px', flex: '0 0 auto', fontSize: '12.5px', color: 'var(--ink-600)' } }, date),
        h('div', { style: { flex: '1 1 34%', minWidth: '0' } },
            h('div', { style: { fontSize: '13.5px', fontWeight: '600', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                r.patient_name || '—'),
            h('div', { class: 'muted', style: { fontSize: '11.5px' } }, r.mrn || '')),
        h('div', { style: { flex: '1 1 46%', minWidth: '0' } },
            h('div', { style: { fontSize: '13px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                r.service_name || '—'),
            answers || h('div', { class: 'muted', style: { fontSize: '11.5px' } },
                (DOC_TYPE_RU[r.service_type] || r.service_type || '')
                + (r.doc_type ? ' · заключение' : ''))),
        h('span', { style: { flex: '0 0 auto' } }, Tag(done ? 'Выдан' : 'Готовится', { kind: done ? 'ok' : 'warn', dot: true })),
        printBtn && h('span', { style: { flex: '0 0 auto' }, onclick: (e) => e.stopPropagation() }, printBtn),
        h('span', { style: { flex: '0 0 auto', color: 'var(--ink-400, #9aa7ab)' } }, Icon('ChevronRight', { size: 15 })));
}

// DOCS_ROW_PRINT_V1 — собрать и напечатать все результаты ОДНОГО визита тем же
// кодом, что архив пациента: fetchLabByVisit + printLabReport, без своей
// вёрстки и без своей выборки. Пациента добираем отдельным запросом — в строке
// ленты нет пола и даты рождения, а шапка бланка без них неполная.
async function printVisitFromFeed(r, btn) {
    // span-кнопка (см. feedRow): .disabled у span нет, гасим кликабельность руками.
    if (btn) { btn.style.pointerEvents = 'none'; btn.style.opacity = '0.55'; }
    try {
        const [brand, labByVisit, visitRes, patientRes] = await Promise.all([
            getBrand(),
            fetchLabByVisit([r.visit_id]),
            supabase.from('visits').select('id,visit_date,visit_type,status,conclusion,conclusion_type,doctor_id').eq('id', r.visit_id).single(),
            supabase.from('patients').select('id, full_name, mrn, phone, gender, date_of_birth').eq('id', r.patient_id).single(),
        ]);
        const visit = visitRes.data;
        if (visitRes.error || !visit) throw new Error((visitRes.error && visitRes.error.message) || 'Визит не найден.');
        const patient = patientRes.data || { id: r.patient_id, full_name: r.patient_name, mrn: r.mrn };
        const results = labByVisit[r.visit_id] || [];
        if (!results.length) return toast('Результатов нет — печатать нечего.', 'info');

        // printLabReport читает имя врача из state.docs.doctorMap — заполним его
        // для этого визита, не трогая выбранного пациента.
        if (visit.doctor_id && !state.docs.doctorMap[visit.doctor_id]) {
            try {
                const { data } = await supabase.from('users').select('id,full_name').eq('id', visit.doctor_id).single();
                if (data) state.docs.doctorMap[visit.doctor_id] = data.full_name;
            } catch (e) { /* бланк печатается и без имени врача */ }
        }
        await printLabReport(visit, results, brand, patient);
    } catch (e) {
        toast('Не удалось напечатать: ' + ((e && e.message) || e), 'fail');
    } finally {
        if (btn) { btn.style.pointerEvents = ''; btn.style.opacity = ''; }
    }
}
