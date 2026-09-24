-- 148_crm_tasks.sql — CRM_DEDUP_SEARCH_TASKS_V1 (2026-09-23). Задачи на карточке
-- заявки CRM.
--
-- Владелец: «add tasks to the card of the crm». Решено: список задач у заявки —
-- текст, дата и время, ответственный, отметка «сделано»; красный счётчик
-- просроченных у пункта CRM в меню — ответственному свои, администратору все.
--
-- due_at — срок в UTC, 'YYYY-MM-DDTHH:MM:SSZ' (так же, как created_at): экран
-- вводит местное время и переводит его сам, а «просрочено» — это сравнение
-- строк due_at <= сейчас, одинаковое в запросе счётчика и на экране.
-- done_at пусто = задача открыта.
--
-- Удаление заявки уносит её задачи (CASCADE): задача без заявки — это
-- напоминание ни о ком. Ссылки на сотрудников — без каскада, как у
-- crm_requests.assigned_to: сотрудника увольняют (is_active = 0), а не удаляют.
--
-- В ОБМЕН МЕЖДУ ЗДАНИЯМИ НЕ ЕДЕТ: доски заявок в branch-sync нет вовсе
-- (SHIPPED), и request_id — id ЭТОЙ базы. Пришпилено в 148.test.js.
CREATE TABLE IF NOT EXISTS crm_tasks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id  INTEGER NOT NULL REFERENCES crm_requests(id) ON DELETE CASCADE,
  text        TEXT NOT NULL CHECK (length(trim(text)) > 0),
  due_at      TEXT,
  assignee_id INTEGER REFERENCES users(id),
  done_at     TEXT,
  done_by     INTEGER REFERENCES users(id),
  created_by  INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- Счётчик в меню: «открытые задачи этого человека со сроком до сейчас».
CREATE INDEX IF NOT EXISTS idx_crm_tasks_assignee ON crm_tasks (assignee_id, done_at, due_at);
-- Окно заявки: «задачи этой заявки».
CREATE INDEX IF NOT EXISTS idx_crm_tasks_request ON crm_tasks (request_id);
