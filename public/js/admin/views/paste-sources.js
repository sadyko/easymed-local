// PASTE_SOURCES_V1 (2026-11-02) — «ВСТАВИТЬ РЕЗУЛЬТАТЫ» КАБИНЕТА ВРАЧА: ОКНО.
//
// Владелец (выпуск 3.21.0): вставить в документ приёма можно было только
// сводку «Осмотр / Диагноз / Рекомендации» завершённых строк, разложенных по
// имени вида услуги. На тестовой клинике диагностика и анализы лежали в
// «Услугах», где вставка выключена; анализ в 'resulted' пропадал; архив
// документов, заключение визита и документы стационара не читались.
//
// Теперь окно спрашивает сервер (rpc patient_doc_sources) и показывает ВСЕ
// документы пациента пятью вкладками: «Консультации», «Диагностика»,
// «Анализы», «Стационар», «Файлы». У документа — разделы с галочками; в
// документ приёма уходит ПОЛНЫЙ текст отмеченных разделов, в поле, которое
// врач выберет («Куда вставить?» кабинета — onInsert). Файлы только
// открываются: их содержимого в ответе нет.
//
// ЗДАНИЕ — как у карты пациента (BRANCH_ORIGIN_V1): результат анализа или
// измерения, приехавший из соседнего здания, подписан «Филиал X» — в окне
// (та же фраза словаря, что у карты) и в тексте вставки, чтобы в документе
// было видно, чья это лаборатория.
//
// У окна нет состояния между открытиями: каждый раз — свежий ответ сервера,
// и поздний ответ одной строки не попадёт в другую (прежняя «история» жила в
// состоянии кабинета — CABINET_FIX_V1_R2, п. 4).
//
// Разметка разделов приходит очищенной с сервера и ещё раз проходит общий
// санитайзер здесь (shared/rich-text.js): второй проход её не меняет, а
// разметка, пришедшая мимо сервера, в документ не попадёт.
import { supabase } from '../../supabase.js';
import { h, Icon, Tag, clear, toast, fmtDate } from '../ui.js';
import { tr, trf } from '../i18n.js';
import { sanitizeStoredHtml, htmlToText } from '../../shared/rich-text.js';
import { docDayText } from '../../shared/cabinet-doc.js';   // PASTE_SOURCES_V1 (ревью L5) — день документа, как у печати (PRINT_VISIT_DATE_V1)
import { BRANCH_BUCKET, signedUrl } from '../storage.js?v=aurora20b';   // тот же адрес, что у кабинета и карты (один экземпляр)
import { CASE_DOC_TITLE } from './case-docs.js?v=cw1';   // имена родов истории болезни — тот же словарь, что у стационара

/** Вкладки окна — группы ответа сервера; field — поле «рекомендуется» в «Куда вставить?». */
export const PASTE_TABS = Object.freeze([
    { key: 'consult',   label: 'Консультации', icon: 'Stethoscope', field: 'physical_exam' },
    { key: 'diag',      label: 'Диагностика',  icon: 'Activity',    field: 'instrumental_text' },
    { key: 'labs',      label: 'Анализы',      icon: 'Flask',       field: 'labs_text' },
    { key: 'inpatient', label: 'Стационар',    icon: 'Bed',         field: 'hpi' },
    { key: 'files',     label: 'Файлы',        icon: 'Folder',      field: null },
]);

const FLAGGED = new Set(['high', 'low', 'critical', 'abnormal']);
const PREVIEW_MAX = 400;
const pad2 = (n) => String(n).padStart(2, '0');
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// Данные пациента (текст разделов, имена, даты) — узлом текста, мимо словаря.
const txt = (s) => document.createTextNode(String(s == null ? '' : s));
// PASTE_SOURCES_V1 (ревью L4) — открыто ли поверх этого окна другое (.modal позже в <body>).
function modalAbove(overlay) {
    const kids = Array.from((document.body && document.body.children) || []);
    const i = kids.indexOf(overlay);
    return i >= 0 && kids.slice(i + 1).some((k) => k && k.classList && k.classList.contains('modal'));
}

/** День документа для текста вставки — местный, «дд.мм.гггг» (документ — по-русски). */
export function docDay(iso) {
    if (!iso) return '';
    const s = String(iso);
    const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? s + 'T12:00:00' : s);
    return isNaN(d.getTime()) ? '' : pad2(d.getDate()) + '.' + pad2(d.getMonth() + 1) + '.' + d.getFullYear();
}

/** Название документа. У записи стационара встроенного рода сервер имени не шлёт — оно в словаре истории болезни. */
export function docTitle(doc) {
    if (!doc) return '';
    if (doc.kind === 'inpatient') return String(doc.title || '').trim() || CASE_DOC_TITLE[doc.doc_kind] || CASE_DOC_TITLE.other;
    return String(doc.title || '');
}

/* i18n-exempt-start: текст вставки («Филиал X», «(не проверено)», таблица показателей) уходит В ДОКУМЕНТ приёма — содержимое бланка, не текст экрана */
// Документ — по-русски, как и прежние вставки кабинета: буква филиала — той же фразой, что у карты.
const branchRu = (letter) => (letter ? 'Филиал ' + letter : '');

/**
 * PASTE_SOURCES_V1 (ревью L5) — ДЕНЬ ДОКУМЕНТА в заголовке вставки — тот же, что
 * печатает карта пациента (PRINT_VISIT_DATE_V1), а не время последней подписи:
 * переподписанный через неделю протокол вставлялся «неделей позже». Копия архива —
 * день, напечатанный на ней (issueDate, ДД.ММ.ГГГГ); запись строки — docDayText:
 * день визита, но не позже ПЕРВОЙ подписи; у прочих (анализы, стационар, заключение
 * визита) — день документа, как раньше. День считается здесь, на компьютере врача.
 */
export function insertDay(doc) {
    if (!doc) return '';
    const printed = typeof doc.issue_date === 'string' ? doc.issue_date.trim() : '';
    if (/^\d{2}\.\d{2}\.\d{4}$/.test(printed)) return printed;
    if (doc.visit_date || doc.first_signed_at) {
        const first = doc.first_signed_at || (doc.source === 'archive' ? doc.at : null);
        const day = docDayText({ visitDate: doc.visit_date || null, history: first ? [{ kind: 'signed', savedAt: first }] : null });
        if (day) return day;
    }
    return docDay(doc.at);
}

function headHtml(doc) {
    const meta = [insertDay(doc), doc.doctor, branchRu(doc.origin)].filter(Boolean).join(', ');
    return '<div><b>' + esc(docTitle(doc)) + '</b>' + (meta ? ' — ' + esc(meta) : '') + '</div>';
}

// PASTE_SOURCES_V1 (ревью L2, L3) — пометки раздела: «Измерения» своего исследования,
// результат которых приехал из другого здания (буква — если не та, что у документа),
// и введённые, но не проверенные лабораторией — как у панели анализа.
function sectionMarks(doc, s) {
    return [s.origin && s.origin !== (doc && doc.origin) ? branchRu(s.origin) : '', s.unverified ? 'не проверено' : ''].filter(Boolean);
}

/**
 * Вставка текстового документа: заголовок («Название — дд.мм.гггг, врач») и
 * отмеченные разделы ЦЕЛИКОМ. Ничего не отмечено — ''.
 */
export function docInsertHtml(doc, keys) {
    const want = new Set(keys || []);
    const parts = ((doc && doc.sections) || []).filter((s) => want.has(s.key))
        .map((s) => {
            const marks = sectionMarks(doc, s);
            return '<div><b>' + esc(s.label) + (marks.length ? ' (' + esc(marks.join(', ')) + ')' : '') + ':</b></div>' + sanitizeStoredHtml(s.html);
        });
    return parts.length ? headHtml(doc) + parts.join('') : '';
}

/**
 * Вставка анализов визита: заголовок и по таблице на каждый анализ с
 * отмеченными показателями (ключ «анализ:показатель», '0:1'). Отклонение от
 * нормы — жирным; непроверенный анализ так и подписан в документе; анализ
 * другого здания — буквой филиала (у заголовка, если она у всего визита одна).
 */
export function labInsertHtml(doc, keys) {
    const want = new Set(keys || []);
    const blocks = ((doc && doc.panels) || []).map((p, pi) => {
        const rows = (p.rows || []).filter((_, ri) => want.has(pi + ':' + ri));
        if (!rows.length) return '';
        const body = rows.map((r) => {
            const v = esc(r.value) + (r.unit ? ' ' + esc(r.unit) : '');
            return '<tr><td>' + esc(r.parameter) + '</td><td>' + (FLAGGED.has(String(r.flag || '').toLowerCase()) ? '<b>' + v + '</b>' : v)
                + '</td><td>' + esc(r.reference_range || '') + '</td></tr>';
        }).join('');
        const marks = [p.origin && p.origin !== doc.origin ? branchRu(p.origin) : '', p.unverified ? 'не проверено' : ''].filter(Boolean);
        return '<div><b>' + esc(p.title || '') + (marks.length ? ' (' + esc(marks.join(', ')) + ')' : '') + '</b></div>'
            + '<table class="a4-restbl"><thead><tr><th>Показатель</th><th>Результат</th><th>Норма</th></tr></thead><tbody>' + body + '</tbody></table>';
    }).filter(Boolean);
    return blocks.length ? headHtml(doc) + blocks.join('') : '';
}
/* i18n-exempt-end */

/** Документы пациента для окна. → { data, error } — ответ rpc patient_doc_sources. */
export function loadPasteSources(patientId, excludeVisitServiceId = null) {
    return supabase.rpc('patient_doc_sources', { patient_id: patientId, exclude_visit_service_id: excludeVisitServiceId || null });
}

// I18N_COVERAGE_V1 — отказ сервера: сначала шаблон, потом значения (как rpcMsg карты пациента).
function errorText(error) {
    if (!error) return tr('нет ответа');
    const params = {};
    for (const [k, v] of Object.entries(error.params || {})) params[k] = typeof v === 'string' ? tr(v) : v;
    return trf(error.message || 'нет ответа', params);
}

function preview(html) {
    const t = htmlToText(sanitizeStoredHtml(html));
    return t.length > PREVIEW_MAX ? t.slice(0, PREVIEW_MAX) + '…' : t;
}

function note(text, color = null) {
    return h('div', { class: 'muted', style: { padding: '14px 16px', fontSize: '12.5px', ...(color ? { color } : {}) } }, text);
}

// BRANCH_ORIGIN_V1 — та же метка, что у карты пациента: «Филиал X» (буква — после перевода).
function branchTag(letter) {
    return letter ? Tag(txt(trf('Филиал {letter}', { letter }))) : null;
}

function metaLine(doc) {
    const bits = [doc.at ? fmtDate(doc.at) : '', doc.doctor || ''];
    if (doc.admission_no) bits.push(trf('Госпитализация № {no}', { no: doc.admission_no }));
    return bits.filter(Boolean).join(' · ');
}

// Галочка: в браузере — её состояние, в стенде без DOM — переключение.
function toggleOn(e, chosen, key) {
    const t = e && e.currentTarget;
    return t && typeof t.checked === 'boolean' ? t.checked : !chosen.has(key);
}

function docHead(doc) {
    return [
        h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
            h('b', { style: { fontSize: '13.5px' } }, docTitle(doc) || '—'),
            branchTag(doc.origin),
            doc.unverified ? Tag('не проверено', { kind: 'warn', dot: true }) : null),
        h('div', { class: 'muted', style: { fontSize: '12.5px', margin: '2px 0 6px' } }, txt(metaLine(doc))),
    ];
}

function insertButton(doc, onClick) {
    return h('div', { style: { marginTop: '8px' } },
        h('button', { class: 'btn btn-primary btn-sm', type: 'button', 'data-paste-insert': doc.id, onclick: onClick },
            Icon('Plus', { size: 13 }), ' ', 'Вставить выбранное'));
}

function docCard(doc, tab, onInsert) {
    const chosen = new Set((doc.sections || []).map((s) => s.key));
    const secs = (doc.sections || []).map((s) => {
        const cb = h('input', { type: 'checkbox', checked: true, 'data-paste-sec': s.key });
        cb.addEventListener('change', (e) => { if (toggleOn(e, chosen, s.key)) chosen.add(s.key); else chosen.delete(s.key); });
        return h('label', { style: { display: 'block', padding: '6px 0', cursor: 'pointer' } },
            h('span', { 'data-paste-seclabel': s.key, style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', fontWeight: 600, fontSize: '12.5px' } }, cb, s.label,
                s.origin && s.origin !== doc.origin ? branchTag(s.origin) : null,       // ревью L2
                s.unverified ? Tag('не проверено', { kind: 'warn', dot: true }) : null),   // ревью L3
            h('div', { class: 'muted', style: { fontSize: '12.5px', whiteSpace: 'pre-wrap', margin: '2px 0 0 24px', lineHeight: '1.45' } }, txt(preview(s.html))),
            // ревью L1 — раздел длиннее предела ответа сокращён (или потерял оформление): врач видит это до вставки.
            s.cut ? h('div', { 'data-paste-cut': s.key, style: { fontSize: '12.5px', margin: '2px 0 0 24px', color: 'var(--warn-700)' } },
                Icon('Info', { size: 12 }), ' ', 'Раздел сокращён — полный текст в карте пациента') : null);
    });
    return h('div', { 'data-paste-doc': doc.id, style: { padding: '12px 16px', borderTop: '1px solid var(--ink-100)' } },
        ...docHead(doc), ...secs,
        insertButton(doc, () => {
            const html = docInsertHtml(doc, [...chosen]);
            if (!html) { toast('Выберите хотя бы один раздел', 'warn'); return; }
            if (onInsert) onInsert(html, tab.field);
        }));
}

function labCard(doc, tab, onInsert) {
    const chosen = new Set();
    const blocks = (doc.panels || []).map((p, pi) => {
        const tbody = h('tbody');
        (p.rows || []).forEach((r, ri) => {
            const key = pi + ':' + ri;
            chosen.add(key);
            const cb = h('input', { type: 'checkbox', checked: true, 'data-paste-row': key });
            cb.addEventListener('change', (e) => { if (toggleOn(e, chosen, key)) chosen.add(key); else chosen.delete(key); });
            const flagged = FLAGGED.has(String(r.flag || '').toLowerCase());
            tbody.appendChild(h('tr', null,
                h('td', { style: { width: '28px' } }, cb),
                h('td', null, txt(r.parameter)),
                h('td', { style: flagged ? { fontWeight: '700', color: 'var(--crit-700)' } : {} },
                    txt(String(r.value == null ? '' : r.value) + (r.unit ? ' ' + r.unit : ''))),
                h('td', { class: 'muted' }, txt(r.reference_range || '—'))));
        });
        return h('div', { 'data-paste-panel': String(p.visit_service_id), style: { marginTop: '8px' } },
            h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', fontWeight: 600, fontSize: '12.5px' } },
                txt(p.title || ''),
                p.origin && p.origin !== doc.origin ? branchTag(p.origin) : null,
                p.unverified ? Tag('не проверено', { kind: 'warn', dot: true }) : null),
            h('table', { class: 'tbl', style: { fontSize: '12.5px', marginTop: '4px' } },
                h('thead', null, h('tr', null, h('th', null, ''), h('th', null, 'Показатель'), h('th', null, 'Результат'), h('th', null, 'Норма'))),
                tbody));
    });
    return h('div', { 'data-paste-doc': doc.id, style: { padding: '12px 16px', borderTop: '1px solid var(--ink-100)' } },
        ...docHead(doc), ...blocks,
        insertButton(doc, () => {
            const html = labInsertHtml(doc, [...chosen]);
            if (!html) { toast('Выберите хотя бы один показатель', 'warn'); return; }
            if (onInsert) onInsert(html, tab.field);
        }));
}

function fileRow(doc) {
    const open = h('button', { class: 'btn btn-outline btn-sm', type: 'button', 'data-paste-open': doc.id, onclick: async () => {
        // Файлы не ездят между зданиями — та же правда, что у карты пациента.
        if (doc.file_available === false) {
            toast('Файл лежит на том компьютере, где его загрузили, — на этом его нет. Откройте карту в том здании или восстановите из резервной копии.', 'fail');
            return;
        }
        const url = await signedUrl(BRANCH_BUCKET, doc.file_path);
        if (url) window.open(url, '_blank'); else toast('Файл недоступен.', 'fail');
    } }, Icon('Link', { size: 13 }), ' ', 'Открыть');
    return h('div', { 'data-paste-doc': doc.id, style: { padding: '10px 16px', borderTop: '1px solid var(--ink-100)', display: 'flex', alignItems: 'center', gap: '10px' } },
        Icon('Doc', { size: 14 }),
        h('div', { style: { flex: '1', minWidth: '0' } },
            h('div', { style: { fontWeight: 600, fontSize: '13.5px', wordBreak: 'break-word' } }, txt(doc.title || doc.file_name || '—')),
            h('div', { class: 'muted', style: { fontSize: '12.5px' } }, txt(metaLine(doc)))),
        open);
}

/**
 * Окно «Вставить результаты».
 * @param {{patientId:number, excludeVisitServiceId?:number|null,
 *          onInsert:(html:string, field:string|null) => void}} opts
 * @returns {{overlay: Node, close: () => void, ready: Promise<void>}} ready — для проверки
 */
export function openPasteSourcesModal({ patientId, excludeVisitServiceId = null, onInsert = null } = {}) {
    const state = { tab: PASTE_TABS[0].key, data: null, error: null, picked: false };
    const overlay = h('div', { class: 'modal', 'data-paste-sources': '', style: { zIndex: '140' } });
    // PASTE_SOURCES_V1 (ревью L4) — Escape закрывает только ВЕРХНЕЕ окно: над этим
    // открывается «Куда вставить?», и Escape в нём закрывал и его, и это окно с галочками.
    const onKey = (e) => { if (e.key === 'Escape' && !modalAbove(overlay)) close(); };
    function close() { overlay.remove(); document.removeEventListener('keydown', onKey); }
    document.addEventListener('keydown', onKey);
    // PASTE_SOURCES_V1 (ревью L6) — пять равных колонок сетки не помещались на телефоне
    // (подпись с числом шире колонки): строка вкладок переносится, подпись не ломается.
    const tabsEl = h('div', { class: 'segmented', role: 'tablist', style: { margin: '12px 14px 0', display: 'flex', flexWrap: 'wrap' } });
    const body = h('div', { class: 'modal-body', 'data-paste-body': '', style: { padding: '0', maxHeight: '62vh', overflowY: 'auto' } });
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));
    overlay.appendChild(h('div', { class: 'modal-card', role: 'dialog', 'aria-label': 'Вставить результаты', style: { width: '720px', maxWidth: 'calc(100vw - 32px)' } },
        h('header', { class: 'modal-head' },
            h('h2', null, Icon('Doc', { size: 16 }), ' ', 'Вставить результаты',
                h('span', { class: 'muted', style: { fontSize: '12.5px', fontWeight: '400', marginLeft: '8px' } }, 'отметьте разделы и нажмите «Вставить выбранное»')),
            h('button', { class: 'modal-close', type: 'button', onclick: close }, '×')),
        tabsEl, body));
    document.body.appendChild(overlay);

    // null — вкладка закрыта для роли; нет ключа или не массив — пусто.
    const groupOf = (key) => {
        const g = state.data && state.data.groups ? state.data.groups[key] : undefined;
        if (g === null) return null;
        return Array.isArray(g) ? g : [];
    };
    function paintTabs() {
        clear(tabsEl);
        for (const t of PASTE_TABS) {
            const list = state.data ? groupOf(t.key) : [];
            const n = Array.isArray(list) ? list.length : 0;
            const on = t.key === state.tab;
            tabsEl.appendChild(h('button', {
                type: 'button', role: 'tab', 'data-paste-tab': t.key, class: on ? 'on' : '', 'aria-selected': on ? 'true' : 'false',
                style: { flex: '1 1 auto', whiteSpace: 'nowrap' },
                onclick: () => { state.tab = t.key; state.picked = true; paintTabs(); paintBody(); },
            }, Icon(t.icon, { size: 13 }), ' ', t.label, n ? h('span', { class: 'num', style: { marginLeft: '6px', fontWeight: 700 } }, String(n)) : null));
        }
    }
    function paintBody() {
        clear(body);
        if (state.error) { body.appendChild(note(trf('Не удалось загрузить документы пациента: {msg}', { msg: state.error }), 'var(--crit-700)')); return; }
        if (!state.data) { body.appendChild(note('Загрузка…')); return; }
        const tab = PASTE_TABS.find((t) => t.key === state.tab) || PASTE_TABS[0];
        const list = groupOf(tab.key);
        if (list === null) { body.appendChild(note('Этот раздел закрыт для вашей роли.')); return; }
        // PASTE_SOURCES_V1 (ревью M2) — группа, обрезанная пределом ответа до нуля, не
        // «пуста»: документы есть, они в карте пациента.
        const cut = !!(state.data.truncated && state.data.truncated[tab.key]);
        if (!list.length && !cut) { body.appendChild(note('Документов этого вида у пациента пока нет.')); return; }
        for (const doc of list) {
            body.appendChild(tab.key === 'files' ? fileRow(doc) : tab.key === 'labs' ? labCard(doc, tab, onInsert) : docCard(doc, tab, onInsert));
        }
        if (cut) body.appendChild(note(trf('Показаны последние {n}. Остальные — в карте пациента.', { n: list.length })));
    }
    paintTabs();
    paintBody();
    const ready = Promise.resolve()
        .then(() => loadPasteSources(patientId, excludeVisitServiceId))
        .then((res) => {
            const { data, error } = res || {};
            if (error || !data) state.error = errorText(error);
            else {
                state.data = data;
                // ревью (NIT) — «Консультации» пусты или закрыты: открыта первая вкладка с документами
                // (если врач, пока шёл ответ, сам не выбрал вкладку).
                const has = (k) => { const g = groupOf(k); return Array.isArray(g) && g.length > 0; };
                if (!state.picked && !has(state.tab)) { const first = PASTE_TABS.find((t) => has(t.key)); if (first) state.tab = first.key; }
            }
        })
        .catch((e) => { state.error = (e && e.message) || String(e); })
        .then(() => { paintTabs(); paintBody(); });
    return { overlay, close, ready };
}
