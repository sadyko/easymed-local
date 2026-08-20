-- TELEGRAM_CHAT_FOLDERS_V1 — папки чатов, как в Telegram.
--
-- «Все» и «Непрочитанные» — не папки: они вычисляются на лету и в базе их нет.
-- Здесь хранятся только те группы, которые завела клиника («Долги», «Анализы
-- готовы», «VIP»), потому что придумать их за неё нельзя.
--
-- Папки общие для всей клиники, а не личные: регистратура работает сменами, и
-- папка, видимая только заведшему её оператору, к следующей смене исчезает
-- вместе с ним. `created_by` остаётся как след, кто её завёл.
CREATE TABLE telegram_chat_folders (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  -- Порядок вкладок задаёт клиника: «Долги» слева, если ими занимаются каждый
  -- день. При равном значении сортируем по id — порядку создания.
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE UNIQUE INDEX idx_telegram_chat_folders_name ON telegram_chat_folders(name);

-- Чат может лежать в нескольких папках сразу — как в Telegram.
--
-- chat_id, а не ссылка на telegram_links: связку могут отвязать и создать
-- заново (пациент переподключился), и папки не должны при этом рассыпаться —
-- для клиники это тот же самый чат с тем же человеком.
CREATE TABLE telegram_chat_folder_items (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  folder_id INTEGER NOT NULL REFERENCES telegram_chat_folders(id) ON DELETE CASCADE,
  chat_id   TEXT NOT NULL,
  added_by  INTEGER REFERENCES users(id),
  added_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE UNIQUE INDEX idx_telegram_chat_folder_items_once ON telegram_chat_folder_items(folder_id, chat_id);
CREATE INDEX idx_telegram_chat_folder_items_chat ON telegram_chat_folder_items(chat_id);
