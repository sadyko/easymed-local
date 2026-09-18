-- 138_departments.sql — DEPARTMENTS_V1: РУКОВОДИТЕЛЬ ОТДЕЛА, ЖУРНАЛ ОТДЕЛА,
-- ЗАЩИТА ОТ ДВОЙНОЙ ВЫДАЧИ.
--
-- Владелец (2026-09-18): «Create department → Assign head → Link rooms → Form
-- department → Dispense supplies → Track department resources». Ответы на
-- вопросы: руководитель — врач или медсестра; истории руководителей не нужно;
-- вид отдела — как был; палаты тоже; выдача — обеими дверями (заявка и прямая
-- выдача); возвратов нет; медсестра видит своё.
--
-- ЧТО УЖЕ БЫЛО. Отдел (departments), кабинеты и палаты с department_id
-- (миграция 108), сотрудники с department_id, остатки держателей
-- (stock_holdings, миграция 128). Чего не было: у отдела нет руководителя,
-- у него нет журнала «что с ним делали», а выдача со склада при повторной
-- отправке той же формы списывала бы товар второй раз.
--
--   • departments.head_user_id — руководитель, ссылка на сотрудника. Без
--     отдельной таблицы «глав»: врач, медсестра и любой другой сотрудник — это
--     одна и та же строка users, и вторая таблица разошлась бы с ней.
--   • department_events — журнал отдела: сформирован, изменён, сменился
--     руководитель, добавлен/убран сотрудник, назначено/снято помещение,
--     выдано со склада, создана заявка. details — JSON с подробностями.
--   • stock_issue_receipts — квитанция выдачи по ключу: экран присылает ключ
--     вместе с формой, сервер хранит ответ, и повторная отправка (обновили
--     страницу, нажали дважды) получает тот же ответ, а склад не списывается
--     второй раз.
--
-- ТОЛЬКО ADD COLUMN / CREATE TABLE.
ALTER TABLE departments ADD COLUMN head_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS department_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  department_id INTEGER NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  kind          TEXT    NOT NULL,
  actor_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  details       TEXT,
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_department_events_dept ON department_events(department_id, created_at);

CREATE TABLE IF NOT EXISTS stock_issue_receipts (
  key        TEXT PRIMARY KEY,
  result     TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
