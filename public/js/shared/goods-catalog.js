// SUPPLIERS_VAT_V1 (2026-09-28) — ТИПЫ ТОВАРОВ, СТАВКИ НДС И СРОК ГОДНОСТИ
// ИМПОРТА: ОДИН СПИСОК НА СЕРВЕР И ЭКРАН.
//
// Владелец: «when adding goods to the procurement we need to hardcode the types
// of the goods, set up price and VAT rate», и про импорт: «add an expiration
// date with a hardcoded format, so the user won't make mistakes».
//
// ТИПЫ ТОВАРОВ — те же восемь, что в CHECK у products.procurement_category
// (миграция 010) и в rpc/expiry.js PROCUREMENT_CATEGORIES (тест сверяет все
// три). Здесь же их русские названия: их пишет человек в файле Excel, их
// показывают «Склад», «Товары» и отчёты (inventory-shared.js CATEGORY_LABEL —
// этот же объект).
//
// СТАВКИ НДС — ровно три: 12 % (стандартная ставка Узбекистана с 2023 года),
// 0 % и «без НДС». В базе — число 12 или 0, «без НДС» — NULL. Любое другое
// число сервер не принимает: ставка «жёстко», как и тип.
//
// Модуль чистый (без DOM, без базы): его читают rpc/procurement.js,
// rpc/catalog-goods.js, rpc/reports.js и экраны склада.

export const GOODS_CATEGORIES = Object.freeze(['medicines', 'consumables', 'equipment', 'lab_supplies', 'dental', 'radiology', 'office_it', 'facility']);

export const GOODS_CATEGORY_RU = Object.freeze({
    medicines:    'Медикаменты',
    consumables:  'Расходники',
    equipment:    'Оборудование',
    lab_supplies: 'Лаб. материалы',
    dental:       'Стоматология',
    radiology:    'Радиология',
    office_it:    'Офис / IT',
    facility:     'Хозяйство',
});

// Как название пишут руками: регистр, «ё», лишние пробелы и пробел у точки
// («Лаб.материалы») не делают его другим типом.
function norm(s) {
    return String(s == null ? '' : s).toLowerCase().replace(/ё/g, 'е')
        .replace(/\s*([./])\s*/g, '$1').replace(/\s+/g, ' ').trim();
}
const CATEGORY_BY_WORD = new Map();
for (const key of GOODS_CATEGORIES) {
    CATEGORY_BY_WORD.set(norm(key), key);
    CATEGORY_BY_WORD.set(norm(GOODS_CATEGORY_RU[key]), key);
}

/** Ключ типа по ключу или русскому названию — или null, если такого типа нет. */
export function parseGoodsCategory(value) {
    if (value === undefined || value === null) return null;
    return CATEGORY_BY_WORD.get(norm(value)) || null;
}

/** Все допустимые названия одной строкой — для сообщений и листа «Подсказки». */
export const GOODS_CATEGORY_LIST_RU = GOODS_CATEGORIES.map((k) => GOODS_CATEGORY_RU[k]).join(', ');

// ---------------------------------------------------------------------------
// НДС
// ---------------------------------------------------------------------------
export const VAT_RATES = Object.freeze([12, 0]);   // и null — «без НДС»
export const VAT_STANDARD = 12;
export const VAT_NONE_RU = 'без НДС';

/** Подпись ставки: 12 → «12 %», 0 → «0 %», null → «без НДС». */
export function vatLabel(rate) {
    if (rate === null || rate === undefined) return VAT_NONE_RU;
    return String(rate) + ' %';
}

/**
 * Ставка из того, что прислали (число из формы, ячейка Excel, JSON).
 *   { rate: 12 | 0 | null }   — ставка («без НДС» — null);
 *   { empty: true }           — ничего не прислали (пусто, undefined);
 *   { error: true }           — что-то другое: 15, «12,5 %», «да».
 * null из формы — это выбор «без НДС», а не «пусто».
 */
export function parseVatRate(value) {
    if (value === undefined || value === '') return { empty: true };
    if (value === null) return { rate: null };
    if (typeof value === 'number') {
        if (VAT_RATES.includes(value)) return { rate: value };
        // Excel, в ячейку которого набрали «12%», хранит 0,12 (процентный
        // формат) — это те же 12 %, а не «0,12 %», которых не бывает.
        if (Math.abs(value - 0.12) < 1e-9) return { rate: 12 };
        return { error: true };
    }
    if (typeof value !== 'string') return { error: true };
    const s = norm(value).replace(/\s/g, '');
    if (s === '') return { empty: true };
    if (s === 'безндс' || s === 'none' || s === 'нет') return { rate: null };
    const m = /^(\d+)%?$/.exec(s);
    if (m && VAT_RATES.includes(Number(m[1]))) return { rate: Number(m[1]) };
    return { error: true };
}

const round2 = (n) => Math.round(Number(n) * 100) / 100;

/** НДС суммы БЕЗ НДС: 1 000 × 12 % = 120. «Без НДС» и 0 % — 0. */
export function vatOnNet(net, rate) {
    const r = Number(rate) || 0;
    return r > 0 ? round2((Number(net) || 0) * r / 100) : 0;
}

/** Цена с НДС из цены без НДС (для показа; сервер считает сам). */
export function grossOfNet(net, rate) {
    const r = Number(rate) || 0;
    return r > 0 ? round2((Number(net) || 0) * (100 + r) / 100) : round2(Number(net) || 0);
}

// ---------------------------------------------------------------------------
// SUPPLIERS_VAT_V1 (ревью F2) — ЦЕНА СВЯЗИ «ТОВАР ↔ ПОСТАВЩИК» — ЗА ЕДИНИЦУ
// ЗАКУПКИ СВЯЗИ.
//
// У каждой связи своя упаковка (item_suppliers.pack_factor: «1 кор = 100
// таб»), и last_price — цена без НДС за ЭТУ упаковку; карточка поставщика так
// её и подписывает («сум за кор»). Делить её на упаковку ТОВАРА (10 таб в
// «уп») значило в десять раз ошибиться: заказ подставлял 900 за таблетку
// вместо 90. Упаковки связи нет (старая строка) — упаковка товара, её нет —
// базовая единица. Одно правило на сервер и экран.
// ---------------------------------------------------------------------------
/** Положительная упаковка или null. */
export function packOf(v) {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
}

/** Сколько базовых единиц в единице закупки СВЯЗИ. */
export function linkPackOf(link, product) {
    return packOf(link && link.pack_factor) || packOf(product && product.pack_factor) || 1;
}

/**
 * Цена связи без НДС за `per` базовых единиц: per = 1 — за базовую единицу
 * (строка заказа), per = упаковка товара — за единицу закупки товара (окно
 * «Принять товар»). Цены у связи нет — null.
 */
export function linkPriceFor(link, product, per = 1) {
    if (!link || link.last_price === null || link.last_price === undefined || link.last_price === '') return null;
    const price = Number(link.last_price);
    if (!Number.isFinite(price)) return null;
    return round2(price * (packOf(per) || 1) / linkPackOf(link, product));
}

/** Обратно: цена за `per` базовых единиц → цена за единицу закупки связи (упаковка `linkPack`). */
export function priceInLinkPack(price, per, linkPack) {
    return round2((Number(price) || 0) * (packOf(linkPack) || 1) / (packOf(per) || 1));
}

// ---------------------------------------------------------------------------
// СРОК ГОДНОСТИ В ИМПОРТЕ — ОДИН ФОРМАТ ДД.ММ.ГГГГ
// ---------------------------------------------------------------------------
export const EXPIRY_FORMAT_RU = 'ДД.ММ.ГГГГ';
export const EXPIRY_EXAMPLE = '31.12.2027';

/**
 * Срок годности из ячейки импорта.
 *   { empty: true }            — пусто;
 *   { iso: 'ГГГГ-ММ-ДД' }      — настоящая дата, не раньше today;
 *   { error: 'format' }        — не ровно ДД.ММ.ГГГГ (или не текст);
 *   { error: 'nodate' }        — формат верный, но такой даты нет (31.02.2027);
 *   { error: 'past' }          — дата уже прошла.
 * todayIso — сегодняшний местный день 'ГГГГ-ММ-ДД' (его знает сервер).
 * Дата-ячейку Excel экран превращает в ДД.ММ.ГГГГ сам (dmyOfDate) — по проводу
 * едет только текст этого одного формата.
 */
export function parseExpiryDmy(value, todayIso) {
    if (value === undefined || value === null) return { empty: true };
    if (typeof value !== 'string') return { error: 'format' };
    const s = value.trim();
    if (s === '') return { empty: true };
    const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(s);
    if (!m) return { error: 'format' };
    const d = Number(m[1]); const mo = Number(m[2]); const y = Number(m[3]);
    if (mo < 1 || mo > 12 || d < 1 || y < 1900) return { error: 'nodate' };
    const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    if (d > last) return { error: 'nodate' };
    const iso = `${m[3]}-${m[2]}-${m[1]}`;
    if (todayIso && iso < String(todayIso).slice(0, 10)) return { error: 'past' };
    return { iso };
}

const pad2 = (n) => String(n).padStart(2, '0');

/**
 * Дата-ячейка Excel (JS Date) → «ДД.ММ.ГГГГ» — КАЛЕНДАРНЫЙ ДЕНЬ, КАК ЕГО
 * НАПИСАЛИ В ЯЧЕЙКЕ.
 *
 * Ревью M4 — прежде здесь стояло «+12 часов»: оно ставило в свой день и
 * местную полночь, и полночь UTC, но переносило на СЛЕДУЮЩИЙ день всё, что
 * написано с 12:00 и позже («28.09.2026 18:00» → 29.09, «31.12.2027 23:59»
 * получал лишний день срока). SheetJS 0.20.3 отдаёт дату-ячейку Date'ом, у
 * которого UTC-часы — ровно написанное в ячейке, поэтому день берётся из UTC.
 * Одно исключение — Date, собранный как МЕСТНАЯ полночь (так его строят
 * вызовы и старые версии, иногда с секундной поправкой старых поясов): у него
 * день — местный. Экран импорта Date'ов вовсе не получает: он читает книгу
 * числами и берёт день из частей Excel (dmyOfParts ниже).
 */
export function dmyOfDate(date) {
    if (!(date instanceof Date) || !Number.isFinite(date.getTime())) return null;
    const localMidnight = date.getHours() === 0 && date.getMinutes() === 0 && date.getMilliseconds() === 0;
    if (localMidnight) return `${pad2(date.getDate())}.${pad2(date.getMonth() + 1)}.${date.getFullYear()}`;
    return `${pad2(date.getUTCDate())}.${pad2(date.getUTCMonth() + 1)}.${date.getUTCFullYear()}`;
}

/**
 * Ревью M4 — дата-ячейка Excel по частям (SheetJS SSF.parse_date_code(число
 * ячейки) → { y, m, d, H, M, … }) → «ДД.ММ.ГГГГ». Часы не участвуют: срок
 * годности — день, написанный в ячейке, при любом поясе компьютера.
 */
export function dmyOfParts(p) {
    if (!p || !Number.isInteger(p.y) || !Number.isInteger(p.m) || !Number.isInteger(p.d)) return null;
    if (p.m < 1 || p.m > 12 || p.d < 1 || p.d > 31 || p.y < 1900) return null;
    return `${pad2(p.d)}.${pad2(p.m)}.${p.y}`;
}
