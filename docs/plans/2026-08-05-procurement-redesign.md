# Procurement (Закупки) Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the local Закупки workspace to match the cloud easymed.uz procurement design — Склад stock table (filters, low-stock ⚠, OK/Reorder flags, Excel export/template/import, Принять/Выдать/Корректировка) plus Товары, Поставщики, Журнал, Дашборд; Заявки/Заказы/Отделения/Сроки годности/Инвентаризация as «Во 2-й фазе» placeholders.

**Architecture:** Spec: `docs/specs/2026-08-05-procurement-redesign-design.md`. The single-file view `public/js/admin/views/inventory.js` is split into a shell (chips + tabs + Дашборд + Журнал) plus three tab modules and a shared-helpers module. Server side: one migration (suppliers + products.supplier_id), two new transactional RPCs (`issue_stock_lines`, `import_products_excel`), schema-registry allow-list entries. `on_hand`/`avg_cost` remain writable only via RPCs.

**Tech Stack:** Vanilla ES modules (no build step), `h()` DOM builder from `public/js/admin/ui.js`, compat layer (`supabase.from(...)` → POST `/api/db` gated by `server/db/schema-registry.js`; `supabase.rpc(...)` → `/api/rpc/:name`), better-sqlite3, `node --test`, vendored SheetJS at `public/js/vendor/xlsx-0.20.3.mjs`.

---

## Context for the implementer (read first)

- **Everything is offline/local.** Never add a CDN import (the old `reports-export.js` uses `esm.sh` — that is parked cloud code; do NOT copy that pattern). Use `await import('../../vendor/xlsx-0.20.3.mjs')` for Excel.
- **UI language is Russian** for this workspace (matches the cloud screenshot and recently converted modules).
- **A parallel session is working in this repo.** Its current uncommitted files: `public/js/admin/views/patient-card.js`, `registration.js`, `service-workspace.js` (may change). Therefore:
  - Work in an **isolated git worktree** (Task 1).
  - `git add` ONLY the explicit paths listed in each commit step. NEVER `git add -A`, `-u`, or `.`.
- **Existing RPC/test/registry patterns** to mirror: `server/services/rpc/procurement.js` (+ `.test.js`), `server/db/migrations/016.test.js`, `server/db/schema-registry.js`.
- Run tests with `npm test` (this runs `node --test`, auto-discovering `*.test.js`). All tests currently pass.
- `products.consumption_factor` semantics: **consumption units per base unit** (e.g. base «флакон», consumption «мл», factor 50). `pack_factor`: base units per purchase unit.
- Movement sign convention in `stock_movements.qty`: receive/void positive, dispense negative, adjust either way.
- The route `case 'procurement'` in admin.js (parked cloud view) is untouched; our workspace is the `case 'inventory'` route.

### File map (what this plan creates/modifies)

| File | Role |
|---|---|
| `server/db/migrations/017_suppliers.sql` (create) | suppliers table + `products.supplier_id` |
| `server/db/migrations/017.test.js` (create) | migration test |
| `server/db/schema-registry.js` (modify) | suppliers entry; products supplier_id + embed; stock_movements users embed |
| `server/db/schema-registry.test.js` (modify) | registry assertions |
| `server/services/rpc/procurement.js` (modify) | add `issueStockLines`, `importProductsExcel` |
| `server/services/rpc/procurement.test.js` (modify) | RPC tests |
| `server/services/rpc/index.js` (modify) | register the two RPCs |
| `public/css/admin-views.css` (modify) | `.proc-tabs` underline tab styles |
| `public/js/admin/views/inventory-shared.js` (create) | helpers shared by all Закупки modules |
| `public/js/admin/views/inventory-products.js` (create) | «Товары» tab + Принять/Корректировка modals (RU) |
| `public/js/admin/views/inventory-sklad.js` (create) | «Склад» tab + Выдать modal + Excel export/шаблон/импорт |
| `public/js/admin/views/inventory-suppliers.js` (create) | «Поставщики» tab |
| `public/js/admin/views/inventory.js` (rewrite) | shell: chips + tabs + Дашборд + Журнал (RU) |
| `public/js/admin.js` (modify, 1 line) | bump `?v=` on the inventory.js import |
| `public/admin.html` (modify, 1 line) | bump `?v=` on admin-views.css |

---

### Task 1: Isolated worktree + baseline

**Files:** none (environment setup)

- [ ] **Step 1: Create the worktree and branch**

Use the superpowers:using-git-worktrees skill. Fallback commands (from the repo root `easymed.uz/`):

```bash
git worktree add ../easymed-procurement -b phase15-procurement
cd ../easymed-procurement
```

All subsequent tasks run inside `../easymed-procurement`.

- [ ] **Step 2: Install dependencies in the worktree**

Run: `npm install`
Expected: completes without errors (better-sqlite3 builds/downloads its native binding).

- [ ] **Step 3: Baseline test run**

Run: `npm test`
Expected: all tests pass, 0 failing. If anything fails, STOP and report — do not start on a broken baseline.

---

### Task 2: Migration `017_suppliers.sql`

**Files:**
- Create: `server/db/migrations/017.test.js`
- Create: `server/db/migrations/017_suppliers.sql`

- [ ] **Step 1: Write the failing test**

Create `server/db/migrations/017.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

test('017 creates suppliers and links products.supplier_id', () => {
  const db = openDb(':memory:'); migrate(db);

  const cols = db.prepare('PRAGMA table_info(suppliers)').all().map(c => c.name);
  for (const c of ['id', 'name', 'contact', 'phone', 'note', 'active', 'created_at']) {
    assert.ok(cols.includes(c), 'suppliers has ' + c);
  }
  const pcols = db.prepare('PRAGMA table_info(products)').all().map(c => c.name);
  assert.ok(pcols.includes('supplier_id'), 'products has supplier_id');

  // FK wiring + defaults
  const sid = db.prepare("INSERT INTO suppliers (name) VALUES ('ООО Медснаб')").run().lastInsertRowid;
  const pid = db.prepare("INSERT INTO products (name, unit, supplier_id) VALUES ('Шприц 5мл','шт',?)").run(sid).lastInsertRowid;
  assert.equal(db.prepare('SELECT supplier_id FROM products WHERE id=?').get(pid).supplier_id, sid);

  const s = db.prepare('SELECT * FROM suppliers WHERE id=?').get(sid);
  assert.equal(s.active, 1);
  assert.equal(s.contact, '');
  assert.ok(s.created_at);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --test server/db/migrations/017.test.js`
Expected: FAIL — `suppliers has id` assertion (PRAGMA on a missing table returns no rows).

- [ ] **Step 3: Write the migration**

Create `server/db/migrations/017_suppliers.sql`:

```sql
-- PROCUREMENT_REDESIGN_V1 — supplier catalog («Поставщики» tab) and a single
-- primary supplier per product (plain FK; the cloud's item_suppliers
-- many-to-many price list is out of scope for phase 1).
CREATE TABLE suppliers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  contact    TEXT NOT NULL DEFAULT '',
  phone      TEXT NOT NULL DEFAULT '',
  note       TEXT NOT NULL DEFAULT '',
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

ALTER TABLE products ADD COLUMN supplier_id INTEGER REFERENCES suppliers(id);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test server/db/migrations/017.test.js`
Expected: PASS (1 test).

- [ ] **Step 5: Full suite + commit**

Run: `npm test` — expected: all pass.

```bash
git add server/db/migrations/017_suppliers.sql server/db/migrations/017.test.js
git commit -m "feat: suppliers table + products.supplier_id (migration 017)"
```

---

### Task 3: Schema-registry allow-list entries

**Files:**
- Modify: `server/db/schema-registry.js` (products entry ~line 107, stock_movements entry ~line 118)
- Modify: `server/db/schema-registry.test.js` (append test)

- [ ] **Step 1: Write the failing test**

Append to `server/db/schema-registry.test.js`:

```js
test('procurement registry: suppliers CRUD for admin/inventory; products.supplier_id + embeds', () => {
  // suppliers: everyone reads, admin/inventory write, nobody deletes (deactivate instead)
  assert.ok(canRead('suppliers', 'registrar'));
  assert.ok(canWrite('suppliers', 'insert', 'admin'));
  assert.ok(canWrite('suppliers', 'insert', 'inventory'));
  assert.ok(canWrite('suppliers', 'update', 'inventory'));
  assert.ok(!canWrite('suppliers', 'insert', 'doctor'));
  assert.ok(!canWrite('suppliers', 'delete', 'admin'));

  // products gained supplier_id everywhere + a suppliers embed
  assert.ok(readableColumns('products').includes('supplier_id'));
  assert.ok(writableColumns('products', 'insert').includes('supplier_id'));
  assert.ok(writableColumns('products', 'update').includes('supplier_id'));
  assert.ok(filterAllowed('products', 'supplier_id'));
  assert.equal(embedEntry('products', 'suppliers').fk, 'supplier_id');

  // Журнал needs "who" — users embed on stock_movements, and reference_type filter
  assert.equal(embedEntry('stock_movements', 'users').fk, 'created_by');
  assert.equal(embedEntry('stock_movements', 'users').table, 'users');
  assert.ok(filterAllowed('stock_movements', 'reference_type'));
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --test server/db/schema-registry.test.js`
Expected: FAIL — `canRead('suppliers', ...)` is false (unknown table).

- [ ] **Step 3: Edit the registry**

In `server/db/schema-registry.js`, replace the whole `products:` entry with:

```js
  products: {
    read:  { roles: ALL_STAFF, columns: ['id','name','code','unit','category','sale_price','on_hand','reorder_level','active','created_at','updated_at',
             'base_unit','purchase_unit','pack_factor','consumption_unit','consumption_factor','is_drug','avg_cost','track_batches','procurement_category','supplier_id'] },
    write: { insert: { roles: ['admin','inventory'], columns: ['name','code','unit','category','sale_price','reorder_level','active',
                'base_unit','purchase_unit','pack_factor','consumption_unit','consumption_factor','is_drug','track_batches','procurement_category','supplier_id'] },
             update: { roles: ['admin','inventory'], columns: ['name','code','unit','category','sale_price','reorder_level','active',
                'base_unit','purchase_unit','pack_factor','consumption_unit','consumption_factor','is_drug','track_batches','procurement_category','supplier_id'] },
             delete: { roles: [] } },
    filters: ['id','active','category','code','name','procurement_category','is_drug','supplier_id'],
    embed:   { suppliers: { table:'suppliers', fk:'supplier_id', columns:['id','name','active'] } },
  },
```

Replace the whole `stock_movements:` entry with:

```js
  stock_movements: {
    read:  { roles: ALL_STAFF, columns: ['id','product_id','kind','qty','unit_cost','reference_type','reference_id','note','created_by','created_at'] },
    write: { insert: { roles: [] }, update: { roles: [] }, delete: { roles: [] } },
    filters: ['id','product_id','kind','reference_type'],
    embed:   { products: { table:'products', fk:'product_id', columns:['id','name','unit','base_unit'] },
               users:    { table:'users',    fk:'created_by', columns:['id','full_name','username'] } },
  },
```

Immediately after the `stock_movements:` entry, add:

```js
  suppliers: {   // PROCUREMENT_REDESIGN_V1 — supplier catalog («Поставщики» tab)
    read:  { roles: ALL_STAFF, columns: ['id','name','contact','phone','note','active','created_at'] },
    write: { insert: { roles: ['admin','inventory'], columns: ['name','contact','phone','note','active'] },
             update: { roles: ['admin','inventory'], columns: ['name','contact','phone','note','active'] },
             delete: { roles: [] } },
    filters: ['id','active','name'],
    embed:   {},
  },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test server/db/schema-registry.test.js`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Full suite + commit**

Run: `npm test` — expected: all pass.

```bash
git add server/db/schema-registry.js server/db/schema-registry.test.js
git commit -m "feat: registry — suppliers table, products.supplier_id + supplier/users embeds"
```

---

### Task 4: RPC `issue_stock_lines`

**Files:**
- Modify: `server/services/rpc/procurement.js` (append)
- Modify: `server/services/rpc/procurement.test.js` (append)
- Modify: `server/services/rpc/index.js`

- [ ] **Step 1: Write the failing tests**

In `server/services/rpc/procurement.test.js`, change the import line to (only `issueStockLines` for now — `importProductsExcel` is added in Task 5):

```js
import { receiveStockLines, adjustStock, issueStockLines } from './procurement.js';
```

Append tests:

```js
test('issue_stock_lines converts consumption->base, decrements stock, records recipient', () => {
  const { db, prod } = seed();
  // held in флаконы; 1 флакон = 50 мл расхода
  db.prepare("UPDATE products SET base_unit='флакон', consumption_unit='мл', consumption_factor=50, on_hand=10, avg_cost=2000 WHERE id=?").run(prod);

  const r = issueStockLines(db, {
    lines: [{ product_id: prod, qty: 100, unit: 'consumption' }],   // 100 мл = 2 флакона
    recipient: 'Процедурный кабинет',
    note: 'капельницы',
  }, inv);
  assert.equal(r.issued.length, 1);
  assert.equal(r.issued[0].base_qty, 2);
  assert.equal(r.issued[0].on_hand, 8);
  assert.equal(db.prepare('SELECT on_hand FROM products WHERE id=?').get(prod).on_hand, 8);

  const m = db.prepare("SELECT * FROM stock_movements WHERE reference_type='issue'").get();
  assert.equal(m.kind, 'dispense');
  assert.equal(m.qty, -2);                      // dispense is negative
  assert.equal(m.unit_cost, 2000);              // costed at avg_cost
  assert.match(m.note, /Процедурный кабинет/);  // recipient lives in the note
  assert.match(m.note, /капельницы/);
  assert.equal(m.created_by, inv.id);
});

test('issue_stock_lines: base-unit issue and consumption default when no consumption unit set', () => {
  const { db, prod } = seed();   // Paracetamol: no consumption_unit, factor 1
  receiveStockLines(db, { lines: [{ product_id: prod, qty: 20, unit: 'base', unit_cost: 100 }] }, inv);

  const r1 = issueStockLines(db, { lines: [{ product_id: prod, qty: 5, unit: 'base' }], recipient: 'Лаборатория' }, inv);
  assert.equal(r1.issued[0].base_qty, 5);
  assert.equal(r1.issued[0].on_hand, 15);

  // unit omitted -> 'consumption'; with no consumption_unit the factor is 1
  const r2 = issueStockLines(db, { lines: [{ product_id: prod, qty: 3 }], recipient: 'Лаборатория' }, inv);
  assert.equal(r2.issued[0].base_qty, 3);
  assert.equal(r2.issued[0].on_hand, 12);
});

test('issue_stock_lines rejects overdraw atomically, missing recipient, bad role', () => {
  const { db, prod } = seed();
  receiveStockLines(db, { lines: [{ product_id: prod, qty: 5, unit: 'base', unit_cost: 100 }] }, inv);

  // two lines, second overdraws -> nothing from EITHER line is committed
  assert.throws(() => issueStockLines(db, {
    lines: [{ product_id: prod, qty: 2, unit: 'base' }, { product_id: prod, qty: 100, unit: 'base' }],
    recipient: 'Лаборатория',
  }, inv), /Недостаточно/);
  assert.equal(db.prepare('SELECT on_hand FROM products WHERE id=?').get(prod).on_hand, 5);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM stock_movements WHERE reference_type='issue'").get().n, 0);

  assert.throws(() => issueStockLines(db, { lines: [{ product_id: prod, qty: 1 }], recipient: '' }, inv), /recipient/i);
  assert.throws(() => issueStockLines(db, { lines: [{ product_id: prod, qty: 1 }] }, inv), /recipient/i);
  assert.throws(() => issueStockLines(db, { lines: [], recipient: 'X' }, inv), /lines/i);
  assert.throws(() => issueStockLines(db, { lines: [{ product_id: prod, qty: 1 }], recipient: 'X' }, doc), /(role|allow)/i);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test server/services/rpc/procurement.test.js`
Expected: FAIL — `SyntaxError: The requested module './procurement.js' does not provide an export named 'issueStockLines'`.

- [ ] **Step 3: Implement the RPC**

Append to `server/services/rpc/procurement.js`:

```js
// ---------------------------------------------------------------------------
// issue_stock_lines — «Выдать»: warehouse issue to a department/person without
// a visit. Multi-line, all-or-nothing. qty may be given in 'consumption'
// units (converted via consumption_factor = consumption units per base unit,
// only when the product actually has a consumption_unit) or 'base' units.
// Writes kind 'dispense' / reference_type 'issue', recipient in the note.
// ---------------------------------------------------------------------------
const ISSUE_UNITS = ['base', 'consumption'];

export function issueStockLines(db, args, user) {
  requireRole(user, PROCUREMENT_ROLES);

  const recipient = (args && typeof args.recipient === 'string') ? args.recipient.trim() : '';
  if (!recipient) {
    throw new RpcError('recipient is required.', 400);
  }
  const extraNote = (args && typeof args.note === 'string') ? args.note.trim() : '';

  const rawLines = args && args.lines;
  if (!Array.isArray(rawLines) || rawLines.length === 0) {
    throw new RpcError('lines must be a non-empty array.', 400);
  }
  const lines = rawLines.map(line => {
    if (!line || typeof line !== 'object') {
      throw new RpcError('each line must be an object.', 400);
    }
    if (!isPositiveInt(line.product_id)) {
      throw new RpcError('product_id must be a positive integer.', 400);
    }
    const qty = line.qty;
    if (!(typeof qty === 'number' && Number.isFinite(qty) && qty > 0 && qty <= MAX_QTY)) {
      throw new RpcError(`qty must be a positive number up to ${MAX_QTY}.`, 400);
    }
    const unit = line.unit === undefined ? 'consumption' : line.unit;
    if (!ISSUE_UNITS.includes(unit)) {
      throw new RpcError(`unit must be one of ${ISSUE_UNITS.join(', ')}.`, 400);
    }
    return { productId: line.product_id, qty, unit };
  });

  const note = extraNote ? `${recipient} — ${extraNote}` : recipient;

  const run = db.transaction(() => {
    const getProduct = db.prepare('SELECT * FROM products WHERE id = ?');
    const updateProduct = db.prepare(`
      UPDATE products
      SET on_hand = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
      WHERE id = ?
    `);
    const insertMovement = db.prepare(`
      INSERT INTO stock_movements (product_id, kind, qty, unit_cost, reference_type, note, created_by, branch_id)
      VALUES (?, 'dispense', ?, ?, 'issue', ?, ?, 1)
    `);

    const issued = [];
    for (const { productId, qty, unit } of lines) {
      const product = getProduct.get(productId);
      if (!product) {
        throw new RpcError('product not found.', 400);
      }

      const cf = (product.consumption_unit && product.consumption_factor > 0) ? product.consumption_factor : 1;
      const baseQty = round2(unit === 'consumption' ? qty / cf : qty);
      if (!(baseQty > 0)) {
        throw new RpcError('qty is too small to issue.', 400);
      }
      if (product.on_hand < baseQty) {
        throw new RpcError(
          `Недостаточно остатка: ${product.name} (в наличии ${product.on_hand} ${product.base_unit || ''})`.trim(), 400);
      }

      const newOnHand = round2(product.on_hand - baseQty);
      updateProduct.run(newOnHand, productId);
      insertMovement.run(productId, -baseQty, product.avg_cost, note, user.id);
      issued.push({ product_id: productId, base_qty: baseQty, on_hand: newOnHand });
    }
    return { issued };
  });

  return run();
}
```

- [ ] **Step 4: Register the RPC**

In `server/services/rpc/index.js`, change the procurement import to:

```js
import { receiveStockLines, adjustStock, issueStockLines } from './procurement.js';
```

and add to the `RPC` object (after `adjust_stock`):

```js
  issue_stock_lines:        (db, args, user) => issueStockLines(db, args, user),
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test server/services/rpc/procurement.test.js`
Expected: PASS (all tests in the file).

- [ ] **Step 6: Full suite + commit**

Run: `npm test` — expected: all pass.

```bash
git add server/services/rpc/procurement.js server/services/rpc/procurement.test.js server/services/rpc/index.js
git commit -m "feat: issue_stock_lines RPC — warehouse issue with unit conversion, no negative stock"
```

---

### Task 5: RPC `import_products_excel`

**Files:**
- Modify: `server/services/rpc/procurement.js` (append)
- Modify: `server/services/rpc/procurement.test.js` (append)
- Modify: `server/services/rpc/index.js`

- [ ] **Step 1: Write the failing tests**

In `server/services/rpc/procurement.test.js`, extend the import line to:

```js
import { receiveStockLines, adjustStock, issueStockLines, importProductsExcel } from './procurement.js';
```

Append tests:

```js
test('import_products_excel creates, updates, receives with WAC, auto-creates suppliers', () => {
  const { db } = seed();
  const r1 = importProductsExcel(db, { rows: [
    { name: 'Шприц 5мл', unit: 'шт', qty: 100, unit_cost: 500, reorder_level: 20, supplier: 'ООО Медснаб' },
    { name: 'Бинт 7м', unit: 'шт' },   // catalog-only row: no qty -> no movement
  ] }, inv);
  assert.deepEqual(r1, { created: 2, updated: 0, received: 1 });

  const p = db.prepare("SELECT * FROM products WHERE name='Шприц 5мл'").get();
  assert.equal(p.on_hand, 100);
  assert.equal(p.avg_cost, 500);
  assert.equal(p.reorder_level, 20);
  assert.equal(p.base_unit, 'шт');
  assert.equal(p.active, 1);

  const s = db.prepare("SELECT * FROM suppliers WHERE name='ООО Медснаб'").get();
  assert.ok(s, 'supplier auto-created');
  assert.equal(p.supplier_id, s.id);

  const m = db.prepare("SELECT * FROM stock_movements WHERE reference_type='import'").get();
  assert.equal(m.kind, 'receive');
  assert.equal(m.qty, 100);
  assert.equal(m.unit_cost, 500);

  // re-import same name -> update path, WAC over the top-up, supplier kept
  const r2 = importProductsExcel(db, { rows: [{ name: 'Шприц 5мл', qty: 100, unit_cost: 700 }] }, inv);
  assert.deepEqual(r2, { created: 0, updated: 1, received: 1 });
  const p2 = db.prepare("SELECT * FROM products WHERE name='Шприц 5мл'").get();
  assert.equal(p2.on_hand, 200);
  assert.equal(p2.avg_cost, 600);      // (500*100 + 700*100) / 200
  assert.equal(p2.supplier_id, s.id);  // not resent -> unchanged
  assert.equal(db.prepare('SELECT COUNT(*) n FROM suppliers').get().n, 1);  // no duplicate supplier
});

test('import_products_excel aborts the whole batch on a bad row, names the Excel row number', () => {
  const { db } = seed();
  // data row i has Excel row number i+2 (row 1 is the header)
  assert.throws(() => importProductsExcel(db, { rows: [
    { name: 'Товар А', qty: 5 },
    { name: '', qty: 3 },
  ] }, inv), /Строка 3/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM products WHERE name='Товар А'").get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM stock_movements').get().n, 0);

  assert.throws(() => importProductsExcel(db, { rows: [{ name: 'X', qty: -1 }] }, inv), /Строка 2/);
  assert.throws(() => importProductsExcel(db, { rows: [] }, inv), /rows/i);
  assert.throws(() => importProductsExcel(db, { rows: [{ name: 'X' }] }, doc), /(role|allow)/i);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test server/services/rpc/procurement.test.js`
Expected: FAIL — missing export `importProductsExcel`.

- [ ] **Step 3: Implement the RPC**

Append to `server/services/rpc/procurement.js`:

```js
// ---------------------------------------------------------------------------
// import_products_excel — «Импорт из Excel»: one transaction over template
// rows. Match by EXACT product name: update catalog fields, or create the
// product; a positive qty becomes a 'receive' movement with weighted-average
// costing (same math as receive_stock_lines). Unknown supplier names are
// created. Any invalid row aborts the whole batch, naming its Excel row
// (data row i -> Excel row i+2; row 1 is the template header).
// ---------------------------------------------------------------------------
const MAX_IMPORT_ROWS = 2000;

function importStr(v) {
  return (v === undefined || v === null) ? '' : String(v).trim();
}

function importNum(v, label, rowNo) {
  if (v === undefined || v === null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.').replace(/\s/g, ''));
  if (!Number.isFinite(n) || n < 0 || n > MAX_QTY) {
    throw new RpcError(`Строка ${rowNo}: «${label}» должно быть числом от 0 до ${MAX_QTY}.`, 400);
  }
  return n;
}

export function importProductsExcel(db, args, user) {
  requireRole(user, PROCUREMENT_ROLES);

  const rows = args && args.rows;
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new RpcError('rows must be a non-empty array.', 400);
  }
  if (rows.length > MAX_IMPORT_ROWS) {
    throw new RpcError(`Не больше ${MAX_IMPORT_ROWS} строк за один импорт.`, 400);
  }

  const run = db.transaction(() => {
    const findSupplier = db.prepare('SELECT id FROM suppliers WHERE name = ?');
    const insertSupplier = db.prepare('INSERT INTO suppliers (name) VALUES (?)');
    const findProduct = db.prepare('SELECT * FROM products WHERE name = ?');
    const insertProduct = db.prepare(`
      INSERT INTO products (name, unit, base_unit, reorder_level, supplier_id, procurement_category, active)
      VALUES (?, ?, ?, ?, ?, 'consumables', 1)
    `);
    const updateCatalog = db.prepare(`
      UPDATE products
      SET base_unit = ?, unit = ?, reorder_level = ?, supplier_id = ?,
          updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
      WHERE id = ?
    `);
    const updateStock = db.prepare(`
      UPDATE products
      SET on_hand = ?, avg_cost = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
      WHERE id = ?
    `);
    const insertMovement = db.prepare(`
      INSERT INTO stock_movements (product_id, kind, qty, unit_cost, reference_type, note, created_by, branch_id)
      VALUES (?, 'receive', ?, ?, 'import', 'Импорт из Excel', ?, 1)
    `);

    let created = 0, updated = 0, received = 0;
    rows.forEach((row, i) => {
      const rowNo = i + 2;
      if (!row || typeof row !== 'object') {
        throw new RpcError(`Строка ${rowNo}: пустая строка.`, 400);
      }
      const name = importStr(row.name);
      if (!name) {
        throw new RpcError(`Строка ${rowNo}: «Название» обязательно.`, 400);
      }
      const unit = importStr(row.unit);
      const supplierName = importStr(row.supplier);
      const qty = importNum(row.qty, 'Кол-во', rowNo);
      const unitCost = importNum(row.unit_cost, 'Себестоимость', rowNo);
      const reorder = importNum(row.reorder_level, 'Мин. остаток', rowNo);

      let supplierId = null;
      if (supplierName) {
        const found = findSupplier.get(supplierName);
        supplierId = found ? found.id : insertSupplier.run(supplierName).lastInsertRowid;
      }

      const existing = findProduct.get(name);
      if (existing) {
        updateCatalog.run(
          unit || existing.base_unit,
          unit || existing.unit,
          reorder !== null ? reorder : existing.reorder_level,
          supplierId !== null ? supplierId : existing.supplier_id,
          existing.id,
        );
        updated++;
      } else {
        const u = unit || 'pcs';
        insertProduct.run(name, u, u, reorder !== null ? reorder : 0, supplierId);
        created++;
      }

      if (qty !== null && qty > 0) {
        const product = findProduct.get(name);   // fresh row after the catalog write
        const cost = unitCost !== null ? unitCost : 0;
        const newOnHand = round2(product.on_hand + qty);
        if (!Number.isFinite(newOnHand)) {
          throw new RpcError(`Строка ${rowNo}: остаток вне диапазона.`, 400);
        }
        const newAvg = newOnHand > 0
          ? round2((product.avg_cost * product.on_hand + qty * cost) / newOnHand)
          : product.avg_cost;
        updateStock.run(newOnHand, newAvg, product.id);
        insertMovement.run(product.id, qty, cost, user.id);
        received++;
      }
    });

    return { created, updated, received };
  });

  return run();
}
```

- [ ] **Step 4: Register the RPC**

In `server/services/rpc/index.js`, change the procurement import to:

```js
import { receiveStockLines, adjustStock, issueStockLines, importProductsExcel } from './procurement.js';
```

and add to the `RPC` object (after `issue_stock_lines`):

```js
  import_products_excel:    (db, args, user) => importProductsExcel(db, args, user),
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test server/services/rpc/procurement.test.js`
Expected: PASS.

- [ ] **Step 6: Full suite + commit**

Run: `npm test` — expected: all pass.

```bash
git add server/services/rpc/procurement.js server/services/rpc/procurement.test.js server/services/rpc/index.js
git commit -m "feat: import_products_excel RPC — all-or-nothing upsert + WAC receive, row-numbered errors"
```

---

### Task 6: Tab CSS + shared helpers module

**Files:**
- Modify: `public/css/admin-views.css` (append at end)
- Create: `public/js/admin/views/inventory-shared.js`

No behavior change yet — nothing imports the new module until Task 10.

- [ ] **Step 1: Append tab styles to `public/css/admin-views.css`**

```css
/* ---- PROCUREMENT_REDESIGN_V1 — underline tab bar for the Закупки workspace ---- */
.proc-tabs { display: flex; gap: 18px; border-bottom: 1px solid var(--ink-100); margin: 2px 0 16px; flex-wrap: wrap; }
.proc-tab { display: inline-flex; align-items: center; gap: 6px; padding: 9px 2px; border: 0; background: none; cursor: pointer; font: inherit; font-size: 13px; font-weight: 600; color: var(--ink-500); border-bottom: 2px solid transparent; margin-bottom: -1px; }
.proc-tab:hover { color: var(--ink-800); }
.proc-tab.active { color: var(--primary-600); border-bottom-color: var(--primary-600); }
```

- [ ] **Step 2: Create `public/js/admin/views/inventory-shared.js`**

```js
// Закупки — shared helpers for the procurement workspace modules
// (inventory.js shell + inventory-sklad.js / inventory-products.js /
// inventory-suppliers.js). Extracted from the original single-file
// inventory.js (PROCUREMENT_WORKSPACE_V1) during PROCUREMENT_REDESIGN_V1 so
// every tab module formats numbers, guards stale fetches, and labels stock
// movements the same way.
import { supabase } from '../../supabase.js';
import { h, Icon, Tag } from '../ui.js';

// Cross-module fetch-race guard: every tab's async fetch grabs a token and
// bails (without touching the DOM) if a newer fetch — including one triggered
// by switching tabs — has landed since. One shared counter object so a fetch
// started by the previous tab module is invalidated by the next one.
export const fetchGuard = { token: 0 };

export function loadingCard() {
    return h('div', { class: 'card', style: { textAlign: 'center', padding: '40px 20px', color: 'var(--ink-500)', fontSize: '12.5px' } }, 'Загрузка…');
}

// Placeholder for panes deferred to phase 2.
export function comingSoon(title, text, icon) {
    return h('div', { class: 'card' },
        h('div', { class: 'empty' },
            h('div', { style: { marginBottom: '10px', color: 'var(--ink-400)' } }, Icon(icon, { size: 32 })),
            h('div', { style: { fontSize: '15px', fontWeight: '700', color: 'var(--ink-800)', marginBottom: '4px' } }, title),
            h('div', { class: 'muted', style: { fontSize: '12.5px' } }, text),
        ),
    );
}

// Thousands-separated integer money display (e.g. 50000 -> "50 000").
export function fmtPrice(n) {
    const v = Math.round(Number(n) || 0);
    const sign = v < 0 ? '-' : '';
    return sign + String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

// Money keeping up to 2 decimals (2169.51 -> "2 169.51", 285000 -> "285 000").
export function fmtMoney2(n) {
    const v = Math.round((Number(n) || 0) * 100) / 100;
    const [int, frac] = Math.abs(v).toFixed(2).split('.');
    const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    const sign = v < 0 ? '-' : '';
    return sign + (frac === '00' ? grouped : `${grouped}.${frac}`);
}

// Trim a display-only quantity to a sane precision (whole numbers stay whole).
export function fmtQty(n) {
    if (!Number.isFinite(n)) return '';
    return String(Math.round(n * 100) / 100);
}

// Signed quantity + unit, e.g. "+30 шт" / "-5 шт" (stock_movements.qty is
// already signed at the DB level — receive/void positive, dispense negative,
// adjust either way — this just makes the '+' explicit for readability).
export function fmtSignedQty(n, unit) {
    const v = Number(n) || 0;
    const sign = v > 0 ? '+' : '';
    return `${sign}${fmtQty(v)} ${unit || ''}`.trim();
}

// PROCUREMENT_CATEGORIES_V1 — fixed catalog, stored in products.procurement_category.
export const CATEGORY_LABEL = {
    medicines:    'Медикаменты',
    consumables:  'Расходники',
    equipment:    'Оборудование',
    lab_supplies: 'Лаб. материалы',
    dental:       'Стоматология',
    radiology:    'Радиология',
    office_it:    'Офис / IT',
    facility:     'Хозяйство',
};

// Inline styles for selects / numeric inputs inside modal line tables.
export const selStyle = { width: '100%', height: '34px', padding: '0 8px', border: '1px solid var(--ink-200)', borderRadius: '8px', fontSize: '13px', background: 'white', fontFamily: 'inherit' };
export const numStyle = { width: '100%', height: '34px', padding: '0 8px', border: '1px solid var(--ink-200)', borderRadius: '8px', fontSize: '13px', textAlign: 'right' };

// RU movement tag; «Выдача» is kind 'dispense' + reference_type 'issue'
// (issue_stock_lines). A plain 'dispense' is a visit dispense (Списание).
const MOVEMENT_KIND = {
    receive:  { label: 'Приход',        kind: 'ok' },
    dispense: { label: 'Списание',      kind: 'info' },
    adjust:   { label: 'Корректировка', kind: 'warn' },
    void:     { label: 'Отмена',        kind: 'off' },
};
export function movementTag(m) {
    if (m.kind === 'dispense' && m.reference_type === 'issue') {
        return Tag('Выдача', { kind: 'info', dot: true });
    }
    const t = MOVEMENT_KIND[m.kind] || { label: m.kind || '—', kind: '' };
    return Tag(t.label, { kind: t.kind, dot: true });
}

// stock_movements with products + users embeds — shared by Дашборд and Журнал.
// Falls back to narrower selects if an embed is rejected, and finally to no
// embed at all so callers can still show product_id.
export async function fetchMovements({ kind, limit } = {}) {
    const selects = [
        '*, products(name,base_unit), users(full_name,username)',
        '*, products(name,unit)',
        '*',
    ];
    let lastError = null;
    for (const sel of selects) {
        let q = supabase.from('stock_movements').select(sel);
        if (kind) q = q.eq('kind', kind);
        q = q.order('id', { ascending: false });
        if (limit) q = q.limit(limit);
        const { data, error } = await q;
        if (!error) return { data: data || [], error: null };
        lastError = error;
    }
    return { data: null, error: lastError };
}
```

- [ ] **Step 3: Syntax check**

Run: `node --check public/js/admin/views/inventory-shared.js`
Expected: exit 0, no output (the package is `"type": "module"`, so this parses as ESM).

- [ ] **Step 4: Commit**

```bash
git add public/css/admin-views.css public/js/admin/views/inventory-shared.js
git commit -m "feat: Закупки — proc-tabs styles + shared helpers module (not yet wired)"
```

---

### Task 7: «Товары» tab module (`inventory-products.js`)

**Files:**
- Create: `public/js/admin/views/inventory-products.js`

This is the existing Product list / Add-Edit / Receive / Adjust code from `inventory.js` moved out, translated to Russian, with two functional changes: (a) the product form gains a «Поставщик» select writing `products.supplier_id`; (b) `openAdjustModal` accepts `p = null` and then shows its own product picker (needed by the Склад toolbar's «Корректировка»). Not imported by anything until Task 10.

- [ ] **Step 1: Create `public/js/admin/views/inventory-products.js`**

```js
// Закупки — «Товары» tab (catalog CRUD) + the shared Принять / Корректировка
// modals. PROCUREMENT_REDESIGN_V1 — extracted from the original single-file
// inventory.js. Catalog writes go through /api/db (allow-listed columns only)
// — on_hand and avg_cost change ONLY through RPCs:
//   receive_stock_lines («Принять»), adjust_stock («Корректировка»),
//   issue_stock_lines («Выдать» — see inventory-sklad.js),
//   dispense_item / void_dispense (visit-bill.js — unrelated, do not touch).
import { supabase } from '../../supabase.js';
import { h, Icon, clear, toast, Tag, field, checkField } from '../ui.js';
import { fetchGuard, fmtPrice, fmtQty, CATEGORY_LABEL, selStyle, numStyle } from './inventory-shared.js';

const productRefs = { tbody: null, emptyEl: null, totalEl: null };

export function renderProductsTab(container) {
    productRefs.tbody = h('tbody');
    productRefs.emptyEl = h('div', { class: 'empty', style: { display: 'none' } },
        'Пока нет товаров — добавьте первый.');
    productRefs.totalEl = h('span', { class: 'muted', style: { fontSize: '12px' } }, '');

    const addBtn = h('button', {
        class: 'btn btn-primary btn-sm', type: 'button',
        onclick: () => openProductModal(null, fetchProductsAndPaint),
    }, Icon('Plus', { size: 14 }), ' Добавить товар');

    const receiveBtn = h('button', {
        class: 'btn btn-sm', type: 'button',
        onclick: () => openReceiveModal(fetchProductsAndPaint),
    }, Icon('Download', { size: 14 }), ' Принять');

    container.appendChild(h('div', null,
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px', marginBottom: '12px' } },
            productRefs.totalEl,
            h('div', { class: 'page-head-actions' }, addBtn, receiveBtn),
        ),
        h('div', { class: 'card' },
            h('table', { class: 'tbl' },
                h('thead', null, h('tr', null,
                    h('th', null, 'Название'),
                    h('th', null, 'Категория'),
                    h('th', null, 'В наличии'),
                    h('th', null, 'Себестоимость'),
                    h('th', null, 'Цена продажи'),
                    h('th', null, 'Статус'),
                    h('th', null, ''),
                )),
                productRefs.tbody,
            ),
            productRefs.emptyEl,
        ),
    ));

    fetchProductsAndPaint();
}

async function fetchProductsAndPaint() {
    const token = ++fetchGuard.token;
    setLoadingRow();
    try {
        const { data, error } = await supabase.from('products')
            .select('*')
            .order('name', { ascending: true })
            .limit(1000);
        if (token !== fetchGuard.token) return;   // a newer fetch already landed
        if (error) {
            toast('Не удалось загрузить товары: ' + (error.message || error), 'fail');
            paintRows([]);
            return;
        }
        paintRows(data || []);
        if (productRefs.totalEl) productRefs.totalEl.textContent = `Товаров: ${(data || []).length}`;
    } catch (e) {
        if (token !== fetchGuard.token) return;
        toast('Не удалось загрузить товары: ' + (e && e.message || e), 'fail');
        paintRows([]);
    }
}

function setLoadingRow() {
    if (!productRefs.tbody) return;
    clear(productRefs.tbody);
    productRefs.tbody.appendChild(h('tr', null,
        h('td', { colspan: '7', style: { textAlign: 'center', padding: '24px', color: 'var(--ink-500)', fontSize: '12.5px' } }, 'Загрузка…'),
    ));
    productRefs.emptyEl.style.display = 'none';
}

function paintRows(rows) {
    clear(productRefs.tbody);
    if (!rows || rows.length === 0) {
        productRefs.emptyEl.style.display = '';
        return;
    }
    productRefs.emptyEl.style.display = 'none';
    for (const p of rows) productRefs.tbody.appendChild(productRow(p));
}

function productRow(p) {
    const inactive = !p.active;
    const onHand = Number(p.on_hand) || 0;
    const reorder = Number(p.reorder_level) || 0;
    const isLow = reorder > 0 && onHand <= reorder;

    const adjustBtn = h('button', {
        class: 'btn btn-sm', type: 'button',
        onclick: (ev) => { ev.stopPropagation(); openAdjustModal(p, fetchProductsAndPaint); },
    }, 'Корректировка');

    return h('tr', {
        class: 'row-click',
        style: { cursor: 'pointer', opacity: inactive ? '0.55' : '' },
        onclick: () => openProductModal(p, fetchProductsAndPaint),
    },
        h('td', { class: 'cell-strong' }, p.name || '—',
            p.code ? h('span', { class: 'muted', style: { marginLeft: '8px', fontWeight: '400' } }, p.code) : null),
        h('td', null, CATEGORY_LABEL[p.procurement_category] || p.procurement_category || '—',
            p.is_drug ? h('span', { style: { marginLeft: '8px' } }, Tag('Препарат', { kind: 'info' })) : null),
        h('td', { class: 'num' }, `${onHand} ${p.base_unit || ''}`.trim()),
        h('td', { class: 'num' }, fmtPrice(p.avg_cost)),
        h('td', { class: 'num' }, fmtPrice(p.sale_price)),
        h('td', null, Tag(p.active ? 'Активен' : 'Неактивен', { kind: p.active ? 'ok' : '', dot: true }),
            isLow ? h('span', { style: { marginLeft: '8px' } }, Tag('Мало', { kind: 'warn', dot: true })) : null),
        h('td', { style: { textAlign: 'right' } }, adjustBtn),
    );
}

// -----------------------------------------------------------------------------
// ADD / EDIT MODAL — p == null -> добавление; p задан -> редактирование.
// -----------------------------------------------------------------------------
function openProductModal(p, onSaved) {
    const isEdit = !!p;

    const overlay = h('div', { class: 'modal' });
    const close = () => overlay.remove();
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));

    const nameInp = h('input', { type: 'text', required: true, value: p ? (p.name || '') : '' });
    const codeInp = h('input', { type: 'text', value: p ? (p.code || '') : '' });

    const categorySel = h('select', null,
        ...Object.entries(CATEGORY_LABEL).map(([key, label]) =>
            h('option', { value: key, selected: (p ? p.procurement_category : 'medicines') === key }, label)));

    const isDrugChk = h('input', { type: 'checkbox', checked: p ? !!p.is_drug : false });

    // «Поставщик» — основной поставщик товара (products.supplier_id).
    const supplierSel = h('select', null, h('option', { value: '' }, '—'));
    (async () => {
        try {
            const { data, error } = await supabase.from('suppliers')
                .select('id,name').eq('active', 1).order('name', { ascending: true });
            if (error) throw error;
            for (const s of (data || [])) {
                supplierSel.appendChild(h('option', {
                    value: String(s.id),
                    selected: !!(p && p.supplier_id === s.id),
                }, s.name));
            }
        } catch (e) {
            // Форма работает и без списка поставщиков — просто останется «—».
        }
    })();

    const baseUnitInp = h('input', { type: 'text', value: p ? (p.base_unit || 'pcs') : 'pcs' });
    const purchaseUnitInp = h('input', { type: 'text', value: p ? (p.purchase_unit || '') : '', placeholder: 'напр., коробка' });
    const packFactorInp = h('input', { type: 'number', min: '0', step: 'any',
        value: (p && p.pack_factor != null) ? String(p.pack_factor) : '1' });
    const packFactorHint = h('div', { class: 'muted', style: { fontSize: '11px', marginTop: '4px' } },
        'Базовых единиц в закупочной — напр., 1 коробка = 10 таб.');
    const consumptionUnitInp = h('input', { type: 'text', value: p ? (p.consumption_unit || '') : '', placeholder: 'напр., мл' });
    const consumptionFactorInp = h('input', { type: 'number', min: '0', step: 'any',
        value: (p && p.consumption_factor != null) ? String(p.consumption_factor) : '1' });
    const consumptionHint = h('div', { class: 'muted', style: { fontSize: '11px', marginTop: '4px' } },
        'Единиц расхода в базовой — напр., 1 флакон = 50 мл.');

    const priceInp = h('input', { type: 'number', min: '0', step: 'any',
        value: (p && p.sale_price != null) ? String(p.sale_price) : '' });
    const reorderInp = h('input', { type: 'number', min: '0', step: 'any',
        value: (p && p.reorder_level != null) ? String(p.reorder_level) : '0' });
    const activeChk = h('input', { type: 'checkbox', checked: p ? !!p.active : true });

    const saveBtn = h('button', { class: 'btn btn-primary', type: 'button' }, isEdit ? 'Сохранить' : 'Добавить товар');
    saveBtn.addEventListener('click', save);

    async function save() {
        const name = nameInp.value.trim();
        if (!name) { toast('Укажите название товара.', 'fail'); return; }
        const price = priceInp.value === '' ? 0 : Number(priceInp.value);
        if (!Number.isFinite(price) || price < 0) { toast('Укажите корректную цену продажи.', 'fail'); return; }
        const reorder = reorderInp.value === '' ? 0 : Number(reorderInp.value);
        if (!Number.isFinite(reorder) || reorder < 0) { toast('Укажите корректный мин. остаток.', 'fail'); return; }
        const packFactor = packFactorInp.value === '' ? 1 : Number(packFactorInp.value);
        if (!Number.isFinite(packFactor) || packFactor <= 0) { toast('Укажите корректный коэфф. упаковки.', 'fail'); return; }
        const consumptionFactor = consumptionFactorInp.value === '' ? 1 : Number(consumptionFactorInp.value);
        if (!Number.isFinite(consumptionFactor) || consumptionFactor <= 0) { toast('Укажите корректный коэфф. расхода.', 'fail'); return; }

        saveBtn.disabled = true;
        const prevLabel = saveBtn.textContent;
        saveBtn.textContent = isEdit ? 'Сохраняем…' : 'Добавляем…';
        try {
            const payload = {
                name,
                code:                 codeInp.value.trim() || null,
                procurement_category: categorySel.value,
                is_drug:              isDrugChk.checked ? 1 : 0,
                base_unit:            baseUnitInp.value.trim() || 'pcs',
                purchase_unit:        purchaseUnitInp.value.trim() || null,
                pack_factor:          packFactor,
                consumption_unit:     consumptionUnitInp.value.trim() || null,
                consumption_factor:   consumptionFactor,
                sale_price:           price,
                reorder_level:        reorder,
                supplier_id:          supplierSel.value ? Number(supplierSel.value) : null,
                active:               activeChk.checked ? 1 : 0,
            };

            const { error } = isEdit
                ? await supabase.from('products').update(payload).eq('id', p.id).select().single()
                : await supabase.from('products').insert(payload).select().single();
            if (error) throw error;

            toast('Сохранено', 'ok');
            close();
            if (typeof onSaved === 'function') await onSaved();
        } catch (e) {
            toast((e && e.message) || 'Не удалось сохранить товар.', 'fail');
            saveBtn.disabled = false;
            saveBtn.textContent = prevLabel;
        }
    }

    const bodyChildren = [
        field('Название', nameInp, { required: true }),
        field('Код', codeInp),
        field('Категория', categorySel),
        field('Поставщик', supplierSel),
        checkField('Препарат', isDrugChk),
        h('div', { class: 'muted', style: { fontSize: '11px', fontWeight: '700', textTransform: 'uppercase', letterSpacing: '0.04em', marginTop: '4px' } }, 'Единицы'),
        field('Базовая единица', baseUnitInp),
        h('div', { class: 'field-row', style: { gridTemplateColumns: '1fr 1fr' } },
            field('Единица закупки', purchaseUnitInp),
            field('Коэфф. упаковки', h('div', null, packFactorInp, packFactorHint)),
        ),
        h('div', { class: 'field-row', style: { gridTemplateColumns: '1fr 1fr' } },
            field('Единица расхода', consumptionUnitInp),
            field('Коэфф. расхода', h('div', null, consumptionFactorInp, consumptionHint)),
        ),
        field('Цена продажи', priceInp),
        field('Мин. остаток', reorderInp),
        checkField('Активен', activeChk),
    ];
    if (isEdit) {
        bodyChildren.push(
            field('В наличии',
                h('div', { class: 'muted', style: { fontSize: '13px', fontWeight: '600', color: 'var(--ink-900)' } },
                    `${Number(p.on_hand) || 0} ${p.base_unit || ''}`.trim())),
            field('Себестоимость',
                h('div', null,
                    h('div', { class: 'muted', style: { fontSize: '13px', fontWeight: '600', color: 'var(--ink-900)' } }, fmtPrice(p.avg_cost)),
                    h('div', { class: 'muted', style: { fontSize: '11px', marginTop: '2px' } }, 'Остаток меняется через «Принять» / «Корректировка».'),
                )),
        );
    }

    overlay.appendChild(h('div', { class: 'modal-card modal-compact', style: { width: '460px', maxWidth: 'calc(100vw - 32px)', maxHeight: 'calc(100vh - 60px)', display: 'flex', flexDirection: 'column' } },
        h('header', { class: 'modal-head' },
            h('h2', null, Icon('Pill', { size: 16 }), ' ', isEdit ? 'Товар' : 'Добавить товар'),
            h('button', { class: 'modal-close', onclick: close }, '×')),
        h('div', { class: 'modal-body', style: { overflowY: 'auto' } },
            ...bodyChildren,
        ),
        h('footer', { class: 'modal-foot' },
            h('button', { class: 'btn', type: 'button', onclick: close }, 'Отмена'),
            h('span', { class: 'grow' }),
            saveBtn),
    ));
    document.body.appendChild(overlay);
    nameInp.focus();
}

// -----------------------------------------------------------------------------
// ПРИНЯТЬ — multi-line, unit-aware, cost-tracked receiving. Каждая строка:
// { product, unit:'base'|'purchase', qty, unitCost }. Вся математика на
// сервере (receive_stock_lines) — подсказка в строке только для отображения.
// -----------------------------------------------------------------------------
export function openReceiveModal(onSaved) {
    const overlay = h('div', { class: 'modal' });
    const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
    function onKey(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey);
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));

    const modalState = { products: [] };   // локально для модалки
    const lineObjs = [];

    const linesBody = h('tbody');
    linesBody.appendChild(loadingLineRow());

    const addLineBtn = h('button', {
        class: 'btn btn-sm', type: 'button', disabled: true,
        onclick: () => addLine(),
    }, Icon('Plus', { size: 13 }), ' Добавить строку');

    const noteInp = h('input', { type: 'text', value: '', placeholder: 'напр., поставка от ООО «Медснаб» (необязательно)' });

    const saveBtn = h('button', { class: 'btn btn-primary', type: 'button' }, 'Принять');
    saveBtn.addEventListener('click', save);

    function loadingLineRow() {
        return h('tr', null, h('td', { colspan: '5', style: { textAlign: 'center', padding: '16px', color: 'var(--ink-500)', fontSize: '12.5px' } }, 'Загрузка товаров…'));
    }

    function computeHint(line) {
        if (!line.product) return '';
        if (line.unit === 'purchase') {
            const qty = Number(line.qty);
            if (!Number.isFinite(qty) || qty <= 0) return '';
            const factor = Number(line.product.pack_factor) > 0 ? Number(line.product.pack_factor) : 1;
            return `= ${fmtQty(qty * factor)} ${line.product.base_unit || ''}`.trim();
        }
        return line.product.base_unit || '';
    }

    function addLine() {
        const line = { product: null, unit: 'base', qty: '', unitCost: '' };
        lineObjs.push(line);
        linesBody.appendChild(buildLineRow(line));
    }

    function buildLineRow(line) {
        const prodSel = h('select', { style: selStyle },
            h('option', { value: '' }, '— Выберите товар —'),
            ...modalState.products.map(pr => h('option', { value: String(pr.id) }, pr.name)));
        prodSel.value = line.product ? String(line.product.id) : '';

        const unitSel = h('select', { style: selStyle });
        const hintEl = h('div', { class: 'muted', style: { fontSize: '11px', marginTop: '3px' } }, '');

        function refreshUnitOptions() {
            clear(unitSel);
            if (!line.product) {
                unitSel.appendChild(h('option', { value: 'base' }, 'Базовая'));
                unitSel.disabled = true;
                unitSel.value = 'base';
                return;
            }
            unitSel.disabled = false;
            unitSel.appendChild(h('option', { value: 'base' }, `Базовая (${line.product.base_unit || 'pcs'})`));
            if (line.product.purchase_unit) {
                unitSel.appendChild(h('option', { value: 'purchase' }, `Закупочная (${line.product.purchase_unit})`));
            }
            unitSel.value = line.unit;
        }
        function refreshHint() { hintEl.textContent = computeHint(line); }

        prodSel.addEventListener('change', () => {
            const pid = Number(prodSel.value) || null;
            line.product = modalState.products.find(pr => pr.id === pid) || null;
            line.unit = 'base';
            refreshUnitOptions();
            refreshHint();
        });
        unitSel.addEventListener('change', () => {
            line.unit = unitSel.value;
            refreshHint();
        });

        const qtyInp = h('input', { type: 'number', min: '0', step: 'any', value: '', style: numStyle });
        qtyInp.addEventListener('input', () => { line.qty = qtyInp.value; refreshHint(); });

        const costInp = h('input', { type: 'number', min: '0', step: 'any', value: '', style: numStyle });
        costInp.addEventListener('input', () => { line.unitCost = costInp.value; });

        const removeBtn = h('button', {
            class: 'btn btn-ghost btn-sm', type: 'button', title: 'Убрать строку',
            onclick: () => {
                const i = lineObjs.indexOf(line);
                if (i >= 0) lineObjs.splice(i, 1);
                tr.remove();
                if (lineObjs.length === 0) addLine();   // всегда хотя бы одна строка
            },
        }, '×');

        refreshUnitOptions();
        refreshHint();

        const tr = h('tr', null,
            h('td', null, prodSel),
            h('td', { style: { width: '190px' } }, unitSel, hintEl),
            h('td', { style: { width: '110px' } }, qtyInp),
            h('td', { style: { width: '130px' } }, costInp),
            h('td', { style: { width: '36px', textAlign: 'center' } }, removeBtn),
        );
        return tr;
    }

    async function save() {
        const lines = [];
        for (const line of lineObjs) {
            if (!line.product) continue;
            const qty = Number(line.qty);
            if (!Number.isFinite(qty) || qty <= 0) continue;
            const unitCost = Number(line.unitCost);
            lines.push({
                product_id: line.product.id,
                qty,
                unit: line.unit === 'purchase' ? 'purchase' : 'base',
                unit_cost: (Number.isFinite(unitCost) && unitCost >= 0) ? unitCost : 0,
            });
        }
        if (!lines.length) { toast('Добавьте хотя бы одну позицию.', 'fail'); return; }

        saveBtn.disabled = true;
        const prevLabel = saveBtn.textContent;
        saveBtn.textContent = 'Принимаем…';
        try {
            const note = noteInp.value.trim() || undefined;
            const { error } = await supabase.rpc('receive_stock_lines', { lines, note });
            if (error) throw error;

            toast('Товар принят', 'ok');
            close();
            if (typeof onSaved === 'function') await onSaved();
        } catch (e) {
            toast((e && e.message) || 'Не удалось принять товар.', 'fail');
            saveBtn.disabled = false;
            saveBtn.textContent = prevLabel;
        }
    }

    overlay.appendChild(h('div', { class: 'modal-card modal-compact', style: { width: '760px', maxWidth: 'calc(100vw - 32px)', maxHeight: 'calc(100vh - 60px)', display: 'flex', flexDirection: 'column' } },
        h('header', { class: 'modal-head' },
            h('h2', null, Icon('Download', { size: 16 }), ' Принять товар'),
            h('button', { class: 'modal-close', onclick: close }, '×')),
        h('div', { class: 'modal-body', style: { flex: 1, minHeight: 0, overflowY: 'auto' } },
            h('div', { style: { overflowX: 'auto', border: '1px solid var(--ink-100)', borderRadius: '10px', marginBottom: '10px' } },
                h('table', { class: 'tbl' },
                    h('thead', null, h('tr', null,
                        h('th', null, 'Товар'),
                        h('th', null, 'Единица'),
                        h('th', null, 'Кол-во'),
                        h('th', null, 'Цена за ед.'),
                        h('th', null, ''),
                    )),
                    linesBody,
                ),
            ),
            addLineBtn,
            field('Примечание', noteInp),
        ),
        h('footer', { class: 'modal-foot' },
            h('button', { class: 'btn', type: 'button', onclick: close }, 'Отмена'),
            h('span', { class: 'grow' }),
            saveBtn),
    ));
    document.body.appendChild(overlay);

    (async () => {
        try {
            const { data, error } = await supabase.from('products')
                .select('id,name,base_unit,purchase_unit,pack_factor')
                .eq('active', 1)
                .order('name', { ascending: true });
            if (error) throw error;
            modalState.products = data || [];
        } catch (e) {
            toast('Не удалось загрузить товары: ' + ((e && e.message) || e), 'fail');
            modalState.products = [];
        } finally {
            clear(linesBody);
            addLineBtn.disabled = false;
            if (!modalState.products.length) {
                linesBody.appendChild(h('tr', null,
                    h('td', { colspan: '5', style: { textAlign: 'center', padding: '16px', color: 'var(--ink-500)', fontSize: '12.5px' } }, 'Нет активных товаров.')));
            } else {
                addLine();
            }
        }
    })();
}

// -----------------------------------------------------------------------------
// КОРРЕКТИРОВКА — знаковая ручная правка остатка, причина обязательна.
// p == null (кнопка на Складе) -> модалка сама даёт выбрать товар.
// -----------------------------------------------------------------------------
export function openAdjustModal(p, onSaved) {
    const overlay = h('div', { class: 'modal' });
    const close = () => overlay.remove();
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));

    let current = p || null;

    const infoEl = h('div', { class: 'muted', style: { fontSize: '12px', marginBottom: '10px' } }, '');
    function refreshInfo() {
        infoEl.textContent = current
            ? `Сейчас в наличии: ${Number(current.on_hand) || 0} ${current.base_unit || ''}`.trim()
            : 'Выберите товар.';
    }

    const prodSel = p ? null : h('select', { style: selStyle }, h('option', { value: '' }, '— Выберите товар —'));
    if (prodSel) {
        (async () => {
            try {
                const { data, error } = await supabase.from('products')
                    .select('id,name,base_unit,on_hand')
                    .eq('active', 1)
                    .order('name', { ascending: true });
                if (error) throw error;
                const list = data || [];
                for (const pr of list) prodSel.appendChild(h('option', { value: String(pr.id) }, pr.name));
                prodSel.addEventListener('change', () => {
                    const pid = Number(prodSel.value) || null;
                    current = list.find(x => x.id === pid) || null;
                    refreshInfo();
                });
            } catch (e) {
                toast('Не удалось загрузить товары: ' + ((e && e.message) || e), 'fail');
            }
        })();
    }

    const qtyInp = h('input', { type: 'number', step: 'any', required: true, value: '' });
    const noteInp = h('input', { type: 'text', required: true, value: '' });

    const saveBtn = h('button', { class: 'btn btn-primary', type: 'button' }, 'Провести');
    saveBtn.addEventListener('click', save);

    async function save() {
        if (!current) { toast('Выберите товар.', 'fail'); return; }
        const qty = Number(qtyInp.value);
        if (!Number.isFinite(qty) || qty === 0) { toast('Введите ненулевое количество.', 'fail'); return; }
        const note = noteInp.value.trim();
        if (!note) { toast('Причина корректировки обязательна.', 'fail'); return; }

        saveBtn.disabled = true;
        const prevLabel = saveBtn.textContent;
        saveBtn.textContent = 'Проводим…';
        try {
            const { error } = await supabase.rpc('adjust_stock', { product_id: current.id, qty, note });
            if (error) throw error;

            toast('Остаток скорректирован', 'ok');
            close();
            if (typeof onSaved === 'function') await onSaved();
        } catch (e) {
            toast((e && e.message) || 'Не удалось скорректировать.', 'fail');
            saveBtn.disabled = false;
            saveBtn.textContent = prevLabel;
        }
    }

    refreshInfo();
    overlay.appendChild(h('div', { class: 'modal-card modal-compact', style: { width: '400px', maxWidth: 'calc(100vw - 32px)' } },
        h('header', { class: 'modal-head' },
            h('h2', null, Icon('Edit', { size: 16 }), ' Корректировка', p ? ` — ${p.name || ''}` : ''),
            h('button', { class: 'modal-close', onclick: close }, '×')),
        h('div', { class: 'modal-body' },
            prodSel ? field('Товар', prodSel, { required: true }) : null,
            infoEl,
            field('Кол-во', qtyInp, { required: true }),
            h('div', { class: 'muted', style: { fontSize: '11px', marginTop: '-6px', marginBottom: '4px' } }, 'Плюс — добавить, минус — списать.'),
            field('Причина', noteInp, { required: true }),
        ),
        h('footer', { class: 'modal-foot' },
            h('button', { class: 'btn', type: 'button', onclick: close }, 'Отмена'),
            h('span', { class: 'grow' }),
            saveBtn),
    ));
    document.body.appendChild(overlay);
    (p ? qtyInp : (prodSel || qtyInp)).focus();
}
```

- [ ] **Step 2: Syntax check**

Run: `node --check public/js/admin/views/inventory-products.js`
Expected: exit 0, no output.

- [ ] **Step 3: Commit**

```bash
git add public/js/admin/views/inventory-products.js
git commit -m "feat: Закупки — Товары tab module (RU, supplier select, pickable Корректировка)"
```

---

### Task 8: «Склад» tab module (`inventory-sklad.js`)

**Files:**
- Create: `public/js/admin/views/inventory-sklad.js`

The screenshot screen: stock table + filter row + toolbar (Excel / Шаблон / Импорт из Excel / Выдать / Корректировка / Принять) + Выдать modal + Excel功能. Not imported until Task 10.

- [ ] **Step 1: Create `public/js/admin/views/inventory-sklad.js`**

```js
// Закупки — «Склад» tab (PROCUREMENT_REDESIGN_V1): the warehouse stock table
// from the cloud design — search/filters, low-stock ⚠, OK/Reorder flags,
// Excel export / шаблон / импорт, and Принять / Выдать / Корректировка.
// Stock is a single pool (products.on_hand); per-department balances arrive
// with «Отделения» in phase 2. «Заказать» is rendered disabled until the
// Заказы на закупку tab ships.
import { supabase } from '../../supabase.js';
import { h, Icon, clear, toast, Tag, field } from '../ui.js';
import { fetchGuard, loadingCard, fmtPrice, fmtMoney2, fmtQty, selStyle, numStyle } from './inventory-shared.js';
import { openReceiveModal, openAdjustModal } from './inventory-products.js';

const sklad = {
    products: [], suppliers: [],
    q: '', unit: 'all', supplier: 'all', avail: 'all', flag: 'all',
    tbody: null, emptyEl: null,
};

function isLow(p) {
    const reorder = Number(p.reorder_level) || 0;
    return reorder > 0 && (Number(p.on_hand) || 0) <= reorder;
}

// Единица выдачи: consumption unit если задана, иначе базовая (factor 1).
function issueUnitOf(p) {
    if (p.consumption_unit && Number(p.consumption_factor) > 0) {
        return { unit: p.consumption_unit, factor: Number(p.consumption_factor) };
    }
    return { unit: p.base_unit || '', factor: 1 };
}

export async function renderSkladTab(container) {
    clear(container);
    container.appendChild(loadingCard());
    const token = ++fetchGuard.token;

    let products = [], suppliers = [], loadError = null;
    try {
        const [pr, sr] = await Promise.all([
            supabase.from('products').select('*, suppliers(id,name)').order('name', { ascending: true }).limit(1000),
            supabase.from('suppliers').select('id,name').eq('active', 1).order('name', { ascending: true }),
        ]);
        if (pr.error) throw pr.error;
        products = pr.data || [];
        suppliers = (sr.error ? [] : sr.data) || [];
    } catch (e) { loadError = e; }
    if (token !== fetchGuard.token) return;

    clear(container);
    if (loadError) {
        toast('Не удалось загрузить склад: ' + ((loadError && loadError.message) || loadError), 'fail');
        container.appendChild(h('div', { class: 'card' }, h('div', { class: 'empty' }, 'Не удалось загрузить остатки.')));
        return;
    }

    sklad.products = products.filter(p => p.active);
    sklad.suppliers = suppliers;
    sklad.tbody = h('tbody');
    sklad.emptyEl = h('div', { class: 'empty', style: { display: 'none' } }, 'Ничего не найдено.');

    const reload = () => renderSkladTab(container);

    // ---- filter controls -------------------------------------------------
    const inputStyle = { width: '100%', height: '30px', padding: '0 8px', border: '1px solid var(--ink-200)', borderRadius: '8px', fontSize: '12.5px', fontFamily: 'inherit' };
    const smallSel = { ...selStyle, height: '30px', fontSize: '12.5px' };

    const searchInp = h('input', { type: 'text', placeholder: 'Поиск…', value: sklad.q, style: inputStyle });
    searchInp.addEventListener('input', () => { sklad.q = searchInp.value; paintRows(); });

    function filterSelect(options, value, onChange) {
        const sel = h('select', { style: smallSel },
            ...options.map(([v, label]) => h('option', { value: v, selected: v === value }, label)));
        sel.addEventListener('change', () => onChange(sel.value));
        return sel;
    }
    const units = [...new Set(sklad.products.map(p => p.base_unit).filter(Boolean))].sort();
    const unitSel = filterSelect([['all', 'Все ед.'], ...units.map(u => [u, u])], sklad.unit,
        v => { sklad.unit = v; paintRows(); });
    const supplierSel = filterSelect(
        [['all', 'Все поставщики'], ['none', 'Без поставщика'], ...sklad.suppliers.map(s => [String(s.id), s.name])],
        sklad.supplier, v => { sklad.supplier = v; paintRows(); });
    const availSel = filterSelect(
        [['all', 'Все'], ['in', 'В наличии'], ['low', 'Заканчивается'], ['out', 'Нет в наличии']],
        sklad.avail, v => { sklad.avail = v; paintRows(); });
    const flagSel = filterSelect([['all', 'Все'], ['ok', 'OK'], ['reorder', 'Reorder']], sklad.flag,
        v => { sklad.flag = v; paintRows(); });

    // ---- toolbar ---------------------------------------------------------
    const toolBtn = (label, icon, onclick) =>
        h('button', { class: 'btn btn-sm', type: 'button', onclick }, Icon(icon, { size: 14 }), ' ' + label);

    const card = h('div', { class: 'card' },
        h('div', { class: 'card-header', style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
            h('h3', null, Icon('Layers', { size: 15 }), ' Остатки на складе'),
            h('span', { class: 'grow' }),
            toolBtn('Excel', 'Download', exportExcel),
            toolBtn('Шаблон', 'Doc', downloadTemplate),
            toolBtn('Импорт из Excel', 'ArrowUp', () => openImportModal(reload)),
            toolBtn('Выдать', 'Send', () => openIssueModal(reload)),
            toolBtn('Корректировка', 'Edit', () => openAdjustModal(null, reload)),
            h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => openReceiveModal(reload) },
                Icon('Plus', { size: 14 }), ' Принять'),
        ),
        h('div', { style: { overflowX: 'auto' } },
            h('table', { class: 'tbl' },
                h('thead', null,
                    h('tr', null,
                        h('th', null, 'Product'),
                        h('th', null, 'Единица'),
                        h('th', null, 'Поставщик'),
                        h('th', null, 'В наличии'),
                        h('th', null, 'Выдать'),
                        h('th', null, 'Себестоимость'),
                        h('th', null, 'Стоимость'),
                        h('th', null, 'Flag'),
                        h('th', null, ''),
                    ),
                    h('tr', null,
                        h('td', { style: { padding: '6px 10px' } }, searchInp),
                        h('td', { style: { padding: '6px 10px', minWidth: '90px' } }, unitSel),
                        h('td', { style: { padding: '6px 10px', minWidth: '140px' } }, supplierSel),
                        h('td', { style: { padding: '6px 10px', minWidth: '110px' } }, availSel),
                        h('td', null, ''),
                        h('td', null, ''),
                        h('td', null, ''),
                        h('td', { style: { padding: '6px 10px', minWidth: '90px' } }, flagSel),
                        h('td', null, ''),
                    ),
                ),
                sklad.tbody,
            ),
        ),
        sklad.emptyEl,
    );

    container.appendChild(card);
    paintRows();

    // ---- rows ------------------------------------------------------------
    function filtered() {
        const q = sklad.q.trim().toLowerCase();
        return sklad.products.filter(p => {
            const onHand = Number(p.on_hand) || 0;
            const low = isLow(p);
            if (q && !(p.name || '').toLowerCase().includes(q)) return false;
            if (sklad.unit !== 'all' && p.base_unit !== sklad.unit) return false;
            if (sklad.supplier === 'none' && p.supplier_id) return false;
            if (sklad.supplier !== 'all' && sklad.supplier !== 'none' && p.supplier_id !== Number(sklad.supplier)) return false;
            if (sklad.avail === 'in' && !(onHand > 0)) return false;
            if (sklad.avail === 'low' && !(onHand > 0 && low)) return false;
            if (sklad.avail === 'out' && onHand > 0) return false;
            if (sklad.flag === 'ok' && low) return false;
            if (sklad.flag === 'reorder' && !low) return false;
            return true;
        });
    }

    function paintRows() {
        clear(sklad.tbody);
        const rows = filtered();
        if (!rows.length) { sklad.emptyEl.style.display = ''; return; }
        sklad.emptyEl.style.display = 'none';
        for (const p of rows) sklad.tbody.appendChild(productRow(p));
    }

    function productRow(p) {
        const onHand = Number(p.on_hand) || 0;
        const low = isLow(p);
        const iu = issueUnitOf(p);
        return h('tr', null,
            h('td', { class: 'cell-strong' }, p.name || '—'),
            h('td', null, p.base_unit || '—'),
            h('td', null, (p.suppliers && p.suppliers.name) || '—'),
            h('td', { class: 'num' }, low
                ? h('span', { style: { color: 'var(--crit-500)' } }, Icon('Warning', { size: 13 }), ' ' + fmtQty(onHand))
                : fmtQty(onHand)),
            h('td', { class: 'num' }, `${fmtQty(onHand * iu.factor)} ${iu.unit}`.trim()),
            h('td', { class: 'num' }, fmtMoney2(p.avg_cost)),
            h('td', { class: 'num' }, fmtPrice(onHand * (Number(p.avg_cost) || 0))),
            h('td', null, low ? Tag('Reorder', { kind: 'crit' }) : Tag('OK', { kind: 'ok' })),
            h('td', { style: { textAlign: 'right' } },
                h('button', { class: 'btn btn-sm', type: 'button', disabled: true, title: 'Заказы на закупку — во 2-й фазе' }, 'Заказать')),
        );
    }

    // ---- Excel: export current (filtered) view --------------------------
    async function exportExcel() {
        try {
            const XLSX = await import('../../vendor/xlsx-0.20.3.mjs');
            const matrix = [
                ['Товар', 'Единица', 'Поставщик', 'В наличии', 'Выдать', 'Себестоимость', 'Стоимость', 'Флаг'],
                ...filtered().map(p => {
                    const iu = issueUnitOf(p);
                    const onHand = Number(p.on_hand) || 0;
                    return [
                        p.name || '', p.base_unit || '', (p.suppliers && p.suppliers.name) || '',
                        onHand, `${fmtQty(onHand * iu.factor)} ${iu.unit}`.trim(),
                        Number(p.avg_cost) || 0, Math.round(onHand * (Number(p.avg_cost) || 0)),
                        isLow(p) ? 'Reorder' : 'OK',
                    ];
                }),
            ];
            const ws = XLSX.utils.aoa_to_sheet(matrix);
            const wb = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wb, ws, 'Склад');
            XLSX.writeFile(wb, `sklad-${new Date().toISOString().slice(0, 10)}.xlsx`);
        } catch (e) {
            toast('Не удалось сформировать Excel: ' + ((e && e.message) || e), 'fail');
        }
    }

    // ---- Excel: import template -----------------------------------------
    async function downloadTemplate() {
        try {
            const XLSX = await import('../../vendor/xlsx-0.20.3.mjs');
            const matrix = [
                ['Название*', 'Единица', 'Кол-во', 'Себестоимость', 'Мин. остаток', 'Поставщик'],
                ['Парацетамол 500мг', 'шт', 100, 1500, 10, 'ООО Медснаб'],
            ];
            const ws = XLSX.utils.aoa_to_sheet(matrix);
            const wb = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wb, ws, 'Импорт');
            XLSX.writeFile(wb, 'shablon-import-tovarov.xlsx');
        } catch (e) {
            toast('Не удалось сформировать шаблон: ' + ((e && e.message) || e), 'fail');
        }
    }
}

// ---------------------------------------------------------------------------
// ИМПОРТ ИЗ EXCEL — клиент читает книгу (vendored SheetJS), маппит колонки
// шаблона, сервер (import_products_excel) делает всё в одной транзакции.
// ---------------------------------------------------------------------------
const HEADER_MAP = {
    'название': 'name', 'единица': 'unit', 'кол-во': 'qty', 'количество': 'qty',
    'себестоимость': 'unit_cost', 'мин. остаток': 'reorder_level', 'мин остаток': 'reorder_level',
    'поставщик': 'supplier',
};

function openImportModal(onDone) {
    const overlay = h('div', { class: 'modal' });
    const close = () => overlay.remove();
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));

    let parsedRows = null;

    const fileInp = h('input', { type: 'file', accept: '.xlsx,.xls' });
    const previewEl = h('div', { style: { marginTop: '10px' } });
    const importBtn = h('button', { class: 'btn btn-primary', type: 'button', disabled: true }, 'Импортировать');

    fileInp.addEventListener('change', async () => {
        parsedRows = null;
        importBtn.disabled = true;
        clear(previewEl);
        const file = fileInp.files && fileInp.files[0];
        if (!file) return;
        try {
            const XLSX = await import('../../vendor/xlsx-0.20.3.mjs');
            const wb = XLSX.read(await file.arrayBuffer());
            const ws = wb.Sheets[wb.SheetNames[0]];
            const matrix = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
            if (!matrix.length) throw new Error('Файл пуст.');
            const headers = matrix[0].map(x => String(x).toLowerCase().replace(/\*/g, '').replace(/\s+/g, ' ').trim());
            const keys = headers.map(hd => HEADER_MAP[hd] || null);
            if (!keys.includes('name')) throw new Error('Не найдена колонка «Название» — скачайте «Шаблон».');
            const rows = [];
            for (const cells of matrix.slice(1)) {
                if (!cells || cells.every(c => String(c).trim() === '')) continue;
                const row = {};
                keys.forEach((k, ci) => { if (k) row[k] = cells[ci]; });
                rows.push(row);
            }
            if (!rows.length) throw new Error('В файле нет строк данных.');
            parsedRows = rows;
            importBtn.disabled = false;
            previewEl.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px' } },
                `Строк к импорту: ${rows.length}. Совпадение — по точному названию товара; новые товары будут созданы.`));
        } catch (e) {
            previewEl.appendChild(h('div', { style: { color: 'var(--crit-700)', fontSize: '12.5px' } },
                'Ошибка чтения файла: ' + ((e && e.message) || e)));
        }
    });

    importBtn.addEventListener('click', async () => {
        if (!parsedRows) return;
        importBtn.disabled = true;
        const prev = importBtn.textContent;
        importBtn.textContent = 'Импортируем…';
        try {
            const num = v => (v === '' || v === undefined || v === null) ? null : Number(String(v).replace(',', '.'));
            const rows = parsedRows.map(r => ({
                name: r.name === undefined ? '' : String(r.name),
                unit: r.unit === undefined ? '' : String(r.unit),
                qty: num(r.qty),
                unit_cost: num(r.unit_cost),
                reorder_level: num(r.reorder_level),
                supplier: r.supplier === undefined ? '' : String(r.supplier),
            }));
            const { data, error } = await supabase.rpc('import_products_excel', { rows });
            if (error) throw error;
            toast(`Импорт готов: создано ${data.created}, обновлено ${data.updated}, приходов ${data.received}.`, 'ok');
            close();
            if (typeof onDone === 'function') onDone();
        } catch (e) {
            toast((e && e.message) || 'Импорт не выполнен.', 'fail');
            importBtn.disabled = false;
            importBtn.textContent = prev;
        }
    });

    overlay.appendChild(h('div', { class: 'modal-card modal-compact', style: { width: '520px', maxWidth: 'calc(100vw - 32px)' } },
        h('header', { class: 'modal-head' },
            h('h2', null, Icon('ArrowUp', { size: 16 }), ' Импорт из Excel'),
            h('button', { class: 'modal-close', onclick: close }, '×')),
        h('div', { class: 'modal-body' },
            h('div', { class: 'muted', style: { fontSize: '12.5px', marginBottom: '10px' } },
                'Колонки шаблона: Название*, Единица, Кол-во, Себестоимость, Мин. остаток, Поставщик. ',
                'Импорт — всё или ничего: ошибка в любой строке отменяет весь файл.'),
            field('Файл', fileInp),
            previewEl,
        ),
        h('footer', { class: 'modal-foot' },
            h('button', { class: 'btn', type: 'button', onclick: close }, 'Отмена'),
            h('span', { class: 'grow' }),
            importBtn),
    ));
    document.body.appendChild(overlay);
}

// ---------------------------------------------------------------------------
// ВЫДАТЬ — выдача со склада отделению/сотруднику без визита. Кол-во вводится
// в единицах выдачи (consumption); сервер (issue_stock_lines) конвертирует и
// не даёт уйти в минус.
// ---------------------------------------------------------------------------
function openIssueModal(onDone) {
    const overlay = h('div', { class: 'modal' });
    const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
    function onKey(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey);
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));

    const modal = { products: [], departments: [] };
    const lineObjs = [];
    const linesBody = h('tbody');
    linesBody.appendChild(h('tr', null, h('td', { colspan: '4', style: { textAlign: 'center', padding: '16px', color: 'var(--ink-500)', fontSize: '12.5px' } }, 'Загрузка товаров…')));

    const addLineBtn = h('button', {
        class: 'btn btn-sm', type: 'button', disabled: true,
        onclick: () => addLine(),
    }, Icon('Plus', { size: 13 }), ' Добавить строку');

    const deptList = h('datalist', { id: 'issue-recipients' });
    const recipientInp = h('input', { type: 'text', required: true, list: 'issue-recipients', placeholder: 'Отделение или сотрудник' });
    const noteInp = h('input', { type: 'text', placeholder: 'Основание (необязательно)' });

    const saveBtn = h('button', { class: 'btn btn-primary', type: 'button' }, 'Выдать');
    saveBtn.addEventListener('click', save);

    function addLine() {
        const line = { product: null, qty: '' };
        lineObjs.push(line);
        linesBody.appendChild(buildLineRow(line));
    }

    function buildLineRow(line) {
        const prodSel = h('select', { style: selStyle },
            h('option', { value: '' }, '— Выберите товар —'),
            ...modal.products.map(pr => h('option', { value: String(pr.id) }, pr.name)));
        const hintEl = h('div', { class: 'muted', style: { fontSize: '11px', marginTop: '3px' } }, '');
        const unitEl = h('div', { class: 'muted', style: { fontSize: '12.5px' } }, '—');

        function refresh() {
            if (!line.product) { hintEl.textContent = ''; unitEl.textContent = '—'; return; }
            const iu = issueUnitOfLocal(line.product);
            unitEl.textContent = iu.unit || '—';
            const avail = (Number(line.product.on_hand) || 0) * iu.factor;
            hintEl.textContent = `Доступно: ${fmtQty(avail)} ${iu.unit}`.trim();
        }
        function issueUnitOfLocal(p) {
            if (p.consumption_unit && Number(p.consumption_factor) > 0) {
                return { unit: p.consumption_unit, factor: Number(p.consumption_factor) };
            }
            return { unit: p.base_unit || '', factor: 1 };
        }

        prodSel.addEventListener('change', () => {
            const pid = Number(prodSel.value) || null;
            line.product = modal.products.find(pr => pr.id === pid) || null;
            refresh();
        });

        const qtyInp = h('input', { type: 'number', min: '0', step: 'any', value: '', style: numStyle });
        qtyInp.addEventListener('input', () => { line.qty = qtyInp.value; });

        const removeBtn = h('button', {
            class: 'btn btn-ghost btn-sm', type: 'button', title: 'Убрать строку',
            onclick: () => {
                const i = lineObjs.indexOf(line);
                if (i >= 0) lineObjs.splice(i, 1);
                tr.remove();
                if (lineObjs.length === 0) addLine();
            },
        }, '×');

        refresh();
        const tr = h('tr', null,
            h('td', null, prodSel, hintEl),
            h('td', { style: { width: '110px' } }, unitEl),
            h('td', { style: { width: '110px' } }, qtyInp),
            h('td', { style: { width: '36px', textAlign: 'center' } }, removeBtn),
        );
        return tr;
    }

    async function save() {
        const recipient = recipientInp.value.trim();
        if (!recipient) { toast('Укажите, кому выдаётся товар.', 'fail'); return; }
        const lines = [];
        for (const line of lineObjs) {
            if (!line.product) continue;
            const qty = Number(line.qty);
            if (!Number.isFinite(qty) || qty <= 0) continue;
            lines.push({ product_id: line.product.id, qty, unit: 'consumption' });
        }
        if (!lines.length) { toast('Добавьте хотя бы одну позицию.', 'fail'); return; }

        saveBtn.disabled = true;
        const prev = saveBtn.textContent;
        saveBtn.textContent = 'Выдаём…';
        try {
            const note = noteInp.value.trim() || undefined;
            const { error } = await supabase.rpc('issue_stock_lines', { lines, recipient, note });
            if (error) throw error;
            toast('Выдано со склада', 'ok');
            close();
            if (typeof onDone === 'function') onDone();
        } catch (e) {
            toast((e && e.message) || 'Не удалось выдать.', 'fail');
            saveBtn.disabled = false;
            saveBtn.textContent = prev;
        }
    }

    overlay.appendChild(h('div', { class: 'modal-card modal-compact', style: { width: '680px', maxWidth: 'calc(100vw - 32px)', maxHeight: 'calc(100vh - 60px)', display: 'flex', flexDirection: 'column' } },
        h('header', { class: 'modal-head' },
            h('h2', null, Icon('Send', { size: 16 }), ' Выдать со склада'),
            h('button', { class: 'modal-close', onclick: close }, '×')),
        h('div', { class: 'modal-body', style: { flex: 1, minHeight: 0, overflowY: 'auto' } },
            h('div', { style: { overflowX: 'auto', border: '1px solid var(--ink-100)', borderRadius: '10px', marginBottom: '10px' } },
                h('table', { class: 'tbl' },
                    h('thead', null, h('tr', null,
                        h('th', null, 'Товар'),
                        h('th', null, 'Ед. выдачи'),
                        h('th', null, 'Кол-во'),
                        h('th', null, ''),
                    )),
                    linesBody,
                ),
            ),
            addLineBtn,
            field('Кому', h('div', null, recipientInp, deptList), { required: true }),
            field('Примечание', noteInp),
        ),
        h('footer', { class: 'modal-foot' },
            h('button', { class: 'btn', type: 'button', onclick: close }, 'Отмена'),
            h('span', { class: 'grow' }),
            saveBtn),
    ));
    document.body.appendChild(overlay);

    (async () => {
        try {
            const [pr, dr] = await Promise.all([
                supabase.from('products')
                    .select('id,name,base_unit,consumption_unit,consumption_factor,on_hand')
                    .eq('active', 1).order('name', { ascending: true }),
                supabase.from('departments').select('name').eq('active', 1).order('name', { ascending: true }),
            ]);
            if (pr.error) throw pr.error;
            modal.products = pr.data || [];
            modal.departments = (dr.error ? [] : dr.data) || [];
            for (const d of modal.departments) deptList.appendChild(h('option', { value: d.name }));
        } catch (e) {
            toast('Не удалось загрузить товары: ' + ((e && e.message) || e), 'fail');
            modal.products = [];
        } finally {
            clear(linesBody);
            addLineBtn.disabled = false;
            if (!modal.products.length) {
                linesBody.appendChild(h('tr', null,
                    h('td', { colspan: '4', style: { textAlign: 'center', padding: '16px', color: 'var(--ink-500)', fontSize: '12.5px' } }, 'Нет активных товаров.')));
            } else {
                addLine();
            }
        }
    })();
}
```

- [ ] **Step 2: Syntax check**

Run: `node --check public/js/admin/views/inventory-sklad.js`
Expected: exit 0, no output.

- [ ] **Step 3: Commit**

```bash
git add public/js/admin/views/inventory-sklad.js
git commit -m "feat: Закупки — Склад tab module (filters, flags, Выдать, Excel export/шаблон/импорт)"
```

---

### Task 9: «Поставщики» tab module (`inventory-suppliers.js`)

**Files:**
- Create: `public/js/admin/views/inventory-suppliers.js`

- [ ] **Step 1: Create `public/js/admin/views/inventory-suppliers.js`**

```js
// Закупки — «Поставщики» tab (PROCUREMENT_REDESIGN_V1): простой CRUD-справочник.
// Удаления нет — поставщика деактивируют, чтобы прошлые записи не ломались
// (registry: delete roles []).
import { supabase } from '../../supabase.js';
import { h, Icon, clear, toast, Tag, field, checkField } from '../ui.js';
import { fetchGuard } from './inventory-shared.js';

const refs = { tbody: null, emptyEl: null, totalEl: null };

export function renderSuppliersTab(container) {
    refs.tbody = h('tbody');
    refs.emptyEl = h('div', { class: 'empty', style: { display: 'none' } },
        'Пока нет поставщиков — добавьте первого.');
    refs.totalEl = h('span', { class: 'muted', style: { fontSize: '12px' } }, '');

    const addBtn = h('button', {
        class: 'btn btn-primary btn-sm', type: 'button',
        onclick: () => openSupplierModal(null, fetchAndPaint),
    }, Icon('Plus', { size: 14 }), ' Добавить поставщика');

    container.appendChild(h('div', null,
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px', marginBottom: '12px' } },
            refs.totalEl,
            h('div', { class: 'page-head-actions' }, addBtn),
        ),
        h('div', { class: 'card' },
            h('table', { class: 'tbl' },
                h('thead', null, h('tr', null,
                    h('th', null, 'Название'),
                    h('th', null, 'Контактное лицо'),
                    h('th', null, 'Телефон'),
                    h('th', null, 'Примечание'),
                    h('th', null, 'Статус'),
                )),
                refs.tbody,
            ),
            refs.emptyEl,
        ),
    ));

    fetchAndPaint();
}

async function fetchAndPaint() {
    const token = ++fetchGuard.token;
    clear(refs.tbody);
    refs.tbody.appendChild(h('tr', null,
        h('td', { colspan: '5', style: { textAlign: 'center', padding: '24px', color: 'var(--ink-500)', fontSize: '12.5px' } }, 'Загрузка…')));
    try {
        const { data, error } = await supabase.from('suppliers')
            .select('*')
            .order('name', { ascending: true })
            .limit(500);
        if (token !== fetchGuard.token) return;
        if (error) throw error;
        paintRows(data || []);
        refs.totalEl.textContent = `Поставщиков: ${(data || []).length}`;
    } catch (e) {
        if (token !== fetchGuard.token) return;
        toast('Не удалось загрузить поставщиков: ' + ((e && e.message) || e), 'fail');
        paintRows([]);
    }
}

function paintRows(rows) {
    clear(refs.tbody);
    if (!rows.length) { refs.emptyEl.style.display = ''; return; }
    refs.emptyEl.style.display = 'none';
    for (const s of rows) {
        refs.tbody.appendChild(h('tr', {
            class: 'row-click',
            style: { cursor: 'pointer', opacity: s.active ? '' : '0.55' },
            onclick: () => openSupplierModal(s, fetchAndPaint),
        },
            h('td', { class: 'cell-strong' }, s.name || '—'),
            h('td', null, s.contact || '—'),
            h('td', null, s.phone || '—'),
            h('td', { class: 'muted' }, s.note || ''),
            h('td', null, Tag(s.active ? 'Активен' : 'Неактивен', { kind: s.active ? 'ok' : '', dot: true })),
        ));
    }
}

function openSupplierModal(s, onSaved) {
    const isEdit = !!s;
    const overlay = h('div', { class: 'modal' });
    const close = () => overlay.remove();
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));

    const nameInp = h('input', { type: 'text', required: true, value: s ? (s.name || '') : '' });
    const contactInp = h('input', { type: 'text', value: s ? (s.contact || '') : '' });
    const phoneInp = h('input', { type: 'text', value: s ? (s.phone || '') : '' });
    const noteInp = h('input', { type: 'text', value: s ? (s.note || '') : '' });
    const activeChk = h('input', { type: 'checkbox', checked: s ? !!s.active : true });

    const saveBtn = h('button', { class: 'btn btn-primary', type: 'button' }, isEdit ? 'Сохранить' : 'Добавить');
    saveBtn.addEventListener('click', save);

    async function save() {
        const name = nameInp.value.trim();
        if (!name) { toast('Укажите название поставщика.', 'fail'); return; }
        saveBtn.disabled = true;
        const prev = saveBtn.textContent;
        saveBtn.textContent = 'Сохраняем…';
        try {
            const payload = {
                name,
                contact: contactInp.value.trim(),
                phone:   phoneInp.value.trim(),
                note:    noteInp.value.trim(),
                active:  activeChk.checked ? 1 : 0,
            };
            const { error } = isEdit
                ? await supabase.from('suppliers').update(payload).eq('id', s.id).select().single()
                : await supabase.from('suppliers').insert(payload).select().single();
            if (error) throw error;
            toast('Сохранено', 'ok');
            close();
            if (typeof onSaved === 'function') await onSaved();
        } catch (e) {
            toast((e && e.message) || 'Не удалось сохранить.', 'fail');
            saveBtn.disabled = false;
            saveBtn.textContent = prev;
        }
    }

    overlay.appendChild(h('div', { class: 'modal-card modal-compact', style: { width: '420px', maxWidth: 'calc(100vw - 32px)' } },
        h('header', { class: 'modal-head' },
            h('h2', null, Icon('Building', { size: 16 }), ' ', isEdit ? 'Поставщик' : 'Добавить поставщика'),
            h('button', { class: 'modal-close', onclick: close }, '×')),
        h('div', { class: 'modal-body' },
            field('Название', nameInp, { required: true }),
            field('Контактное лицо', contactInp),
            field('Телефон', phoneInp),
            field('Примечание', noteInp),
            checkField('Активен', activeChk),
        ),
        h('footer', { class: 'modal-foot' },
            h('button', { class: 'btn', type: 'button', onclick: close }, 'Отмена'),
            h('span', { class: 'grow' }),
            saveBtn),
    ));
    document.body.appendChild(overlay);
    nameInp.focus();
}
```

- [ ] **Step 2: Syntax check**

Run: `node --check public/js/admin/views/inventory-suppliers.js`
Expected: exit 0, no output.

- [ ] **Step 3: Commit**

```bash
git add public/js/admin/views/inventory-suppliers.js
git commit -m "feat: Закупки — Поставщики tab module (CRUD, deactivate instead of delete)"
```

---

### Task 10: Rewrite the shell (`inventory.js`) and wire everything

**Files:**
- Rewrite: `public/js/admin/views/inventory.js` (replace the entire file)
- Modify: `public/js/admin.js` (one line — the inventory import's `?v=`)
- Modify: `public/admin.html` (one line — admin-views.css `?v=`)

- [ ] **Step 1: Replace the entire contents of `public/js/admin/views/inventory.js`**

```js
// Закупки — PROCUREMENT_REDESIGN_V1 — workspace shell matching the cloud
// design. Page head «Закупки» + toolbar chips (Дашборд / Отделения / Сроки
// годности / Инвентаризация / Журнал / Обновить) + underline tabs (Склад /
// Заявки / Заказы на закупку / Товары / Поставщики).
//
// Live panes: Склад (inventory-sklad.js), Товары (inventory-products.js),
// Поставщики (inventory-suppliers.js), Дашборд + Журнал (this file).
// Заявки / Заказы / Отделения / Сроки годности / Инвентаризация are visible
// «Во 2-й фазе» placeholders (spec 2026-08-05-procurement-redesign-design.md).
//
// on_hand / avg_cost change ONLY through RPCs (receive_stock_lines,
// adjust_stock, issue_stock_lines, dispense_item/void_dispense) — the
// allow-list in server/db/schema-registry.js enforces this.
import { supabase } from '../../supabase.js';
import { h, Icon, clear, toast, fmtDateTime } from '../ui.js';
import {
    fetchGuard, loadingCard, comingSoon, fmtPrice, fmtQty, fmtSignedQty,
    movementTag, fetchMovements,
} from './inventory-shared.js';
import { renderProductsTab } from './inventory-products.js';
import { renderSkladTab } from './inventory-sklad.js';
import { renderSuppliersTab } from './inventory-suppliers.js';

const refs = { container: null, onNavigate: null, chipsEl: null, tabBarEl: null, contentEl: null };
const state = { pane: 'sklad' };

const TABS = [
    { id: 'sklad',           label: 'Склад',             icon: 'Layers' },
    { id: 'requisitions',    label: 'Заявки',            icon: 'Send' },
    { id: 'purchase_orders', label: 'Заказы на закупку', icon: 'Receipt' },
    { id: 'products',        label: 'Товары',            icon: 'Pill' },
    { id: 'suppliers',       label: 'Поставщики',        icon: 'Building' },
];
const CHIPS = [
    { id: 'dashboard',   label: 'Дашборд',        icon: 'Chart' },
    { id: 'departments', label: 'Отделения',      icon: 'Building' },
    { id: 'expiry',      label: 'Сроки годности', icon: 'Clock' },
    { id: 'stockcount',  label: 'Инвентаризация', icon: 'Grid' },
    { id: 'audit',       label: 'Журнал',         icon: 'Activity' },
];

export async function renderInventory(container, { onNavigate } = {}) {
    refs.container = container;
    refs.onNavigate = onNavigate;
    state.pane = 'sklad';   // всегда открываемся на Складе
    mount();
    await repaint();
}

function mount() {
    clear(refs.container);
    refs.chipsEl = h('div', { class: 'page-head-actions', style: { flexWrap: 'wrap' } });
    refs.tabBarEl = h('div', { class: 'proc-tabs' });
    refs.contentEl = h('div', { class: 'proc-tab-content' });
    paintChips();
    paintTabBar();

    refs.container.appendChild(h('div', { class: 'fade-in' },
        h('div', { class: 'page-head' },
            h('div', null,
                h('h1', { class: 'page-title' }, 'Закупки'),
                h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '2px' } },
                    'Остатки, поставщики и заказы на закупку — по всем филиалам клиники.'),
            ),
            refs.chipsEl,
        ),
        refs.tabBarEl,
        refs.contentEl,
    ));
}

function setPane(id) {
    if (state.pane !== id) {
        state.pane = id;
        paintChips();
        paintTabBar();
    }
    repaint();
}

function paintChips() {
    clear(refs.chipsEl);
    for (const c of CHIPS) {
        const active = state.pane === c.id;
        refs.chipsEl.appendChild(h('button', {
            class: 'btn btn-sm ' + (active ? 'btn-primary' : 'btn-outline'),
            type: 'button',
            onclick: () => setPane(c.id),
        }, Icon(c.icon, { size: 14 }), ' ' + c.label));
    }
    refs.chipsEl.appendChild(h('button', {
        class: 'btn btn-sm btn-outline', type: 'button', title: 'Обновить данные',
        onclick: () => repaint(),
    }, Icon('Refresh', { size: 14 }), ' Обновить'));
}

function paintTabBar() {
    clear(refs.tabBarEl);
    for (const t of TABS) {
        const active = state.pane === t.id;
        refs.tabBarEl.appendChild(h('button', {
            class: 'proc-tab' + (active ? ' active' : ''),
            type: 'button',
            onclick: () => setPane(t.id),
        }, Icon(t.icon, { size: 14 }), t.label));
    }
}

async function repaint() {
    clear(refs.contentEl);
    const container = refs.contentEl;
    switch (state.pane) {
        case 'sklad':      return renderSkladTab(container);
        case 'products':   return renderProductsTab(container);
        case 'suppliers':  return renderSuppliersTab(container);
        case 'dashboard':  return renderDashboardTab(container);
        case 'audit':      return renderAuditTab(container);
        case 'requisitions':
            return void container.appendChild(comingSoon('Заявки',
                'Заявки на закупку — запрос, согласование, превращение в заказ. Во 2-й фазе.', 'Send'));
        case 'purchase_orders':
            return void container.appendChild(comingSoon('Заказы на закупку',
                'Создание заказов поставщикам и приёмка по ним. Во 2-й фазе.', 'Receipt'));
        case 'departments':
            return void container.appendChild(comingSoon('Отделения',
                'Товары и остатки по отделениям. Во 2-й фазе.', 'Building'));
        case 'expiry':
            return void container.appendChild(comingSoon('Сроки годности',
                'Партии и сроки годности (FEFO). Во 2-й фазе.', 'Clock'));
        case 'stockcount':
            return void container.appendChild(comingSoon('Инвентаризация',
                'Пересчёт фактических остатков и проведение расхождений. Во 2-й фазе.', 'Grid'));
        default:
            return;
    }
}

// =============================================================================
// ДАШБОРД
// =============================================================================
const KPI_ACCENT = {
    primary: { fg: 'var(--primary-600)', bg: 'var(--primary-50)' },
    ok:      { fg: 'var(--ok-700)',      bg: 'var(--ok-50)' },
    warn:    { fg: 'var(--warn-700)',    bg: 'var(--warn-50)' },
    info:    { fg: 'var(--info-700)',    bg: 'var(--info-50)' },
};

function kpiTile({ icon, accent, label, value, meta, valueWarn, onClick }) {
    const a = KPI_ACCENT[accent] || KPI_ACCENT.primary;
    return h('div', { class: 'dash-kpi', onclick: onClick || undefined },
        h('div', { class: 'dash-kpi-top' },
            h('div', { class: 'dash-kpi-icon', style: { color: a.fg, background: a.bg } }, Icon(icon, { size: 18 })),
            onClick ? h('span', { class: 'dash-kpi-go' }, '→') : null,
        ),
        h('div', { class: 'dash-kpi-label' }, label),
        h('div', {
            class: 'dash-kpi-value num',
            style: valueWarn ? { color: 'var(--warn-700)' } : null,
        }, value),
        meta ? h('div', { class: 'dash-kpi-meta' }, meta) : null,
    );
}

async function renderDashboardTab(container) {
    container.appendChild(loadingCard());
    const token = ++fetchGuard.token;

    let products = null;
    let productsError = null;
    try {
        const res = await supabase.from('products')
            .select('id,name,on_hand,avg_cost,sale_price,reorder_level,base_unit,procurement_category,active')
            .limit(1000);
        products = res.data;
        productsError = res.error;
    } catch (e) {
        productsError = e;
    }
    if (token !== fetchGuard.token) return;

    const { data: recent } = await fetchMovements({ kind: 'receive', limit: 8 });
    if (token !== fetchGuard.token) return;

    clear(container);

    if (productsError) {
        toast('Не удалось загрузить дашборд: ' + (productsError.message || productsError), 'fail');
        container.appendChild(h('div', { class: 'empty' }, 'Не удалось загрузить данные.'));
        return;
    }

    const all = products || [];
    const active = all.filter(p => p.active);
    const productsById = new Map(all.map(p => [p.id, p]));

    const stockValue = active.reduce((s, p) => s + (Number(p.on_hand) || 0) * (Number(p.avg_cost) || 0), 0);
    const lowStock = active.filter(p => {
        const reorder = Number(p.reorder_level) || 0;
        const onHand = Number(p.on_hand) || 0;
        return reorder > 0 && onHand <= reorder;
    });
    const categories = new Set(active.map(p => p.procurement_category).filter(Boolean));

    const grid = h('div', { class: 'dash-kpi-row' },
        kpiTile({ icon: 'Pill', accent: 'primary', label: 'Товары', value: String(active.length) }),
        kpiTile({ icon: 'Coins', accent: 'ok', label: 'Стоимость склада', value: fmtPrice(stockValue) }),
        kpiTile({
            icon: 'Warning', accent: lowStock.length > 0 ? 'warn' : 'ok', label: 'Мало на складе',
            value: String(lowStock.length), valueWarn: lowStock.length > 0,
            onClick: () => setPane('sklad'),
        }),
        kpiTile({ icon: 'Layers', accent: 'info', label: 'Категории', value: String(categories.size) }),
    );

    const detailGrid = h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1.3fr', gap: '16px', marginTop: '16px' } },
        lowStockCard(lowStock),
        recentReceiptsCard(recent || [], productsById),
    );

    container.appendChild(h('div', null, grid, detailGrid));
}

function lowStockCard(list) {
    if (!list.length) {
        return h('div', { class: 'card' },
            h('div', { class: 'card-header' }, h('h3', null, Icon('Pill', { size: 15 }), ' Мало на складе')),
            h('div', { class: 'empty', style: { padding: '28px 20px' } }, 'Все остатки выше минимума.'),
        );
    }
    const shown = list.slice(0, 10);
    return h('div', { class: 'card' },
        h('div', { class: 'card-header' },
            h('h3', null, Icon('Warning', { size: 15 }), ' Мало на складе ', h('span', { class: 'h-count' }, String(list.length))),
        ),
        h('div', { style: { display: 'flex', flexDirection: 'column' } },
            ...shown.map(p => h('div', {
                style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 16px', borderTop: '1px solid var(--ink-100)' },
            },
                h('div', { style: { fontWeight: 600, fontSize: '13px', color: 'var(--ink-900)' } }, p.name || '—'),
                h('div', { class: 'muted num', style: { fontSize: '12px' } },
                    `${fmtQty(Number(p.on_hand) || 0)} / ${fmtQty(Number(p.reorder_level) || 0)} ${p.base_unit || ''}`.trim()),
            )),
        ),
    );
}

function recentReceiptsCard(rows, productsById) {
    if (!rows.length) {
        return h('div', { class: 'card' },
            h('div', { class: 'card-header' }, h('h3', null, Icon('Download', { size: 15 }), ' Последние приходы')),
            h('div', { class: 'empty', style: { padding: '28px 20px' } }, 'Приходов пока нет.'),
        );
    }
    return h('div', { class: 'card' },
        h('div', { class: 'card-header' }, h('h3', null, Icon('Download', { size: 15 }), ' Последние приходы')),
        h('table', { class: 'tbl' },
            h('thead', null, h('tr', null,
                h('th', null, 'Дата'), h('th', null, 'Товар'), h('th', null, 'Кол-во'), h('th', null, 'Цена за ед.'),
            )),
            h('tbody', null, ...rows.map(m => {
                const fallback = productsById.get(m.product_id);
                const name = (m.products && m.products.name) || (fallback && fallback.name) || `Товар #${m.product_id}`;
                const unit = (fallback && fallback.base_unit) || (m.products && (m.products.base_unit || m.products.unit)) || '';
                return h('tr', null,
                    h('td', null, fmtDateTime(m.created_at)),
                    h('td', null, name),
                    h('td', { class: 'num' }, `${fmtQty(Number(m.qty) || 0)} ${unit}`.trim()),
                    h('td', { class: 'num' }, m.unit_cost != null ? fmtPrice(m.unit_cost) : '—'),
                );
            })),
        ),
    );
}

// =============================================================================
// ЖУРНАЛ ДВИЖЕНИЙ
// =============================================================================
const audit = { kind: 'all', q: '' };

async function renderAuditTab(container) {
    container.appendChild(loadingCard());
    const token = ++fetchGuard.token;

    const { data, error } = await fetchMovements({ limit: 300 });
    if (token !== fetchGuard.token) return;

    clear(container);

    if (error) {
        toast('Не удалось загрузить журнал: ' + (error.message || error), 'fail');
        container.appendChild(h('div', { class: 'card' }, h('div', { class: 'empty' }, 'Не удалось загрузить движения.')));
        return;
    }

    const rows = data || [];
    const tbody = h('tbody');

    const selStyleSmall = { height: '30px', padding: '0 8px', border: '1px solid var(--ink-200)', borderRadius: '8px', fontSize: '12.5px', background: 'white', fontFamily: 'inherit' };
    const kindSel = h('select', { style: selStyleSmall },
        ...[['all', 'Все типы'], ['receive', 'Приход'], ['issue', 'Выдача'], ['dispense', 'Списание'], ['adjust', 'Корректировка'], ['void', 'Отмена']]
            .map(([v, label]) => h('option', { value: v, selected: v === audit.kind }, label)));
    kindSel.addEventListener('change', () => { audit.kind = kindSel.value; paint(); });

    const qInp = h('input', { type: 'text', placeholder: 'Поиск товара…', value: audit.q,
        style: { height: '30px', padding: '0 8px', border: '1px solid var(--ink-200)', borderRadius: '8px', fontSize: '12.5px', fontFamily: 'inherit', width: '220px' } });
    qInp.addEventListener('input', () => { audit.q = qInp.value; paint(); });

    function paint() {
        clear(tbody);
        const q = audit.q.trim().toLowerCase();
        const shown = rows.filter(m => {
            const isIssue = m.kind === 'dispense' && m.reference_type === 'issue';
            if (audit.kind === 'issue' && !isIssue) return false;
            if (audit.kind === 'dispense' && (m.kind !== 'dispense' || isIssue)) return false;
            if (audit.kind !== 'all' && audit.kind !== 'issue' && audit.kind !== 'dispense' && m.kind !== audit.kind) return false;
            if (q) {
                const name = (m.products && m.products.name) || '';
                if (!name.toLowerCase().includes(q)) return false;
            }
            return true;
        });
        if (!shown.length) {
            tbody.appendChild(h('tr', null,
                h('td', { colspan: '7', style: { textAlign: 'center', padding: '24px', color: 'var(--ink-500)', fontSize: '12.5px' } }, 'Нет подходящих движений.')));
            return;
        }
        for (const m of shown) tbody.appendChild(auditRow(m));
    }

    container.appendChild(h('div', { class: 'card' },
        h('div', { class: 'card-header', style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
            h('h3', null, Icon('Activity', { size: 15 }), ' Журнал движений'),
            h('span', { class: 'grow' }),
            qInp,
            kindSel,
        ),
        h('div', { style: { overflowX: 'auto' } },
            h('table', { class: 'tbl' },
                h('thead', null, h('tr', null,
                    h('th', null, 'Когда'),
                    h('th', null, 'Товар'),
                    h('th', null, 'Тип'),
                    h('th', null, 'Кол-во'),
                    h('th', null, 'Цена за ед.'),
                    h('th', null, 'Основание'),
                    h('th', null, 'Кто'),
                )),
                tbody,
            ),
        ),
    ));
    paint();
}

function auditRow(m) {
    const name = (m.products && m.products.name) || '—';
    const unit = (m.products && (m.products.base_unit || m.products.unit)) || '';
    const who = (m.users && (m.users.full_name || m.users.username)) || '—';
    return h('tr', null,
        h('td', null, fmtDateTime(m.created_at)),
        h('td', null, name),
        h('td', null, movementTag(m)),
        h('td', { class: 'num' }, fmtSignedQty(m.qty, unit)),
        h('td', { class: 'num' }, m.unit_cost != null ? fmtPrice(m.unit_cost) : '—'),
        h('td', { class: 'muted' }, m.note || ''),
        h('td', null, who),
    );
}
```

- [ ] **Step 2: Bump the cache-busting versions**

In `public/js/admin.js`, find the line (~line 63):

```js
import { renderInventory }    from './admin/views/inventory.js?v=inv1';   // INVENTORY_UI_V1
```

replace with:

```js
import { renderInventory }    from './admin/views/inventory.js?v=zakupki1';   // PROCUREMENT_REDESIGN_V1
```

In `public/admin.html`, find:

```html
<link rel="stylesheet" href="css/admin-views.css?v=navbadge1">
```

replace with:

```html
<link rel="stylesheet" href="css/admin-views.css?v=proctabs1">
```

- [ ] **Step 3: Syntax check + full suite**

Run: `node --check public/js/admin/views/inventory.js && npm test`
Expected: no syntax errors; all server tests pass (UI changes don't affect them).

- [ ] **Step 4: Commit**

Before committing, run `git status --short` and confirm ONLY these three files are listed as modified. If other files appear modified, do NOT add them.

```bash
git add public/js/admin/views/inventory.js public/js/admin.js public/admin.html
git commit -m "feat: Закупки — RU shell (chips + underline tabs), Дашборд/Журнал RU, wire Склад/Товары/Поставщики"
```

---

### Task 11: Verification & finish

**Files:** none (verification)

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: all tests pass, 0 failing.

- [ ] **Step 2: Manual smoke (use the superpowers:verification-before-completion skill)**

Start the app from the worktree — if port 8000 is busy (the parallel session may be running it), use another port:

```bash
npm start            # or: PORT=8001 npm start
```

Then in the browser (`http://localhost:8000` or `:8001`), log in as an admin and verify against the spec's success criteria:

1. Sidebar → Закупки opens on the **Склад** tab: header «Закупки» + subtitle; chips Дашборд/Отделения/Сроки годности/Инвентаризация/Журнал/Обновить; underline tabs Склад/Заявки/Заказы на закупку/Товары/Поставщики.
2. **Поставщики**: add «ООО Медснаб» (contact + phone) — appears in the list.
3. **Товары**: add a product with base unit «флакон», consumption «мл» ×50, reorder level 2, supplier «ООО Медснаб».
4. **Принять** (from Склад toolbar): receive 10 флаконов at 2000 — Склад row shows В наличии 10, Выдать «500 мл», Себестоимость 2 000, Стоимость 20 000, Flag OK.
5. **Выдать**: 100 мл to «Процедурный кабинет» — В наличии drops to 8; **Журнал** shows «Выдача −2 флакон», Основание contains the recipient, Кто = your user.
6. **Корректировка** (from Склад toolbar, no preselected product): pick the product, −1 with a reason — stock 7, journal row «Корректировка».
7. Drive stock to ≤ 2 (reorder level) — row shows red ⚠ and **Reorder** flag; filters: search, unit, supplier, «Заканчивается», flag Reorder each narrow the table; «Заказать» is disabled with a tooltip.
8. **Excel** downloads the filtered table; **Шаблон** downloads; fill the template with 2 new products and **Импорт из Excel** — toast reports created/received counts and rows appear with stock and supplier. Import a file with an empty Название in row 3 — toast says «Строка 3…», nothing changed.
9. **Дашборд** chip: RU KPIs (Товары / Стоимость склада / Мало на складе / Категории); clicking «Мало на складе» jumps to Склад. Placeholder chips/tabs show «Во 2-й фазе» cards. «Обновить» repaints the current pane.
10. Regression: Настройки → existing flows (a visit with product dispensing via the item picker) still work — `dispense_item` untouched.

If anything fails: fix, re-run `npm test`, and amend the relevant commit story with a new commit (do not rewrite history).

- [ ] **Step 3: Finish the branch**

Use the superpowers:finishing-a-development-branch skill to merge `phase15-procurement` back (target: the branch it was cut from) and remove the worktree. Coordinate with the parallel session before merging — its WIP files do not overlap with this plan's files, so a clean merge is expected.
