-- CRM_UNIFY_V1 (2026-10-09) — РАЗОВОЕ ИСПРАВЛЕНИЕ ЗАСТРЯВШИХ КАРТОЧЕК И
-- ПОТЕРЯННЫХ ЗАДАЧ (решение владельца 5, Р19).
--
-- Само исправление делает сервер при первом запуске после этой миграции
-- (server/services/crm/unify-repair.js), до первого прохода «Не пришёл»:
-- «может ли сотрудник вести карточку» — правило прав (роль, своя роль клиники,
-- дополнительные роли, «crm.all», «CRM: изменение»), и живёт оно только в коде
-- (crm/tasks-follow.js); его копия на SQL была бы вторым ответом на тот же
-- вопрос. Здесь — отметка «ещё не сделано» и журнал исправленного: только
-- номера и ключи колонок, ни имён, ни денег.
--
-- Отметка ставится той же транзакцией, что и правки: упавший запуск не
-- оставляет ни половины правок, ни отметки — исправление повторится при
-- следующем запуске целиком. Резервная копия перед миграциями (server/index.js)
-- покрывает и его: оно идёт в том же запуске.
--
-- Таблицы этой установки (здания): соседям не ездят, как и сами карточки.
CREATE TABLE crm_unify_repair (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  done_at    TEXT,
  cards      INTEGER NOT NULL DEFAULT 0 CHECK (cards >= 0),      -- живые карточки → конверсия
  no_shows   INTEGER NOT NULL DEFAULT 0 CHECK (no_shows >= 0),   -- «Не пришёл» → конверсия
  tasks      INTEGER NOT NULL DEFAULT 0 CHECK (tasks >= 0)       -- задачи → оператору карточки
);
INSERT INTO crm_unify_repair (id) VALUES (1);

-- Журнал: kind 'card' — карточка request_id сменила колонку from_value →
-- to_value; kind 'task' — задача task_id карточки request_id сменила
-- исполнителя (номера сотрудников; from_value пуст — исполнителя не было).
-- Внешних ключей нет намеренно: журнал — история, карточку и задачу потом можно
-- удалить.
CREATE TABLE crm_unify_repair_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL CHECK (kind IN ('card', 'task')),
  request_id  INTEGER NOT NULL,
  task_id     INTEGER,
  from_value  TEXT,
  to_value    TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  CHECK ((kind = 'task') = (task_id IS NOT NULL))
);
