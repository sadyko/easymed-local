-- 241 — BRANCH_PROFILE_V1 (2026-10-10): ПРОФИЛЬ ЗДАНИЯ КЛИНИКИ (шаг 4 API
-- клиники, docs/specs/2026-10-06-clinic-api-design.md; план
-- docs/plans/2026-10-10-clinic-api-4-branches.md).
--
-- ТОЛЬКО ADD COLUMN, бэкфилла нет: branches не пересобирается (буква здания и
-- её UNIQUE-индекс мигр. 080 на месте), здания после обновления работают так
-- же. Часы работы — прежние working_hours / is_24_7 (мигр. 002): их читает
-- движок записи (slot-engine.js clinicWindow), и он не меняется.
--
-- name остаётся тем, что показывает программа (выбор здания, календарь,
-- касса, отчёты) и по чему связываются здания. Новое — рядом и наружу (сайт,
-- Symptex, партнёры): названия uz/en; адрес для партнёров — кодами
-- справочника (мигр. 132), улица и ориентир на трёх языках; карта; «показывать
-- на сайте». Адрес для партнёров, карта и телефон ГЛАВНОГО здания живут в его
-- «Компании» (doc_settings, мигр. 240) — в его строке здесь они не правятся
-- (shared/branch-profile.js OWN_FROM_COMPANY): одно место на здание.
-- CHECK — запасной замок для /api/db: экран и сервер проверяют то же раньше.

ALTER TABLE branches ADD COLUMN name_uz TEXT NOT NULL DEFAULT '';
ALTER TABLE branches ADD COLUMN name_en TEXT NOT NULL DEFAULT '';

-- Адрес для партнёров: коды countries.code / regions.code / districts.code
-- (мигр. 132), улица и ориентир на трёх языках.
ALTER TABLE branches ADD COLUMN country_code  TEXT NOT NULL DEFAULT '';
ALTER TABLE branches ADD COLUMN region_code   TEXT NOT NULL DEFAULT '';
ALTER TABLE branches ADD COLUMN district_code TEXT NOT NULL DEFAULT '';
ALTER TABLE branches ADD COLUMN street_ru TEXT NOT NULL DEFAULT '';
ALTER TABLE branches ADD COLUMN street_uz TEXT NOT NULL DEFAULT '';
ALTER TABLE branches ADD COLUMN street_en TEXT NOT NULL DEFAULT '';
ALTER TABLE branches ADD COLUMN landmark_ru TEXT NOT NULL DEFAULT '';
ALTER TABLE branches ADD COLUMN landmark_uz TEXT NOT NULL DEFAULT '';
ALTER TABLE branches ADD COLUMN landmark_en TEXT NOT NULL DEFAULT '';

ALTER TABLE branches ADD COLUMN maps_url TEXT NOT NULL DEFAULT ''
  CHECK (maps_url = '' OR maps_url LIKE 'https://yandex.%' OR maps_url LIKE 'https://www.yandex.%' OR maps_url LIKE 'https://maps.yandex.%');

-- 1 — здание видно на сайте клиники, в Symptex и у партнёров; 0 — скрыто, и
-- его врачи тоже (shared/branch-profile.js branchAllowsDoctor). Внутри
-- программы не меняет ничего.
ALTER TABLE branches ADD COLUMN show_public INTEGER NOT NULL DEFAULT 1 CHECK (show_public IN (0, 1));
