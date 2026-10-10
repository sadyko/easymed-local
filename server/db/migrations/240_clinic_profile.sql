-- 240 — CLINIC_PROFILE_V1 (2026-10-10): ПРОФИЛЬ КЛИНИКИ (шаг 3 API клиники,
-- docs/specs/2026-10-06-clinic-api-design.md; план 2026-10-10-clinic-api-3-company-profile.md).
--
-- ТОЛЬКО ADD COLUMN: doc_settings не пересобирается (строка одна, id = 1,
-- миграция 008; lab_scope мигр. 085 на месте), бэкфилла нет.
--
-- Документы печатают ПРЕЖНИЕ поля: clinic_name и address — адрес, вписанный
-- руками в «Компании» (ответ владельца 2026-10-10, вариант B: сборки адреса
-- для бланка нет). Новые — рядом и только наружу (API, партнёры, предпросмотр
-- «Как это увидят пациенты»): названия и описание на uz/en; адрес главного
-- здания — кодами справочника (мигр. 132) и улицей на трёх языках; сайт и
-- соцсети (сайт на бланках не печатается — ответ владельца 2026-10-10);
-- логотипы — путями к файлам корзины clinic-logos (сами файлы — в хранилище;
-- печатная копия квадратного — прежний logo_data_url).
-- CHECK — запасной замок форматов: экран проверяет то же раньше и понятнее.

ALTER TABLE doc_settings ADD COLUMN name_uz  TEXT NOT NULL DEFAULT '';
ALTER TABLE doc_settings ADD COLUMN name_en  TEXT NOT NULL DEFAULT '';
ALTER TABLE doc_settings ADD COLUMN about_ru TEXT NOT NULL DEFAULT '';
ALTER TABLE doc_settings ADD COLUMN about_uz TEXT NOT NULL DEFAULT '';
ALTER TABLE doc_settings ADD COLUMN about_en TEXT NOT NULL DEFAULT '';

-- Адрес этого здания (в главном — главного): коды countries.code /
-- regions.code / districts.code (мигр. 132), улица на трёх языках. На бланк
-- не идёт: там — address, как его вписала клиника.
ALTER TABLE doc_settings ADD COLUMN country_code  TEXT NOT NULL DEFAULT '';
ALTER TABLE doc_settings ADD COLUMN region_code   TEXT NOT NULL DEFAULT '';
ALTER TABLE doc_settings ADD COLUMN district_code TEXT NOT NULL DEFAULT '';
ALTER TABLE doc_settings ADD COLUMN street_ru TEXT NOT NULL DEFAULT '';
ALTER TABLE doc_settings ADD COLUMN street_uz TEXT NOT NULL DEFAULT '';
ALTER TABLE doc_settings ADD COLUMN street_en TEXT NOT NULL DEFAULT '';

ALTER TABLE doc_settings ADD COLUMN website TEXT NOT NULL DEFAULT ''
  CHECK (website = '' OR website LIKE 'https://_%');
ALTER TABLE doc_settings ADD COLUMN telegram_bot TEXT NOT NULL DEFAULT ''
  CHECK (telegram_bot = '' OR (telegram_bot GLOB '@?*' AND lower(telegram_bot) GLOB '*bot'));
ALTER TABLE doc_settings ADD COLUMN telegram_channel TEXT NOT NULL DEFAULT ''
  CHECK (telegram_channel = '' OR telegram_channel GLOB '@?*');
ALTER TABLE doc_settings ADD COLUMN instagram TEXT NOT NULL DEFAULT ''
  CHECK (instagram = '' OR instagram GLOB '@?*');
ALTER TABLE doc_settings ADD COLUMN maps_url TEXT NOT NULL DEFAULT ''
  CHECK (maps_url = '' OR maps_url LIKE 'https://yandex.%' OR maps_url LIKE 'https://www.yandex.%' OR maps_url LIKE 'https://maps.yandex.%');

ALTER TABLE doc_settings ADD COLUMN logo_square_path TEXT NOT NULL DEFAULT ''
  CHECK (logo_square_path = '' OR logo_square_path GLOB 'square/?*.png');
ALTER TABLE doc_settings ADD COLUMN logo_portrait_path TEXT NOT NULL DEFAULT ''
  CHECK (logo_portrait_path = '' OR logo_portrait_path GLOB 'portrait/?*.png');
