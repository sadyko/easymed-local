/**
 * WALK_IN_BOOKING_V1 — регистрация «пришёл сейчас» без окна: визит → строки услуг
 * → счёт → номера очереди. Порядок и формы аргументов — те же, что у мастера визита
 * (createVisit в visit-wizard.js); здесь только та часть, что нужна одному окну
 * «Быстрой регистрации»: без слота, без разбивки плательщика.
 *
 * ПОЧЕМУ ОТДЕЛЬНЫЙ МОДУЛЬ. Цепочка сохранения мастера живёт внутри его DOM —
 * шаги, корзина, чипы, планировщик. Быстрой регистрации нужна ровно её середина:
 * пациент и список строк «услуга + врач». Скопировать цепочку в экран значило бы
 * завести вторую правду о том, как заводится визит; поэтому она вынута сюда
 * целиком и без единого обращения к DOM — экран зовёт одну функцию.
 *
 * СКИДКА ГРУППЫ ПАЦИЕНТА СЧИТАЕТСЯ НА СЕРВЕРЕ, И ЗДЕСЬ ЕЁ НЕ СЧИТАЮТ.
 * create_invoice_for_visit сам берёт процент категории пациента и применяет его
 * как ПОЛ скидки (server/services/rpc/billing.js:249-252, CATEGORY_DISCOUNT_V1:
 * `Math.min(Math.max(discountRaw, categoryDiscount), subtotal)`). Поэтому
 * discount_amount уходит нулём: прислать свой расчёт значило бы поставить
 * деньги в зависимость от того, какая страница открыта у регистратора.
 *
 * ВИЗИТ БЕЗ СЧЁТА — ЭТО НЕ ПОТЕРЯ. Провал после ensure_visit бросает наружу и
 * оставляет визит (и уже вставленные строки) как есть — ровно как мастер. Визит
 * виден в карте пациента, счёт выставляется из него же; удалять пациента,
 * который уже стоит у стойки, было бы хуже.
 *
 * НО ОШИБКА ОБЯЗАНА СКАЗАТЬ, ЧТО УЖЕ ЗАПИСАНО. Провал после визита несёт
 * err.partial = { visit, lines } — заведённый визит и строки, которые в него
 * уже легли. Без этого вызывающему остаётся одно «не получилось», а самое
 * естественное движение регистратора после неудачи — нажать ещё раз; второй
 * вызов переиспользует ТОТ ЖЕ визит дня (ensure_visit) и допишет в него те же
 * строки заново. Пациент с задвоенными услугами разбирается уже в кассе,
 * поэтому повтор должен быть НЕВОЗМОЖЕН, а не «просто не рекомендован».
 *
 * ЭТА ФУНКЦИЯ НЕ ИДЕМПОТЕНТНА. Второй вызов в тот же день не «повторит»
 * регистрацию, а допишет строки в тот же визит дня и выставит ВТОРОЙ счёт на
 * них. Поэтому вызывающий обязан выключить свою кнопку на время вызова и
 * ОСТАВИТЬ её выключенной после успеха: пациент с двумя счетами за один приход
 * разбирается уже в кассе, а не на экране.
 *
 * quoteError — ЭТО ГРОМКОЕ СОБЫТИЕ, А НЕ ПОМЕТКА В ОТВЕТЕ. Когда он заполнен,
 * тариф визита спросить не удалось, и счёт выставлен по цене каталога и слову
 * 'primary' (первичный приём) — то есть возможной переплатой пациента.
 * Вызывающий обязан сказать об этом видимо, а не проглотить ответ молча.
 *
 * lines: [{ service: {id, price, requires_doctor, name}, doctorId: number|null }]
 * → { visit, invoice, items, queue: Map(visit_service_id → row),
 *     lines: [{ visitServiceId, serviceId, doctorId, unitPrice, tier }],
 *     quoteError?: string, queueError?: string }
 * Бросает Error с читаемым message на первом провале ДО счёта (визит остаётся
 * без счёта — как в мастере).
 */
import { supabase } from '../../supabase.js';
import { tr, trf } from '../i18n.js';   // I18N_COVERAGE_V1 — перевод СНАЧАЛА, подстановка ПОТОМ
// CRM_REAL_BOOKING_V1 — ответ ensure_visit читается ОДНИМ кодом на три двери:
// у него три исхода, и визит есть во всех трёх (см. ensure-visit-answer.js).
import { readEnsureVisit } from '../ensure-visit-answer.js';

const isPosInt = (v) => {
    const n = Number(v);
    return Number.isInteger(n) && n > 0;
};

/** Текст отказа сервера его словами; форма ответа одинакова у rpc и у /api/db. */
const msgOf = (err) => (err && (err.message || err.msg)) || String(err || '');

// WALK_IN_ROLE_GATE_V1 — КОМУ ЭТА ЦЕПОЧКА ПРОХОДИМА ЦЕЛИКОМ.
//
// Сервер и без нас никого лишнего не пропустит, но пропускает он ПОШАГОВО:
// вставку в patients разрешает admin/registrar/callcenter, а
// create_invoice_for_visit — admin/registrar/cashier (server/services/rpc/
// billing.js, CREATE_INVOICE_ROLES). Пересечение этих двух списков и стоит
// ниже: только оно доходит от карты пациента до счёта.
//
// Зачем повторять серверную проверку на клиенте. Кассир, взявшийся
// зарегистрировать приход, завёл бы карту и визит и получил отказ НА СЧЁТЕ —
// то самое «визит без счёта», которое потом разбирают руками. Ранний отказ
// стоит перед первой записью, а последнее слово о правах остаётся за сервером:
// это подсказка, а не охрана.
const WALK_IN_ROLES = ['admin', 'registrar'];

/**
 * Роли человека: основная плюс «Дополнительные роли» (users.extra_roles) — тем
 * же объединением, которым считает сервер (server/services/roles.js,
 * effectiveRoles). Клиент, смотрящий только на основную, отказал бы медсестре с
 * ролью регистратора в дополнительных, которую сервер пропускает.
 *
 * Принимаем и строку роли, и самого пользователя: вызывающему не приходится
 * разбирать, что у него на руках.
 */
function rolesOf(actor) {
    if (!actor) return [];
    if (typeof actor === 'string') return [actor];
    const extra = Array.isArray(actor.extra_roles) ? actor.extra_roles : [];
    return [actor.role, ...extra].filter((r) => typeof r === 'string' && r);
}

/**
 * Отказ по роли ТЕКСТОМ — или null, если человеку можно.
 *
 * Отдельно от registerWalkIn и наружу: экран спрашивает ДО заведения карты
 * пациента, чтобы отказ не оставлял после себя половину работы. Ответ один и
 * тот же, потому что список ролей один.
 *
 * Роль не передана — не отказываем. Молчание вызывающего не значит «нельзя»:
 * придумать отказ на пустом месте значило бы сорвать вызов, который сервер
 * выполнил бы.
 *
 * @param {string|{role?:string, extra_roles?:string[]}|null} actor
 * @returns {string|null}
 */
export function walkInRoleRefusal(actor) {
    const mine = rolesOf(actor);
    if (!mine.length) return null;
    if (mine.some((r) => WALK_IN_ROLES.includes(r))) return null;
    return tr('Регистрировать визиты и выставлять счета может регистратор или администратор.');
}

/**
 * Проверка ДО ПЕРВОЙ ЗАПИСИ В БАЗУ. Услуга, которой нужен врач, без врача —
 * это строка, которую никто не выполнит и которую очередь не сможет никуда
 * поставить; узнать об этом надо до визита, а не после него.
 */
function validate(patientId, items) {
    if (!isPosInt(patientId)) throw new Error(tr('Не выбран пациент — регистрировать некого.'));
    if (!items.length) throw new Error(tr('Добавьте хотя бы одну услугу.'));
    for (const line of items) {
        const svc = line && line.service;
        if (!svc || !isPosInt(svc.id)) throw new Error(tr('Строка без услуги — выберите услугу из каталога.'));
        if (svc.requires_doctor && !isPosInt(line.doctorId)) {
            throw new Error(trf('Укажите врача для услуги «{name}»', { name: svc.name || '' }));
        }
    }
}

/**
 * VISIT_TIER_PRICING_V1 — что эти услуги стоят ИМЕННО ЭТОМУ пациенту сегодня.
 * Отказ RPC не срывает регистрацию: строка ложится по цене каталога и словом
 * 'primary' — тем же, по которому касса потом пересчитает её сама. О том, что
 * тариф не спрошен, вызывающий узнаёт из quoteError, а не из тишины.
 *
 * visit_id — ТОТ САМЫЙ визит, в который сейчас лягут строки, и сервер исключает
 * его из поиска «предыдущего визита» (server/services/rpc/service-price-quote.js).
 * Без него вторая услуга, выписанная тому же пациенту в тот же день, видела бы
 * первую как прошлый приём и продавалась бы по тарифу повторного — за визит,
 * которого не было. Визит дня переиспользуется (ensure_visit), так что это не
 * редкий случай, а обычная вторая услуга у стойки.
 */
async function quoteTiers(patientId, serviceIds, visitId) {
    try {
        const res = await supabase.rpc('service_price_quote', {
            patient_id: patientId, service_ids: serviceIds, visit_id: visitId,
        });
        if (res && res.error) return { quotes: {}, quoteError: msgOf(res.error) };
        const quotes = res && res.data && res.data.quotes;
        return { quotes: quotes && typeof quotes === 'object' ? quotes : {}, quoteError: null };
    } catch (e) {
        return { quotes: {}, quoteError: msgOf(e) };
    }
}

export async function registerWalkIn({ patientId, lines, referralSourceId = null, createdBy = null, actorRole = null, now = () => new Date() } = {}) {
    const pid = Number(patientId);
    const items = (Array.isArray(lines) ? lines : []).filter(Boolean);
    // WALK_IN_ROLE_GATE_V1 — раньше всего остального: роль решает, дойдёт ли
    // цепочка до конца вообще, а не эта строка или та.
    const refusal = walkInRoleRefusal(actorRole);
    if (refusal) throw new Error(refusal);
    validate(pid, items);

    // 1. Филиал — тот же первый действующий, что берёт мастер визита.
    const { data: branchRows } = await supabase.from('branches').select('id').eq('active', true).order('id').limit(1);
    const branchId = branchRows && branchRows[0] ? branchRows[0].id : null;

    // 2. Визит дня. Слота нет: приход «сейчас» ничьё время в календаре не
    //    занимает, поэтому book не отправляется вовсе — проверять нечего.
    const when = now();
    const iso = new Date(when instanceof Date ? when.getTime() : when).toISOString();
    //    ВРАЧ ВИЗИТА — ПЕРВАЯ СТРОКА, У КОТОРОЙ ВРАЧ ЕСТЬ, а не первая строка
    //    вообще. Заказ у стойки обычно начинается с анализа (врач ему не нужен)
    //    и только потом идёт приём: взяв врача у items[0], визит уходил бы в
    //    базу без врача, хотя приём в нём есть, — и в дне врача такого пациента
    //    не было бы вовсе, хотя он уже стоит у его двери.
    const head = items.find((l) => isPosInt(l.doctorId));
    const headDoctor = head ? Number(head.doctorId) : null;
    const { data: ev, error: evErr } = await supabase.rpc('ensure_visit', {
        patient_id: pid,
        date: iso,
        doctor_id: headDoctor,
        visit_type: 'outpatient',
        referral_source_id: isPosInt(referralSourceId) ? Number(referralSourceId) : null,
        branch_id: branchId,
        notes: null,
    });
    if (evErr) throw new Error(trf('Визит не создан: {msg}', { msg: msgOf(evErr) }));
    const visit = ev && ev.visit;
    if (!visit || !isPosInt(visit.id)) throw new Error(tr('Визит не создан: сервер не вернул запись.'));
    // CRM_REAL_BOOKING_V1 — ОТВЕТ ЧИТАЕТСЯ ЦЕЛИКОМ. book: отсюда не уходит, и
    // сервер на такой вызов ни переноса, ни отказа по занятому дню не отдаёт —
    // но дверь читает ответ тем же кодом, что и две другие: если сюда
    // когда-нибудь придёт «время НЕ занято», регистрация обязана остановиться
    // ДО первой строки, а не выставить счёт на час, которого в календаре нет.
    // Перенос — успех, о котором вызывающий говорит вслух (movedNote).
    const answer = readEnsureVisit(ev);
    if (answer.busy) throw new Error(answer.text);

    // 3. Тариф визита — до вставки строк: слово тарифа пишется В САМУЮ СТРОКУ,
    //    и касса потом считает цену по нему.
    const serviceIds = [...new Set(items.map((l) => Number(l.service.id)))];
    const { quotes, quoteError } = await quoteTiers(pid, serviceIds, visit.id);

    // 4. Строки услуг. Провал вставки — наружу: половина визита лучше, чем счёт
    //    на услуги, которых в визите нет.
    const saved = [];
    const vsIds = [];
    /** Отказ ПОСЛЕ визита: к сообщению прикладывается уже записанное (см. шапку). */
    const failAfterVisit = (msg) => {
        const err = new Error(msg);
        err.partial = { visit, lines: saved.slice() };
        return err;
    };
    for (const line of items) {
        const svc = line.service;
        const q = quotes[svc.id] != null ? quotes[svc.id] : quotes[String(svc.id)];
        const quoted = q && Number.isFinite(Number(q.price)) ? Number(q.price) : null;
        const unitPrice = quoted === null ? (Number(svc.price) || 0) : quoted;
        const tier = q && (q.tier === 'secondary' || q.tier === 'repeat') ? q.tier : 'primary';
        const row = {
            visit_id: visit.id,
            service_id: Number(svc.id),
            quantity: 1,
            unit_price: unitPrice,
            total: unitPrice,
            status: 'added',
            price_tier: tier,
        };
        const doctorId = isPosInt(line.doctorId) ? Number(line.doctorId) : null;
        if (doctorId) row.doctor_id = doctorId;
        // PACKAGES_V1 — строка из пакета: скидку пакета и его срок считает сервер.
        if (isPosInt(line.packageId)) row.package_id = Number(line.packageId);
        if (isPosInt(createdBy)) row.created_by = Number(createdBy);
        const res = await supabase.from('visit_services').insert(row).select().single();
        if (res.error) throw failAfterVisit(trf('Услуга «{name}»: {msg}', { name: svc.name || '', msg: msgOf(res.error) }));
        vsIds.push(res.data.id);
        saved.push({ visitServiceId: res.data.id, serviceId: Number(svc.id), doctorId, unitPrice, tier });
    }

    // 5. Счёт пациенту. discount_amount = 0 — см. шапку: процент категории
    //    применяет сервер, и он же зажимает скидку суммой счёта.
    const { data: inv, error: invErr } = await supabase.rpc('create_invoice_for_visit', {
        visit_id: visit.id,
        visit_service_ids: vsIds,
        discount_amount: 0,
        payer_id: null,
    });
    if (invErr) throw failAfterVisit(trf('Счёт не выставлен: {msg}', { msg: msgOf(invErr) }));

    // 6. Номера очереди. Провал — предупреждение, а не отказ: деньги приняты,
    //    визит заведён, а талон печатается повторно тем же вызовом.
    const queue = new Map();
    let queueError = null;
    try {
        const res = await supabase.rpc('issue_queue_numbers', { p_ids: vsIds });
        if (res && res.error) queueError = msgOf(res.error);
        else for (const ticket of (res && res.data) || []) queue.set(ticket.visit_service_id, ticket);
    } catch (e) {
        queueError = msgOf(e);
    }

    const out = {
        visit,
        invoice: (inv && inv.invoice) || null,
        items: (inv && inv.items) || [],
        queue,
        lines: saved,
    };
    if (quoteError) out.quoteError = quoteError;
    if (queueError) out.queueError = queueError;
    if (answer.moved) out.movedNote = answer.text;
    return out;
}
