-- PATIENT_MERGE_BRANCHES_V1 (2026-09-27) — ОБЪЕДИНЕНИЕ КАРТ ПО ЗДАНИЯМ.
--
-- Решение владельца: «объединять и по зданиям тоже». До этой миграции карту,
-- уже переданную в другое здание, объединять было нельзя: у соседа лежат строки
-- дубля, которые между зданиями не ездят (баланс, госпитализации, давление,
-- диагнозы, документы, опекуны, журнал карты), и приехавшее надгробие дубля
-- там либо упало бы на внешнем ключе (sync_refused), либо стёрло бы их.
--
-- Теперь объединение — САМОСТОЯТЕЛЬНОЕ СОБЫТИЕ, строка этой таблицы: «карта
-- drop_uid слита в карту keep_uid». Она едет журналом, как пациент, и КАЖДОЕ
-- здание, получив её, само переносит на keep всё, что у него есть на drop
-- (тот же перечень MERGE_TABLES, что у объединения на месте), и само удаляет
-- drop. Надгробие дубля, пришедшее следом, при известном событии ничего не
-- удаляет (records.js), а строки, приехавшие позже со ссылкой на drop,
-- садятся на keep (переадресация по этой таблице).
--
-- Карты называются по uid (083) — единственному имени, одинаковому во всех
-- зданиях; локальный id у каждого свой.
--
-- События не удаляются и не правятся: объединение необратимо, а переадресация
-- нужна, пока где-то в сети может жить строка со ссылкой на drop.
CREATE TABLE patient_merges (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  uid         TEXT,
  keep_uid    TEXT NOT NULL,
  drop_uid    TEXT NOT NULL,
  merged_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  sync_origin TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  CHECK (keep_uid <> drop_uid)
);
CREATE UNIQUE INDEX idx_patient_merges_uid ON patient_merges(uid);
CREATE INDEX idx_patient_merges_drop ON patient_merges(drop_uid);

CREATE TRIGGER patient_merges_uid_autogen AFTER INSERT ON patient_merges
  WHEN NEW.uid IS NULL
  BEGIN UPDATE patient_merges SET uid = lower(hex(randomblob(16))) WHERE id = NEW.id; END;

-- Журнал — по образцу 084. Вставка с uid (приём соседа) пишется сразу; вставка
-- без uid — через autogen: его UPDATE (OLD.uid IS NULL) даёт '*'.
CREATE TRIGGER patient_merges_journal_ins AFTER INSERT ON patient_merges
  BEGIN INSERT INTO sync_journal (tbl, uid, op, cols)
        SELECT 'patient_merges', uid, 'put', '*' FROM patient_merges
         WHERE id = NEW.id AND uid IS NOT NULL; END;

CREATE TRIGGER patient_merges_journal_upd AFTER UPDATE ON patient_merges
  BEGIN
    INSERT INTO sync_journal (tbl, uid, op, cols)
    SELECT 'patient_merges', uid, 'put', cols FROM (
      SELECT r.uid AS uid, CASE WHEN OLD.uid IS NULL THEN '*' ELSE rtrim(
             CASE WHEN NEW.keep_uid IS NOT OLD.keep_uid THEN 'keep_uid,' ELSE '' END ||
             CASE WHEN NEW.drop_uid IS NOT OLD.drop_uid THEN 'drop_uid,' ELSE '' END ||
             CASE WHEN NEW.merged_at IS NOT OLD.merged_at THEN 'merged_at,' ELSE '' END, ',') END AS cols
        FROM patient_merges r WHERE r.id = NEW.id AND r.uid IS NOT NULL
    ) WHERE cols <> '';
    INSERT INTO sync_authored (tbl, uid, col, at)
    SELECT 'patient_merges', r.uid, v.col, strftime('%Y-%m-%dT%H:%M:%fZ','now')
      FROM patient_merges r
      JOIN (
            SELECT 'keep_uid' AS col WHERE NEW.keep_uid IS NOT OLD.keep_uid
            UNION ALL SELECT 'drop_uid' WHERE NEW.drop_uid IS NOT OLD.drop_uid
            UNION ALL SELECT 'merged_at' WHERE NEW.merged_at IS NOT OLD.merged_at
           ) v
     WHERE r.id = NEW.id AND r.uid IS NOT NULL AND OLD.uid IS NOT NULL
    ON CONFLICT(tbl, uid, col) DO UPDATE SET at = excluded.at;
  END;

CREATE TRIGGER patient_merges_journal_del AFTER DELETE ON patient_merges
  WHEN OLD.uid IS NOT NULL
  BEGIN
    INSERT INTO sync_journal (tbl, uid, op) VALUES ('patient_merges', OLD.uid, 'del');
    INSERT OR REPLACE INTO sync_tombstones (tbl, uid) VALUES ('patient_merges', OLD.uid);
    DELETE FROM sync_authored WHERE tbl = 'patient_merges' AND uid = OLD.uid;
  END;
