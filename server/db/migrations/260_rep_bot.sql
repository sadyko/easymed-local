-- REP_BOT_V1 (2026-10-30) — TELEGRAM-БОТ ДЛЯ МЕДПРЕДСТАВИТЕЛЕЙ: ПРЕДСТАВИТЕЛЬ
-- ЗАВОДИТ ВНЕШНЕГО ВРАЧА ИЗ TELEGRAM.
--
-- Владелец (снимок вкладки «Врачи-источники»): «make it possible that med
-- representative adds doctor from telegram bot, make seperate bot for only med
-- reps». Представитель работает «в полях» — у поликлиник, не у компьютера
-- клиники; врача, с которым только что договорился, он заводит с телефона.
--
-- Это ТРЕТИЙ бот: не пациентский (060) и не бот врачей-источников (253) — у
-- него свои собеседники (сотрудники клиники) и свой смысл (бот ПИШЕТ в
-- справочник). Поэтому свои настройки, свои связки, своё смещение getUpdates.
-- Общее с двумя другими — клиент Bot API и ключ шифрования токена.
--
-- rep_bot_settings — одна строка id = 1, как doctor_bot_settings; в реестр
-- /api/db не входит (читает и пишет только rpc/rep-bot.js, администратору).
CREATE TABLE rep_bot_settings (
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
INSERT INTO rep_bot_settings (id) VALUES (1);

-- Связка «чат Telegram ↔ сотрудник-представитель». Представитель присылает
-- свой номер кнопкой; номер ищется среди ДЕЙСТВУЮЩИХ сотрудников с ролью
-- «Медпредставитель» (users.phone, ключ phoneKey — те же 9 цифр, что в CRM).
-- С самого начала — с подтверждением администратора (урок FIX_318_V1 M2 бота
-- врачей): этот бот не читает, а ЗАПИСЫВАЕТ в справочник, и подтверждение
-- администратора — единственное, что даёт чату Telegram право заводить врачей.
CREATE TABLE rep_bot_links (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_id       TEXT NOT NULL,
  phone         TEXT NOT NULL,
  tg_user_id    TEXT NOT NULL DEFAULT '',
  tg_username   TEXT NOT NULL DEFAULT '',
  tg_name       TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'rejected')),
  linked_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  last_seen_at  TEXT,
  confirmed_at  TEXT,
  confirmed_by  INTEGER REFERENCES users(id),
  revoked_at    TEXT,
  revoked_by    INTEGER REFERENCES users(id)
);
CREATE INDEX idx_rep_bot_links_user ON rep_bot_links(user_id);
CREATE INDEX idx_rep_bot_links_chat ON rep_bot_links(chat_id);

-- Смещение getUpdates — своё, не telegram_state и не doctor_bot_state.
CREATE TABLE rep_bot_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- Недописанная анкета врача: один чат — одна анкета. step — какой вопрос
-- задан последним, draft — JSON уже введённого. Строка живёт от «Добавить
-- врача» до «Сохранить» или «Отмена»; в памяти процесса анкету не держим —
-- перезапуск сервера посреди анкеты не должен её терять.
CREATE TABLE rep_bot_drafts (
  chat_id    TEXT PRIMARY KEY,
  link_id    INTEGER NOT NULL REFERENCES rep_bot_links(id) ON DELETE CASCADE,
  step       TEXT NOT NULL,
  draft      TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- Кто и когда завёл врача через бота: список «Добавлены через бота» на
-- вкладке администратора. У referral_sources нет ни created_by, ни created_at,
-- а добавлять их туда ради одного канала — менять общую таблицу справочника.
CREATE TABLE rep_bot_additions (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  referral_source_id INTEGER NOT NULL REFERENCES referral_sources(id) ON DELETE CASCADE,
  user_id            INTEGER REFERENCES users(id) ON DELETE SET NULL,
  link_id            INTEGER REFERENCES rep_bot_links(id) ON DELETE SET NULL,
  chat_id            TEXT NOT NULL,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_rep_bot_additions_created ON rep_bot_additions(created_at);

-- Сотрудника уволили (is_active = 0), сменили ему роль или номер по цифрам
-- (последние 9 — ключ номера CRM) — открытые связки сразу отозваны. Та же
-- схема, что триггер врачей мигр. 257; это вторая линия: диалог бота и сам
-- перепроверяет сотрудника перед каждым действием. Включили обратно — связка
-- не воскресает: представитель присылает номер снова, администратор
-- подтверждает.
CREATE TRIGGER rep_bot_links_user_changed
AFTER UPDATE OF is_active, phone, custom_role_code ON users
FOR EACH ROW WHEN NEW.is_active = 0
               OR COALESCE(NEW.phone, '') <> COALESCE(OLD.phone, '')
               OR COALESCE(NEW.custom_role_code, '') <> COALESCE(OLD.custom_role_code, '')
BEGIN
  UPDATE rep_bot_links
     SET revoked_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
   WHERE user_id = NEW.id
     AND revoked_at IS NULL
     AND (NEW.is_active = 0
          OR COALESCE(NEW.custom_role_code, '') <> COALESCE(OLD.custom_role_code, '')
          OR substr(replace(replace(replace(replace(replace(replace(replace(COALESCE(NEW.phone, ''),
                    ' ', ''), '+', ''), '-', ''), '(', ''), ')', ''), '.', ''), char(160), ''), -9)
             <> substr(replace(replace(replace(replace(replace(replace(replace(COALESCE(phone, ''),
                    ' ', ''), '+', ''), '-', ''), '(', ''), ')', ''), '.', ''), char(160), ''), -9));
END;
