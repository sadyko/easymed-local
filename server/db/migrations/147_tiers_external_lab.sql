-- 147_tiers_external_lab.sql — две правки карточки услуги.
--
-- DOCTOR_TIER_V2. Владелец (2026-09-23): «in the services settings, we need to
-- add another 2 (overall 3) steps of the percentage for the service». Ступень 1
-- остаётся в колонках 140 (doctor_tier_from/doctor_tier_percent), ступени 2 и
-- 3 — рядом, того же типа и с теми же нулями по умолчанию. Правило прежнее —
-- «только выше порога»: строка, ушедшая за САМЫЙ ВЫСОКИЙ из пройденных
-- порогов, идёт по доле этой ступени (и не ниже личной), до первого порога —
-- по личной. Нумерацию по-прежнему считает ОДНО место — TIER_RANK_SQL в
-- services/rpc/reports.js. Нули = ступени нет: ни одна цифра не меняется, пока
-- клиника не заполнит ступень 2.
--
-- EXTERNAL_LAB_V1. Владелец: «tick the "внешняя лаборатория" … lab services
-- which is provided in the another clinic but result inputted in our system»;
-- «nothing, as it is but labeled as external lab»; «Just a tick, no lab named».
-- Только отметка на услуге: 1 — анализ делает другая клиника, результат вносят
-- у нас. Ни забор, ни штрихкод, ни анализатор, ни оплата от неё не зависят.
--
-- Все пять колонок едут с прайсом в филиалы (branch-sync/catalogue.js).
-- ТОЛЬКО ADD COLUMN.
ALTER TABLE services ADD COLUMN doctor_tier_from_2    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE services ADD COLUMN doctor_tier_percent_2 REAL    NOT NULL DEFAULT 0;
ALTER TABLE services ADD COLUMN doctor_tier_from_3    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE services ADD COLUMN doctor_tier_percent_3 REAL    NOT NULL DEFAULT 0;
ALTER TABLE services ADD COLUMN external_lab          INTEGER NOT NULL DEFAULT 0;
