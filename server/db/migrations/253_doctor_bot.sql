-- REFERRALS_CRM_V1 (2026-10-26) — Telegram-бот для врачей-источников (вкладка
-- «Реферирование → Telegram-бот»; docs/specs/2026-10-26-referrals-crm-design.md).
--
-- Снимок владельца: «Бот для врачей-источников» — токен, выключатель, «Это
-- должен быть ДРУГОЙ бот, не пациентский», «Как подключиться врачу» (номер
-- кнопкой, должен совпасть с телефоном во вкладке «Врачи-источники»), а дальше
-- бот пишет врачу, когда направленный им пациент пришёл: ФИО и список услуг
-- без цен, один раз на визит, через 2 минуты после последней добавленной услуги.
--
-- Это ВТОРОЙ бот, не пациентский: у него свои настройки, свои связки, своё
-- смещение getUpdates и свой журнал уведомлений. Пациентский бот (060) ни
-- одной строкой не задет — у него другой токен и другие собеседники. Общее —
-- только клиент Bot API и ключ шифрования токена (data/.telegram-key).
--
-- doctor_bot_settings — одна строка id = 1, как telegram_settings: токен
-- зашифрован, в реестр /api/db таблица нарочно не входит (читает и пишет только
-- rpc/doctor-bot.js, администратору).
CREATE TABLE doctor_bot_settings (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  enabled           INTEGER NOT NULL DEFAULT 0,
  bot_token_enc     TEXT NOT NULL DEFAULT '',
  bot_token_hint    TEXT NOT NULL DEFAULT '',
  bot_username      TEXT NOT NULL DEFAULT '',
  bot_id            TEXT NOT NULL DEFAULT '',
  last_check_status TEXT NOT NULL DEFAULT '',
  last_check_error  TEXT NOT NULL DEFAULT '',
  last_check_at     TEXT,
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_by        INTEGER REFERENCES users(id)
);
INSERT INTO doctor_bot_settings (id) VALUES (1);

-- Связка «чат Telegram ↔ врач-источник». Врач присылает номер кнопкой; номер
-- ищется среди внешних активных источников по ключу номера (phoneKey из
-- crm-phone-match.js — те же 9 цифр, что сравнивает CRM). Прежняя связка того
-- же врача или того же чата отзывается; строка остаётся ради истории.
CREATE TABLE doctor_bot_links (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  referral_source_id INTEGER NOT NULL REFERENCES referral_sources(id) ON DELETE CASCADE,
  chat_id            TEXT NOT NULL,
  phone              TEXT NOT NULL,
  tg_user_id         TEXT NOT NULL DEFAULT '',
  tg_username        TEXT NOT NULL DEFAULT '',
  tg_name            TEXT NOT NULL DEFAULT '',
  linked_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  last_seen_at       TEXT,
  revoked_at         TEXT,
  revoked_by         INTEGER REFERENCES users(id)
);
CREATE INDEX idx_doctor_bot_links_source ON doctor_bot_links(referral_source_id);
CREATE INDEX idx_doctor_bot_links_chat ON doctor_bot_links(chat_id);

-- Смещение getUpdates и прочие курсоры поллера — своё, не telegram_state.
CREATE TABLE doctor_bot_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- Один визит — одно уведомление (UNIQUE по visit_id): это и защита от
-- повтора, и плитка «Уведомлений за 30 дней». viewed_at ставит нажатие кнопки
-- «Получил» под сообщением — у Telegram нет отметок о прочтении, и плитка
-- «Из них просмотрено» честно считает нажатия, а не прочтения.
CREATE TABLE doctor_bot_notifications (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  visit_id           INTEGER NOT NULL UNIQUE REFERENCES visits(id) ON DELETE CASCADE,
  referral_source_id INTEGER NOT NULL REFERENCES referral_sources(id) ON DELETE CASCADE,
  link_id            INTEGER REFERENCES doctor_bot_links(id) ON DELETE SET NULL,
  chat_id            TEXT NOT NULL,
  message_id         TEXT NOT NULL DEFAULT '',
  text               TEXT NOT NULL DEFAULT '',
  sent_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  viewed_at          TEXT
);
CREATE INDEX idx_doctor_bot_notifications_source ON doctor_bot_notifications(referral_source_id, sent_at);
