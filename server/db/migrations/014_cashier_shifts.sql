CREATE TABLE cash_shifts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cashier_id INTEGER NOT NULL REFERENCES users(id),
  branch_id INTEGER REFERENCES branches(id),
  opening_float REAL NOT NULL DEFAULT 0,
  opened_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  closed_at TEXT,
  counted_amount REAL,
  expected_amount REAL,
  over_short REAL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_cash_shifts_cashier ON cash_shifts(cashier_id, status);

ALTER TABLE payments ADD COLUMN shift_id INTEGER REFERENCES cash_shifts(id);

-- Cashiers see the Касса module by default (adds module key 'cashier' to the seeded role)
UPDATE role_permissions
SET permissions = '{"sections":["cashier","patients","dashboard","reports-hub"],"levels":{"cashier":"admin","patients":"editor","dashboard":"viewer","reports-hub":"viewer"}}'
WHERE role = 'cashier';
