// INPATIENT_REQUIRED_V1 (2026-11-23) — ОТМЕТКИ ОБЯЗАТЕЛЬНЫХ ПОЛЕЙ И «СОХРАНИТЬ КАК ЕСТЬ».
//
// Владелец: «in the required fields of the title and other user cannot understand
// which fields he is not filled, cn we add visual cues for that?»
//
// Один помощник на все формы стационара: окно размещения, титульный лист в истории
// болезни, каждый документ истории болезни, выбор лечащего и приёмного врача.
// Обязательная подпись — красная звезда (только экран, CSS; для читалки звезды нет)
// и скрытое «обязательно» для читалки; пустое обязательное поле — красная рамка,
// aria-invalid и «Не заполнено» (на него же указывает aria-describedby поля);
// сверху формы — строка «Не заполнено: …», каждое имя ведёт к своему полю.
// Отметки — только экран: @media print их прячет, печатный HTML их не получает.
//
// Окно «Заполнено не всё» — как прочие окна приложения (.modal / .modal-card), но
// общей функции «спросить» в приложении нет (departments.js держит свою askConfirm),
// а inpatientModal — окно формы с «Закрыть» и отправкой, не вопрос. Поэтому окно
// здесь, а клавиатура — как у окна причины (booked-drop.js): Escape только этому
// окну, Tab не уходит из окна, фокус возвращается туда, где был. window.confirm —
// никогда.
//
// Модуль не импортирует ни одного экрана (NO_IMPORT_CYCLES_V1); общие модули — без
// штампа ?v= (один экземпляр модуля на страницу).
import { supabase } from '../../supabase.js';
import { h, clear, Icon } from '../ui.js';
import { tr, trf } from '../i18n.js';
import { rulesFromSettings, DEFAULT_RULES } from '../../shared/inpatient-required.js';

/** Подписи полей титульного листа — как на самом листе (ключи — TITLE_FIELDS). */
export const TITLE_FIELD_LABEL = Object.freeze({
    phone: 'Телефон', address: 'Постоянный адрес', national_id: 'Паспорт / ID',
    occupation: 'Место работы, профессия, должность', emergency_contact_name: 'Близкий родственник',
    emergency_contact_phone: 'Телефон родственника', blood_type: 'Группа крови и резус', allergies: 'Аллергия на лекарства',
    referred_from: 'Кем направлен', delivered_by: 'Каким транспортом', mobility: 'Как доставляют по отделению',
    since_onset: 'Сколько прошло от начала болезни',
    height_cm: 'Рост', weight_kg: 'Вес', temp_c: 'Температура', bp_sys: 'АД верхнее', bp_dia: 'АД нижнее', pulse_bpm: 'Пульс',
    pediculosis: 'Осмотр на педикулёз и чесотку', sanitation: 'Санитарная обработка',
    contract_signed: 'Договор на госпитализацию', consent_signed: 'Информированное согласие', memo_given: 'Памятка стационара',
});
/** Подписи групп полей (TITLE_GROUPS) — заголовки на странице настроек. */
export const TITLE_GROUP_LABEL = Object.freeze({
    patient: 'Пациент', admission: 'Поступление в стационар', measures: 'Измерения', exam: 'Осмотр медсестры',
    papers: 'Документы при поступлении',
});
/** Подпись поля на языке экрана; неизвестный ключ — как есть. */
export function titleFieldLabel(key) { return tr(TITLE_FIELD_LABEL[key] || key); }

/** Правила стационара для экрана. Сбой, старый сервер, нет права — сегодняшние правила. */
export async function loadInpatientRules() {
    try {
        const { data, error } = await supabase.rpc('inpatient_settings_get', {});
        if (error || !data) return DEFAULT_RULES;
        return rulesFromSettings(data);
    } catch (e) { return DEFAULT_RULES; }
}

let _seq = 0;
// Классы — переписью className: classList поддельного DOM тестов ничего не делает
// (та же причина, что у syncSecs в admission-modal.js).
function setClass(el, name, on) {
    if (!el) return;
    const parts = String(el.className || '').split(/\s+/).filter((c) => c && c !== name);
    if (on) parts.push(name);
    el.className = parts.join(' ');
}
// Снять атрибут; у поддельного DOM без removeAttribute — записать «нет».
function dropAttr(el, k, fallback) {
    if (!el) return;
    if (typeof el.removeAttribute === 'function') el.removeAttribute(k);
    else if (typeof el.setAttribute === 'function') el.setAttribute(k, fallback);
}
// aria-describedby — список id: свой добавляем и убираем, чужие не трогаем.
function setDescribed(el, id, on) {
    if (!el || !id || typeof el.getAttribute !== 'function') return;
    const ids = String(el.getAttribute('aria-describedby') || '').split(/\s+/).filter((x) => x && x !== id);
    if (on) ids.push(id);
    if (ids.length) el.setAttribute('aria-describedby', ids.join(' '));
    else dropAttr(el, 'aria-describedby', '');
}
const isControl = (el) => !!el && /^(INPUT|SELECT|TEXTAREA)$/.test(String(el.tagName || ''));
const hasChild = (parent, node) => !!parent && Array.prototype.includes.call(parent.children || [], node);
const reducedMotion = () => {
    try { return !!(typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); }
    catch (e) { return false; }
};

/**
 * Отметки формы.
 * @param {{fields: Array<{key:string, label:string, el?:Element, box?:Element, labelEl?:Element,
 *          watch?:Element[], isEmpty:() => boolean}>}} opts
 *   el — поле (фокус, aria-*); box — рамка («Не заполнено» ложится внутрь неё; без box
 *   рамка — само поле, и «Не заполнено» встаёт сразу после него); labelEl — подпись
 *   (звезда и скрытое «обязательно»); watch — ещё элементы, чьи input/change
 *   пересчитывают отметки (радиокнопки группы). label — уже на языке экрана.
 * @returns {{summary: Element, refresh: () => string[], setFields: (fields) => string[],
 *            missing: () => Array<{key:string,label:string}>, focusFirst: () => boolean}}
 */
export function requiredMarks({ fields = [] } = {}) {
    let list = [];
    let shown = null;              // что сейчас в строке сверху: перерисовка — только когда список пустых другой
    const summary = h('div', { class: 'rq-summary no-print', 'data-rq-summary': '' });
    summary.hidden = true;
    const msgs = new Map();        // поле → «Не заполнено»
    const srs = new Map();         // поле → скрытое «обязательно»
    const ownReq = new Set();      // поля, которым aria-required поставили мы (снимаем только свои)
    const bound = new Set();       // элементы, на которые навешан пересчёт

    const frameOf = (f) => f.box || f.el || null;
    const isEmptyF = (f) => (typeof f.isEmpty === 'function' ? !!f.isEmpty() : false);

    function focusField(f) {
        const target = frameOf(f);
        if (target && typeof target.scrollIntoView === 'function') {
            try { target.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' }); } catch (e) { /* не прокрутилось — не беда */ }
        }
        // preventScroll: фокус не перебивает плавную прокрутку рывком.
        if (f.el && typeof f.el.focus === 'function') {
            try { f.el.focus({ preventScroll: true }); } catch (e) { /* без фокуса */ }
        }
    }
    // «Не заполнено» заводим, когда поле впервые пусто: в рамке, а у рамки-поля — сразу за ним.
    function msgFor(f) {
        if (msgs.has(f)) return msgs.get(f);
        const frame = frameOf(f);
        if (!frame) return null;
        const msg = h('span', { class: 'rq-msg no-print', id: 'rq-msg-' + (++_seq) }, 'Не заполнено');
        if (!isControl(frame)) frame.appendChild(msg);
        else if (frame.parentNode && typeof frame.insertAdjacentElement === 'function') frame.insertAdjacentElement('afterend', msg);
        else return null;
        msgs.set(f, msg);
        return msg;
    }
    // Подпись раздела переименовывают (textContent) — скрытое «обязательно» возвращается.
    function ensureSr(f) {
        if (!f.labelEl || typeof f.labelEl.appendChild !== 'function') return;
        if (!srs.has(f)) srs.set(f, h('span', { class: 'rq-sr' }, ' ' + tr('обязательно')));
        const sr = srs.get(f);
        if (!hasChild(f.labelEl, sr)) f.labelEl.appendChild(sr);
    }
    function paintSummary(missing) {
        const sig = missing.map((f) => f.key + '\u0001' + f.label).join('\u0002');
        if (sig === shown) return;
        shown = sig;
        clear(summary);
        summary.hidden = missing.length === 0;
        if (!missing.length) return;
        summary.appendChild(h('span', { class: 'rq-summary-t' }, Icon('Warning', { size: 14 }), 'Не заполнено:'));
        // Имена — одной строкой текста через запятую (не флекс: запятая не отрывается от имени).
        const names = h('span', { class: 'rq-list' });
        missing.forEach((f, i) => {
            if (i) names.appendChild(document.createTextNode(', '));
            names.appendChild(h('button', { class: 'rq-jump', type: 'button', 'data-rq-jump': f.key, onclick: () => focusField(f) }, f.label));
        });
        summary.appendChild(names);
    }
    function refresh() {
        const missing = [];
        for (const f of list) {
            const empty = isEmptyF(f);
            setClass(frameOf(f), 'rq-empty', empty);
            if (f.el && typeof f.el.setAttribute === 'function') {
                if (empty) f.el.setAttribute('aria-invalid', 'true');
                else dropAttr(f.el, 'aria-invalid', 'false');
            }
            const msg = empty ? msgFor(f) : msgs.get(f);
            if (msg) {
                msg.hidden = !empty;
                setDescribed(f.el, msg.getAttribute('id'), empty);
            }
            ensureSr(f);
            if (empty) missing.push(f);
        }
        paintSummary(missing);
        return missing.map((f) => f.key);
    }
    const onChange = () => { refresh(); };
    function unmark(f) {
        setClass(frameOf(f), 'rq-empty', false);
        setClass(f.labelEl, 'rq-req', false);
        if (f.el) {
            dropAttr(f.el, 'aria-invalid', 'false');
            if (ownReq.has(f)) dropAttr(f.el, 'aria-required', 'false');
        }
        const msg = msgs.get(f);
        if (msg) { msg.hidden = true; setDescribed(f.el, msg.getAttribute('id'), false); }
        // Только если ещё на месте: настоящий DOM бросает, когда узла среди детей нет.
        const sr = srs.get(f);
        if (sr && hasChild(f.labelEl, sr)) f.labelEl.removeChild(sr);
    }
    function setFields(next) {
        for (const f of list) unmark(f);
        for (const w of bound) {
            if (typeof w.removeEventListener === 'function') { w.removeEventListener('input', onChange); w.removeEventListener('change', onChange); }
        }
        bound.clear();
        ownReq.clear();
        list = (Array.isArray(next) ? next : []).filter(Boolean);
        shown = null;   // новые поля — новые кнопки строки сверху
        for (const f of list) {
            setClass(f.labelEl, 'rq-req', true);
            if (f.el && typeof f.el.setAttribute === 'function') {
                if (typeof f.el.getAttribute !== 'function' || f.el.getAttribute('aria-required') !== 'true') ownReq.add(f);
                f.el.setAttribute('aria-required', 'true');
            }
            for (const w of [f.el, ...(f.watch || [])]) {
                if (!w || typeof w.addEventListener !== 'function' || bound.has(w)) continue;
                bound.add(w);
                w.addEventListener('input', onChange);
                w.addEventListener('change', onChange);
            }
        }
        return refresh();
    }
    setFields(fields);
    return {
        summary, refresh, setFields,
        missing: () => list.filter(isEmptyF).map((f) => ({ key: f.key, label: f.label })),
        focusFirst: () => { const f = list.find(isEmptyF); if (f) focusField(f); return !!f; },
    };
}

const FOCUSABLE = (n) => !!n && /^(BUTTON|INPUT|SELECT|TEXTAREA|A)$/.test(String(n.tagName || '').toUpperCase()) && !n.disabled;

/**
 * «Заполнено не всё». Мягкий случай — «Дописать» / «Сохранить как есть»;
 * жёсткий (переключатель клиники включён) — только «Дописать».
 * Escape, крестик и щелчок мимо окна — «Дописать». Первый фокус — на «Дописать».
 * @param {{missing?: string[], hard?: boolean}} opts  missing — подписи пустых полей на языке экрана
 * @returns {Promise<'save'|'fix'>}
 */
export function askSaveAnyway({ missing = [], hard = false } = {}) {
    return new Promise((resolve) => {
        const id = 'rq-dlg-' + (++_seq);
        const back = typeof document !== 'undefined' ? document.activeElement : null;   // куда вернуть фокус
        const overlay = h('div', { class: 'modal', style: { zIndex: '200' }, 'data-dialog': 'required-missing' });
        let finished = false;
        const done = (v) => {
            if (finished) return;
            finished = true;
            document.removeEventListener('keydown', onKey, true);
            overlay.remove();
            try { if (back && typeof back.focus === 'function' && back.isConnected !== false) back.focus(); } catch (e) { /* фокус вернуть некуда */ }
            resolve(v);
        };
        const names = (Array.isArray(missing) ? missing : []).map((x) => String(x == null ? '' : x).trim()).filter(Boolean);
        const closeBtn = h('button', { class: 'modal-close', type: 'button', 'aria-label': 'Закрыть', onclick: () => done('fix') }, '×');
        const saveBtn = hard ? null : h('button', { class: 'btn', type: 'button', 'data-rq-save': '', onclick: () => done('save') }, 'Сохранить как есть');
        const fixBtn = h('button', { class: 'btn btn-primary', type: 'button', 'data-rq-fix': '', onclick: () => done('fix') }, 'Дописать');
        // Escape — только этому окну (окно стационара под ним слушает документ без «захвата»
        // и закрылось бы вместе с ним); Tab ходит по кругу внутри окна.
        const onKey = (e) => {
            if (!e) return;
            if (e.key === 'Escape') {
                if (typeof e.preventDefault === 'function') e.preventDefault();
                if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
                if (typeof e.stopPropagation === 'function') e.stopPropagation();
                done('fix');
                return;
            }
            if (e.key === 'Tab') {
                const ring = [closeBtn, saveBtn, fixBtn].filter(FOCUSABLE);
                if (!ring.length) return;
                const at = ring.indexOf(document.activeElement);
                const next = e.shiftKey ? (at <= 0 ? ring[ring.length - 1] : ring[at - 1]) : (at === -1 || at === ring.length - 1 ? ring[0] : ring[at + 1]);
                if (typeof e.preventDefault === 'function') e.preventDefault();
                try { next.focus(); } catch (err) { /* без фокуса */ }
            }
        };
        const described = hard ? id + '-list ' + id + '-hard' : id + '-list';
        overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: () => done('fix') }));
        overlay.appendChild(h('div', { class: 'modal-card modal-compact', role: 'alertdialog', 'aria-modal': 'true',
            'aria-labelledby': id + '-title', 'aria-describedby': described, style: { width: '460px', maxWidth: 'calc(100vw - 32px)' } },
            h('header', { class: 'modal-head' },
                h('h2', { id: id + '-title' }, Icon('Warning', { size: 16 }), ' ', 'Заполнено не всё'),
                closeBtn),
            h('div', { class: 'modal-body' },
                h('p', { id: id + '-list', style: { margin: 0 } }, trf('Не заполнено: {list}', { list: names.join(', ') })),
                hard ? h('p', { id: id + '-hard', class: 'muted', style: { margin: '8px 0 0' } }, 'Без этого сохранить нельзя — так настроено в клинике.') : null),
            h('footer', { class: 'modal-foot' },
                h('span', { class: 'grow' }),
                saveBtn,
                fixBtn)));
        document.body.appendChild(overlay);
        document.addEventListener('keydown', onKey, true);
        try { fixBtn.focus(); } catch (e) { /* без фокуса — не беда */ }
    });
}
