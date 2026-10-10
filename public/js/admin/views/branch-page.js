// BRANCH_PROFILE_V1 — СТРАНИЦА ЗДАНИЯ в «Филиалах» (шаг 4 API клиники; план
// docs/plans/2026-10-10-clinic-api-4-branches.md, задачи 12–14).
//
// Название здания на трёх языках (RU — branches.name: его показывает вся
// программа, по нему связываются здания; UZ / EN — сайту и партнёрам),
// телефон для пациентов, «Работает»; адрес для партнёров с ориентиром, карта,
// «показывать на сайте» (задача 13); часы работы (задача 14).
//
// ОДНО МЕСТО НА АДРЕС ЗДАНИЯ (Р2):
//   • своё здание главного (own) — адрес для партнёров, карта и телефон живут
//     в «Компании» (doc_settings, шаг 3): здесь только видны, кнопка ведёт туда;
//   • остальные здания — всё здесь (branches), правит главное здание;
//   • в филиале (secondary) — всё только видно: ведёт главное здание.
// Сохраняется только изменённое (как «Компания», ревью C1 шага 3): нетронутое
// поле не может быть затёрто ничем. Страница вместо окна макета (решение Р12):
// карточки шага 3 переиспользуются как есть, на телефоне — один столбец.
import { supabase } from '../../supabase.js';
import { h, Icon, clear, toast, Tag } from '../ui.js';
import { tr } from '../i18n.js';
import { phoneInput } from '../phone-input.js?v=ph1';
import { triGroup, labeled } from './company-fields.js';
import { NAME_MAX } from '../../shared/clinic-profile.js';
import { BRANCH_EDIT_COLUMNS, OWN_FROM_COMPANY, BRANCH_MESSAGES, normalizeBranch, branchProblems, overlayOwnBuilding } from '../../shared/branch-profile.js';

export const BRANCH_DEFAULTS = Object.freeze({
    name: '', name_uz: '', name_en: '', phone: '', address: '', active: 1,
    country_code: '', region_code: '', district_code: '', street_ru: '', street_uz: '', street_en: '',
    landmark_ru: '', landmark_uz: '', landmark_en: '', maps_url: '', show_public: 1,
    working_hours: '{}', is_24_7: 0,
});
const ADDRESS_COLUMNS = ['country_code', 'region_code', 'district_code', 'street_ru', 'street_uz', 'street_en'];
// Порядок экрана: неудачное сохранение ведёт к первому неверному полю (как «Компания»).
const FIELD_ORDER = ['name', 'phone', 'country_code', 'region_code', 'district_code', 'street_ru', 'maps_url', 'hours'];
const same = (a, b) => String(a == null ? '' : a) === String(b == null ? '' : b);

function card(icon, title, ...body) {
    return h('div', { class: 'card' },
        h('div', { class: 'card-header' }, h('h3', null, Icon(icon, { size: 16 }), ' ', title)),
        h('div', { class: 'cpf-body' }, ...body));
}
// Отметка с подписью, связанной с полем (for / id): читалка называет её.
let chkSeq = 0;
function checkRow(label, chk) {
    const id = 'brf-chk-' + (++chkSeq);
    chk.setAttribute('id', id);
    return h('div', { class: 'field checkbox' }, chk, h('label', { for: id }, label));
}
function askDiscard() {
    const text = tr('Филиал изменён, но не сохранён. Вернуться к списку? Изменения пропадут.');
    return (typeof window !== 'undefined' && typeof window.confirm === 'function') ? window.confirm(text) : true;
}
function focusField(ctrl) {
    const calm = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    try { ctrl.scrollIntoView({ block: 'center', behavior: calm ? 'auto' : 'smooth' }); } catch (_) { /* старый браузер */ }
    try { ctrl.focus({ preventScroll: true }); } catch (_) { /* поле исчезло */ }
}

export async function renderBranchPage(container, opts = {}) {
    const {
        row = null, company = null, own = false, readOnly = false, secondary = false,
        onDone = null, onBack = null, onNavigate = null,
    } = opts;
    const isNew = !row || !row.id;
    const lockAll = readOnly || secondary;    // филиал или «Просмотр» — только видно
    const lockCompany = lockAll || own;       // своё здание главного: адрес, карта, телефон — в «Компании»
    const state = { ...BRANCH_DEFAULTS, ...(own ? overlayOwnBuilding(row, company) : (row || {})) };
    const errs = {};
    let availability = () => ({});            // задача 13 — доступность списков адреса
    let busy = false;

    // ---- название и «Работает» ----
    const name = triGroup('Название филиала', { ru: state.name, uz: state.name_uz, en: state.name_en }, {
        key: 'bname', cellLabel: 'Название', max: NAME_MAX, disabled: lockAll, markMissing: true,
        hint: 'RU — так филиал называется во всей программе, в отчётах и при связи зданий. UZ и EN получают сайт и партнёры.',
        onInput: (l, v) => { state[l === 'ru' ? 'name' : 'name_' + l] = v; },
    });
    errs.name = name.inputs.ru.err;
    const activeChk = h('input', { type: 'checkbox' });
    activeChk.checked = Number(state.active) !== 0;
    activeChk.disabled = lockAll;
    activeChk.addEventListener('change', () => { state.active = activeChk.checked ? 1 : 0; });

    // ---- телефон для пациентов ----
    const phone = phoneInput('phone', '+998 71 200 12 00', { value: state.phone });
    phone.disabled = lockCompany;
    const phoneBox = labeled('Телефон для пациентов', phone, { key: 'bphone', hint: 'У пациентов это кнопка «Позвонить».' });
    // Подпись — к самому полю ввода, а не к обёртке с флажком страны.
    const phoneId = phone.getAttribute('id');
    phone.removeAttribute('id');
    phone.input.setAttribute('id', phoneId);
    phoneBox.err.ctrl = phone.input;
    errs.phone = phoneBox.err;

    const cards = [
        card('Building', 'Название', name.node, isNew ? null : checkRow('Работает', activeChk)),
        card('Phone', 'Телефон', phoneBox.node),
    ];

    const collect = () => {
        state.phone = phone.value;
        return normalizeBranch(state);
    };
    const pick = (v) => Object.fromEntries(BRANCH_EDIT_COLUMNS.map((c) => [c, v[c]]));
    let loaded = pick(collect());
    const editable = lockAll ? [] : BRANCH_EDIT_COLUMNS.filter((c) => !(own && OWN_FROM_COMPANY.includes(c)) && !(isNew && c === 'active'));
    const changedOf = (v) => {
        const out = {};
        for (const c of editable) if (isNew || !same(v[c], loaded[c])) out[c] = v[c];
        return out;
    };
    const dirty = () => { if (lockAll) return false; const v = pick(collect()); return BRANCH_EDIT_COLUMNS.some((c) => !same(v[c], loaded[c])); };

    function problemsFor(v, keys) {
        const all = branchProblems(v, availability());
        const addrTouched = keys.some((k) => ADDRESS_COLUMNS.includes(k));
        const out = {};
        for (const [k, msg] of Object.entries(all)) {
            const mine = k === 'name' ? (isNew || keys.includes('name')) : (keys.includes(k) || (addrTouched && ADDRESS_COLUMNS.includes(k)));
            if (mine) out[k] = msg;
        }
        return out;
    }
    function showProblems(p, { focus = false } = {}) {
        for (const [k, e] of Object.entries(errs)) {
            const m = p[k];
            if (Array.isArray(m)) e.set(m[0], m[1]); else e.set(m || '');
        }
        if (!focus) return;
        const bad = (k) => !!(p[k] && errs[k] && errs[k].ctrl);
        const first = FIELD_ORDER.find(bad) || Object.keys(p).find(bad);
        if (first) focusField(errs[first].ctrl);
    }

    const saveBtn = lockAll ? null : h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => save() },
        Icon('Check', { size: 14 }), ' ', isNew ? 'Добавить' : 'Сохранить');
    async function save() {
        if (busy || lockAll) return;
        const v = collect();
        const payload = changedOf(v);
        const keys = Object.keys(payload);
        if (!keys.length) { showProblems({}); toast(tr('Нет изменений'), 'info'); return; }
        const problems = problemsFor(v, keys);
        showProblems(problems, { focus: true });
        if (Object.keys(problems).length) { toast(tr('Проверьте выделенные поля.'), 'fail'); return; }
        busy = true; saveBtn.disabled = true;
        try {
            const q = isNew ? supabase.from('branches').insert(payload) : supabase.from('branches').update(payload).eq('id', row.id);
            const { data, error } = await q.select().single();
            if (error) throw error;
            loaded = pick(v);
            toast(tr('Филиал сохранён'), 'ok');
            if (typeof onDone === 'function') await onDone(data);
            // Без onDone новое здание остаётся на странице — уже как записанное
            // (вторая «Добавить» завела бы его ещё раз).
            else if (isNew && data && data.id) await renderBranchPage(container, { ...opts, row: data });
        } catch (e) {
            // Сервер назвал поле (/api/db: { field, message } — те же правила, что у экрана): объяснение под ним.
            const field = e && e.field === 'working_hours' ? 'hours' : e && e.field;
            if (field && e.message && errs[field]) showProblems({ [field]: e.message }, { focus: true });
            toast(tr((e && e.message) || 'Не удалось сохранить.'), 'fail');
        } finally { busy = false; saveBtn.disabled = false; }
    }

    // Уйти со страницы: без несохранённого — сразу; с ним — спросить.
    const leave = (go) => { if (busy) return; if (lockAll || !dirty() || askDiscard()) go(); };
    const back = h('button', { class: 'btn btn-outline btn-sm', type: 'button', style: { marginBottom: '14px' },
        onclick: () => leave(() => { if (typeof onBack === 'function') onBack(); }) },
        Icon('ChevronLeft', { size: 14 }), ' ', 'К списку филиалов');
    const title = isNew ? h('h1', { class: 'page-title' }, 'Новый филиал')
        : h('h1', { class: 'page-title' }, document.createTextNode(state.name || '—'));
    const actions = lockAll ? h('span', { class: 'muted brf-lock' }, Icon('Lock', { size: 14 }), ' ', 'Только просмотр') : saveBtn;
    const notes = [];
    if (secondary) {
        notes.push(h('p', { class: 'cpf-note', role: 'note' }, Icon('Building', { size: 16 }), h('span', null, BRANCH_MESSAGES.mainOnly)));
    } else if (own) {
        notes.push(h('div', { class: 'cpf-note brf-own', role: 'note' }, Icon('Info', { size: 16 }),
            h('span', null, 'Адрес для партнёров, телефон и карта этого здания — из «Компании»: там их и меняйте.'),
            h('button', { class: 'btn btn-outline btn-sm', type: 'button',
                onclick: () => leave(() => { if (typeof onNavigate === 'function') onNavigate('documents-settings'); }) }, 'Изменить в «Компании»')));
    }
    clear(container);
    container.appendChild(h('div', { class: 'fade-in brf-page' },
        back,
        h('div', { class: 'page-head' },
            h('div', null, h('div', { class: 'brf-title' }, title, own ? Tag('Это здание', { kind: 'teal' }) : null), h('p', { class: 'page-subtitle' },
                'Название и адрес на трёх языках, карта, часы работы и показ на сайте. Эти данные получат сайт клиники, Symptex и партнёры.')),
            h('div', { class: 'page-head-actions' }, actions)),
        ...notes,
        h('div', { class: 'cpf-stack' }, ...cards)));
}
