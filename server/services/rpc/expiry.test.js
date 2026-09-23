// EXPIRY_BALANCE_V1 — ОСТАТКИ ПАРТИЯМИ И ПРЕДУПРЕЖДЕНИЕ О ПРОСРОЧКЕ.
//
// Владелец (23.09), решение по четвёртому вопросу: «экран "Сроки годности"
// показывает остатки партиями, ближайший срок первым; выдача и списание
// просроченного предупреждают». Полной прослеживаемости партии до пациента
// владелец НЕ выбрал — и её здесь нет: ни в stock_holdings, ни в строках
// визита, ни в вопросе «из какой партии берёте».
//
// Что закреплено здесь, по важности:
//   1. ОСТАТОК ПАРТИИ — РАСЧЁТ, А НЕ ИЗМЕРЕНИЕ. Количество по партиям нигде не
//      хранится: приход знает партию, расход — нет. Поэтому остаток склада
//      РАСКЛАДЫВАЕТСЯ по приходам, и сумма разложенного обязана совпадать с
//      остатком склада ВСЕГДА. Разойдись она — экран начнёт спорить со
//      складом, и правым окажется склад.
//   2. РАСКЛАД ИДЁТ ОТ ПОСЛЕДНЕГО ПРИХОДА НАЗАД. FEFO — это «первым расходуется
//      ближайший срок», то есть ранняя партия УХОДИТ ПЕРВОЙ, а на полке
//      остаётся поздняя. Прежний расклад говорил обратное — клал остаток на
//      самые ранние партии, — и клиника видела просроченный товар, которого на
//      складе нет, а предупреждение о нём не гасло уже никогда: гасить его было
//      нечем, потому что и следующее списание «брало» у той же старой партии.
//   3. ПРЕДУПРЕЖДЕНИЕ НЕ СТАНОВИТСЯ ОТКАЗОМ. Владелец сказал предупреждать, а
//      не запрещать: и выдача, и списание на пациента проходят, ledger пишется
//      как писался, а ответ несёт предупреждение сверх результата.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { productLots, expiryLots, expiryWarnings, EXPIRING_SOON_DAYS } from './expiry.js';
import { receiveStockLines, issueStockLines, adjustStock } from './procurement.js';
import { dispenseItem, dispenseAdmissionItemCore } from './inventory.js';
import { dispenseFromHolding } from './holdings.js';
import { departmentForm } from './departments.js';
import { today } from '../domain/day.js';

const ADMIN = { id: 1, role: 'admin', extra_roles: [] };
const INV   = { id: 2, role: 'inventory', extra_roles: [] };
const HEAD  = { id: 3, role: 'doctor', extra_roles: [] };     // заведующая Кардиологией
const NURSE = { id: 4, role: 'nurse', extra_roles: [] };
const REG   = { id: 5, role: 'registrar', extra_roles: [] };

function seed() {
  const db = openDb(':memory:');
  migrate(db);
  const mk = db.prepare('INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (?,?,?,?,?,?)');
  mk.run(1, 'admin', 'x', 'Админ Админов', 'admin', 0);
  mk.run(2, 'inv', 'x', 'Кладовщик Каримов', 'inventory', 0);
  mk.run(3, 'head', 'x', 'Заведующая Юсупова', 'doctor', 1);
  mk.run(4, 'nurse', 'x', 'Медсестра Алиева', 'nurse', 0);
  mk.run(5, 'reg', 'x', 'Регистратор Рустамов', 'registrar', 0);
  db.prepare("INSERT INTO suppliers (id, name) VALUES (9, 'Медснаб')").run();
  db.prepare("INSERT INTO products (id, name, code, unit, base_unit, sale_price, on_hand, avg_cost, active) VALUES (7, 'Перчатки', 'GLV', 'уп', 'уп', 500, 0, 0, 1)").run();
  db.prepare("INSERT INTO products (id, name, code, unit, base_unit, sale_price, on_hand, avg_cost, active) VALUES (8, 'Бинт', 'BND', 'шт', 'шт', 2000, 0, 0, 1)").run();
  db.prepare("INSERT INTO patients (id, full_name) VALUES (50, 'Сидоров Сидор')").run();
  db.prepare("INSERT INTO visits (id, patient_id, visit_date, status) VALUES (300, 50, date('now','localtime'), 'arrived')").run();
  departmentForm(db, { name: 'Кардиология', kind: 'clinical', head_user_id: 3, member_ids: [4], places: [] }, ADMIN);
  return db;
}

const shift = (db, days) => {
  const d = new Date(today(db) + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const onHand = (db, id) => db.prepare('SELECT on_hand FROM products WHERE id = ?').get(id).on_hand;
const sum = (lots) => Math.round(lots.reduce((s, l) => s + l.remaining, 0) * 100) / 100;

/** Приход тремя партиями одного товара: просроченная, скорая и дальняя. */
function threeLots(db) {
  receiveStockLines(db, { lines: [
    { product_id: 7, qty: 10, unit: 'base', unit_cost: 1000, supplier_id: 9, batch_no: 'A-1', expiry_date: shift(db, -5) },
    { product_id: 7, qty: 10, unit: 'base', unit_cost: 1000, batch_no: 'B-2', expiry_date: shift(db, 10) },
    { product_id: 7, qty: 10, unit: 'base', unit_cost: 1000, batch_no: 'C-3', expiry_date: shift(db, 400) },
  ] }, ADMIN);
}

// ───────────────────────────────────────────────────────────────────────────
// 1. Расклад остатка по партиям
// ───────────────────────────────────────────────────────────────────────────

test('сумма по партиям РАВНА остатку склада — иначе экран спорит со складом', () => {
  const db = seed();
  try {
    threeLots(db);
    assert.equal(sum(productLots(db, 7).lots), onHand(db, 7), 'сразу после прихода');

    issueStockLines(db, { holder: { type: 'staff', id: 4 }, lines: [{ product_id: 7, qty: 12, unit: 'base' }] }, INV);
    assert.equal(sum(productLots(db, 7).lots), onHand(db, 7), 'после выдачи');

    adjustStock(db, { product_id: 7, qty: -3, note: 'бой' }, ADMIN);
    assert.equal(sum(productLots(db, 7).lots), onHand(db, 7), 'после корректировки в минус');

    adjustStock(db, { product_id: 7, qty: -10, note: 'пересчёт: на полке меньше' }, ADMIN);
    assert.equal(sum(productLots(db, 7).lots), onHand(db, 7),
        'инвентаризация ниже всех приходов: партии обязаны съёжиться, а не оставить лишнее');

    adjustStock(db, { product_id: 7, qty: 50, note: 'найдено при инвентаризации' }, ADMIN);
    assert.equal(sum(productLots(db, 7).lots), onHand(db, 7),
        'остаток больше, чем пришло партиями: излишек обязан лечь в «без срока», а не потеряться');
  } finally { db.close(); }
});

// ── C2: расход берёт РАННЮЮ партию, значит на полке остаётся ПОЗДНЯЯ ────────
test('израсходованная партия не воскресает: остаток ложится на последний приход', () => {
  const db = seed();
  try {
    // Ровно случай из клиники: перчатки пришли со старым сроком, разошлись
    // целиком, потом пришла новая коробка. Старой на складе НЕТ.
    receiveStockLines(db, { lines: [{ product_id: 7, qty: 10, unit: 'base', unit_cost: 1000, batch_no: 'OLD', expiry_date: shift(db, -200) }] }, ADMIN);
    issueStockLines(db, { holder: { type: 'staff', id: 4 }, lines: [{ product_id: 7, qty: 10, unit: 'base' }] }, INV);
    receiveStockLines(db, { lines: [{ product_id: 7, qty: 50, unit: 'base', unit_cost: 1000, batch_no: 'NEW', expiry_date: shift(db, 400) }] }, ADMIN);
    assert.equal(onHand(db, 7), 50);

    const shown = productLots(db, 7).lots.filter((l) => l.remaining > 1e-9);
    assert.deepEqual(shown.map((l) => [l.batch_no, l.remaining]), [['NEW', 50]],
        'экран придумал просроченный остаток, которого на складе нет');
    assert.deepEqual(expiryWarnings(db, [7]), [],
        'предупреждение о партии, которой нет, гасить нечем — оно не погаснет никогда');

    // И следующая выдача молчит — до этой правки она тревожила вечно.
    const res = issueStockLines(db, { holder: { type: 'staff', id: 4 }, lines: [{ product_id: 7, qty: 2, unit: 'base' }] }, INV);
    assert.deepEqual(res.warnings, []);
  } finally { db.close(); }
});

test('старая партия держит остаток ровно в той мере, в какой её не покрыли поздние приходы', () => {
  const db = seed();
  try {
    receiveStockLines(db, { lines: [{ product_id: 7, qty: 10, unit: 'base', unit_cost: 1000, batch_no: 'OLD', expiry_date: shift(db, -200) }] }, ADMIN);
    receiveStockLines(db, { lines: [{ product_id: 7, qty: 50, unit: 'base', unit_cost: 1000, batch_no: 'NEW', expiry_date: shift(db, 400) }] }, ADMIN);
    issueStockLines(db, { holder: { type: 'staff', id: 4 }, lines: [{ product_id: 7, qty: 5, unit: 'base' }] }, INV);
    assert.equal(onHand(db, 7), 55);

    const lots = productLots(db, 7).lots;
    assert.deepEqual(lots.map((l) => l.batch_no), ['OLD', 'NEW'], 'показ — ближайший срок первым');
    assert.deepEqual(lots.map((l) => l.remaining), [5, 50],
        'поздний приход закрывает 50 из 55, старой партии остаётся 5 — и о них надо предупредить');

    const [w] = expiryWarnings(db, [7]);
    assert.ok(w, 'просроченные 5 упаковок действительно лежат на складе — молчать нельзя');
    assert.equal(w.batch_no, 'OLD');
    assert.equal(w.remaining, 5, 'предупреждение обязано назвать, сколько именно просрочено');
  } finally { db.close(); }
});

test('остаток ложится на ПОСЛЕДНИЕ приходы, а показывается ближайшим сроком вперёд', () => {
  const db = seed();
  try {
    threeLots(db);
    issueStockLines(db, { holder: { type: 'staff', id: 4 }, lines: [{ product_id: 7, qty: 12, unit: 'base' }] }, INV);
    const lots = productLots(db, 7).lots;
    assert.deepEqual(lots.map((l) => l.batch_no), ['A-1', 'B-2', 'C-3'], 'порядок показа — по сроку, ближайший первым');
    // 18 на складе. Последней пришла C-3 — её 10 целы; на B-2 приходится 8;
    // A-1 разошлась первой, как ей и положено по FEFO.
    assert.deepEqual(lots.map((l) => l.remaining), [0, 8, 10]);
  } finally { db.close(); }
});

test('партия, которую расчёт считает израсходованной, показывает ноль и в остатках не значится', () => {
  const db = seed();
  try {
    threeLots(db);
    issueStockLines(db, { holder: { type: 'staff', id: 4 }, lines: [{ product_id: 7, qty: 25, unit: 'base' }] }, INV);
    const lots = productLots(db, 7).lots;
    assert.equal(lots.find((l) => l.batch_no === 'A-1').remaining, 0);
    assert.equal(lots.find((l) => l.batch_no === 'B-2').remaining, 0);
    const r = expiryLots(db, {}, ADMIN);
    assert.deepEqual(r.lots.map((l) => l.batch_no), ['C-3'],
        'пустая партия попала в список остатков — её там нет, её остаток ноль');
    assert.equal(sum(r.lots), onHand(db, 7));
  } finally { db.close(); }
});

test('приход без срока — такой же приход: очередь решает, кто пришёл позже', () => {
  const db = seed();
  try {
    // Просроченная партия, потом безымянный приход, потом расход ровно на
    // просроченную. Позже пришёл безымянный — он и лежит на складе.
    receiveStockLines(db, { lines: [
      { product_id: 7, qty: 10, unit: 'base', unit_cost: 1000, batch_no: 'A-1', expiry_date: shift(db, -5) },
      { product_id: 7, qty: 10, unit: 'base', unit_cost: 1000 },   // без партии и без срока
    ] }, ADMIN);
    issueStockLines(db, { holder: { type: 'staff', id: 4 }, lines: [{ product_id: 7, qty: 10, unit: 'base' }] }, INV);
    const { lots } = productLots(db, 7);
    assert.equal(lots.find((l) => l.batch_no === 'A-1').remaining, 0);
    assert.equal(lots.find((l) => l.no_expiry).remaining, 10);
    assert.deepEqual(expiryWarnings(db, [7]), [], 'просроченной партии на складе не осталось — тревожить не о чем');
    assert.equal(sum(lots), onHand(db, 7));
  } finally { db.close(); }
});

test('безымянный приход СТАРШЕ партии со сроком — и остаток держит партия', () => {
  const db = seed();
  try {
    receiveStockLines(db, { lines: [{ product_id: 7, qty: 10, unit: 'base', unit_cost: 1000 }] }, ADMIN);
    receiveStockLines(db, { lines: [{ product_id: 7, qty: 10, unit: 'base', unit_cost: 1000, batch_no: 'A-1', expiry_date: shift(db, -5) }] }, ADMIN);
    issueStockLines(db, { holder: { type: 'staff', id: 4 }, lines: [{ product_id: 7, qty: 10, unit: 'base' }] }, INV);
    const { lots } = productLots(db, 7);
    assert.equal(lots.find((l) => l.batch_no === 'A-1').remaining, 10,
        'просрочка растворилась в безымянном остатке — ровно там, где о ней и нужно предупредить');
    assert.equal(lots.find((l) => l.no_expiry).remaining, 0);
    assert.equal(expiryWarnings(db, [7]).length, 1);
    assert.equal(sum(lots), onHand(db, 7));
  } finally { db.close(); }
});

// Решение по мелкому замечанию: ПОКАЗАТЬ МИНУС, А НЕ ПРЯТАТЬ ЕГО. Прежний
// Math.max(on_hand, 0) сводил минусовой товар к нулю — сумма по партиям
// переставала сходиться со складом молча, то есть ровно тем способом, от
// которого экран и защищают. adjust_stock в минус не пускает, но остаток туда
// попадает переносом справочника, восстановлением из копии и правкой руками, и
// справочный экран обязан сказать об этом, а не упасть и не соврать нулём.
test('минус на складе показывается строкой, а не прячется под ноль', () => {
  const db = seed();
  try {
    threeLots(db);
    db.prepare('UPDATE products SET on_hand = -4 WHERE id = 7').run();
    const { lots } = productLots(db, 7);
    assert.equal(sum(lots), -4, 'сумма по партиям разошлась с остатком склада');
    const minus = lots.find((l) => l.no_expiry);
    assert.ok(minus && minus.remaining === -4, 'минус обязан быть видимой строкой «без срока»');
    assert.deepEqual(lots.filter((l) => !l.no_expiry).map((l) => l.remaining), [0, 0, 0],
        'при минусе ни одна партия не «держит» товар');
    const r = expiryLots(db, {}, ADMIN);
    assert.equal(sum(r.lots), onHand(db, 7), 'экран показал не всё, что посчитал');
    assert.deepEqual(expiryWarnings(db, [7]), [], 'минус — не повод тревожить о просрочке');
  } finally { db.close(); }
});

test('два товара не смешиваются: партии одного не занимают остаток другого', () => {
  const db = seed();
  try {
    receiveStockLines(db, { lines: [
      { product_id: 7, qty: 10, unit: 'base', unit_cost: 1000, batch_no: 'A-1', expiry_date: shift(db, 30) },
      { product_id: 8, qty: 4, unit: 'base', unit_cost: 500, batch_no: 'Z-9', expiry_date: shift(db, 5) },
    ] }, ADMIN);
    const r = expiryLots(db, {}, ADMIN);
    const byProduct = new Map(r.lots.map((l) => [l.product_id, l]));
    assert.equal(byProduct.get(7).remaining, 10);
    assert.equal(byProduct.get(8).remaining, 4);
    assert.equal(byProduct.get(8).batch_no, 'Z-9');
    // Ближайший срок первым — и через товары тоже.
    assert.deepEqual(r.lots.map((l) => l.product_id), [8, 7]);
  } finally { db.close(); }
});

test('состояние партии названо: просрочено / истекает / в порядке', () => {
  const db = seed();
  try {
    receiveStockLines(db, { lines: [
      { product_id: 7, qty: 5, unit: 'base', unit_cost: 1, batch_no: 'A-1', expiry_date: shift(db, -1) },
      { product_id: 7, qty: 5, unit: 'base', unit_cost: 1, batch_no: 'B-2', expiry_date: shift(db, EXPIRING_SOON_DAYS - 1) },
      { product_id: 7, qty: 5, unit: 'base', unit_cost: 1, batch_no: 'C-3', expiry_date: shift(db, EXPIRING_SOON_DAYS + 1) },
      { product_id: 8, qty: 5, unit: 'base', unit_cost: 1 },
    ] }, ADMIN);
    const r = expiryLots(db, {}, ADMIN);
    const st = new Map(r.lots.map((l) => [l.batch_no || l.product_id, l]));
    assert.equal(st.get('A-1').state, 'expired');
    assert.equal(st.get('A-1').days_left, -1);
    assert.equal(st.get('B-2').state, 'soon');
    assert.equal(st.get('C-3').state, 'ok');
    assert.equal(st.get(8).state, 'none', 'приход без срока — это не «в порядке», это «срок не указан»');
    assert.equal(st.get(8).days_left, null);
    assert.equal(r.soon_days, EXPIRING_SOON_DAYS, 'порог назван в ответе — экран не выдумывает свой');
    assert.equal(r.dated_total, 3,
        'экрану нужно знать, сколько партий СО СРОКОМ есть вообще: пустой список по фильтру и «срок не заполняли ни разу» — разные новости');
  } finally { db.close(); }
});

test('срок не заполняли ни разу — экрану видно это по ответу, а не по догадке', () => {
  const db = seed();
  try {
    receiveStockLines(db, { lines: [{ product_id: 8, qty: 10, unit: 'base', unit_cost: 100 }] }, ADMIN);
    const r = expiryLots(db, {}, ADMIN);
    assert.equal(r.dated_total, 0);
    assert.equal(r.lots.length, 1, 'остаток без срока показывается корзиной «без срока», а не прячется');
    assert.equal(r.lots[0].no_expiry, true);
  } finally { db.close(); }
});

// ───────────────────────────────────────────────────────────────────────────
// 2. Область видимости — та же, что у журнала (S2)
// ───────────────────────────────────────────────────────────────────────────

test('партии склада видит тот же, кто видит весь журнал: администратор и кладовщик', () => {
  const db = seed();
  try {
    threeLots(db);
    for (const u of [ADMIN, INV]) {
      const r = expiryLots(db, {}, u);
      assert.equal(r.scope, 'all');
      assert.ok(r.lots.length, 'кладовщику не видно партий склада');
    }
  } finally { db.close(); }
});

test('кому склад не виден — пустой список, а не отказ: 403 читается как поломка', () => {
  const db = seed();
  try {
    threeLots(db);
    for (const u of [HEAD, NURSE, REG]) {
      const r = expiryLots(db, {}, u);
      assert.deepEqual(r.lots, [], 'чужие остатки склада доехали до ' + u.role);
      assert.notEqual(r.scope, 'all');
    }
    assert.equal(expiryLots(db, {}, HEAD).scope, 'department');
    assert.equal(expiryLots(db, {}, NURSE).scope, 'own');
  } finally { db.close(); }
});

test('отбор по товару и поиск считает сервер', () => {
  const db = seed();
  try {
    receiveStockLines(db, { lines: [
      { product_id: 7, qty: 5, unit: 'base', unit_cost: 1, batch_no: 'A-1', expiry_date: shift(db, 3) },
      { product_id: 8, qty: 5, unit: 'base', unit_cost: 1, batch_no: 'Z-9', expiry_date: shift(db, 4) },
    ] }, ADMIN);
    assert.deepEqual(expiryLots(db, { product_id: 8 }, ADMIN).lots.map((l) => l.product_name), ['Бинт']);
    assert.deepEqual(expiryLots(db, { q: 'перч' }, ADMIN).lots.map((l) => l.product_name), ['Перчатки']);
    assert.deepEqual(expiryLots(db, { q: 'BND' }, ADMIN).lots.map((l) => l.product_name), ['Бинт'],
        'поиск по коду товара, как в журнале');
    // Отбор уехал в SQL, и встроенный lower() в SQLite складывает регистр
    // только для латиницы: без lower_uni «ПЕРЧ» не нашло бы «Перчатки», а
    // «bnd» — код BND (CYRILLIC_ILIKE_V1).
    assert.deepEqual(expiryLots(db, { q: 'ПЕРЧ' }, ADMIN).lots.map((l) => l.product_name), ['Перчатки'],
        'поиск кириллицей перестал складывать регистр');
    assert.deepEqual(expiryLots(db, { q: 'bnd' }, ADMIN).lots.map((l) => l.product_name), ['Бинт']);
    assert.deepEqual(expiryLots(db, { q: 'нет такого' }, ADMIN).lots, []);
    // Список товаров для отбора не сужается вместе с отбором — иначе фильтр
    // схлопывается в один пункт после первого же выбора.
    assert.deepEqual(expiryLots(db, { product_id: 8 }, ADMIN).products.map((p) => p.name), ['Бинт', 'Перчатки']);
  } finally { db.close(); }
});

// ───────────────────────────────────────────────────────────────────────────
// 3. Предупреждения: выдача и списание просроченного проходят — со словами
// ───────────────────────────────────────────────────────────────────────────

test('выдача товара, чья ближайшая партия просрочена, ПРОХОДИТ и несёт предупреждение', () => {
  const db = seed();
  try {
    threeLots(db);
    const before = onHand(db, 7);
    const res = issueStockLines(db, { holder: { type: 'staff', id: 4 }, lines: [{ product_id: 7, qty: 2, unit: 'base' }] }, INV);
    assert.equal(res.issued.length, 1, 'выдача не записалась — предупреждение стало отказом');
    assert.equal(onHand(db, 7), before - 2, 'склад не списался — предупреждение стало отказом');
    assert.equal(res.warnings.length, 1);
    const w = res.warnings[0];
    assert.equal(w.product_name, 'Перчатки');
    assert.equal(w.batch_no, 'A-1');
    assert.equal(w.expiry_date, shift(db, -5));
    assert.match(w.message, /Просроченная партия: Перчатки — партия A-1, срок /);
    assert.match(w.message, /Операция проведена/);
  } finally { db.close(); }
});

test('списание на пациента предупреждает так же — всеми дверями', () => {
  const db = seed();
  try {
    threeLots(db);
    const r1 = dispenseItem(db, { product_id: 7, quantity: 1, visit_id: 300 }, NURSE);
    assert.equal(r1.warnings.length, 1, 'окно визита промолчало о просроченной партии');
    assert.equal(r1.warnings[0].batch_no, 'A-1');

    const r2 = dispenseFromHolding(db, { visit_id: 300, product_id: 7, quantity: 1, holder: { type: 'warehouse' } }, NURSE);
    assert.equal(r2.warnings.length, 1, 'амбулаторная вкладка медсестры промолчала');

    // Стационар: та же партия, та же тревога.
    db.prepare("INSERT INTO wards (id, name) VALUES (1, 'Палата 1')").run();
    db.prepare("INSERT INTO beds (id, ward_id, code, status) VALUES (1, 1, 'B-1', 'occupied')").run();
    db.prepare(`INSERT INTO admissions (id, patient_id, ward_id, bed_id, status, attending_doctor_id, admitted_at)
                VALUES (77, 50, 1, 1, 'active', 3, strftime('%Y-%m-%dT%H:%M:%SZ','now'))`).run();
    const r3 = dispenseAdmissionItemCore(db, { admission_id: 77, product_id: 7, quantity: 1 }, NURSE);
    assert.equal(r3.warnings.length, 1, 'койка промолчала');
    assert.equal(r3.warnings[0].product_name, 'Перчатки');
  } finally { db.close(); }
});

test('товар без сроков в приходах не предупреждает ни о чём — тишина здесь правдива', () => {
  const db = seed();
  try {
    receiveStockLines(db, { lines: [{ product_id: 8, qty: 10, unit: 'base', unit_cost: 100 }] }, ADMIN);
    const res = issueStockLines(db, { holder: { type: 'staff', id: 4 }, lines: [{ product_id: 8, qty: 2, unit: 'base' }] }, INV);
    assert.deepEqual(res.warnings, []);
    assert.deepEqual(expiryWarnings(db, [8]), []);
    // И партия со сроком в будущем тоже молчит.
    receiveStockLines(db, { lines: [{ product_id: 7, qty: 5, unit: 'base', unit_cost: 1, batch_no: 'F-1', expiry_date: shift(db, 90) }] }, ADMIN);
    assert.deepEqual(expiryWarnings(db, [7]), []);
  } finally { db.close(); }
});

test('предупреждение НИКОГДА не становится 400 — владелец сказал предупреждать, а не запрещать', () => {
  const db = seed();
  try {
    threeLots(db);
    assert.doesNotThrow(() => issueStockLines(db, { holder: { type: 'department', id: 1 }, lines: [{ product_id: 7, qty: 1, unit: 'base' }] }, INV));
    assert.doesNotThrow(() => dispenseItem(db, { product_id: 7, quantity: 1, visit_id: 300 }, NURSE));
    // Ledger не изменился от предупреждения: движений ровно столько, сколько операций.
    const moved = db.prepare("SELECT COUNT(*) c FROM stock_movements WHERE product_id = 7 AND kind = 'dispense'").get().c;
    assert.equal(moved, 2, 'предупреждение добавило движение в журнал — оно обязано быть словом, а не записью');
  } finally { db.close(); }
});

test('повторная выдача по той же квитанции возвращает то же предупреждение, а не теряет его', () => {
  const db = seed();
  try {
    threeLots(db);
    const args = { holder: { type: 'staff', id: 4 }, lines: [{ product_id: 7, qty: 2, unit: 'base' }], idempotency_key: 'issue-abcdefgh' };
    const first = issueStockLines(db, args, INV);
    const again = issueStockLines(db, args, INV);
    assert.equal(again.repeated, true);
    assert.deepEqual(again.warnings, first.warnings);
  } finally { db.close(); }
});
