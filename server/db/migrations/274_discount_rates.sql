-- 274_discount_rates.sql — DISCOUNT_RATES_V1 (3.22.0, владелец 2026-11-07)
--
-- Владелец: «When we are adding the discount in the group, we should be able to
-- select the discount for each service. For example for consultations 100 % and
-- 20 % for another». У скидки был ОДИН процент; теперь у неё могут быть свои
-- ставки — по группе услуг (пять фиксированных: Консультации, Диагностика,
-- Лаборатория, Процедуры, Хирургия — services.type), по категории услуг клиники
-- (services.category_id) и по отдельной услуге. Действует самая точная: услуга >
-- категория > группа > процент самой скидки. 0 % — на эту услугу скидки нет;
-- 100 % — бесплатно.
--
-- Только ДОБАВЛЯЕТ колонки. Ни одна прежняя группа, скидка, счёт или строка не
-- меняется: пустые ставки ('{}') — ровно прежнее поведение (один процент на всё,
-- к чему скидка применялась), а строки счёта без отметки (NULL) считаются, как
-- до 3.22.
--
-- 1. Ставки — JSON: {"g": {"consultation": 100}, "c": {"12": 50}, "s": {"345": 0}}
--    (g — группа услуги, c — категория, s — услуга; значение — процент 0..100).
--    У группы пациентов (patient_categories, скидка с мигр. 107) и у скидок клиники
--    (patient_discounts: промокод; карта и сертификат — это деньги, ставки им ни к
--    чему, но колонка у всех строк таблицы одна).
ALTER TABLE patient_categories ADD COLUMN discount_rates TEXT NOT NULL DEFAULT '{}'
  CHECK (json_valid(discount_rates));
ALTER TABLE patient_discounts ADD COLUMN discount_rates TEXT NOT NULL DEFAULT '{}'
  CHECK (json_valid(discount_rates));

-- 2. Строка счёта, которую посчитала скидка со ставками, несёт её СВОЕЙ скидкой
--    (invoice_items.discount_amount, как строка пакета, мигр. 154): у консультации
--    100 %, у УЗИ 20 % — разные доли, и отчёты, возврат строки и доля врача видят
--    деньги каждой строки, а не среднюю по счёту.
--      discount_rate — каким процентом её посчитали (NULL — строка не по ставкам:
--                      пакет со своей ценой или счёт без ставок, как прежде);
--      discount_doctor_share — какая доля СВОЕЙ скидки строки уменьшает долю врача:
--                      переключатель «Скидка уменьшает долю врача» скидки (мигр.
--                      273), 1 — уменьшает (как всегда было), 0 — клиника берёт
--                      скидку на себя. NULL — 1 (строки пакета и прежние строки).
--    Колонки свои у здания (как doctor_discount_share счёта, мигр. 273): долю
--    врача по счёту считает только здание счёта.
ALTER TABLE invoice_items ADD COLUMN discount_rate REAL
  CHECK (discount_rate IS NULL OR (discount_rate >= 0 AND discount_rate <= 100));
ALTER TABLE invoice_items ADD COLUMN discount_doctor_share REAL
  CHECK (discount_doctor_share IS NULL OR (discount_doctor_share >= 0 AND discount_doctor_share <= 1));
