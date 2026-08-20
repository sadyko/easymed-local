-- CASHIER_DESIGN_V2 — cash drawer movements («Внести» / «Изъять») per shift.
-- Drawer math: остаток = opening_float + cash payments + in − out; the same
-- formula feeds cash_shift_summary and close_cash_shift's expected amount.
CREATE TABLE cash_movements (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  shift_id   INTEGER NOT NULL REFERENCES cash_shifts(id),
  kind       TEXT NOT NULL CHECK (kind IN ('in','out')),
  amount     REAL NOT NULL,
  article    TEXT NOT NULL DEFAULT '',
  note       TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_cash_movements_shift ON cash_movements(shift_id);
