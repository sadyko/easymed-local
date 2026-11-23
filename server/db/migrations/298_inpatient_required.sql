-- INPATIENT_REQUIRED_V1 (2026-11-23) — ЧТО В СТАЦИОНАРЕ ОБЯЗАТЕЛЬНО, РЕШАЕТ КЛИНИКА.
--
-- Владелец: «in the stationary, we have a roadblocks as a unfilled title list,
-- reception doctor filling, and others, we need to make some settings for that
-- so we can switch the setup of the stationary documents lists as a required,
-- not required fields».
--
-- Одна строка настроек: четыре переключателя «что останавливает работу»,
-- обязателен ли титульный лист и какие его поля. Каждое умолчание — то, как
-- программа работала до этой миграции, строка в строку: клиника, которая
-- ничего не трогала, разницы не заметит.
--
-- Настройка — этого здания (как stock_settings и case_doc_types): своё
-- отделение, свои правила; соседям по сети таблицы не ездят.
-- Только CREATE TABLE и ADD COLUMN — пересборок нет (урок 1.1.0).
CREATE TABLE inpatient_settings (
  id                        INTEGER PRIMARY KEY CHECK (id = 1),
  -- Лечащий врач — только после осмотра приёмного врача (или первичного осмотра).
  intake_before_attending   INTEGER NOT NULL DEFAULT 1 CHECK (intake_before_attending IN (0, 1)),
  -- Приёмный врач обязателен при размещении на койке (решает экран медсестры).
  admitting_at_placement    INTEGER NOT NULL DEFAULT 1 CHECK (admitting_at_placement IN (0, 1)),
  -- Первичный осмотр публикуется только с диагнозом (решает экран врача).
  primary_needs_diagnosis   INTEGER NOT NULL DEFAULT 1 CHECK (primary_needs_diagnosis IN (0, 1)),
  -- Заявку на выписку принимают только по опубликованному выписному эпикризу.
  discharge_needs_epicrisis INTEGER NOT NULL DEFAULT 1 CHECK (discharge_needs_epicrisis IN (0, 1)),
  -- Титульный лист — обязательный документ истории болезни.
  title_required            INTEGER NOT NULL DEFAULT 1 CHECK (title_required IN (0, 1)),
  -- Обязательные поля листа — JSON-список ключей (shared/inpatient-required.js TITLE_FIELDS).
  title_required_fields     TEXT    NOT NULL DEFAULT '["height_cm","weight_kg","temp_c","bp_sys","bp_dia","pulse_bpm","pediculosis","sanitation"]',
  updated_at                TEXT,
  updated_by                INTEGER REFERENCES users(id)
);
INSERT INTO inpatient_settings (id) VALUES (1);

-- Кто и когда менял. Обязательность документа пишется сюда же:
-- field = 'doc:<род>:required' / 'doc:<род>:sections'.
CREATE TABLE inpatient_settings_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  user_id   INTEGER REFERENCES users(id),
  field     TEXT    NOT NULL,
  old_value TEXT    NOT NULL DEFAULT '',
  new_value TEXT    NOT NULL DEFAULT ''
);

-- Документ набора: обязательный или «по желанию», и какие его разделы обязательны
-- (JSON-список ключей разделов этого документа).
ALTER TABLE case_doc_types ADD COLUMN required INTEGER NOT NULL DEFAULT 1 CHECK (required IN (0, 1));
ALTER TABLE case_doc_types ADD COLUMN required_sections TEXT NOT NULL DEFAULT '[]';
