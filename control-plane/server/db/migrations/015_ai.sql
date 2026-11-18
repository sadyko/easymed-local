-- AI_CHAT_V1 (2026-11-08) — ИИ-помощник клиник: расход по клинике и месяцу.
-- ТЕКСТА СООБЩЕНИЙ ЗДЕСЬ НЕТ И НЕ БУДЕТ: только числа (запросы, токены, деньги
-- в микродолларах). Лимит месяца — у клиники, по умолчанию 20 USD.
CREATE TABLE ai_usage (
  clinic_id       TEXT NOT NULL REFERENCES clinics(clinic_id) ON DELETE CASCADE,
  month           TEXT NOT NULL,             -- 'YYYY-MM' (UTC)
  requests        INTEGER NOT NULL DEFAULT 0,
  input_tokens    INTEGER NOT NULL DEFAULT 0,
  output_tokens   INTEGER NOT NULL DEFAULT 0,
  cost_micro_usd  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (clinic_id, month)
);
ALTER TABLE clinics ADD COLUMN ai_monthly_limit_usd REAL NOT NULL DEFAULT 20;
