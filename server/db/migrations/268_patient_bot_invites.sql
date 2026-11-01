-- PATIENT_BOT_INVITE_V1 (2026-11-01) — «ОТПРАВИТЬ ССЫЛКУ НА БОТА» ИЗ СПИСКА ПАЦИЕНТОВ.
--
-- Владелец (снимок списка пациентов): «at the end of patientline add button to
-- send bot link to patient if patient has no bot, if patinet has bot, small
-- telegram logo should be there». Ссылка на пациентский Telegram-бот уходит
-- пациенту SMS через Play Mobile (мигр. 261) — rpc/patient-bot.js.
--
-- Свой журнал, а не sms_messages: у той таблицы kind ограничен CHECK ('test'),
-- и расширить его — пересобрать чужую таблицу. Здесь же — защита от двойного
-- нажатия: одному пациенту не чаще раза в 10 минут (проверяет RPC по этой
-- таблице), чтобы регистратор не отправил три SMS одним «не нажалось».
CREATE TABLE patient_bot_invites (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id  INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  phone       TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('sent', 'failed')),
  error       TEXT NOT NULL DEFAULT '',
  message_id  TEXT NOT NULL DEFAULT '',
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_patient_bot_invites_patient ON patient_bot_invites(patient_id, created_at);
