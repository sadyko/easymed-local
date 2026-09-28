-- SUPPLIERS_VAT_V1 (2026-09-28) — НДС В СТРОКЕ ЗАКАЗА НА ЗАКУПКУ.
--
-- Строка заказа несёт ту же пару, что строка прихода (мигр. 222):
--   unit_cost  — цена за единицу БЕЗ НДС (как в счёте-фактуре поставщика);
--   vat_rate   — ставка НДС строки: 12, 0 или NULL («без НДС»); какие ставки
--                допустимы, решает сервер (goods-catalog.js VAT_RATES);
--   vat_amount — НДС на заказанное количество (qty_ordered × unit_cost ×
--                ставка / 100). NULL в обеих колонках — строка заказа до этой
--                миграции: НДС «не указан», и приход по ней пишет «не указан»,
--                как прежде (цена — себестоимость). «Без НДС» — vat_rate NULL
--                и vat_amount 0.
-- Приход по заказу (receive_purchase_order) пишет ставку и НДС принятого
-- количества в движение и считает себестоимость с НДС — как «Принять товар».
ALTER TABLE purchase_order_items ADD COLUMN vat_rate REAL
  CHECK (vat_rate IS NULL OR (vat_rate >= 0 AND vat_rate <= 100));
ALTER TABLE purchase_order_items ADD COLUMN vat_amount REAL
  CHECK (vat_amount IS NULL OR vat_amount >= 0);
