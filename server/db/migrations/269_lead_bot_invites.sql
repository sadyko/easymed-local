-- PATIENT_BOT_INVITE_V1 (2026-11-01) — «ССЫЛКА НА БОТ» И В КАРТОЧКЕ ЗАЯВКИ CRM.
--
-- Владелец (снимок карточки заявки): «put to the lead card too, telegram bot
-- button link». У заявки пациента в базе может ещё не быть, поэтому ссылка
-- уходит по НОМЕРУ (rpc/patient-bot.js phone_bot_invite), а журнал — свой:
-- patient_bot_invites (мигр. 268) требует patient_id. Защита от двойного
-- нажатия (раз в 10 минут) смотрит номер в ОБОИХ журналах: человек, который
-- одновременно и заявка, и пациент, не получит два SMS подряд.
CREATE TABLE lead_bot_invites (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id     INTEGER,
  phone       TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('sent', 'failed')),
  error       TEXT NOT NULL DEFAULT '',
  message_id  TEXT NOT NULL DEFAULT '',
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_lead_bot_invites_phone ON lead_bot_invites(phone, created_at);
