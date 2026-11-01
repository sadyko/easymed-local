-- SMS_PUSH_V1 (мигр. 262, 2026-10-30, владелец: «build such push place in
-- there, push should have telegram push, sms push») — SMS-рассылка пациентам
-- из «Коммерческих инструментов», рядом с рассылкой в Telegram.
--
-- Устроена как telegram_broadcasts (мигр. 061): строка рассылки — что, кому
-- по каким условиям, сколько ушло; строка получателя — один номер, свой
-- message-id у Play Mobile и чем кончилось. Отдельной миграцией, а не правкой
-- 261: та уже могла пройти на базе разработки.
--
-- Один номер — одно SMS: у нескольких карт одного телефона (мама и дети)
-- сообщение не дублируется (UNIQUE broadcast_id + phone).

CREATE TABLE sms_broadcasts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  text           TEXT    NOT NULL,
  filters        TEXT    NOT NULL DEFAULT '{}',
  audience_count INTEGER NOT NULL DEFAULT 0,
  sent_count     INTEGER NOT NULL DEFAULT 0,
  failed_count   INTEGER NOT NULL DEFAULT 0,
  status         TEXT    NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'failed')),
  created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  finished_at    TEXT
);

CREATE TABLE sms_broadcast_targets (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  broadcast_id INTEGER NOT NULL REFERENCES sms_broadcasts(id) ON DELETE CASCADE,
  patient_id   INTEGER REFERENCES patients(id) ON DELETE SET NULL,
  phone        TEXT    NOT NULL,
  message_id   TEXT    NOT NULL UNIQUE,
  status       TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  error        TEXT    NOT NULL DEFAULT '',
  sent_at      TEXT
);
CREATE INDEX sms_broadcast_targets_bc ON sms_broadcast_targets (broadcast_id);
CREATE UNIQUE INDEX sms_broadcast_targets_once ON sms_broadcast_targets (broadcast_id, phone);
