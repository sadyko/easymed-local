// DOC_HISTORY_V1 (3.25.0, решение владельца) — ИСТОРИЯ ИЗМЕНЕНИЙ ДОКУМЕНТА ПРИЁМА:
// ПРАВИЛА, ОБЩИЕ ДЛЯ СЕРВЕРА И ЭКРАНА.
//
// Документ приёма (visit_services.notes, JSON кабинета — shared/cabinet-notes.js)
// браузер пишет целиком. Каждая запись, которая МЕНЯЕТ содержание документа,
// оставляет на сервере неизменяемую версию (таблица visit_document_revisions,
// миграция 289; пишет services/domain/doc-history.js в той же транзакции, что и
// сама запись). Здесь — чистые функции без базы и без DOM:
//   • что такое содержание документа (поля, назначения, диагнозы, услуги, тип,
//     заметка медсестры; снимки — только отпечатками) и его отпечаток;
//   • снимок версии (содержание + кто и когда подписывал — по записи документа);
//   • какие разделы изменились и сколько снимков добавлено / убрано;
//   • вид версии (черновик, подпись, исправление после подписи, отметка
//     медсестры, изменение назначений и диагнозов);
//   • подписи разделов и сравнение текста по словам — для окна «История изменений».
// История черновиков в JSON (history[]) — не содержание: тот же текст, сохранённый
// ещё раз, версии не оставляет.
import { NOTES_TAG, notesBaseOf, stableJson, storedIsCabinet, signedEntryAdded } from './cabinet-notes.js';

/** Виды версии (CHECK миграции 289 — тот же список). */
export const DOC_REVISION_KINDS = Object.freeze(['baseline', 'draft', 'signed', 'amended', 'nurse', 'lists']);
/** Подписи видов — ключи словаря i18n-strings.js. */
export const DOC_REVISION_KIND_LABELS = Object.freeze({
    baseline: 'Версия до журнала изменений',
    draft: 'Черновик',
    signed: 'Подписан',
    amended: 'Исправлен после подписи',
    nurse: 'Отметка медсестры',
    lists: 'Изменение назначений и диагнозов',
});
/** Разделы-списки документа (вид «Изменение назначений и диагнозов»). */
export const DOC_LIST_SECTIONS = Object.freeze(['prescriptions', 'diagnoses', 'services']);

/** Отказ записи документа не его врачом (сервер: /api/db, 403). */
export const DOC_EDIT_REFUSAL = 'Документ этой услуги меняет только врач, который её оказывает, или администратор.';
/** Отказ чтения истории (сервер: RPC document_history_*, 403). */
export const DOC_HISTORY_DENIED = 'Историю изменений документа видят врач этой услуги, главный врач и администратор.';

/**
 * Кто видит историю документа строки (решение владельца): врач строки (её исполнитель —
 * doctor_id), главный врач (надстроечная роль head_doctor) и администратор. Роли — основная
 * и дополнительные (как server/services/roles.js effectiveRoles). Сервер проверяет это сам
 * (rpc/doc-history.js); экран лишь не показывает кнопку тем, кому откажут.
 */
export function canSeeDocHistory(user, lineDoctorId) {
    if (!user) return false;
    const roles = [user.role, ...(Array.isArray(user.extra_roles) ? user.extra_roles : [])];
    if (roles.includes('admin') || roles.includes('head_doctor')) return true;
    return lineDoctorId != null && user.id != null && Number(lineDoctorId) === Number(user.id);
}

const EMPTY = Object.freeze({ docType: 'conclusion', fields: Object.freeze({}), prescriptions: Object.freeze([]), diagnoses: Object.freeze([]), services: Object.freeze([]), images: Object.freeze([]), nurseNote: '' });

function parse(raw) {
    if (typeof raw !== 'string' || !raw) return null;
    try { const p = JSON.parse(raw); return p && typeof p === 'object' && !Array.isArray(p) ? p : null; } catch { return null; }
}
const arr = (v) => (Array.isArray(v) ? v : []);
const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
// Пустое поле и отсутствующее — одно и то же: '' после «×» у раздела не версия.
function cleanFields(f) {
    const out = {};
    if (!f || typeof f !== 'object' || Array.isArray(f)) return out;
    for (const k of Object.keys(f).sort()) {
        const v = f[k];
        if (v == null) continue;
        if (typeof v === 'string' && v.trim() === '') continue;
        out[k] = v;
    }
    return out;
}

/**
 * Содержание документа строки: null — документа нет (пусто). Текст не кабинета
 * (заметка медсестры до первого сохранения кабинета) — содержание с одной заметкой.
 */
export function docContentOf(raw) {
    const p = parse(raw);
    if (p && p[NOTES_TAG]) {
        return {
            docType: p.docType === 'diag' ? 'diag' : 'conclusion',
            fields: cleanFields(p.current),
            prescriptions: arr(p.prescriptions),
            diagnoses: arr(p.diagnoses),
            services: arr(p.services),
            // Снимки исследования — отпечатки (тот же cyrb53, что у основы записи), данные не копируются.
            images: arr(p.diagImages).filter((x) => typeof x === 'string' && x).map((x) => notesBaseOf(x)),
            nurseNote: str(p.nurseNote).trim(),
        };
    }
    if (raw == null || String(raw).trim() === '') return null;
    return { ...EMPTY, fields: {}, prescriptions: [], diagnoses: [], services: [], images: [], nurseNote: String(raw).trim() };
}

/** Отпечаток содержания (null — как пустой документ). */
export function docContentHash(content) {
    return notesBaseOf(stableJson(content || EMPTY));
}

/** Подписанные версии записи документа: кто и когда (как их записал кабинет). */
export function signedEntriesOf(raw) {
    const p = parse(raw);
    if (!p || !p[NOTES_TAG]) return [];
    return arr(p.history).filter((e) => e && e.kind === 'signed').map((e) => ({
        at: str(e.savedAt), by: e.by == null ? null : e.by, byName: str(e.byName),
    }));
}

/** Снимок версии: содержание и подписи. content — уже посчитанное содержание raw (не считать дважды). */
export function docSnapshotOf(raw, content = undefined) {
    const c = (content !== undefined ? content : docContentOf(raw)) || EMPTY;
    return { v: 1, docType: c.docType, fields: c.fields, prescriptions: c.prescriptions, diagnoses: c.diagnoses,
        services: c.services, images: c.images, nurseNote: c.nurseNote, signed: signedEntriesOf(raw) };
}

/** Раздел поля: заголовок своего раздела врача (free_3__title) — тот же раздел (free_3). */
export function sectionKeyOf(fieldKey) {
    return String(fieldKey).replace(/__title$/, '');
}
const FIELD_ORDER = ['chief_complaint', 'hpi', 'physical_exam', 'labs_text', 'instrumental_text', 'primary_diagnosis', 'icd10',
    'therapy_text', 'recommendations_text', 'conclusion_text', 'follow_up', 'referral', 'doctor_phone'];
function orderedFieldKeys(keys) {
    const known = FIELD_ORDER.filter((k) => keys.includes(k));
    return [...known, ...keys.filter((k) => !FIELD_ORDER.includes(k)).sort()];
}

/** Разделы, которые есть в снимке, по порядку листа: поля (свой раздел — один раз), списки, снимки, заметка медсестры. */
export function docSectionKeys(snap) {
    const s = snap || {};
    const keys = [];
    for (const k of orderedFieldKeys(Object.keys(s.fields || {}))) {
        const sk = sectionKeyOf(k);
        if (!keys.includes(sk)) keys.push(sk);
    }
    for (const k of DOC_LIST_SECTIONS) if (arr(s[k]).length) keys.push(k);
    if (arr(s.images).length) keys.push('images');
    if (str(s.nurseNote).trim()) keys.push('nurseNote');
    return keys;
}

/** Что изменилось между двумя содержаниями: разделы по порядку листа, снимки — добавлено / убрано. */
export function docSectionsChanged(prev, next) {
    const a = prev || EMPTY;
    const b = next || EMPTY;
    const sections = [];
    const add = (k) => { if (!sections.includes(k)) sections.push(k); };
    const keys = [...new Set([...Object.keys(a.fields || {}), ...Object.keys(b.fields || {})])];
    for (const k of orderedFieldKeys(keys)) {
        if (stableJson(a.fields[k] ?? null) !== stableJson(b.fields[k] ?? null)) add(sectionKeyOf(k));
    }
    for (const k of DOC_LIST_SECTIONS) if (stableJson(a[k] || []) !== stableJson(b[k] || [])) add(k);
    const count = (list) => { const m = new Map(); for (const x of list || []) m.set(x, (m.get(x) || 0) + 1); return m; };
    const ca = count(a.images), cb = count(b.images);
    let imagesAdded = 0, imagesRemoved = 0;
    for (const [x, n] of cb) imagesAdded += Math.max(0, n - (ca.get(x) || 0));
    for (const [x, n] of ca) imagesRemoved += Math.max(0, n - (cb.get(x) || 0));
    if (imagesAdded || imagesRemoved) add('images');
    if ((a.nurseNote || '') !== (b.nurseNote || '')) add('nurseNote');
    if ((a.docType || 'conclusion') !== (b.docType || 'conclusion')) add('docType');
    return { sections, imagesAdded, imagesRemoved };
}

/**
 * Вид версии записи prevRaw → nextRaw или null (версии нет: содержание то же и
 * новой подписи нет, или ни то ни другое — не документ кабинета).
 *   via 'nurse' — «Выполнено» процедуры (rpc/procedures.js): отметка медсестры;
 *   документ уже был подписан и содержание изменилось — «Исправлен после подписи»
 *   (причина не спрашивается — решение владельца);
 *   новая подписанная версия — «Подписан» (и переподпись без изменений);
 *   изменились только списки — «Изменение назначений и диагнозов»;
 *   только заметка медсестры — «Отметка медсестры»; иначе — «Черновик».
 */
export function docRevisionKind({ prevRaw, nextRaw, via = 'cabinet', prevContent = undefined, nextContent = undefined }) {
    if (!storedIsCabinet(prevRaw) && !storedIsCabinet(nextRaw)) return null;
    // Содержание, уже посчитанное вызывающим, не считается второй раз (отпечатки снимков — по всем их байтам).
    const pc = prevContent !== undefined ? prevContent : docContentOf(prevRaw);
    const nc = nextContent !== undefined ? nextContent : docContentOf(nextRaw);
    const changed = docContentHash(pc) !== docContentHash(nc);
    const newSigned = signedEntryAdded(typeof prevRaw === 'string' ? prevRaw : null, typeof nextRaw === 'string' ? nextRaw : null);
    if (!changed && !newSigned) return null;
    if (via === 'nurse') return 'nurse';
    if (changed && signedEntriesOf(prevRaw).length > 0) return 'amended';
    if (newSigned) return 'signed';
    const { sections } = docSectionsChanged(pc, nc);
    if (sections.length && sections.every((s) => DOC_LIST_SECTIONS.includes(s))) return 'lists';
    if (sections.length === 1 && sections[0] === 'nurseNote') return 'nurse';
    return 'draft';
}

// Подписи разделов — ключи словаря (экран переводит их через tr()).
const SECTION_LABELS = Object.freeze({
    chief_complaint: 'Жалобы', hpi: 'Анамнез', physical_exam: 'Осмотр', labs_text: 'Лабораторные исследования',
    instrumental_text: 'Инструментальные исследования', primary_diagnosis: 'Диагноз', icd10: 'МКБ-10',
    therapy_text: 'Терапия', recommendations_text: 'Рекомендации', conclusion_text: 'Заключение',
    follow_up: 'Контроль', referral: 'Направление', doctor_phone: 'Тел. врача',
    prescriptions: 'Назначения', diagnoses: 'Диагнозы', services: 'Услуги', images: 'Снимки',
    nurseNote: 'Заметка медсестры', docType: 'Тип документа',
});
// Бланк «Диагностика» называет два поля по-своему (service-workspace.js TPL_DIAG_LABELS).
const DIAG_SECTION_LABELS = Object.freeze({ instrumental_text: 'Описание', primary_diagnosis: 'Заключение' });
/**
 * Подпись раздела. Свой раздел врача — его заголовок из снимка (текст врача,
 * не переводится); без заголовка — «Свой раздел».
 */
export function docSectionLabel(key, snap = null) {
    if (snap && snap.docType === 'diag' && DIAG_SECTION_LABELS[key]) return DIAG_SECTION_LABELS[key];
    if (Object.prototype.hasOwnProperty.call(SECTION_LABELS, key)) return SECTION_LABELS[key];
    if (/^free_\d+$/.test(String(key))) {
        const t = snap && snap.fields ? snap.fields[key + '__title'] : null;
        return typeof t === 'string' && t.trim() ? t.trim() : 'Свой раздел';
    }
    return 'Раздел';
}
/** Вид документа — словами (ключи словаря). */
export const DOC_TYPE_LABELS = Object.freeze({ conclusion: 'Приём', diag: 'Диагностика' });

// Виды диагноза (service-workspace.js DX_TYPE_RU) — ключи словаря.
const DX_TYPE_LABELS = Object.freeze({ main: 'Основной', concomitant: 'Сопутствующий', complication: 'Осложнение', background: 'Фоновый' });
/** Пункты списка документа строками — для просмотра и сравнения. t — перевод экрана. */
export function listItemsText(kind, items, t = (s) => s) {
    return arr(items).map((x) => {
        if (typeof x === 'string') return x;
        if (!x || typeof x !== 'object') return str(x);
        if (kind === 'prescriptions') return ['name', 'dose', 'freq', 'dur', 'notes', 'nurse'].map((k) => str(x[k]).trim()).filter(Boolean).join(' · ');
        if (kind === 'diagnoses') {
            const head = `${str(x.code).trim()} ${str(x.name).trim()}`.trim();
            return DX_TYPE_LABELS[x.type] ? `${head} (${t(DX_TYPE_LABELS[x.type])})` : head;
        }
        return str(x.name).trim() || stableJson(x);
    }).filter((s) => s !== '');
}

// Сравнение текста по словам: общая часть, убранное, добавленное. Таблица LCS
// ограничена; больше — сравнение по строкам, ещё больше — «всё убрано / всё добавлено».
const LCS_CAP = 4000000;
function diffTokens(A, B, push) {
    const n = A.length, m = B.length;
    const W = m + 1;
    const L = new Uint16Array((n + 1) * W);
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            L[i * W + j] = A[i] === B[j] ? L[(i + 1) * W + j + 1] + 1 : Math.max(L[(i + 1) * W + j], L[i * W + j + 1]);
        }
    }
    let i = 0, j = 0;
    while (i < n && j < m) {
        if (A[i] === B[j]) { push('eq', A[i]); i++; j++; }
        else if (L[(i + 1) * W + j] >= L[i * W + j + 1]) { push('del', A[i]); i++; }
        else { push('ins', B[j]); j++; }
    }
    while (i < n) push('del', A[i++]);
    while (j < m) push('ins', B[j++]);
}
/** [{ op: 'eq' | 'del' | 'ins', text }] — склейка частей 'eq'+'del' даёт a, 'eq'+'ins' — b. */
export function wordDiff(a, b) {
    const out = [];
    const push = (op, text) => {
        if (!text) return;
        const last = out[out.length - 1];
        if (last && last.op === op) last.text += text; else out.push({ op, text });
    };
    const split = (s, re) => String(s == null ? '' : s).match(re) || [];
    const run = (A, B, fallback) => {
        let pre = 0;
        while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
        let suf = 0;
        while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
        push('eq', A.slice(0, pre).join(''));
        const a2 = A.slice(pre, A.length - suf), b2 = B.slice(pre, B.length - suf);
        if (a2.length * b2.length <= LCS_CAP) diffTokens(a2, b2, push);
        else if (fallback) fallback(a2.join(''), b2.join(''));
        else { push('del', a2.join('')); push('ins', b2.join('')); }
        push('eq', A.slice(A.length - suf).join(''));
    };
    run(split(a, /\s+|[^\s]+/g), split(b, /\s+|[^\s]+/g),
        (ra, rb) => run(split(ra, /[^\n]*\n|[^\n]+$/g), split(rb, /[^\n]*\n|[^\n]+$/g), null));
    return out;
}
