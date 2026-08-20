-- 037_receive_batches.sql
-- RECEIVE_EASYMED_V1 — приход в дизайне easymed: каждая строка прихода может
-- нести поставщика, партию/серию и срок годности. Пишутся на строку журнала
-- (stock_movements) при receive_stock_lines; вкладка «Сроки годности» (FEFO)
-- позже агрегирует остатки партий из этих движений.
ALTER TABLE stock_movements ADD COLUMN supplier_id INTEGER REFERENCES suppliers(id);
ALTER TABLE stock_movements ADD COLUMN batch_no TEXT;
ALTER TABLE stock_movements ADD COLUMN expiry_date TEXT;
