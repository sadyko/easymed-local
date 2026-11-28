-- HR_STAFF_V1 (2026-11-26) — РАЗДЕЛ «HR»: ДОКУМЕНТЫ СОТРУДНИКА И ВЫДАННАЯ ТЕХНИКА.
--
-- Владелец: «list of workers with the filter based on what position, doctor,
-- administrative or middle low, and based on what field, when hired, if hired
-- documents uploading place for each staff, and place to assign using
-- materials like laptop or phone or so on».
--
-- Список сотрудников своей таблицы не получает: категория (users.staff_type —
-- 'doctor' | 'admin_staff' | 'mid_low'), должность, специальность, отдел и дата
-- приёма уже живут в users и правятся в «Сотрудниках». Здесь — только то,
-- чего в users нет и быть не должно: файлы и вещи.
--
-- hr_staff_documents — сканы паспорта, диплома, договора и прочего. Файл лежит
--   в отдельной корзине хранилища `hr-docs` по пути staff/<user_id>/<ключ>
--   (server/routes/storage.js: читать и класть — только с правом `hr`). Строку
--   не удаляют, а снимают (removed_at): «какой договор был приложен и кто его
--   убрал» — кадровая история, и файл по старой ссылке должен открыться после
--   отката копии.
-- hr_assets — выданная техника: ноутбук, телефон, планшет… Возврат — это
--   returned_at, а не удаление строки: «у кого был ноутбук с этим серийным
--   номером в марте» — ровно тот вопрос, ради которого журнал и заводят.
CREATE TABLE hr_staff_documents (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL DEFAULT 'other' CHECK (kind IN ('passport', 'diploma', 'contract', 'certificate', 'medical', 'order', 'other')),
  title       TEXT NOT NULL CHECK (length(trim(title)) > 0),
  file_path   TEXT NOT NULL CHECK (length(file_path) > 0),
  file_name   TEXT NOT NULL DEFAULT '',
  file_size   INTEGER NOT NULL DEFAULT 0,
  valid_until TEXT,
  uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  uploaded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  removed_at  TEXT,
  removed_by  INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX idx_hr_staff_documents_user ON hr_staff_documents(user_id, removed_at);

CREATE TABLE hr_assets (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL DEFAULT 'other' CHECK (kind IN ('laptop', 'desktop', 'phone', 'tablet', 'monitor', 'sim', 'uniform', 'key', 'other')),
  name          TEXT NOT NULL CHECK (length(trim(name)) > 0),
  serial_no     TEXT NOT NULL DEFAULT '',
  inventory_no  TEXT NOT NULL DEFAULT '',
  note          TEXT NOT NULL DEFAULT '',
  issued_on     TEXT NOT NULL,
  issued_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  returned_on   TEXT,
  returned_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  return_note   TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_hr_assets_user ON hr_assets(user_id, returned_on);
