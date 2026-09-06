-- 107_patient_category_discount.sql — КАТЕГОРИЯ ПАЦИЕНТА СТАНОВИТСЯ НАСТОЯЩЕЙ,
-- И ЗА НЕЙ ЗАКРЕПЛЯЕТСЯ СКИДКА.
--
-- Владелец: «the category of the patient should come from the patient category
-- settings. and in the category settings should be selected the discount amount
-- to the patient group. which means when patient selected with the category
-- discount should be applied».
--
-- ЧТО БЫЛО НА САМОМ ДЕЛЕ — ХУЖЕ, ЧЕМ «НЕ СВЯЗАНО СО СПРАВОЧНИКОМ».
--
-- 1. В окне заведения пациента есть поле «Категория пациента» с тремя
--    значениями, зашитыми в код: Взрослый / Ребёнок / Новорождённый. Оно
--    подставляется по дате рождения и выглядит как настоящее поле.
-- 2. Колонки для него в таблице `patients` НЕТ. Миграция 002 заводила
--    `category TEXT`, но позднейшая перестройка таблицы её не сохранила.
-- 3. Компилятор запросов молча отбрасывает ключи, которых нет в списке
--    разрешённых колонок. То есть выбранная категория не сохранялась НИКОГДА:
--    регистратор её выбирал, а она исчезала при сохранении.
-- 4. Справочник `patient_categories` при этом существовал отдельно, пустой и
--    ни с чем не связанный.
--
-- Поэтому здесь не «добавить скидку», а достроить связь целиком: у пациента
-- появляется настоящая ссылка на категорию, у категории — процент скидки.
--
-- ССЫЛКА, А НЕ ТЕКСТ. Терять тут нечего (сохранённых значений не существует),
-- поэтому берём внешний ключ: переименование категории не рассыпает связь, а
-- скидка ищется по ключу, а не сравнением строк.
--
-- ПОЧЕМУ ПРОЦЕНТ, А НЕ СУММА. Скидка группы применяется к счетам любого
-- размера: фиксированная сумма на приёме за 50 000 и на обследовании за
-- 3 000 000 значит совершенно разное, процент — одно и то же. Сумма остаётся у
-- ручной скидки и промокодов (patient_discounts), где она и уместна.

ALTER TABLE patient_categories ADD COLUMN discount_percent REAL NOT NULL DEFAULT 0;
ALTER TABLE patients ADD COLUMN category_id INTEGER REFERENCES patient_categories(id);

CREATE INDEX IF NOT EXISTS idx_patients_category ON patients(category_id);

-- Три возрастные категории, которые до сих пор были зашиты в код окна: клиника
-- их уже видит и выбирает, поэтому они переезжают в справочник как есть, со
-- скидкой 0 %. Скидку клиника проставит сама, если захочет.
--
-- ТОЛЬКО В ПУСТОЙ СПРАВОЧНИК: клиника, которая уже завела свои категории (VIP,
-- сотрудники, льготники), не должна получить поверх них три чужие строки.
INSERT INTO patient_categories (name, discount_percent, active)
SELECT 'Взрослый', 0, 1 WHERE NOT EXISTS (SELECT 1 FROM patient_categories);
INSERT INTO patient_categories (name, discount_percent, active)
SELECT 'Ребёнок', 0, 1 WHERE (SELECT COUNT(*) FROM patient_categories) = 1;
INSERT INTO patient_categories (name, discount_percent, active)
SELECT 'Новорождённый', 0, 1 WHERE (SELECT COUNT(*) FROM patient_categories) = 2;
