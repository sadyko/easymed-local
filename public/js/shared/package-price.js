// SERVICES_PACKAGES_V1 — ПАКЕТ УСЛУГ: ЦЕНА, РАСКЛАДКА ПО УСЛУГАМ, ПРОВЕРКИ,
// ПОКАЗ (шаг 6 API клиники; спецификация «Правила, без которых не строим» →
// «Пакеты»; макет screen-packages.js и data.js packageCalc).
//
// ОДНА ФУНКЦИЯ РАСКЛАДКИ (packageCalc) на всё: окно «Пакет услуг» в
// «Настройках», окна выбора пакета (смета, быстрая регистрация, мастер визита),
// запись строки (server/services/domain/package-lines.js ставит строке цену в
// пакете), счёт и оплату врача (они берут цену, записанную на строке), а в
// шаге 8 — API. Второй копии правила нет нигде.
//
// ПРАВИЛА:
//   • скидку задают процентом, суммой на весь пакет или итоговой ценой пакета;
//   • посчитанная цена пакета (процент, сумма) округляется до 1 000 сум (макет
//     «округляем до 1 000 сум»); вписанную клиникой цену пакета не трогаем;
//     цена пакета — от 0 до суммы цен услуг (скидка не бывает отрицательной);
//   • цена каждой услуги в пакете — её цена × (цена пакета ÷ сумма цен),
//     округлённая до 100 сум; остаток округления — на последнюю услугу, не ниже
//     нуля и не выше её цены; строки дают РОВНО цену пакета;
//   • у пакета со скидкой каждая платная услуга получает хоть 1 сум скидки,
//     если скидки на это хватает: строка с нулевой скидкой на кассе была бы
//     обычной строкой, и на неё легла бы скидка группы пациента (решение 1);
//   • пакет — строка service_templates с отметкой is_package = 1; без отметки
//     это шаблон сметы: просто список услуг.
//
// Чистый модуль — без DOM, базы и перевода. Сообщения — ключи словаря.
import { isOn } from './flags.js';
import { servicePublicState } from './service-public.js';

export const PACKAGE_MODES = Object.freeze(['percent', 'amount', 'price']);
/** Посчитанная цена пакета — до 1 000 сум (макет screen-packages.js:31). */
export const PACKAGE_PRICE_STEP = 1000;
/** Цена услуги в пакете — до 100 сум (макет data.js:101). */
export const PACKAGE_LINE_STEP = 100;
/** Как название клиники (shared/clinic-profile.js NAME_MAX). */
export const PACKAGE_NAME_MAX = 120;

export const PACKAGE_MESSAGES = Object.freeze({
  nameRu:    'Введите название на русском.',
  nameLong:  'Название — не длиннее 120 знаков.',
  services:  'Добавьте в пакет хотя бы одну услугу.',
  serviceId: 'В пакете — услуги из прайса, каждая один раз.',
  mode:      'Скидку задают процентом, суммой или ценой пакета.',
  value:     'Скидка — число не меньше нуля.',
  percent:   'Процент скидки — от 0 до 100.',
  amount:    'Скидка больше суммы цен услуг пакета.',
  price:     'Цена пакета больше суммы цен услуг.',
  dates:     'Дата «по» раньше даты «с».',
  dateForm:  'Дата — в виде ГГГГ-ММ-ДД.',
  publishUz: 'Чтобы показывать пакет, нужно название на узбекском.',
  flag:      'Отметка записана неверно: нужно «да» или «нет».',
});

const r2 = (n) => Math.round(n * 100) / 100;
const money = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? r2(n) : 0; };
const text = (v) => String(v == null ? '' : v).trim();
const has = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
const ymd = (v) => { const s = text(v).slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : ''; };

/** Это пакет (а не шаблон сметы)? Флаг 0/1 из базы или булев с экрана. */
export function isPackageRow(row) {
  return !!row && (isOn(row.is_package) || row.is_package === true);
}

/** id услуг пакета по его порядку, без повторов (JSON-текст базы или массив). */
export function packageIds(row) {
  let raw = row && row.service_ids;
  if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { raw = []; } }
  const out = [];
  for (const v of Array.isArray(raw) ? raw : []) {
    const n = Number(v);
    if (Number.isInteger(n) && n > 0 && !out.includes(n)) out.push(n);
  }
  return out;
}

/**
 * Как задана скидка: { mode, value }. Строка до мигр. 244 (или выборка без
 * новых колонок) — процент из discount_percent.
 */
export function packageTerms(row) {
  const r = row || {};
  if (r.discount_mode == null && r.discount_value == null) {
    const p = Number(r.discount_percent);
    return { mode: 'percent', value: Number.isFinite(p) && p > 0 ? Math.min(p, 100) : 0 };
  }
  const mode = PACKAGE_MODES.includes(r.discount_mode) ? r.discount_mode : 'percent';
  const v = Number(r.discount_value);
  const value = Number.isFinite(v) && v > 0 ? v : 0;
  return { mode, value: mode === 'percent' ? Math.min(value, 100) : value };
}

/**
 * Услуги пакета для расчёта — по порядку пакета: только существующие и
 * действующие (active ≠ 0). services — строки services (id, price, active;
 * __base_price окна выбора сильнее price). { items: [{ service_id, price, service }], missing }.
 */
export function packageItems(row, services) {
  const byId = new Map((services || []).filter(Boolean).map((s) => [Number(s.id), s]));
  const items = [];
  let missing = 0;
  for (const id of packageIds(row)) {
    const s = byId.get(id);
    if (!s || (s.active != null && s.active !== true && !isOn(s.active))) { missing++; continue; }
    items.push({ service_id: id, price: money(s.__base_price != null ? s.__base_price : s.price), service: s });
  }
  return { items, missing };
}

const roundTo = (n, step) => Math.round(n / step) * step;
const floorTo = (n, step) => Math.floor(n / step) * step;

/**
 * РАСКЛАДКА. terms — { mode, value } (или строка пакета); items — [{ service_id, price }].
 * → { mode, value, full, price, off, pct, lines: [{ service_id, full, price }] }:
 *   full — сумма цен услуг («Без скидки»), price — цена пакета, off — скидка,
 *   pct — скидка в процентах до 0,1; lines — цена каждой услуги в пакете.
 */
export function packageCalc(terms, items) {
  const t = terms && PACKAGE_MODES.includes(terms.mode) ? { mode: terms.mode, value: terms.value } : packageTerms(terms);
  const list = (items || []).map((it) => ({ service_id: Number(it.service_id), full: money(it.price) }));
  const full = r2(list.reduce((s, x) => s + x.full, 0));
  const v = Math.max(0, Number(t.value) || 0);
  // Ревью C4 — скидка суммой больше суммы цен (прайс подешевел, услугу сняли с
  // учёта): пакет без скидки, как у вписанной цены больше суммы, а не бесплатный.
  // Ровно сумма цен — бесплатный пакет: так его задали (packageProblem принимает).
  const raw = Math.min(full, Math.max(0, t.mode === 'percent' ? full * (1 - Math.min(v, 100) / 100)
    : t.mode === 'amount' ? (v > full ? full : full - v) : v));
  let price;
  if (raw >= full) price = full;
  else if (t.mode === 'price') price = Math.round(raw);            // вписанная цена — как есть, до сума
  else {
    price = roundTo(raw, PACKAGE_PRICE_STEP);
    if (price === 0 && raw > 0) price = Math.round(raw);           // дешёвый пакет: 0 не выдумываем
  }
  price = Math.min(full, Math.max(0, price));
  const off = r2(full - price);
  const pct = full > 0 ? Math.round((off / full) * 1000) / 10 : 0;
  const lines = list.map((x) => ({ service_id: x.service_id, full: x.full, price: x.full }));
  if (!(off > 0) || !lines.length) return { mode: t.mode, value: t.value, full, price: full, off: 0, pct: 0, lines };

  const k = price / full;
  const paid = lines.filter((x) => x.full > 0).length;
  const minOff = off >= paid ? 1 : 0;                               // хоть 1 сум скидки каждой платной, если хватает
  const cap = (x) => (x.full > 0 ? Math.max(0, r2(x.full - minOff)) : 0);
  const n = lines.length;
  let sum = 0;
  for (let i = 0; i < n - 1; i++) {
    const x = lines[i];
    const target = x.full * k;
    let p = roundTo(target, PACKAGE_LINE_STEP);
    if (p > cap(x)) { p = floorTo(target, PACKAGE_LINE_STEP); if (p > cap(x)) p = cap(x); }
    x.price = Math.max(0, p);
    sum = r2(sum + x.price);
  }
  let last = r2(price - sum);
  const lastCap = cap(lines[n - 1]);
  if (last > lastCap) {                                             // остаток больше цены последней — назад по строкам
    let excess = r2(last - lastCap);
    last = lastCap;
    for (let i = n - 2; i >= 0 && excess > 0; i--) {
      const add = Math.min(r2(cap(lines[i]) - lines[i].price), excess);
      if (add > 0) { lines[i].price = r2(lines[i].price + add); excess = r2(excess - add); }
    }
  } else if (last < 0) {                                            // округление вверх съело больше цены пакета
    let deficit = r2(-last);
    last = 0;
    for (let i = n - 2; i >= 0 && deficit > 0; i--) {
      const take = Math.min(lines[i].price, deficit);
      lines[i].price = r2(lines[i].price - take);
      deficit = r2(deficit - take);
    }
  }
  lines[n - 1].price = last;
  return { mode: t.mode, value: t.value, full, price, off, pct, lines };
}

/** «Как задать скидку» переключили — значение в новом виде, при котором цена пакета та же (макет screen-packages.js:74-80). */
export function packageValueFor(calc, mode) {
  if (!calc) return 0;
  if (mode === 'percent') return calc.pct;
  if (mode === 'amount') return calc.off;
  return calc.price;
}

/** Цена услуги в пакете: { service_id, full, price } или null — услуги в раскладке нет. */
export function packageLineOf(calc, serviceId) {
  return (calc && Array.isArray(calc.lines) && calc.lines.find((l) => Number(l.service_id) === Number(serviceId))) || null;
}

/**
 * Деньги строки визита из пакета — по ценам, записанным на строке при записи
 * (visit_services.package_full / package_price — за единицу):
 * { gross, discount, net }; null — строка не из пакета.
 */
export function packageLineMoney(row) {
  if (!row || row.package_price == null || row.package_full == null) return null;
  const q = Number(row.quantity != null ? row.quantity : row.qty);
  const qty = Number.isFinite(q) && q > 0 ? q : 1;
  const full = money(row.package_full);
  const price = Math.min(money(row.package_price), full);
  const gross = r2(full * qty);
  const net = r2(price * qty);
  return { gross, discount: r2(gross - net), net };
}

/** 'active' | 'expired' | 'upcoming' — день против срока пакета (границы включительно, пустая — без ограничения). */
export function packageDayState(row, day) {
  const from = ymd(row && row.valid_from);
  const until = ymd(row && row.valid_until);
  const d = ymd(day);
  if (from && d && d < from) return 'upcoming';
  if (until && d && d > until) return 'expired';
  return 'active';
}

/**
 * Пакет перед записью: { field, message } | null. Проверяется присланное
 * (правка — только тронутые поля); insert — новая строка (название и услуги
 * обязательны). full — сумма цен услуг пакета (для «суммы» и «цены»); null —
 * не проверять их против суммы. merged — строка, какой она ляжет в базу (для
 * «показывать — нужно название на узбекском»).
 */
export function packageProblem(values, { full = null, insert = false, merged = null } = {}) {
  const v = values || {};
  const m = merged || v;
  if (insert || has(v, 'name')) {
    if (!text(v.name)) return { field: 'name', message: PACKAGE_MESSAGES.nameRu };
  }
  for (const k of ['name', 'name_uz', 'name_en']) {
    if (has(v, k) && text(v[k]).length > PACKAGE_NAME_MAX) return { field: k, message: PACKAGE_MESSAGES.nameLong };
  }
  if (insert || has(v, 'service_ids')) {
    let raw = v.service_ids;
    if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { raw = null; } }
    if (!Array.isArray(raw) || !raw.length) return { field: 'service_ids', message: PACKAGE_MESSAGES.services };
    const ids = raw.map(Number);
    if (!ids.every((n) => Number.isInteger(n) && n > 0) || new Set(ids).size !== ids.length) return { field: 'service_ids', message: PACKAGE_MESSAGES.serviceId };
  }
  for (const k of ['is_package', 'show_public']) {
    if (has(v, k) && ![0, 1, true, false, '0', '1'].includes(v[k])) return { field: k, message: PACKAGE_MESSAGES.flag };
  }
  if (has(v, 'discount_mode') && !PACKAGE_MODES.includes(v.discount_mode)) return { field: 'discount_mode', message: PACKAGE_MESSAGES.mode };
  if (has(v, 'discount_value')) {
    const n = Number(v.discount_value);
    if (v.discount_value === null || v.discount_value === '' || !Number.isFinite(n) || n < 0) return { field: 'discount_value', message: PACKAGE_MESSAGES.value };
    const mode = PACKAGE_MODES.includes(m.discount_mode) ? m.discount_mode : 'percent';
    if (mode === 'percent' && n > 100) return { field: 'discount_value', message: PACKAGE_MESSAGES.percent };
    if (full != null && mode === 'amount' && n > full) return { field: 'discount_value', message: PACKAGE_MESSAGES.amount };
    if (full != null && mode === 'price' && n > full) return { field: 'discount_value', message: PACKAGE_MESSAGES.price };
  }
  for (const k of ['valid_from', 'valid_until']) {
    if (has(v, k) && v[k] != null && v[k] !== '' && !ymd(v[k])) return { field: k, message: PACKAGE_MESSAGES.dateForm };
  }
  const from = ymd(m.valid_from);
  const until = ymd(m.valid_until);
  if ((has(v, 'valid_from') || has(v, 'valid_until')) && from && until && until < from) return { field: 'valid_until', message: PACKAGE_MESSAGES.dates };
  if (isOn(m.show_public) || m.show_public === true) {
    if ((has(v, 'show_public') || has(v, 'name_uz')) && !text(m.name_uz)) return { field: 'name_uz', message: PACKAGE_MESSAGES.publishUz };
  }
  return null;
}

/**
 * Что с показом пакета на сайте и у партнёров:
 *   'not_package' — шаблон сметы; 'retired' — снят с учёта (active = 0);
 *   'off' — показ выключен; 'expired' / 'upcoming' — день вне срока;
 *   'no_uz' — нет названия на русском или узбекском; 'empty' — ни одной
 *   действующей услуги; 'service_hidden' — в пакете есть услуга, которую сайт и
 *   партнёры не видят (В10: пакет не открывает скрытую услугу);
 *   'terms_invalid' — скидка суммой больше суммы цен действующих услуг (прайс
 *   подешевел или услугу сняли с учёта после сохранения): раскладка даёт пакет
 *   без скидки, клинике нужно поправить условия (ревью C4); 'shown'.
 * services — строки services (id, name, name_uz, active, online_booking, price).
 */
export function packagePublicState(row, services, day) {
  if (!isPackageRow(row)) return 'not_package';
  if (row.active != null && row.active !== true && !isOn(row.active)) return 'retired';
  if (!(isOn(row.show_public) || row.show_public === true)) return 'off';
  const ds = packageDayState(row, day);
  if (ds !== 'active') return ds;
  if (!text(row.name) || !text(row.name_uz)) return 'no_uz';
  const byId = new Map((services || []).filter(Boolean).map((s) => [Number(s.id), s]));
  const ids = packageIds(row);
  const live = ids.map((id) => byId.get(id)).filter((s) => s && servicePublicState(s) !== 'inactive');
  if (!live.length) return 'empty';
  if (live.some((s) => servicePublicState(s) !== 'shown')) return 'service_hidden';
  const terms = packageTerms(row);
  if (terms.mode === 'amount' && terms.value > r2(packageItems(row, services).items.reduce((sum, x) => sum + x.price, 0))) return 'terms_invalid';
  return 'shown';
}

/** Услуги пакета, которые сайт и партнёры не видят (их названия — для подсказки у пакета). */
export function packageHiddenServices(row, services) {
  const byId = new Map((services || []).filter(Boolean).map((s) => [Number(s.id), s]));
  return packageIds(row).map((id) => byId.get(id))
    .filter((s) => s && servicePublicState(s) !== 'inactive' && servicePublicState(s) !== 'shown');
}
