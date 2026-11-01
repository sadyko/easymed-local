-- SMS_INFORM_V1 (мигр. 261, 2026-10-30, владелец: «in commerce build SMS
-- informing tool integration», провайдер — «Play Mobile») — SMS пациентам
-- через SMS-Broker API Play Mobile (playmobile.uz).
--
-- Сеть нужна только в момент отправки: сервер клиники сам идёт к адресу,
-- который Play Mobile выдал клинике (у каждого клиента свой), — входящих
-- соединений нет, как у опроса Meta.
--
-- Две таблицы, только CREATE TABLE — прежние не тронуты:
--   sms_settings — одна строка (id = 1): включено ли, адрес, логин, пароль
--                  ТОЛЬКО шифртекстом (server/services/api/secret-box.js, как
--                  токен Meta) и подпись отправителя (originator). Таблица
--                  НАРОЧНО не заведена в schema-registry.js: до неё можно
--                  добраться только через RPC, которые пароль не отдают.
--   sms_messages — журнал отправленного: кому, что, чем кончилось. message_id
--                  — наш идентификатор сообщения у Play Mobile (поле
--                  «message-id»), уникален, чтобы отчёт о доставке нашёл строку.
--                  Текст и номер — персональные данные пациента; они живут в
--                  базе клиники и уходят только к Play Mobile.

CREATE TABLE sms_settings (
  id               INTEGER PRIMARY KEY CHECK (id = 1),
  enabled          INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  base_url         TEXT    NOT NULL DEFAULT '',
  login            TEXT    NOT NULL DEFAULT '',
  password_sealed  TEXT    NOT NULL DEFAULT '',
  password_tail    TEXT    NOT NULL DEFAULT '',
  originator       TEXT    NOT NULL DEFAULT '',
  updated_at       TEXT,
  updated_by       INTEGER REFERENCES users(id) ON DELETE SET NULL
);
INSERT INTO sms_settings (id) VALUES (1);

CREATE TABLE sms_messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id   TEXT    NOT NULL UNIQUE,
  phone        TEXT    NOT NULL,
  text         TEXT    NOT NULL,
  kind         TEXT    NOT NULL DEFAULT 'test' CHECK (kind IN ('test')),
  status       TEXT    NOT NULL CHECK (status IN ('sent', 'failed')),
  error        TEXT    NOT NULL DEFAULT '',
  http_status  INTEGER,
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX sms_messages_created ON sms_messages (created_at DESC);
