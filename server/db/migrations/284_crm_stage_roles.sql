-- CRM_STAGE_ROLES_V1 (3.23.0) — РОЛИ КОЛОНОК CRM-КАНБАНА: «запись», «подтверждение»,
-- «не пришёл».
--
-- Владелец (2026-11-10): «there is a setting in the CRM kanban columns; we need to add a
-- booking tick (like conversion) so the system won't break». До этой миграции три колонки,
-- на которые завязана автоматика, угадывались:
--   «Колонка записи»       — выбор crm_settings.booked_stage, если он допустим, иначе
--                            «Записан» (ключ 'scheduled'), иначе последняя открытая видимая
--                            колонка до конверсии (public/js/shared/crm-booked-stage.js);
--   «Колонка подтверждения» — первая открытая видимая колонка после колонки записи и до
--                            конверсии (по порядку колонок);
--   «Не пришёл»            — колонка с ключом 'no_show', если она проигрышная (kind 'lost').
-- Теперь это роль колонки — отметка, как «конверсия» (вид won). Одна колонка на роль
-- (частичный уникальный индекс), у колонки не больше одной роли. Роли может не быть: без
-- роли «не пришёл» автоматика «Не пришёл» выключена (services/crm/config.js noShowStageKey).
--
-- ЗАПОЛНЕНИЕ — РОВНО ТЕМ, ЧТО КЛИНИКА ИСПОЛЬЗУЕТ СЕГОДНЯ: по ключам, порядку (position,
-- затем ключ — как listStages), видимости, виду и сохранённому выбору. Никогда по названиям:
-- переименованная «Записан» остаётся колонкой записи, а колонка, которую назвали «Записан»,
-- ею не становится. После обновления ни одна карточка никуда не переезжает.
--
-- crm_settings.booked_stage больше не читается (его выбор переносится сюда); столбец
-- остаётся — откат на 3.22.0 его найдёт.
--
-- Настройка — этого здания: crm_stages соседям не ездит (branch-sync/journal.js SHIPPED).
ALTER TABLE crm_stages ADD COLUMN role TEXT
  CHECK (role IS NULL OR role IN ('booked', 'confirmed', 'no_show'));

CREATE UNIQUE INDEX crm_stages_one_role ON crm_stages(role) WHERE role IS NOT NULL;

-- 0. Ревью — РАВНЫЕ position (их оставляет только ручная правка базы: экран пишет 1..n). Порядок
--    таких колонок 3.22.0 решал localeCompare (crm-booked-stage.js, экран), а SQLite — коды
--    символов; для ключей [a-z0-9_] они расходятся только в «_» (localeCompare ставит его перед
--    цифрами и буквами). Колонки перенумеровываются 1..n в том порядке, который клиника видела на
--    экране и по которому 3.22.0 угадывал колонку записи, — и дальше равенства нет, а SQL и JS
--    (сравнение по кодам) видят один порядок. Без равных position ничего не меняется.
CREATE TEMP TABLE _crm_stage_order AS
  SELECT key, ROW_NUMBER() OVER (ORDER BY position, replace(key, '_', ' ')) AS n FROM crm_stages
   WHERE EXISTS (SELECT 1 FROM crm_stages a JOIN crm_stages b ON a.key < b.key AND a.position = b.position);
UPDATE crm_stages SET position = (SELECT o.n FROM _crm_stage_order o WHERE o.key = crm_stages.key)
 WHERE key IN (SELECT key FROM _crm_stage_order);
DROP TABLE _crm_stage_order;

-- 1. «Запись»: допустимый сохранённый выбор, иначе 'scheduled', иначе последняя кандидатка.
--    Кандидатки — открытые видимые колонки ДО первой колонки-конверсии (без конверсии — все).
WITH ord AS (
  SELECT key, kind, is_active, ROW_NUMBER() OVER (ORDER BY position, key) AS n FROM crm_stages
),
conv AS (SELECT MIN(n) AS n FROM ord WHERE kind = 'won'),
cand AS (
  SELECT o.key, o.n FROM ord o, conv c
   WHERE o.kind = 'open' AND o.is_active = 1 AND (c.n IS NULL OR o.n < c.n)
)
UPDATE crm_stages SET role = 'booked'
 WHERE key = COALESCE(
   (SELECT c.key FROM cand c JOIN crm_settings s ON s.id = 1 AND s.booked_stage = c.key),
   (SELECT key FROM cand WHERE key = 'scheduled'),
   (SELECT key FROM cand ORDER BY n DESC LIMIT 1));

-- 2. «Подтверждение»: первая открытая видимая колонка ПОСЛЕ колонки записи и ДО конверсии.
WITH ord AS (
  SELECT key, kind, is_active, role, ROW_NUMBER() OVER (ORDER BY position, key) AS n FROM crm_stages
),
conv AS (SELECT MIN(n) AS n FROM ord WHERE kind = 'won'),
bk AS (SELECT n FROM ord WHERE role = 'booked')
UPDATE crm_stages SET role = 'confirmed'
 WHERE key = (SELECT o.key FROM ord o, conv c, bk b
               WHERE o.kind = 'open' AND o.is_active = 1 AND o.n > b.n AND (c.n IS NULL OR o.n < c.n)
               ORDER BY o.n LIMIT 1);

-- 3. «Не пришёл»: сидовая колонка, если она проигрышная (видимая или скрытая — сервер 3.22.0
--    ставил «Не пришёл» и в скрытую). Иначе роли нет: автоматика и прежде молчала.
UPDATE crm_stages SET role = 'no_show' WHERE key = 'no_show' AND kind = 'lost';
