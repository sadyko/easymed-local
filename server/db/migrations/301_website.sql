-- WEBSITE_V1 — публичный сайт клиники (перенос модуля из Chilla: его 083 + 087).
--
-- Сайт — второй слушатель того же процесса (server/site/), поднимается только
-- при модуле лицензии website и включённом «Сайт включён» (server/site/controller.js).
--
-- ОТЛИЧИЕ ОТ CHILLA (решение владельца 2026-11-23, «Reuse existing profiles»):
-- врачей и услуги на сайт выводит ТОТ ЖЕ показ, что для Symptex и партнёров —
-- users.is_public (shared/doctor-public.js) и services.online_booking
-- (shared/service-public.js). Поэтому website_doctors и website_services — не
-- «вторая публикация», а только добавки сайта: порядок, «на главной», описание
-- услуги. Ни published, ни slug у них нет — слаг строится из id и имени
-- (server/site/content.js).
--
-- website_settings, website_requests и таблицы аналитики НЕ регистрируются в
-- server/db/schema-registry.js (прецедент — telegram_settings): заявки — это
-- персональные данные, путь к ним только через серверные обработчики.

CREATE TABLE website_settings (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  -- JSON: { enabled, default_lang, langs, hero, stats, why_us, contact,
  --         social, seo, legal, analytics, notify }
  settings   TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
INSERT INTO website_settings (id) VALUES (1);

CREATE TABLE website_doctors (
  user_id    INTEGER PRIMARY KEY REFERENCES users(id),
  sort_order INTEGER NOT NULL DEFAULT 0,
  featured   INTEGER NOT NULL DEFAULT 0 CHECK (featured IN (0,1)),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE website_services (
  service_id INTEGER PRIMARY KEY REFERENCES services(id),
  sort_order INTEGER NOT NULL DEFAULT 0,
  featured   INTEGER NOT NULL DEFAULT 0 CHECK (featured IN (0,1)),
  image_path TEXT NOT NULL DEFAULT '',
  -- по языкам: { short_desc, body, preparation } — название берётся из services
  content    TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE website_departments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  department_id INTEGER NOT NULL UNIQUE REFERENCES departments(id),
  published     INTEGER NOT NULL DEFAULT 0 CHECK (published IN (0,1)),
  slug          TEXT NOT NULL UNIQUE,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  image_path    TEXT NOT NULL DEFAULT '',
  content       TEXT NOT NULL DEFAULT '{}',
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE website_testimonials (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  published   INTEGER NOT NULL DEFAULT 0 CHECK (published IN (0,1)),
  sort_order  INTEGER NOT NULL DEFAULT 0,
  author_name TEXT NOT NULL DEFAULT '',
  rating      INTEGER CHECK (rating BETWEEN 1 AND 5),
  content     TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE website_faq (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  published  INTEGER NOT NULL DEFAULT 0 CHECK (published IN (0,1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  content    TEXT NOT NULL DEFAULT '{}',   -- по языкам: { q, a }
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE website_posts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  published    INTEGER NOT NULL DEFAULT 0 CHECK (published IN (0,1)),
  slug         TEXT NOT NULL UNIQUE,
  cover_path   TEXT NOT NULL DEFAULT '',
  content      TEXT NOT NULL DEFAULT '{}',   -- по языкам: { title, excerpt, body }
  published_at TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- Входящие с сайта — неизменяемая запись того, что отправил пациент. Заявка на
-- приём дополнительно заводит карточку CRM (источник 'website'); статус здесь —
-- только разбор входящих.
CREATE TABLE website_requests (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  type           TEXT NOT NULL CHECK (type IN ('appointment','contact','callback')),
  status         TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','in_progress','done','spam')),
  full_name      TEXT NOT NULL,
  phone          TEXT NOT NULL DEFAULT '',
  email          TEXT NOT NULL DEFAULT '',
  message        TEXT NOT NULL DEFAULT '',
  service_id     INTEGER REFERENCES services(id),
  doctor_id      INTEGER REFERENCES users(id),
  department_id  INTEGER REFERENCES departments(id),
  preferred_date TEXT,
  preferred_time TEXT NOT NULL DEFAULT '' CHECK (preferred_time IN ('','morning','afternoon','evening')),
  locale         TEXT NOT NULL DEFAULT '',
  page           TEXT NOT NULL DEFAULT '',
  crm_request_id INTEGER REFERENCES crm_requests(id),
  assigned_to    INTEGER REFERENCES users(id),
  staff_notes    TEXT NOT NULL DEFAULT '',
  ip_hash        TEXT NOT NULL DEFAULT '',   -- сырые IP не храним
  user_agent     TEXT NOT NULL DEFAULT '',
  -- Без FK: сессии вычищаются по сроку хранения, заявка обязана пережить чистку.
  session_id     TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_website_requests_status ON website_requests(status, created_at);
CREATE INDEX idx_website_requests_created ON website_requests(created_at);

-- Аналитика — без персональных данных вообще.
CREATE TABLE website_sessions (
  id            TEXT PRIMARY KEY,
  day           TEXT NOT NULL,
  first_seen    TEXT NOT NULL,
  last_seen     TEXT NOT NULL,
  pageviews     INTEGER NOT NULL DEFAULT 0,
  entry_path    TEXT NOT NULL DEFAULT '',
  referrer_host TEXT NOT NULL DEFAULT '',
  utm_source    TEXT NOT NULL DEFAULT '',
  utm_medium    TEXT NOT NULL DEFAULT '',
  utm_campaign  TEXT NOT NULL DEFAULT '',
  device        TEXT NOT NULL DEFAULT '',
  lang          TEXT NOT NULL DEFAULT '',
  is_returning  INTEGER NOT NULL DEFAULT 0 CHECK (is_returning IN (0,1))
);
CREATE INDEX idx_website_sessions_day ON website_sessions(day);

CREATE TABLE website_pageviews (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES website_sessions(id),
  path       TEXT NOT NULL,
  page_type  TEXT NOT NULL DEFAULT '',
  entity_id  INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_website_pageviews_session ON website_pageviews(session_id);
CREATE INDEX idx_website_pageviews_created ON website_pageviews(created_at);

CREATE TABLE website_stats_daily (
  day    TEXT NOT NULL,
  metric TEXT NOT NULL,
  key    TEXT NOT NULL DEFAULT '',
  value  REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (day, metric, key)
);
