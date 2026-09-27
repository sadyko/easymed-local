-- CRM_CALENDAR_MIRROR_V1 (разбор ревью, 2026-09-27) — ОТКУДА ПРИВЯЗКА ЗАПИСИ К ЗАЯВКЕ.
--
-- source — почему запись календаря привязана к заявке:
--   'callcenter' — запись сделал колл-центр (заявка — его, не старше 30 дней,
--                  или заведена этой записью);
--   'match'      — у открытой заявки уже была строка или дата на ЭТОТ день
--                  (записывала регистратура или врач).
-- created_by      — кто записал.
-- created_request — 1: заявку завела сама эта запись. Убрали пустую запись
--                   (discard_empty_visit) — убирается и такая заявка.
ALTER TABLE crm_booking_links ADD COLUMN source TEXT;
ALTER TABLE crm_booking_links ADD COLUMN created_by INTEGER;
ALTER TABLE crm_booking_links ADD COLUMN created_request INTEGER NOT NULL DEFAULT 0;
