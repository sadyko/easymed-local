-- 115_case_doc_types.sql — CASE_DOC_SET_V2: состав истории болезни задаёт КЛИНИКА.
--
-- Владелец (2026-09-08): «this list is hardcoded and the system asks for
-- filling them, we need to make not hardcoded, and able to add a title
-- document. its maybe before operation it can be anesthesist list etc etc. but
-- we shoud give basic templates list + option».
--
-- До этого набор из десяти документов был константой в коде
-- (rpc/inpatient-reviews.js, CASE_DOC_SET). Он верен для типовой хирургии и
-- неверен для всех остальных: родильному отделению нужен партограмма-лист,
-- реанимации — карта интенсивной терапии, а кому-то лишний «осмотр
-- заведующего» просто мешает и вечно висит просроченным. Клиника не может
-- править код, поэтому набор переезжает в базу.
--
-- ЧТО ОСТАЁТСЯ КОДОМ. Правила срока — их четыре, и каждое считается по-своему
-- (от койки, периодом, от начала хирургического блока, при выписке). Клиника
-- ВЫБИРАЕТ правило и число часов, но не изобретает новое: новое правило — это
-- новая арифметика, а не строка в справочнике.
--
-- ПОЧЕМУ kind ОСТАЁТСЯ ТЕКСТОМ И КЛЮЧОМ. На него уже ссылаются написанные
-- записи (admission_reviews.kind) и собранные истории. Замена его на
-- числовой id означала бы переписать существующие записи — то есть пересборку
-- таблицы, которой мы не делаем (урок 1.1.0). Поэтому kind уникален, а
-- встроенные роды сохраняют СВОИ прежние значения: старые записи продолжают
-- находиться своим чек-листом.
--
-- Только CREATE TABLE и INSERT — пересборок нет.
CREATE TABLE IF NOT EXISTS case_doc_types (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Род записи: то же значение, что в admission_reviews.kind.
  kind       TEXT    NOT NULL UNIQUE,
  -- Название клиники для своих родов. У встроенных пусто: их имена переводятся
  -- на три языка на экране, и записать сюда одно из них значило бы навсегда
  -- прибить документ к одному языку.
  title      TEXT    NOT NULL DEFAULT '',
  -- Правило срока. 'none' — документ без срока: он в наборе, но никогда не
  -- «просрочен» (клиника ведёт его по обстоятельствам).
  due_rule   TEXT    NOT NULL DEFAULT 'clock'
             CHECK (due_rule IN ('clock','period','surgical','at_discharge','none')),
  -- Часы для правила. У 'at_discharge' и 'none' пусто.
  due_hours  INTEGER,
  -- Блок, который появляется только вместе со своим первым документом.
  -- Сегодня блок один — хирургический; поэтому не флаг, а имя.
  block      TEXT,
  -- Порядок в чек-листе — он же порядок в собранной истории болезни.
  sort_order INTEGER NOT NULL DEFAULT 0,
  -- Встроенный род нельзя удалить и переименовать: на него ссылается код
  -- (гейт выписки спрашивает выписной эпикриз по имени) и уже написанные
  -- записи. Выключить его из набора можно — active = 0.
  builtin    INTEGER NOT NULL DEFAULT 0 CHECK (builtin IN (0,1)),
  active     INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- Чек-лист читает набор целиком и по порядку — это его единственный запрос.
CREATE INDEX IF NOT EXISTS idx_case_doc_types_order ON case_doc_types (active, sort_order);

-- ВСТРОЕННЫЙ НАБОР — тот же, что был константой, строка в строку и в том же
-- порядке. Клиника, которая ничего не настраивала, не заметит миграции.
INSERT OR IGNORE INTO case_doc_types (kind, due_rule, due_hours, block, sort_order, builtin) VALUES
  ('intake',      'clock',        2,    NULL,       10, 1),
  ('anesthesia',  'surgical',     24,   'surgical', 20, 1),
  ('preop',       'surgical',     24,   'surgical', 30, 1),
  ('head_review', 'clock',        72,   NULL,       40, 1),
  ('primary',     'clock',        24,   NULL,       50, 1),
  ('rationale',   'clock',        72,   NULL,       60, 1),
  ('operation',   'surgical',     24,   'surgical', 70, 1),
  ('round',       'period',       24,   NULL,       80, 1),
  ('interim',     'period',       240,  NULL,       90, 1),
  ('discharge',   'at_discharge', NULL, NULL,      100, 1);
