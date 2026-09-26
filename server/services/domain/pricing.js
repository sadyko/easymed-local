import { tierUnitPrice } from './visit-tier.js';   // PAY_BASIS_PERFORMED_V1 — lineUnitPrice

// DOCTOR_OWN_PRICE_V1 — what a service costs when THIS doctor performs it.
//
// The catalog price on `services` is the clinic's default. A doctor may have
// their own price for a service (a senior consultant charging more for the same
// consultation is the usual case); it is stored on the doctor's own rate list,
// users.service_rates, as `price` alongside the `pct` they earn.
//
// Absence is meaningful and must survive every hop: no `price` key at all means
// "this doctor has no own price — bill the catalog", whereas a stored 0 is a
// genuine free-of-charge price. Conflating the two would silently zero a bill,
// so every layer here distinguishes null from 0.
//
// Rule: no handler reads users.service_rates for money itself. It calls in here,
// so there is exactly one answer to "what does this line cost".

// The doctor's own price for a service, or null when they have none.
// `doctorId` may be null (an unassigned line) — that simply has no override.
export function doctorPriceFor(db, doctorId, serviceId) {
  if (!Number.isInteger(doctorId) || doctorId <= 0) return null;
  if (!Number.isInteger(serviceId) || serviceId <= 0) return null;

  const row = db.prepare(`
    SELECT CAST(json_extract(j.value, '$.price') AS REAL) AS price
      FROM users u, json_each(u.service_rates) j
     WHERE u.id = ?
       AND u.service_rates IS NOT NULL AND u.service_rates != ''
       AND json_valid(u.service_rates)
       AND CAST(json_extract(j.value, '$.service_id') AS INTEGER) = ?
     LIMIT 1
  `).get(doctorId, serviceId);

  // json_extract returns NULL both for a missing key and for a JSON null, which
  // is exactly the "no own price" case we want to fall through on.
  if (!row || row.price === null || row.price === undefined) return null;
  if (!Number.isFinite(row.price) || row.price < 0) return null;   // corrupt row -> catalog
  return row.price;
}

// The unit price to bill for one line: the performing doctor's own price when
// they have one, otherwise the catalog price. Kept as a named function so the
// precedence rule is stated once and can be cited from the billing handlers.
export function unitPriceFor(db, { doctorId, serviceId, catalogPrice }) {
  const own = doctorPriceFor(db, doctorId, serviceId);
  return own === null ? catalogPrice : own;
}

// PAY_BASIS_PERFORMED_V1 — the unit price the INVOICE will charge for one
// stored line, stated once for both the till and the doctor's pay.
//
// The doctor is now paid for PERFORMED work, invoiced or not (owner, 26.09).
// A performed line that has no invoice yet is priced exactly the way the
// cashier's invoice will price it, so the doctor's share does not change when
// the invoice is issued. That is only true while there is ONE answer to
// "what will the invoice charge", so the billing handlers call this too:
//   • a service line — the performing doctor's own price, else the catalog
//     (unitPriceFor); on a VISIT line the recorded price tier then wins over
//     both (VISIT_TIER_PRICING_V1, tierUnitPrice). Inpatient lines carry no
//     tier: pass tiered = false, as buildAdmissionInvoice does;
//   • a product line (clinic_item_id) — the product's sale price;
//   • an ad-hoc line (neither) — the price stored on the line.
// `service` / `product` are the rows already looked up by the caller (the
// till throws on a missing one; the pay report reads NULL as "catalog 0").
export function lineUnitPrice(db, row, { service = null, product = null, tiered = true } = {}) {
  if (row.service_id != null) {
    const catalogPrice = service ? service.price : 0;
    const unit = unitPriceFor(db, { doctorId: row.doctor_id, serviceId: row.service_id, catalogPrice });
    return tiered && service ? tierUnitPrice(service, row.price_tier, unit) : unit;
  }
  if (row.clinic_item_id != null) return product ? product.sale_price : 0;
  return row.unit_price;
}

// PACKAGES_V1, ревью M3 (2026-09-26) — скидка пакета, которую касса даст
// строке визита, или 0. Правило то же, что у create_invoice_for_visit
// (billing.js linePackage): местный день визита лежит в сроке предложения
// [valid_from, valid_until] (границы включительно, пустая — без ограничения),
// и услуга строки входит в пакет. Касса на нарушение ОТКАЗЫВАЕТ выставлять
// счёт; доля врача за выполненную, но ещё не выставленную строку в этом случае
// считается БЕЗ скидки пакета (скидку дать нельзя — значит, её и нет), а не
// со скидкой, которую счёт никогда не поставит.
//
// `pkg` — строка service_templates (service_ids, discount_percent, valid_from,
// valid_until) или null; `visitDay` — 'YYYY-MM-DD'. Чистая функция.
export function packageDiscountPct(pkg, serviceId, visitDay) {
  if (!pkg) return 0;
  const day = String(visitDay || '').slice(0, 10);
  if ((pkg.valid_from && day < pkg.valid_from) || (pkg.valid_until && day > pkg.valid_until)) return 0;
  let ids = [];
  try { ids = JSON.parse(pkg.service_ids || '[]'); } catch { ids = []; }
  if (!Array.isArray(ids) || !ids.some((id) => Number(id) === Number(serviceId))) return 0;
  const pct = Number(pkg.discount_percent);
  return Number.isFinite(pct) ? Math.min(Math.max(pct, 0), 100) : 0;
}
