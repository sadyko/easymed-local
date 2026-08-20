CREATE TABLE products (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  code          TEXT,
  unit          TEXT NOT NULL DEFAULT 'pcs',
  category      TEXT NOT NULL DEFAULT 'other' CHECK (category IN ('drug','consumable','other')),
  sale_price    REAL NOT NULL DEFAULT 0,
  on_hand       REAL NOT NULL DEFAULT 0,
  reorder_level REAL NOT NULL DEFAULT 0,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE stock_movements (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id     INTEGER NOT NULL REFERENCES products(id),
  kind           TEXT NOT NULL CHECK (kind IN ('receive','dispense','adjust','void')),
  qty            REAL NOT NULL,
  unit_cost      REAL,
  reference_type TEXT,
  reference_id   INTEGER,
  note           TEXT NOT NULL DEFAULT '',
  created_by     INTEGER REFERENCES users(id),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_stock_movements_product ON stock_movements(product_id);

ALTER TABLE visit_services ADD COLUMN clinic_item_id INTEGER REFERENCES products(id);
