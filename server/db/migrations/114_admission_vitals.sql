-- 114_admission_vitals.sql — VITALS_NEWS_V1: измерения показателей в стационаре.
--
-- Владелец (2026-09-08): «dashboard like this» — панель показателей с баллом
-- NEWS, динамикой и плитками (температура, АД, пульс, ЧДД, SpO₂).
--
-- До этого единственными измерениями были три числа на титульном листе —
-- при поступлении. Наблюдение в динамике — это РЯД измерений, каждое со
-- своим временем и подписью того, кто измерил; поэтому отдельная таблица, а
-- не ещё колонки у госпитализации.
--
-- Любой показатель может быть NULL: медсестра записывает то, что измерила
-- (пульс и температуру у поста, SpO₂ — когда есть пульсоксиметр). Балл NEWS
-- считается по тому, что есть, и НЕ хранится: шкала одна (shared/news2.js), и
-- хранить производное значит однажды показать два разных балла за одно
-- измерение.
--
-- consciousness — ACVPU из NEWS2: alert (ясное), confused (спутанное), voice
-- (реагирует на голос), pain (на боль), unresponsive (без сознания).
-- on_oxygen — дополнительный кислород (2 очка NEWS2).
--
-- Только CREATE TABLE — пересборок нет (урок 1.1.0).
CREATE TABLE IF NOT EXISTS admission_vitals (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  admission_id  INTEGER NOT NULL REFERENCES admissions(id),
  measured_at   TEXT    NOT NULL,
  temp_c        REAL,
  bp_sys        INTEGER,
  bp_dia        INTEGER,
  pulse_bpm     INTEGER,
  resp_rate     INTEGER,
  spo2          INTEGER,
  on_oxygen     INTEGER NOT NULL DEFAULT 0,
  consciousness TEXT    NOT NULL DEFAULT 'alert'
                CHECK (consciousness IN ('alert','confused','voice','pain','unresponsive')),
  note          TEXT    NOT NULL DEFAULT '',
  measured_by   INTEGER REFERENCES users(id),
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- Ряд одной госпитализации читается по времени — обзор берёт последние.
CREATE INDEX IF NOT EXISTS idx_admission_vitals_adm_at ON admission_vitals (admission_id, measured_at);
