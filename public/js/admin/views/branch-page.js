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
// поле не может быть затёрто ничем.
//
// CLINIC_API_STEP7_V1 — решение владельца 11 по зданиям: пока включено
// подключение API (window.CLINIC.api_address_required), у филиала, показанного
// на сайте (работает и «Показывать на сайте»), адрес для партнёров обязателен —
// звёздочки, строка над полями и проверка до записи; отказ сервера
// partner_address_required — объяснение под полем и фокус, флаг исправляется.
// Своё здание главного (адрес — «Компания») и филиал-установка — без этого. Страница вместо окна макета (решение Р12):
// карточки шага 3 переиспользуются как есть, на телефоне — один столбец.
import { supabase } from '../../supabase.js';
import { h, Icon, clear, toast, Tag } from '../ui.js';
import { tr, trf } from '../i18n.js';
import { isRouteAllowed } from '../permissions.js';   // ревью 6 — «Изменить в «Компании»» только тому, кому она открыта
import { phoneInput } from '../phone-input.js?v=ph1';
import { triGroup, labeled } from './company-fields.js';
import { addressCard, mapCard } from './company-address.js';   // те же карточки, что «Компания»
import { NAME_MAX, partnerAddressProblems } from '../../shared/clinic-profile.js';   // CLINIC_API_STEP7_V1 — partnerAddressProblems
import { refreshClinicBrand } from '../clinic-context.js?v=localclinic2';   // CLINIC_API_STEP7_V1 — свежий флаг «адрес обязателен»
import { BRANCH_EDIT_COLUMNS, OWN_FROM_COMPANY, BRANCH_MESSAGES, LANDMARK_MAX, PHONE_MAX, normalizeBranch, branchProblems, overlayOwnBuilding,
    branchShownToPartners } from '../../shared/branch-profile.js';   // CLINIC_API_STEP7_V1 — branchShownToPartners
import { readBranchHours, writeBranchHours, hoursProblem } from '../../shared/branch-hours.js';
import { hoursCard, DAY_LABEL } from './branch-hours-card.js';   // задача 14 — часы и предупреждение о сотрудниках, чьё время закроется

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
// CLINIC_API_STEP7_V1 — включено ли подключение API (флаг записи клиники, только главное здание).
const apiAddressRequired = () => !!(typeof window !== 'undefined' && window.CLINIC && window.CLINIC.api_address_required);

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
        registerLeave = null,   // CLINIC_API_STEP7_V1 (ревью слияния №4) — уход извне через ту же защиту
    } = opts;
    const isNew = !row || !row.id;
    const lockAll = readOnly || secondary;    // филиал или «Просмотр» — только видно
    const lockCompany = lockAll || own;       // своё здание главного: адрес, карта, телефон — в «Компании»
    const state = { ...BRANCH_DEFAULTS, ...(own ? overlayOwnBuilding(row, company) : (row || {})) };
    const errs = {};
    let availability = () => ({});            // задача 13 — доступность списков адреса
    let busy = false;
    let asking = false;                       // открыт вопрос «эти врачи / сотрудники потеряют часы приёма»
    let gen = 0;                              // поколение сохранения (ревью 2)

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
    activeChk.addEventListener('change', () => { state.active = activeChk.checked ? 1 : 0; syncRequired(); });

    // ---- телефон для пациентов ----
    const phone = phoneInput('phone', '+998 71 200 12 00', { value: state.phone });
    phone.input.setAttribute('maxlength', String(PHONE_MAX));   // ревью шага 4, #3 — предел виден полю, а не только серверу
    phone.disabled = lockCompany;
    const phoneBox = labeled('Телефон для пациентов', phone, { key: 'bphone', hint: 'У пациентов это кнопка «Позвонить».' });
    // Подпись — к самому полю ввода, а не к обёртке с флажком страны.
    const phoneId = phone.getAttribute('id');
    phone.removeAttribute('id');
    phone.input.setAttribute('id', phoneId);
    phoneBox.err.ctrl = phone.input;
    errs.phone = phoneBox.err;

    // ---- адрес для партнёров, ориентир, карта, показ на сайте (задача 13) ----
    const landmark = triGroup('Ориентир', { ru: state.landmark_ru, uz: state.landmark_uz, en: state.landmark_en }, {
        key: 'landmark', max: LANDMARK_MAX, disabled: lockAll,   // без «нет перевода»: ориентир необязателен (макет: noMiss)
        hint: 'Необязательно. Например: «напротив парка», «вход со двора».',
        onInput: (l, v) => { state['landmark_' + l] = v; },
    });
    // Р3 — прежний адрес, вписанный руками в старом списке, больше не правится:
    // виден, пока его не перенесут в списки и улицу. У своего здания главного
    // адрес — в «Компании»: второго адреса здесь не рисуем.
    const legacy = !own && String(state.address || '').trim()
        ? h('p', { class: 'cpf-hint' }, document.createTextNode(trf('Прежний адрес из списка: {address}', { address: String(state.address).trim() })))
        : null;
    // CLINIC_API_STEP7_V1 — адрес обязателен: подключение включено, адрес правится
    // здесь (не своё здание главного, не филиал-установка) и здание видно на сайте.
    const needsAddress = () => apiAddressRequired() && !lockCompany && branchShownToPartners(state);
    const address = addressCard(state, {
        title: 'Адрес для партнёров и сайта', disabled: lockCompany, after: [landmark.node, legacy].filter(Boolean),
        required: needsAddress(),   // CLINIC_API_STEP7_V1
        hint: 'Страна, город и район — из списков, как при регистрации пациента; партнёры получают их коды. Ориентир помогает пациенту найти вход.',
    });
    Object.assign(errs, address.errs);
    availability = () => address.availability();
    const map = mapCard(state, { label: 'Ссылка на филиал в Яндекс Картах', disabled: lockCompany,
        hint: 'Найдите здание в Яндекс Картах, нажмите «Поделиться» и скопируйте ссылку. У каждого здания своя ссылка.' });
    errs.maps_url = map.err;
    const pubChk = h('input', { type: 'checkbox' });
    pubChk.checked = Number(state.show_public) !== 0;
    pubChk.disabled = lockAll;
    pubChk.addEventListener('change', () => { state.show_public = pubChk.checked ? 1 : 0; syncRequired(); });
    const pubCard = card('Globe', 'Сайт и партнёры', checkRow('Показывать филиал на сайте и у партнёров', pubChk),
        h('p', { class: 'cpf-hint' }, 'Скрытый филиал работает в программе как обычно, но не виден пациентам на сайте и у партнёров; его врачей там тоже не покажут.'));

    // CLINIC_API_STEP7_V1 — звёздочки и строка «адрес обязателен» по текущему состоянию.
    function syncRequired() { address.setRequired(needsAddress()); }

    // ---- часы работы (задача 14) ----
    const hours = readBranchHours(state.working_hours, state.is_24_7);
    const hoursUi = hoursCard(hours, { disabled: lockAll });
    errs.hours = hoursUi.err;

    const cards = [
        card('Building', 'Название', name.node, isNew ? null : checkRow('Работает', activeChk)),
        card('Phone', 'Телефон', phoneBox.node),
        address.node, map.node, hoursUi.node, pubCard,
    ];

    const collect = () => {
        Object.assign(state, writeBranchHours(hours));   // сетка → колонки (так их читает движок записи)
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
        // Часы проверяются, если их меняли. Третий элемент — к какому полю вести
        // (ревью 8): понедельник, если рабочих дней нет, иначе «до» этого дня.
        if (keys.includes('working_hours') || keys.includes('is_24_7')) {
            const hp = hoursProblem(hours);
            if (hp) out.hours = [hp.template, hp.day ? { day: tr(DAY_LABEL[hp.day]) } : undefined, hp.day || 'noDay'];
        }
        return out;
    }
    function showProblems(p, { focus = false } = {}) {
        for (const [k, e] of Object.entries(errs)) {
            const m = p[k];
            if (k === 'hours') hoursUi.pointAt(Array.isArray(m) ? m[2] : null);   // ревью 8 — у ошибки часов есть поле
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
        busy = true; saveBtn.disabled = true;
        const mine = ++gen;   // ревью 2 — уход со страницы делает это сохранение чужим
        try {
            // Ревью 1 — что записать, считается ПОСЛЕ проверки часов: пока шла
            // проверка или был открыт вопрос, человек мог дописать другие поля,
            // и уходит текущее (с той же проверкой полей). Часы, изменённые за
            // время проверки, проверяются заново; правка часов при открытом
            // вопросе снимает его (ответ «нет»).
            let v, payload, checked = null;
            for (;;) {
                v = collect();
                payload = changedOf(v);
                const keys = Object.keys(payload);
                if (!keys.length) { showProblems({}); toast(tr('Нет изменений'), 'info'); return; }
                const problems = problemsFor(v, keys);
                // CLINIC_API_STEP7_V1 — решение владельца 11: пока включено подключение,
                // адрес филиала на сайте обязателен целиком, что бы ни меняли (сервер,
                // routes/db.js, откажет так же).
                if (needsAddress()) for (const [k, msg] of Object.entries(partnerAddressProblems(v, availability()))) problems[k] = msg;
                showProblems(problems, { focus: true });
                if (Object.keys(problems).length) { toast(tr('Проверьте выделенные поля.'), 'fail'); return; }
                // «Каким врачам какое время закроется» — до записи (спецификация).
                // Только новые часы «По дням недели» могут закрыть время; у нового
                // здания врачей ещё нет.
                const hoursTouched = keys.includes('working_hours') || keys.includes('is_24_7');
                const sameAsChecked = !!checked && checked.working_hours === v.working_hours && checked.is_24_7 === v.is_24_7;
                if (isNew || hours.mode !== 'week' || !hoursTouched || sameAsChecked) break;
                asking = true;
                let go = false;
                try { go = await confirmHours(v); } finally { asking = false; }
                if (!go || mine !== gen) return;
                checked = { working_hours: v.working_hours, is_24_7: v.is_24_7 };
            }
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
            // CLINIC_API_STEP7_V1 — сервер знает, что подключение включено, а флаг экрана
            // устарел: исправить флаг, поставить звёздочки, показать под полями, чего не
            // хватает (та же partnerAddressProblems), и вести к первому полю.
            if (e && e.code === 'partner_address_required' && !lockCompany) {
                if (typeof window !== 'undefined' && window.CLINIC) window.CLINIC.api_address_required = true;
                syncRequired();
                const missing = partnerAddressProblems(collect(), availability());
                if (e.field && !missing[e.field] && errs[e.field]) missing[e.field] = e.message;
                showProblems(missing, { focus: true });
                toast(tr(e.message || 'Проверьте выделенные поля.'), 'fail');
                return;
            }
            // Сервер назвал поле (/api/db: { field, message } — те же правила, что у экрана): объяснение под ним.
            const field = e && e.field === 'working_hours' ? 'hours' : e && e.field;
            if (field && e.message && errs[field]) showProblems({ [field]: e.message }, { focus: true });
            toast(tr((e && e.message) || 'Не удалось сохранить.'), 'fail');
        } finally { busy = false; saveBtn.disabled = false; }
    }

    // Сервер считает тем же движком, что слоты записи (RPC branch_hours_impact).
    async function confirmHours(v) {
        const { data, error } = await supabase.rpc('branch_hours_impact', { branch_id: row.id, working_hours: v.working_hours, is_24_7: v.is_24_7 });
        if (error) {
            toast(trf('Не удалось проверить, у кого из сотрудников закроется время: {msg}', { msg: tr(error.message || '') }), 'fail');
            return false;
        }
        const doctors = data && Array.isArray(data.doctors) ? data.doctors : [];
        return doctors.length ? hoursUi.askImpact(doctors) : true;
    }

    // Уйти со страницы: без несохранённого — сразу; с ним — спросить.
    // Открытый вопрос о врачах не держит человека на странице: уход снимает его
    // (ответ «нет» — ничего не записано), дальше — как обычно.
    // Ревью 2 — ушли, пока проверка часов ещё шла: её ответ больше ничего не пишет.
    const leave = (go) => {
        if (busy && !asking) return;
        if (!(lockAll || !dirty() || askDiscard())) return;
        gen++;
        if (asking) hoursUi.clearImpact();
        go();
    };
    // CLINIC_API_STEP7_V1 (ревью слияния №4) — уход, который начинает не страница
    // («Открыть «Филиалы»» из окна подключения в хаб из кэша), идёт через ту же
    // защиту несохранённого.
    if (typeof registerLeave === 'function') registerLeave(leave);
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
        // Ревью 6 — кнопка ведёт в «Компанию» только того, кому она открыта;
        // остальным — объяснение, кто её меняет (иначе «Нет доступа» после
        // брошенных правок).
        const canCompany = isRouteAllowed('documents-settings');
        notes.push(h('div', { class: 'cpf-note brf-own', role: 'note' }, Icon('Info', { size: 16 }),
            h('span', null, canCompany
                ? 'Адрес для партнёров, телефон и карта этого здания — из «Компании»: там их и меняйте.'
                : 'Адрес для партнёров, телефон и карта этого здания — из «Компании»; её меняет администратор или тот, кому выдано изменение «Компании».'),
            canCompany ? h('button', { class: 'btn btn-outline btn-sm', type: 'button',
                onclick: () => leave(() => { if (typeof onNavigate === 'function') onNavigate('documents-settings'); }) }, 'Изменить в «Компании»') : null));
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
    map.load(); await address.load();   // списки адреса грузятся уже с сохранёнными кодами
    // CLINIC_API_STEP7_V1 — флаг мог устареть (подключение включили или выключили в
    // другом окне): перечитать запись клиники и поставить звёздочки по свежему.
    if (!lockCompany) refreshClinicBrand(supabase).then(syncRequired).catch(() => {});
}
