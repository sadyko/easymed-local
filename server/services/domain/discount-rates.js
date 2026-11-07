// DISCOUNT_RATES_V1 (3.22.0, решение владельца 2026-11-07) — СКИДКА ПО УСЛУГАМ НА СЕРВЕРЕ.
//
// У скидки группы пациентов и у промокода могут быть ставки по группе, категории и
// отдельной услуге (мигр. 274; правило — public/js/admin/discount-rates.js, одно с
// экранами). Сервер — власть: счёт считает он.
//
// КАК ЛОЖИТСЯ НА СЧЁТ. Скидка со ставками даёт каждой строке СВОЮ скидку
// (invoice_items.discount_amount — та же колонка, что у строки пакета, мигр. 154):
// консультация 100 % и УЗИ 20 % — разные доли, и отчёты (доля врача, выручка по
// услугам), возврат строки и правка счёта видят деньги каждой строки, а не среднюю
// по счёту. Строка помнит свой процент (discount_rate) и долю своей скидки,
// уменьшающую долю врача (discount_doctor_share — переключатель «Скидка уменьшает
// долю врача» скидки, мигр. 273). Строка со ставкой 0 % скидки не получает и
// остаётся «строкой без своей скидки» — с отметкой discount_rate = 0, чтобы пол
// группы на неё не лёг заново при правке счёта.
//
// Скидка БЕЗ ставок — ровно прежняя (один процент скидкой счёта на строки без своей,
// пол группы, append, отчёты — бит в бит как в 3.22 без этого потока).
//
// КОГДА СТАВКИ ДЕЙСТВУЮТ (выбор скидки — domain/discount-choice.js):
//   • «Скидка группы» — всегда ставками группы;
//   • выбор не передан (прежние экраны, касса, врач) и «вручную» — ставки группы, если
//     присланная скидка не больше скидки по ставкам (до сума вверх); больше — это своя
//     скидка регистратора, как прежде (одна сумма на счёт), и ставки не ложатся: пол
//     группы и так меньше присланного;
//   • промокод с процентом — ставками промокода на услуги, где он действует («Только на
//     эти услуги»); промокод суммой ставок не знает;
//   • «Без скидки» и счёт плательщику (B5) — без скидки группы, как прежде.
import { hasRates, lineDiscountPct } from '../../../public/js/admin/discount-rates.js';
import { isStoredValueCard } from '../../../public/js/admin/discount-rules.js';

const round2 = (n) => Math.round(n * 100) / 100;
const pctText = (p) => String(Math.round(Number(p) * 100) / 100).replace('.', ',') + '%';

function parseIds(v) {
  if (Array.isArray(v)) return v;
  try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a : []; } catch { return []; }
}

/**
 * Услуга строки для ставок, с кэшем на вызов: { id, type, is_lab, category_id } —
 * строка с услугой; { consultation: true } — консультация по виду приёма (без
 * услуги); null — товар и строка без услуги (действует процент скидки).
 */
export function makeLineService(db) {
  const stmt = db.prepare('SELECT id, type, is_lab, category_id FROM services WHERE id = ?');
  const cache = new Map();
  return (row) => {
    if (!row) return null;
    if (row.service_id != null) {
      const id = Number(row.service_id);
      if (!cache.has(id)) cache.set(id, stmt.get(id) || { id });
      return cache.get(id);
    }
    if (row.consultation_type_id != null && row.clinic_item_id == null) return { consultation: true };
    return null;
  };
}

/** Источник ставок — группа пациента (patientGroupDiscount с ставками) или null. */
export function groupRateSource(group) {
  if (!group || !hasRates(group.rates)) return null;
  return { kind: 'group', id: group.id, name: group.name, pct: group.pct, rates: group.rates, reduces: group.reduces === 0 ? 0 : 1, scope: [] };
}

/** Источник ставок — промокод с процентом и ставками, или null. */
export function promoRateSource(db, discountId) {
  const id = Number(discountId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const row = db.prepare('SELECT * FROM patient_discounts WHERE id = ?').get(id);
  if (!row || isStoredValueCard(row)) return null;
  const pct = Number(row.percent) || 0;
  if (!(pct > 0) || !hasRates(row.discount_rates)) return null;
  return { kind: 'promo', id: row.id, name: row.name || '', pct: Math.min(pct, 100), rates: row.discount_rates,
    reduces: Number(row.reduces_doctor_share) === 0 ? 0 : 1, scope: parseIds(row.service_ids) };
}

/** Причина скидки словами для кассы и истории. */
export function ratedNote(src) {
  if (!src) return null;
  return src.kind === 'promo'
    ? `Промокод «${src.name}» — по услугам (по умолчанию ${pctText(src.pct)})`
    : `Скидка группы «${src.name}» — по услугам (по умолчанию ${pctText(src.pct)})`;
}

/**
 * Скидка счёта по ставкам при выставлении (issueVisitInvoice).
 * @param db
 * @param choice  resolveDiscountChoice(...)
 * @param {{sent:number, discountId:any, lines: Array<{row:object, line:number}>}} a
 *   lines — строки счёта без своей скидки пакета.
 * @returns {null | {manualOver:true, floor:number} | {src, per:Array<{p, pct, off}>, total:number, note:string}}
 *   null — ставок нет (прежнее правило); manualOver — присланная своя скидка больше
 *   скидки по ставкам: прежнее правило «вручную» без пола группы.
 */
export function ratedChoice(db, choice, a) {
  let src = null;
  const kind = choice && choice.choice;
  if (kind === 'promo') src = promoRateSource(db, a.discountId);
  else if (kind === null || kind === undefined || kind === 'manual' || kind === 'group') src = groupRateSource(choice && choice.group);
  if (!src) return null;
  const svcOf = makeLineService(db);
  const per = (a.lines || []).map((p) => {
    const pct = lineDiscountPct(src, svcOf(p.row));
    return { p, pct, off: round2(Math.max(0, Number(p.line) || 0) * pct / 100) };
  });
  const total = round2(per.reduce((s, x) => s + x.off, 0));
  const sent = Number(a.sent) || 0;
  if ((kind == null || kind === 'manual') && sent > Math.ceil(total - 1e-9) + 0.005) return { manualOver: true, floor: total };
  return { src, per, total, note: total > 0 ? ratedNote(src) : null };
}

/**
 * Источник ставок неоплаченного счёта при правке строк (касса добавила услугу,
 * заменила услугу): группа пациента — там, где ложится её пол (выбор «группа»,
 * «вручную», прежний счёт); у счёта плательщику, стационара, «Без скидки» и промокода
 * новые строки ставок не получают (промокод на новые строки не расширяется — как и
 * сумма промокода без ставок).
 */
export function invoiceRateSource(db, inv, group) {
  if (!inv || inv.payer_id || inv.admission_id) return null;
  const s = inv.discount_source;
  if (!(s == null || s === '' || s === 'group' || s === 'manual')) return null;
  return groupRateSource(group);
}

/**
 * Поставить строкам счёта их ставку (новая строка кассы, заменённая услуга).
 * Строки берутся из itemIds; строка со своей скидкой (пакет) не трогается.
 */
export function rateInvoiceItems(db, src, itemIds) {
  if (!src || !Array.isArray(itemIds) || !itemIds.length) return;
  const svcOf = makeLineService(db);
  const getItem = db.prepare('SELECT * FROM invoice_items WHERE id = ?');
  const getVs = db.prepare('SELECT service_id, consultation_type_id, clinic_item_id FROM visit_services WHERE invoice_item_id = ?');
  const upd = db.prepare('UPDATE invoice_items SET discount_amount = ?, discount_rate = ?, discount_doctor_share = ? WHERE id = ?');
  for (const id of itemIds) {
    const it = getItem.get(id);
    if (!it || Number(it.discount_amount) > 0) continue;
    const vs = getVs.get(id) || { service_id: it.service_id, consultation_type_id: null, clinic_item_id: null };
    const pct = lineDiscountPct(src, svcOf(vs));
    const total = Math.max(0, Number(it.total) || 0);
    upd.run(round2(total * pct / 100), pct, src.reduces, id);
  }
}

/**
 * База пола группы при правке счёта: сумма строк без своей скидки, БЕЗ строк по
 * ставкам (discount_rate задан — их скидка уже своя, у 0 % — нулевая). У счёта без
 * ставок — ровно прежняя база (invoiceRestBase).
 */
export function invoiceFloorBase(db, invoiceId) {
  return round2(db.prepare(`SELECT COALESCE(SUM(CASE WHEN COALESCE(discount_amount, 0) > 0 OR discount_rate IS NOT NULL THEN 0 ELSE total END), 0) b
                              FROM invoice_items WHERE invoice_id = ?`).get(invoiceId).b);
}
