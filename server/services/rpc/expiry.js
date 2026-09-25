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
// САМОГО ПОЗДНЕГО ПРИХОДА и назад по времени: сколько влезло в последний
// приход — его, что осталось — предыдущему, и так далее. Партия держит остаток
// РОВНО В ТОЙ МЕРЕ, В КАКОЙ ЕЁ НЕ ПОКРЫЛИ ПРИХОДЫ, СЛУЧИВШИЕСЯ ПОЗЖЕ.
//
// Это и есть FEFO, записанное правильной стороной. FEFO говорит: «первым
// расходуется ближайший срок» — то есть ранняя партия УХОДИТ ПЕРВОЙ, и на
// полке остаётся поздняя. Прежний расклад читал то же правило наоборот и клал
// остаток на самые ранние партии; выглядело это «осторожно», а на деле
// ПРИДУМЫВАЛО ПРОСРОЧКУ. Перчатки пришли партией со старым сроком, разошлись
// целиком, пришла новая коробка на 50 — и экран показывал 10 просроченных,
// которых на складе нет, а выдача и списание тревожили о них при каждой
// операции. Погасить эту тревогу было НЕЧЕМ: следующее списание расчёт снова
// «брал» у той же старой партии, и она не пустела никогда.
//
// Приходы без срока — такие же приходы: они образуют ОДНУ корзину «без срока»
// и встают в ту же очередь по времени своего последнего поступления. Особого
// права у партий со сроком нет: если безымянный приход случился позже, значит
// на полке лежит он, и просроченной партии там уже нет.
//
// Экран обязан назвать это расчётом словами (одна приглушённая строка,
// views/inventory-expiry.js): выдать предположение за измерение — значит
// однажды поспорить с полкой и оказаться неправым.
//
// ИНВАРИАНТ, КОТОРЫЙ ДЕРЖИТ ВСЁ: СУММА ПО ПАРТИЯМ РАВНА ОСТАТКУ СКЛАДА.
// Всегда, при любых приходах, выдачах, корректировках и излишках
// инвентаризации. Разойдись она — экран начнёт спорить со «Складом», и правым
// окажется «Склад», а этот экран перестанут открывать. Корзина «без срока»
// существует в том числе ради этого: она добирает разницу, когда остаток
// больше, чем пришло известными партиями, — и она же ПОКАЗЫВАЕТ МИНУС, если
// остаток товара ушёл ниже нуля. Прежний Math.max(on_hand, 0) сводил такой
// товар к нулю, то есть ломал инвариант ровно тем способом, от которого он и
// поставлен: молча.
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

// PROCUREMENT_FILTERS_V1 (2026-09-25) — КАТЕГОРИИ ЗАКУПОК, ТОТ ЖЕ СПИСОК, ЧТО В
// CHECK У products.procurement_category (миграция 010). Владелец: «just show
// filters so user ticks his own and manage statistics» — фильтр, который каждый
// отмечает сам; НЕ назначение и НЕ ограничение. Поэтому сервер ничего не решает
// за человека: он только проверяет, что прислана настоящая категория, и отбирает
// товары в SQL. Неизвестное слово — 400, а не «пустой список»: опечатка в
// категории, прочитанная как «товаров нет», — это ложь о складе.
export const PROCUREMENT_CATEGORIES = ['medicines', 'consumables', 'equipment', 'lab_supplies', 'dental', 'radiology', 'office_it', 'facility'];

/**
 * Категории из аргумента: массив (или одна строка) → проверенный список без
 * повторов в порядке каталога. Пусто / не прислано → null («все категории»).
 */
export function parseCategories(value, argName = 'categories') {
  if (value === undefined || value === null || value === '') return null;
  const list = Array.isArray(value) ? value : [value];
  const seen = new Set();
  for (const raw of list) {
    const v = typeof raw === 'string' ? raw.trim() : raw;
    if (!PROCUREMENT_CATEGORIES.includes(v)) {
      throw new RpcError(argName + ': неизвестная категория «' + String(raw) + '». Допустимо: ' + PROCUREMENT_CATEGORIES.join(', ') + '.', 400);
    }
    seen.add(v);
  }
  if (!seen.size) return null;
  return PROCUREMENT_CATEGORIES.filter((c) => seen.has(c));
}

/** SQL-условие «товар из этих категорий» — или null, если отбора нет. */
export function categoryClause(categories, col) {
  if (!categories || !categories.length) return null;
  return { sql: `${col} IN (${categories.map(() => '?').join(', ')})`, params: [...categories] };
}

// Отбор по состоянию партии на экране «Сроки годности»: «Все / Просрочено /
// Истекает / В порядке». «Срок не указан» отдельной кнопки не имеет — такие
// строки видны в «Все».
export const LOT_STATE_FILTERS = ['all', 'expired', 'soon', 'ok'];

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

// ОТБОР СЧИТАЕТ SQL, А НЕ JS ПОВЕРХ ВСЕГО КАТАЛОГА (2026-09-23). Экран
// перерисовывается на каждую букву в поиске, а better-sqlite3 синхронный: пока
// сервер раскладывает по партиям ВЕСЬ каталог, чтобы потом отбросить 1499
// товаров из 1500, стоит вся клиника — регистратура, касса, лаборатория.
// Поэтому и товар, и поиск уезжают в WHERE, и до JS доезжает только то, что
// человек попросил.
//
// lower_uni, а не lower: встроенный lower() в SQLite складывает регистр только
// для латиницы, и «перч» никогда не нашло бы «Перчатки» (CYRILLIC_ILIKE_V1,
// db/connection.js).
function searchClause(q, nameCol, codeCol) {
  if (!q) return null;
  return { sql: `(lower_uni(${nameCol}) LIKE lower_uni(?) OR lower_uni(IFNULL(${codeCol}, '')) LIKE lower_uni(?))`,
           params: [`%${q}%`, `%${q}%`] };
}

/**
 * Приходы, сгруппированные в партии: одна строка на пару (партия, срок).
 * Один и тот же товар, принятый дважды по одной накладной-партии, — это одна
 * партия, а не две одинаковые строки на экране.
 *
 * first_id — приход, которым партия ОТКРЫЛАСЬ: им она и называет поставщика.
 * last_id — САМЫЙ ПОЗДНИЙ её приход: им партия встаёт в очередь расклада.
 * Поставщик приезжает одним соединением здесь же: прежде на каждую партию
 * уходил отдельный запрос, то есть на складе в 1500 товаров — двенадцать тысяч
 * походов в базу за одним именем.
 */
function receiptGroups(db, { productIds = null } = {}) {
  const where = ["m.kind = 'receive'", 'm.qty > 0'];
  const params = [];
  if (productIds && productIds.length) {
    where.push(`m.product_id IN (${productIds.map(() => '?').join(', ')})`);
    params.push(...productIds);
  }
  return db.prepare(`
    SELECT g.product_id, g.batch_no, g.expiry_date, g.received_qty, g.first_id, g.last_id,
           m0.supplier_id AS supplier_id, s.name AS supplier_name
      FROM (
        SELECT m.product_id,
               IFNULL(m.batch_no, '')    AS batch_no,
               IFNULL(m.expiry_date, '') AS expiry_date,
               SUM(m.qty)                AS received_qty,
               MIN(m.id)                 AS first_id,
               MAX(m.id)                 AS last_id
          FROM stock_movements m
         WHERE ${where.join(' AND ')}
         GROUP BY m.product_id, IFNULL(m.batch_no, ''), IFNULL(m.expiry_date, '')
      ) g
      LEFT JOIN stock_movements m0 ON m0.id = g.first_id
      LEFT JOIN suppliers s ON s.id = m0.supplier_id
     ORDER BY g.product_id, g.expiry_date, g.batch_no, g.first_id`).all(...params);
}

/** Товары, у которых вообще есть что раскладывать: приход или остаток. */
function stockedProducts(db, { productIds = null, q = '', categories = null } = {}) {
  const where = [`(EXISTS (SELECT 1 FROM stock_movements m WHERE m.product_id = p.id AND m.kind = 'receive' AND m.qty > 0) OR p.on_hand <> 0)`];
  const params = [];
  if (productIds && productIds.length) {
    where.push(`p.id IN (${productIds.map(() => '?').join(', ')})`);
    params.push(...productIds);
  }
  // PROCUREMENT_FILTERS_V1 — категория решается на товарах, как и поиск: в
  // журнал уезжают только номера отобранных товаров (см. lotBalances).
  const c = categoryClause(categories, 'p.procurement_category');
  if (c) { where.push(c.sql); params.push(...c.params); }
  const s = searchClause(q, 'p.name', 'p.code');
  if (s) { where.push(s.sql); params.push(...s.params); }
  return db.prepare(`
    SELECT p.id, p.name, IFNULL(p.code, '') AS code, p.unit, p.base_unit, p.on_hand
      FROM products p
     WHERE ${where.join(' AND ')}
     ORDER BY p.name, p.id`).all(...params);
}

/**
 * Сколько партий СО СРОКОМ клиника вообще заводила — одним счётом в SQL.
 *
 * Экрану это нужно ради одной новости: «сроки годности ещё не заполняли»
 * (0) против «по вашему отбору ничего не нашлось» (не 0). Раскладывать ради
 * этого числа весь каталог на каждую букву поиска нельзя — см. отбор выше; а
 * заодно ответ стал честнее прежнего. Прежде считались партии, У КОТОРЫХ ЕСТЬ
 * ОСТАТОК, и клиника, однажды заполнившая срок и израсходовавшая товар, читала
 * про себя «сроки годности ещё не заполняли» — неправду.
 *
 * ЧЕГО ЗДЕСЬ НЕ ХВАТАЕТ: индекса. Приходы лежат вперемешку с расходом, а
 * индекс у stock_movements один — по товару (миграция 007), поэтому этот счёт
 * читает таблицу целиком (~70 мс на 306 тысячах движений). Частичный индекс
 * по (product_id, expiry_date, batch_no) WHERE kind='receive' AND qty>0 снял бы
 * и его, и оставшийся проход receiptGroups. Здесь его НЕТ намеренно: индекс —
 * это миграция, а номер миграции занимают три машины сразу, и ставить его
 * заодно с починкой расчёта значит смешать две правки в одном откате.
 */
function datedLotCount(db) {
  const row = db.prepare(`
    SELECT COUNT(*) AS c FROM (
      SELECT 1 FROM stock_movements m
       WHERE m.kind = 'receive' AND m.qty > 0 AND IFNULL(m.expiry_date, '') <> ''
       GROUP BY m.product_id, IFNULL(m.batch_no, ''), m.expiry_date)`).get();
  return row ? row.c : 0;
}

/**
 * Разложить остаток ОДНОГО товара по его партиям.
 *
 * Правило целиком: приходы встают в очередь ОТ САМОГО ПОЗДНЕГО К САМОМУ
 * РАННЕМУ и забирают остаток в этом порядке, каждый — не больше, чем его
 * пришло; приходы без срока идут одной корзиной «без срока» и стоят в той же
 * очереди по своему последнему поступлению. Всё, что не досталось никому,
 * ложится в ту же корзину: она заводится и тогда, когда приходов без срока не
 * было вовсе, — иначе излишек инвентаризации (или минус на складе) потерялся
 * бы, и сумма перестала бы сходиться с остатком склада. Показываются партии
 * ближайшим сроком вперёд — в том порядке, в каком их и будут расходовать.
 *
 * @returns {{ product, lots: Array }} — ВСЕ партии, включая нулевые: отбор
 *   «остаток больше нуля» делает тот, кто показывает, а инвариант проверяется
 *   по полному списку.
 */
export function productLots(db, productId, todayStr = null) {
  const product = db.prepare('SELECT id, name, IFNULL(code, \'\') AS code, unit, base_unit, on_hand FROM products WHERE id = ?').get(productId);
  if (!product) return { product: null, lots: [] };
  const day = todayStr || today(db);
  return { product, lots: allocate(product, receiptGroups(db, { productIds: [productId] }), day) };
}

/**
 * Тот же расклад, но сразу по многим товарам — одним запросом на всё.
 *
 * ОТБОР РЕШАЕТСЯ НА ТОВАРАХ, А ПОТОМ ЕДЕТ В ЖУРНАЛ НОМЕРАМИ. Поиск по названию
 * стоит одного прохода по products (полторы тысячи строк), а тот же поиск,
 * приписанный к приходам, заставил бы базу выполнить его на КАЖДОЙ из трёхсот
 * тысяч строк журнала. Найденные номера уходят в `product_id IN (…)` — по
 * индексу idx_stock_movements_product. Когда отбора нет, номера не
 * перечисляются вовсе: перечислять весь каталог дороже, чем не перечислять.
 */
export function lotBalances(db, { productIds = null, q = '', categories = null, todayStr = null } = {}) {
  const day = todayStr || today(db);
  const products = stockedProducts(db, { productIds, q, categories });
  const filtered = !!(q || (productIds && productIds.length) || (categories && categories.length));
  if (filtered && !products.length) return [];
  const groups = new Map();
  for (const g of receiptGroups(db, { productIds: filtered ? products.map((p) => p.id) : null })) {
    if (!groups.has(g.product_id)) groups.set(g.product_id, []);
    groups.get(g.product_id).push(g);
  }
  const out = [];
  for (const p of products) out.push(...allocate(p, groups.get(p.id) || [], day));
  return out;
}

/** Ядро расчёта: остаток склада → партии, самый поздний приход первым. */
function allocate(product, groups, day) {
  const unit = product.base_unit || product.unit || '';
  const dated = groups.filter((g) => g.expiry_date);
  const undated = groups.filter((g) => !g.expiry_date);

  // Корзина «без срока» — ОДНА на товар, и в очередь она встаёт по самому
  // позднему из своих приходов.
  const bucket = {
    received: round2(undated.reduce((s, g) => s + Number(g.received_qty), 0)),
    last_id: undated.reduce((m, g) => Math.max(m, Number(g.last_id) || 0), 0),
    taken: 0,
  };
  const queue = dated.map((g) => ({ g, received: round2(g.received_qty), last_id: Number(g.last_id) || 0, taken: 0 }));
  if (undated.length) queue.push(bucket);
  queue.sort((a, b) => b.last_id - a.last_id);

  let left = round2(product.on_hand);
  for (const q of queue) {
    // Остаток ушёл в минус — брать нечего: ни одна партия не «держит» товар,
    // а сам минус ниже ляжет в корзину и будет НАЗВАН.
    const take = left > 0 ? round2(Math.min(q.received, left)) : 0;
    q.taken = take;
    left = round2(left - take);
  }

  const lots = dated.map((g) => {
    const daysLeft = daysBetween(day, g.expiry_date);
    const q = queue.find((x) => x.g === g);
    return {
      product_id: product.id,
      product_name: product.name,
      product_code: product.code || '',
      unit,
      batch_no: g.batch_no,
      expiry_date: g.expiry_date,
      no_expiry: false,
      received_qty: round2(g.received_qty),
      remaining: q.taken,
      days_left: daysLeft,
      state: lotState(daysLeft),
      supplier_id: g.supplier_id || null,
      supplier_name: g.supplier_id ? (g.supplier_name || '') : '',
    };
  });
  // Ближайший срок первым — порядок ПОКАЗА и порядок расхода, а не порядок
  // расклада: расклад шёл от последнего прихода назад.
  lots.sort((x, y) => (x.expiry_date === y.expiry_date
    ? String(x.batch_no).localeCompare(String(y.batch_no))
    : (x.expiry_date < y.expiry_date ? -1 : 1)));

  const rest = round2(bucket.taken + left);
  if (undated.length || Math.abs(rest) > 1e-9) {
    lots.push({
      product_id: product.id,
      product_name: product.name,
      product_code: product.code || '',
      unit,
      batch_no: '',
      expiry_date: '',
      no_expiry: true,
      received_qty: bucket.received,
      remaining: rest,
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
 * args: { product_id?, q? (название или код товара), limit?,
 *         categories? (PROCUREMENT_FILTERS_V1: список категорий закупок),
 *         state? ('all' | 'expired' | 'soon' | 'ok') }
 * → { scope, today, soon_days, count, truncated, products: [{id, name}],
 *     summary: { total, expired, soon, ok, none } — партии по состояниям
 *       ПОСЛЕ отбора по категориям/товару/поиску, но ДО отбора по состоянию:
 *       кнопки состояния показывают, сколько за каждой из них лежит,
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
    return { scope: scope.kind, today: day, soon_days: EXPIRING_SOON_DAYS, count: 0, dated_total: 0, truncated: false, products: [], lots: [],
             summary: { total: 0, expired: 0, soon: 0, ok: 0, none: 0 } };
  }

  let productId = null;
  if (a.product_id !== undefined && a.product_id !== null && a.product_id !== '') {
    productId = Number(a.product_id);
    if (!isPosInt(productId)) throw new RpcError('product_id: положительное целое.', 400);
  }
  const q = typeof a.q === 'string' ? a.q.trim() : '';
  const limit = isPosInt(Number(a.limit)) ? Math.min(Number(a.limit), 2000) : 500;
  const categories = parseCategories(a.categories);
  let stateFilter = 'all';
  if (a.state !== undefined && a.state !== null && a.state !== '') {
    if (!LOT_STATE_FILTERS.includes(a.state)) {
      throw new RpcError('state: одно из ' + LOT_STATE_FILTERS.join(', ') + '.', 400);
    }
    stateFilter = a.state;
  }

  // Список товаров для отбора считается БЕЗ отбора по товару и поиску: иначе
  // фильтр схлопывается в один пункт сразу после первого выбора, и вернуться к
  // «всем» нечем. Партии ради этого списка не раскладываются — довольно имён
  // (он стоит один запрос по products, а не разбор всего журнала прихода).
  // Отмеченные категории (PROCUREMENT_FILTERS_V1) список СУЖАЮТ: человек,
  // отметивший «Медикаменты», не должен листать перчатки.
  const products = stockedProducts(db, { categories })
    .map((p) => ({ id: p.id, name: p.name }))
    .sort((x, y) => String(x.name).localeCompare(String(y.name), 'ru'));

  // Сколько партий СО СРОКОМ есть вообще. Пустой экран должен различать
  // «ничего не нашлось по фильтру» и «срок не заполняли ни разу»: вторая
  // новость просит объяснить, где этот срок вводится.
  const datedTotal = datedLotCount(db);

  // Отбор — в SQL (см. receiptGroups/stockedProducts): раскладывать весь
  // каталог, чтобы показать одну строку, значит держать клинику на каждой букве.
  // Ноль в остатке не показываем; МИНУС показываем — он и есть новость.
  const all = lotBalances(db, { productIds: productId ? [productId] : null, q, categories, todayStr: day })
    .filter((l) => Math.abs(l.remaining) > 1e-9);

  // Итоги по состояниям — по тому, что человек отобрал (категории, товар,
  // поиск), и ДО кнопки состояния: иначе на кнопке «Просрочено» стоял бы ноль,
  // как только выбрана «Истекает».
  const summary = { total: all.length, expired: 0, soon: 0, ok: 0, none: 0 };
  for (const l of all) summary[l.state] = (summary[l.state] || 0) + 1;

  const lots = stateFilter === 'all' ? all : all.filter((l) => l.state === stateFilter);

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
    products, summary, lots: truncated ? lots.slice(0, limit) : lots,
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
