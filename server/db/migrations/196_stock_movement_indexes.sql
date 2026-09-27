-- V3120_FIX (2026-09-27) — индексы журнала склада.
--
-- Инспекция 3.12.0 на синтетической базе в 500 тыс. движений:
--   * «Журнал движений» (stock_movements_list) — 1,4–3,1 с на запрос: отбор по
--     датам и сортировка «новые сверху» читали всю таблицу. Отбор переписан
--     диапазоном по самой колонке (day.js localRangeWhere) — ему нужен
--     idx_stock_movements_created; он же отдаёт «последние 200» без сортировки.
--   * «Сроки годности» (stock_expiry_lots) — 2,8–3,7 с: приходы, разложенные
--     по партиям, искались перебором всех движений (у stock_movements был один
--     индекс — по товару, миграция 007). Частичный индекс держит ТОЛЬКО приходы
--     (их доли процента) и покрывает группировку товар/партия/срок/количество
--     целиком — таблица не читается вовсе.
--   * Строка визита/госпитализации ищет свои движения при отмене и в списке
--     «выдано» (reference_type, reference_id) — перебором.
--   * Подотчёт и «мой журнал» спрашивают держателя (holder_type, holder_id).
--
-- ДАННЫЕ НЕ ТРОГАЮТСЯ. Остатки, накопившие хвосты округления до сотых
-- (прежний round2, см. domain/stock-qty.js), этой миграцией не правятся:
-- UPDATE остатков разошёлся бы по филиалам через журнал обмена и сдвинул бы
-- числа, которые кладовщик уже сверял. Новые записи хвостов не копят; старый
-- хвост на руках убирается кнопкой «Вернуть на склад» (holding_return) или
-- инвентаризацией.
--
-- БЕЗОПАСНО ДЛЯ ФИЛИАЛОВ: только CREATE INDEX — журнальные триггеры (084) не
-- срабатывают. IF NOT EXISTS — на случай соседней миграции с тем же именем.

CREATE INDEX IF NOT EXISTS idx_stock_movements_created   ON stock_movements(created_at);
CREATE INDEX IF NOT EXISTS idx_stock_movements_receipts  ON stock_movements(product_id, batch_no, expiry_date, qty) WHERE kind = 'receive';
CREATE INDEX IF NOT EXISTS idx_stock_movements_reference ON stock_movements(reference_type, reference_id);
CREATE INDEX IF NOT EXISTS idx_stock_movements_holder    ON stock_movements(holder_type, holder_id);
