// DOC_HISTORY_V1 (3.25.0, решение владельца) — ОКНО «ИСТОРИЯ ИЗМЕНЕНИЙ» ДОКУМЕНТА ПРИЁМА.
//
// Открывается из кабинета врача (кнопка у «Сохранить» / «Завершить приём»,
// service-workspace.js) и из списка документов карты пациента (patient-card.js).
// Слева — версии документа строки (rpc document_history_list): когда, кто (имя и
// роль; при входе «от имени» — администратор «вместо» сотрудника), вид версии,
// какие разделы изменились. Одна отмеченная версия — показ только для чтения
// (rpc document_history_get); две — сравнение по разделам: убранное и добавленное.
//
// Видят историю врач строки, главный врач и администратор — проверяет сервер
// (rpc/doc-history.js); кнопку остальным экран просто не показывает
// (canSeeDocHistory, то же правило). Текст врача в окно попадает только через
// общую очистку разметки (shared/rich-text.js sanitizeStoredHtml), а в сравнении —
// простым текстом (htmlToText → текстовые узлы): сохранённая разметка не
// вставляется в страницу как есть.
import { supabase } from '../../supabase.js';
import { h, Icon, fmtDateTime } from '../ui.js';
import { tr, trf } from '../i18n.js';
import { currentUser } from '../data.js';
import {
    canSeeDocHistory, DOC_REVISION_KIND_LABELS, DOC_TYPE_LABELS, DOC_LIST_SECTIONS, docSectionLabel,
    docSectionKeys, listItemsText, wordDiff,
} from '../../shared/doc-history.js';
import { sanitizeStoredHtml, htmlToText } from '../../shared/rich-text.js';

const ROLE_LABELS = Object.freeze({
    admin: 'Администратор', registrar: 'Регистратор', doctor: 'Врач', nurse: 'Медсестра', senior_nurse: 'Старшая медсестра',
    head_doctor: 'Главный врач', lab: 'Лаборант', cashier: 'Кассир', inventory: 'Склад', callcenter: 'Оператор колл-центра',
});
const KIND_TONE = Object.freeze({
    baseline: ['var(--ink-50, #f4f4f5)', 'var(--ink-700, #3f3f46)'],
    draft: ['var(--info-50, #eff6ff)', 'var(--info-700, #1d4ed8)'],
    signed: ['var(--ok-50, #f0fdf4)', 'var(--ok-700, #15803d)'],
    amended: ['var(--warn-50, #fffbeb)', 'var(--warn-700, #b45309)'],
    nurse: ['var(--primary-50, #f0f9ff)', 'var(--primary-700, #0369a1)'],
    lists: ['var(--ink-50, #f4f4f5)', 'var(--ink-700, #3f3f46)'],
});
const DEL_STYLE = { background: 'var(--crit-50, #fef2f2)', color: 'var(--crit-700, #b91c1c)', textDecoration: 'line-through' };
const INS_STYLE = { background: 'var(--ok-50, #f0fdf4)', color: 'var(--ok-700, #15803d)' };
// Текст врача — текстовым узлом: h() переводит строки-дети через tr(), а чужой текст переводить нельзя.
const txt = (s) => document.createTextNode(String(s == null ? '' : s));

/** Видна ли история строки тому, кто сейчас вошёл (сервер проверит сам). */
export function canSeeLineHistory(lineDoctorId, user = currentUser()) {
    return canSeeDocHistory(user, lineDoctorId);
}

/** Кто записал версию — словами: имя и роль; при входе «от имени» — администратор вместо сотрудника. */
export function revisionWho(rev) {
    if (!rev || (!rev.user && !rev.acting_admin)) return tr('до журнала изменений');
    const u = rev.user || {};
    const role = u.role ? tr(ROLE_LABELS[u.role] || u.role) : '';
    const person = role ? trf('{name} ({role})', { name: u.name || '—', role }) : (u.name || '—');
    if (rev.acting_admin) return trf('{admin} (администратор) вместо {name}', { admin: rev.acting_admin.name || '—', name: person });
    return person;
}

/** Что изменилось — подписями разделов (снимки — с числом добавленных и убранных). */
export function revisionChanges(rev, snap = null) {
    if (rev.kind === 'baseline') return tr('документ, написанный до обновления программы');
    const parts = (rev.sections || []).map((k) => (k === 'images'
        ? trf('Снимки: +{added} / −{removed}', { added: rev.images_added || 0, removed: rev.images_removed || 0 })
        : tr(docSectionLabel(k, snap || { docType: rev.doc_type }))));
    return parts.length ? parts.join(', ') : tr('содержание то же');
}

function kindTag(kind) {
    const [bg, fg] = KIND_TONE[kind] || KIND_TONE.draft;
    return h('span', { 'data-dh-kind': kind, style: { display: 'inline-block', padding: '1px 8px', borderRadius: '999px', background: bg, color: fg, fontSize: '12px', fontWeight: 600, whiteSpace: 'nowrap' } },
        DOC_REVISION_KIND_LABELS[kind] || kind);
}

function sectionBlock(key, label, ...content) {
    return h('div', { 'data-dh-section': key, style: { marginBottom: '12px' } },
        h('div', { class: 'muted', style: { fontSize: '12.5px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '4px' } }, txt(label)),
        ...content);
}
const boxStyle = { fontSize: '13.5px', padding: '8px 10px', background: 'var(--ink-25, #fafafa)', border: '1px solid var(--ink-100, #e4e4e7)', borderRadius: '7px', wordBreak: 'break-word' };

/** Одна версия — только для чтения. Экспорт — для проверки. */
export function renderRevisionView(rev, snap) {
    const s = snap || {};
    const out = h('div', { 'data-dh-view': String(rev.id) },
        h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '10px' } },
            h('b', null, trf('Версия {n}', { n: rev.rev_no })), kindTag(rev.kind),
            h('span', { class: 'muted num', style: { fontSize: '12.5px' } }, txt(fmtDateTime(rev.created_at))),
            h('span', { class: 'muted', style: { fontSize: '12.5px' } }, txt(revisionWho(rev)))),
        h('div', { class: 'muted', style: { fontSize: '12.5px', marginBottom: '10px' } },
            trf('Тип документа: {type}', { type: tr(DOC_TYPE_LABELS[s.docType] || DOC_TYPE_LABELS.conclusion) })));
    const keys = docSectionKeys(s);
    if (!keys.length) out.appendChild(h('div', { class: 'muted' }, 'Документ пуст.'));
    for (const k of keys) {
        const label = tr(docSectionLabel(k, s));
        if (DOC_LIST_SECTIONS.includes(k)) {
            out.appendChild(sectionBlock(k, label, h('ul', { style: { margin: 0, paddingLeft: '18px' } },
                ...listItemsText(k, s[k], tr).map((line) => h('li', null, txt(line))))));
        } else if (k === 'images') {
            out.appendChild(sectionBlock(k, label, h('div', null, trf('Снимков: {n}', { n: (s.images || []).length }))));
        } else if (k === 'nurseNote') {
            out.appendChild(sectionBlock(k, label, h('div', { style: { ...boxStyle, whiteSpace: 'pre-wrap' } }, txt(s.nurseNote))));
        } else {
            const v = s.fields ? s.fields[k] : '';
            // Разметка врача — только после общей очистки (те же правила, что у бланка и сервера).
            out.appendChild(sectionBlock(k, label, h('div', { class: 'dh-rich', style: boxStyle, html: sanitizeStoredHtml(typeof v === 'string' ? v : String(v == null ? '' : v)) })));
        }
    }
    for (const sg of (s.signed || [])) {
        out.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px' } },
            trf('Подписано в документе: {name}, {when}', { name: sg.byName || '—', when: sg.at ? fmtDateTime(sg.at) : '—' })));
    }
    return out;
}

function diffNodes(parts) {
    return parts.map((p) => (p.op === 'eq' ? txt(p.text)
        : h(p.op === 'del' ? 'del' : 'ins', { [p.op === 'del' ? 'data-dh-del' : 'data-dh-ins']: '', style: p.op === 'del' ? DEL_STYLE : { ...INS_STYLE, textDecoration: 'none' } }, txt(p.text))));
}
function listDiff(a, b) {
    const left = new Map();
    for (const x of a) left.set(x, (left.get(x) || 0) + 1);
    const rows = [];
    for (const x of b) {
        if (left.get(x)) { left.set(x, left.get(x) - 1); rows.push(['eq', x]); } else rows.push(['ins', x]);
    }
    for (const [x, n] of left) for (let i = 0; i < n; i++) rows.unshift(['del', x]);
    return rows;
}

/** Две версии — сравнение по разделам (a — старше, b — новее). Экспорт — для проверки. */
export function renderRevisionCompare(revA, snapA, revB, snapB) {
    const A = snapA || {}, B = snapB || {};
    const out = h('div', { 'data-dh-compare': revA.id + ':' + revB.id },
        h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '6px' } },
            h('b', null, trf('Версия {a} → версия {b}', { a: revA.rev_no, b: revB.rev_no }))),
        h('div', { class: 'muted', style: { fontSize: '12.5px', marginBottom: '12px', display: 'flex', gap: '10px', flexWrap: 'wrap' } },
            h('span', { style: DEL_STYLE }, 'убрано'), h('span', { style: INS_STYLE }, 'добавлено')));
    const keys = [...new Set([...docSectionKeys(A), ...docSectionKeys(B)])];
    if ((A.docType || 'conclusion') !== (B.docType || 'conclusion')) keys.push('docType');
    const same = [];
    let changed = 0;
    for (const k of keys) {
        const label = tr(docSectionLabel(k, B.fields && (B.fields[k] != null || B.fields[k + '__title'] != null) ? B : A));
        if (DOC_LIST_SECTIONS.includes(k)) {
            const rows = listDiff(listItemsText(k, A[k], tr), listItemsText(k, B[k], tr));
            if (rows.every(([op]) => op === 'eq')) { same.push(label); continue; }
            out.appendChild(sectionBlock(k, label, h('ul', { style: { margin: 0, paddingLeft: '18px' } },
                ...rows.map(([op, line]) => h('li', null, op === 'eq' ? txt(line) : diffNodes([{ op, text: line }]))))));
        } else if (k === 'images') {
            const a = A.images || [], b = B.images || [];
            const added = listDiff(a, b).filter(([op]) => op === 'ins').length;
            const removed = listDiff(a, b).filter(([op]) => op === 'del').length;
            if (!added && !removed) { same.push(label); continue; }
            out.appendChild(sectionBlock(k, label, h('div', null,
                trf('Было снимков: {a}, стало: {b} (добавлено {added}, убрано {removed})', { a: a.length, b: b.length, added, removed }))));
        } else if (k === 'docType') {
            out.appendChild(sectionBlock(k, label, h('div', null,
                trf('{from} → {to}', { from: tr(DOC_TYPE_LABELS[A.docType] || DOC_TYPE_LABELS.conclusion), to: tr(DOC_TYPE_LABELS[B.docType] || DOC_TYPE_LABELS.conclusion) }))));
        } else {
            const ta = k === 'nurseNote' ? String(A.nurseNote || '') : htmlToText((A.fields || {})[k]);
            const tb = k === 'nurseNote' ? String(B.nurseNote || '') : htmlToText((B.fields || {})[k]);
            const titleA = (A.fields || {})[k + '__title'], titleB = (B.fields || {})[k + '__title'];
            if (ta === tb && titleA === titleB) { same.push(label); continue; }
            const block = sectionBlock(k, label);
            if (titleA !== titleB && (titleA || titleB)) {
                block.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px', marginBottom: '4px' } }, diffNodes(wordDiff(String(titleA || ''), String(titleB || '')))));
            }
            block.appendChild(h('div', { style: { ...boxStyle, whiteSpace: 'pre-wrap' } }, diffNodes(wordDiff(ta, tb))));
            out.appendChild(block);
        }
        changed++;
    }
    if (!changed) out.appendChild(h('div', { 'data-dh-nodiff': '', class: 'muted' }, 'Содержание этих версий одинаково.'));
    if (same.length) out.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '8px' } }, trf('Без изменений: {list}', { list: same.join(', ') })));
    return out;
}

/**
 * Открыть окно истории строки. → { overlay, close, ready, select(id) } — ready
 * (список загружен) и select (отметить / снять версию; промис — правая часть
 * дорисована) нужны проверкам.
 */
export function openDocHistoryModal({ visitServiceId, title = '' } = {}) {
    const overlay = h('div', { class: 'modal', 'data-doc-history': String(visitServiceId), style: { zIndex: '150' } });
    const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));
    const listEl = h('div', { 'data-dh-list': '', style: { flex: '0 0 300px', maxWidth: '100%', overflow: 'auto', maxHeight: '70vh', display: 'flex', flexDirection: 'column', gap: '6px' } },
        h('div', { class: 'muted' }, 'Загрузка…'));
    const pane = h('div', { 'data-dh-pane': '', style: { flex: '1 1 360px', minWidth: 0, overflow: 'auto', maxHeight: '70vh' } });
    const hint = () => h('div', { class: 'muted', 'data-dh-hint': '' }, 'Отметьте одну версию, чтобы посмотреть её, или две — чтобы сравнить.');
    pane.appendChild(hint());
    const card = h('div', { class: 'modal-card', style: { width: '980px', maxWidth: 'calc(100vw - 32px)' } },
        h('header', { class: 'modal-head' },
            h('div', { class: 'row', style: { gap: '10px', alignItems: 'center' } },
                Icon('Layers', { size: 16 }),
                h('div', null,
                    h('h2', { style: { margin: 0 } }, 'История изменений'),
                    title ? h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '2px' } }, txt(title)) : null)),
            h('button', { class: 'modal-close', onclick: close }, '×')),
        h('div', { class: 'modal-body', style: { display: 'flex', gap: '16px', flexWrap: 'wrap', alignItems: 'flex-start' } }, listEl, pane),
        h('footer', { class: 'modal-foot' }, h('button', { class: 'btn', type: 'button', onclick: close }, 'Закрыть')));
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKey);

    const st = { revs: [], selected: [], snaps: new Map(), boxes: new Map(), seq: 0 };
    const getSnap = async (rev) => {
        if (st.snaps.has(rev.id)) return st.snaps.get(rev.id);
        const { data, error } = await supabase.rpc('document_history_get', { visit_service_id: visitServiceId, id: rev.id });
        if (error) throw error;
        st.snaps.set(rev.id, data && data.snapshot);
        return data && data.snapshot;
    };
    const paintPane = async () => {
        const my = ++st.seq;
        const picked = st.revs.filter((r) => st.selected.includes(r.id)).sort((x, y) => x.rev_no - y.rev_no);
        const show = (node) => { if (my !== st.seq) return; pane.textContent = ''; pane.appendChild(node); };
        if (!picked.length) { show(hint()); return; }
        try {
            const snaps = [];
            for (const r of picked) snaps.push(await getSnap(r));
            show(picked.length === 1 ? renderRevisionView(picked[0], snaps[0]) : renderRevisionCompare(picked[0], snaps[0], picked[1], snaps[1]));
        } catch (e) {
            show(h('div', { class: 'muted', 'data-dh-error': '' }, trf('Версию не загрузить: {msg}', { msg: tr(String((e && e.message) || '')) })));
        }
    };
    const select = (id) => {
        const i = st.selected.indexOf(id);
        if (i >= 0) st.selected.splice(i, 1);
        else {
            st.selected.push(id);
            if (st.selected.length > 2) st.selected.shift();   // третья отметка снимает самую раннюю
        }
        for (const [rid, box] of st.boxes) box.checked = st.selected.includes(rid);
        return paintPane();
    };
    const ready = (async () => {
        const { data, error } = await supabase.rpc('document_history_list', { visit_service_id: visitServiceId });
        listEl.textContent = '';
        if (error) {
            listEl.appendChild(h('div', { class: 'muted', 'data-dh-error': '' }, trf('Историю не загрузить: {msg}', { msg: tr(String(error.message || '')) })));
            return false;
        }
        st.revs = (data && Array.isArray(data.revisions) ? data.revisions : []).slice().sort((x, y) => y.rev_no - x.rev_no);
        if (!st.revs.length) {
            listEl.appendChild(h('div', { class: 'muted', 'data-dh-empty': '' }, 'Изменений пока нет: версия появится при первом сохранении документа.'));
            return true;
        }
        for (const rev of st.revs) {
            const box = h('input', { type: 'checkbox', 'data-dh-check': String(rev.id), 'aria-label': trf('Версия {n}', { n: rev.rev_no }) });
            box.addEventListener('change', () => { select(rev.id); });
            st.boxes.set(rev.id, box);
            listEl.appendChild(h('label', { 'data-dh-rev': String(rev.id), style: { display: 'flex', gap: '8px', alignItems: 'flex-start', padding: '8px 10px', border: '1px solid var(--ink-100, #e4e4e7)', borderRadius: '8px', cursor: 'pointer' } },
                box,
                h('div', { style: { minWidth: 0 } },
                    h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' } },
                        h('b', { style: { fontSize: '13px' } }, trf('Версия {n}', { n: rev.rev_no })), kindTag(rev.kind)),
                    h('div', { class: 'muted num', style: { fontSize: '12.5px', marginTop: '2px' } }, txt(fmtDateTime(rev.created_at))),
                    h('div', { style: { fontSize: '12.5px', marginTop: '2px' } }, txt(revisionWho(rev))),
                    h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '2px' } }, txt(revisionChanges(rev))))));
        }
        return true;
    })();
    return { overlay, close, ready, select };
}

/**
 * Кнопка «История изменений» строки — или null, если её истории этому
 * сотруднику не видно. Экспорт — для кабинета и карты пациента.
 */
export function docHistoryButton({ visitServiceId, lineDoctorId, title = '', small = false } = {}) {
    if (!visitServiceId || !canSeeLineHistory(lineDoctorId)) return null;
    return h('button', { class: 'btn btn-outline' + (small ? ' btn-sm' : ''), type: 'button', 'data-doc-history-btn': String(visitServiceId),
        title: 'История изменений документа', onclick: () => { openDocHistoryModal({ visitServiceId, title }); } },
    Icon('Layers', { size: 13 }), small ? null : ' История изменений');
}
