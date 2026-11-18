// WAIT_REG_V1 (3.25.0, 2026-11-17) — вкладка «Ждут регистрации» раздела «Пациенты».
//
// Владелец: «in the registrator window we should show the patients that were sent and patients
// for which we created a booking so registrators won't be confused; create a forcing function».
// Решение владельца: запись выставляется в счёт ПО ПРИХОДУ — «Оформить по записи» открывает окно
// визита с записанными услугами, окно выставляет счёт ровно на них, пациент идёт в кассу.
//
// CRM_BOOKINGS_TAB_V1 (3.25.0, 2026-11-17) — ВКЛАДКА СТАЛА «ЗАПИСИ CRM»: СПИСОК ЗАПИСЕЙ С ФИЛЬТРАМИ.
// Решение владельца (с макета): регистратор видит записи, не выбирая врача, кабинет или услугу.
// Полоса фильтров над списком (клавиатурой — обычные кнопки, поля с подписью; состояние живёт, пока
// живёт вкладка — хост её не размонтирует при переходе на соседнюю; «Сбросить фильтры»):
//   • День: «Сегодня» (по умолчанию), «Завтра», «7 дней» (сегодня … +6), дата. Прошлая дата — сразу
//     «Не пришли»: «Ждут» прошлого дня пусты (неоформленное прошлого дня сервер считает «не пришёл»);
//   • Источник: «Все», «CRM / колл-центр» (по умолчанию), «Календарь», «Сайт / партнёр», «Направил врач»;
//   • Статус: «Ждут» (по умолчанию — прежнее правило «ждёт»), «Оформлены», «Не пришли», «Отменены», «Все»;
//   • Врач: «Все врачи» или один (список — с сервера: is_doctor или роль «Врач»);
//   • Поиск: имя, телефон, номер карты (ищет сервер).
// Даты «Завтра» и «7 дней» считаются от дня СЕРВЕРА (ответ today), а не от часов браузера; «Сегодня»
// не шлёт дня вовсе — день решает сервер. Строка: время (или «за день»), пациент (имя открывает карту,
// номер карты, телефон), источники и кто записал, врачи, услуги («услуга не выбрана»), статус словами,
// причина отмены. «Оформить по записи» — ТОЛЬКО у строки «сегодня + Ждёт»; у остальных — «Открыть
// карту». Порядок — сервера: по дню, по времени, «за день» — после строк со временем. Несколько дней —
// заголовок дня над его строками. Счётчик вкладки (patients-hub.js) — по фильтру ПО УМОЛЧАНИЮ, а не по
// текущему: при других фильтрах вкладка отдельно спрашивает число (count_only, BADGE_ARGS).
//
// Что здесь:
//   • список ожидаемых пациентов — строка на пациента (и день, и статус): время, пациент
//     (имя открывает карту, номер карты, телефон), откуда он (колл-центр / CRM, календарь, сайт /
//     партнёр, направил врач), врач, услуги, кто записал, и «Оформить по записи»;
//   • считает и решает СЕРВЕР (registrar_waiting, rpc/registrar-waiting.js): источники, кто уже
//     зарегистрирован и кто ещё ждёт, фильтры. Экран только рисует;
//   • openRegisterByBooking — «Оформить по записи» для любого места (эта вкладка, быстрая
//     регистрация): окно визита пациента. Записанные строки, направления врача и анализы «на дату»
//     окно берёт само (visit-wizard.js prefillFromBooking / prefillFromDoctorOrders /
//     prefillFromCrm), и убрать их молча нельзя (booked-drop.js).
import { h, Icon, clear, toast } from '../ui.js';
import { tr, trf, monthName } from '../i18n.js';
import { supabase } from '../../supabase.js';
import { loadPatientById } from '../data.js';

/** Стойка — администратор и регистратура (зеркало сервера: rpc/registrar-waiting.js WAITING_ROLES). */
export const WAITING_ROLES = Object.freeze(['admin', 'registrar']);

/** Подпись источника — шаблон и параметры (переводит вызывающий: trf). */
export function sourceText(src) {
    const kind = src && src.kind;
    if (kind === 'crm') return { template: 'Колл-центр / CRM', params: {} };
    if (kind === 'partner') return src.name ? { template: 'Сайт / партнёр · {name}', params: { name: src.name } } : { template: 'Сайт / партнёр', params: {} };
    if (kind === 'doctor') return src.name ? { template: 'Направил врач {name}', params: { name: src.name } } : { template: 'Направил врач', params: {} };
    return { template: 'Календарь', params: {} };
}
const SOURCE_TAG = { crm: 'tag-teal', calendar: 'tag-ok', partner: 'tag-purple', doctor: 'tag-info' };
const SOURCE_ICON = { crm: 'Headset', calendar: 'Calendar', partner: 'Globe', doctor: 'Stethoscope' };

// ─── CRM_BOOKINGS_TAB_V1: фильтры ───────────────────────────────────────────
const DAY_CHOICES = [
    { id: 'today', label: 'Сегодня' },
    { id: 'tomorrow', label: 'Завтра' },
    { id: 'week', label: '7 дней' },
];
const SOURCE_CHOICES = [
    { id: 'all', label: 'Все' },
    { id: 'crm', label: 'CRM / колл-центр' },
    { id: 'calendar', label: 'Календарь' },
    { id: 'partner', label: 'Сайт / партнёр' },
    { id: 'doctor', label: 'Направил врач' },
];
const STATUS_CHOICES = [
    { id: 'waiting', label: 'Ждут' },
    { id: 'registered', label: 'Оформлены' },
    { id: 'no_show', label: 'Не пришли' },
    { id: 'cancelled', label: 'Отменены' },
    { id: 'all', label: 'Все' },
];
// Статус строки словами (чип) и его цвет.
const STATUS_CHIP = {
    waiting: { label: 'Ждёт', tag: 'tag-warn', icon: 'Clock' },
    registered: { label: 'Оформлен', tag: 'tag-ok', icon: 'Check' },
    no_show: { label: 'Не пришёл', tag: 'tag-crit', icon: 'Warning' },
    cancelled: { label: 'Отменена', tag: '', icon: 'X' },
};

/** Фильтры по умолчанию (решение владельца): сегодня, CRM / колл-центр, «Ждут», все врачи, без поиска. */
export const DEFAULT_FILTER = Object.freeze({ day: 'today', date: '', source: 'crm', status: 'waiting', doctorId: '', q: '' });

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const pad2 = (n) => String(n).padStart(2, '0');
/** Местный день браузера — запасной, пока сервер не назвал свой. */
function localYmd(d = new Date()) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
/** День + n дней: календарная арифметика строки 'ГГГГ-ММ-ДД' (без часовых поясов). */
export function addDays(ymd, n) {
    const [y, m, d] = String(ymd).split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/**
 * Аргументы сервера по фильтру. today — день сервера (ответ today); нет — день браузера. «Сегодня» и
 * «Ждут» — умолчания сервера и не шлются.
 */
export function filterArgs(f, today = null) {
    const base = today && YMD.test(today) ? today : localYmd();
    const args = {};
    if (f.day === 'tomorrow') args.day = addDays(base, 1);
    else if (f.day === 'week') { args.from = base; args.to = addDays(base, 6); }
    else if (f.day === 'date' && YMD.test(String(f.date || ''))) args.day = f.date;
    if (f.source && f.source !== 'all') args.sources = [f.source];
    if (f.status && f.status !== 'waiting') args.status = f.status;
    if (f.doctorId !== '' && f.doctorId != null && Number(f.doctorId) > 0) args.doctor_id = Number(f.doctorId);
    const q = String(f.q || '').trim();
    if (q) args.q = q;
    return args;
}

/** Счётчик вкладки — фильтр по умолчанию (сегодня, CRM, «Ждут»): { sources: ['crm'] }. */
export const BADGE_ARGS = Object.freeze(filterArgs(DEFAULT_FILTER));

/** Фильтр — по умолчанию? (тогда число строк списка — и есть счётчик вкладки). */
export function isDefaultFilter(f) {
    return ['day', 'source', 'status'].every((k) => f[k] === DEFAULT_FILTER[k])
        && !(f.doctorId !== '' && f.doctorId != null) && !String(f.q || '').trim();
}

/**
 * «Оформить по записи» — только у строки «сегодня + Ждёт». Строка прежнего вида (без дня и статуса —
 * старый сервер, подмены тестов) — сегодняшняя «ждёт».
 */
export function canRegisterRow(r, today) {
    const status = (r && r.status) || 'waiting';
    const day = r && r.day;
    return status === 'waiting' && (!day || !today || day === today);
}

/**
 * Список «Записи CRM» с сервера. Бросает при отказе сервера: пустой ответ — это «никого», а отказ —
 * не он. patientId — только этот пациент (быстрая регистрация спрашивает про одного; без фильтров —
 * прежнее правило: сегодня, все источники, «ждёт»). countOnly — только число (счётчик вкладки):
 * сервер не собирает подписи (WAIT_REG_V1, ревью M6). args — фильтры (filterArgs).
 */
export async function loadRegistrarWaiting({ patientId = null, countOnly = false, args = null } = {}) {
    const body = { ...(args || {}) };
    if (patientId != null) body.patient_id = Number(patientId);
    if (countOnly) body.count_only = true;
    const { data, error } = await supabase.rpc('registrar_waiting', body);
    if (error) throw new Error(error.message || String(error));
    const rows = data && Array.isArray(data.rows) ? data.rows : [];
    const count = countOnly && data && Number.isFinite(Number(data.count)) ? Number(data.count) : rows.length;
    return { today: (data && data.today) || null, from: (data && data.from) || null, to: (data && data.to) || null,
        count, rows, doctors: data && Array.isArray(data.doctors) ? data.doctors : [] };
}

/** Ждёт ли пациент регистрации сегодня (запись, анализ «на дату», направление врача). Сбой — нет. */
export async function patientWaitsToday(patientId) {
    try { return (await loadRegistrarWaiting({ patientId })).count > 0; } catch (_) { return false; }
}

/**
 * «Оформить по записи» — окно визита пациента на сегодня. Окно само ставит в смету записанные
 * строки («из записи»), направления врача («от врача») и анализы «на дату» («из заявки»), а
 * выставляет счёт при подтверждении. opts.presetServiceIds — услуги, набранные до этого в другом
 * окне (быстрая регистрация), без пометки «из заявки».
 * WAIT_REG_V1 (ревью L2, M5, решение владельца):
 *   presetLines — строки другого окна целиком ({ service_id | consultation_type_id, doctor_id,
 *     package, name, price }): врач, пакет и консультация по виду приёма не теряются;
 *   referralSourceId — «Код отправителя» другого окна;
 *   bookingDoctorId — запись без услуги: окно открыто на врача записи.
 * → то, что вернуло окно визита (его пульт — окно открыто), или null.
 */
export async function openRegisterByBooking(patient, { onSaved = null, presetServiceIds = [], presetLines = [], referralSourceId = null,
    bookingDoctorId = null, openWizard = null } = {}) {
    if (!patient || patient.id == null) return null;
    const full = await loadPatientById(patient.id).catch(() => null);
    // Окну — те же поля, что даёт ему карта пациента (patient-card.js patientStub):
    // loadPatientById отдаёт карту в виде экрана (fullName), а не строки базы.
    const stub = {
        id: (full && full.id != null) ? full.id : patient.id,
        full_name: (full && (full.fullName || full.full_name)) || patient.full_name || patient.patient_name || '',
        mrn: full && full.mrn && full.mrn !== '—' ? full.mrn : (patient.mrn || ''),
        phone: (full && full.phone) || patient.phone || '',
    };
    const open = openWizard || (await import('./visit-wizard.js?v=ownrep4')).openVisitWizard;
    const ids = (presetServiceIds || []).filter((x) => Number.isInteger(Number(x)) && Number(x) > 0).map(Number);
    const wizOpts = {};
    if (ids.length) { wizOpts.presetServiceIds = ids; wizOpts.presetFromCrm = false; }
    const lines = (presetLines || []).filter((l) => l && (Number(l.service_id) > 0 || Number(l.consultation_type_id) > 0));
    if (lines.length) { wizOpts.presetLines = lines; wizOpts.presetFromCrm = false; }
    if (referralSourceId != null && referralSourceId !== '') wizOpts.referralSourceId = referralSourceId;
    if (Number(bookingDoctorId) > 0) wizOpts.bookingDoctorId = Number(bookingDoctorId);
    const handle = await open(typeof onSaved === 'function' ? onSaved : () => {}, stub, wizOpts);
    return handle || null;
}

/**
 * WAIT_REG_V1 (ревью M5, решение владельца) — что передать окну визита по строке списка: строки записи
 * соседнего здания (окно визита их не прочтёт — счёт по визиту соседа не выставить, стойка оформляет
 * своим визитом) — набранными услугами; запись без услуги — врачом записи.
 */
export function registerOptsOf(r) {
    const lines = (r && r.lines) || [];
    const presetLines = lines.filter((l) => l.foreign && l.kind === 'booked')
        .map((l) => ({ service_id: l.service_id ?? null, consultation_type_id: l.consultation_type_id ?? null,
            doctor_id: l.doctor_id ?? null, name: l.name || '' }));
    const bare = lines.find((l) => l.kind === 'booking' && Number(l.doctor_id) > 0);
    return { presetLines, bookingDoctorId: bare ? Number(bare.doctor_id) : null };
}

/** Заголовок дня: «18 ноября», и «Сегодня» / «Завтра», когда это они. */
function dayLabel(ymd, today) {
    const [, m, d] = String(ymd).split('-').map(Number);
    const word = `${d} ${monthName(m - 1)}`;
    const rel = ymd === today ? tr('Сегодня') : (today && ymd === addDays(today, 1) ? tr('Завтра') : '');
    return [rel, word].filter(Boolean).join(', ');
}

/**
 * Вкладка «Записи CRM». ctx — { onNavigate, onCount(n) }; deps — подмены тестов (load(opts),
 * openWizard, filter — начальные фильтры поверх умолчаний).
 */
export async function renderRegistrarWaiting(host, ctx = {}, deps = {}) {
    clear(host);
    const state = { rows: [], today: null, from: null, to: null, doctors: [], loading: true, error: '', busy: false,
        filter: { ...DEFAULT_FILTER, ...(deps.filter || {}) } };
    const load = deps.load || loadRegistrarWaiting;
    let token = 0;   // CRM_BOOKINGS_TAB_V1 — ответ на устаревший фильтр не рисуется
    const root = h('div', { class: 'rwait', 'data-registrar-waiting': '' });
    host.appendChild(root);
    const head = h('div', { class: 'card rwait-head' });
    const filters = h('div', { class: 'card rwait-filters', 'data-rwait-filters': '', role: 'search', 'aria-label': 'Фильтры записей' });
    const list = h('div', { class: 'card rwait-card' });
    root.appendChild(head);
    root.appendChild(filters);
    root.appendChild(list);

    // ── полоса фильтров: строится ОДИН раз (фокус и набранный поиск не теряются), дальше — только отметки ──
    const segButtons = { day: [], source: [], status: [] };
    const segGroup = (key, label, choices, attr) => {
        const btns = choices.map((c) => {
            const b = h('button', { type: 'button', 'aria-pressed': 'false', [attr]: c.id, onclick: () => pick(key, c.id) }, c.label);
            segButtons[key].push([c.id, b]);
            return b;
        });
        return h('div', { class: 'rwait-f', role: 'group', 'aria-label': label },
            h('span', { class: 'rwait-f-l', 'aria-hidden': 'true' }, label), h('div', { class: 'segmented' }, ...btns));
    };
    const dateInp = h('input', { type: 'date', class: 'rwait-date', 'data-rwait-date': '', 'aria-label': 'Дата',
        // CRM_BOOKINGS_TAB_V1 (вид) — подпись пустого поля: её показывает календарь программы (ui-datefield.js).
        placeholder: tr('Другая дата'),
        onchange: () => { if (dateInp.value) pickDate(dateInp.value); } });
    const doctorSel = h('select', { class: 'rwait-doctor', 'data-rwait-doctor': '', 'aria-label': 'Врач',
        onchange: () => setFilter({ doctorId: String(doctorSel.value || '') }) });
    const qInp = h('input', { type: 'search', class: 'rwait-q', 'data-rwait-q': '', autocomplete: 'off',
        'aria-label': 'Поиск: имя, телефон или номер карты', placeholder: 'Имя, телефон или номер карты',
        // ui.js (SEARCH_DEBOUNCE_V1) даёт полю поиска паузу перед 'input'; Enter — сразу.
        oninput: () => { if (String(qInp.value || '').trim() !== String(state.filter.q || '').trim()) setFilter({ q: String(qInp.value || '') }); },
        onkeydown: (e) => { if (e && e.key === 'Enter') { if (typeof e.preventDefault === 'function') e.preventDefault(); setFilter({ q: String(qInp.value || '') }, { force: true }); } } });
    const resetBtn = h('button', { type: 'button', class: 'btn btn-sm btn-outline', 'data-rwait-reset': '',
        onclick: () => { state.filter = { ...DEFAULT_FILTER }; qInp.value = ''; void apply(); } },
    Icon('Refresh', { size: 13 }), ' ', tr('Сбросить фильтры'));
    filters.appendChild(h('div', { class: 'rwait-frow' },
        h('div', { class: 'rwait-f rwait-f-day' }, segGroup('day', 'День', DAY_CHOICES, 'data-rwait-day'), dateInp),
        segGroup('source', 'Источник', SOURCE_CHOICES, 'data-rwait-src'),
        segGroup('status', 'Статус', STATUS_CHOICES, 'data-rwait-status')));
    filters.appendChild(h('div', { class: 'rwait-frow' },
        h('label', { class: 'rwait-f' }, h('span', { class: 'rwait-f-l' }, tr('Врач')), doctorSel),
        h('label', { class: 'rwait-f rwait-f-q' }, h('span', { class: 'rwait-f-l' }, tr('Поиск')), qInp),
        resetBtn));

    function pick(key, value) {
        if (key === 'day') setFilter({ day: value, date: '' });
        else setFilter({ [key]: value });
    }
    function pickDate(value) {
        const patch = { day: 'date', date: value };
        // Прошлый день: «Ждут» его пусты (неоформленное прошлого дня — «не пришёл») — сразу «Не пришли».
        const today = state.today || localYmd();
        if (value < today && state.filter.status === 'waiting') patch.status = 'no_show';
        setFilter(patch);
    }
    function setFilter(patch, { force = false } = {}) {
        const next = { ...state.filter, ...patch };
        const same = JSON.stringify(filterArgs(next, state.today)) === JSON.stringify(filterArgs(state.filter, state.today))
            && next.day === state.filter.day;
        state.filter = next;
        if (same && !force) { paintFilters(); return; }
        void apply();
    }
    async function apply() { paintFilters(); await reload(); }

    let doctorsKey = null;
    function paintFilters() {
        const f = state.filter;
        for (const [key, btns] of Object.entries(segButtons)) {
            for (const [id, b] of btns) {
                const on = f[key] === id;
                b.className = on ? 'on' : '';
                b.setAttribute('aria-pressed', on ? 'true' : 'false');
            }
        }
        dateInp.value = f.day === 'date' ? f.date : '';
        // CRM_BOOKINGS_TAB_V1 (вид) — отметка классом, не className целиком: календарь программы
        // (ui-datefield.js) повесил на родное поле uidate-native, и затирать его значит вытащить
        // спрятанное «дд.мм.гггг» вторым полем. Видимое поле — обёртка .uidate, отметка и на ней.
        dateInp.classList.toggle('on', f.day === 'date');
        const dateWrap = typeof dateInp.closest === 'function' ? dateInp.closest('.uidate') : null;
        if (dateWrap) dateWrap.classList.toggle('on', f.day === 'date');
        // Список врачей — с сервера; выбранный остаётся и тогда, когда сервер его больше не прислал.
        const docs = [...state.doctors];
        if (f.doctorId && !docs.some((d) => String(d.id) === String(f.doctorId))) docs.push({ id: Number(f.doctorId), name: '#' + f.doctorId });
        const key = docs.map((d) => d.id + ':' + d.name).join('|');
        if (key !== doctorsKey) {
            doctorsKey = key;
            clear(doctorSel);
            doctorSel.appendChild(h('option', { value: '' }, tr('Все врачи')));
            for (const d of docs) doctorSel.appendChild(h('option', { value: String(d.id) }, d.name || ('#' + d.id)));
        }
        doctorSel.value = String(f.doctorId || '');
        if (String(qInp.value || '').trim() !== String(f.q || '').trim()) qInp.value = f.q || '';
        // ревью L5 — disabled логическим значением: h() пустую строку считает «нет».
        if (isDefaultFilter(f)) resetBtn.setAttribute('disabled', ''); else resetBtn.removeAttribute('disabled');
    }

    async function report() {
        if (typeof ctx.onCount !== 'function') return;
        // Счётчик вкладки — по фильтру по умолчанию: при нём число строк списка — оно и есть; иначе — отдельно.
        let n = null;
        if (isDefaultFilter(state.filter)) n = state.rows.length;
        else {
            try { n = (await load({ countOnly: true, args: BADGE_ARGS })).count; } catch (_) { n = null; }
        }
        if (n == null) return;
        try { ctx.onCount(n); } catch (_) { /* счётчик — не повод ронять вкладку */ }
    }

    function paintHead() {
        clear(head);
        head.appendChild(h('div', { class: 'rwait-head-text' },
            h('div', { class: 'rwait-title' }, Icon('Headset', { size: 16 }), ' ', tr('Записи CRM'),
                h('span', { class: 'rwait-count', 'data-rwait-count': String(state.rows.length) }, String(state.rows.length))),
            h('div', { class: 'rwait-sub' },
                tr('Записи колл-центра, календаря и сайта и направления врача. Пациент уходит из «Ждут», когда его оформили — со счётом или без.'))),
        h('button', { class: 'btn btn-sm btn-outline', type: 'button', 'data-rwait-refresh': '', onclick: () => { void reload(); } },
            Icon('Refresh', { size: 13 }), ' ', tr('Обновить')));
    }

    function emptyText() {
        const f = state.filter;
        if (f.day === 'today' && f.status === 'waiting' && !(f.doctorId) && !String(f.q || '').trim()) {
            if (f.source === 'all') return tr('Сегодня никого не ждём: все записанные и направленные пациенты оформлены.');
            if (f.source === 'crm') return tr('Сегодня никого не ждём: все записи CRM оформлены.');
        }
        return tr('Записей по этим фильтрам нет.');
    }

    function paintList() {
        clear(list);
        if (state.loading && !state.rows.length) { list.appendChild(h('div', { class: 'empty rwait-empty' }, tr('Загружаем…'))); return; }
        if (state.error) {
            list.appendChild(h('div', { class: 'empty rwait-empty' }, Icon('Warning', { size: 20 }),
                h('div', null, trf('Список не загрузился: {msg}', { msg: state.error }))));
            return;
        }
        if (!state.rows.length) {
            list.appendChild(h('div', { class: 'empty rwait-empty', 'data-rwait-empty': '' }, Icon('Check', { size: 20 }),
                h('div', null, emptyText())));
            return;
        }
        // Несколько дней или не сегодня — заголовок дня над его строками.
        const today = state.today;
        const headed = state.rows.some((r) => r.day && r.day !== today) || (state.from && state.to && state.from !== state.to);
        const items = [];
        let lastDay = null;
        for (const r of state.rows) {
            if (headed && r.day && r.day !== lastDay) {
                lastDay = r.day;
                items.push(h('div', { class: 'rwait-day', role: 'listitem', 'data-rwait-day-head': r.day }, Icon('Calendar', { size: 13 }), ' ', dayLabel(r.day, today)));
            }
            items.push(rowEl(r));
        }
        list.appendChild(h('div', { class: 'rwait-list', role: 'list' }, ...items));
    }

    function rowEl(r) {
        const sources = (r.sources || []).map((s) => {
            const t = sourceText(s);
            return h('span', { class: 'tag ' + (SOURCE_TAG[s.kind] || ''), 'data-rwait-source': s.kind }, Icon(SOURCE_ICON[s.kind] || 'Calendar', { size: 12 }), trf(t.template, t.params));
        });
        const meta = [r.mrn, r.phone].filter(Boolean).join(' · ');
        const status = r.status || 'waiting';
        const chip = STATUS_CHIP[status] || STATUS_CHIP.waiting;
        const canRegister = canRegisterRow(r, state.today);
        const noService = !!r.no_service || !(r.services || []).length;
        return h('div', { class: 'rwait-row', role: 'listitem', 'data-rwait-row': String(r.patient_id),
            'data-rwait-key': [r.patient_id, r.day || '', status].join('|') },
            h('div', { class: 'rwait-time' }, r.time ? h('b', null, r.time) : h('span', { class: 'muted' }, tr('за день'))),
            h('div', { class: 'rwait-who' },
                h('button', { type: 'button', class: 'link-btn rwait-pt', 'data-rwait-open': String(r.patient_id), title: tr('Открыть карту пациента'),
                    onclick: () => openCard(r.patient_id) }, r.patient_name || '—'),
                meta ? h('div', { class: 'rwait-meta' }, meta) : null,
                h('div', { class: 'rwait-tags' }, ...sources)),
            h('div', { class: 'rwait-what' },
                (r.services || []).length ? h('div', { class: 'rwait-svc' }, Icon('Stethoscope', { size: 12 }), ' ', r.services.join(', ')) : null,
                // WAIT_REG_V1 (ревью, решение владельца) — запись календаря без услуги: услугу выберет регистратор.
                noService ? h('div', { class: 'rwait-svc rwait-nosvc', 'data-rwait-no-service': '' }, Icon('Warning', { size: 12 }), ' ', tr('услуга не выбрана')) : null,
                (r.doctors || []).length ? h('div', { class: 'rwait-sub2' }, trf('Врач: {names}', { names: r.doctors.join(', ') })) : null,
                (r.booked_by || []).length ? h('div', { class: 'rwait-sub2' }, trf('Записал(а): {names}', { names: r.booked_by.join(', ') })) : null,
                (r.reasons || []).length ? h('div', { class: 'rwait-sub2 rwait-reason' }, trf('Причина: {reason}', { reason: r.reasons.join('; ') })) : null),
            h('div', { class: 'rwait-act' },
                h('span', { class: 'tag rwait-status ' + chip.tag, 'data-rwait-status-chip': status }, Icon(chip.icon, { size: 12 }), tr(chip.label)),
                // ревью L5 — disabled логическим значением: h() пустую строку считает «нет» и кнопку не гасил.
                canRegister
                    ? h('button', { type: 'button', class: 'btn btn-sm btn-primary', 'data-rwait-register': String(r.patient_id),
                        disabled: !!state.busy, onclick: () => { void register(r); } },
                    Icon('Receipt', { size: 13 }), ' ', tr('Оформить по записи'))
                    : h('button', { type: 'button', class: 'btn btn-sm btn-outline', 'data-rwait-card': String(r.patient_id),
                        onclick: () => openCard(r.patient_id) },
                    Icon('User', { size: 13 }), ' ', tr('Открыть карту'))));
    }

    async function register(r) {
        if (state.busy) return;
        state.busy = true;
        repaintKeepingFocus(paintList);   // кнопки погашены, пока окно визита открывается
        try {
            await openRegisterByBooking({ id: r.patient_id, full_name: r.patient_name, mrn: r.mrn, phone: r.phone },
                { onSaved: () => { void reload(); }, openWizard: deps.openWizard || null, ...registerOptsOf(r) });   // ревью M5 / решение владельца
        } catch (e) {
            toast((e && e.message) || tr('Не удалось открыть окно визита.'), 'fail');
        } finally {
            state.busy = false;
            repaintKeepingFocus(paintList);
        }
    }

    // WAIT_REG_V1 (ревью L5) — ПЕРЕЧИТЫВАНИЕ НЕ ОТНИМАЕТ ФОКУС: список перерисовывается целиком (живое
    // обновление, «Обновить», раз в минуту), и кнопка с фокусом клавиатуры исчезала — фокус падал в body.
    // Запоминается, ЧТО было в фокусе (кнопка какого пациента), и фокус возвращается на ту же кнопку;
    // пациента в списке больше нет — на «Обновить» (фокус остаётся во вкладке). Полоса фильтров не
    // перерисовывается — фокус в ней не теряется вовсе (CRM_BOOKINGS_TAB_V1).
    function focusedKey() {
        try {
            const a = typeof document !== 'undefined' ? document.activeElement : null;
            if (!a || a === root || typeof root.contains !== 'function' || !root.contains(a) || typeof a.getAttribute !== 'function') return null;
            for (const k of ['data-rwait-register', 'data-rwait-card', 'data-rwait-open', 'data-rwait-refresh']) {
                const v = a.getAttribute(k);
                if (v != null) return [k, v];
            }
        } catch (_) { /* без документа — нечего беречь */ }
        return null;
    }
    function repaintKeepingFocus(...paints) {
        const key = focusedKey();
        for (const p of paints) p();
        if (!key) return;
        try {
            const el = root.querySelector(`[${key[0]}="${String(key[1]).replace(/"/g, '')}"]`) || root.querySelector('[data-rwait-refresh]');
            if (el && typeof el.focus === 'function') el.focus();
        } catch (_) { /* фокус вернуть некуда */ }
    }

    async function openCard(patientId) {
        if (typeof ctx.onNavigate !== 'function') return;
        const full = await loadPatientById(patientId).catch(() => null);
        if (!full) { toast(tr('Карта пациента не найдена.'), 'fail'); return; }
        ctx.onNavigate('patient-card', full);
    }

    async function reload() {
        const my = ++token;
        state.loading = true;
        try {
            const res = await load({ args: filterArgs(state.filter, state.today) });
            if (my !== token) return state.rows.length;   // пока ждали, фильтр сменили — рисует следующий ответ
            state.rows = res.rows; state.today = res.today || state.today; state.error = '';
            state.from = res.from || null; state.to = res.to || null;
            if (Array.isArray(res.doctors)) state.doctors = res.doctors;
        } catch (e) {
            if (my !== token) return state.rows.length;
            state.error = (e && e.message) || String(e);
        } finally {
            if (my === token) state.loading = false;
        }
        paintFilters();
        repaintKeepingFocus(paintHead, paintList);   // ревью L5
        await report();
        return state.rows.length;
    }

    paintHead(); paintFilters(); paintList();
    await reload();
    return { state, reload, setFilter: async (patch) => { state.filter = { ...state.filter, ...patch }; await apply(); } };
}
