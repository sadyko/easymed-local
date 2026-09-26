-- GROUPS_FIVE_REFERRAL_V1 (2026-09-26) — СТАВКИ НАПРАВЛЕНИЙ ПО ПЯТИ ГРУППАМ.
--
-- Владелец: «в системе 5 групп, а в направлениях почему-то 6; и в категориях
-- источников тоже». Словарь владельца (2026-09-15): ГРУППА — пять значений
-- services.type (consultation / lab / imaging = «Диагностика» / procedure /
-- other = «Хирургия», мигр. 109); ТИП — строки service_types, которые клиника
-- пишет сама; КАТЕГОРИЯ — service_categories.
--
-- ЧТО БЫЛО. referral_sources.own_rates и referral_source_categories.rates
-- (мигр. 120) — JSON-массивы [{type_id, unit, value}], ключ — service_types.id,
-- а таблица ставок называла эти строки «Группа услуг». На базе разработки
-- типов шесть: пять повторяют группы, шестой («Лучевая диагностика») без
-- единой услуги.
--
-- ЧТО ТЕПЕРЬ. Записи [{group, unit, value}], group — одно из пяти значений
-- services.type; расчёт (shared/referral-reward.js) ищет ставку по
-- services.type позиции счёта.
--
-- ПЕРЕВОД type_id → группа считается ЗДЕСЬ, по данным клиники:
--   * группа типа — та, к которой принадлежит БОЛЬШИНСТВО услуг этого типа
--     (при равенстве — первая по алфавиту ключа, чтобы результат не зависел
--     от порядка строк); 'radiology' читается как 'imaging';
--   * у типа без услуг — по точному названию («Консультации», «Лаборатория»,
--     «Диагностика», «Процедуры», «Хирургия» и формы в единственном числе);
--   * тип, который не перевёлся никак, отбрасывается — С ЗАПИСЬЮ в журнал.
-- Где два типа попали в одну группу, остаётся запись типа, у которого БОЛЬШЕ
-- услуг (тот, по чьей ставке платилось большинство строк); при равенстве —
-- меньший id. Если у проигравшей записи была ДРУГАЯ ставка — она пишется в
-- журнал referral_rate_migration_log (ops_events для этого не годится: у него
-- CHECK на вид события и принципиально нет колонок под значения). Совпадающие
-- ставки просто сливаются — терять там нечего.
--
-- ЧТО ЕЩЁ МЕНЯЕТСЯ МОЛЧА — И ПОЭТОМУ ПИШЕТСЯ В ЖУРНАЛ (ревью I-4):
--   * 'split' — у типа есть услуги и в ДРУГИХ группах (не в той, куда тип
--     перевёлся). Раньше они платились по ставке типа, теперь — по ставке своей
--     группы (или стандартным %). Строка на (ставка, тип, группа меньшинства)
--     с числом таких услуг в service_count; unit/value — прежняя ставка типа.
--   * 'untyped' — услуги БЕЗ типа (type_id IS NULL) раньше не находили ставку и
--     платились стандартным %, теперь находят ставку своей группы. Строка на
--     (ставка, группа) с числом таких услуг; unit/value — новая ставка группы,
--     kept_type_id — тип, чья ставка стала ставкой группы.
--
-- ИДЕМПОТЕНТНОСТЬ. Переводится только строка, в которой есть хоть одна запись
-- с type_id; уже переведённая (только group) не трогается. Записи, которые уже
-- с group, в смешанной строке сохраняются и выигрывают у переводимых — это
-- ставка, заданная уже в новом редакторе.

CREATE TABLE IF NOT EXISTS referral_rate_migration_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  table_name   TEXT NOT NULL,          -- referral_sources | referral_source_categories
  row_id       INTEGER NOT NULL,
  type_id      INTEGER,                -- ключ отброшенной записи
  type_name    TEXT,
  service_group TEXT,                  -- куда она перевелась бы (NULL — никуда)
  unit         TEXT,
  value        REAL,
  kept_type_id INTEGER,                -- чья запись осталась в этой группе
  service_count INTEGER,               -- split / untyped: сколько услуг меняют ставку
  reason       TEXT NOT NULL CHECK (reason IN ('conflict','unmapped','split','untyped')),
  at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- Тип → группа.
DROP TABLE IF EXISTS temp.m153_counts;
CREATE TEMP TABLE m153_counts AS
SELECT type_id,
       CASE type WHEN 'radiology' THEN 'imaging' ELSE type END AS grp,
       COUNT(*) AS n
  FROM services
 -- type IS NOT NULL: услуга без группы не может выиграть группу типа (ревью I-4)
 WHERE type_id IS NOT NULL AND type IS NOT NULL
 GROUP BY type_id, CASE type WHEN 'radiology' THEN 'imaging' ELSE type END;

DROP TABLE IF EXISTS temp.m153_map;
CREATE TEMP TABLE m153_map AS
SELECT st.id   AS type_id,
       st.name AS type_name,
       COALESCE(
         (SELECT c.grp FROM m153_counts c WHERE c.type_id = st.id
           ORDER BY c.n DESC, c.grp LIMIT 1),
         CASE trim(st.name)
           WHEN 'Консультации' THEN 'consultation' WHEN 'Консультация' THEN 'consultation'
           WHEN 'Лаборатория'  THEN 'lab'
           WHEN 'Диагностика'  THEN 'imaging'
           WHEN 'Процедуры'    THEN 'procedure'    WHEN 'Процедура'    THEN 'procedure'
           WHEN 'Хирургия'     THEN 'other'
         END) AS grp,
       COALESCE((SELECT SUM(c.n) FROM m153_counts c WHERE c.type_id = st.id), 0) AS weight
  FROM service_types st;

-- Все записи строк, которые ещё надо переводить.
DROP TABLE IF EXISTS temp.m153_entries;
CREATE TEMP TABLE m153_entries AS
SELECT 'referral_sources' AS tbl, r.id AS row_id, CAST(e.key AS INTEGER) AS idx,
       json_extract(e.value, '$.type_id') AS type_id,
       json_extract(e.value, '$.group')   AS old_group,
       json_extract(e.value, '$.unit')    AS unit,
       json_extract(e.value, '$.value')   AS value
  FROM referral_sources r, json_each(r.own_rates) e
 WHERE json_valid(r.own_rates) AND json_type(r.own_rates) = 'array' AND e.type = 'object'
   AND EXISTS (SELECT 1 FROM json_each(r.own_rates) x
                WHERE x.type = 'object' AND json_extract(x.value, '$.type_id') IS NOT NULL)
UNION ALL
SELECT 'referral_source_categories', c.id, CAST(e.key AS INTEGER),
       json_extract(e.value, '$.type_id'), json_extract(e.value, '$.group'),
       json_extract(e.value, '$.unit'),    json_extract(e.value, '$.value')
  FROM referral_source_categories c, json_each(c.rates) e
 WHERE json_valid(c.rates) AND json_type(c.rates) = 'array' AND e.type = 'object'
   AND EXISTS (SELECT 1 FROM json_each(c.rates) x
                WHERE x.type = 'object' AND json_extract(x.value, '$.type_id') IS NOT NULL);

DROP TABLE IF EXISTS temp.m153_resolved;
CREATE TEMP TABLE m153_resolved AS
SELECT en.tbl, en.row_id, en.idx, en.unit, en.value,
       CAST(en.type_id AS INTEGER) AS type_id,
       m.type_name,
       CASE WHEN en.type_id IS NULL
            THEN (CASE en.old_group WHEN 'radiology' THEN 'imaging' ELSE en.old_group END)
            ELSE m.grp END AS grp,
       -- запись, уже заданная группой, выигрывает у переводимой
       CASE WHEN en.type_id IS NULL THEN 1e18 ELSE COALESCE(m.weight, 0) END AS weight
  FROM m153_entries en
  LEFT JOIN m153_map m ON m.type_id = CAST(en.type_id AS INTEGER);
UPDATE m153_resolved SET grp = NULL
 WHERE grp NOT IN ('consultation','lab','imaging','procedure','other');

DROP TABLE IF EXISTS temp.m153_ranked;
CREATE TEMP TABLE m153_ranked AS
SELECT r.*,
       ROW_NUMBER() OVER (PARTITION BY r.tbl, r.row_id, r.grp
                          ORDER BY r.weight DESC, r.type_id IS NULL DESC, r.type_id, r.idx) AS rn
  FROM m153_resolved r
 WHERE r.grp IS NOT NULL;

-- Журнал: не перевелась никуда.
INSERT INTO referral_rate_migration_log (table_name, row_id, type_id, type_name, service_group, unit, value, kept_type_id, reason)
SELECT tbl, row_id, type_id, type_name, NULL, unit, value, NULL, 'unmapped'
  FROM m153_resolved WHERE grp IS NULL;

-- Журнал: проиграла другой записи той же группы с ДРУГОЙ ставкой.
INSERT INTO referral_rate_migration_log (table_name, row_id, type_id, type_name, service_group, unit, value, kept_type_id, reason)
SELECT l.tbl, l.row_id, l.type_id, l.type_name, l.grp, l.unit, l.value, w.type_id, 'conflict'
  FROM m153_ranked l
  JOIN m153_ranked w ON w.tbl = l.tbl AND w.row_id = l.row_id AND w.grp = l.grp AND w.rn = 1
 WHERE l.rn > 1
   AND ( (CASE WHEN l.unit = 'fix' THEN 'fix' ELSE 'pct' END) <> (CASE WHEN w.unit = 'fix' THEN 'fix' ELSE 'pct' END)
      OR CAST(l.value AS REAL) IS NOT CAST(w.value AS REAL) );

-- Журнал (ревью I-4): услуги типа в ДРУГОЙ группе, чем та, куда тип перевёлся,
-- больше не платятся по ставке типа. Услуги без группы (type IS NULL) — тоже:
-- у них service_group пуст.
INSERT INTO referral_rate_migration_log (table_name, row_id, type_id, type_name, service_group, unit, value, kept_type_id, reason, service_count)
SELECT r.tbl, r.row_id, r.type_id, r.type_name, s.grp, r.unit, r.value, NULL, 'split', s.n
  FROM m153_resolved r
  JOIN (SELECT type_id, CASE type WHEN 'radiology' THEN 'imaging' ELSE type END AS grp, COUNT(*) AS n
          FROM services WHERE type_id IS NOT NULL
         GROUP BY type_id, CASE type WHEN 'radiology' THEN 'imaging' ELSE type END) s
    ON s.type_id = r.type_id
 WHERE r.type_id IS NOT NULL AND r.grp IS NOT NULL AND s.grp IS NOT r.grp;

-- Журнал (ревью I-4): услуги без типа в группе, которая теперь получила ставку,
-- раньше платились стандартным %.
INSERT INTO referral_rate_migration_log (table_name, row_id, type_id, type_name, service_group, unit, value, kept_type_id, reason, service_count)
SELECT k.tbl, k.row_id, NULL, NULL, k.grp, k.unit, k.value, k.type_id, 'untyped', u.n
  FROM m153_ranked k
  JOIN (SELECT CASE type WHEN 'radiology' THEN 'imaging' ELSE type END AS grp, COUNT(*) AS n
          FROM services WHERE type_id IS NULL AND type IS NOT NULL
         GROUP BY CASE type WHEN 'radiology' THEN 'imaging' ELSE type END) u
    ON u.grp = k.grp
 WHERE k.rn = 1;

-- Перезапись: по записи на группу, в порядке таблицы ставок.
UPDATE referral_sources SET own_rates = (
  SELECT json_group_array(json_object('group', k.grp, 'unit', k.unit, 'value', k.value))
    FROM (SELECT grp, unit, value FROM m153_ranked
           WHERE tbl = 'referral_sources' AND row_id = referral_sources.id AND rn = 1
           ORDER BY CASE grp WHEN 'consultation' THEN 1 WHEN 'lab' THEN 2 WHEN 'imaging' THEN 3
                             WHEN 'procedure' THEN 4 ELSE 5 END) k)
 WHERE id IN (SELECT row_id FROM m153_entries WHERE tbl = 'referral_sources');

UPDATE referral_source_categories SET rates = (
  SELECT json_group_array(json_object('group', k.grp, 'unit', k.unit, 'value', k.value))
    FROM (SELECT grp, unit, value FROM m153_ranked
           WHERE tbl = 'referral_source_categories' AND row_id = referral_source_categories.id AND rn = 1
           ORDER BY CASE grp WHEN 'consultation' THEN 1 WHEN 'lab' THEN 2 WHEN 'imaging' THEN 3
                             WHEN 'procedure' THEN 4 ELSE 5 END) k)
 WHERE id IN (SELECT row_id FROM m153_entries WHERE tbl = 'referral_source_categories');

DROP TABLE temp.m153_ranked;
DROP TABLE temp.m153_resolved;
DROP TABLE temp.m153_entries;
DROP TABLE temp.m153_map;
DROP TABLE temp.m153_counts;
