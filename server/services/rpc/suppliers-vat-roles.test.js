// SUPPLIERS_VAT_V1 (ревью F1) — ПРИХОД, ИМПОРТ, ЗАКАЗ И КАРТОЧКИ ТОВАРА И
// ПОСТАВЩИКА — ТЕМ ЖЕ, КТО ДЕЛАЛ ЭТО В 3.12.1: АДМИНИСТРАТОР И СКЛАД.
//
// Ворота «Закупки: Изменение», поставленные на эти двери в первой версии
// ветки, заперли кладовщика, чью роль сохранил старый экран «Роли»
// («Закупки: Просмотр», выдача — «Нет»: отпечаток миграции 215), —
// в 3.12.1 он принимал товар. И заперли не до конца: старый receive_stock,
// adjust_stock и прямая запись в products / suppliers / purchase_orders через
// /api/db его по-прежнему пускали.
//
// Правило обновления: ни одна роль не теряет того, что делала в 3.12.1.
// Поэтому здесь — одна проверка на все двери, и её ответ совпадает с 3.12.1
// для каждого вида роли, включая те, что хуже всего разбирает матрица прав:
// свою роль на основе администратора с «Закупки: Просмотр», врача с
// дополнительной ролью «Склад», чья основная роль видит склад только на
// просмотр, и регистратора, которому «Закупки: Изменение» выдали в матрице
// (в 3.12.1 товар он не принимал — не принимает и теперь, иначе /api/db и
// receive_stock ответили бы ему иначе, чем приход).
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { compile } from '../../db/query-compiler.js';
import { getRpc } from './index.js';

const OLD_SCREEN_INVENTORY = { sections: ['inventory'], levels: { inventory: 'viewer' }, grants: { procurement: 'view', 'procurement.issue': 'none' } };

const USERS = {
  admin:        { user: { id: 1, role: 'admin', extra_roles: [] }, allowed: true },
  inventory:    { user: { id: 2, role: 'inventory', extra_roles: [] }, allowed: true },
  customAdmin:  { user: { id: 3, role: 'admin', extra_roles: [], custom_role_code: 'senior_admin' }, allowed: true },
  doctorInv:    { user: { id: 4, role: 'doctor', extra_roles: ['inventory'] }, allowed: true },
  registrarEdit:{ user: { id: 5, role: 'registrar', extra_roles: [] }, allowed: false },
  nurse:        { user: { id: 6, role: 'nurse', extra_roles: [] }, allowed: false },
};

function seed() {
  const db = openDb(':memory:');
  migrate(db);
  const u = db.prepare("INSERT INTO users (id, username, password_hash, role, full_name) VALUES (?, ?, 'x', ?, ?)");
  for (const [k, { user }] of Object.entries(USERS)) u.run(user.id, k, user.role, k);
  const perms = db.prepare('INSERT OR REPLACE INTO role_permissions (role, permissions) VALUES (?, ?)');
  perms.run('inventory', JSON.stringify(OLD_SCREEN_INVENTORY));
  perms.run('senior_admin', JSON.stringify({ sections: ['inventory'], levels: { inventory: 'viewer' }, grants: { procurement: 'view' } }));
  perms.run('doctor', JSON.stringify({ sections: ['inventory'], levels: { inventory: 'viewer' }, grants: { procurement: 'view' } }));
  perms.run('registrar', JSON.stringify({ sections: ['inventory'], levels: { inventory: 'editor' }, grants: { procurement: 'edit' } }));
  const S = Number(db.prepare("INSERT INTO suppliers (name) VALUES ('ООО Аптека')").run().lastInsertRowid);
  const P = Number(db.prepare("INSERT INTO products (name, base_unit, procurement_category) VALUES ('Бинт', 'шт', 'consumables')").run().lastInsertRowid);
  return { db, S, P };
}

const ADMIN = USERS.admin.user;
let seq = 0;
const uniq = (s) => `${s} ${++seq}`;

/** Пускает ли дверь: true — прошла, false — 403. Любой другой отказ — ошибка теста. */
function verdict(fn) {
  try { fn(); return true; } catch (e) {
    if (e && e.status === 403) return false;
    throw e;
  }
}

function doors(db, S, P) {
  const rpc = (name, args) => (user) => getRpc(name)(db, args(), user);
  const api = (table, op, values, filters) => (user) => {
    const q = compile({ table, op, values, filters: filters || [] }, user, { db });
    db.prepare(q.sql).run(...q.params);
  };
  return {
    receive_stock_lines: rpc('receive_stock_lines', () => ({ lines: [{ product_id: P, qty: 1, unit_cost: 10 }] })),
    receive_stock: rpc('receive_stock', () => ({ product_id: P, quantity: 1, unit_cost: 10 })),
    adjust_stock: rpc('adjust_stock', () => ({ product_id: P, qty: 1, note: 'пересчёт' })),
    product_save: rpc('product_save', () => ({ name: uniq('Шприц'), procurement_category: 'consumables', vat_rate: 12 })),
    supplier_save: rpc('supplier_save', () => ({ name: uniq('ООО Поставщик') })),
    purchase_order_create: rpc('purchase_order_create', () => ({ supplier_id: S, lines: [{ product_id: P, qty: 1, unit_cost: 5 }] })),
    receive_purchase_order: (user) => {
      const po = getRpc('purchase_order_create')(db, { supplier_id: S, lines: [{ product_id: P, qty: 1, unit_cost: 5 }] }, ADMIN);
      getRpc('receive_purchase_order')(db, { po_id: po.po_id }, user);
    },
    import_products_excel: rpc('import_products_excel', () => ({ rows: [{ name: uniq('Перчатки'), category: 'Расходники' }] })),
    'api products insert': api('products', 'insert', { name: 'Вата' }),
    'api products update': api('products', 'update', { supplier_id: S, pack_factor: 10 }, [{ col: 'id', op: 'eq', val: P }]),
    'api suppliers insert': api('suppliers', 'insert', { name: 'ООО Новый' }),
    'api purchase_orders insert': api('purchase_orders', 'insert', { po_number: 'PO-X', supplier_id: S }),
  };
}

test('ревью F1: приход, импорт, заказ, карточки — кого пускала 3.12.1, того и сейчас; все двери отвечают одинаково', () => {
  const { db, S, P } = seed();
  try {
    const all = doors(db, S, P);
    for (const [who, { user, allowed }] of Object.entries(USERS)) {
      for (const [door, fn] of Object.entries(all)) {
        seq++;
        const got = verdict(() => fn(user));
        assert.equal(got, allowed, `${who} → ${door}: ${got ? 'пускает' : 'отказ'}, а в 3.12.1 — ${allowed ? 'пускала' : 'отказ'}`);
      }
    }
  } finally { db.close(); }
});

test('ревью F1: отказ — прежними словами роли (как в 3.12.1), без ссылки на матрицу прав', () => {
  const { db, S, P } = seed();
  try {
    const nurse = USERS.nurse.user;
    for (const [name, args] of [
      ['receive_stock_lines', { lines: [{ product_id: P, qty: 1, unit_cost: 1 }] }],
      ['product_save', { name: 'Х', procurement_category: 'consumables', vat_rate: 12 }],
      ['supplier_save', { name: 'Y' }],
      ['purchase_order_create', { supplier_id: S, lines: [{ product_id: P, qty: 1 }] }],
      ['import_products_excel', { rows: [{ name: 'Z', category: 'Расходники' }] }],
    ]) {
      assert.throws(() => getRpc(name)(db, args, nurse), (e) => e.status === 403 && e.message === 'Ваша роль не может выполнить это действие.', name);
    }
    assert.equal(db.prepare('SELECT COUNT(*) n FROM stock_movements').get().n, 0, 'из отказов ничего не записано');
  } finally { db.close(); }
});
