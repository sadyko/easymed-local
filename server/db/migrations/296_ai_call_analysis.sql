-- AI_CALLS_V1 (2026-11-18) — ИИ разбирает записи звонков.
--
-- Владелец: функции ИИ «Meta answering, analyzing call record and so on»; на вопрос,
-- что должно получиться, — все четыре: краткое содержание в карточке звонка, оценка
-- оператора, заявка/задача в CRM, если пациент хотел записаться и не записался, и
-- полная расшифровка. Какие звонки — «все отвеченные», автоматически.
--
-- Одна строка на звонок (call_id). Очередь — здесь же: status + next_at. Запись у
-- станции готовится до 10 минут, поэтому next_at — конец разговора плюс две минуты,
-- а «ещё готовится» откладывает строку, а не роняет её.
--
-- scores_json — пять оценок 0..2 (приветствие, выяснил потребность, предложил запись,
-- вежливость, завершение); score — их сумма в процентах (0..100), по нему считается
-- средняя оценка оператора. operator_ext — внутренний номер звонка на момент разбора:
-- сотрудника ищем по нему (users.pbx_extension), как журнал звонков.
--
-- ai_settings.calls_since — когда функцию включили: разбираются звонки ПОСЛЕ этого,
-- 23 тысячи старых звонков клиники не отправляются в OpenAI разом.
CREATE TABLE ai_call_analysis (
  call_id        INTEGER PRIMARY KEY REFERENCES calls(id) ON DELETE CASCADE,
  status         TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'working', 'done', 'failed', 'skipped')),
  reason         TEXT NOT NULL DEFAULT '',
  attempts       INTEGER NOT NULL DEFAULT 0,
  next_at        TEXT NOT NULL,
  transcript     TEXT NOT NULL DEFAULT '',
  summary        TEXT NOT NULL DEFAULT '',
  caller_wanted  TEXT NOT NULL DEFAULT '',
  wants_booking  INTEGER NOT NULL DEFAULT 0,
  booked         INTEGER NOT NULL DEFAULT 0,
  score          INTEGER,
  scores_json    TEXT NOT NULL DEFAULT '{}',
  feedback       TEXT NOT NULL DEFAULT '',
  operator_ext   TEXT NOT NULL DEFAULT '',
  crm_request_id INTEGER,
  crm_task_id    INTEGER,
  cost_micro_usd INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  finished_at    TEXT
);
CREATE INDEX idx_ai_call_analysis_queue ON ai_call_analysis(status, next_at);

ALTER TABLE ai_settings ADD COLUMN calls_since TEXT;
