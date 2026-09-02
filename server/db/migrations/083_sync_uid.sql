-- 083_sync_uid.sql — BRANCH_RECORDS_V1: глобальная личность строки.
--
-- Локальный id — счётчик ВНУТРИ базы: пациент №500 есть в каждом филиале и это
-- разные люди. Пока базы не встречались, это безвредно; в тот момент, когда
-- они встретятся, каждая ссылка «визит → пациент» должна пережить границу.
-- uid переживает, локальный id — нет.
--
-- Почему не переиспользуем branch_sync_map (079): та карта односторонняя и
-- рассчитана на один пишущий узел (главный отдаёт справочник). Здесь пишут все.
--
-- TEXT, а не BLOB: uid попадает в JSON выгрузки, и hex-строка не требует
-- кодирования на каждом шаге.
ALTER TABLE patients        ADD COLUMN uid TEXT;
ALTER TABLE visits          ADD COLUMN uid TEXT;
ALTER TABLE visit_services  ADD COLUMN uid TEXT;
ALTER TABLE lab_results     ADD COLUMN uid TEXT;

-- BRANCH_ORIGIN_V1 — ОТКУДА строка. NULL = заведена здесь; буква = приехала от
-- того узла. Ставится один раз, при ВСТАВКЕ приехавшей записи (records.js), и
-- не меняется, когда сосед потом правит ту же строку: происхождение — не
-- состояние, а факт.
--
-- Почему не буква MRN: MRN говорит, где ЗАВЕДЁН ПАЦИЕНТ, а не где сделана
-- работа. Пациент из «C», пришедший в «B», лечится в B, и его визит — работа B;
-- по MRN лаборатория B не увидела бы собственный анализ. visits.branch_id тоже
-- не годится: до Фазы 1 мастер проставляет туда первый активный филиал.
--
-- Колонка НЕ уезжает соседу (её нет в SHIPPED): у каждого узла своя точка
-- зрения — то, что здесь «из C», у самого C помечено NULL.
ALTER TABLE patients        ADD COLUMN sync_origin TEXT;
ALTER TABLE visits          ADD COLUMN sync_origin TEXT;
ALTER TABLE visit_services  ADD COLUMN sync_origin TEXT;
ALTER TABLE lab_results     ADD COLUMN sync_origin TEXT;

-- Засев для строк, которые уже есть. lower(hex(randomblob(16))) — 128 бит из
-- ГСЧ SQLite: столкновение невероятнее, чем потеря базы.
UPDATE patients       SET uid = lower(hex(randomblob(16))) WHERE uid IS NULL;
UPDATE visits         SET uid = lower(hex(randomblob(16))) WHERE uid IS NULL;
UPDATE visit_services SET uid = lower(hex(randomblob(16))) WHERE uid IS NULL;
UPDATE lab_results    SET uid = lower(hex(randomblob(16))) WHERE uid IS NULL;

-- UNIQUE, а не просто INDEX: приём ищет строку по uid, и два совпадения
-- означали бы, что одна запись приехала дважды под разными локальными id —
-- молча выбрать любую из них хуже, чем упасть.
CREATE UNIQUE INDEX idx_patients_uid       ON patients(uid);
CREATE UNIQUE INDEX idx_visits_uid         ON visits(uid);
CREATE UNIQUE INDEX idx_visit_services_uid ON visit_services(uid);
CREATE UNIQUE INDEX idx_lab_results_uid    ON lab_results(uid);

-- Новые строки получают uid сами: прикладной код о нём знать не обязан, а
-- строка без uid не поедет никуда и обнаружится через недели.
CREATE TRIGGER patients_uid_autogen AFTER INSERT ON patients
  WHEN NEW.uid IS NULL
  BEGIN UPDATE patients SET uid = lower(hex(randomblob(16))) WHERE id = NEW.id; END;
CREATE TRIGGER visits_uid_autogen AFTER INSERT ON visits
  WHEN NEW.uid IS NULL
  BEGIN UPDATE visits SET uid = lower(hex(randomblob(16))) WHERE id = NEW.id; END;
CREATE TRIGGER visit_services_uid_autogen AFTER INSERT ON visit_services
  WHEN NEW.uid IS NULL
  BEGIN UPDATE visit_services SET uid = lower(hex(randomblob(16))) WHERE id = NEW.id; END;
CREATE TRIGGER lab_results_uid_autogen AFTER INSERT ON lab_results
  WHEN NEW.uid IS NULL
  BEGIN UPDATE lab_results SET uid = lower(hex(randomblob(16))) WHERE id = NEW.id; END;
