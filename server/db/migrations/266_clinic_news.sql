-- CLINIC_NEWS_V1 (2026-10-31) — «ИНФОРМАЦИОННАЯ ДОСКА» КЛИНИКИ.
--
-- Владелец: «add here informative dashboard button too, where can be added
-- daily news of clinic, about foreign doctors coming, some equipment is not
-- working place and so on». Объявления для СОТРУДНИКОВ (не для пациентов):
-- пишет администрация, читают все вошедшие — карточка на витрине
-- «Коммерческие инструменты» (views/clinic-news.js, rpc/clinic-news.js).
--
-- kind — 'news' (новость дня), 'doctor_visit' (приезжий врач), 'equipment'
--   (оборудование не работает), 'other'. CHECK, потому что экран рисует по
--   нему значок и цвет, а неизвестный вид остался бы без них.
-- show_until — до какой даты объявление на доске (включительно, местная дата
--   клиники 'YYYY-MM-DD'); NULL — пока его не снимут. «Аппарат УЗИ не
--   работает» обычно без срока: снимают, когда починили.
-- pinned — закреплено сверху.
-- archived_at — снято с доски («Снять»); строка остаётся историей и видна в
--   «Архиве». Удаления нет: «что было объявлено и когда» — тоже информация.
CREATE TABLE clinic_news (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL DEFAULT 'news' CHECK (kind IN ('news', 'doctor_visit', 'equipment', 'other')),
  title       TEXT NOT NULL CHECK (length(trim(title)) > 0),
  body        TEXT NOT NULL DEFAULT '',
  pinned      INTEGER NOT NULL DEFAULT 0,
  show_until  TEXT,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  archived_at TEXT,
  archived_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX idx_clinic_news_live ON clinic_news(archived_at, pinned, created_at);
