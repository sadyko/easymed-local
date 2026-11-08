-- AI_CHAT_V1 (2026-11-08) — ИИ-помощник в чатах Telegram, Facebook и Instagram
-- (docs/superpowers/specs/2026-11-08-ai-chat-assistant-design.md).
--
-- ai_settings — одна строка: переключатель «ИИ отвечает в чатах» и почему ИИ
-- сейчас не может отвечать (blocked: '' | 'limit' | 'no_module'). enabled_at —
-- с этого момента сообщения ставятся в очередь: история, пришедшая опросом
-- после включения, ИИ не касается.
CREATE TABLE ai_settings (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  enabled     INTEGER NOT NULL DEFAULT 0,
  enabled_at  TEXT,
  updated_by  INTEGER,
  updated_at  TEXT,
  blocked     TEXT NOT NULL DEFAULT '',
  blocked_at  TEXT
);
INSERT INTO ai_settings (id) VALUES (1);

-- Очередь: одна строка на входящее сообщение пациента. channel —
-- 'telegram' | 'meta_dm' | 'meta_comment'; chat_key — telegram chat_id,
-- meta_conversations.id или meta_comments.id; source_id — id входящего
-- сообщения у источника (уникален в канале: одно сообщение — одна задача).
-- status: queued → working → sending → done | handed_off | dropped | merged | failed.
CREATE TABLE ai_chat_jobs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  channel     TEXT NOT NULL,
  chat_key    TEXT NOT NULL,
  source_id   TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'queued',
  attempts    INTEGER NOT NULL DEFAULT 0,
  next_at     TEXT NOT NULL,
  outcome     TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  finished_at TEXT,
  UNIQUE (channel, source_id)
);
CREATE INDEX ai_chat_jobs_queue ON ai_chat_jobs (status, next_at);

-- «Нужен оператор»: чат передан людям. Снимается ответом оператора (guards.js
-- сравнивает flagged_at с его последним сообщением), отдельной кнопки нет.
CREATE TABLE ai_chat_flags (
  channel     TEXT NOT NULL,
  chat_key    TEXT NOT NULL,
  reason      TEXT NOT NULL,
  flagged_at  TEXT NOT NULL,
  PRIMARY KEY (channel, chat_key)
);

-- Сообщения и ответы, отправленные ИИ, видны в истории с пометкой «ИИ».
-- Отметка — колонка by_ai во всех трёх таблицах. У telegram_messages.kind есть
-- CHECK ('text','document','system','broadcast', миграция 062): новое значение
-- 'ai' потребовало бы пересборки таблицы, а ответ ИИ — это обычный текст.
ALTER TABLE telegram_messages ADD COLUMN by_ai INTEGER NOT NULL DEFAULT 0;
ALTER TABLE meta_messages ADD COLUMN by_ai INTEGER NOT NULL DEFAULT 0;
ALTER TABLE meta_comments ADD COLUMN by_ai INTEGER NOT NULL DEFAULT 0;
