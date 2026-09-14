-- 129_patient_form_and_discount_rules.sql — PATIENT_FORM_ONE_V1 · CHRONIC_REF_V1 · DISCOUNT_RULES_V1
--
-- Владелец (2026-09-14): «editing the existing patients dont have the same
-- fields as registration of new patients. we need to make the window and the
-- fields similar. … chronic diseases should be the dropdown (we will provide
-- the list from the settings). … in the category of the patients we should add
-- the discounts … applied automatically. … discounts: the expiration date /
-- apply to the selected group / apply to the selected services / apply until.»
--
-- 1. АНКЕТА. Окно заведения пациента спрашивало доп. телефон, язык, паспорт,
--    поведение, страну, регион, район, махаллю и резидентство — а колонок для
--    них в patients НЕ БЫЛО: вставка молча выбрасывала эти ключи, и
--    регистратор заполнял поля в никуда. Колонки заводятся здесь; окно правки
--    становится тем же окном (patient-create-modal.js в режиме правки).
-- 2. ХРОНИЧЕСКИЕ ЗАБОЛЕВАНИЯ — справочник клиники (Настройки), из которого
--    анкета выбирает. patients.chronic_conditions остаётся ТЕКСТОМ: выбранные
--    названия пишутся через запятую, и всё, что читает это поле сегодня
--    (карта, печать), читает его по-прежнему.
-- 3. СКИДКИ (patient_discounts): срок действия, группа пациентов, услуги.
--    Пустое поле = без ограничения, как и было. Скидка группы (patient_
--    categories.discount_percent) существует с миграции 107 и считается на
--    сервере (billing.js) — здесь она только показывается в редакторе.
-- ТОЛЬКО ADD COLUMN / CREATE TABLE.
ALTER TABLE patients ADD COLUMN phone_secondary TEXT;
ALTER TABLE patients ADD COLUMN language        TEXT;
ALTER TABLE patients ADD COLUMN passport_number TEXT;
ALTER TABLE patients ADD COLUMN behavior_note   TEXT;
ALTER TABLE patients ADD COLUMN country         TEXT;
ALTER TABLE patients ADD COLUMN region          TEXT;
ALTER TABLE patients ADD COLUMN district        TEXT;
ALTER TABLE patients ADD COLUMN mahalla         TEXT;
ALTER TABLE patients ADD COLUMN citizenship     TEXT;

CREATE TABLE IF NOT EXISTS chronic_conditions_ref (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL,
  code       TEXT    NOT NULL DEFAULT '',
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

ALTER TABLE patient_discounts ADD COLUMN valid_from  TEXT;
ALTER TABLE patient_discounts ADD COLUMN valid_until TEXT;
ALTER TABLE patient_discounts ADD COLUMN category_id INTEGER REFERENCES patient_categories(id) ON DELETE SET NULL;
ALTER TABLE patient_discounts ADD COLUMN service_ids TEXT NOT NULL DEFAULT '[]';
ALTER TABLE patient_discounts ADD COLUMN note        TEXT NOT NULL DEFAULT '';
