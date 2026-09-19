-- 140_doctor_tier.sql — DOCTOR_TIER_V1: СТУПЕНЬ ДОЛИ ВРАЧА ПО ОБЪЁМУ.
--
-- Владелец (2026-09-19): «by default we setup 30% but if doctor performs this
-- type of service more than 25 we need to make 40%» — «apply only above the
-- threshold services», «per exact service», «both» (оплаченные и начатые
-- строки считаются).
--
-- Правило живёт на УСЛУГЕ (политика клиники, едет с прайсом в филиалы, как
-- default_doctor_percent из 081): порог — число услуг в календарном месяце,
-- доля выше порога — процент, который применяется к строкам врача по этой
-- услуге НАЧИНАЯ со следующей после порога. Личный процент ступень никогда не
-- понижает: действует MAX(личный, ступень). Нумерацию строк считает ОДНО место
-- — TIER_RANK_SQL в services/rpc/reports.js; кабинет врача берёт её оттуда.
--
-- Нули = ступени нет: ни один существующий отчёт не меняет ни одной цифры,
-- пока клиника не заполнит пару полей в карточке услуги.
--
-- ТОЛЬКО ADD COLUMN.
ALTER TABLE services ADD COLUMN doctor_tier_from    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE services ADD COLUMN doctor_tier_percent REAL    NOT NULL DEFAULT 0;
