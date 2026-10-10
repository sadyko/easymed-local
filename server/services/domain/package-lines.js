// SERVICES_PACKAGES_V1 — ЦЕНА ПАКЕТА ФИКСИРУЕТСЯ НА СТРОКЕ ПРИ ЗАПИСИ
// (спецификация «Правила, без которых не строим» → «Пакеты»).
//
// Строку визита из пакета заводит только /api/db (routes/db.js — единственная
// дверь visit_services с package_id; RPC сервера пакет не ставят). Перед
// вставкой дверь зовёт stampPackageLines: строка получает цену услуги без
// скидки (package_full) и цену в пакете (package_price) — за единицу, по той
// же раскладке, что показали окно пакета и смета (shared/package-price.js
// packageCalc), по сегодняшнему прайсу. Дальше их берут счёт (billing.js),
// оплата врача (reports.js) и «Ждут счёта» (cashier.js) — сегодняшний процент
// пакета деньги строки больше не меняет.
//
// Раскладка — по всем действующим услугам пакета, а не по строкам этой
// записи: строки одного пакета, заведённые по одной, получают те же цены,
// что вместе (сумма — ровно цена пакета).
//
// Присланное браузером в package_full / package_price не учитывается никогда:
// цену ставит сервер.
import { isPackageRow, packageIds, packageTerms, packageItems, packageCalc, packageLineOf } from '../../../public/js/shared/package-price.js';

export const STAMP_COLUMNS = Object.freeze(['package_full', 'package_price']);

const r2 = (n) => Math.round(n * 100) / 100;

/** Раскладка пакета по сегодняшнему прайсу: { pkg, calc } или null (строки нет / это шаблон сметы). */
export function packageCalcFor(db, packageId, cache = new Map()) {
  const id = Number(packageId);
  if (!Number.isInteger(id) || id <= 0) return null;
  if (cache.has(id)) return cache.get(id);
  const pkg = db.prepare('SELECT * FROM service_templates WHERE id = ?').get(id) || null;
  let out = null;
  if (pkg && isPackageRow(pkg)) {
    const ids = packageIds(pkg);
    const services = ids.length
      ? db.prepare(`SELECT id, price, active FROM services WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids)
      : [];
    out = { pkg, calc: packageCalc(packageTerms(pkg), packageItems(pkg, services).items) };
  }
  cache.set(id, out);
  return out;
}

/**
 * Строки вставки visit_services (объекты тела /api/db) — на месте: строке из
 * пакета — package_full, package_price, unit_price = package_full, total =
 * package_full × количество; остальным — package_full / package_price = null.
 * Возвращает число строк, получивших цену пакета.
 */
export function stampPackageLines(db, rows) {
  const list = Array.isArray(rows) ? rows : [rows];
  const cache = new Map();
  let n = 0;
  for (const r of list) {
    if (!r || typeof r !== 'object') continue;
    r.package_full = null;
    r.package_price = null;
    if (r.package_id == null || r.package_id === '' || r.service_id == null) continue;
    const hit = packageCalcFor(db, r.package_id, cache);
    const line = hit && packageLineOf(hit.calc, r.service_id);
    if (!line) continue;
    const q = Number(r.quantity == null ? 1 : r.quantity);
    r.package_full = line.full;
    r.package_price = line.price;
    r.unit_price = line.full;
    r.total = r2(line.full * (Number.isFinite(q) && q > 0 ? q : 1));
    n++;
  }
  return n;
}

/**
 * Тело записи /api/db (routes/db.js — до выполнения; стенды тестов экранов,
 * которые повторяют эту дверь, — тоже): строкам visit_services из пакета —
 * цена пакета (stampPackageLines), правка, снимающая пакет, — без его цены.
 * meta — то, что разобрал compile() (иначе — table / op самого тела).
 * true — тело изменено: его нужно собрать заново тем же compile().
 */
export function stampWriteBody(db, body, meta = null) {
  const table = meta ? meta.table : body && body.table;
  const op = meta ? meta.op : body && body.op;
  if (!body || table !== 'visit_services') return false;
  if (op === 'insert' || op === 'upsert') {
    const rows = Array.isArray(body.values) ? body.values : (body.values ? [body.values] : []);
    const touches = (r) => r && typeof r === 'object' && (r.package_id != null
      || Object.prototype.hasOwnProperty.call(r, 'package_full') || Object.prototype.hasOwnProperty.call(r, 'package_price'));
    if (!rows.some(touches)) return false;
    stampPackageLines(db, rows);
    return true;
  }
  if (op === 'update') return clearStampOnUnpackage(body.values);
  return false;
}

/** Правка строки снимает пакет (package_id = NULL) — снимается и его цена. */
export function clearStampOnUnpackage(values) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) return false;
  if (!Object.prototype.hasOwnProperty.call(values, 'package_id') || values.package_id != null) return false;
  values.package_full = null;
  values.package_price = null;
  return true;
}
