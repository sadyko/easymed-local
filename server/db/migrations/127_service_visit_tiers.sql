-- 127_service_visit_tiers.sql — VISIT_TIER_PRICING_V1: ЦЕНА УСЛУГИ ПО СЧЁТУ ВИЗИТА.
--
-- Владелец (2026-09-14): «we have services, we need to add them a settings
-- (nullable) for the primary visit, secondary, repeat visit and set dates
-- between the first and second. for example in the first visit there can be
-- 200000 sum and for second visit of this service can be 60000 if patient
-- comes between 1-6 days and repeat visit is for example free».
--
-- Первичная цена — это существующая services.price. Три новые колонки
-- ПУСТЫЕ по умолчанию: услуга без них считается по-старому, одной ценой.
--   price_secondary      — цена ВТОРОГО визита по той же услуге;
--   secondary_days_from/ — окно в днях от ПРЕДЫДУЩЕГО визита, в которое
--   secondary_days_to      второй визит считается вторым (1–6 в примере);
--                          «до» пустое = окно не ограничено сверху;
--   price_repeat         — цена третьего и последующих визитов в том же
--                          окне (0 = бесплатно; пусто = как второй).
-- Пришёл позже окна — счёт начинается заново с первичной цены.
--
-- Строка визита запоминает, ПО КАКОЙ СТУПЕНИ её посчитали: касса и отчёты
-- читают это слово, а следующий визит по нему решает, второй он или третий.
-- ТОЛЬКО ADD COLUMN.
ALTER TABLE services ADD COLUMN price_secondary     REAL;
ALTER TABLE services ADD COLUMN secondary_days_from INTEGER;
ALTER TABLE services ADD COLUMN secondary_days_to   INTEGER;
ALTER TABLE services ADD COLUMN price_repeat        REAL;

ALTER TABLE visit_services ADD COLUMN price_tier TEXT;
