-- SUPPLIERS_VAT_V1 (2026-09-28) — ПОСТАВЩИКИ ↔ ТОВАРЫ, СТАВКА НДС ТОВАРА И
-- ПРИХОДА (docs/plans/2026-09-28-suppliers-vat.md).
--
-- Владелец: «connect the providers to the drug products … one provider can have
-- multiple drugs … set up price and VAT rate. Also in the report of the
-- procurement too.»
--
-- СТАВКА НДС — ровно три значения: 12, 0 или NULL («без НДС»). Какие именно,
-- решает сервер (public/js/shared/goods-catalog.js VAT_RATES): CHECK здесь
-- только от мусора. Жёстко перечислить ставки в CHECK значило бы, что смена
-- ставки законом (было 20, потом 15, с 2023 — 12) требует пересборки трёх
-- таблиц; в коде это одна строка.
--
--   products.vat_rate        — НДС в цене продажи товара (цена продажи — с НДС,
--                              как у услуг services.tax_rate). Товары до этой
--                              миграции — NULL, «без НДС»: их налог в отчётах
--                              остаётся таким, каким был (0).
--   item_suppliers.vat_rate  — НДС поставщика на этот товар: по умолчанию для
--                              строки прихода от этого поставщика.
--                              last_price — цена закупки БЕЗ НДС за единицу
--                              закупки (как в счёте-фактуре).
--   stock_movements.vat_rate / vat_amount — НДС строки прихода: ставка и сумма
--                              (сумма без НДС × ставка). NULL в обеих — приход
--                              до этой версии или без ставки («не указан»);
--                              «без НДС» — vat_rate NULL и vat_amount 0.
--                              unit_cost остаётся себестоимостью на складе —
--                              с НДС, то есть сколько клиника заплатила.
ALTER TABLE products ADD COLUMN vat_rate REAL
  CHECK (vat_rate IS NULL OR (vat_rate >= 0 AND vat_rate <= 100));
ALTER TABLE item_suppliers ADD COLUMN vat_rate REAL
  CHECK (vat_rate IS NULL OR (vat_rate >= 0 AND vat_rate <= 100));
ALTER TABLE stock_movements ADD COLUMN vat_rate REAL
  CHECK (vat_rate IS NULL OR (vat_rate >= 0 AND vat_rate <= 100));
ALTER TABLE stock_movements ADD COLUMN vat_amount REAL
  CHECK (vat_amount IS NULL OR vat_amount >= 0);

-- МНОГИЕ-КО-МНОГИМ ПОЛНОЕ С ПЕРВОГО ДНЯ. Связи item_suppliers заводила только
-- карточка товара; приход и импорт Excel писали поставщика в движение и в
-- products.supplier_id, а связи — нет. Карточка поставщика («все его товары»)
-- показала бы пустоту у поставщика, от которого клиника принимает товар годами.
-- Поэтому связи заводятся:
--   1) из истории приходов (свой приход — stock_movements.supplier_id, приход по
--      заказу — поставщик заказа; то же правило, что у отчёта «Приход по
--      поставщикам») — с последней ценой: себестоимость единицы × упаковка =
--      цена за единицу закупки. НДС у старых приходов не записан, поэтому и у
--      связи он «без НДС»: старая цена — это цена, которую платили;
--   2) из «основного поставщика» товара (products.supplier_id) — без цены.
-- INSERT OR IGNORE: связь, которую уже завели в карточке, не трогается.
INSERT OR IGNORE INTO item_suppliers (product_id, supplier_id, last_price, pack_factor, purchase_unit)
SELECT x.product_id, x.supplier_id,
       (SELECT round(m2.unit_cost * (CASE WHEN p.pack_factor > 0 THEN p.pack_factor ELSE 1 END), 2)
          FROM stock_movements m2
          LEFT JOIN purchase_orders po2 ON m2.reference_type = 'purchase_order' AND po2.id = m2.reference_id
         WHERE m2.kind = 'receive' AND m2.product_id = x.product_id AND m2.unit_cost IS NOT NULL
           AND COALESCE(m2.supplier_id, po2.supplier_id) = x.supplier_id
         ORDER BY m2.id DESC LIMIT 1),
       p.pack_factor, p.purchase_unit
  FROM (SELECT DISTINCT sm.product_id AS product_id, COALESCE(sm.supplier_id, po.supplier_id) AS supplier_id
          FROM stock_movements sm
          LEFT JOIN purchase_orders po ON sm.reference_type = 'purchase_order' AND po.id = sm.reference_id
         WHERE sm.kind = 'receive' AND COALESCE(sm.supplier_id, po.supplier_id) IS NOT NULL) x
  JOIN products p  ON p.id = x.product_id
  JOIN suppliers s ON s.id = x.supplier_id;

INSERT OR IGNORE INTO item_suppliers (product_id, supplier_id, pack_factor, purchase_unit)
SELECT p.id, p.supplier_id, p.pack_factor, p.purchase_unit
  FROM products p
  JOIN suppliers s ON s.id = p.supplier_id;
