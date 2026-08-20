ALTER TABLE products ADD COLUMN base_unit          TEXT NOT NULL DEFAULT 'pcs';
ALTER TABLE products ADD COLUMN purchase_unit      TEXT;
ALTER TABLE products ADD COLUMN pack_factor        REAL NOT NULL DEFAULT 1;
ALTER TABLE products ADD COLUMN consumption_unit   TEXT;
ALTER TABLE products ADD COLUMN consumption_factor REAL NOT NULL DEFAULT 1;
ALTER TABLE products ADD COLUMN is_drug            INTEGER NOT NULL DEFAULT 0;
ALTER TABLE products ADD COLUMN avg_cost           REAL NOT NULL DEFAULT 0;
ALTER TABLE products ADD COLUMN track_batches      INTEGER NOT NULL DEFAULT 0;
ALTER TABLE products ADD COLUMN procurement_category TEXT NOT NULL DEFAULT 'consumables'
  CHECK (procurement_category IN ('medicines','consumables','equipment','lab_supplies','dental','radiology','office_it','facility'));
ALTER TABLE stock_movements ADD COLUMN branch_id INTEGER REFERENCES branches(id);
-- seed base_unit from the existing unit and is_drug from category, for existing rows
UPDATE products SET base_unit = unit WHERE unit IS NOT NULL AND unit <> '';
UPDATE products SET is_drug = 1 WHERE category = 'drug';
UPDATE products SET procurement_category = 'medicines' WHERE category = 'drug';
