-- STOCK_REQUEST_V1 (2026-09-23) — ЗАЯВКА ЗНАЕТ, ДЛЯ КОГО ОНА, И МИНИМУМ НА РУКАХ.
--
-- Владелец: «#my-stock should be able to request and set to auto request with
-- minimum amount». План: docs/plans/2026-09-23-stock-requests.md.
--
-- ЧТО БЫЛО. Заявка на склад (028) знала только отдел: department_id, и
-- одобрение выдавало в подотчёт этого отдела. Попросить СЕБЕ медсестра не
-- могла, а минимума у держателя не было вовсе — только products.reorder_level,
-- то есть минимум СКЛАДА.
--
-- ЧТО ТЕПЕРЬ.
--   1. У заявки есть держатель: holder_type ('staff' | 'department') и
--      holder_id — тот, кому одобрение выдаст товар. Старые заявки получают
--      держателя из своего отдела. Заявку без отдела (была и такая: выдача «в
--      никуда», списанием) держатель не выдумывается — она остаётся списанием.
--   2. auto = 1 — заявку подала программа сама: остаток на руках упал ниже
--      минимума (rpc/stock-requests.js). Сама она ничего не выдаёт: одобряет
--      кладовщик в «Заявках», как любую другую.
--   3. stock_minimums — минимум и норма на держателя и товар. Упал остаток
--      ниже минимума — заявка на (норма − остаток − уже запрошено и не выдано).
--      Количества — БАЗОВЫЕ единицы товара, те же, что stock_holdings.qty и
--      products.on_hand: сравнивать минимум с остатком в разных единицах
--      значило бы ошибаться в десять раз на каждой упаковке таблеток.
--
-- ЭКРАН «ЗАЯВКИ» ПИШЕТ ЗАЯВКУ И НАПРЯМУЮ (реестр, inventory-docs.js), называя
-- только отдел. Чтобы у такой заявки тоже был держатель, триггер ставит его из
-- отдела, если держателя не назвали. Иначе одобрение увидело бы «ничей»
-- документ ровно у тех заявок, что пишутся руками.
--
-- ОБМЕН ЗДАНИЙ НИ ОДНУ ИЗ ЭТИХ ТАБЛИЦ НЕ ВЕЗЁТ (branch-sync/journal.js
-- SHIPPED): держатель — id ЭТОЙ базы, а подотчёт у каждого здания свой.
-- migrate.js оборачивает файл в транзакцию — здесь BEGIN/COMMIT нет.

ALTER TABLE purchase_requisitions ADD COLUMN holder_type TEXT
  CHECK (holder_type IS NULL OR holder_type IN ('staff', 'department'));
ALTER TABLE purchase_requisitions ADD COLUMN holder_id INTEGER;
ALTER TABLE purchase_requisitions ADD COLUMN auto INTEGER NOT NULL DEFAULT 0
  CHECK (auto IN (0, 1));

UPDATE purchase_requisitions
   SET holder_type = 'department', holder_id = department_id
 WHERE holder_type IS NULL AND department_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_requisitions_holder ON purchase_requisitions(holder_type, holder_id, status);

CREATE TRIGGER IF NOT EXISTS trg_requisitions_holder_from_department
AFTER INSERT ON purchase_requisitions
WHEN NEW.holder_type IS NULL AND NEW.department_id IS NOT NULL
BEGIN
  UPDATE purchase_requisitions
     SET holder_type = 'department', holder_id = NEW.department_id
   WHERE id = NEW.id;
END;

CREATE TABLE IF NOT EXISTS stock_minimums (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  holder_type TEXT    NOT NULL CHECK (holder_type IN ('staff', 'department')),
  holder_id   INTEGER NOT NULL,
  product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  min_qty     REAL    NOT NULL CHECK (min_qty >= 0),
  target_qty  REAL    NOT NULL CHECK (target_qty >= min_qty),
  set_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE (holder_type, holder_id, product_id)
);
CREATE INDEX IF NOT EXISTS idx_stock_minimums_holder ON stock_minimums(holder_type, holder_id);
