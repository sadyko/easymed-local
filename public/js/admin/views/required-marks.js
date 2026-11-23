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
// INPATIENT_REQUIRED_V1 (ревью) — редактор с contenteditable тоже поле: «Не заполнено»,
// дописанное ВНУТРЬ, становилось частью текста документа (и поле больше не считалось
// пустым). Пустое значение атрибута по HTML — тоже «редактируемо».
function isEditable(el) {
    if (!el) return false;
    if (el.isContentEditable === true) return true;
    const v = typeof el.getAttribute === 'function' ? el.getAttribute('contenteditable') : null;
    return v === '' || /^(true|plaintext-only)$/i.test(String(v));
}
const isControl = (el) => !!el && (/^(INPUT|SELECT|TEXTAREA)$/.test(String(el.tagName || '').toUpperCase()) || isEditable(el));
// INPATIENT_REQUIRED_V1 (ревью) — ARIA разрешает aria-required не каждому элементу, а только
// ролям, у которых «обязательно» что-то значит. Редактор с contenteditable без роли,
// радиокнопка (role=radio), кнопка — нет: на них aria-required недопустим (axe:
// aria-allowed-attr). Им остаются aria-invalid, aria-describedby, «Не заполнено», скрытое
// «обязательно» у подписи и строка сверху — этого читалке хватает.
const REQUIRED_ROLES = new Set(['checkbox', 'combobox', 'gridcell', 'listbox', 'radiogroup', 'searchbox',
    'spinbutton', 'switch', 'textbox', 'tree', 'treegrid']);
// Типы <input>, чья роль (или «без роли, но с атрибутами textbox») aria-required принимает.
const REQUIRED_INPUT_TYPES = new Set(['', 'text', 'search', 'tel', 'url', 'email', 'password', 'number',
    'date', 'datetime-local', 'month', 'week', 'time', 'checkbox']);
function allowsAriaRequired(el) {
    if (!el || typeof el.setAttribute !== 'function') return false;
    const role = typeof el.getAttribute === 'function' ? String(el.getAttribute('role') || '').trim().split(/\s+/)[0].toLowerCase() : '';
    if (role) return REQUIRED_ROLES.has(role);
    const tag = String(el.tagName || '').toUpperCase();
    if (tag === 'SELECT' || tag === 'TEXTAREA') return true;
    if (tag !== 'INPUT') return false;   // contenteditable, кнопки, рамки — без роли не берут
    const type = String((typeof el.getAttribute === 'function' && el.getAttribute('type')) || el.type || '').trim().toLowerCase();
    return REQUIRED_INPUT_TYPES.has(type);
}
const hasChild = (parent, node) => !!parent && Array.prototype.includes.call(parent.children || [], node);
const hasCls = (el, name) => !!el && String(el.className || '').split(/\s+/).includes(name);
const kids = (el) => Array.prototype.slice.call((el && el.children) || []);
// INPATIENT_REQUIRED_V1 (ревью) — <select> в окнах подменяет список программы:
// ui-enhance.js кадром позже вызывает enhanceSelect (ui-select.js), и родное поле
// уезжает в обёртку .uisel спрятанным (.uisel-native, tabIndex -1, data-ui-select="on"),
// а видимая часть — кнопка .uisel-field рядом с ним в той же обёртке. Подмена случается
// ПОСЛЕ setFields, поэтому кнопку ищем в момент действия: фокус, aria-*, место подсказки.
const isSelect = (el) => !!el && String(el.tagName || '').toUpperCase() === 'SELECT';
function isSwapped(el) {
    if (!isSelect(el)) return false;
    if (el.dataset && el.dataset.uiSelect === 'on') return true;
    if (typeof el.getAttribute === 'function' && el.getAttribute('data-ui-select') === 'on') return true;
    return hasCls(el, 'uisel-native');
}
/** Элемент, до которого доходят клавиатура и читалка: кнопка списка программы или само поле. */
function visibleOf(el) {
    if (!el || !isSwapped(el)) return el || null;
    return kids(el.parentNode).find((c) => c !== el && hasCls(c, 'uisel-field')) || el;
}
/** После чего ставить «Не заполнено» у поля без рамки: у подменённого списка — за обёрткой. */
function afterAnchor(frame) {
    return isSwapped(frame) && hasCls(frame.parentNode, 'uisel') ? frame.parentNode : frame;
}
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
 *   INPATIENT_REQUIRED_V1 (ревью): el — <select>, подменённый списком программы, —
 *   фокус и aria-* получает и видимая кнопка .uisel-field (ищется в момент действия);
 *   el с contenteditable — поле, «Не заполнено» встаёт после него, не внутрь. У полей с
 *   общей рамкой одна подсказка (рамка красная, пока пусто хоть одно); с общей подписью —
 *   одно скрытое «обязательно».
 * @returns {{summary: Element, refresh: () => string[], setFields: (fields) => string[],
 *            missing: () => Array<{key:string,label:string}>, focusFirst: () => boolean}}
 */
export function requiredMarks({ fields = [] } = {}) {
    let list = [];
    let shown = null;              // что сейчас в строке сверху: перерисовка — только когда список пустых другой
    const summary = h('div', { class: 'rq-summary no-print', 'data-rq-summary': '' });
    summary.hidden = true;
    // INPATIENT_REQUIRED_V1 (ревью) — ключи — ЭЛЕМЕНТЫ, не записи полей: экран зовёт
    // setFields с новыми записями тех же полей (правила пришли позже), и по записи
    // каждый вызов дописывал ещё одно «Не заполнено»; два поля с одной подписью
    // (АД верхнее и нижнее) давали два скрытых «обязательно».
    const msgs = new Map();        // рамка → «Не заполнено»
    const srs = new Map();         // подпись → скрытое «обязательно»
    const ownReq = new Set();      // элементы, которым aria-required поставили мы (снимаем только свои)
    const bound = new Set();       // элементы, на которые навешан пересчёт
    let gen = 0;                   // поколение списка: отложенный пересчёт старого списка не нужен

    const frameOf = (f) => f.box || f.el || null;
    const isEmptyF = (f) => (typeof f.isEmpty === 'function' ? !!f.isEmpty() : false);
    // Куда ставить aria-*: само поле и — если список подменён — видимая кнопка.
    const ariaOf = (f) => {
        if (!f.el) return [];
        const v = visibleOf(f.el);
        return (v && v !== f.el ? [f.el, v] : [f.el]).filter((t) => typeof t.setAttribute === 'function');
    };

    function focusField(f) {
        const vis = visibleOf(f.el);
        const target = f.box || vis;
        if (target && typeof target.scrollIntoView === 'function') {
            try { target.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' }); } catch (e) { /* не прокрутилось — не беда */ }
        }
        // preventScroll: фокус не перебивает плавную прокрутку рывком.
        if (vis && typeof vis.focus === 'function') {
            try { vis.focus({ preventScroll: true }); } catch (e) { /* без фокуса */ }
        }
    }
    // «Не заполнено» заводим, когда рамка впервые пуста: в рамке, а у рамки-поля — сразу за ним.
    function msgFor(frame) {
        if (msgs.has(frame)) return msgs.get(frame);
        if (!frame) return null;
        const msg = h('span', { class: 'rq-msg no-print', id: 'rq-msg-' + (++_seq) }, 'Не заполнено');
        const at = isControl(frame) ? afterAnchor(frame) : null;
        if (!at) frame.appendChild(msg);
        else if (at.parentNode && typeof at.insertAdjacentElement === 'function') at.insertAdjacentElement('afterend', msg);
        else return null;
        msgs.set(frame, msg);
        return msg;
    }
    // Подпись раздела переименовывают (textContent) — скрытое «обязательно» возвращается.
    function ensureSr(labelEl) {
        if (!labelEl || typeof labelEl.appendChild !== 'function') return;
        if (!srs.has(labelEl)) srs.set(labelEl, h('span', { class: 'rq-sr' }, ' ' + tr('обязательно')));
        const sr = srs.get(labelEl);
        if (!hasChild(labelEl, sr)) labelEl.appendChild(sr);
    }
    // aria-required ставим и в refresh: кнопка списка программы появляется после setFields.
    // INPATIENT_REQUIRED_V1 (ревью) — только самому полю: видимой кнопке списка программы
    // (.uisel-field, role=button) ARIA aria-required не разрешает. Обязательность остаётся у
    // родного <select>, а aria-invalid / aria-describedby кнопка получает (ariaOf).
    // INPATIENT_REQUIRED_V1 (ревью) — и только полю с ролью, которой ARIA его разрешает
    // (allowsAriaRequired): редактор с contenteditable без роли его не получает.
    function markRequired(t) {
        if (!allowsAriaRequired(t)) return;
        if (typeof t.getAttribute !== 'function' || t.getAttribute('aria-required') !== 'true') ownReq.add(t);
        t.setAttribute('aria-required', 'true');
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
        const emptyOf = new Map();     // поле → пусто ли
        const frameEmpty = new Map();  // рамка → пусто ли хоть одно её поле (АД верхнее и нижнее в одной рамке)
        for (const f of list) {
            const empty = isEmptyF(f);
            emptyOf.set(f, empty);
            if (empty) missing.push(f);
            const frame = frameOf(f);
            if (frame) frameEmpty.set(frame, frameEmpty.get(frame) === true || empty);
        }
        for (const [frame, empty] of frameEmpty) {
            setClass(frame, 'rq-empty', empty);
            const msg = empty ? msgFor(frame) : msgs.get(frame);
            if (msg) msg.hidden = !empty;
        }
        for (const f of list) {
            const empty = emptyOf.get(f);
            const msg = msgs.get(frameOf(f));
            for (const t of ariaOf(f)) {
                if (t === f.el) markRequired(t);   // INPATIENT_REQUIRED_V1 (ревью) — не на кнопку списка
                if (empty) t.setAttribute('aria-invalid', 'true');
                else dropAttr(t, 'aria-invalid', 'false');
                if (msg) setDescribed(t, msg.getAttribute('id'), empty);
            }
            ensureSr(f.labelEl);
        }
        paintSummary(missing);
        return missing.map((f) => f.key);
    }
    const onChange = () => { refresh(); };
    // INPATIENT_REQUIRED_V1 (ревью) — снять ВСЁ своё с прежнего списка: aria-* с поля и
    // его видимой кнопки, классы, и «Не заполнено» / «обязательно» — из DOM, а не только
    // спрятать. Сперва описания (им нужны id подсказок), потом сами подсказки.
    function unmarkAll(old) {
        for (const f of old) {
            setClass(frameOf(f), 'rq-empty', false);
            setClass(f.labelEl, 'rq-req', false);
            const msg = msgs.get(frameOf(f));
            for (const t of ariaOf(f)) {
                dropAttr(t, 'aria-invalid', 'false');
                if (msg) setDescribed(t, msg.getAttribute('id'), false);
            }
        }
        for (const t of ownReq) dropAttr(t, 'aria-required', 'false');
        ownReq.clear();
        for (const msg of msgs.values()) if (msg.parentNode) msg.parentNode.removeChild(msg);
        msgs.clear();
        // Только если ещё на месте: настоящий DOM бросает, когда узла среди детей нет.
        for (const [labelEl, sr] of srs) if (hasChild(labelEl, sr)) labelEl.removeChild(sr);
        srs.clear();
    }
    // Список программы подменяет <select> кадром позже (ui-enhance.js ставит подмену в
    // requestAnimationFrame после вставки): через два кадра пересчёт ещё раз — aria-*
    // ложатся на появившуюся кнопку. Фокус кнопку и так находит в момент действия.
    function resyncAfterSwap() {
        const my = ++gen;
        if (typeof requestAnimationFrame !== 'function') return;
        if (!list.some((f) => isSelect(f.el) && !isSwapped(f.el))) return;
        requestAnimationFrame(() => requestAnimationFrame(() => { if (my === gen) refresh(); }));
    }
    function setFields(next) {
        unmarkAll(list);
        for (const w of bound) {
            if (typeof w.removeEventListener === 'function') { w.removeEventListener('input', onChange); w.removeEventListener('change', onChange); }
        }
        bound.clear();
        list = (Array.isArray(next) ? next : []).filter(Boolean);
        shown = null;   // новые поля — новые кнопки строки сверху
        for (const f of list) {
            setClass(f.labelEl, 'rq-req', true);
            for (const w of [f.el, ...(f.watch || [])]) {
                if (!w || typeof w.addEventListener !== 'function' || bound.has(w)) continue;
                bound.add(w);
                w.addEventListener('input', onChange);
                w.addEventListener('change', onChange);
            }
        }
        const out = refresh();
        resyncAfterSwap();
        return out;
    }
    setFields(fields);
    return {
        summary, refresh, setFields,
        missing: () => list.filter(isEmptyF).map((f) => ({ key: f.key, label: f.label })),
        focusFirst: () => { const f = list.find(isEmptyF); if (f) focusField(f); return !!f; },
    };
}

const FOCUSABLE = (n) => !!n && /^(BUTTON|INPUT|SELECT|TEXTAREA|A)$/.test(String(n.tagName || '').toUpperCase()) && !n.disabled;

// INPATIENT_REQUIRED_V1 (ревью) — куда вернуть фокус, когда окно закрылось. Окно формы
// (inpatientModal, docActionsBar) гасит кнопку отправки на время сохранения — а вопрос
// задаётся именно из её обработчика; на неактивную или убранную кнопку фокус не
// встаёт, и браузер оставлял его на body при открытом окне формы.
// Обход — по children, без querySelectorAll: так же работает и поддельный DOM тестов.
const walkEls = (root, out = []) => { for (const c of kids(root)) { out.push(c); walkEls(c, out); } return out; };
const canFocus = (n) => FOCUSABLE(n) && n.isConnected !== false && !n.hidden
    && !(typeof n.tabIndex === 'number' && n.tabIndex < 0)                  // спрятанный родной список (.uisel-native)
    && (typeof n.getClientRects !== 'function' || n.getClientRects().length > 0);   // display: none
function closestCls(n, name) {
    for (let x = n; x; x = x.parentNode) if (hasCls(x, name)) return x;
    return null;
}
/** Верхнее открытое окно приложения (.modal в <body>) — его карточка. */
function topModalCard() {
    if (typeof document === 'undefined' || !document.body) return null;
    const mods = kids(document.body).filter((n) => hasCls(n, 'modal'));
    for (let i = mods.length - 1; i >= 0; i--) {
        const card = walkEls(mods[i]).find((n) => hasCls(n, 'modal-card'));
        if (card) return card;
    }
    return null;
}
/** Первое доступное поле окна: сперва тело окна (поля формы), потом вся карточка. */
function firstFocusableIn(card) {
    const body = walkEls(card).find((n) => hasCls(n, 'modal-body'));
    return (body && walkEls(body).find(canFocus)) || walkEls(card).find(canFocus) || null;
}
function restoreFocus(back, openerCard) {
    const doc = typeof document !== 'undefined' ? document : null;
    if (back && (!doc || back !== doc.body) && back.isConnected !== false && !back.disabled && typeof back.focus === 'function') {
        try { back.focus(); } catch (e) { /* фокус не встал — ищем дальше */ }
        if (!doc || doc.activeElement === back) return;
    }
    const card = (openerCard && openerCard.isConnected !== false) ? openerCard : topModalCard();
    if (!card) return;   // окон нет — фокусу на body и место
    const target = firstFocusableIn(card);
    try {
        if (target) { target.focus(); return; }
        // Полей нет — сама карточка (tabindex -1: в обход по Tab она не встаёт).
        if (typeof card.getAttribute === 'function' && card.getAttribute('tabindex') == null) card.setAttribute('tabindex', '-1');
        if (typeof card.focus === 'function') card.focus();
    } catch (e) { /* фокус вернуть некуда */ }
}

/**
 * «Заполнено не всё». Мягкий случай — «Дописать» / «Сохранить как есть»;
 * жёсткий (переключатель клиники включён) — только «Дописать».
 * Escape, крестик и щелчок мимо окна — «Дописать». Первый фокус — на «Дописать».
 * INPATIENT_REQUIRED_V1 (ревью) — reason: своя причина жёсткого отказа. «Так настроено в
 * клинике» верно для переключателей клиники, но не для лечащего врача: он обязателен
 * всегда, и действие окна там — «Назначить», а не «сохранить». Без reason — прежняя строка.
 * @param {{missing?: string[], hard?: boolean, reason?: string}} opts  missing — подписи пустых
 *   полей на языке экрана; reason — причина жёсткого отказа (ключ словаря или уже переведённая)
 * @returns {Promise<'save'|'fix'>}
 */
export function askSaveAnyway({ missing = [], hard = false, reason = '' } = {}) {
    return new Promise((resolve) => {
        const id = 'rq-dlg-' + (++_seq);
        const back = typeof document !== 'undefined' ? document.activeElement : null;   // куда вернуть фокус
        const openerCard = closestCls(back, 'modal-card');   // окно формы, из которого спросили (пока кнопка на месте)
        // INPATIENT_REQUIRED_V1 (ревью) — no-print: вопрос на экране не попадает в печать.
        const overlay = h('div', { class: 'modal no-print', style: { zIndex: '200' }, 'data-dialog': 'required-missing' });
        let finished = false;
        const done = (v) => {
            if (finished) return;
            finished = true;
            document.removeEventListener('keydown', onKey, true);
            overlay.remove();
            restoreFocus(back, openerCard);
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
                hard ? h('p', { id: id + '-hard', class: 'muted', style: { margin: '8px 0 0' } },
                    reason || 'Без этого сохранить нельзя — так настроено в клинике.') : null),   // INPATIENT_REQUIRED_V1 (ревью) — своя причина
            h('footer', { class: 'modal-foot' },
                h('span', { class: 'grow' }),
                saveBtn,
                fixBtn)));
        document.body.appendChild(overlay);
        document.addEventListener('keydown', onKey, true);
        try { fixBtn.focus(); } catch (e) { /* без фокуса — не беда */ }
    });
}
