// REFERRAL_CATEGORY_RATES_V1 — одна таблица истинности для реферального
// вознаграждения. До неё ставку выбирали сравнением строк прямо в отчёте
// (правило с именем источника, потом правило с именем категории), и понять,
// откуда взялась цифра, можно было только сверив три экрана глазами.
//
//   режим 'category':  ставка группы у КАТЕГОРИИ → стандартный процент       → 0
//   режим 'own':       ставка группы у ИСТОЧНИКА → свой процент источника    → 0
//
// В режиме 'own' категория не читается НИ ПРИ КАКИХ условиях — решение
// владельца 2026-09-08: карточка источника должна объяснять его выплату
// целиком, без второго экрана. Источник без категории в режиме 'category'
// получает 0 — это видно в карточке и чинится выбором категории.

// Разбор JSON-ставок. Читатель намеренно терпимый: колонку пишет только admin,
// но испорченная строка не должна ронять отчёт целиком — она должна означать
// «ставок нет», и тогда сработает откат на процент уровнем выше.
export function parseRates(raw) {
  if (Array.isArray(raw)) return raw;              // уже разобрано маршрутом /api/db
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

// Конечное неотрицательное число либо null. Отрицательная ставка — это не
// «клиника удерживает с партнёра», такого случая нет; это испорченные данные.
//
// Пустота отсеивается ДО Number(), и это не придирка: Number(null) === 0 и
// Number('  ') === 0, поэтому запись без значения выглядела бы как честно
// выставленная ставка «0%» и перекрывала бы процент уровнем выше. Партнёр
// получал бы ноль там, где должен был получить стандартный процент.
function num(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' && v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// GROUPS_FIVE_REFERRAL_V1 (мигр. 153) — ставка задаётся на ГРУППУ услуги, то
// есть на одно из пяти фиксированных значений services.type (словарь
// владельца: «Группа» — пять, «Тип» и «Категория» клиника пишет сама). До этого
// ключом был services.type_id — строка справочника service_types, которую
// клиника ведёт сама, — и в таблице ставок стояло шесть «групп», одна из них
// («Лучевая диагностика») без единой услуги. Порядок — тот, в котором группы
// стоят в таблицах ставок.
export const REFERRAL_GROUPS = ['consultation', 'lab', 'imaging', 'procedure', 'other'];

// Группа услуги для ставки: одно из пяти значений или null. 'radiology' —
// устаревшее значение, читается как «Диагностика» (SERVICE_TYPES_FIVE_V1).
// null — у строки счёта нет услуги (свободный текст): групповой ставки у неё
// нет, действует процент уровнем выше — как было и при ключе type_id.
export function referralGroupOf(type) {
  const t = String(type ?? '').trim().toLowerCase();
  if (t === 'radiology') return 'imaging';
  return REFERRAL_GROUPS.includes(t) ? t : null;
}

// Ставка конкретной группы услуг внутри массива, либо null. Записи со старым
// ключом type_id не читаются: миграция 153 перевела их на группы, а угадывать
// по числу, какой из пяти групп оно было, — значит платить наугад.
function rateForGroup(rates, serviceGroup) {
  const want = referralGroupOf(serviceGroup);
  if (want === null) return null;
  for (const e of parseRates(rates)) {
    if (!e || referralGroupOf(e.group) !== want) continue;
    const value = num(e.value);
    if (value === null) continue;                  // запись без числа — как будто её нет
    const unit = e.unit === 'fix' ? 'fix' : 'pct';
    return { unit, value };
  }
  return null;
}

const pct = (v) => ({ unit: 'pct', value: num(v) ?? 0 });

// Ставка для одной позиции счёта. Всегда возвращает объект — «ставки нет»
// выражается нулём, чтобы у вызывающего не было ветки на null.
// serviceGroup — services.type позиции (одно из пяти; см. referralGroupOf).
export function resolveReferralRate({ source, category, serviceGroup }) {
  if (!source) return pct(0);
  if (source.reward_mode === 'own') {
    return rateForGroup(source.own_rates, serviceGroup) || pct(source.own_percent);
  }
  // Всё, что не 'own', — это 'category': незнакомый режим не должен молча
  // включать чужие ставки (см. отсутствие CHECK в мигр. 120).
  if (!category) return pct(0);
  return rateForGroup(category.rates, serviceGroup) || pct(category.standard_percent);
}

// Вознаграждение за одну позицию счёта.
//
// Процент берётся ПОСЛЕ скидки: партнёру причитается доля того, что клиника
// действительно взяла с пациента, а не прайсовой цены — так считал и прежний
// отчёт. Фиксированная сумма умножается на количество: «фиксированная сумма за
// услугу» — это за услугу, и три снимка по 60 000 дают 180 000.
export function rewardForLine(rate, { amount = 0, discount = 0, qty = 1 } = {}) {
  if (!rate) return 0;
  const value = num(rate.value) ?? 0;
  if (value === 0) return 0;
  // Количество, которого нет, — это ОДНА услуга, а не ноль услуг: так же его
  // читает расчёт доли врача (COALESCE(ii.quantity, 1) в ITEM_FEE_SQL). Иначе
  // строка счёта без количества молча не приносила бы партнёру ничего.
  if (rate.unit === 'fix') { const q = num(qty); return value * (q === null ? 1 : q); }
  const base = (Number(amount) || 0) - (Number(discount) || 0);
  return base * value / 100;
}
