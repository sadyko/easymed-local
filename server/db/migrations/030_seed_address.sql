-- 030_seed_address.sql
-- Address reference data for registration.js's country -> region -> district
-- cascade (previously the dropdowns were empty). Seeds Uzbekistan + its
-- neighbours, the 14 first-level regions of Uzbekistan, and the 12 districts
-- (tumanlar) of Tashkent city — the common clinic location.
--
-- Provincial districts (~160) are DELIBERATELY not hand-entered here: they
-- should be imported from an official administrative dataset rather than
-- transcribed from memory. Regions everywhere still work; only the district
-- dropdown for non-Tashkent regions stays empty until that import.
--
-- Explicit ids keep the FK links deterministic; the migration runs once
-- (tracked by schema_migrations), and these tables ship empty.

INSERT INTO countries (id, name, code) VALUES
  (1, 'Узбекистан', 'UZ'),
  (2, 'Казахстан', 'KZ'),
  (3, 'Кыргызстан', 'KG'),
  (4, 'Таджикистан', 'TJ'),
  (5, 'Туркменистан', 'TM'),
  (6, 'Россия', 'RU'),
  (7, 'Афганистан', 'AF');

INSERT INTO regions (id, country_id, name) VALUES
  (1,  1, 'Республика Каракалпакстан'),
  (2,  1, 'Андижанская область'),
  (3,  1, 'Бухарская область'),
  (4,  1, 'Джизакская область'),
  (5,  1, 'Кашкадарьинская область'),
  (6,  1, 'Навоийская область'),
  (7,  1, 'Наманганская область'),
  (8,  1, 'Самаркандская область'),
  (9,  1, 'Сурхандарьинская область'),
  (10, 1, 'Сырдарьинская область'),
  (11, 1, 'Ташкентская область'),
  (12, 1, 'Ферганская область'),
  (13, 1, 'Хорезмская область'),
  (14, 1, 'город Ташкент');

-- Districts of Tashkent city (region_id = 14).
INSERT INTO districts (region_id, name) VALUES
  (14, 'Алмазарский район'),
  (14, 'Бектемирский район'),
  (14, 'Мирабадский район'),
  (14, 'Мирзо-Улугбекский район'),
  (14, 'Сергелийский район'),
  (14, 'Учтепинский район'),
  (14, 'Чиланзарский район'),
  (14, 'Шайхантахурский район'),
  (14, 'Юнусабадский район'),
  (14, 'Яккасарайский район'),
  (14, 'Яшнабадский район'),
  (14, 'Янгихаётский район');
