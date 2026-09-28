// OWN_SHELF_ONLY_V1 — ревью F5: «Только со своих полок» — ПЕРЕКЛЮЧАТЕЛЬ КЛИНИКИ.
//
// Владелец: «Clinics keep working as today. The admin turns it on in settings
// once the warehouse has issued stock to rooms and nurses. The settings screen
// shows what is still missing.»
//
// Этот файл прикалывает ВЫКЛЮЧЕННОЕ положение (оно — у каждой клиники, пока
// администратор не включит) к 3.12.1 (aec7b7c):
//   1. ОРАКУЛ. planSources из 3.12.1 — дословная копия ниже — против живого
//      planSources на сетке «роль × полки × склад × количество × товар
//      включён/отключён × единицы»: выключено — отказ ровно там, где отказывал
//      3.12.1, и источники те же; число склада в отказе — только тому, кто
//      склад видит. Включено — правило ветки: клиническим ролям нехватка на
//      своих полках — own_shelf_short, складу и администратору — как в 3.12.1.
//   2. КАЖДАЯ ДВЕРЬ выдачи × каждая клиническая роль: пустые и неполные полки —
//      склад добирает; склада не хватает — отказ 3.12.1, не own_shelf_short.
//   3. ЛИСТ НАЗНАЧЕНИЙ: «введено» и «расход сверх дозы» — склад добирает,
//      пустой склад — предупреждение, отметка стоит.
//   4. ОСТАТОК СКЛАДА врачу и медсестре не показывается ни при каком положении.
//   5. ПЕРЕКЛЮЧАЕТ ТОЛЬКО АДМИНИСТРАТОР — проверка на сервере; журнал: кто,
//      когда и что готовность называла недостающим; готовность считает сервер.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { compile } from '../../db/query-compiler.js';
import { getRpc } from './index.js';
import { treatmentOrderCreate, treatmentAdminMark } from './treatment-orders.js';
import { holdingChain, planSources, ownShelfOnly, warehouseAccess, OWN_SHELF_SHORT, RpcError } from './inventory.js';
import { WAREHOUSE } from './holdings.js';
import { roundQty, factorOf, coversQty, qtyTolerance, unitsOf } from '../domain/stock-qty.js';
import { isReadOnlyRpc } from '../control/gate.js';

// ─── 3.12.1 (aec7b7c) server/services/rpc/inventory.js — ДОСЛОВНО ────────────
// Эталон «как было». Менять только вместе с решением владельца.
function round2(n) {
  return Math.round(n * 100) / 100;
}
function shortfallMessage3121(product, need, onHand, found, inUnits = false) {
  const cf = inUnits ? factorOf(product) : 1;
  const unit = (inUnits && cf !== 1 ? product.consumption_unit : '') || product.base_unit || product.unit || '';
  const num = (v) => String(cf !== 1 ? unitsOf(v, cf) : round2(v));
  const tail = [];
  if (found.staff > 0) tail.push(`у вас на руках ${num(found.staff)}`);
  if (found.room > 0) tail.push(`в кабинете ${num(found.room)}`);
  if (found.department > 0) tail.push(`в отделе ${num(found.department)}`);
  const head = `Недостаточно: ${product.name} — на складе ${num(onHand)} из ${num(need)}${unit ? ` ${unit}` : ''}`;
  return `${head}; ${tail.length ? tail.join(', ') : 'на руках, в кабинете и в отделе — ничего'}.`;
}
function planSources3121(db, chain, product, quantity, opts = {}) {
  const q = db.prepare('SELECT qty FROM stock_holdings WHERE holder_type = ? AND holder_id = ? AND product_id = ?');
  const picks = [];
  const found = { staff: 0, room: 0, department: 0 };
  const cf = factorOf(product);
  const tol = qtyTolerance(cf);
  let need = roundQty(quantity);
  for (const c of chain) {
    const row = q.get(c.type, c.id, product.id);
    const have = row && row.qty > 0 ? roundQty(row.qty) : 0;
    if (!have) continue;
    found[c.type] = roundQty(found[c.type] + have);
    if (need <= 0) continue;
    const take = need <= have + tol ? Math.min(have, need) : have;
    if (take <= 0) continue;
    picks.push({ type: c.type, id: c.id, qty: take });
    need = need <= have + tol ? 0 : roundQty(need - take);
  }
  if (need > 0) {
    const onHand = roundQty(product.on_hand);
    if (!product.active) {
      throw new RpcError(`Товар «${product.name}» отключён в каталоге: со склада не выдаётся`
        + `${picks.length ? ', а на руках, в кабинете и в отделе его не хватает' : ''}.`, 400);
    }
    if (!coversQty(onHand, need, cf)) {
      throw new RpcError(shortfallMessage3121(product, quantity, onHand, found, !!opts.inUnits), 400);
    }
    picks.push({ type: WAREHOUSE, id: null, qty: Math.min(need, onHand) });
  }
  return picks;
}
// ──────────────────────────────────────────────────────────────────────────────

const U = {
  admin:    { id: 1, role: 'admin' },
  inv:      { id: 2, role: 'inventory' },
  adminDoc: { id: 3, role: 'doctor', extra_roles: ['admin'] },
  doctor:   { id: 10, role: 'doctor' },
  nurse:    { id: 11, role: 'nurse' },
  senior:   { id: 12, role: 'nurse', extra_roles: ['senior_nurse'] },
  head:     { id: 14, role: 'doctor', extra_roles: ['head_doctor'] },
  custom:   { id: 16, role: 'nurse', custom_role_code: 'proc_nurse' },
};
const CLINICAL = ['doctor', 'nurse', 'senior', 'head', 'custom'];
const WAREHOUSE_ROLES = ['admin', 'inv', 'adminDoc'];
const P = 1;   // Бинт, штука
const K = 2;   // Кеторол, коробка по 10 ампул

function seed() {
  const db = openDb(':memory:'); migrate(db);
  db.prepare("INSERT INTO departments (id, name) VALUES (30, 'Терапия'), (31, 'Хирургия')").run();
  db.prepare("INSERT INTO rooms (id, name, department_id) VALUES (20, 'Кабинет врача', 30), (21, 'Процедурный', 30), (22, 'Перевязочная', 31)").run();
  db.prepare("INSERT INTO custom_roles (code, name, base_role, active) VALUES ('proc_nurse', 'Процедурная медсестра', 'nurse', 1)").run();
  db.prepare(`INSERT INTO role_permissions (role, permissions) VALUES ('proc_nurse', '{"sections":["patients","procedures","beds"]}')`).run();
  const u = db.prepare('INSERT INTO users (id, username, password_hash, role, full_name, room_id, department_id, extra_roles, custom_role_code) VALUES (?,?,?,?,?,?,?,?,?)');
  u.run(1, 'admin', 'x', 'admin', 'Админ', null, null, '[]', null);
  u.run(2, 'inv', 'x', 'inventory', 'Кладовщик', null, null, '[]', null);
  u.run(3, 'admdoc', 'x', 'doctor', 'Администратор-врач', null, null, '["admin"]', null);
  u.run(10, 'doc', 'x', 'doctor', 'Врач Азиз', 20, 30, '[]', null);
  u.run(11, 'nurse', 'x', 'nurse', 'Медсестра Ирина', 21, 30, '[]', null);
  u.run(12, 'senior', 'x', 'nurse', 'Старшая Ольга', null, 31, '["senior_nurse"]', null);
  u.run(14, 'head', 'x', 'doctor', 'Главный врач', null, 30, '["head_doctor"]', null);
  u.run(16, 'proc', 'x', 'nurse', 'Процедурная Нигора', 21, 30, '[]', 'proc_nurse');
  db.prepare("INSERT INTO products (id, name, unit, base_unit, sale_price, on_hand, avg_cost, is_drug) VALUES (1, 'Бинт', 'шт', 'шт', 1000, 100, 400, 1)").run();
  db.prepare("INSERT INTO products (id, name, unit, base_unit, consumption_unit, consumption_factor, sale_price, on_hand, avg_cost, is_drug) VALUES (2, 'Кеторол', 'уп', 'уп', 'амп', 10, 50000, 10, 20000, 1)").run();
  db.prepare("INSERT INTO patients (id, full_name, mrn) VALUES (1, 'Иванов Иван', 'EM-1')").run();
  db.prepare("INSERT INTO wards (id, name, department_id) VALUES (1, 'Палата 1', 30)").run();
  db.prepare("INSERT INTO beds (id, code, ward_id) VALUES (1, '1-1', 1)").run();
  db.prepare("INSERT INTO services (id, name, price) VALUES (1, 'Инъекция', 20000)").run();
  return db;
}
const setOwnShelfOnly = (db, on) => db.prepare('UPDATE stock_settings SET own_shelf_only = ? WHERE id = 1').run(on ? 1 : 0);
const rpc = (db, name, args, user) => getRpc(name)(db, args, user);
const onHand = (db, pid = P) => db.prepare('SELECT on_hand FROM products WHERE id = ?').get(pid).on_hand;
const held = (db, type, id, pid = P) => (db.prepare('SELECT qty FROM stock_holdings WHERE holder_type = ? AND holder_id = ? AND product_id = ?').get(type, id, pid) || { qty: 0 }).qty;
const put = (db, type, id, qty, pid = P) => db.prepare(`INSERT INTO stock_holdings (holder_type, holder_id, product_id, qty) VALUES (?, ?, ?, ?)
  ON CONFLICT (holder_type, holder_id, product_id) DO UPDATE SET qty = excluded.qty`).run(type, id, pid, qty);
const visit = (db, roomId = 20) => Number(db.prepare("INSERT INTO visits (patient_id, doctor_id, room_id, visit_date, status) VALUES (1, 10, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'), 'arrived')").run(roomId).lastInsertRowid);
const admission = (db) => Number(db.prepare("INSERT INTO admissions (patient_id, status, ward_id, bed_id, doctor_id, attending_doctor_id) VALUES (1, 'active', 1, 1, 10, 10)").run().lastInsertRowid);
const src = (r) => (r.sources || []).map((s) => `${s.type}${s.id == null ? '' : ':' + s.id}=${s.qty}`).join(' + ');
const product = (db, pid) => db.prepare('SELECT * FROM products WHERE id = ?').get(pid);

function outcome(fn) {
  try { return { picks: fn() }; } catch (e) { return { error: e }; }
}

// 3.12.1 — число склада в отказе; F5 — без числа тому, кто склад не видит.
function maskedShortfall(message) {
  const m = /^Недостаточно: (.*) — на складе (\S+) из (\S+)((?: [^;]+)?); (.*)$/.exec(message);
  assert.ok(m, 'отказ 3.12.1 узнаётся: ' + message);
  return `Недостаточно: ${m[1]} — нужно ${m[3]}${m[4]}, на складе столько нет; ${m[5]}`;
}

// ─── 1. Оракул: выключено = 3.12.1 ────────────────────────────────────────────

const SHELVES = [
  { name: 'полки пусты', rows: [] },
  { name: 'свой подотчёт', rows: [['staff', 'me', 1]] },
  { name: 'подотчёт + кабинет + отдел', rows: [['staff', 'me', 1], ['room', 20, 2], ['room', 21, 1], ['department', 30, 3], ['department', 31, 1]] },
  { name: 'только отдел', rows: [['department', 30, 4], ['department', 31, 2]] },
];
const WAREHOUSE_STOCK = [0, 2, 100];
const QTY = { [P]: [1, 3, 6, 50], [K]: [0.1, 0.35, 1, 12] };

function gridCases() {
  const out = [];
  for (const who of [...CLINICAL, ...WAREHOUSE_ROLES]) {
    for (const place of ['visit', 'admission', 'none']) {
      for (const sh of SHELVES) {
        for (const wh of WAREHOUSE_STOCK) {
          for (const pid of [P, K]) {
            for (const active of [1, 0]) {
              for (const qty of QTY[pid]) out.push({ who, place, sh, wh, pid, active, qty, inUnits: pid === K });
            }
          }
        }
      }
    }
  }
  return out;
}

function runGrid(on) {
  const db = seed();
  setOwnShelfOnly(db, on);
  const v = visit(db, 20);
  const a = admission(db);
  const places = {
    visit: { visit: db.prepare('SELECT * FROM visits WHERE id = ?').get(v) },
    admission: { admission: db.prepare('SELECT * FROM admissions WHERE id = ?').get(a) },
    none: null,
  };
  let compared = 0; let refusedByOldToo = 0;
  for (const c of gridCases()) {
    const user = U[c.who];
    db.prepare('DELETE FROM stock_holdings').run();
    for (const [type, id, qty] of c.sh.rows) put(db, type, id === 'me' ? user.id : id, c.pid === K ? qty / 10 : qty, c.pid);
    db.prepare('UPDATE products SET on_hand = ?, active = ? WHERE id = ?').run(c.pid === K ? c.wh / 10 : c.wh, c.active, c.pid);
    const prod = product(db, c.pid);
    const chain = holdingChain(db, user, places[c.place]);
    const label = JSON.stringify({ on, who: c.who, place: c.place, shelves: c.sh.name, wh: c.wh, pid: c.pid, active: c.active, qty: c.qty });
    const ref = outcome(() => planSources3121(db, chain, prod, c.qty, { inUnits: c.inUnits }));
    const live = outcome(() => planSources(db, chain, prod, c.qty, { inUnits: c.inUnits, user }));
    const clinical = CLINICAL.includes(c.who);
    const shelvesShort = ref.error
      ? true
      : ref.picks.some((p) => p.type === WAREHOUSE);
    if (on && clinical && shelvesShort) {
      // Включено: клинической роли нехватка на своих полках — own_shelf_short
      // (склад не добирает и молчит), при любом складе и товаре.
      assert.ok(live.error, 'включено — отказ: ' + label);
      assert.equal(live.error.code, OWN_SHELF_SHORT, label + ' ' + live.error.message);
      assert.equal(live.error.status, 400, label);
    } else if (ref.error) {
      refusedByOldToo++;
      assert.ok(live.error, 'отказ 3.12.1 — и сейчас отказ: ' + label);
      assert.notEqual(live.error.code, OWN_SHELF_SHORT, label);
      assert.equal(live.error.status, 400, label);
      const sees = warehouseAccess(db, user).see;
      const expected = /^Недостаточно:/.test(ref.error.message) && !sees ? maskedShortfall(ref.error.message) : ref.error.message;
      assert.equal(live.error.message, expected, label);
    } else {
      assert.ok(!live.error, 'где 3.12.1 выдавал, выключено тоже выдаёт: ' + label + ' — ' + (live.error && live.error.message));
      assert.deepEqual(live.picks, ref.picks, label);
    }
    compared++;
  }
  db.close();
  return { compared, refusedByOldToo };
}

test('оракул: переключатель ВЫКЛЮЧЕН — отказ ровно там, где отказывал 3.12.1, источники те же (сетка роль × полки × склад × количество × товар)', () => {
  const r = runGrid(false);
  assert.ok(r.compared >= 2000, 'сетка не выродилась: ' + r.compared);
  assert.ok(r.refusedByOldToo > 100 && r.refusedByOldToo < r.compared - 100, 'в сетке есть и выдачи, и отказы 3.12.1: ' + JSON.stringify(r));
});

test('оракул: переключатель ВКЛЮЧЁН — склад и администратор как в 3.12.1; врачу и медсестре нехватка на своих полках — own_shelf_short', () => {
  const r = runGrid(true);
  assert.ok(r.compared >= 2000);
});

test('положение переключателя читает сервер; базы без таблицы (до 226) — выключено', () => {
  const db = seed();
  assert.equal(ownShelfOnly(db), false, 'новая клиника — выключен');
  setOwnShelfOnly(db, true);
  assert.equal(ownShelfOnly(db), true);
  db.exec('DROP TABLE stock_settings');
  assert.equal(ownShelfOnly(db), false, 'нет таблицы — выключен, а не 500');
  db.close();
});

// ─── 2. Каждая дверь × каждая клиническая роль, выключено ─────────────────────

const VISIT_DOORS = {
  dispense_visit_item: (db, v, qty, user, pid = P) => rpc(db, 'dispense_visit_item', { p_visit_id: v, p_item_id: pid, p_qty: qty, p_doctor_id: 10 }, user),
  dispense_item: (db, v, qty, user, pid = P) => rpc(db, 'dispense_item', { visit_id: v, product_id: pid, quantity: qty }, user),
  dispense_from_holding: (db, v, qty, user, pid = P) => rpc(db, 'dispense_from_holding', { product_id: pid, quantity: qty, visit_id: v }, user),
};
const ADM_DOORS = {
  dispense_admission_item: (db, a, qty, user, pid = P) => rpc(db, 'dispense_admission_item', { p_admission_id: a, p_item_id: pid, p_qty: qty }, user),
  dispense_from_holding: (db, a, qty, user, pid = P) => rpc(db, 'dispense_from_holding', { product_id: pid, quantity: qty, admission_id: a }, user),
};
const DOORS = [
  ...Object.entries(VISIT_DOORS).map(([name, call]) => ({ name: `${name} (визит)`, call, place: (db) => visit(db, 20) })),
  ...Object.entries(ADM_DOORS).map(([name, call]) => ({ name: `${name} (койка)`, call, place: admission })),
];

for (const door of DOORS) {
  for (const who of CLINICAL) {
    test(`выключено, ${door.name}, ${who}: полки пусты — склад выдаёт, как в 3.12.1; числа склада в ответе нет`, () => {
      const db = seed();
      const place = door.place(db);
      const r = door.call(db, place, 3, U[who]);
      assert.equal(src(r), 'warehouse=3');
      assert.equal(onHand(db), 97);
      assert.equal(r.on_hand == null, true, 'остаток склада врачу и медсестре не называется');
      const mv = db.prepare("SELECT qty, holder_type FROM stock_movements WHERE kind = 'dispense'").all();
      assert.deepEqual(mv, [{ qty: -3, holder_type: null }]);
      db.close();
    });

    test(`выключено, ${door.name}, ${who}: своего мало — своё, потом склад (одна строка, два движения)`, () => {
      const db = seed();
      const place = door.place(db);
      put(db, 'staff', U[who].id, 1);
      const r = door.call(db, place, 4, U[who]);
      assert.equal(src(r), `staff:${U[who].id}=1 + warehouse=3`);
      assert.equal(held(db, 'staff', U[who].id), 0);
      assert.equal(onHand(db), 97);
      db.close();
    });

    test(`выключено, ${door.name}, ${who}: и склада не хватает — отказ 3.12.1 «Недостаточно», не own_shelf_short; ничего не записано`, () => {
      const db = seed();
      const place = door.place(db);
      db.prepare('UPDATE products SET on_hand = 2 WHERE id = ?').run(P);
      assert.throws(() => door.call(db, place, 5, U[who]), (e) => {
        assert.equal(e.status, 400);
        assert.notEqual(e.code, OWN_SHELF_SHORT);
        assert.match(e.message, /^Недостаточно: Бинт — нужно 5 шт, на складе столько нет; /);
        return true;
      });
      assert.equal(onHand(db), 2);
      assert.equal(db.prepare('SELECT COUNT(*) n FROM visit_services').get().n + db.prepare('SELECT COUNT(*) n FROM admission_services').get().n, 0);
      db.close();
    });
  }
}

test('выключено, dispense_from_holding: «Склад», названный медсестрой, — склад, как в 3.12.1 (сначала своё)', () => {
  const db = seed();
  const v = visit(db, 20);
  put(db, 'staff', 11, 1);
  const r = rpc(db, 'dispense_from_holding', { holder: { type: 'warehouse' }, product_id: P, quantity: 3, visit_id: v }, U.nurse);
  assert.equal(src(r), 'staff:11=1 + warehouse=2');
  db.close();
});

test('выключено: holdings_list отвечает экрану «склад берёт» и врачу, и медсестре — без числа, только «есть на складе»', () => {
  const db = seed();
  const v = visit(db, 20);
  db.prepare("INSERT INTO products (id, name, unit, base_unit, sale_price, on_hand, active) VALUES (5, 'Вата', 'шт', 'шт', 500, 0, 1), (6, 'Маска', 'шт', 'шт', 500, 3, 0)").run();
  for (const k of CLINICAL) {
    const r = rpc(db, 'holdings_list', { reachable: true, visit_id: v }, U[k]);
    assert.deepEqual([r.warehouse_allowed, r.warehouse_visible, r.warehouse_in_stock], [true, false, [P, K]], k);
  }
  for (const k of ['admin', 'inv']) {
    const r = rpc(db, 'holdings_list', { reachable: true, visit_id: v }, U[k]);
    assert.deepEqual([r.warehouse_allowed, r.warehouse_visible, r.warehouse_in_stock], [true, true, undefined], k);
  }
  setOwnShelfOnly(db, true);
  for (const k of CLINICAL) {
    const r = rpc(db, 'holdings_list', { reachable: true, visit_id: v }, U[k]);
    assert.deepEqual([r.warehouse_allowed, r.warehouse_visible, r.warehouse_in_stock], [false, false, undefined], k);
  }
  db.close();
});

// ─── 3. Лист назначений, выключено ────────────────────────────────────────────

const medOrder = (db, adm, over = {}) => treatmentOrderCreate(db, {
  admission_id: adm, kind: 'med', name: 'Бинт', dose: '1', route: 'в/м', freq_code: '1x',
  starts_on: '2026-09-04', days: 1, service_id: 1, stock_item_id: P, ...over,
}, U.doctor).order;
const markGiven = (db, order, user, extra) => treatmentAdminMark(db, {
  order_id: order.id, date: '2026-09-04', slot: 10, status: 'given', ...(extra ? { extra } : {}),
}, user);

for (const who of ['nurse', 'senior', 'custom']) {
  test(`выключено, лист назначений, ${who}: полки пусты — «введено» стоит, доза и расход сверх дозы — со склада, как в 3.12.1`, () => {
    const db = seed();
    const a = admission(db);
    const m = markGiven(db, medOrder(db, a), U[who], [{ product_id: P, qty: 2, name: 'Бинт (порван)' }]);
    assert.equal(m.administration.status, 'given');
    assert.equal(m.stock.status, 'ok', JSON.stringify(m.warnings));
    assert.equal(onHand(db), 97, 'доза 1 + сверх дозы 2 — со склада');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM admission_services').get().n, 2, 'две строки начисления');
    db.close();
  });

  test(`выключено, лист назначений, ${who}: склад пуст — отметка стоит, предупреждение, строки нет (3.12.1)`, () => {
    const db = seed();
    db.prepare('UPDATE products SET on_hand = 0 WHERE id = ?').run(P);
    const a = admission(db);
    const m = markGiven(db, medOrder(db, a), U[who]);
    assert.equal(m.administration.status, 'given');
    assert.equal(m.stock.status, 'short');
    assert.ok(m.warnings.some((w) => w.code === 'stock'));
    assert.doesNotMatch(m.stock.note, /на складе 0/, 'число склада медсестре не называется');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM admission_services').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM treatment_administrations').get().n, 1);
    db.close();
  });
}

// ─── 4. Остаток склада не виден врачу и медсестре — при любом положении ──────

const PRODUCTS = { op: 'select', table: 'products', columns: 'id,name,on_hand', filters: [{ col: 'id', op: 'eq', val: P }] };
const readAs = (db, user) => { const q = compile(PRODUCTS, user, { db }); return db.prepare(q.sql).all(...q.params); };

for (const [mode, on] of [['выключен', false], ['включён', true]]) {
  test(`остаток склада (products.on_hand, ответ двери, сводка) врачу и медсестре не виден — переключатель ${mode}`, () => {
    const db = seed();
    setOwnShelfOnly(db, on);
    for (const k of CLINICAL) {
      assert.equal(readAs(db, U[k])[0].on_hand, null, k);
      assert.equal(rpc(db, 'dashboard_summary', {}, U[k]).low_stock_count, null, k);
    }
    assert.equal(readAs(db, U.inv)[0].on_hand, 100);
    const a = admission(db);
    put(db, 'staff', 11, 2);
    assert.equal(ADM_DOORS.dispense_admission_item(db, a, 1, U.nurse).on_hand, null);
    assert.equal(ADM_DOORS.dispense_admission_item(db, a, 1, U.inv).on_hand, 99);
    db.close();
  });
}

// ─── 5. Переключает только администратор; журнал; готовность ─────────────────

test('own_shelf_set: врач, медсестра, старшая, кладовщик — 403, и ничего не меняется; администратор — включает', () => {
  const db = seed();
  for (const k of [...CLINICAL, 'inv']) {
    assert.throws(() => rpc(db, 'own_shelf_set', { own_shelf_only: true }, U[k]), (e) => e.status === 403, k);
  }
  assert.equal(ownShelfOnly(db), false);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM stock_settings_log').get().n, 0, 'отказ ничего не пишет');
  assert.throws(() => rpc(db, 'own_shelf_set', { own_shelf_only: 'yes' }, U.admin), (e) => e.status === 400);
  assert.throws(() => rpc(db, 'own_shelf_set', {}, U.admin), (e) => e.status === 400);

  const r = rpc(db, 'own_shelf_set', { own_shelf_only: true }, U.admin);
  assert.equal(r.own_shelf_only, true);
  assert.equal(r.changed, true);
  assert.equal(ownShelfOnly(db), true);
  // Администратор по дополнительной роли — тоже администратор.
  const off = rpc(db, 'own_shelf_set', { own_shelf_only: false }, U.adminDoc);
  assert.equal(off.own_shelf_only, false);
  db.close();
});

test('own_shelf_set: журнал — кто, когда и что готовность называла недостающим; повтор того же — без записи', () => {
  const db = seed();
  const r = rpc(db, 'own_shelf_set', { own_shelf_only: true }, U.admin);
  assert.ok(r.missing > 0, 'в пустой клинике недостающее есть — включить всё равно можно');
  const settings = db.prepare('SELECT own_shelf_only, changed_by, changed_at FROM stock_settings WHERE id = 1').get();
  assert.equal(settings.own_shelf_only, 1);
  assert.equal(settings.changed_by, 1);
  assert.match(settings.changed_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  const log = db.prepare('SELECT own_shelf_only, changed_by, changed_at, missing FROM stock_settings_log').all();
  assert.equal(log.length, 1);
  assert.equal(log[0].own_shelf_only, 1);
  assert.equal(log[0].changed_by, 1);
  const missing = JSON.parse(log[0].missing);
  const nothing = missing.find((i) => i.key === 'staff_with_nothing');
  assert.ok(nothing && nothing.count === CLINICAL.length, JSON.stringify(missing));
  assert.ok(nothing.names.includes('Медсестра Ирина'));

  const again = rpc(db, 'own_shelf_set', { own_shelf_only: true }, U.admin);
  assert.equal(again.changed, false);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM stock_settings_log').get().n, 1, 'повтор — без записи');

  rpc(db, 'own_shelf_set', { own_shelf_only: false }, U.admin);
  const s = rpc(db, 'own_shelf_settings', {}, U.admin);
  assert.equal(s.own_shelf_only, false);
  assert.equal(s.changed_by_name, 'Админ');
  assert.equal(s.log.length, 2);
  assert.deepEqual(s.log.map((l) => [l.own_shelf_only, l.changed_by_name]), [[false, 'Админ'], [true, 'Админ']], 'новые сверху');
  assert.ok(s.log[1].missing > 0);
  db.close();
});

test('own_shelf_settings: видят администратор и склад; врачу и медсестре — 403; менять — только администратору', () => {
  const db = seed();
  assert.equal(rpc(db, 'own_shelf_settings', {}, U.admin).can_change, true);
  const inv = rpc(db, 'own_shelf_settings', {}, U.inv);
  assert.equal(inv.can_change, false, 'склад видит готовность, но не переключает');
  assert.equal(inv.own_shelf_only, false);
  for (const k of CLINICAL) assert.throws(() => rpc(db, 'own_shelf_settings', {}, U[k]), (e) => e.status === 403, k);
  db.close();
});

test('готовность считает сервер: сотрудники без кабинета и отдела, палаты и кабинеты без отдела, у кого что на полках', () => {
  const db = seed();
  db.prepare("INSERT INTO users (id, username, password_hash, role, full_name) VALUES (40, 'nomad', 'x', 'nurse', 'Медсестра Без Места')").run();
  db.prepare("INSERT INTO users (id, username, password_hash, role, full_name, is_active) VALUES (41, 'gone', 'x', 'nurse', 'Уволенная', 0)").run();
  db.prepare("INSERT INTO users (id, username, password_hash, role, full_name) VALUES (42, 'cash', 'x', 'cashier', 'Кассир')").run();
  db.prepare("INSERT INTO wards (id, name, department_id) VALUES (2, 'Палата без отдела', NULL)").run();
  db.prepare("INSERT INTO rooms (id, name, department_id) VALUES (23, 'УЗИ', NULL)").run();
  put(db, 'staff', 11, 2);          // у медсестры — на руках
  put(db, 'room', 20, 1);           // у врача — в его кабинете
  const s = rpc(db, 'own_shelf_settings', {}, U.admin).readiness;
  const item = (key) => s.items.find((i) => i.key === key);
  assert.deepEqual(item('staff_without_place').names, ['Медсестра Без Места']);
  assert.deepEqual(item('wards_without_department').names, ['Палата без отдела']);
  assert.deepEqual(item('rooms_without_department').names, ['УЗИ']);
  assert.deepEqual(item('departments_empty').names, ['Терапия', 'Хирургия']);
  // Клинические роли — врач, медсестра, старшая, главный, своя роль на основе
  // медсестры и медсестра без места; администратор (и врач-администратор),
  // склад, кассир и уволенная в готовность не входят.
  assert.equal(s.clinical_staff, 6);
  assert.equal(s.staff_with_stock, 2, 'медсестра — на руках, врач — в своём кабинете');
  assert.deepEqual(item('staff_with_nothing').names.sort(), ['Главный врач', 'Медсестра Без Места', 'Процедурная Нигора', 'Старшая Ольга'].sort());
  for (const i of s.items) assert.equal(i.count, i.names.length, i.key);
  assert.equal(s.missing, s.items.reduce((n, i) => n + i.count, 0));
  db.close();
});

test('шлюз лицензии: положение и готовность — чтение; переключить — запись', () => {
  assert.equal(isReadOnlyRpc('own_shelf_settings'), true);
  assert.equal(isReadOnlyRpc('own_shelf_set'), false);
});
