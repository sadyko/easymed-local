-- V3120_FIX (2026-09-27) — ДОСКА ОЧЕРЕДИ БЕЗ ПЕРЕБОРА ВСЕЙ ИСТОРИИ.
--
-- queue_board (rpc/queue.js) экран спрашивает каждые 10 секунд. Отбор шёл по
-- `queue_key LIKE '%:<день>'` — по всем строкам visit_services за всю жизнь
-- клиники (634 мс на трёхлетней базе). Теперь кандидаты берутся по дню визита
-- (idx_visits_date) и по времени самой строки — этим индексом. Частичный:
-- только строки с номером очереди, остальным на доске делать нечего.
--
-- БЕЗОПАСНО ДЛЯ ФИЛИАЛОВ: только CREATE INDEX, ни одна строка не меняется.
CREATE INDEX IF NOT EXISTS idx_visit_services_sched_queue ON visit_services(scheduled_at) WHERE queue_no IS NOT NULL;
