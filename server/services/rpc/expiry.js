// EXPIRY_BALANCE_V1 (2026-09-23) — ОСТАТКИ ПАРТИЯМИ И ПРЕДУПРЕЖДЕНИЕ О ПРОСРОЧКЕ.
//
// Владелец (23.09), решение по четвёртому вопросу: «экран "Сроки годности"
// показывает остатки партиями, ближайший срок первым; выдача и списание
// просроченного предупреждают». Полную прослеживаемость партии до пациента
// владелец НЕ выбрал — и её здесь нет: в stock_holdings партии нет, в строках
// визита и госпитализации её нет, и никто ни у кого не спрашивает «из какой
// партии берёте».
//
// ПОЧЕМУ ОТДЕЛЬНЫЙ ФАЙЛ, А НЕ ПРОДОЛЖЕНИЕ stock-log.js. Журнал отвечает на
// вопрос «что произошло» — он перечисляет строки, которые кто-то записал.
// Здесь вопрос другой: «что ЛЕЖИТ на складе и до какого числа» — и ответа на
// него в базе нет вовсе, его приходится ВЫЧИСЛЯТЬ. Это не колонка журнала, это
// расчёт поверх него. И второе: этот расчёт зовут двери, к журналу отношения
// не имеющие, — выдача (rpc/procurement.js) и все списания на пациента
// (rpc/inventory.js, rpc/holdings.js). Журнал в них импортировать незачем.
//
// ГЛАВНОЕ, ЧТО НУЖНО ПОНИМАТЬ ПРО ЭТИ ЧИСЛА: ОСТАТОК ПАРТИИ — РАСЧЁТ, А НЕ
// ИЗМЕРЕНИЕ. Приход знает партию и срок (миграция 037). Расход не знает НИЧЕГО:
// ни issue_stock_lines, ни dispense_item, ни dispense_from_holding партию не
// пишут — и по решению владельца писать не будут. Значит количество «сколько
// осталось в партии A-117» в базе не хранится нигде, и добыть его можно только
// предположением.
//
// ПРЕДПОЛОЖЕНИЕ, КОТОРОЕ МЫ ДЕЛАЕМ, И ПОЧЕМУ ИМЕННО ОНО. Остаток склада
// (products.on_hand) раскладывается по приходам этого товара, начиная с
// САМОГО РАННЕГО СРОКА: сколько влезло в первую партию — её, что осталось —
// следующей, и так далее. Приходы без срока образуют отдельную корзину «без
// срока» и забирают только ТО, ЧТО ОСТАЛОСЬ после партий со сроком.
//
// Это то же самое, что сказать: «дальше со склада берут сначала то, что
// портится раньше» — правило FEFO, по которому кладовщик и должен работать.
// Обратное предположение (считать, что раннее УЖЕ израсходовано) выглядит
// логичным, но делает экран бесполезным: просроченная партия всегда
// показывала бы ноль, и предупредить о ней было бы не о чем — то есть ровно
// та задача, ради которой экран и написан, решалась бы «просрочки нет».
// Поэтому расчёт здесь ОСТОРОЖНЫЙ: пока остатка хватает, считаем, что старое
// ещё лежит на полке, и говорим об этом.
//
// И поэтому же экран обязан назвать это расчётом словами (одна приглушённая
// строка, views/inventory-expiry.js): выдать предположение за измерение —
// значит однажды поспорить с полкой и оказаться неправым.
//
// ИНВАРИАНТ, КОТОРЫЙ ДЕРЖИТ ВСЁ: СУММА ПО ПАРТИЯМ РАВНА ОСТАТКУ СКЛАДА.
// Всегда, при любых приходах, выдачах, корректировках и излишках
// инвентаризации. Разойдись она — экран начнёт спорить со «Складом», и правым
// окажется «Склад», а этот экран перестанут открывать. Корзина «без срока»
// существует в том числе ради этого: она добирает разницу, когда остаток
// больше, чем пришло известными партиями.
import { journalScope } from './stock-log.js';   // S2 — одно правило видимости на весь склад
import { today } from '../domain/day.js';

export class RpcError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

// Порог «истекает». 30 дней — месяц: столько нужно, чтобы успеть вернуть
// поставщику или перевести товар туда, где он разойдётся. Число названо и в
// ответе RPC (soon_days), чтобы экран не завёл своё, второе.
export const EXPIRING_SOON_DAYS = 30;

const MS_DAY = 86400000;
const round2 = (n) => Math.round(Number(n) * 100) / 100;
const isPosInt = (v) => Number.isInteger(v) && v > 0;

/** Дней от одной календарной даты до другой (обе 'ГГГГ-ММ-ДД'). */
function daysBetween(fromStr, toStr) {
  const a = Date.parse(fromStr + 'T00:00:00Z');
  const b = Date.parse(toStr + 'T00:00:00Z');
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / MS_DAY);
}

/** Состояние партии словами экрана: просрочено / истекает / в порядке / без срока. */
export function lotState(daysLeft) {
  if (daysLeft === null || daysLeft === undefined) return 'none';
  if (daysLeft < 0) return 'expired';
  if (daysLeft <= EXPIRING_SOON_DAYS) return 'soon';
  return 'ok';
}

/**
 * Приходы, сгруппированные в партии: одна строка на пару (партия, срок).
 * Один и тот же товар, принятый дважды по одной накладной-партии, — это одна
 * партия, а не две одинаковые строки на экране.
 */
function receiptGroups(db, productIds) {
  const where = ["m.kind = 'receive'", 'm.qty > 0'];
  const params = [];
  if (productIds && productIds.length) {
    where.push(`m.product_id IN (${productIds.map(() => '?').join(', ')})`);
    params.push(...productIds);
  }
  return db.prepare(`
    SELECT m.product_id,
           IFNULL(m.batch_no, '')    AS batch_no,
           IFNULL(m.expiry_date, '') AS expiry_date,
           SUM(m.qty)                AS received_qty,
           MIN(m.id)                 AS first_id
      FROM stock_movements m
     WHERE ${where.join(' AND ')}
     GROUP BY m.product_id, IFNULL(m.batch_no, ''), IFNULL(m.expiry_date, '')
     ORDER BY m.product_id, IFNULL(m.expiry_date, ''), IFNULL(m.batch_no, ''), MIN(m.id)`).all(...params);
}

/** Поставщик того прихода, которым партия открылась (если он вообще назван). */
function supplierOf(db, movementId) {
  const row = db.prepare(`
    SELECT s.id, s.name FROM stock_movements m
      LEFT JOIN suppliers s ON s.id = m.supplier_id
     WHERE m.id = ?`).get(movementId);
  return row && row.id ? { id: row.id, name: row.name || '' } : { id: null, name: '' };
}

/** Товары, у которых вообще есть что раскладывать: приход или остаток. */
function stockedProducts(db, productIds) {
  const where = [`(EXISTS (SELECT 1 FROM stock_movements m WHERE m.product_id = p.id AND m.kind = 'receive' AND m.qty > 0) OR p.on_hand <> 0)`];
  const params = [];
  if (productIds && productIds.length) {
    where.push(`p.id IN (${productIds.map(() => '?').join(', ')})`);
    params.push(...productIds);
  }
  return db.prepare(`
    SELECT p.id, p.name, IFNULL(p.code, '') AS code, p.unit, p.base_unit, p.on_hand
      FROM products p
     WHERE ${where.join(' AND ')}
     ORDER BY p.name, p.id`).all(...params);
}

/**
 * Разложить остаток ОДНОГО товара по его партиям.
 *
 * Правило целиком: партии со сроком идут по возрастанию срока и забирают
 * остаток в этом порядке, каждая — не больше, чем её пришло; всё, что не
 * досталось им, ложится в корзину «без срока». Корзина заводится и тогда,
 * когда приходов без срока не было вовсе, — иначе излишек инвентаризации
 * потерялся бы, и сумма перестала бы сходиться с остатком склада.
 *
 * @returns {{ product, lots: Array }} — ВСЕ партии, включая нулевые: отбор
 *   «остаток больше нуля» делает тот, кто показывает, а инвариант проверяется
 *   по полному списку.
 */
export function productLots(db, productId, todayStr = null) {
  const product = db.prepare('SELECT id, name, IFNULL(code, \'\') AS code, unit, base_unit, on_hand FROM products WHERE id = ?').get(productId);
  if (!product) return { product: null, lots: [] };
  const day = todayStr || today(db);
  return { product, lots: allocate(db, product, receiptGroups(db, [productId]), day) };
}

/** Тот же расклад, но сразу по многим товарам — одним запросом на всё. */
export function lotBalances(db, { productIds = null, todayStr = null } = {}) {
  const day = todayStr || today(db);
  const products = stockedProducts(db, productIds);
  const groups = new Map();
  for (const g of receiptGroups(db, productIds)) {
    if (!groups.has(g.product_id)) groups.set(g.product_id, []);
    groups.get(g.product_id).push(g);
  }
  const out = [];
  for (const p of products) out.push(...allocate(db, p, groups.get(p.id) || [], day));
  return out;
}

/** Ядро расчёта: остаток склада → партии, ближайший срок первым. */
function allocate(db, product, groups, day) {
  const dated = groups.filter((g) => g.expiry_date);
  const undated = groups.filter((g) => !g.expiry_date);
  const unit = product.base_unit || product.unit || '';

  let left = Math.max(round2(product.on_hand), 0);
  const lots = [];
  for (const g of dated) {
    const take = round2(Math.min(round2(g.received_qty), left));
    left = round2(left - take);
    const daysLeft = daysBetween(day, g.expiry_date);
    const sup = supplierOf(db, g.first_id);
    lots.push({
      product_id: product.id,
      product_name: product.name,
      product_code: product.code || '',
      unit,
      batch_no: g.batch_no,
      expiry_date: g.expiry_date,
      no_expiry: false,
      received_qty: round2(g.received_qty),
      remaining: take,
      days_left: daysLeft,
      state: lotState(daysLeft),
      supplier_id: sup.id,
      supplier_name: sup.name,
    });
  }
  // «Без срока» — одна корзина на товар, и заводится она, только если есть что
  // в неё положить или было чему прийти без срока.
  const undatedReceived = round2(undated.reduce((s, g) => s + Number(g.received_qty), 0));
  if (undated.length || left > 1e-9) {
    lots.push({
      product_id: product.id,
      product_name: product.name,
      product_code: product.code || '',
      unit,
      batch_no: '',
      expiry_date: '',
      no_expiry: true,
      received_qty: undatedReceived,
      remaining: left,
      days_left: null,
      state: 'none',
      supplier_id: null,
      supplier_name: '',
    });
  }
  return lots;
}

/**
 * stock_expiry_lots — остатки партиями, ближайший срок первым.
 *
 * args: { product_id?, q? (название или код товара), limit? }
 * → { scope, today, soon_days, count, truncated, products: [{id, name}],
 *     lots: [{ product_id, product_name, unit, batch_no, expiry_date, no_expiry,
 *              received_qty, remaining, days_left, state, supplier_id, supplier_name }] }
 *
 * ОБЛАСТЬ ВИДИМОСТИ — ТА ЖЕ, ЧТО У ЖУРНАЛА (S2), И НОВОГО ПРАВИЛА ЗДЕСЬ НЕТ.
 * journalScope отвечает «вся клиника / свой отдел / своё»; партии — это остаток
 * СКЛАДА, а у склада нет ни «своего», ни «отдельского»: половину склада никому
 * не показать. Поэтому список отдаётся только тем, кому журнал отдаёт всю
 * клинику (администратор, кладовщик, настроенный уровень «Закупки»), а
 * остальным приходит ПУСТОЙ список со своим именем области — не 403. Отказ на
 * справочном экране читается как поломка и кончается звонком; пустой список со
 * словами говорит правду. Предупреждения при выдаче и списании этой областью НЕ
 * ограничены: там правда нужна каждому, кто берёт товар в руки.
 */
export function expiryLots(db, args, user) {
  const a = args || {};
  const scope = journalScope(db, user);
  const day = today(db);
  if (scope.kind !== 'all') {
    return { scope: scope.kind, today: day, soon_days: EXPIRING_SOON_DAYS, count: 0, dated_total: 0, truncated: false, products: [], lots: [] };
  }

  let productId = null;
  if (a.product_id !== undefined && a.product_id !== null && a.product_id !== '') {
    productId = Number(a.product_id);
    if (!isPosInt(productId)) throw new RpcError('product_id: положительное целое.', 400);
  }
  const q = typeof a.q === 'string' ? a.q.trim().toLowerCase() : '';
  const limit = isPosInt(Number(a.limit)) ? Math.min(Number(a.limit), 2000) : 500;

  const all = lotBalances(db, { todayStr: day });
  // Список товаров для отбора считается ДО отбора: иначе фильтр схлопывается в
  // один пункт сразу после первого выбора, и вернуться к «всем» нечем.
  const seen = new Map();
  for (const l of all) if (!seen.has(l.product_id)) seen.set(l.product_id, { id: l.product_id, name: l.product_name });
  const products = [...seen.values()].sort((x, y) => String(x.name).localeCompare(String(y.name), 'ru'));

  let lots = all.filter((l) => l.remaining > 1e-9);
  // Сколько партий СО СРОКОМ есть вообще — считается ДО отбора. Пустой экран
  // должен различать «ничего не нашлось по фильтру» и «срок не заполняли ни
  // разу»: вторая новость просит объяснить, где этот срок вводится.
  const datedTotal = lots.filter((l) => !l.no_expiry).length;
  if (productId) lots = lots.filter((l) => l.product_id === productId);
  if (q) lots = lots.filter((l) => l.product_name.toLowerCase().includes(q) || l.product_code.toLowerCase().includes(q));

  // Ближайший срок первым; «без срока» — в конце: это не «ещё не скоро», это
  // «неизвестно», и смешивать их в одном порядке нельзя.
  lots.sort((x, y) => {
    if (x.no_expiry !== y.no_expiry) return x.no_expiry ? 1 : -1;
    if (x.expiry_date !== y.expiry_date) return x.expiry_date < y.expiry_date ? -1 : 1;
    if (x.product_name !== y.product_name) return String(x.product_name).localeCompare(String(y.product_name), 'ru');
    return String(x.batch_no).localeCompare(String(y.batch_no));
  });

  const truncated = lots.length > limit;
  return {
    scope: scope.kind, today: day, soon_days: EXPIRING_SOON_DAYS,
    truncated, count: Math.min(lots.length, limit), dated_total: datedTotal,
    products, lots: truncated ? lots.slice(0, limit) : lots,
  };
}

/**
 * Предупреждение о просроченной партии для ОДНОГО товара — или null.
 *
 * Партия берётся та, которую расклад отдаёт следующей: первая с ненулевым
 * остатком. Если у неё срока нет — говорить нечего; если срок ещё не вышел —
 * тоже. Слова строятся здесь, а не в экранах: дверей четыре, и четыре разных
 * формулировки одной и той же беды — это четыре разных беды для читающего.
 */
export function expiryWarning(db, productId, todayStr = null) {
  const { product, lots } = productLots(db, productId, todayStr);
  if (!product) return null;
  const next = lots.find((l) => l.remaining > 1e-9);
  if (!next || next.no_expiry || next.state !== 'expired') return null;
  const batch = next.batch_no ? `партия ${next.batch_no}` : 'партия без номера';
  return {
    product_id: product.id,
    product_name: product.name,
    batch_no: next.batch_no,
    expiry_date: next.expiry_date,
    days_left: next.days_left,
    remaining: next.remaining,
    unit: next.unit,
    message: `Просроченная партия: ${product.name} — ${batch}, срок ${next.expiry_date}. `
      + 'Операция проведена; использовать эту партию нельзя.',
  };
}

/** То же для нескольких товаров сразу; товар повторяется в ответе один раз. */
export function expiryWarnings(db, productIds, todayStr = null) {
  const day = todayStr || today(db);
  const out = [];
  const done = new Set();
  for (const raw of productIds || []) {
    const id = Number(raw);
    if (!isPosInt(id) || done.has(id)) continue;
    done.add(id);
    const w = expiryWarning(db, id, day);
    if (w) out.push(w);
  }
  return out;
}
