// INPATIENT_REQUIRED_V1 (2026-11-23) — «НАСТРОЙКИ → СТАЦИОНАР»: ЧТО В СТАЦИОНАРЕ ОБЯЗАТЕЛЬНО.
//
// Владелец: «in the stationary, we have a roadblocks as a unfilled title list,
// reception doctor filling, and others, we need to make some settings for that so
// we can switch the setup of the stationary documents lists as a required, not
// required fields».
//
// Три карточки и журнал:
//   1. «Что останавливает работу» — четыре переключателя; у каждого одна простая
//      фраза, и она меняется вместе с переключателем: человек читает, ЧТО будет,
//      а не угадывает по слову «вкл».
//   2. «Документы истории болезни» — титульный лист первым, дальше действующие
//      документы набора по порядку: «Обязательный» и разделы-кнопки, отмеченный
//      раздел обязателен.
//   3. «Титульный лист — обязательные поля» — галочки по группам TITLE_GROUPS,
//      подписи как на самом листе (required-marks.js).
//   4. «Кто менял» — последние 20 строк журнала.
// Одна кнопка «Сохранить» уносит только изменённое (settingsDiff): сервер пишет
// строку журнала на каждое изменение, и лишние «да → да» засорили бы его.
//
// Два правила сервера страница показывает, а не прячет:
//   • при включённом «Выписка — только с выписным эпикризом» выписной эпикриз
//     обязателен ВСЕГДА (rpc/inpatient-reviews.js epicrisisBySwitch) — его
//     «Обязательный» стоит включённым и заблокированным, с пометкой, кто решает;
//   • титульный лист «не обязателен» — не обязательно ни одно его поле
//     (titleRequiredKeys) — галочки полей серые, с пометкой.
//
// Маршрут — главному врачу и администратору (permissions.js), сервер отказывает
// второй раз (SETTINGS_WRITE_ROLES). can_edit: false всё же возможен (роль клиники
// без кода роли проходит ворота «неизвестная роль не прячет») — тогда только
// просмотр: всё погашено, кнопки нет.
//
// Классы страницы — общие (.card, .field.checkbox, .view-only-note); своё — в
// style: общий файл стилей правят параллельно, а странице хватает раскладки.
import { supabase } from '../../supabase.js';
import { h, Icon, PageHead, clear, toast, fmtDateTime } from '../ui.js';
import { tr, trf } from '../i18n.js';
import { SWITCH_KEYS, TITLE_FIELDS, TITLE_GROUPS, DEFAULT_TITLE_REQUIRED, cleanTitleRequired, cleanRequiredSections } from '../../shared/inpatient-required.js';
import { sectionsFor } from '../../shared/case-doc-sections.js';
import { TITLE_GROUP_LABEL, titleFieldLabel } from './required-marks.js';
import { sectionLabel } from './case-doc-a4.js';
import { caseDocTitle, CASE_DOC_TITLE } from './case-docs.js?v=cw1';

/** Четыре переключателя карточки «Что останавливает работу»: подпись и фраза на каждое состояние. */
const STOP_SWITCHES = Object.freeze([
    { key: 'intake_before_attending', label: 'Лечащий врач — только после осмотра приёмного врача',
        on: 'Лечащего врача назначают после того, как опубликован осмотр приёмного врача или первичный осмотр.',
        off: 'Лечащего врача назначают сразу после размещения на койке; осмотр остаётся в списке как документ.' },
    { key: 'admitting_at_placement', label: 'Приёмный врач — обязателен при размещении на койке',
        on: 'Медсестра не положит пациента, пока не выберет приёмного врача.',
        off: 'Медсестра может разместить пациента без приёмного врача; осмотр при поступлении пишет главный врач.' },
    { key: 'primary_needs_diagnosis', label: 'Первичный осмотр — только с диагнозом',
        on: 'Первичный осмотр не публикуется без диагноза.',
        off: 'Первичный осмотр можно опубликовать без диагноза.' },
    { key: 'discharge_needs_epicrisis', label: 'Выписка — только с выписным эпикризом',
        on: 'Заявку на выписку принимают только по опубликованному выписному эпикризу.',
        off: 'Заявку на выписку принимают и без выписного эпикриза.' },
]);
const SWITCH_LABEL = Object.freeze(Object.fromEntries(STOP_SWITCHES.map((s) => [s.key, s.label])));

const on01 = (v) => (v === 0 || v === false || v === '0' || v === 'false' ? 0 : 1);
const sameList = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * Ответ inpatient_settings_get → чистое состояние страницы (копия, правится на месте).
 * Пропущенный переключатель — «включён»: так считает и сервер (умолчания = сегодня).
 */
function snapshot(data) {
    const s = (data && data.settings) || {};
    const settings = {};
    for (const k of SWITCH_KEYS) settings[k] = on01(s[k]);
    settings.title_required_fields = cleanTitleRequired(Array.isArray(s.title_required_fields) ? s.title_required_fields : DEFAULT_TITLE_REQUIRED);
    const docs = (data && Array.isArray(data.docs) ? data.docs : []).filter((d) => d && d.kind).map((d) => {
        const sections = Array.isArray(d.sections) && d.sections.length ? d.sections.map(String) : sectionsFor(d.kind);
        return {
            kind: String(d.kind), title: d.title || '', builtin: !!d.builtin,
            required: !(d.required === false || d.required === 0),
            required_sections: cleanRequiredSections(d.required_sections, sections),
            sections,
        };
    });
    return { settings, docs };
}

/**
 * Что изменилось между двумя состояниями — ровно то, что уходит в inpatient_settings_save:
 * изменённые переключатели (0/1), title_required_fields при изменённом наборе,
 * docs — только изменённые документы и в них только изменённые поля; docs без
 * изменений не шлётся вовсе. Принимает и сырой ответ сервера.
 */
export function settingsDiff(before, after) {
    const a = snapshot(before);
    const b = snapshot(after);
    const out = {};
    for (const k of SWITCH_KEYS) if (a.settings[k] !== b.settings[k]) out[k] = b.settings[k];
    if (!sameList(a.settings.title_required_fields, b.settings.title_required_fields)) out.title_required_fields = b.settings.title_required_fields.slice();
    const docs = [];
    for (const d of b.docs) {
        const was = a.docs.find((x) => x.kind === d.kind);
        if (!was) continue;   // документа не было в прочитанном наборе — менять нечего
        const one = { kind: d.kind };
        if (was.required !== d.required) one.required = d.required;
        if (!sameList(was.required_sections, d.required_sections)) one.required_sections = d.required_sections.slice();
        if (Object.keys(one).length > 1) docs.push(one);
    }
    if (docs.length) out.docs = docs;
    return out;
}

/** Имя документа для журнала: из набора, иначе — словарное имя встроенного рода, иначе — род как есть. */
function docName(kind, docs) {
    const d = (Array.isArray(docs) ? docs : []).find((x) => x && x.kind === kind);
    if (d) return caseDocTitle(d.kind, d.title);
    return CASE_DOC_TITLE[kind] ? caseDocTitle(kind, '') : String(kind);
}

function parseList(raw) {
    try { const v = JSON.parse(raw); return Array.isArray(v) ? v.map(String) : null; }
    catch (e) { return null; }
}

/** Одна строка журнала «Кто менял» на языке экрана. */
export function logLineText(entry, docs) {
    const e = entry || {};
    const f = String(e.field || '');
    const m = /^doc:(.+):(required|sections)$/.exec(f);
    let what;
    let fmt;
    // Состояние переключателя — «включён / выключен»: у слова «нет» в словаре английское
    // «none» (пустое значение), и строка журнала читалась бы «yes → none».
    const yesNo = (v) => (String(v) === '1' ? tr('включён') : String(v) === '0' ? tr('выключен') : String(v == null ? '' : v));
    const list = (labelOf) => (v) => {
        const l = parseList(v);
        if (!l) return String(v == null ? '' : v);
        return l.length ? l.map(labelOf).join(', ') : '—';
    };
    if (SWITCH_LABEL[f]) { what = tr(SWITCH_LABEL[f]); fmt = yesNo; }
    else if (f === 'title_required') { what = tr('Титульный лист — обязательный документ'); fmt = yesNo; }
    else if (f === 'title_required_fields') { what = tr('Обязательные поля титульного листа'); fmt = list(titleFieldLabel); }
    else if (m && m[2] === 'required') { what = trf('{doc}: обязательный документ', { doc: docName(m[1], docs) }); fmt = yesNo; }
    else if (m) { what = trf('{doc}: обязательные разделы', { doc: docName(m[1], docs) }); fmt = list((k) => tr(sectionLabel(m[1], k))); }
    else { what = f; fmt = (v) => String(v == null ? '' : v); }
    return trf('{when} · {who}: {what} — {from} → {to}', {
        when: e.at ? fmtDateTime(e.at) : '—',
        who: e.user_name || '—',
        what,
        from: fmt(e.old_value),
        to: fmt(e.new_value),
    });
}

// ─── уход с несохранёнными правками ─────────────────────────────────────────
// Один сторож на модуль, смотрит на страницу, нарисованную последней: панель
// перерисовывается заново (смена языка, возврат), и сторож на каждую отрисовку
// копил бы обработчики. Внутри приложения панель живёт в кэше вместе с правками;
// теряются они только при перезагрузке и закрытии вкладки — это и спрашиваем.
let _guardPage = null;
let _guardArmed = false;
function armLeaveGuard(page) {
    _guardPage = page;
    if (_guardArmed || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
    _guardArmed = true;
    window.addEventListener('beforeunload', (e) => {
        const p = _guardPage;
        if (!p || !p.isDirty() || (p.root && p.root.isConnected === false)) return;
        e.preventDefault();
        e.returnValue = '';
    });
}

let _seq = 0;
const uid = (p) => 'ips-' + p + '-' + (++_seq);

const CARD = { marginBottom: '16px' };
const CARD_BODY = { padding: '6px 18px 14px' };
const ROW = { padding: '12px 0', borderTop: '1px solid var(--ink-100)' };
const NOTE = { fontSize: '12.5px', lineHeight: 1.5, margin: '4px 0 0' };

function card(icon, title, ...body) {
    return h('div', { class: 'card', style: CARD },
        h('div', { class: 'card-header' }, h('h3', null, Icon(icon, { size: 16 }), ' ', tr(title))),
        h('div', { style: CARD_BODY }, ...body));
}

/** Флажок-переключатель с подписью: <input role=switch id> + <label for>. */
function switchControl({ id, checked, disabled, attrs, label, labelStyle, ariaLabel, describedBy, onChange }) {
    const cb = h('input', Object.assign({ type: 'checkbox', role: 'switch', id }, attrs || {}));
    if (ariaLabel) cb.setAttribute('aria-label', ariaLabel);
    if (describedBy) cb.setAttribute('aria-describedby', describedBy);
    cb.checked = !!checked;
    cb.disabled = !!disabled;
    if (onChange) cb.addEventListener('change', () => onChange(!!cb.checked));
    const wrap = h('div', { class: 'field checkbox', style: { margin: 0 } }, cb, h('label', { for: id, style: labelStyle || null }, label));
    return { cb, wrap };
}

/** Кнопка-раздел: нажатая — раздел обязателен. Вид — по aria-pressed, одним местом. */
function paintChip(btn, pressed) {
    btn.setAttribute('aria-pressed', pressed ? 'true' : 'false');
    Object.assign(btn.style, pressed
        ? { borderColor: 'var(--crit-500)', background: 'var(--crit-50)', color: 'var(--crit-700)', fontWeight: '600' }
        : { borderColor: 'var(--ink-200)', background: 'var(--white)', color: 'var(--ink-700)', fontWeight: '500' });
}
const CHIP = { border: '1px solid var(--ink-200)', borderRadius: '999px', padding: '3px 10px', font: 'inherit', fontSize: '12.5px', lineHeight: 1.5, cursor: 'pointer' };

export async function renderInpatientSettings(container, _ctx = {}) {
    clear(container);
    const root = h('div', { class: 'fade-in', 'data-inpatient-settings': '' });
    container.appendChild(root);
    root.appendChild(PageHead({ title: 'Стационар' }));
    const body = h('div');
    root.appendChild(body);
    body.appendChild(h('div', { class: 'muted', style: { padding: '24px' } }, 'Загрузка…'));

    let data = null;
    let readError = null;
    try {
        const { data: d, error } = await supabase.rpc('inpatient_settings_get', {});
        if (error || !d) readError = (error && error.message) || tr('Не удалось выполнить запрос.');
        else data = d;
    } catch (e) { readError = (e && e.message) || String(e); }
    if (readError) {
        clear(body);
        body.appendChild(h('div', { class: 'card', style: CARD },
            h('div', { class: 'empty', style: { padding: '30px' }, 'data-ips-error': '' },
                trf('Настройки стационара недоступны: {msg}', { msg: tr(readError) }))));
        return;
    }

    // base — как в базе (последний ответ сервера), cur — что на экране.
    const page = { root, base: snapshot(data), cur: null, log: [], canEdit: true, busy: false, isDirty: () => false };
    page.cur = snapshot(data);
    page.log = Array.isArray(data.log) ? data.log : [];
    page.canEdit = data.can_edit !== false;
    page.isDirty = () => page.canEdit && Object.keys(settingsDiff(page.base, page.cur)).length > 0;
    armLeaveGuard(page);

    // Ссылки на то, что меняется на месте (без перерисовки: фокус остаётся у флажка).
    let refs = {};
    paint();

    function paint() {
        refs = { sentences: {}, dischargeCb: null, dischargeNote: null, dischargeDoc: null, fieldCbs: [], titleNote: null, saveBtn: null, dirtyEl: null };
        clear(body);
        if (!page.canEdit) {
            body.appendChild(h('div', { class: 'view-only-note', role: 'note' }, Icon('Lock', { size: 14 }), ' ',
                tr('Настройки стационара меняет главный врач или администратор.')));
        }
        const settingsBox = h('div');
        settingsBox.appendChild(stopCard());
        settingsBox.appendChild(docsCard());
        settingsBox.appendChild(fieldsCard());
        if (page.canEdit) settingsBox.appendChild(footer());
        body.appendChild(settingsBox);
        body.appendChild(logCard());
        refresh();
    }

    // ── 1. Что останавливает работу ──────────────────────────────────────────
    function stopCard() {
        const rows = STOP_SWITCHES.map((s, i) => {
            const id = uid('sw');
            const descId = id + '-d';
            const { wrap } = switchControl({
                id, checked: page.cur.settings[s.key] === 1, disabled: !page.canEdit,
                attrs: { 'data-ips-switch': s.key }, describedBy: descId,
                label: tr(s.label), labelStyle: { fontSize: '13.5px', fontWeight: 600, color: 'var(--ink-900)' },
                onChange: (v) => { page.cur.settings[s.key] = v ? 1 : 0; refresh(); },
            });
            const sentence = h('p', { id: descId, class: 'muted', style: Object.assign({}, NOTE, { marginLeft: '28px' }) });
            refs.sentences[s.key] = sentence;
            return h('div', { style: Object.assign({}, ROW, i === 0 ? { borderTop: '0' } : null), 'data-ips-row': s.key }, wrap, sentence);
        });
        return card('Shield', 'Что останавливает работу', ...rows);
    }

    // ── 2. Документы истории болезни ─────────────────────────────────────────
    function docsCard() {
        const rows = [];
        // Титульный лист — первой строкой: в наборе (case_doc_types) его нет, его
        // обязательность — переключатель title_required строки настроек.
        const titleName = tr('Титульный лист');
        const tId = uid('doc');
        const t = switchControl({
            id: tId, checked: page.cur.settings.title_required === 1, disabled: !page.canEdit,
            attrs: { 'data-ips-switch': 'title_required' },
            ariaLabel: tr('Титульный лист — обязательный документ'), label: tr('Обязательный'),
            onChange: (v) => { page.cur.settings.title_required = v ? 1 : 0; refresh(); },
        });
        rows.push(docRow('title', titleName, t.wrap, null, null, true));

        for (const d of page.cur.docs) {
            const name = caseDocTitle(d.kind, d.title);
            const id = uid('doc');
            const isDischarge = d.kind === 'discharge';
            const noteId = isDischarge ? id + '-n' : null;
            const s = switchControl({
                id, checked: d.required, disabled: !page.canEdit,
                attrs: { 'data-ips-doc-required': d.kind },
                ariaLabel: trf('{doc}: обязательный документ', { doc: name }), describedBy: noteId,
                label: tr('Обязательный'),
                onChange: (v) => { d.required = v; refresh(); },
            });
            let note = null;
            if (isDischarge) {
                note = h('p', { id: noteId, class: 'muted', style: NOTE, 'data-ips-discharge-note': '' });
                refs.dischargeCb = s.cb;
                refs.dischargeNote = note;
                refs.dischargeDoc = d;
            }
            const chips = h('div', { role: 'group', 'aria-label': trf('{doc}: обязательные разделы', { doc: name }),
                style: { display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '8px' } },
            ...d.sections.map((key) => {
                const btn = h('button', { type: 'button', style: CHIP, 'data-ips-kind': d.kind, 'data-ips-section': key },
                    tr(sectionLabel(d.kind, key)));
                paintChip(btn, d.required_sections.includes(key));
                btn.disabled = !page.canEdit;
                btn.addEventListener('click', () => {
                    if (!page.canEdit) return;
                    const want = new Set(d.required_sections);
                    if (want.has(key)) want.delete(key); else want.add(key);
                    d.required_sections = cleanRequiredSections([...want], d.sections);
                    paintChip(btn, d.required_sections.includes(key));
                    refresh();
                });
                return btn;
            }));
            rows.push(docRow(d.kind, name, s.wrap, chips, note, false));
        }
        return card('Doc', 'Документы истории болезни',
            h('p', { class: 'muted', style: Object.assign({}, NOTE, { margin: '8px 0 4px' }) },
                tr('Отмеченные разделы обязательны: пустой раздел подсвечивается, публикация спрашивает «Сохранить как есть».')),
            ...rows);
    }

    function docRow(kind, name, switchWrap, chips, note, first) {
        return h('div', { style: Object.assign({}, ROW, first ? { borderTop: '0' } : null), 'data-ips-doc': kind },
            h('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px 16px' } },
                h('div', { style: { flex: '1 1 220px', minWidth: 0, fontSize: '13.5px', fontWeight: 600, color: 'var(--ink-900)' } }, name),
                switchWrap),
            note, chips);
    }

    // ── 3. Титульный лист — обязательные поля ────────────────────────────────
    function fieldsCard() {
        refs.titleNote = h('p', { class: 'muted', style: Object.assign({}, NOTE, { margin: '8px 0 4px' }), 'data-ips-title-note': '' });
        const groups = TITLE_GROUPS.map((g) => {
            const boxes = TITLE_FIELDS.filter((f) => f.group === g).map((f) => {
                const id = uid('f');
                const cb = h('input', { type: 'checkbox', id, 'data-ips-field': f.key });
                cb.checked = page.cur.settings.title_required_fields.includes(f.key);
                cb.addEventListener('change', () => {
                    const want = new Set(page.cur.settings.title_required_fields);
                    if (cb.checked) want.add(f.key); else want.delete(f.key);
                    page.cur.settings.title_required_fields = cleanTitleRequired([...want]);
                    refresh();
                });
                refs.fieldCbs.push(cb);
                return h('div', { class: 'field checkbox', style: { margin: 0 } }, cb, h('label', { for: id }, titleFieldLabel(f.key)));
            });
            return h('fieldset', { style: { border: '0', padding: '0', margin: '12px 0 0', minWidth: 0 }, 'data-ips-group': g },
                h('legend', { style: { padding: 0, marginBottom: '6px', fontSize: '13.5px', fontWeight: 600, color: 'var(--ink-900)' } }, tr(TITLE_GROUP_LABEL[g] || g)),
                h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '6px 16px' } }, ...boxes));
        });
        return card('User', 'Титульный лист — обязательные поля', refs.titleNote, ...groups);
    }

    // ── 4. Кто менял ─────────────────────────────────────────────────────────
    function logCard() {
        const lines = page.log.slice(0, 20);
        const content = lines.length
            ? h('ul', { style: { listStyle: 'none', margin: '8px 0 0', padding: 0 } },
                ...lines.map((e) => h('li', { 'data-ips-log': String(e.id == null ? '' : e.id),
                    style: { padding: '6px 0', borderTop: '1px solid var(--ink-100)', fontSize: '12.5px', lineHeight: 1.5, color: 'var(--ink-700)' } },
                logLineText(e, page.cur.docs))))
            : h('p', { class: 'muted', style: Object.assign({}, NOTE, { margin: '8px 0 0' }) }, tr('Изменений ещё не было.'));
        return card('Clock', 'Кто менял', content);
    }

    // ── «Сохранить» ──────────────────────────────────────────────────────────
    // Прилипает к низу окна, пока видны карточки настроек: на длинном наборе
    // документов кнопка сверху уезжала бы из виду вместе с правками.
    function footer() {
        refs.saveBtn = h('button', { class: 'btn btn-primary', type: 'button', 'data-ips-save': '' }, Icon('Check', { size: 13 }), ' ', tr('Сохранить'));
        refs.saveBtn.addEventListener('click', save);
        refs.dirtyEl = h('span', { class: 'muted', role: 'status', style: { fontSize: '12.5px' } });
        return h('div', { style: { position: 'sticky', bottom: '0', zIndex: 2, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px 12px',
            padding: '12px 0', marginBottom: '16px', background: 'var(--white)', borderTop: '1px solid var(--ink-100)' } },
        refs.saveBtn, refs.dirtyEl);
    }

    /** Всё, что зависит от состояния, — на месте: фразы, эпикриз, поля листа, «Сохранить». */
    function refresh() {
        for (const s of STOP_SWITCHES) {
            const el = refs.sentences[s.key];
            if (el) el.textContent = tr(page.cur.settings[s.key] === 1 ? s.on : s.off);
        }
        // Выписной эпикриз: пока переключатель выписки включён, решает он (сервер так и считает).
        if (refs.dischargeCb && refs.dischargeDoc) {
            const bySwitch = page.cur.settings.discharge_needs_epicrisis === 1;
            refs.dischargeCb.checked = bySwitch ? true : refs.dischargeDoc.required;
            refs.dischargeCb.disabled = !page.canEdit || bySwitch;
            refs.dischargeNote.textContent = bySwitch ? tr('Обязателен, пока включено «Выписка — только с выписным эпикризом».') : '';
            refs.dischargeNote.hidden = !bySwitch;
        }
        // Титульный лист «не обязателен» — не требуется ни одно поле.
        const titleOn = page.cur.settings.title_required === 1;
        for (const cb of refs.fieldCbs) cb.disabled = !page.canEdit || !titleOn;
        if (refs.titleNote) {
            refs.titleNote.textContent = titleOn ? '' : tr('Титульный лист не обязателен — поля не требуются.');
            refs.titleNote.hidden = titleOn;
        }
        if (refs.saveBtn) {
            const dirty = page.isDirty();
            refs.saveBtn.disabled = page.busy || !dirty;
            refs.dirtyEl.textContent = dirty ? tr('● Есть несохранённые изменения') : '';
        }
    }

    async function save() {
        if (page.busy || !page.canEdit) return;
        const diff = settingsDiff(page.base, page.cur);
        if (!Object.keys(diff).length) return;
        page.busy = true;
        refresh();
        let answer = null;
        let failure = null;
        try {
            const { data: d, error } = await supabase.rpc('inpatient_settings_save', diff);
            if (error) failure = error.message || tr('Не удалось сохранить.');
            else answer = d;
        } catch (e) { failure = (e && e.message) || tr('Не удалось сохранить.'); }
        if (failure) {
            // Правки остаются на экране: человек исправит причину и нажмёт ещё раз.
            page.busy = false;
            refresh();
            toast(failure, 'error');
            return;
        }
        // Ответ сохранения — то же, что inpatient_settings_get после записи; старый
        // сервер без него — перечитываем.
        let fresh = answer && answer.settings ? answer : null;
        if (!fresh) {
            try { const r = await supabase.rpc('inpatient_settings_get', {}); fresh = r && !r.error ? r.data : null; }
            catch (e) { fresh = null; }
        }
        page.busy = false;
        if (fresh) {
            page.base = snapshot(fresh);
            page.cur = snapshot(fresh);
            page.log = Array.isArray(fresh.log) ? fresh.log : page.log;
            page.canEdit = fresh.can_edit !== false;
        } else {
            page.base = snapshot(page.cur);
        }
        paint();
        toast('Настройки стационара сохранены.', 'success');
    }
}
