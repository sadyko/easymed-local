-- DAILY_REPORT_BOT_V1 (2026-11-13) — «ОТЧЁТ В TELEGRAM» ДЛЯ СОВЕТА ДИРЕКТОРОВ.
--
-- Владелец: «I will create new telegram bot that pushes daily report to group of
-- board of directors, make setting block as follow that I will put token and
-- choose the time when it has to push message and every day to that group my bot
-- pushes report about cashier, types of payment, CRM and so on».
--
-- Свой бот, а не пациентский: тот принимает сообщения пациентов (getUpdates), и
-- вторая программа на том же токене отбирала бы у него обновления. Одна строка
-- настроек (id = 1), как у ботов врачей и медпредставителей; токен — шифртекстом
-- тем же ключом data/.telegram-key (services/telegram/crypto.js).
--
-- chat_id      — группа совета директоров (у групп номер отрицательный, -100…).
-- send_time    — местное время клиники 'HH:MM', когда слать.
-- period       — 'today' (вечерний отчёт за прошедший день) или 'yesterday'
--                (утренний — за вчера).
-- sections     — JSON-список включённых блоков отчёта; '[]' — все.
-- last_sent_day — местная дата, за которую отчёт УЖЕ ушёл по расписанию: второй
--                раз в тот же день не шлём (перезапуск сервера, второй процесс).
-- last_attempt_at — последняя попытка: при сбое следующая — не раньше чем через
--                10 минут, а не каждую минуту.
CREATE TABLE daily_report_settings (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  enabled         INTEGER NOT NULL DEFAULT 0,
  bot_token_enc   TEXT NOT NULL DEFAULT '',
  bot_token_hint  TEXT NOT NULL DEFAULT '',
  bot_username    TEXT NOT NULL DEFAULT '',
  bot_id          TEXT NOT NULL DEFAULT '',
  chat_id         TEXT NOT NULL DEFAULT '',
  chat_title      TEXT NOT NULL DEFAULT '',
  send_time       TEXT NOT NULL DEFAULT '21:00' CHECK (send_time GLOB '[0-2][0-9]:[0-5][0-9]'),
  period          TEXT NOT NULL DEFAULT 'today' CHECK (period IN ('today', 'yesterday')),
  sections        TEXT NOT NULL DEFAULT '[]',
  last_sent_day   TEXT,
  last_sent_at    TEXT,
  last_attempt_at TEXT,
  last_error      TEXT NOT NULL DEFAULT '',
  updated_at      TEXT,
  updated_by      INTEGER REFERENCES users(id) ON DELETE SET NULL
);
INSERT INTO daily_report_settings (id) VALUES (1);
