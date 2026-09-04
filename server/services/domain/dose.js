// MED_DOSE_QTY_V1 — из «дозы» врача в «сколько списать со склада».
//
// ЧИСТЫЙ МОДУЛЬ, как domain/mar-schedule.js и domain/day.js: ни базы, ни
// запросов. Причина та же — это ПРАВИЛО, и спрашивать его будут из двух мест:
// сервер (Задача 6: отметка «дала» списывает препарат) и экран (показать
// заранее «спишется 1 шт», чтобы медсестра увидела это ДО нажатия). Разъедься
// две копии — и в клинике списывалось бы не то, что обещал экран.
//
// ─── ГЛАВНОЕ ПРАВИЛО: НЕ УГАДЫВАТЬ ──────────────────────────────────────────
//
// `treatment_orders.dose` — свободный текст, его пишет врач: «1 г», «500 мг»,
// «2 таб.», «0,5 мл», «по схеме». Склад же считает штуки, миллилитры и граммы
// (`products.unit`). Между этими двумя мирами нет надёжного моста: «1 г»
// цефтриаксона — это один флакон, если флакон по грамму, и два, если по
// полграмма. Ни одна формула этого не знает.
//
// Поэтому здесь три источника количества, строго по старшинству:
//
//   1. `treatment_orders.stock_qty` — врач (или экран) сказал ЯВНО, сколько
//      единиц склада уходит на одну дозу. Это единственный по-настоящему
//      надёжный ответ, и он всегда главнее текста дозы.
//   2. Доза БЕЗ единицы («2») — это счёт единиц склада: две штуки, два флакона.
//   3. Доза С единицей, приводимой к единице склада («500 мг» при складе в
//      «г» → 0.5). Приведение разрешено ТОЛЬКО внутри одной размерности.
//
// Всё остальное — отказ, а не догадка: «1 г» при складе в «шт» не даёт
// количества, и правильный ответ здесь — «не списано, разберитесь», а не
// списанная наугад штука. Такие отметки считаются (см. stock_status в
// миграции 096), чтобы их было видно человеку, а не чтобы они утонули.

/** Текст отказа — один на весь продукт: сервер пишет, экран показывает. */
export const UNKNOWN_QTY_MESSAGE = 'не списано: не удалось определить количество';

// Ни одна разовая доза в клинике столько не весит. Верхняя граница та же, что
// у inventory.js (MAX_QTY): количество отсюда уходит прямо в списание.
const MAX_QTY = 1_000_000;

// ─── Единицы ────────────────────────────────────────────────────────────────
//
// Канон + размерность. Размерность («что это вообще за величина») несущая:
// приводить миллиграммы к граммам можно, миллилитры к штукам — нельзя.
//
// Все СЧЁТНЫЕ формы (таблетка, капсула, ампула, флакон) сведены к 'pcs'
// намеренно: на складе они и лежат штуками, и «2 таб.» при складе в «шт» — это
// ровно две штуки, а не догадка. А вот «ЕД»/«МЕ» — НЕ штуки: это единицы
// действия (инсулин, гепарин), и во флаконе их сотни. Их отдельная размерность
// и есть защита от списания четырёх флаконов вместо четырёх единиц инсулина.
const UNITS = Object.freeze({
  // счётные
  pcs:  { dim: 'count',  factor: 1 },
  // масса, база — грамм
  kg:   { dim: 'mass',   factor: 1000 },
  g:    { dim: 'mass',   factor: 1 },
  mg:   { dim: 'mass',   factor: 0.001 },
  mcg:  { dim: 'mass',   factor: 0.000001 },
  // объём, база — миллилитр
  l:    { dim: 'volume', factor: 1000 },
  ml:   { dim: 'volume', factor: 1 },
  // единицы действия
  iu:   { dim: 'iu',     factor: 1 },
});

const ALIASES = Object.freeze({
  // штуки и всё, что в аптеке считают поштучно
  'pcs': 'pcs', 'pc': 'pcs', 'шт': 'pcs', 'шт.': 'pcs', 'штук': 'pcs', 'штука': 'pcs', 'штуки': 'pcs',
  'таб': 'pcs', 'таб.': 'pcs', 'табл': 'pcs', 'табл.': 'pcs', 'таблетка': 'pcs', 'таблетки': 'pcs', 'tab': 'pcs',
  'капс': 'pcs', 'капс.': 'pcs', 'капсула': 'pcs', 'капсулы': 'pcs', 'caps': 'pcs',
  'амп': 'pcs', 'амп.': 'pcs', 'ампула': 'pcs', 'ампулы': 'pcs', 'amp': 'pcs',
  'фл': 'pcs', 'фл.': 'pcs', 'флакон': 'pcs', 'флакона': 'pcs', 'vial': 'pcs',
  'уп': 'pcs', 'уп.': 'pcs', 'упаковка': 'pcs',
  'доза': 'pcs', 'дозы': 'pcs', 'доз': 'pcs',
  // масса
  'кг': 'kg', 'kg': 'kg',
  'г': 'g', 'г.': 'g', 'гр': 'g', 'гр.': 'g', 'грамм': 'g', 'g': 'g',
  'мг': 'mg', 'мг.': 'mg', 'mg': 'mg',
  'мкг': 'mcg', 'мкг.': 'mcg', 'mcg': 'mcg', 'µg': 'mcg', 'μg': 'mcg',
  // объём
  'л': 'l', 'л.': 'l', 'литр': 'l', 'l': 'l',
  'мл': 'ml', 'мл.': 'ml', 'ml': 'ml',
  // единицы действия — НЕ штуки
  'ед': 'iu', 'ед.': 'iu', 'ме': 'iu', 'ме.': 'iu', 'iu': 'iu', 'ui': 'iu',
});

/** Единица в каноне ('шт.' → 'pcs') или null, если она нам незнакома. */
export function normalizeUnit(u) {
  if (u === null || u === undefined) return null;
  const key = String(u).trim().toLowerCase().replace(/\s+/g, '');
  if (!key) return null;
  return ALIASES[key] || null;
}

// Доза целиком: «число [единица]» и НИЧЕГО больше. Строгость намеренная:
// «1 г × 2» и «по схеме» обязаны провалиться в отказ, а не отдать 1 — из
// половины строки количество не выводят.
const DOSE_RE = /^\s*(\d+(?:[.,]\d+)?)\s*([^\s\d]*)\s*$/;

/** '500 мг' → { value: 500, unit: 'mg' }; '2' → { value: 2, unit: null }; иначе null. */
export function parseDose(text) {
  if (text === null || text === undefined) return null;
  const m = DOSE_RE.exec(String(text));
  if (!m) return null;
  const value = Number(m[1].replace(',', '.'));
  if (!Number.isFinite(value) || value <= 0) return null;
  const raw = m[2] || '';
  if (!raw) return { value, unit: null, raw: '' };
  const unit = normalizeUnit(raw);
  if (!unit) return null;             // единица есть, но нам неизвестна
  return { value, unit, raw };
}

/** Округление количества: шесть знаков — 1 мкг при складе в граммах ещё живёт. */
function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}

/**
 * Сколько единиц склада уходит на одну дозу.
 *
 * @param {{dose?: string, stock_qty?: number|null, product_unit?: string|null}} a
 * @returns {{ok: true, quantity: number, basis: 'order'|'count'|'unit'}
 *          |{ok: false, reason: 'no_dose'|'unit'|'range', message: string}}
 */
export function doseQuantity(a) {
  const src = a || {};

  // 1. Явное количество из назначения — главнее любого текста.
  const explicit = Number(src.stock_qty);
  if (src.stock_qty !== null && src.stock_qty !== undefined && src.stock_qty !== ''
      && Number.isFinite(explicit) && explicit > 0) {
    if (explicit > MAX_QTY) {
      return { ok: false, reason: 'range', message: `${UNKNOWN_QTY_MESSAGE} (количество за пределами разумного)` };
    }
    return { ok: true, quantity: round6(explicit), basis: 'order' };
  }

  const doseText = src.dose === null || src.dose === undefined ? '' : String(src.dose).trim();
  const parsed = parseDose(doseText);
  if (!parsed) {
    return {
      ok: false,
      reason: 'no_dose',
      message: `${UNKNOWN_QTY_MESSAGE}${doseText ? ` (доза «${doseText}»)` : ' (доза не указана)'}`,
    };
  }

  const prodUnit = normalizeUnit(src.product_unit);

  // 2. Доза без единицы — это счёт единиц склада, какими бы они ни были.
  if (parsed.unit === null) {
    if (parsed.value > MAX_QTY) {
      return { ok: false, reason: 'range', message: `${UNKNOWN_QTY_MESSAGE} (количество за пределами разумного)` };
    }
    return { ok: true, quantity: round6(parsed.value), basis: 'count' };
  }

  // 3. Доза с единицей: приводим — но только внутри одной размерности.
  const unitLabel = src.product_unit ? `«${src.product_unit}»` : 'не указана';
  if (!prodUnit) {
    return { ok: false, reason: 'unit', message: `${UNKNOWN_QTY_MESSAGE} (доза «${doseText}», единица склада ${unitLabel})` };
  }
  const from = UNITS[parsed.unit];
  const to = UNITS[prodUnit];
  if (!from || !to || from.dim !== to.dim) {
    return { ok: false, reason: 'unit', message: `${UNKNOWN_QTY_MESSAGE} (доза «${doseText}», склад в ${unitLabel})` };
  }

  const quantity = round6(parsed.value * from.factor / to.factor);
  if (!(Number.isFinite(quantity) && quantity > 0)) {
    return { ok: false, reason: 'range', message: `${UNKNOWN_QTY_MESSAGE} (доза «${doseText}» слишком мала для единицы ${unitLabel})` };
  }
  if (quantity > MAX_QTY) {
    return { ok: false, reason: 'range', message: `${UNKNOWN_QTY_MESSAGE} (количество за пределами разумного)` };
  }
  return { ok: true, quantity, basis: 'unit' };
}
