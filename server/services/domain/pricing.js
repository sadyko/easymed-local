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
