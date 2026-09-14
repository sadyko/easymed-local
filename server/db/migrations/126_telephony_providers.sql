-- 126_telephony_providers.sql — TELEPHONY_PROVIDERS_V1: НЕСКОЛЬКО ПРОВАЙДЕРОВ ТЕЛЕФОНИИ.
--
-- Владелец (2026-09-14): «make in the telephony settings section a cards of
-- the companies (now we have binotel with their settings) and we will add
-- another (onlinePBX) … flow should be exactly like that».
--
-- Binotel живёт в telephony_settings (миграция 076) одной строкой, и на неё
-- завязаны опрос, вебхуки и экран. Эту строку НЕ трогаем: она остаётся
-- карточкой Binotel. Все ОСТАЛЬНЫЕ провайдеры — строками этой таблицы:
-- вид, имя, открытые настройки (JSON), секреты (JSON, только сервер),
-- свой интервал опроса и своя «жизнь» (последний опрос, последний звонок,
-- последняя ошибка).
--
-- Звонок помнит, откуда он: провайдер и его строка. У старых звонков
-- провайдер — Binotel по умолчанию, и это правда: других не было.
-- ТОЛЬКО CREATE TABLE / ADD COLUMN.
CREATE TABLE IF NOT EXISTS telephony_providers (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  kind              TEXT NOT NULL CHECK (kind IN ('onlinepbx')),
  name              TEXT NOT NULL,
  enabled           INTEGER NOT NULL DEFAULT 0,
  config            TEXT NOT NULL DEFAULT '{}',   -- открытые настройки: domain, default_extension
  secret            TEXT NOT NULL DEFAULT '{}',   -- auth_key + выданные key_id/key; браузеру не отдаётся
  poll_interval_sec INTEGER NOT NULL DEFAULT 30,
  last_poll_at      TEXT,
  last_call_at      TEXT,
  last_error        TEXT NOT NULL DEFAULT '',
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

ALTER TABLE calls ADD COLUMN provider TEXT NOT NULL DEFAULT 'binotel';
ALTER TABLE calls ADD COLUMN provider_id INTEGER REFERENCES telephony_providers(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS calls_provider_started ON calls (provider_id, started_at);
