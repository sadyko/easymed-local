// REPORTS_TAX_PAY_V1 (владелец, 2026-11-07) — СПОСОБ ОПЛАТЫ И НДС В ОТЧЁТАХ.
//
// «Во всех окнах отчётов: цена без НДС / НДС / цена с НДС; ТИП ОПЛАТЫ
// (наличные, карта, перевод… — смешанная оплата делится по типам); фильтры
// в окне отчёта ДО выгрузки в Excel».
//
// ЧАСТЬ ОПЛАТЫ. Счёт может закрываться несколькими платежами разными способами
// (record_payment_split — часть наличными, часть картой). Строка отчёта,
// которая стоит на счёте (строка счёта или сам счёт), делится на ЧАСТИ — по
// одной на способ, — и каждая часть несёт свою долю денег строки:
//
//     доля способа = (платежи этим способом − возвраты этим способом) / итог счёта
//     «Не оплачено» = то, что от итога счёта ещё не заплачено.
//
// Поэтому сумма частей по способу «Карта» во всех отчётах — ровно то, что
// касса приняла картой по этим счетам, тем же правилом, что итог смены
// (cashier.js paymentTotals: SUM(amount) по способу, возвраты — минусом).
// Кошелёк и подарочная карта — свои способы, как отдельные строки смены.
//
// ФИЛЬТР. Способ оплаты и/или кассир оставляют одну часть на способ из
// подходящих платежей; «Не оплачено» — только остаток (кассира у него нет).
// Бесплатный счёт (итог 0) — одна часть без способа: платить было нечего, и
// фильтр по оплате его убирает.
//
// НДС. Правило владельца 2026-09-29 (SUPPLIERS_VAT_V1, reports.js
// ITEM_TAX_SQL): цены в программе — С НДС, налог внутри цены, сумма после
// скидки × ставка / 100 («100 = 12 % + 88»). Ставка — у услуги
// (services.tax_rate, «Налог %» в карточке услуги; по умолчанию 0) и у товара
// (НДС товара, записанный в строке при выдаче). Отдельной ставки клиники нет и
// не вводится — она уже есть у каждой услуги. Здесь — только три ячейки из
// уже посчитанных «с НДС» и «НДС»: без НДС = с НДС − НДС, каждое до копеек,
// так что по строке и в итоге три колонки сходятся.
//
// Модуль чистый (без базы): его читают rpc/reports.js и rpc/cashier-report.js.
import { METHOD_RU } from '../../../public/js/shared/payment-methods.js';

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Порядок способов в отчёте — словарь кассы, «Не оплачено» последним.
export const PAY_METHOD_ORDER = Object.keys(METHOD_RU);
export const UNPAID = 'unpaid';
// Оплачено, но способ не записан (оплата есть в счёте, строк платежей нет).
export const UNKNOWN = 'unknown';
// Значения фильтра «Способ оплаты» (пусто — все).
export const PAY_FILTER_VALUES = [...PAY_METHOD_ORDER, UNPAID];

export function payMethodArgOk(v) {
  return PAY_FILTER_VALUES.includes(String(v));
}

// Подпись части: способ словами кассы, остаток — «Не оплачено», бесплатная
// строка — прочерк. Неизвестный код показывается как есть: это настоящий
// платёж, и прятать его нельзя.
export function methodLabel(method) {
  if (method == null || method === '') return '—';
  if (method === UNPAID) return 'Не оплачено';
  if (method === UNKNOWN) return 'Способ не указан';
  return METHOD_RU[method] || String(method);
}

/**
 * Части оплаты одного счёта.
 * @param {number} total    итог счёта (то, что пациент должен заплатить)
 * @param {Array<{method:string, amount:number, cashier_id:number|null}>} pays — платежи счёта (возвраты — минусом)
 * @param {{method?:string|null, cashierId?:number|null}} filter
 * @returns {Array<{method:string|null, share:number, cashier_ids:number[]}>}
 */
export function payParts(total, pays, filter = {}, paidAmount = null) {
  const T = Number(total) || 0;
  const fm = filter && filter.method ? String(filter.method) : null;
  const fc = filter && filter.cashierId != null ? Number(filter.cashierId) : null;
  const filtered = fm != null || fc != null;
  if (T <= 0) return filtered ? [] : [{ method: null, share: 1, cashier_ids: [] }];

  const list = Array.isArray(pays) ? pays : [];
  let paidAll = 0;
  for (const p of list) paidAll += Number(p.amount) || 0;
  // ОПЛАЧЕНО — по счёту (paidAmount = invoices.paid_amount), если его дали: у
  // счетов, перенесённых из прежней программы, сумма оплаты есть, а строк
  // платежей нет — такой счёт не должен читаться долгом. Оплаченное, чей
  // способ не записан, — частью «Способ не указан» (UNKNOWN). Без
  // paidAmount — сумма платежей. Переплата (оплачено больше итога) — части
  // делятся в той же доле, и их сумма остаётся равной строке, а не больше неё.
  const paidRaw = paidAmount != null && Number.isFinite(Number(paidAmount)) ? Number(paidAmount) : paidAll;
  const paid = Math.min(Math.max(paidRaw, 0), T);
  const scale = paidAll > paid && paidAll > 0 ? paid / paidAll : 1;
  const unknownShare = paidAll < paid ? (paid - Math.max(paidAll, 0)) / T : 0;
  const unpaidShare = paid < T ? (T - paid) / T : 0;

  if (fm === UNPAID) {
    return fc == null && unpaidShare > 1e-9 ? [{ method: UNPAID, share: unpaidShare, cashier_ids: [] }] : [];
  }
  const by = new Map();
  for (const p of list) {
    if (fm != null && String(p.method) !== fm) continue;
    if (fc != null && Number(p.cashier_id) !== fc) continue;
    const key = String(p.method || '');
    const cur = by.get(key) || { sum: 0, cashiers: new Set() };
    cur.sum += Number(p.amount) || 0;
    if (p.cashier_id != null) cur.cashiers.add(Number(p.cashier_id));
    by.set(key, cur);
  }
  const rank = (m) => { const i = PAY_METHOD_ORDER.indexOf(m); return i < 0 ? PAY_METHOD_ORDER.length : i; };
  const parts = [...by.entries()]
    .filter(([, v]) => Math.abs(v.sum) > 0.004)
    .sort((a, b) => rank(a[0]) - rank(b[0]))
    .map(([m, v]) => ({ method: m, share: (v.sum * scale) / T, cashier_ids: [...v.cashiers].sort((x, y) => x - y) }));
  if (!filtered && unknownShare > 1e-9) parts.push({ method: UNKNOWN, share: unknownShare, cashier_ids: [] });
  if (!filtered && unpaidShare > 1e-9) parts.push({ method: UNPAID, share: unpaidShare, cashier_ids: [] });
  // Округление долей до 12 знаков: 0,6 должно читаться как 0,6, а не
  // 0,6000000000000001 — доля печатается в тестах и в разрезах.
  return parts.map((p) => ({ ...p, share: Math.round(p.share * 1e12) / 1e12 }));
}

/**
 * Деньги строки по долям: каждая часть до копеек, последняя забирает остаток
 * округления — сумма частей ровно равна round2(value × Σдолей).
 */
export function splitMoney(value, shares) {
  const v = Number(value) || 0;
  const total = round2(v * shares.reduce((n, s) => n + s, 0));
  const out = shares.map((s) => round2(v * s));
  if (out.length) {
    const head = out.slice(0, -1).reduce((n, x) => n + x, 0);
    out[out.length - 1] = round2(total - head);
  }
  return out;
}

/** Три ячейки НДС: [без НДС, НДС, с НДС]. */
export function vatCells(gross, tax) {
  const g = round2(gross);
  const t = round2(tax);
  return [round2(g - t), t, g];
}

export const VAT_COLUMNS = ['Сумма без НДС', 'НДС', 'Сумма с НДС'];
export const PAY_COLUMN = 'Способ оплаты';
export const CASHIER_COLUMN = 'Кассир';
