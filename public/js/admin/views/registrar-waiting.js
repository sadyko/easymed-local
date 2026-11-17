// WAIT_REG_V1 (3.25.0, 2026-11-17) — вкладка «Ждут регистрации» раздела «Пациенты».
//
// Владелец: «in the registrator window we should show the patients that were sent and patients
// for which we created a booking so registrators won't be confused; create a forcing function».
// Решение владельца: запись выставляется в счёт ПО ПРИХОДУ — «Оформить по записи» открывает окно
// визита с записанными услугами, окно выставляет счёт ровно на них, пациент идёт в кассу.
//
// Что здесь:
//   • список СЕГОДНЯШНИХ ожидаемых пациентов всей клиники — строка на пациента: время, пациент
//     (имя открывает карту, номер карты, телефон), откуда он (колл-центр / CRM, календарь, сайт /
//     партнёр, направил врач), врач, услуги, кто записал, и «Оформить по записи»;
//   • считает и решает СЕРВЕР (registrar_waiting, rpc/registrar-waiting.js): источники, кто уже
//     зарегистрирован и кто ещё ждёт. Экран только рисует;
//   • openRegisterByBooking — «Оформить по записи» для любого места (эта вкладка, быстрая
//     регистрация): окно визита пациента. Записанные строки, направления врача и анализы «на дату»
//     окно берёт само (visit-wizard.js prefillFromBooking / prefillFromDoctorOrders /
//     prefillFromCrm), и убрать их молча нельзя (booked-drop.js).
import { h, Icon, clear, toast } from '../ui.js';
import { tr, trf } from '../i18n.js';
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

/**
 * Сегодняшние ожидаемые пациенты. Бросает при отказе сервера: пустой ответ — это «никого не ждём»,
 * а отказ — не он. patientId — только этот пациент (быстрая регистрация спрашивает про одного).
 * WAIT_REG_V1 (ревью M6) — countOnly: только число (счётчик вкладки) — сервер не собирает подписи.
 */
export async function loadRegistrarWaiting({ patientId = null, countOnly = false } = {}) {
    const args = patientId != null ? { patient_id: Number(patientId) } : {};
    if (countOnly) args.count_only = true;
    const { data, error } = await supabase.rpc('registrar_waiting', args);
    if (error) throw new Error(error.message || String(error));
    const rows = data && Array.isArray(data.rows) ? data.rows : [];
    const count = countOnly && data && Number.isFinite(Number(data.count)) ? Number(data.count) : rows.length;
    return { today: (data && data.today) || null, count, rows };
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

/**
 * Вкладка «Ждут регистрации». ctx — { onNavigate, onCount(n) }; deps — подмены тестов
 * (load, openWizard).
 */
export async function renderRegistrarWaiting(host, ctx = {}, deps = {}) {
    clear(host);
    const state = { rows: [], today: null, loading: true, error: '', busy: false };
    const load = deps.load || loadRegistrarWaiting;
    const root = h('div', { class: 'rwait', 'data-registrar-waiting': '' });
    host.appendChild(root);
    const head = h('div', { class: 'card rwait-head' });
    const list = h('div', { class: 'card rwait-card' });
    root.appendChild(head);
    root.appendChild(list);

    function report() {
        if (typeof ctx.onCount === 'function') { try { ctx.onCount(state.rows.length); } catch (_) { /* счётчик — не повод ронять вкладку */ } }
    }

    function paintHead() {
        clear(head);
        head.appendChild(h('div', { class: 'rwait-head-text' },
            h('div', { class: 'rwait-title' }, Icon('Bell', { size: 16 }), ' ', tr('Ждут регистрации'),
                h('span', { class: 'rwait-count', 'data-rwait-count': String(state.rows.length) }, String(state.rows.length))),
            h('div', { class: 'rwait-sub' },
                tr('Сегодня: записанные на сегодня и направленные врачом. Пациент уходит из списка, когда его оформили — со счётом или без.'))),
        h('button', { class: 'btn btn-sm btn-outline', type: 'button', 'data-rwait-refresh': '', onclick: () => { void reload(); } },
            Icon('Refresh', { size: 13 }), ' ', tr('Обновить')));
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
                h('div', null, tr('Сегодня никого не ждём: все записанные и направленные пациенты оформлены.'))));
            return;
        }
        list.appendChild(h('div', { class: 'rwait-list', role: 'list' }, ...state.rows.map(rowEl)));
    }

    function rowEl(r) {
        const sources = (r.sources || []).map((s) => {
            const t = sourceText(s);
            return h('span', { class: 'tag ' + (SOURCE_TAG[s.kind] || ''), 'data-rwait-source': s.kind }, Icon(SOURCE_ICON[s.kind] || 'Calendar', { size: 12 }), trf(t.template, t.params));
        });
        const meta = [r.mrn, r.phone].filter(Boolean).join(' · ');
        return h('div', { class: 'rwait-row', role: 'listitem', 'data-rwait-row': String(r.patient_id) },
            h('div', { class: 'rwait-time' }, r.time ? h('b', null, r.time) : h('span', { class: 'muted' }, tr('за день'))),
            h('div', { class: 'rwait-who' },
                h('button', { type: 'button', class: 'link-btn rwait-pt', 'data-rwait-open': String(r.patient_id), title: tr('Открыть карту пациента'),
                    onclick: () => openCard(r.patient_id) }, r.patient_name || '—'),
                meta ? h('div', { class: 'rwait-meta' }, meta) : null,
                h('div', { class: 'rwait-tags' }, ...sources)),
            h('div', { class: 'rwait-what' },
                (r.services || []).length ? h('div', { class: 'rwait-svc' }, Icon('Stethoscope', { size: 12 }), ' ', r.services.join(', ')) : null,
                // WAIT_REG_V1 (ревью, решение владельца) — запись календаря без услуги: услугу выберет регистратор.
                r.no_service ? h('div', { class: 'rwait-svc rwait-nosvc', 'data-rwait-no-service': '' }, Icon('Warning', { size: 12 }), ' ', tr('услуга не выбрана')) : null,
                (r.doctors || []).length ? h('div', { class: 'rwait-sub2' }, trf('Врач: {names}', { names: r.doctors.join(', ') })) : null,
                (r.booked_by || []).length ? h('div', { class: 'rwait-sub2' }, trf('Записал(а): {names}', { names: r.booked_by.join(', ') })) : null),
            h('div', { class: 'rwait-act' },
                // ревью L5 — disabled логическим значением: h() пустую строку считает «нет» и кнопку не гасил.
                h('button', { type: 'button', class: 'btn btn-sm btn-primary', 'data-rwait-register': String(r.patient_id),
                    disabled: !!state.busy, onclick: () => { void register(r); } },
                Icon('Receipt', { size: 13 }), ' ', tr('Оформить по записи'))));
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
    // пациента в списке больше нет — на «Обновить» (фокус остаётся во вкладке).
    function focusedKey() {
        try {
            const a = typeof document !== 'undefined' ? document.activeElement : null;
            if (!a || a === root || typeof root.contains !== 'function' || !root.contains(a) || typeof a.getAttribute !== 'function') return null;
            for (const k of ['data-rwait-register', 'data-rwait-open', 'data-rwait-refresh']) {
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
        state.loading = true;
        try {
            const res = await load();
            state.rows = res.rows; state.today = res.today; state.error = '';
        } catch (e) {
            state.error = (e && e.message) || String(e);
        } finally {
            state.loading = false;
        }
        repaintKeepingFocus(paintHead, paintList);   // ревью L5
        report();
        return state.rows.length;
    }

    paintHead(); paintList();
    await reload();
    return { state, reload };
}
