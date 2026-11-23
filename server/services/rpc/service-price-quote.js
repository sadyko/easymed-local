// VISIT_TIER_PRICING_V1 — service_price_quote: what these services cost THIS
// patient today, by the tier rule in domain/visit-tier.js.
//
// Asked by the booking wizard the moment a patient is attached and a service
// is in the смета, and by the doctor's «добавить услугу». The answer is a
// quote, not a write: the caller puts the price and the tier word on the line
// it inserts, and the cashier (billing.js) re-derives the price from that
// word, so a line always says why it costs what it costs.
//
// «Previous visit» = the patient's most recent EARLIER line of the same
// service on a visit that happened (not cancelled / no-show), excluding the
// visit being edited. Its local calendar day is what the window counts from.
//
// VISIT_TIER_ATTENDED_V1 (3.25.0, правило владельца) — «ПРОШЛЫЙ ВИЗИТ» — ТОЛЬКО
// ТОТ, НА КОТОРЫЙ ПАЦИЕНТ ПРИШЁЛ И ЗА КОТОРЫЙ ВЫСТАВЛЕН СЧЁТ. Прежде считалась
// любая строка той же услуги на неотменённом визите — и БУДУЩАЯ запись тоже:
// две записи колл-центра (через день и через три) давали второй цену «второго
// визита» (бывает и 0), хотя первого визита не было; касса брала записанный
// ярус, и его не пересчитывало ни отмена, ни «Не пришёл», ни перенос первой.
// Теперь прошлая строка считается, только если:
//   • визит не отменён и не «Не пришёл», и его местный день — не позже
//     сегодняшнего дня клиники (будущая запись ещё не случилась) и не позже
//     дня этой строки;
//   • строка выставлена в счёт, который не отменён и не возвращён целиком
//     ('void' / 'refunded'), и деньги за неё не возвращены (отметка возврата
//     'out', pay_refund_releases). Строка соседнего здания (sync_origin) ссылки
//     на позицию счёта не везёт (journal.js) — у неё «выставлена» значит: у её
//     визита есть живой счёт с позицией этой услуги;
//   • визит — другой, не тот, что считается (его строки исключены целиком).
// ТОТ ЖЕ ДЕНЬ: окно услуги решает само, как и прежде (visit-tier.js windowFor):
// «со дня» не задано — с 1-го дня, и визит того же дня не в счёт; задано 0 —
// выставленный визит того же дня (другой визит) — прошлый.
// Правило одно — здесь; смета мастера, быстрая регистрация, калькулятор,
// запись колл-центра (booking-mirror.js priceFor) и касса (billing.js — ярус
// невыставленных строк решается заново при счёте, billingTiers ниже) читают его.
import { hasAnyRole } from '../roles.js';
import { notRefundReleasedSql } from '../domain/pay-releases.js';   // VISIT_TIER_ATTENDED_V1 — возвращённая строка не в счёт
import { tierFor, hasTiers } from '../domain/visit-tier.js';
import { today, localDate } from '../domain/day.js';
// BILLING_AUDIT_FIX_V1 (A2) — личная цена врача: то же правило, что у кассы.
import { doctorPriceFor } from '../domain/pricing.js';
// OWN_PRICE_REPEAT_V1 — своя цена сильнее яруса: то же правило, что у счёта.
import { serviceLinePrice } from '../../../public/js/shared/own-price-rule.js';

export class RpcError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

const QUOTE_ROLES = ['admin', 'registrar', 'doctor', 'nurse', 'cashier', 'callcenter'];

/**
 * args: { patient_id, service_ids: [id…], visit_id?, date?: 'YYYY-MM-DD',
 *         doctor_id?, doctor_ids?: { [service_id]: doctor_id } }
 * `date` — the day the visit is PLANNED for (the wizard books tomorrow as
 * readily as today); the window is counted to that day, and only visits up
 * to that day are «earlier». Absent → the clinic's today.
 * → { quotes: { [service_id]: { tier, price, base_price, days_since, reason, prev_day, own_price? } } }
 *
 * BILLING_AUDIT_FIX_V1 (A2) — ВРАЧ СТРОКИ ВХОДИТ В ЦЕНУ. Касса считает строку
 * через lineUnitPrice (domain/pricing.js): личная цена врача поверх каталога,
 * а тариф второго/повторного визита — поверх каталога (см. ниже, как тариф
 * действует на личную цену). Котировка без врача
 * отдавала каталог, и быстрая регистрация показывала и печатала 100 000, пока
 * счёт брал личные 150 000 врача (а разницу рисовала «Скидкой»). Теперь врач
 * строки — doctor_ids[service_id], иначе doctor_id — даёт ту же цену, что
 * счёт: его личная цена первого визита (base_price тоже).
 *
 * OWN_PRICE_TIER_RATIO_V1 (владелец, 2026-09-30; заменяет OWN_PRICE_REPEAT_V1
 * 3.14.0, где личная цена шла на любой ярус как есть) — на втором и повторном
 * визите личная цена получает ту же скидку, что каталог: price = личная ×
 * (цена тарифа ÷ каталог первичного), до 0,01 (shared/own-price-rule.js
 * serviceLinePrice). Ярус (tier) котировка называет по-прежнему — он пишется в
 * строку, по нему считаются визиты. base_price и own_price — личная цена
 * ПЕРВОГО визита: её экран зачёркивает рядом с ценой со скидкой.
 */
export function servicePriceQuote(db, args, user) {
  if (!hasAnyRole(user, QUOTE_ROLES)) throw new RpcError('Нет доступа к ценам услуг.', 403);
  return quoteServicePrices(db, args);
}

/**
 * CASHIER_HEAD_V1 (ревью) — тот же расчёт без проверки роли: для серверных
 * дверей, которые уже проверили СВОЁ право (касса по «Исправляет услуги в
 * счёте» — у своей роли клиники на основе медсестры или склада роли из
 * QUOTE_ROLES может не быть, а тариф строки считать всё равно нужно).
 */
export function quoteServicePrices(db, args) {
  const a = args || {};
  const patientId = Number(a.patient_id);
  if (!Number.isInteger(patientId) || patientId <= 0) throw new RpcError('patient_id обязателен.', 400);
  const ids = Array.isArray(a.service_ids) ? [...new Set(a.service_ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))] : [];
  if (!ids.length) return { quotes: {} };
  const decided = tierDecisions(db, { patientId, serviceIds: ids, visitId: a.visit_id, date: a.date });

  const byService = a.doctor_ids && typeof a.doctor_ids === 'object' ? a.doctor_ids : {};
  const anyDoctor = Number(a.doctor_id);
  const doctorOf = (sid) => {
    const d = Number(byService[sid] != null ? byService[sid] : byService[String(sid)]);
    if (Number.isInteger(d) && d > 0) return d;
    return Number.isInteger(anyDoctor) && anyDoctor > 0 ? anyDoctor : null;
  };

  const quotes = {};
  for (const id of ids) {
    const d = decided.get(id);
    if (!d) continue;
    const { svc, q } = d;
    const own = doctorPriceFor(db, doctorOf(id), id);
    quotes[id] = own === null ? q
      : { ...q, own_price: own, base_price: own, price: serviceLinePrice(own, q.price, Number(svc.price) || 0) };   // OWN_PRICE_TIER_RATIO_V1
  }
  return { quotes };
}

/**
 * VISIT_TIER_ATTENDED_V1 — РЕШЕНИЕ О ЯРУСЕ, ОДНО НА КОТИРОВКУ И КАССУ: для каждой
 * услуги — строка services и ответ tierFor (без своей цены врача — её кладёт
 * котировка). Услуги, которой нет, в ответе нет.
 * `date` — день визита ('YYYY-MM-DD'; нет — сегодняшний день клиники);
 * `visitId` — визит, чьи строки не считаются прошлыми (null — визита ещё нет).
 * @returns {Map<number, {svc: object, q: object}>}
 */
function tierDecisions(db, args) {
  return tierDecider(db)(args);
}

// VISIT_TIER_ATTENDED_V1 (доводка) — то же решение для МНОГИХ визитов подряд:
// запросы готовятся один раз, строка услуги читается один раз на услугу, день
// клиники — один на всю выборку. Им считают доля врача в отчётах (reports.js,
// тысячи строк за период) и «Ждут счёта»; одиночный вызов — tierDecisions выше.
function tierDecider(db) {
  const clinicToday = today(db);
  const getService = db.prepare('SELECT id, price, price_secondary, secondary_days_from, secondary_days_to, price_repeat, repeat_days_from, repeat_days_to FROM services WHERE id = ?');
  const services = new Map();
  const serviceOf = (id) => { if (!services.has(id)) services.set(id, getService.get(id) || null); return services.get(id); };
  // The most recent earlier line of this service for this patient. Lines
  // cancelled at the desk and visits that never happened do not count: a
  // patient who booked and did not come has not had a first visit.
  // VISIT_TIER_ATTENDED_V1 — и только визит, который УЖЕ был (день не позже
  // сегодняшнего), со строкой, выставленной в живой счёт и не возвращённой
  // (правило — в шапке модуля).
  const prevStmt = db.prepare(`
    SELECT ${localDate('v.visit_date')} AS day, vs.price_tier AS tier
      FROM visit_services vs
      JOIN visits v ON v.id = vs.visit_id
     WHERE v.patient_id = ? AND vs.service_id = ?
       AND v.status NOT IN ('cancelled', 'no_show')
       AND COALESCE(vs.status, '') NOT IN ('cancelled', 'void', 'removed')
       AND (? IS NULL OR vs.visit_id != ?)
       AND ${localDate('v.visit_date')} <= ?
       AND ${localDate('v.visit_date')} <= ?
       AND (
         (vs.invoice_item_id IS NOT NULL
           AND EXISTS (SELECT 1 FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
                        WHERE ii.id = vs.invoice_item_id AND COALESCE(i.status, '') NOT IN ('void', 'refunded'))
           AND ${notRefundReleasedSql('vs', 'out')})
         OR (vs.sync_origin IS NOT NULL
           AND EXISTS (SELECT 1 FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
                        WHERE i.visit_id = vs.visit_id AND ii.service_id = vs.service_id
                          AND COALESCE(i.status, '') NOT IN ('void', 'refunded')))
       )
     ORDER BY v.visit_date DESC, vs.id DESC
     LIMIT 1`);
  // VISIT_TIER_SAME_DAY_V1 (2026-11-23, владелец: «second visit price wont working … charged full price
  // without showing a discount») — ВТОРОЙ ВИЗИТ В ТОТ ЖЕ ДЕНЬ. У пациента один визит на день: пришёл
  // утром и снова после обеда — вторая строка той же услуги садится в ТОТ ЖЕ визит (ensure_visit у
  // стойки отдаёт визит дня). prevStmt исключает текущий визит целиком, и «Не раньше чем через 0»
  // (экран услуги обещает: «второй визит в тот же день тоже считается») не срабатывал никогда —
  // полная цена и в смете, и в счёте. Теперь уже выставленная (в живом счёте, не возвращённая)
  // строка той же услуги В ЭТОМ ЖЕ визите тоже прошлая — но берётся, только если окно услуги её
  // пускает (день 0 в окне, обычно «со дня» 0). С окном «со дня» 1 и больше (по умолчанию) — как
  // раньше: прошлым остаётся визит другого дня.
  const sameVisitStmt = db.prepare(`
    SELECT ${localDate('v.visit_date')} AS day, vs.price_tier AS tier
      FROM visit_services vs
      JOIN visits v ON v.id = vs.visit_id
     WHERE vs.visit_id = ? AND v.patient_id = ? AND vs.service_id = ?
       AND v.status NOT IN ('cancelled', 'no_show')
       AND COALESCE(vs.status, '') NOT IN ('cancelled', 'void', 'removed')
       AND vs.invoice_item_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
                    WHERE ii.id = vs.invoice_item_id AND COALESCE(i.status, '') NOT IN ('void', 'refunded'))
       AND ${notRefundReleasedSql('vs', 'out')}
     ORDER BY vs.id DESC
     LIMIT 1`);

  return function decide({ patientId, serviceIds, visitId = null, date = null }) {
    const vid = visitId == null ? null : Number(visitId);
    const lineDay = /^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) ? String(date) : clinicToday;
    const out = new Map();
    for (const id of serviceIds) {
      const svc = serviceOf(id);
      if (!svc) continue;
      if (!hasTiers(svc)) {
        out.set(id, { svc, q: { tier: 'primary', price: Number(svc.price) || 0, base_price: Number(svc.price) || 0, days_since: null, reason: 'no_tiers', prev_day: null } });
        continue;
      }
      // VISIT_TIER_SAME_DAY_V1 — выставленная строка этой же услуги в этом же визите, если окно пускает день 0.
      const same = vid != null ? sameVisitStmt.get(vid, patientId, id) || null : null;
      if (same) {
        const q = tierFor(svc, { day: lineDay, tier: same.tier }, lineDay);
        if (q.reason === 'in_window') { out.set(id, { svc, q: { ...q, prev_day: lineDay } }); continue; }
      }
      const prev = prevStmt.get(patientId, id, vid, vid, lineDay, clinicToday) || null;
      out.set(id, { svc, q: { ...tierFor(svc, prev, lineDay), prev_day: prev ? prev.day : null } });
    }
    return out;
  };
}

/**
 * VISIT_TIER_ATTENDED_V1 — ЯРУС НЕВЫСТАВЛЕННЫХ СТРОК ОДНОГО ВИЗИТА В МИГ СЧЁТА.
 *
 * Ярус, записанный в строку при записи, мог устареть: прошлую запись отменили,
 * отметили «Не пришёл», перенесли, вернули за неё деньги — или экран прислал
 * свой. Касса (billing.js issueVisitInvoice) и «Ждут счёта» (cashier.js) берут
 * ярус отсюда — тем же правилом, что смета (tierDecisions): пациент визита,
 * местный день визита, сам визит исключён. Строка из пакета (цена пакета
 * записана на ней) и услуга без цен визитов в ответ не попадают: их цену ярус
 * не меняет, и записанное в них остаётся как есть.
 * `visit` — { id, patient_id, visit_date }; `rows` — строки visit_services.
 * @returns {Map<number, 'primary'|'secondary'|'repeat'>} id строки → ярус
 */
export function billingTiers(db, visit, rows) {
  return billingTiersMany(db, [{ visit, rows }]);
}

/**
 * VISIT_TIER_ATTENDED_V1 (доводка) — billingTiers для МНОГИХ визитов одним
 * проходом (запросы готовятся один раз, tierDecider): доля врача за выполненные,
 * ещё не выставленные строки периода (reports.js) и «Ждут счёта» (cashier.js).
 * Решение — ровно то же, что у счёта каждого визита.
 * `groups` — [{ visit: { id, patient_id, visit_date } | { id, patient_id, day: 'YYYY-MM-DD' }, rows }];
 * `day` — уже местный день визита (тогда visit_date не нужен).
 * @returns {Map<number, 'primary'|'secondary'|'repeat'>} id строки → ярус
 */
export function billingTiersMany(db, groups) {
  const out = new Map();
  let decide = null;
  let dayStmt = null;
  for (const { visit, rows } of groups || []) {
    const patientId = Number(visit && visit.patient_id);
    if (!Number.isInteger(patientId) || patientId <= 0) continue;
    const lines = (rows || []).filter((r) => r && r.service_id != null && !(r.package_price != null && r.package_full != null));
    if (!lines.length) continue;
    let day = /^\d{4}-\d{2}-\d{2}$/.test(String(visit.day || '')) ? String(visit.day) : null;
    if (!day) {
      if (!dayStmt) dayStmt = db.prepare(`SELECT ${localDate('?')} AS d`);
      day = dayStmt.get(visit.visit_date).d;
    }
    if (!decide) decide = tierDecider(db);
    const decided = decide({
      patientId, serviceIds: [...new Set(lines.map((r) => Number(r.service_id)))], visitId: visit.id, date: day,
    });
    for (const r of lines) {
      const d = decided.get(Number(r.service_id));
      if (!d || d.q.reason === 'no_tiers') continue;
      out.set(r.id, d.q.tier === 'secondary' || d.q.tier === 'repeat' ? d.q.tier : 'primary');
    }
  }
  return out;
}
