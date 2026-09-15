-- 131_service_names_online.sql — SERVICE_NAMES_ONLINE_V1: НАЗВАНИЕ НА ТРЁХ ЯЗЫКАХ И ОНЛАЙН-ЗАПИСЬ.
--
-- Владелец (2026-09-15): «add ru uz en fields for the name. and add
-- available for online appointment. just add the parameters. when active
-- make names in uz ru versions to be written. and do not save active unless
-- users writes the language versions».
--
-- services.name остаётся русским названием (им живёт вся система). Две новые
-- колонки — узбекское и английское, ПУСТЫЕ у всего, что уже есть. Флаг
-- онлайн-записи — ТОЛЬКО параметр: ничего наружу пока не публикуется.
-- Правило «онлайн только с названиями на ru и uz» держит service_save.
-- ТОЛЬКО ADD COLUMN.
ALTER TABLE services ADD COLUMN name_uz        TEXT;
ALTER TABLE services ADD COLUMN name_en        TEXT;
ALTER TABLE services ADD COLUMN online_booking INTEGER NOT NULL DEFAULT 0;
