-- META_LEADS_V1 (мигр. 249; файл родился как 246, номер заняла удалённая ветка при
-- синхронизации 2026-10-26 — на dev-базе строка schema_migrations переименована рукой)
-- (2026-10-16, владелец: «all the leads coming from meta ads
-- should come to crm») — заявки из рекламы Meta (Lead Ads: форма, которую
-- человек заполняет прямо в Facebook или Instagram) сами попадают в CRM.
--
-- Клиника стоит в локальной сети без публичного адреса, поэтому Meta не может
-- «постучаться» к ней (webhook). Сервер клиники сам опрашивает Graph API раз
-- в несколько минут, пока интеграция включена (server/services/meta/poller.js).
--
-- Две таблицы, только CREATE TABLE — прежние не тронуты:
--   meta_settings — одна строка (id = 1): включено ли, токен ТОЛЬКО шифртекстом
--                   (server/services/api/secret-box.js, как ключи подключений
--                   API), страница, список форм, период опроса, курсор since_ts
--                   и состояние последнего опроса. Таблица НАРОЧНО не заведена
--                   в schema-registry.js: до неё можно добраться только через
--                   RPC, которые токен не отдают (правило telegram_settings).
--   meta_leads    — журнал полученных заявок: leadgen_id Meta уникален, поэтому
--                   одна и та же заявка не создаст двух карточек, сколько бы раз
--                   опрос её ни увидел (повтор окна времени, сбой на полпути).
--                   Ответы формы — персональные данные пациента; они живут в
--                   базе клиники и никуда не уходят.
--
-- crm_request_id — ON DELETE SET NULL: удалённая карточка CRM отвязывает запись
-- журнала, а не стирает её, иначе удалённая заявка вернулась бы следующим опросом.

CREATE TABLE meta_settings (
  id                 INTEGER PRIMARY KEY CHECK (id = 1),
  enabled            INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  token_sealed       TEXT    NOT NULL DEFAULT '',
  token_tail         TEXT    NOT NULL DEFAULT '',
  page_token_sealed  TEXT    NOT NULL DEFAULT '',
  page_id            TEXT    NOT NULL DEFAULT '',
  page_name          TEXT    NOT NULL DEFAULT '',
  token_checked_at   TEXT,
  token_expires_at   TEXT,
  forms_mode         TEXT    NOT NULL DEFAULT 'all' CHECK (forms_mode IN ('all', 'selected')),
  forms_json         TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(forms_json) AND json_type(forms_json) = 'array'),
  poll_minutes       INTEGER NOT NULL DEFAULT 2 CHECK (poll_minutes >= 1),
  since_ts           INTEGER NOT NULL DEFAULT 0,
  last_poll_at       TEXT,
  last_ok_at         TEXT,
  last_error         TEXT    NOT NULL DEFAULT '',
  updated_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_by         INTEGER
);
INSERT INTO meta_settings (id) VALUES (1);

CREATE TABLE meta_leads (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  leadgen_id       TEXT    NOT NULL UNIQUE,
  form_id          TEXT    NOT NULL DEFAULT '',
  form_name        TEXT    NOT NULL DEFAULT '',
  ad_id            TEXT    NOT NULL DEFAULT '',
  ad_name          TEXT    NOT NULL DEFAULT '',
  campaign_id      TEXT    NOT NULL DEFAULT '',
  campaign_name    TEXT    NOT NULL DEFAULT '',
  platform         TEXT    NOT NULL DEFAULT '',
  created_time     TEXT    NOT NULL DEFAULT '',
  field_data_json  TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(field_data_json)),
  full_name        TEXT    NOT NULL DEFAULT '',
  phone            TEXT    NOT NULL DEFAULT '',
  email            TEXT    NOT NULL DEFAULT '',
  crm_request_id   INTEGER REFERENCES crm_requests(id) ON DELETE SET NULL,
  status           TEXT    NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'merged', 'error')),
  error            TEXT    NOT NULL DEFAULT '',
  received_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX meta_leads_received ON meta_leads (received_at);
CREATE INDEX meta_leads_crm ON meta_leads (crm_request_id);
