-- 047_crm_scheduled.sql
-- CRM_V7 — дата записи на заявке (YYYY-MM-DD): на какой день пациент записан.
-- Питает автоматику воронки: день прошёл без визита -> «Не пришёл» (no_show);
-- визит создан (ensure_visit) -> «Пришёл» (came).
ALTER TABLE crm_requests ADD COLUMN scheduled_date TEXT;
