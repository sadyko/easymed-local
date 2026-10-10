-- 243 — DOCTOR_PROFILE_V1 (2026-10-10): ПУБЛИЧНЫЙ ПРОФИЛЬ ВРАЧА ДЛЯ САЙТА,
-- SYMPTEX И ПАРТНЁРОВ (шаг 5 API клиники, docs/specs/2026-10-06-clinic-api-design.md;
-- план docs/plans/2026-10-10-clinic-api-5-doctor-profile.md).
--
-- ТОЛЬКО ADD COLUMN и один индекс. Бэкфилл — только НОВОЙ колонки
-- practice_since из прежнего стажа (как мигр. 231: новая колонка из старой);
-- прежние колонки не трогаются. Документы по-прежнему печатают
-- users.full_name и users.specialty.
--
-- users:
--   is_public        — 1: врач виден на сайте клиники, в Symptex и у партнёров.
--                      Меняет только администратор (routes/users.js). По
--                      умолчанию 0 — наружу никто не уходит, пока
--                      администратор не включит.
--   languages        — языки приёма: JSON-список из 'ru' / 'uz' / 'en'.
--   practice_since   — год «работает врачом с»: стаж на сайте растёт сам.
--                      experience_years остаётся и пишется вместе с ним
--                      (shared/doctor-public.js withExperience).
--   booking_days     — на сколько дней вперёд партнёры видят время: 7 / 14 / 30.
--   show_queue_count — живая очередь: показывать партнёрам, сколько ждут.
-- consultation_types:
--   name_en          — название вида на английском (наружу).
--   duration_minutes — сколько длится приём этого вида; 30 — столько окно
--                      записи ставило консультации до шага 5.
--   api_kind         — 'initial' / 'repeat' для партнёров
--                      (/slots?consultation=initial, шаг 8): у каждого
--                      значения — не больше одного вида.
-- CHECK — запасной замок для /api/db и синхронизации: экран и сервер
-- проверяют то же раньше.

ALTER TABLE users ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0 CHECK (is_public IN (0, 1));
ALTER TABLE users ADD COLUMN languages TEXT NOT NULL DEFAULT '[]';
ALTER TABLE users ADD COLUMN practice_since INTEGER CHECK (practice_since IS NULL OR practice_since BETWEEN 1940 AND 2200);
ALTER TABLE users ADD COLUMN booking_days INTEGER NOT NULL DEFAULT 14 CHECK (booking_days IN (7, 14, 30));
ALTER TABLE users ADD COLUMN show_queue_count INTEGER NOT NULL DEFAULT 0 CHECK (show_queue_count IN (0, 1));

-- Стаж, введённый раньше, — от года обновления.
UPDATE users SET practice_since = CAST(strftime('%Y', 'now', 'localtime') AS INTEGER) - experience_years
 WHERE experience_years IS NOT NULL AND experience_years BETWEEN 0 AND 80;

ALTER TABLE consultation_types ADD COLUMN name_en TEXT;
ALTER TABLE consultation_types ADD COLUMN duration_minutes INTEGER NOT NULL DEFAULT 30 CHECK (duration_minutes BETWEEN 5 AND 480);
ALTER TABLE consultation_types ADD COLUMN api_kind TEXT NOT NULL DEFAULT '' CHECK (api_kind IN ('', 'initial', 'repeat'));
CREATE UNIQUE INDEX consultation_types_api_kind_uniq ON consultation_types(api_kind) WHERE api_kind <> '';
