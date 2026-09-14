-- 128_stock_holdings.sql — HOLDINGS_V1: ЧТО ВЫДАНО СО СКЛАДА И ЕЩЁ НЕ ИЗРАСХОДОВАНО.
--
-- Владелец (2026-09-14): «nurses can dispense items which is dispensed from
-- the procurement either to the nurse or either to the cabinet or to the
-- department. please inspect that flow too, so it will work seamlessly».
--
-- Что было: «Выдать со склада» (issue_stock_lines) списывало товар с
-- products.on_hand и записывало получателя ТЕКСТОМ в заметку движения — и на
-- этом след обрывался. Когда медсестра потом выдавала тот же препарат
-- пациенту (dispense_item / dispense_admission_item), склад списывался ВТОРОЙ
-- раз: одна упаковка уходила с остатка дважды, а где она лежит на самом деле —
-- у медсестры, в кабинете, в отделении — не знал никто.
--
-- Что стало: у каждого получателя — сотрудника, кабинета, отделения — свой
-- остаток по товару. Выдача со склада ПЕРЕКЛАДЫВАЕТ: склад минус, держатель
-- плюс. Выдача пациенту берёт у держателя и склад не трогает. Остаток на
-- складе плюс остатки держателей — вот всё, что клиника купила и ещё не
-- израсходовала.
--
-- qty — в БАЗОВЫХ единицах товара, как products.on_hand: одна арифметика на
-- склад и держателей. Движение помнит держателя, чтобы журнал отвечал
-- «откуда ушло» и «куда пришло».
-- ТОЛЬКО CREATE TABLE / ADD COLUMN.
CREATE TABLE IF NOT EXISTS stock_holdings (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  holder_type TEXT    NOT NULL CHECK (holder_type IN ('staff','room','department')),
  holder_id   INTEGER NOT NULL,
  product_id  INTEGER NOT NULL REFERENCES products(id),
  qty         REAL    NOT NULL DEFAULT 0,
  updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE (holder_type, holder_id, product_id)
);
CREATE INDEX IF NOT EXISTS idx_stock_holdings_holder ON stock_holdings(holder_type, holder_id);

ALTER TABLE stock_movements ADD COLUMN holder_type TEXT;
ALTER TABLE stock_movements ADD COLUMN holder_id   INTEGER;
