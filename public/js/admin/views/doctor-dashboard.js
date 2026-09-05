// DOCTOR_DASHBOARD_V1 (2026-09-05) — КАБИНЕТ ВРАЧА ОТКРЫВАЕТСЯ ДАШБОРДОМ.
//
// Владелец: «in the doctors cabinet make dashboard first». На эскизе: слева
// крупно — обращение к врачу, приёмы за день, заработок за день, выполненные
// услуги и статистика; справа высокой колонкой — календарь с пациентами;
// посередине четыре маленькие плитки; снизу слева широкий график.
//
// ЧТО ЭТО НЕ ТАКОЕ. Это НЕ вернувшийся приветственный баннер. Полосы «Доброе
// утро» вместе с живыми часами и абзацем-пожеланием сняты со всех экранов
// (NO_GREETING_V1), и возвращать их сюда нельзя. Обращение здесь — это
// ЛИЧНОСТЬ и ДАТА: чей это кабинет и какой сегодня день; ни времени суток, ни
// секундной стрелки, ни текста, который не отвечает ни на один вопрос.
//
// ═══ ОТКУДА КАЖДОЕ ЧИСЛО, И ПОЧЕМУ ИМЕННО ОТТУДА ══════════════════════════
//
// Правило одно: НЕ ВЫДУМЫВАТЬ ПОКАЗАТЕЛЬ, КОТОРЫЙ НЕЧЕМ ПОСЧИТАТЬ. Правдоподобный
// ноль хуже отсутствующей плитки: ноль читают как факт.
//
//   «Приёмов сегодня»      visits: doctor_id = я, visit_date внутри местных
//                          суток. Это записи, а не услуги: пациент приходит на
//                          приём, а услуг в нём может быть три.
//   «Заработано сегодня»   ДОЛЯ ВРАЧА по завершённым услугам сегодняшних
//                          приёмов. Арифметика — та же и в том же порядке, что
//                          в отчёте «Зарплата врачей» (rpc/reports.js,
//                          ITEM_FEE_SQL): база = сумма строки − доля скидки
//                          счёта; налог = база × ставка услуги; доля =
//                          (база − налог) × процент врача; фикс — за единицу и
//                          налогом не режется. Второй реализации нет: обе
//                          стороны кабинета зовут serviceShare() ИЗ ЭТОГО
//                          ФАЙЛА (consultation.js импортирует его отсюда).
//   «Услуг завершено»      visit_services сегодняшних приёмов со статусом
//                          completed, и рядом — сколько их всего за день.
//   «Пациентов сегодня»    разные patient_id среди сегодняшних приёмов.
//   «Пришли, ждут»         visits.status = 'arrived' и приём ещё не закрыт.
//   «за 7 дней» + стрелка  те же две величины за последние 7 дней против
//                          предыдущих 7. Окно берётся одним запросом на 14
//                          дней, поэтому сравнение считается из одних данных.
//   график                 14 дней, по ДНЮ ПРИЁМА (отметки времени «услуга
//                          завершена» в базе нет — см. ниже).
//   «Частые услуги»        топ услуг за те же 14 дней.
//
// ОДНА ОГОВОРКА, КОТОРУЮ НАДО ЗНАТЬ: у visit_services НЕТ колонки «когда
// завершена» — есть created_at, scheduled_at и статус. Поэтому «завершено
// сегодня» означает «завершённая услуга СЕГОДНЯШНЕГО приёма», а не «статус
// переключили сегодня». Так же считает и плитка в очереди кабинета
// (consultation.js kpiSummary) — два разных ответа на один вопрос на одном
// экране были бы хуже, чем один честно названный.
//
// ЧЕГО ЗДЕСЬ НЕТ И ПОЧЕМУ (эскиз-образец это показывал):
//
//   • РАЗБИВКА ПО ДИАГНОЗАМ. У амбулаторного приёма нет поля диагноза:
//     visits.conclusion — свободный текст, visit_services.notes — JSON
//     документа приёма. Считать по ним частоту диагнозов значит считать
//     совпадения подстрок и назвать это статистикой. Вместо неё — «Частые
//     услуги»: тот же вопрос «чем этот врач занят», но по данным, которые
//     действительно есть.
//   • «НОВЫЕ ПАЦИЕНТЫ» ЗА НЕДЕЛЮ. visits.visit_kind по умолчанию 'first' и
//     ставится в 'repeat' только вручную (visit-modal) или из рабочей области;
//     calendar_book пишет 'first' ВСЕГДА. График «первичных» показал бы почти
//     все приёмы первичными — это не метрика, а значение по умолчанию.
//   • ПЕРЕКЛЮЧАТЕЛЬ ПЕРИОДА У КАЖДОЙ ПЛИТКИ. Окно данных здесь 14 дней;
//     «месяц» и «год» пришлось бы либо тянуть отдельно, либо соврать.
//     Глубокие периоды уже есть на вкладке «Зарплата» — там они и остаются.
//
// ═══ ДЕНЬГИ ═══════════════════════════════════════════════════════════════
//
// Врач видит СВОЙ заработок. Идентичность берётся РОВНО В ОДНОМ МЕСТЕ —
// dashboardDoctorId(), — и это учётная запись, вошедшая в систему
// (selfDoctorId()). Ни один загрузчик в этом файле не принимает doctor_id
// аргументом: подменить его нечем, потому что параметра нет. Проверено тестом
// (doctor-dashboard.test.mjs): каждый запрос уходит с фильтром на свой id, и
// смена пользователя меняет фильтр.
//
// Честная оговорка, которую нельзя прятать: /api/db отдаёт users всему
// персоналу (schema-registry.js, ALL_STAFF), поэтому таблица ставок читается
// шире, чем этот экран. Закрыть это можно только серверным RPC, который берёт
// врача из сессии; он выходит за границы этой правки и назван в отчёте.
//
// ═══ ОКЛАД ════════════════════════════════════════════════════════════════
//
// У врача на ФИКСИРОВАННОМ ОКЛАДЕ дневного заработка не существует: оклад не
// делится на приёмы. Такой врач видит на месте суммы прочерк и подпись
// «фиксированный оклад», а не аккуратный ноль. То же — у «фикс + KPI», если ни
// один сервисный KPI не отмечен: переменной части нет, и рисовать её нельзя.

import { supabase } from '../../supabase.js';
import { h, Icon, clear, initials, fmtDate } from '../ui.js';
import { tr, trf } from '../i18n.js';   // I18N_COVERAGE_V1 — перевод СНАЧАЛА, подстановка ПОТОМ
import { selfDoctorId } from '../permissions.js';   // ADMIN_DOCTOR_V2
import { pastelFor } from '../pastel.js';   // PASTEL_IDENTITY_V1 — оттенок = личность, не тяжесть

export const DOCTOR_DASH_BUILD = 'DOCTOR_DASHBOARD_V1';

/** Окно данных: 14 дней = неделя и предыдущая неделя одним запросом. */
export const DASH_WINDOW_DAYS = 14;

// ---------------------------------------------------------------------------
// ИДЕНТИЧНОСТЬ. Единственный источник «чей это кабинет». Аргументов нет и не
// будет: параметр здесь и означал бы «покажи чужие деньги».
// ---------------------------------------------------------------------------
export function dashboardDoctorId() {
    return selfDoctorId();
}

// ---------------------------------------------------------------------------
// Дни и время
// ---------------------------------------------------------------------------
export function startOfDay(ref) {
    const d = new Date(ref);
    d.setHours(0, 0, 0, 0);
    return d;
}
/** Местный день строки/даты как 'YYYY-MM-DD' (UTC-сдвиг здесь всё ломает). */
export function localDayKey(value) {
    if (value == null || value === '') return '';
    const d = new Date(value);
    if (isNaN(d.getTime())) return '';
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')
        + '-' + String(d.getDate()).padStart(2, '0');
}
export function hhmm(value) {
    const d = new Date(value);
    if (isNaN(d.getTime())) return '';
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}
/** Полных лет на дату ref; null, если даты рождения нет. */
export function ageYears(dob, ref) {
    if (!dob) return null;
    const b = new Date(dob);
    if (isNaN(b.getTime())) return null;
    const r = new Date(ref);
    let age = r.getFullYear() - b.getFullYear();
    const m = r.getMonth() - b.getMonth();
    if (m < 0 || (m === 0 && r.getDate() < b.getDate())) age--;
    return age >= 0 && age < 150 ? age : null;
}

// ---------------------------------------------------------------------------
// ДЕНЬГИ — ОДНА реализация на весь кабинет.
// ---------------------------------------------------------------------------

/**
 * service_id → правило оплаты врача из его карточки (users.service_rates,
 * раздел «Услуги и ставки»). Терпит все три формы, которые исторически писали
 * разные экраны: {percentage}, {pct} (быстрое назначение в «Сотрудниках») и
 * {mode,value}. RATES_PCT_ALIAS_V1 — из-за расхождения ключей ставка читалась
 * как 0%, и заработок с услуг просто не показывался.
 */
export function serviceRateMap(doctorRow) {
    const m = new Map();
    const rates = Array.isArray(doctorRow && doctorRow.service_rates) ? doctorRow.service_rates : [];
    for (const r of rates) if (r && r.service_id != null) {
        let price = Number(r.price) || 0;
        let percentage = Number(r.percentage != null ? r.percentage : r.pct) || 0;
        if (!price && r.mode === 'fixed' && r.value != null) price = Number(r.value) || 0;
        if (!percentage && r.mode !== 'fixed' && r.value != null) percentage = Number(r.value) || 0;
        m.set(String(r.service_id), { price, percentage });
    }
    return m;
}

/**
 * Доля врача с ОДНОЙ услуги. DOCTOR_SHARE_AFTER_TAX_V1 — порядок в точности
 * как в отчётах (rpc/reports.js ITEM_FEE_SQL):
 *   база = сумма строки − доля скидки счёта
 *   налог = база × ставка налога услуги
 *   доля = фикс_за_единицу + (база − налог) × процент врача
 * Ставки налога нет — считаем 0 и не выдумываем налог, которого нет в данных.
 */
export function serviceShare(s, rateMap) {
    const rate = rateMap.get(String(s.serviceId));
    if (!rate) return 0;
    const base = Math.max(0, Number(s.total || 0) - Number(s.discount || 0));
    const taxRate = s.taxRate != null ? Number(s.taxRate) : 0;
    const net = base * (1 - taxRate / 100);
    return (rate.price || 0) + net * (rate.percentage || 0) / 100;
}

/**
 * Платят ли этому врачу ПОУСЛУЖНО. DOCTOR_PAY_KPI_WIRE_V1 — у «фикс + KPI»
 * переменная часть начисляется, только если отмечен хоть один сервисный KPI;
 * один лишь «направления пациентов» переменной с услуг не даёт (вознаграждение
 * за направления — отдельная строка на вкладке «Зарплата»).
 */
export function perServicePayApplies(doctorRow) {
    if (!doctorRow) return false;
    const kind = doctorRow.salary_type || '';
    if (kind === 'fixed') return false;
    if (kind !== 'fix_plus_kpi') return true;
    const kpis = new Set(Array.isArray(doctorRow.kpi_links) ? doctorRow.kpi_links : []);
    return ['consultations', 'services', 'revenue', 'lab_tests', 'surgeries'].some((k) => kpis.has(k));
}

/**
 * Доля скидки СЧЁТА, приходящаяся на строку. Скидка живёт на счёте, а не на
 * услуге; разносится пропорционально сумме строки — ровно как ITEM_DISCOUNT_SQL.
 * Возвращает Map(invoice_item_id → сумма скидки).
 */
export function prorateInvoiceDiscounts(items, invoices) {
    const invById = new Map((invoices || []).map((i) => [i.id, i]));
    const out = new Map();
    for (const it of (items || [])) {
        const inv = invById.get(it.invoice_id);
        const sub = Number(inv && inv.subtotal) || 0;
        const disc = Number(inv && inv.discount_amount) || 0;
        out.set(it.id, sub > 0 ? disc * (Number(it.total) || 0) / sub : 0);
    }
    return out;
}

// ---------------------------------------------------------------------------
// СЧЁТ ПОКАЗАТЕЛЕЙ — чистая функция, отдельно от загрузки и от рисования.
// ---------------------------------------------------------------------------

/**
 * @param visits   [{ id, at, status, patientId, … }] приёмы врача за окно
 * @param services [{ visitId, status, serviceId, serviceName, total, discount,
 *                    taxRate, invoiceStatus }] услуги этих приёмов
 * @param rateMap  Map из serviceRateMap()
 * @param now      «сейчас» (тест подаёт своё)
 * @param perService платят ли поуслужно (perServicePayApplies)
 */
export function computeDoctorStats({ visits, services, rateMap, now, perService = true }) {
    const today = localDayKey(now);
    const dayOf = new Map((visits || []).map((v) => [String(v.id), localDayKey(v.at)]));
    const share = (s) => (perService ? serviceShare(s, rateMap) : 0);

    const todayVisits = (visits || []).filter((v) => localDayKey(v.at) === today);
    const todaySvc = (services || []).filter((s) => dayOf.get(String(s.visitId)) === today);
    const todayDone = todaySvc.filter((s) => s.status === 'completed');

    // Ряд по дням: DASH_WINDOW_DAYS корзин, старая слева. Пустой день — 0, и
    // это не выдумка: приёма в этот день у врача действительно не было.
    const series = [];
    const idx = new Map();
    for (let i = DASH_WINDOW_DAYS - 1; i >= 0; i--) {
        const d = startOfDay(now);
        d.setDate(d.getDate() - i);
        const key = localDayKey(d);
        idx.set(key, series.length);
        series.push({
            day: key,
            label: String(d.getDate()).padStart(2, '0') + '.' + String(d.getMonth() + 1).padStart(2, '0'),
            services: 0, earned: 0, isToday: key === today,
        });
    }
    const byService = new Map();
    for (const s of (services || [])) {
        if (s.status !== 'completed') continue;
        const i = idx.get(dayOf.get(String(s.visitId)));
        if (i == null) continue;
        series[i].services += 1;
        series[i].earned += share(s);
        const name = s.serviceName || tr('Услуга без названия');
        byService.set(name, (byService.get(name) || 0) + 1);
    }

    const sum = (from, to, field) => series.slice(from, to).reduce((n, d) => n + d[field], 0);
    const week = { services: sum(7, 14, 'services'), earned: sum(7, 14, 'earned') };
    const prev = { services: sum(0, 7, 'services'), earned: sum(0, 7, 'earned') };

    const totalTop = [...byService.values()].reduce((n, v) => n + v, 0);
    const topServices = [...byService.entries()]
        .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
        .slice(0, 5)
        .map(([name, count]) => ({ name, count, share: totalTop ? Math.round(count * 100 / totalTop) : 0 }));

    // «Пришёл и ещё ждёт»: статус приёма 'arrived', и хотя бы одна его услуга
    // не завершена (или услуг ещё нет вовсе). Приём, все услуги которого
    // закрыты, из очереди ожидания выходит, даже если статус визита не трогали
    // — визит перестаёт быть «ждёт» в тот момент, когда врач его закончил.
    const svcOfVisit = (id) => todaySvc.filter((s) => String(s.visitId) === String(id));
    const stillWaiting = (v) => {
        const own = svcOfVisit(v.id);
        return own.length === 0 || own.some((s) => s.status !== 'completed');
    };

    return {
        todayVisits: todayVisits.length,
        todayPatients: new Set(todayVisits.map((v) => String(v.patientId))
            .filter((x) => x && x !== 'null' && x !== 'undefined')).size,
        todayArrived: todayVisits.filter((v) => v.status === 'arrived' && stillWaiting(v)).length,
        todayServices: todaySvc.length,
        todayCompleted: todayDone.length,
        todayEarned: Math.round(todayDone.reduce((n, s) => n + share(s), 0)),
        todayPaid: Math.round(todayDone.filter((s) => s.invoiceStatus === 'paid')
            .reduce((n, s) => n + share(s), 0)),
        week: { services: week.services, earned: Math.round(week.earned) },
        prevWeek: { services: prev.services, earned: Math.round(prev.earned) },
        deltaServices: week.services - prev.services,
        deltaEarnedPct: prev.earned > 0 ? Math.round((week.earned - prev.earned) * 100 / prev.earned) : null,
        series: series.map((d) => ({ ...d, earned: Math.round(d.earned) })),
        topServices,
    };
}

/** Статусы приёма, которые закрывают его БЕЗ осмотра. */
const DEAD_VISIT = new Set(['cancelled', 'no_show']);

/**
 * Колонка «Мой день»: сегодняшние приёмы врача во ВРЕМЕННОМ порядке, с тем, что
 * нужно, чтобы войти в кабинет — имя, возраст, услуга, время и пришёл ли.
 * `nowAt` — сколько карточек уже в прошлом (после них рисуется черта «сейчас»).
 */
export function buildDayColumn({ visits, services, now }) {
    const today = localDayKey(now);
    const svcByVisit = new Map();
    for (const s of (services || [])) {
        const k = String(s.visitId);
        if (!svcByVisit.has(k)) svcByVisit.set(k, []);
        svcByVisit.get(k).push(s);
    }
    const rows = (visits || [])
        .filter((v) => localDayKey(v.at) === today)
        .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())
        .map((v) => {
            const svc = svcByVisit.get(String(v.id)) || [];
            const done = svc.length > 0 && svc.every((s) => s.status === 'completed');
            return {
                id: v.id,
                at: v.at,
                time: hhmm(v.at),
                patientId: v.patientId,
                patientName: v.patientName,
                mrn: v.mrn,
                age: ageYears(v.dob, now),
                serviceName: v.serviceName || (svc[0] && svc[0].serviceName) || '',
                room: v.room || '',
                status: v.status,
                arrived: v.status === 'arrived',
                done,
                past: new Date(v.at).getTime() < new Date(now).getTime(),
            };
        });
    let nowAt = rows.findIndex((r) => !r.past);
    if (nowAt < 0) nowAt = rows.length;
    return { rows, nowAt };
}

/** Подпись состояния приёма. Осмотр важнее записи: он её отменяет. */
export function dayStateLabel(row) {
    if (row.done) return tr('Приём завершён');
    if (row.status === 'cancelled') return tr('Отменён');
    if (row.status === 'no_show') return tr('Не пришёл');
    if (row.status === 'arrived') return tr('Пришёл, ждёт');
    if (row.status === 'confirmed') return tr('Подтверждён');
    return tr('Записан');
}
function dayStateTone(row) {
    if (row.done) return 'ok';
    if (DEAD_VISIT.has(row.status)) return 'dead';
    if (row.status === 'arrived') return 'now';
    return 'plan';
}

// ---------------------------------------------------------------------------
// СОСТОЯНИЕ + ЗАГРУЗКА
// ---------------------------------------------------------------------------
const state = {
    loading: false,
    loaded: false,
    failed: false,
    doctor: null,
    visits: [],
    services: [],
    metric: 'services',   // что рисует график: 'services' | 'earned'
    now: null,
};
let hostRef = null;
let openWorkRef = null;

const money = (n) => Math.round(Number(n) || 0).toLocaleString('ru-RU');

/**
 * Всё, что нужно экрану, четырьмя запросами. КАЖДЫЙ сужен на СВОЙ id, и id
 * берётся из dashboardDoctorId(), а не из аргумента.
 */
export async function loadDoctorDashboard() {
    const me = dashboardDoctorId();
    state.failed = false;
    state.now = new Date();
    if (!me) { state.doctor = null; state.visits = []; state.services = []; state.loaded = true; return; }

    const from = startOfDay(state.now); from.setDate(from.getDate() - (DASH_WINDOW_DAYS - 1));
    const to = startOfDay(state.now); to.setDate(to.getDate() + 1);

    // 1. Своя карточка — ставки и вид оплаты. Строго .eq('id', me).
    const { data: docRows, error: docErr } = await supabase.from('users')
        .select('id, full_name, specialty, is_doctor, salary_type, salary_fixed, salary_percent, service_rates, kpi_links, room_id, rooms(id, name)')
        .eq('id', me).limit(1);
    if (docErr) console.warn('[doctor-dash] doctor:', docErr.message);
    state.doctor = (docRows && docRows[0]) || null;

    // 2. Приёмы за окно. BRANCH_ORIGIN_V1 — кабинет врача показывает работу
    // СВОЕГО здания (решение владельца 2026-09-02, то же условие, что у
    // очереди в consultation.js): приехавшая запись живёт в кабинете своего
    // здания, а здесь была бы работой, которую этот врач не делал.
    const { data: visitRows, error: vErr } = await supabase.from('visits')
        .select('id, visit_date, duration_minutes, status, patient_id, service_id, room_id, patients(id, mrn, full_name, first_name, last_name, phone, date_of_birth), services(id, name, duration_minutes), rooms(id, name, code)')
        .eq('doctor_id', me)
        .is('sync_origin', null)
        .gte('visit_date', from.toISOString())
        .lt('visit_date', to.toISOString())
        .order('visit_date', { ascending: true })
        .limit(800);
    if (vErr) { console.warn('[doctor-dash] visits:', vErr.message); state.failed = true; }
    state.visits = (visitRows || []).map((v) => {
        const p = v.patients || {};
        return {
            id: v.id,
            at: v.visit_date,
            status: v.status || 'scheduled',
            patientId: v.patient_id,
            patientName: [p.last_name, p.first_name].filter(Boolean).join(' ').trim() || p.full_name || '',
            mrn: p.mrn || '',
            dob: p.date_of_birth || null,
            serviceName: (v.services && v.services.name) || '',
            room: (v.rooms && (v.rooms.name || v.rooms.code)) || '',
        };
    });

    // 3. Услуги ЭТИХ приёмов. Фильтр по visit_id, а не по created_at: услугу
    // могли завести за неделю до приёма, и окно по дате создания её потеряло бы.
    const visitIds = state.visits.map((v) => v.id).filter((x) => x != null);
    let svcRows = [];
    if (visitIds.length) {
        const { data, error } = await supabase.from('visit_services')
            .select('id, visit_id, service_id, status, quantity, unit_price, total, invoice_item_id, services(id, name, tax_rate)')
            .eq('doctor_id', me)
            .in('visit_id', visitIds)
            .limit(2000);
        if (error) { console.warn('[doctor-dash] services:', error.message); state.failed = true; }
        svcRows = data || [];
    }

    // 4. Скидка счёта и оплачен ли он. Обе величины нужны деньгам: скидка
    // входит в базу доли врача, статус счёта отвечает на «сколько из этого уже
    // в кассе».
    const itemIds = [...new Set(svcRows.map((r) => r.invoice_item_id).filter(Boolean))];
    let discByItem = new Map();
    const statusByItem = new Map();
    if (itemIds.length) {
        try {
            const { data: items } = await supabase.from('invoice_items')
                .select('id, total, invoice_id').in('id', itemIds).limit(2000);
            const invIds = [...new Set((items || []).map((i) => i.invoice_id).filter(Boolean))];
            const { data: invs } = invIds.length
                ? await supabase.from('invoices').select('id, subtotal, discount_amount, status').in('id', invIds).limit(2000)
                : { data: [] };
            discByItem = prorateInvoiceDiscounts(items, invs);
            const invById = new Map((invs || []).map((i) => [i.id, i]));
            for (const it of (items || [])) {
                const inv = invById.get(it.invoice_id);
                statusByItem.set(it.id, (inv && inv.status) || null);
            }
        } catch (e) { console.warn('[doctor-dash] invoices:', e && e.message); }
    }

    state.services = svcRows.map((r) => ({
        id: r.id,
        visitId: r.visit_id,
        serviceId: r.service_id,
        serviceName: (r.services && r.services.name) || '',
        status: r.status || '',
        total: Number(r.total || (r.unit_price || 0) * (r.quantity || 1)),
        taxRate: r.services && r.services.tax_rate != null ? Number(r.services.tax_rate) : 0,
        discount: r.invoice_item_id ? (discByItem.get(r.invoice_item_id) || 0) : 0,
        invoiceStatus: r.invoice_item_id ? (statusByItem.get(r.invoice_item_id) || null) : null,
    }));
    state.loaded = true;
}

// ---------------------------------------------------------------------------
// СТИЛИ. Своего файла CSS у вида нет, поэтому правила едут с ним — так же, как
// их возят service-workspace.js, procedures.js и employee-editor.js. Ни одного
// НОВОГО цвета: грунт, рамка окна и тень берутся из admin.css
// (--page-ground / --window-line / --shadow-window через .card), оттенок
// карточки пациента — из pastel.js. Размеры шрифта — только ступени шкалы.
// ---------------------------------------------------------------------------
const DASH_CSS = `
.dd-grid { display: grid; gap: 14px; align-items: start;
    grid-template-columns: minmax(0, 1fr) 344px;
    grid-template-areas: "hero day" "stats day" "chart day"; }
.dd-hero  { grid-area: hero;  padding: 20px 22px; }
.dd-stats { grid-area: stats; display: grid; gap: 12px; grid-template-columns: repeat(4, minmax(0, 1fr)); }
.dd-chart { grid-area: chart; padding: 16px 18px; }
.dd-day   { grid-area: day; display: flex; flex-direction: column; overflow: hidden; max-height: 78vh; }
@media (max-width: 1180px) {
  .dd-grid { grid-template-columns: minmax(0, 1fr); grid-template-areas: "hero" "stats" "day" "chart"; }
  .dd-day { max-height: none; }
}
@media (max-width: 860px) { .dd-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); } }

.dd-id { display: flex; align-items: center; gap: 14px; }
.dd-id-av { width: 52px; height: 52px; border-radius: 50%; display: grid; place-items: center;
    font-weight: 700; font-size: 17px; flex: none;
    background: var(--p-bg, var(--primary-50)); color: var(--p-fg, var(--primary-700)); }
.dd-id-name { font-size: 20px; font-weight: 700; color: var(--ink-900); line-height: 1.2; }
.dd-id-sub  { font-size: 13.5px; color: var(--ink-500); margin-top: 2px; }
.dd-id-date { font-size: 13.5px; color: var(--ink-600); font-weight: 600; text-align: right; }

.dd-figs { display: grid; gap: 12px; grid-template-columns: repeat(3, minmax(0, 1fr)); margin-top: 18px; }
@media (max-width: 700px) { .dd-figs { grid-template-columns: minmax(0, 1fr); } }
.dd-fig { border: 1px solid var(--ink-100); border-radius: 14px; padding: 14px 16px; background: var(--ink-25); }
.dd-fig-v { font-size: 30px; font-weight: 700; color: var(--ink-900); line-height: 1.15; letter-spacing: -0.02em; }
.dd-fig-v.is-none { font-size: 24px; color: var(--ink-400); }
.dd-fig-l { font-size: 12.5px; color: var(--ink-500); margin-top: 4px; }
.dd-fig-s { font-size: 12.5px; color: var(--ink-600); margin-top: 4px; }

.dd-progress { margin-top: 16px; }
.dd-progress-t { font-size: 12.5px; color: var(--ink-600); margin-bottom: 6px; }
.dd-track { height: 8px; border-radius: 999px; background: var(--ink-100); overflow: hidden; }
.dd-track i { display: block; height: 100%; border-radius: 999px; background: var(--primary-500); }

.dd-stat { padding: 14px 16px; }
.dd-stat-l { font-size: 12.5px; color: var(--ink-500); }
.dd-stat-v { font-size: 24px; font-weight: 700; color: var(--ink-900); line-height: 1.2; margin-top: 4px;
    display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }

.dd-plot { display: flex; align-items: flex-end; gap: 6px; height: 156px; margin-top: 14px; }
.dd-col { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; justify-content: flex-end;
    align-items: center; gap: 6px; height: 100%; }
.dd-bar { width: 100%; min-height: 3px; border-radius: 6px 6px 2px 2px; background: var(--primary-300); }
.dd-col.is-today .dd-bar { background: var(--primary-600); }
.dd-col-l { font-size: 12.5px; color: var(--ink-400); white-space: nowrap; }
.dd-col.is-today .dd-col-l { color: var(--ink-700); font-weight: 600; }

.dd-top { margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--ink-100);
    display: flex; flex-direction: column; gap: 10px; }
.dd-top-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 6px 10px; align-items: center; }
.dd-top-n { font-size: 13.5px; color: var(--ink-800); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dd-top-c { font-size: 12.5px; color: var(--ink-500); font-variant-numeric: tabular-nums; }
.dd-top-bar { grid-column: 1 / -1; height: 6px; border-radius: 999px; background: var(--ink-100); overflow: hidden; }
.dd-top-bar i { display: block; height: 100%; border-radius: 999px; background: var(--primary-400); }

.dd-day-list { overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 8px; }
.dd-appt { display: flex; gap: 12px; align-items: center; width: 100%; text-align: left;
    padding: 10px 12px; border: 1px solid var(--ink-100); border-radius: 12px;
    background: var(--white); font-family: inherit; cursor: pointer; }
.dd-appt:hover { border-color: var(--primary-300); }
.dd-appt:focus-visible { outline: 2px solid var(--primary-600); outline-offset: 2px; }
.dd-appt.is-past { opacity: 0.7; }
.dd-appt.is-dead .dd-appt-n { text-decoration: line-through; }
.dd-appt-t { font-size: 13.5px; font-weight: 700; color: var(--ink-900); width: 42px; flex: none;
    font-variant-numeric: tabular-nums; }
.dd-appt-av { width: 34px; height: 34px; border-radius: 50%; display: grid; place-items: center;
    font-weight: 700; font-size: 12.5px; flex: none;
    background: var(--p-bg, var(--ink-50)); color: var(--p-fg, var(--ink-700)); }
.dd-appt-b { min-width: 0; flex: 1; display: block; }
.dd-appt-n { font-size: 13.5px; font-weight: 600; color: var(--ink-900); display: block;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dd-appt-m { font-size: 12.5px; color: var(--ink-500); margin-top: 2px; display: block;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dd-chip { font-size: 12.5px; font-weight: 600; border-radius: 999px; padding: 2px 9px; flex: none; }
.dd-chip.plan { background: var(--ink-50);   color: var(--ink-600); }
.dd-chip.now  { background: var(--info-50);  color: var(--info-700); }
.dd-chip.ok   { background: var(--ok-50);    color: var(--ok-700); }
.dd-chip.dead { background: var(--crit-50);  color: var(--crit-700); }
.dd-nowline { display: flex; align-items: center; gap: 8px; padding: 2px;
    font-size: 12.5px; font-weight: 600; color: var(--crit-700); }
.dd-nowline i { display: block; flex: 1; height: 1px; background: var(--crit-500); }
`;

function ensureCss() {
    if (typeof document === 'undefined' || !document.createElement) return;
    if (document.getElementById && document.getElementById('dd-style')) return;
    const el = document.createElement('style');
    el.id = 'dd-style';
    el.textContent = DASH_CSS;
    if (document.head && document.head.appendChild) document.head.appendChild(el);
}

// ---------------------------------------------------------------------------
// РИСОВАНИЕ
// ---------------------------------------------------------------------------

/**
 * @param host       куда рисовать
 * @param onOpenWork колбэк «открыть рабочий список» (вкладка «Мои приёмы»)
 */
export async function renderDoctorDashboard(host, { onOpenWork } = {}) {
    hostRef = host;
    openWorkRef = typeof onOpenWork === 'function' ? onOpenWork : null;
    ensureCss();
    if (!state.loaded) {
        state.loading = true;
        paint();
        await loadDoctorDashboard();
        state.loading = false;
    }
    paint();
}

/** Перечитать данные по кнопке. Идентичность берётся заново — своя. */
export async function refreshDoctorDashboard() {
    state.loading = true;
    await loadDoctorDashboard();
    state.loading = false;
    paint();
}

export function resetDoctorDashboard() {
    state.loaded = false; state.loading = false; state.failed = false;
    state.doctor = null; state.visits = []; state.services = [];
    state.metric = 'services'; state.now = null;
    hostRef = null; openWorkRef = null;
}

function paint() {
    if (!hostRef) return;
    clear(hostRef);
    if (state.loading && !state.loaded) {
        hostRef.appendChild(h('div', { class: 'card empty' }, tr('Загружаем ваш день…')));
        return;
    }
    if (!dashboardDoctorId()) {
        hostRef.appendChild(h('div', { class: 'card', style: { padding: '22px' } },
            h('div', { style: { fontSize: '15px', fontWeight: '600', color: 'var(--ink-900)' } },
                tr('Дашборд открывается по учётной записи врача')),
            h('div', { class: 'muted', style: { fontSize: '13.5px', marginTop: '6px' } },
                tr('У этой учётной записи нет карточки врача, поэтому личных приёмов и заработка у неё нет. Рабочий список кабинета открывается как обычно.')),
        ));
        return;
    }

    const now = state.now || new Date();
    const doc = state.doctor;
    const perService = perServicePayApplies(doc);
    const rateMap = serviceRateMap(doc);
    const stats = computeDoctorStats({ visits: state.visits, services: state.services, rateMap, now, perService });
    const day = buildDayColumn({ visits: state.visits, services: state.services, now });

    hostRef.appendChild(h('div', { class: 'dd-grid' },
        heroCard(doc, stats, now, perService),
        statsRow(stats),
        chartCard(stats),
        dayCard(day, now),
    ));
    if (state.failed) {
        // Сбой запроса и пустой день выглядят одинаково — серым нулём. Разница
        // между «отдел пуст» и «экран сломан» обязана быть на экране словами.
        hostRef.appendChild(h('div', { class: 'card', style: { padding: '14px 18px', marginTop: '14px' } },
            h('div', { style: { fontSize: '13.5px', fontWeight: '600', color: 'var(--crit-700)' } },
                tr('Часть данных не загрузилась')),
            h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '4px' } },
                tr('Это сбой запроса, а не пустой день: цифры могут быть неполными. Нажмите «Обновить».')),
        ));
    }
}

// ---- Обращение к врачу + три главных числа дня -----------------------------
function heroCard(doc, stats, now, perService) {
    const name = (doc && doc.full_name) || tr('Врач');
    const room = doc && doc.rooms && doc.rooms.name;
    const sub = [doc && doc.specialty, room ? trf('кабинет {room}', { room }) : null].filter(Boolean).join(' · ');

    const earnFig = perService
        ? h('div', { class: 'dd-fig-v' }, money(stats.todayEarned))
        : h('div', { class: 'dd-fig-v is-none' }, '—');
    const earnSub = perService
        ? trf('оплачено: {sum}', { sum: money(stats.todayPaid) })
        : tr('фиксированный оклад — по дням не делится');

    return h('section', { class: 'card dd-hero' },
        h('div', { class: 'dd-id' },
            h('span', { class: 'dd-id-av ' + pastelFor(doc && doc.id) }, initials(name)),
            h('div', { style: { flex: '1', minWidth: '0' } },
                h('div', { class: 'dd-id-name' }, name),
                sub ? h('div', { class: 'dd-id-sub' }, sub) : null,
            ),
            h('div', { class: 'dd-id-date' }, fmtDate(now)),
            h('button', {
                class: 'btn btn-outline btn-sm', type: 'button',
                style: { marginLeft: '10px' },
                onclick: () => { refreshDoctorDashboard(); },
            }, Icon('Refresh', { size: 13 }), ' ', tr('Обновить')),
        ),
        h('div', { class: 'dd-figs' },
            h('div', { class: 'dd-fig' },
                h('div', { class: 'dd-fig-v' }, String(stats.todayVisits)),
                h('div', { class: 'dd-fig-l' }, tr('Приёмов сегодня')),
                h('div', { class: 'dd-fig-s' }, trf('пациентов: {n}', { n: stats.todayPatients })),
            ),
            h('div', { class: 'dd-fig' },
                earnFig,
                h('div', { class: 'dd-fig-l' }, tr('Заработано сегодня')),
                h('div', { class: 'dd-fig-s' }, earnSub),
            ),
            h('div', { class: 'dd-fig' },
                h('div', { class: 'dd-fig-v' }, String(stats.todayCompleted)),
                h('div', { class: 'dd-fig-l' }, tr('Услуг завершено')),
                h('div', { class: 'dd-fig-s' }, trf('всего за день: {n}', { n: stats.todayServices })),
            ),
        ),
        h('div', { class: 'dd-progress' },
            h('div', { class: 'dd-progress-t' },
                trf('Завершено {done} из {all} сегодняшних услуг', { done: stats.todayCompleted, all: stats.todayServices })),
            h('div', { class: 'dd-track' },
                h('i', { style: { width: (stats.todayServices
                    ? Math.round(stats.todayCompleted * 100 / stats.todayServices) : 0) + '%' } })),
        ),
    );
}

// ---- Четыре маленькие плитки ----------------------------------------------
function statsRow(stats) {
    return h('div', { class: 'dd-stats' },
        statCard(tr('Пациентов сегодня'), String(stats.todayPatients)),
        statCard(tr('Пришли, ждут приёма'), String(stats.todayArrived)),
        statCard(tr('Услуг за 7 дней'), String(stats.week.services), deltaNode(stats.deltaServices, '')),
        statCard(tr('Заработано за 7 дней'), money(stats.week.earned),
            stats.deltaEarnedPct == null ? null : deltaNode(stats.deltaEarnedPct, '%')),
    );
}
function statCard(label, value, extra) {
    return h('div', { class: 'card dd-stat' },
        h('div', { class: 'dd-stat-l' }, label),
        h('div', { class: 'dd-stat-v' }, value, extra || null),
    );
}
// Стрелка изменения. Знак СЧИТАЕТСЯ, а не подставляется словом: «↑ 5» и «↓ 2%»
// собираются из числа и суффикса, поэтому переводить в самой стрелке нечего —
// переводится подсказка, и она держит значение в {дырке}.
function deltaNode(value, suffix) {
    const n = Number(value) || 0;
    const sign = n > 0 ? 'up' : n < 0 ? 'down' : 'flat';
    const arrow = n > 0 ? '↑' : n < 0 ? '↓' : '—';
    return h('span', {
        class: 'delta ' + sign,
        title: trf('против предыдущих 7 дней: {v}', { v: (n > 0 ? '+' : '') + n + suffix }),
    }, arrow + ' ' + Math.abs(n) + suffix);
}

// ---- График за 14 дней -----------------------------------------------------
function chartCard(stats) {
    const field = state.metric === 'earned' ? 'earned' : 'services';
    const max = Math.max(1, ...stats.series.map((d) => d[field]));
    return h('section', { class: 'card dd-chart' },
        h('div', { class: 'row', style: { alignItems: 'center', gap: '10px', flexWrap: 'wrap' } },
            h('div', { style: { fontSize: '15px', fontWeight: '600', color: 'var(--ink-900)' } },
                tr('Последние 14 дней')),
            h('span', { style: { flex: '1' } }),
            h('div', { class: 'segmented', 'aria-label': tr('Что показывает график') },
                metricBtn('services', tr('Услуги')),
                metricBtn('earned', tr('Заработок')),
            ),
        ),
        h('div', { class: 'dd-plot' },
            ...stats.series.map((d) => h('div', {
                class: 'dd-col' + (d.isToday ? ' is-today' : ''),
                title: state.metric === 'earned'
                    ? trf('{d}: заработано {v}', { d: d.label, v: money(d.earned) })
                    : trf('{d}: услуг {v}', { d: d.label, v: d.services }),
            },
                h('div', { class: 'dd-bar', style: { height: Math.max(3, Math.round(d[field] * 100 / max)) + '%' } }),
                h('div', { class: 'dd-col-l' }, d.label),
            )),
        ),
        topServicesBlock(stats.topServices),
    );
}
function metricBtn(id, label) {
    const on = state.metric === id;
    return h('button', {
        type: 'button', class: on ? 'on' : '', 'aria-pressed': on ? 'true' : 'false',
        onclick: () => { if (state.metric === id) return; state.metric = id; paint(); },
    }, label);
}
function topServicesBlock(top) {
    if (!top || !top.length) {
        return h('div', { class: 'dd-top' },
            h('div', { class: 'muted', style: { fontSize: '12.5px' } },
                tr('За две недели завершённых услуг нет — считать частоту не из чего.')));
    }
    const best = top[0].count || 1;
    return h('div', { class: 'dd-top' },
        h('div', { style: { fontSize: '13.5px', fontWeight: '600', color: 'var(--ink-800)' } },
            tr('Частые услуги за 14 дней')),
        ...top.map((s) => h('div', { class: 'dd-top-row' },
            h('div', { class: 'dd-top-n' }, s.name),
            h('div', { class: 'dd-top-c' }, trf('{n} · {p}%', { n: s.count, p: s.share })),
            h('div', { class: 'dd-top-bar' }, h('i', { style: { width: Math.round(s.count * 100 / best) + '%' } })),
        )),
    );
}

// ---- Правая колонка: мой день ---------------------------------------------
function dayCard(day, now) {
    const list = h('div', { class: 'dd-day-list' });
    if (!day.rows.length) {
        // 08:00, приёмов ещё нет. Это НЕ ошибка и не заглушка «нет данных»: у
        // дня просто нет записей, и сказать об этом надо словами, которые не
        // выглядят поломкой.
        list.appendChild(h('div', { class: 'empty', style: { padding: '40px 16px' } },
            h('div', { style: { fontSize: '13.5px', fontWeight: '600', color: 'var(--ink-700)' } },
                tr('На сегодня записей нет')),
            h('div', { style: { fontSize: '12.5px', marginTop: '6px' } },
                tr('Как только регистратура запишет пациента, он появится здесь по времени приёма.')),
        ));
    } else {
        day.rows.forEach((r, i) => {
            if (i === day.nowAt) list.appendChild(nowLine(now));
            list.appendChild(apptCard(r));
        });
        if (day.nowAt >= day.rows.length) list.appendChild(nowLine(now));
    }
    return h('aside', { class: 'card dd-day' },
        h('div', { class: 'card-header' },
            h('h3', null, Icon('Calendar', { size: 15 }), tr('Мой день')),
            h('span', { class: 'muted', style: { fontSize: '12.5px' } },
                trf('приёмов: {n}', { n: day.rows.length })),
        ),
        list,
    );
}
function nowLine(now) {
    return h('div', { class: 'dd-nowline' }, hhmm(now), h('i', null));
}
function apptCard(r) {
    const meta = [
        r.age != null ? trf('{n} г.', { n: r.age }) : null,
        r.mrn || null,
        r.serviceName || null,
        r.room || null,
    ].filter(Boolean).join(' · ');
    return h('button', {
        type: 'button',
        class: 'dd-appt' + (r.past ? ' is-past' : '') + (DEAD_VISIT.has(r.status) ? ' is-dead' : ''),
        onclick: () => { if (openWorkRef) openWorkRef(r); },
    },
        h('span', { class: 'dd-appt-t' }, r.time || '—'),
        h('span', { class: 'dd-appt-av ' + pastelFor(r.patientId) }, initials(r.patientName || '?')),
        h('span', { class: 'dd-appt-b' },
            h('span', { class: 'dd-appt-n' }, r.patientName || tr('Без имени')),
            h('span', { class: 'dd-appt-m' }, meta || '—'),
        ),
        h('span', { class: 'dd-chip ' + dayStateTone(r) }, dayStateLabel(r)),
    );
}
