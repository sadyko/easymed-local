-- 130_service_repeat_window.sql — REPEAT_WINDOW_V1: СВОЁ ОКНО ДНЕЙ У ПОВТОРНОГО ВИЗИТА.
--
-- Владелец (2026-09-14): «there was secondary visit days and repeat days,
-- it should have the range too». В 127 окно дней было одно на второй и
-- повторный визит. Теперь у повторного (третий и далее) — своё окно от
-- ПРЕДЫДУЩЕГО визита; обе колонки ПУСТЫЕ = как у второго визита, то есть
-- всё, что уже настроено, считается ровно как раньше.
-- ТОЛЬКО ADD COLUMN.
ALTER TABLE services ADD COLUMN repeat_days_from INTEGER;
ALTER TABLE services ADD COLUMN repeat_days_to   INTEGER;
