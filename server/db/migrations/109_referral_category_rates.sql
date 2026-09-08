-- REFERRAL_CATEGORY_RATES_V1 — ставка вознаграждения живёт на КАТЕГОРИИ
-- источника, а источник либо берёт её, либо задаёт свою целиком.
--
-- Как было: чтобы задать процент категории «Внешный врач», в клинике заводили
-- ПРАВИЛО ВОЗНАГРАЖДЕНИЯ с точно таким же названием, а отчёт «Рефералы» искал
-- ставку сравнением строк — сначала правило с именем источника, потом правило
-- с именем его категории (referralsReport в services/rpc/reports.js). Опечатка
-- в названии молча означала 0%: ошибки никто не показывал, партнёру просто не
-- платили. Ставка была одна на всю категорию — лаборатории и хирургии разный
-- процент не задать, — а фиксированную сумму за услугу нельзя было задать
-- вовсе: правило хранит только процент.
--
-- Что становится: у категории есть стандартный процент и ставки по группам
-- услуг; у источника — галочка «по категории» либо свои ставки. Строка группы
-- может быть процентом ИЛИ фиксированной суммой за услугу.
ALTER TABLE referral_source_categories ADD COLUMN standard_percent REAL NOT NULL DEFAULT 0;
ALTER TABLE referral_source_categories ADD COLUMN rates            TEXT NOT NULL DEFAULT '';

-- category_id — НАСТОЯЩАЯ ссылка вместо свободного текста в `category`.
-- Свободный текст и был причиной, по которой опечатка стоила партнёру ставки.
-- Ссылка не каскадная и без ON DELETE: удалить категорию всё равно некому —
-- реестр ставит delete:{roles:[]} обеим таблицам.
ALTER TABLE referral_sources ADD COLUMN category_id INTEGER REFERENCES referral_source_categories(id);

-- 'category' — вознаграждение по ставке категории; 'own' — свои ставки.
-- CHECK намеренно не ставится, тем же доводом, что у payment_type в мигр. 058:
-- упавший CHECK на живом регистре хуже неожиданной строки. Читатель ставок
-- (services/referral-reward.js) любой незнакомый режим считает 'category'.
ALTER TABLE referral_sources ADD COLUMN reward_mode TEXT NOT NULL DEFAULT 'category';
ALTER TABLE referral_sources ADD COLUMN own_percent REAL NOT NULL DEFAULT 0;
ALTER TABLE referral_sources ADD COLUMN own_rates   TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_referral_sources_category ON referral_sources(category_id);

-- ===================== ПЕРЕНОС УЖЕ НАСТРОЕННЫХ ДЕНЕГ =====================
-- После обновления клиника обязана получить ТЕ ЖЕ суммы, что считались
-- накануне. Три шага ниже повторяют порядок разрешения ставки в сегодняшнем
-- referralsReport, поэтому первая же выгрузка отчёта даёт прежние цифры.
--
-- Всё, что здесь есть, идемпотентно: повторный прогон блока ничего не меняет.
-- Это не теория — на этом построен его тест (109.test.js).

-- Шаг 1а. Категории, которые существуют ТОЛЬКО как набранный текст, заводятся
-- как настоящие записи справочника. Сравнение без учёта регистра и пробелов по
-- краям — «врач» и «Врач » это одна категория.
--
-- Регистр складывает lower_uni, а не встроенный lower: встроенный складывает
-- ТОЛЬКО латиницу (CYRILLIC_ILIKE_V1 в db/connection.js), то есть «Внешний» и
-- «внешний» остались бы разными категориями. Здесь это не косметика: отчёт,
-- который переносится, сравнивает имена джаваскриптовым toLowerCase() — он
-- кириллицу складывает, — и разошедшееся сравнение означало бы, что после
-- обновления партнёру платят другую сумму.
--
-- А вот «Внешный врач» и «Внешний врач» — РАЗНЫЕ: они отличаются буквой, а не
-- регистром. Миграция сохраняет то, что есть, и не угадывает, где опечатка:
-- свести две категории вручную — минутное дело, а угаданное слияние ставок
-- необратимо.
INSERT INTO referral_source_categories (name)
SELECT t.nm FROM (
    SELECT trim(rs.category) AS nm, lower_uni(trim(rs.category)) AS k
      FROM referral_sources rs
     WHERE trim(COALESCE(rs.category, '')) <> ''
     GROUP BY k
) t
WHERE NOT EXISTS (
    SELECT 1 FROM referral_source_categories c WHERE lower_uni(trim(c.name)) = t.k);

-- Шаг 1б. Связываем источник с его категорией. ORDER BY id — на случай, когда
-- в справочнике УЖЕ лежали два одинаковых по написанию названия: берём то,
-- что завели раньше, а не то, которое подвернулось.
UPDATE referral_sources
   SET category_id = (
       SELECT c.id FROM referral_source_categories c
        WHERE lower_uni(trim(c.name)) = lower_uni(trim(referral_sources.category))
        ORDER BY c.id LIMIT 1)
 WHERE trim(COALESCE(category, '')) <> '';

-- Шаг 1в. Текст гасим: два источника правды у одного поля — это ровно та
-- ошибка, из-за которой опечатка стоила денег. Строка остаётся только там, где
-- связать не удалось (после шага 1а таких быть не должно) — и тогда она видна.
UPDATE referral_sources SET category = '' WHERE category_id IS NOT NULL;

-- Шаг 2. Правило вознаграждения, названное как категория, становится
-- стандартным процентом этой категории.
--
-- Только active = 1: выключенное правило не платило вчера и не должно начать
-- платить сегодня — отчёт читает ставки тем же условием. При нескольких
-- подходящих правилах берётся ПОСЛЕДНЕЕ заведённое: сегодняшний Map строится
-- обходом списка в порядке вставки, и последнее совпадение затирает прежние.
UPDATE referral_source_categories
   SET standard_percent = (
       SELECT r.percent FROM referral_rewards r
        WHERE r.active = 1
          AND lower_uni(trim(r.name)) = lower_uni(trim(referral_source_categories.name))
        ORDER BY r.id DESC LIMIT 1)
 WHERE EXISTS (
       SELECT 1 FROM referral_rewards r
        WHERE r.active = 1
          AND lower_uni(trim(r.name)) = lower_uni(trim(referral_source_categories.name)));

-- Шаг 3. Правило, названное как САМ источник, — это его личная ставка, и она
-- перекрывает категорию. Порядок шагов 2 и 3 здесь и есть тот приоритет.
UPDATE referral_sources
   SET reward_mode = 'own',
       own_percent = (
       SELECT r.percent FROM referral_rewards r
        WHERE r.active = 1
          AND lower_uni(trim(r.name)) = lower_uni(trim(referral_sources.name))
        ORDER BY r.id DESC LIMIT 1)
 WHERE EXISTS (
       SELECT 1 FROM referral_rewards r
        WHERE r.active = 1
          AND lower_uni(trim(r.name)) = lower_uni(trim(referral_sources.name)));

-- referral_rewards НЕ трогаем и не роняем: её строки — единственный путь
-- назад, если перенос окажется неверным.
