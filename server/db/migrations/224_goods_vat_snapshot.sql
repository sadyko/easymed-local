-- SUPPLIERS_VAT_V1 (ревью F3, M9, M3; 2026-09-28) — СТАВКА НДС ТОВАРА ЗАПИСЫВАЕТСЯ
-- У СТРОКИ, И СУММА ПРИХОДА — КАК В СЧЁТЕ-ФАКТУРЕ.
--
-- F3. Отчёты о выручке считали НДС строки товара по СЕГОДНЯШНЕЙ ставке
-- карточки (products.vat_rate). После миграции 222 ставка у всех товаров
-- пустая, и первая же настройка ставок переписала бы «Налог», «После налога»
-- и «в т.ч. НДС (товары)» у каждого прошлого месяца; импорт строки прихода
-- «без НДС» сбрасывал её обратно. Правило: месяц читается одинаково до и
-- после обновления и до и после любой правки ставки товара. Поэтому ставка
-- записывается У СТРОКИ — в момент выдачи, вместе с ценой, которую она
-- включает:
--
--   visit_services.goods_vat_rate      — строка визита с товаром;
--   admission_services.goods_vat_rate  — строка стационара с товаром;
--   invoice_items.goods_vat_rate       — строка счёта: ставка её строки
--                                        визита или стационара, переходит при
--                                        выставлении (и при перевыставлении).
--
-- Строки, выданные ДО этой миграции, ставки не имеют (NULL) и считаются, как
-- в 3.12.1: у товара налога нет. То же NULL у товара «без НДС». Заполнения
-- задним числом нет — именно оно и переписало бы прошлое.
--
-- Записывают ставку ТРИГГЕРЫ, а не каждая дверь: товар попадает в строку
-- визита из шести мест (кабинет, окно визита, процедуры, счёт визита,
-- вкладка медсестры, лист назначений) и в строку счёта из выставления и
-- перевыставления счёта; копия правила в каждой разошлась бы с первой через
-- выпуск. Строка, вставленная со ставкой, её сохраняет.
--
-- M9. Строка счёта соседнего здания приезжает без строки визита (её
-- invoice_item_id — местная ссылка и не ездит), поэтому ставку везёт сама
-- строка счёта: goods_vat_rate входит в журнал invoice_items (триггер ниже;
-- journal.js SHIPPED). Старый отправитель колонку не шлёт — у строки
-- остаётся NULL, как у доапгрейдной продажи.
--
-- M3. «Приход по поставщикам» считал сумму строки как количество ×
-- себестоимость ЕДИНИЦЫ, а она округлена до тийина после деления на упаковку:
-- 100 коробок по 3 шт по 100 000 без НДС (12 %) давали 9 999 999 / 11 199 999
-- вместо 10 000 000 / 11 200 000 из счёта-фактуры. stock_movements.net_amount
-- — сумма строки прихода без НДС ровно как её ввели (количество × цена без
-- НДС, до деления на упаковку). NULL — приход до этой миграции: отчёт считает
-- его по-прежнему.
ALTER TABLE visit_services ADD COLUMN goods_vat_rate REAL
  CHECK (goods_vat_rate IS NULL OR (goods_vat_rate >= 0 AND goods_vat_rate <= 100));
ALTER TABLE admission_services ADD COLUMN goods_vat_rate REAL
  CHECK (goods_vat_rate IS NULL OR (goods_vat_rate >= 0 AND goods_vat_rate <= 100));
ALTER TABLE invoice_items ADD COLUMN goods_vat_rate REAL
  CHECK (goods_vat_rate IS NULL OR (goods_vat_rate >= 0 AND goods_vat_rate <= 100));
ALTER TABLE stock_movements ADD COLUMN net_amount REAL
  CHECK (net_amount IS NULL OR net_amount >= 0);

-- Выдача: ставка товара в момент вставки строки.
CREATE TRIGGER visit_services_goods_vat_ins AFTER INSERT ON visit_services
  WHEN NEW.clinic_item_id IS NOT NULL AND NEW.goods_vat_rate IS NULL
  BEGIN
    UPDATE visit_services SET goods_vat_rate = (SELECT p.vat_rate FROM products p WHERE p.id = NEW.clinic_item_id)
     WHERE id = NEW.id;
  END;
CREATE TRIGGER admission_services_goods_vat_ins AFTER INSERT ON admission_services
  WHEN NEW.clinic_item_id IS NOT NULL AND NEW.goods_vat_rate IS NULL
  BEGIN
    UPDATE admission_services SET goods_vat_rate = (SELECT p.vat_rate FROM products p WHERE p.id = NEW.clinic_item_id)
     WHERE id = NEW.id;
  END;

-- Выставление: ставка строки переходит в строку счёта. Срабатывает и на
-- ставку, записанную триггером выше у строки, вставленной сразу со счётом.
CREATE TRIGGER visit_services_goods_vat_bill AFTER UPDATE OF invoice_item_id, goods_vat_rate ON visit_services
  WHEN NEW.invoice_item_id IS NOT NULL AND NEW.clinic_item_id IS NOT NULL
  BEGIN
    UPDATE invoice_items SET goods_vat_rate = NEW.goods_vat_rate
     WHERE id = NEW.invoice_item_id AND service_id IS NULL AND goods_vat_rate IS NOT NEW.goods_vat_rate;
  END;
CREATE TRIGGER admission_services_goods_vat_bill AFTER UPDATE OF invoice_item_id, goods_vat_rate ON admission_services
  WHEN NEW.invoice_item_id IS NOT NULL AND NEW.clinic_item_id IS NOT NULL
  BEGIN
    UPDATE invoice_items SET goods_vat_rate = NEW.goods_vat_rate
     WHERE id = NEW.invoice_item_id AND service_id IS NULL AND goods_vat_rate IS NOT NEW.goods_vat_rate;
  END;

-- M9 — журнал строки счёта с новой колонкой (перечень — как в 154, плюс
-- goods_vat_rate; journal.test.js сверяет его с journal.js SHIPPED).
DROP TRIGGER IF EXISTS invoice_items_journal_upd;
CREATE TRIGGER invoice_items_journal_upd AFTER UPDATE ON invoice_items
  BEGIN
    INSERT INTO sync_journal (tbl, uid, op, cols)
    SELECT 'invoice_items', uid, 'put', cols FROM (
      SELECT r.uid AS uid, CASE WHEN OLD.uid IS NULL THEN '*' ELSE rtrim(
             CASE WHEN NEW.description IS NOT OLD.description THEN 'description,' ELSE '' END ||
             CASE WHEN NEW.quantity IS NOT OLD.quantity THEN 'quantity,' ELSE '' END ||
             CASE WHEN NEW.unit_price IS NOT OLD.unit_price THEN 'unit_price,' ELSE '' END ||
             CASE WHEN NEW.total IS NOT OLD.total THEN 'total,' ELSE '' END ||
             CASE WHEN NEW.discount_amount IS NOT OLD.discount_amount THEN 'discount_amount,' ELSE '' END ||
             CASE WHEN NEW.goods_vat_rate IS NOT OLD.goods_vat_rate THEN 'goods_vat_rate,' ELSE '' END ||
             CASE WHEN NEW.created_at IS NOT OLD.created_at THEN 'created_at,' ELSE '' END ||
             CASE WHEN NEW.invoice_id IS NOT OLD.invoice_id THEN 'invoice_id,' ELSE '' END ||
             CASE WHEN NEW.service_id IS NOT OLD.service_id THEN 'service_id,' ELSE '' END, ',') END AS cols
        FROM invoice_items r WHERE r.id = NEW.id AND r.uid IS NOT NULL
    ) WHERE cols <> '';

    INSERT INTO sync_authored (tbl, uid, col, at)
    SELECT 'invoice_items', r.uid, v.col, strftime('%Y-%m-%dT%H:%M:%fZ','now')
      FROM invoice_items r
      JOIN (
            SELECT 'description' AS col WHERE NEW.description IS NOT OLD.description
            UNION ALL SELECT 'quantity' WHERE NEW.quantity IS NOT OLD.quantity
            UNION ALL SELECT 'unit_price' WHERE NEW.unit_price IS NOT OLD.unit_price
            UNION ALL SELECT 'total' WHERE NEW.total IS NOT OLD.total
            UNION ALL SELECT 'discount_amount' WHERE NEW.discount_amount IS NOT OLD.discount_amount
            UNION ALL SELECT 'goods_vat_rate' WHERE NEW.goods_vat_rate IS NOT OLD.goods_vat_rate
            UNION ALL SELECT 'created_at' WHERE NEW.created_at IS NOT OLD.created_at
            UNION ALL SELECT 'invoice_id' WHERE NEW.invoice_id IS NOT OLD.invoice_id
            UNION ALL SELECT 'service_id' WHERE NEW.service_id IS NOT OLD.service_id
           ) v
     WHERE r.id = NEW.id AND r.uid IS NOT NULL AND OLD.uid IS NOT NULL
    ON CONFLICT(tbl, uid, col) DO UPDATE SET at = excluded.at;
  END;
