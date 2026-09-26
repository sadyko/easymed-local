-- DOCTOR_PUBLIC_PROFILE_V1 (2026-09-26) — ПУБЛИЧНЫЙ ПРОФИЛЬ ВРАЧА ХРАНИТСЯ ОФЛАЙН.
--
-- Владелец: «we need to add them for building a proper API for partners».
-- Сам API — не в этом наборе; здесь поля наконец ХРАНЯТСЯ и читаются.
--
-- Колонки — ровно белый список update_my_doctor_profile
-- (rpc/doctor-profile.js PROFILE_KEYS): RPC пишет только существующие колонки
-- и до этой миграции возвращал их в `not_stored` («не хранятся»).
--
--   *_ru/_uz/_en        — ФИО, учёная степень, биография на трёх языках;
--   *_entries           — списки (образование, опыт, сертификаты, повышение
--                         квалификации) JSON-текстом, как у service_rates;
--   experience_years    — стаж, целые годы;
--   instagram_url, telegram_url — ссылки;
--   photo_url           — путь файла в хранилище doctor-photos
--                         (/api/storage/doctor-photos/…) или внешняя ссылка.
ALTER TABLE users ADD COLUMN full_name_ru TEXT;
ALTER TABLE users ADD COLUMN full_name_uz TEXT;
ALTER TABLE users ADD COLUMN full_name_en TEXT;
ALTER TABLE users ADD COLUMN academic_title_ru TEXT;
ALTER TABLE users ADD COLUMN academic_title_uz TEXT;
ALTER TABLE users ADD COLUMN academic_title_en TEXT;
ALTER TABLE users ADD COLUMN bio_ru TEXT;
ALTER TABLE users ADD COLUMN bio_uz TEXT;
ALTER TABLE users ADD COLUMN bio_en TEXT;
ALTER TABLE users ADD COLUMN education_entries TEXT NOT NULL DEFAULT '[]';
ALTER TABLE users ADD COLUMN experience_entries TEXT NOT NULL DEFAULT '[]';
ALTER TABLE users ADD COLUMN certifications_entries TEXT NOT NULL DEFAULT '[]';
ALTER TABLE users ADD COLUMN prof_dev_entries TEXT NOT NULL DEFAULT '[]';
ALTER TABLE users ADD COLUMN experience_years INTEGER;
ALTER TABLE users ADD COLUMN instagram_url TEXT;
ALTER TABLE users ADD COLUMN telegram_url TEXT;
ALTER TABLE users ADD COLUMN photo_url TEXT;
