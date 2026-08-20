-- 028_procurement_documents.sql
-- Phase-2 procurement documents for the LOCAL single-warehouse model.
-- Stock lives in products.on_hand (one warehouse pool); these tables are the
-- purchasing/counting PAPERWORK on top of it. They never change on_hand
-- directly — receiving a PO, issuing a requisition, and posting a stock count
-- all go through RPCs that write stock_movements + products.on_hand (Phase 2),
-- exactly like receive_stock_lines / adjust_stock already do.
--
-- Item table is `products` (NOT easymed's clinic_items); this is the deliberate
-- local single-warehouse design (see docs/specs/2026-08-05-procurement-redesign).
-- migrate.js runs this whole file in one transaction — no BEGIN/COMMIT here.

-- Suppliers — soft-deleted via active=0, never removed (referenced by POs).
CREATE TABLE IF NOT EXISTS suppliers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL,
  contact_name  TEXT,
  phone         TEXT,
  email         TEXT,
  notes         TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Which suppliers stock a product, and the last purchase price (price list).
CREATE TABLE IF NOT EXISTS item_suppliers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id    INTEGER NOT NULL REFERENCES products(id)  ON DELETE CASCADE,
  supplier_id   INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  last_price    REAL,
  pack_factor   REAL,
  purchase_unit TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (product_id, supplier_id)
);
CREATE INDEX IF NOT EXISTS idx_item_suppliers_product ON item_suppliers(product_id);
CREATE INDEX IF NOT EXISTS idx_item_suppliers_supplier ON item_suppliers(supplier_id);

-- Purchase orders — a purchasing document. Stock is added only when a PO is
-- RECEIVED (a Phase-2 RPC that posts stock_movements), never by writing here.
CREATE TABLE IF NOT EXISTS purchase_orders (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  po_number     TEXT    NOT NULL,
  supplier_id   INTEGER REFERENCES suppliers(id),
  status        TEXT    NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','ordered','partial','received','cancelled')),
  order_date    TEXT,
  expected_date TEXT,
  total         REAL    NOT NULL DEFAULT 0,
  notes         TEXT,
  created_by    INTEGER REFERENCES users(id),
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  received_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_supplier ON purchase_orders(supplier_id);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_status   ON purchase_orders(status);

CREATE TABLE IF NOT EXISTS purchase_order_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  po_id         INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  product_id    INTEGER NOT NULL REFERENCES products(id),
  qty_ordered   REAL    NOT NULL,
  qty_received  REAL    NOT NULL DEFAULT 0,
  unit_cost     REAL    NOT NULL DEFAULT 0,
  line_total    REAL    GENERATED ALWAYS AS (qty_ordered * unit_cost) STORED
);
CREATE INDEX IF NOT EXISTS idx_po_items_po      ON purchase_order_items(po_id);
CREATE INDEX IF NOT EXISTS idx_po_items_product ON purchase_order_items(product_id);

-- Requisitions — a department requests stock from the warehouse. Approving &
-- issuing moves stock via a Phase-2 RPC; converting spawns a purchase order.
CREATE TABLE IF NOT EXISTS purchase_requisitions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  req_number      TEXT    NOT NULL,
  status          TEXT    NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','submitted','approved','rejected','issued','converted')),
  department_id   INTEGER REFERENCES departments(id),
  notes           TEXT,
  reject_reason   TEXT,
  requested_by    INTEGER REFERENCES users(id),
  converted_po_id INTEGER REFERENCES purchase_orders(id),
  created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_requisitions_status ON purchase_requisitions(status);
CREATE INDEX IF NOT EXISTS idx_requisitions_dept   ON purchase_requisitions(department_id);

CREATE TABLE IF NOT EXISTS purchase_requisition_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  req_id      INTEGER NOT NULL REFERENCES purchase_requisitions(id) ON DELETE CASCADE,
  product_id  INTEGER NOT NULL REFERENCES products(id),
  qty         REAL    NOT NULL,
  note        TEXT
);
CREATE INDEX IF NOT EXISTS idx_requisition_items_req ON purchase_requisition_items(req_id);

-- Stock counts — physical inventory reconciliation. Posting a count applies the
-- variances to products.on_hand via a Phase-2 RPC (post_stock_count); status
-- only reaches 'posted' through that RPC, never by writing this table.
CREATE TABLE IF NOT EXISTS stock_counts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  count_number  TEXT    NOT NULL,
  status        TEXT    NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open','counting','posted','cancelled')),
  note          TEXT,
  counted_by    INTEGER REFERENCES users(id),
  posted_at     TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_stock_counts_status ON stock_counts(status);

CREATE TABLE IF NOT EXISTS stock_count_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  count_id     INTEGER NOT NULL REFERENCES stock_counts(id) ON DELETE CASCADE,
  product_id   INTEGER NOT NULL REFERENCES products(id),
  system_qty   REAL    NOT NULL DEFAULT 0,
  counted_qty  REAL,
  variance     REAL    GENERATED ALWAYS AS (COALESCE(counted_qty, 0) - system_qty) STORED
);
CREATE INDEX IF NOT EXISTS idx_stock_count_items_count ON stock_count_items(count_id);
