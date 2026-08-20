-- 036_product_supplier.sql
-- PROCUREMENT_REDESIGN_V1 — primary supplier link on the product card
-- (Склад's «Поставщик» column, Excel import's auto-created suppliers).
-- The item_suppliers junction (mig 028) keeps multi-supplier pricing;
-- this is the ONE default supplier the list and import work with.
ALTER TABLE products ADD COLUMN supplier_id INTEGER REFERENCES suppliers(id);
