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

// Которая запись карточки ставок (users u, json_each(u.service_rates) j) несёт
// СВОЮ ЦЕНУ врача. Одно условие на doctorPriceFor и doctorPriceLookup
// (REFBILL_REVIEW_V1): вторая копия правила разошлась бы с первой.
const OWN_PRICE_ENTRY = `
       u.service_rates IS NOT NULL AND u.service_rates != ''
       AND json_valid(u.service_rates)
       -- FINAL_MONEY_FIX_V1 (M4) — при дублях услуги в карточке берётся запись
       -- С ЦЕНОЙ (ставка без цены и кривая отрицательная цена пропускаются) —
       -- то же правило, что у миграции 175. Прежде бралась первая запись, и
       -- акт стационара показывал личную цену, а счёт — каталог.
       AND json_extract(j.value, '$.price') IS NOT NULL
       AND CAST(json_extract(j.value, '$.price') AS REAL) >= 0
       -- V3120_FIX (MINOR) — ПУСТАЯ ИЛИ НЕЧИСЛОВАЯ ЦЕНА — «СВОЕЙ ЦЕНЫ НЕТ».
       -- '' и 'abc' приводились CAST к 0 и выставляли услугу бесплатно. Цена —
       -- это число JSON или строка из цифр ('80000', '80000.5'); остальное
       -- пропускается, и счёт берёт каталог.
       AND (json_type(j.value, '$.price') IN ('integer', 'real')
            OR (json_type(j.value, '$.price') = 'text'
                AND trim(json_extract(j.value, '$.price')) GLOB '[0-9]*'
                AND trim(json_extract(j.value, '$.price')) NOT GLOB '*[^0-9.]*'))`;

// Найденная цена → своя цена или null (кривая строка — каталог).
function ownPriceOf(price) {
  // json_extract returns NULL both for a missing key and for a JSON null, which
  // is exactly the "no own price" case we want to fall through on.
  if (price === null || price === undefined) return null;
  if (!Number.isFinite(price) || price < 0) return null;   // corrupt row -> catalog
  return price;
}

// The doctor's own price for a service, or null when they have none.
// `doctorId` may be null (an unassigned line) — that simply has no override.
export function doctorPriceFor(db, doctorId, serviceId) {
  if (!Number.isInteger(doctorId) || doctorId <= 0) return null;
  if (!Number.isInteger(serviceId) || serviceId <= 0) return null;

  const row = db.prepare(`
    SELECT CAST(json_extract(j.value, '$.price') AS REAL) AS price
      FROM users u, json_each(u.service_rates) j
     WHERE u.id = ?
       AND CAST(json_extract(j.value, '$.service_id') AS INTEGER) = ?
       AND ${OWN_PRICE_ENTRY}
     LIMIT 1
  `).get(doctorId, serviceId);
  return row ? ownPriceOf(row.price) : null;
}

// REFBILL_REVIEW_V1 (ревью M2) — СВОИ ЦЕНЫ ВРАЧЕЙ ВЫБОРКИ ОДНИМ ЗАПРОСОМ.
//
// «Ждут счёта» кассы (cashier_unbilled) спрашивал doctorPriceFor на КАЖДУЮ
// строку — json_each по всей карточке ставок врача, запрос за запросом: на
// объёме клиники 0,6–2,7 с на перерисовку, и всё это время стоит сервер
// (better-sqlite3 синхронный). Здесь карточки всех врачей выборки читаются
// одним запросом с тем же условием записи (OWN_PRICE_ENTRY) и тем же порядком:
// у doctorPriceFor LIMIT 1 без ORDER BY отдаёт первую подходящую запись
// карточки в порядке документа, здесь — первая встреченная на пару «врач,
// услуга». Возвращает функцию (doctorId, serviceId) → своя цена или null —
// то же, что ответил бы doctorPriceFor; её принимает lineUnitPrice (ownPrice).
export function doctorPriceLookup(db, doctorIds) {
  const ids = [...new Set((doctorIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  const prices = new Map();
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const rows = db.prepare(`
      SELECT u.id AS doctor_id,
             CAST(json_extract(j.value, '$.service_id') AS INTEGER) AS service_id,
             CAST(json_extract(j.value, '$.price') AS REAL) AS price
        FROM users u, json_each(u.service_rates) j
       WHERE u.id IN (${chunk.map(() => '?').join(', ')})
         AND ${OWN_PRICE_ENTRY}
    `).all(...chunk);
    for (const r of rows) {
      const key = r.doctor_id + ':' + r.service_id;
      if (!prices.has(key)) prices.set(key, r.price);
    }
  }
  return (doctorId, serviceId) => {
    if (!Number.isInteger(doctorId) || doctorId <= 0) return null;
    if (!Number.isInteger(serviceId) || serviceId <= 0) return null;
    const key = doctorId + ':' + serviceId;
    return prices.has(key) ? ownPriceOf(prices.get(key)) : null;
  };
}

// The unit price to bill for one line: the performing doctor's own price when
// they have one, otherwise the catalog price. Kept as a named function so the
// precedence rule is stated once and can be cited from the billing handlers.
// REFBILL_REVIEW_V1 — ownPrice: готовый ответ doctorPriceLookup вместо запроса.
export function unitPriceFor(db, { doctorId, serviceId, catalogPrice }, ownPrice = null) {
  const own = ownPrice ? ownPrice(doctorId, serviceId) : doctorPriceFor(db, doctorId, serviceId);
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
//   • a product line (clinic_item_id) — the price stored on the line at
//     dispense, in the line's own quantity unit (productLineUnitPrice);
//   • an ad-hoc line (neither) — the price stored on the line.
// `service` / `product` are the rows already looked up by the caller (the
// till throws on a missing one; the pay report reads NULL as "catalog 0").
// REFBILL_REVIEW_V1 (ревью M2) — для выборки из тысяч строк вызывающий может
// дать готовые ответы: `ownPrice` (doctorPriceLookup) вместо запроса своей цены
// врача на строку и `consult(typeId, doctorId)` (запомненный consultationFor).
// Правило цены от этого не меняется — меняется только, откуда взят ответ.
export function lineUnitPrice(db, row, { service = null, product = null, tiered = true, ownPrice = null, consult = null } = {}) {
  if (row.service_id != null) {
    const catalogPrice = service ? service.price : 0;
    const unit = unitPriceFor(db, { doctorId: row.doctor_id, serviceId: row.service_id, catalogPrice }, ownPrice);
    return tiered && service ? tierUnitPrice(service, row.price_tier, unit) : unit;
  }
  if (row.clinic_item_id != null) return productLineUnitPrice(row, product);
  // BILLING_AUDIT_FIX_V1 (B7) — консультация (service_id NULL +
  // consultation_type_id) — цена врача по виду приёма, а не присланная браузером.
  if (row.consultation_type_id != null) {
    const c = consult ? consult(row.consultation_type_id, row.doctor_id) : consultationFor(db, row.consultation_type_id, row.doctor_id);
    if (c) return c.price;
  }
  return row.unit_price;
}

// BILLING_AUDIT_FIX_V1 (B7) — ЦЕНА И ИМЯ КОНСУЛЬТАЦИИ СЧИТАЕТ СЕРВЕР.
//
// Строка консультации (service_id NULL + consultation_type_id, врач строки)
// шла в счёт как «ad-hoc»: с ценой, которую прислал браузер, и с пустым
// описанием. Правило то же, что у каталога (service-picker-modal.js
// consultPriceFor, CONSULT_PER_DOCTOR_V1): у врача есть строка
// doctor_consultation_prices по этому виду — её цена (is_free → 0, пустая → 0);
// строки нет — цена вида приёма из consultation_types (цена клиники). Имя —
// личное название врача, иначе название вида. Вида нет вовсе (удалён) — null:
// вызывающий оставляет сохранённое.
export function consultationFor(db, typeId, doctorId) {
  const tid = Number(typeId);
  if (!Number.isInteger(tid) || tid <= 0) return null;
  const ct = db.prepare('SELECT * FROM consultation_types WHERE id = ?').get(tid);
  if (!ct) return null;
  const did = Number(doctorId);
  const dc = Number.isInteger(did) && did > 0
    ? db.prepare('SELECT * FROM doctor_consultation_prices WHERE doctor_id = ? AND consultation_type_id = ? ORDER BY id DESC LIMIT 1').get(did, tid)
    : null;
  let price;
  if (dc) price = dc.is_free ? 0 : (Number.isFinite(Number(dc.price)) && dc.price !== null ? Math.max(0, Number(dc.price)) : 0);
  else price = Number.isFinite(Number(ct.price)) ? Math.max(0, Number(ct.price)) : 0;
  const name = (dc && (dc.name_ru || dc.name_uz || dc.name_en)) || ct.name_ru || ct.name_uz || ct.name || 'Консультация';
  return { price, name };
}

// INPATIENT_MONEY_FIX_V1 — товарная строка оценивается ОДИН раз, при выдаче, и
// её цена стоит в той же единице, что и количество. Выдача со склада пишет
// количество в базовых единицах (коробки) и цену коробки; выдача из подотчёта
// (holdings.js) — в единицах выдачи (таблетки) и цену таблетки. Пересчёт
// «цена коробки × число таблеток» давал счёт 400 000 за выдачу на 20 000
// (аудит 27.09). Поэтому счёт берёт сохранённую цену строки; каталог — только
// для строки, у которой цены нет вовсе (NULL из старых баз). Писать товарную
// строку с ценой умеют только RPC выдачи: /api/db её не заводит (реестр).
export function productLineUnitPrice(row, product) {
  const stored = row && row.unit_price;
  if (stored !== null && stored !== undefined && Number.isFinite(Number(stored)) && Number(stored) >= 0) return Number(stored);
  return product ? product.sale_price : 0;
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
