-- STAFF_ATTENDANCE_V1 (2026-11-27) — EASYMED STAFF, ЭТАП 1: БОТ СОТРУДНИКОВ И
-- ОТМЕТКА ПРИХОДА / УХОДА ПО QR НА ВХОДЕ.
--
-- Владелец (ТЗ «EasyMed Staff», модуль 1): сотрудник сканирует QR у входа,
-- Telegram открывает бота сотрудников, сервер проверяет QR и личность и пишет
-- приход или уход. Кнопки «отметиться» в меню бота НЕТ и быть не должно.
--
-- КАК ЗАЩИЩЕНО (подробно — services/attendance/tokens.js и core.js):
--   * QR на экране у входа меняется каждые rotate_seconds (по умолчанию 20 с):
--     код = HMAC-SHA256(token_secret точки, «точка.окно»). Сервер принимает
--     текущее и предыдущее окно — сфотографированный код живёт не дольше
--     двух окон. Секрет точки не покидает сервер: экран получает готовую
--     картинку, а не секрет.
--   * Экран открывается по ссылке с display_key — отдельным ключом только
--     для показа: украденная ссылка экрана не даёт подделывать коды задним
--     числом и меняется кнопкой «Новая ссылка экрана».
--   * Кто отмечается — решает Telegram (from.id сообщения), а не то, что
--     прислал телефон. Время — часы сервера. Повтор того же кода тем же
--     человеком — отказ (UNIQUE в attendance_scans).
--   * Каждая неудачная или подозрительная попытка — строка attendance_flags.
--
-- staff_bot_settings / staff_bot_state — бот сотрудников, как doctor_bot_*:
--   токен зашифрован ключом data/.telegram-key, смещение getUpdates.
-- staff_telegram_links — чей это Telegram. Подключение — только одноразовым
--   кодом, который выдаёт HR (staff_link_codes, хранится хэш, живёт 15 мин):
--   совпадения телефона для отметки присутствия мало. Отключение — revoked_at,
--   а не удаление: «чей Telegram это был в марте» — вопрос аудита.
-- attendance_locations — точки входа (вход филиала). Не удаляются — гасятся.
-- attendance_scans — отсканированные коды: ждут подтверждения кнопкой (2 мин)
--   и не дают использовать тот же код второй раз.
-- attendance_sessions — смена сотрудника: приход и уход. Открытая смена —
--   out_at IS NULL; одна открытая на сотрудника (уникальный индекс).
--   missing_out = 1 — уход так и не отметили (новый приход закрыл старую смену
--   без ухода). Аннулированная HR смена — voided_at, не удаление.
-- attendance_events — журнал отметок (и правок HR), только добавляется.
-- attendance_flags — отказы и подозрительное: чужой Telegram, просроченный или
--   поддельный код, повтор, не тот филиал, слишком частые сканы.
-- attendance_corrections — правки HR: что было, что стало, кто, почему
--   (причина обязательна, CHECK).
CREATE TABLE staff_bot_settings (
  id                 INTEGER PRIMARY KEY CHECK (id = 1),
  enabled            INTEGER NOT NULL DEFAULT 0,
  bot_token_enc      TEXT NOT NULL DEFAULT '',
  bot_token_hint     TEXT NOT NULL DEFAULT '',
  bot_username       TEXT NOT NULL DEFAULT '',
  bot_id             TEXT NOT NULL DEFAULT '',
  last_check_status  TEXT NOT NULL DEFAULT '',
  last_check_error   TEXT NOT NULL DEFAULT '',
  last_check_at      TEXT,
  grace_minutes      INTEGER NOT NULL DEFAULT 10 CHECK (grace_minutes BETWEEN 0 AND 120),
  updated_at         TEXT,
  updated_by         INTEGER REFERENCES users(id) ON DELETE SET NULL
);
INSERT INTO staff_bot_settings (id) VALUES (1);

CREATE TABLE staff_bot_state (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL DEFAULT '',
  updated_at  TEXT
);

CREATE TABLE staff_telegram_links (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tg_user_id   TEXT NOT NULL CHECK (length(tg_user_id) > 0),
  chat_id      TEXT NOT NULL CHECK (length(chat_id) > 0),
  tg_username  TEXT NOT NULL DEFAULT '',
  lang         TEXT NOT NULL DEFAULT 'ru' CHECK (lang IN ('ru', 'uz')),
  linked_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  revoked_at   TEXT,
  revoked_by   INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX idx_staff_tg_links_user ON staff_telegram_links(user_id) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX idx_staff_tg_links_tg ON staff_telegram_links(tg_user_id) WHERE revoked_at IS NULL;

CREATE TABLE staff_link_codes (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash        TEXT NOT NULL UNIQUE,
  created_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  expires_at       TEXT NOT NULL,
  used_at          TEXT,
  used_tg_user_id  TEXT
);
CREATE INDEX idx_staff_link_codes_user ON staff_link_codes(user_id, used_at);

CREATE TABLE attendance_locations (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  branch_id       INTEGER REFERENCES branches(id) ON DELETE SET NULL,
  name            TEXT NOT NULL CHECK (length(trim(name)) > 0),
  active          INTEGER NOT NULL DEFAULT 1,
  token_secret    TEXT NOT NULL CHECK (length(token_secret) >= 32),
  display_key     TEXT NOT NULL CHECK (length(display_key) >= 24),
  rotate_seconds  INTEGER NOT NULL DEFAULT 20 CHECK (rotate_seconds BETWEEN 10 AND 120),
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE UNIQUE INDEX idx_attendance_locations_display ON attendance_locations(display_key);

CREATE TABLE attendance_scans (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  location_id   INTEGER NOT NULL REFERENCES attendance_locations(id) ON DELETE CASCADE,
  token_window  INTEGER NOT NULL,
  tg_user_id    TEXT NOT NULL,
  user_id       INTEGER REFERENCES users(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('in', 'out')),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  consumed_at   TEXT,
  result        TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX idx_attendance_scans_once ON attendance_scans(location_id, token_window, tg_user_id);
CREATE INDEX idx_attendance_scans_tg ON attendance_scans(tg_user_id, created_at);

CREATE TABLE attendance_sessions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  branch_id        INTEGER REFERENCES branches(id) ON DELETE SET NULL,
  in_location_id   INTEGER REFERENCES attendance_locations(id) ON DELETE SET NULL,
  in_at            TEXT NOT NULL,
  out_location_id  INTEGER REFERENCES attendance_locations(id) ON DELETE SET NULL,
  out_at           TEXT,
  missing_out      INTEGER NOT NULL DEFAULT 0,
  source           TEXT NOT NULL DEFAULT 'qr' CHECK (source IN ('qr', 'correction')),
  voided_at        TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  CHECK (out_at IS NULL OR out_at >= in_at)
);
CREATE UNIQUE INDEX idx_attendance_sessions_open ON attendance_sessions(user_id)
  WHERE out_at IS NULL AND missing_out = 0 AND voided_at IS NULL;
CREATE INDEX idx_attendance_sessions_in ON attendance_sessions(in_at);
CREATE INDEX idx_attendance_sessions_user ON attendance_sessions(user_id, in_at);

CREATE TABLE attendance_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id   INTEGER REFERENCES attendance_sessions(id) ON DELETE SET NULL,
  location_id  INTEGER REFERENCES attendance_locations(id) ON DELETE SET NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('in', 'out', 'correction')),
  at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  source       TEXT NOT NULL DEFAULT 'qr' CHECK (source IN ('qr', 'correction')),
  scan_id      INTEGER REFERENCES attendance_scans(id) ON DELETE SET NULL,
  by_user      INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX idx_attendance_events_user ON attendance_events(user_id, at);

CREATE TABLE attendance_flags (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  kind         TEXT NOT NULL CHECK (kind IN ('unknown_telegram', 'bad_token', 'expired_token', 'replay',
                 'inactive_location', 'branch_not_allowed', 'inactive_employee', 'too_soon',
                 'rate_limited', 'confirm_expired', 'missing_out', 'not_private')),
  tg_user_id   TEXT NOT NULL DEFAULT '',
  user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  location_id  INTEGER REFERENCES attendance_locations(id) ON DELETE SET NULL,
  detail       TEXT NOT NULL DEFAULT '',
  reviewed_at  TEXT,
  reviewed_by  INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX idx_attendance_flags_at ON attendance_flags(at);

CREATE TABLE attendance_corrections (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  INTEGER NOT NULL REFERENCES attendance_sessions(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action      TEXT NOT NULL CHECK (action IN ('create', 'edit', 'void')),
  old_in_at   TEXT,
  old_out_at  TEXT,
  new_in_at   TEXT,
  new_out_at  TEXT,
  reason      TEXT NOT NULL CHECK (length(trim(reason)) >= 3),
  by_user     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_attendance_corrections_session ON attendance_corrections(session_id, id);
