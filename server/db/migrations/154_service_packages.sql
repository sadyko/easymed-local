-- PACKAGES_V1 (2026-09-26) — ПАКЕТЫ УСЛУГ: СКИДКА И СРОК ПРЕДЛОЖЕНИЯ.
--
-- Владелец: «in Настройки услуг we need to add packages with expiration dates,
-- so they are available in «+Пакеты» in fast registration (now it's templates).
-- Packages should include the discount and the services list with expiration
-- dates. Also add this to the Roles sections for setting up.»
--
-- Решения владельца (26.09): срок — это ОКНО ПРЕДЛОЖЕНИЯ (акция), а не
-- абонемент: пакет выбирают при регистрации только между valid_from и
-- valid_until, его услуги выставляются на этом визите со скидкой пакета.
-- Скидка — построчно и только на услуги самого пакета; со скидкой категории
-- пациента не суммируется — на строке действует бо́льшая из двух.
--
-- ТАБЛИЦА НЕ ПЕРЕИМЕНОВЫВАЕТСЯ. Пакет — это тот же service_templates (мигр. 027)
-- с тремя новыми колонками: имя таблицы знают реестр, три окна выбора, мастер
-- визита и их тесты, и переименование (или вид поверх) стоило бы правок во всех
-- них ради слова. Прежние шаблоны становятся пакетами без скидки и без дат —
-- ровно тем, чем были: список услуг, доступный всегда.
--
-- ПО ФИЛИАЛАМ ПАКЕТЫ НЕ ЕЗДЯТ — как не ездили шаблоны (branch-sync/catalogue.js
-- их не перечисляет). Поэтому visit_services.package_id тоже остаётся дома
-- (journal.js SHIPPED его не называет). А вот скидка строки счёта — это деньги
-- ДОКУМЕНТА, и документ ездит (мигр. 087): invoice_items.discount_amount
-- вписан в SHIPPED и в журнальный триггер ниже, иначе сосед разнёс бы скидку
-- счёта по всем строкам поровну и разошёлся с нами в долях врачей.

-- 1. Пакет: скидка, срок предложения (местные календарные даты, обе
--    необязательны: пусто — без ограничения с этой стороны).
ALTER TABLE service_templates ADD COLUMN discount_percent REAL NOT NULL DEFAULT 0
  CHECK (discount_percent >= 0 AND discount_percent <= 100);
ALTER TABLE service_templates ADD COLUMN valid_from TEXT
  CHECK (valid_from IS NULL OR valid_from GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]');
ALTER TABLE service_templates ADD COLUMN valid_until TEXT
  CHECK (valid_until IS NULL OR (valid_until GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
                                 AND (valid_from IS NULL OR valid_until >= valid_from)));

-- 2. Своя скидка строки счёта. 0 — у строки своей скидки нет, и на неё, как
--    прежде, ложится доля скидки счёта (reports.js ITEM_DISCOUNT_SQL).
ALTER TABLE invoice_items ADD COLUMN discount_amount REAL NOT NULL DEFAULT 0
  CHECK (discount_amount >= 0);
-- Отчёты спрашивают «есть ли у счёта строки со своей скидкой» на КАЖДОЙ строке
-- (reports.js ITEM_DISCOUNT_SQL). Частичный индекс держит только такие строки —
-- их единицы, — и вопрос стоит один пустой пробег по индексу, а не проход по
-- всем позициям счёта (счёт стационара бывает на десятки тысяч строк).
CREATE INDEX idx_invoice_items_own_discount ON invoice_items(invoice_id) WHERE discount_amount > 0;

-- 3. Из какого пакета строка визита. Пакет удалили — строка остаётся строкой,
--    просто без пакета (счёт по ней уже выставлен с той скидкой, что была).
ALTER TABLE visit_services ADD COLUMN package_id INTEGER
  REFERENCES service_templates(id) ON DELETE SET NULL;
CREATE INDEX idx_visit_services_package ON visit_services(package_id) WHERE package_id IS NOT NULL;

-- 4. Журнальный триггер правки позиции счёта (мигр. 087) — с новой колонкой.
--    Перечень колонок триггера обязан совпадать с SHIPPED ∪ REFS ∪ CODE_REFS
--    (journal.test.js сверяет).
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
            UNION ALL SELECT 'created_at' WHERE NEW.created_at IS NOT OLD.created_at
            UNION ALL SELECT 'invoice_id' WHERE NEW.invoice_id IS NOT OLD.invoice_id
            UNION ALL SELECT 'service_id' WHERE NEW.service_id IS NOT OLD.service_id
           ) v
     WHERE r.id = NEW.id AND r.uid IS NOT NULL AND OLD.uid IS NOT NULL
    ON CONFLICT(tbl, uid, col) DO UPDATE SET at = excluded.at;
  END;
