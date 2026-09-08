-- 110_admission_title_sheets.sql — TITLE_SHEET_V1: титульный лист истории болезни.
--
-- Владелец: «when request of hospitalization is accepted and patient is
-- admitting to the bed, nurse should collect the title list, with personal
-- information and anthropometric data of the patient, and it goes as a title
-- list when history is collected».
--
-- ─── ПОЧЕМУ СВОЯ ТАБЛИЦА, А НЕ ДВЕНАДЦАТЫЙ ДОКУМЕНТ ───────────────────────
-- Документы истории болезни (admission_reviews, 095/104) — пять текстовых
-- полей врача. Титульный лист — это ЧИСЛА медсестры: рост, вес, температура,
-- давление, пульс. Записать их текстом в `body` значило бы потерять ИМТ,
-- проверку диапазонов и любую возможность спросить «а сколько он весил при
-- поступлении» иначе, чем глазами. Поэтому — свои колонки.
--
-- ─── ЧЕГО ЗДЕСЬ НЕТ: ЛИЧНЫХ ДАННЫХ ─────────────────────────────────────────
-- ФИО, дата рождения, адрес, телефон, группа крови, аллергии живут в
-- `patients` и НЕ КОПИРУЮТСЯ: лист показывает их из карточки и пишет
-- исправления обратно в карточку (rpc/title-sheet.js). Копия разошлась бы с
-- карточкой в первый же день.
--
-- ─── ПОЧЕМУ БЕЗ ИМТ ────────────────────────────────────────────────────────
-- ИМТ — вычисление от роста и веса (public/js/shared/title-sheet-rules.js).
-- Хранимая копия разошлась бы с исходными числами при первой правке веса.
--
-- Только CREATE TABLE. Пересборки нет и быть не должно: миграция 109 (1.1.0)
-- показала, что DROP при включённых внешних ключах роняет запуск клиники.
CREATE TABLE admission_title_sheets (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  admission_id  INTEGER NOT NULL UNIQUE REFERENCES admissions(id),

  referred_from TEXT NOT NULL DEFAULT '',        -- «Кем направлен»

  height_cm     REAL,                            -- 30–250
  weight_kg     REAL,                            -- 1–400
  temp_c        REAL,                            -- 30–45
  bp_sys        INTEGER,                         -- 40–300
  bp_dia        INTEGER,                         -- 20–200, меньше bp_sys
  pulse_bpm     INTEGER,                         -- 20–250

  -- Осмотр на педикулёз и чесотку: '' — не отвечено, none — не выявлено, found — выявлено.
  pediculosis   TEXT NOT NULL DEFAULT '' CHECK (pediculosis IN ('', 'none', 'found')),
  -- Санитарная обработка: '' — не отвечено, full — полная, partial — частичная, none — не проводилась.
  sanitation    TEXT NOT NULL DEFAULT '' CHECK (sanitation IN ('', 'full', 'partial', 'none')),

  note          TEXT NOT NULL DEFAULT '',

  -- Кто и когда ВПЕРВЫЕ заполнил лист целиком. Ставится один раз.
  filled_by     INTEGER REFERENCES users(id),
  filled_at     TEXT,

  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at    TEXT
);
