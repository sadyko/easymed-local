-- HR_CANDIDATE_DOCS_V1 (2026-11-28) — ДОКУМЕНТЫ КАНДИДАТА В «ПОДБОРЕ».
--
-- Владелец (снимок карточки кандидата): «make it wider and put place to upload
-- documents, like passport, resume, diploma and so on».
--
-- Файлы лежат в той же корзине `hr-docs`, что и документы сотрудников, но в
-- своей папке: candidate/<id кандидата>/<файл>. Право на неё — строка «Ролей»
-- hr_recruiting (рекрутер), а не только администратор, как у staff/: резюме
-- и паспорт кандидата рекрутер смотрит каждый день (routes/storage.js).
--
-- Документ не стирают, а убирают из карточки (removed_at), как у сотрудника:
-- строка — история, файл — на диске.
--
-- Когда из нанятого кандидата заводят сотрудника (hr_candidate_link_employee),
-- его документы переносятся в карточку сотрудника строками hr_staff_documents
-- с тем же file_path — второй раз сканировать паспорт не нужно.
CREATE TABLE hr_candidate_documents (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id  INTEGER NOT NULL REFERENCES hr_candidates(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL DEFAULT 'other'
                CHECK (kind IN ('passport', 'resume', 'diploma', 'certificate', 'medical', 'recommendation', 'other')),
  title         TEXT NOT NULL CHECK (length(trim(title)) > 0),
  file_path     TEXT NOT NULL CHECK (length(file_path) > 0),
  file_name     TEXT NOT NULL DEFAULT '',
  file_size     INTEGER NOT NULL DEFAULT 0,
  uploaded_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  uploaded_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  removed_at    TEXT,
  removed_by    INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX idx_hr_candidate_documents_cand ON hr_candidate_documents(candidate_id, removed_at);
