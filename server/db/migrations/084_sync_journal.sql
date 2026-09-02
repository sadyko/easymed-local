-- 084_sync_journal.sql — BRANCH_RECORDS_V1: что изменилось и когда.
--
-- Пишется ТРИГГЕРАМИ, а не прикладным кодом. Это не стилистика: путей, которыми
-- строка меняется, в этом проекте десятки (RPC, импорт, ручные правки), и
-- дописать журнал в каждый — значит однажды забыть. Триггер обойти нельзя.
--
-- Побочная выгода, которую стоит назвать вслух: у большинства этих таблиц не
-- было аудиторского следа вообще.
--
-- ВНИМАНИЕ:
--  (a) Любой массовый UPDATE этих четырёх таблиц теперь СЕТЕВОЕ СОБЫТИЕ —
--      каждая тронутая строка целиком уедет соседям. Ограничивайте WHERE
--      (например, WHERE phone <> trim(phone)), а не «поправить всех разом»;
--      для служебной правки без сетевого трафика — временно снимайте
--      журнальные триггеры вокруг неё, а затем создавайте их заново.
--  (b) Никогда не удаляйте из этих таблиц с foreign_keys = OFF: само удаление
--      зажурналится, а осиротевшие дети — нет, и на приёме их никто не удалит.
--
-- Эта миграция сознательно НЕ досоздаёт журнал задним числом для уже
-- существующих строк: холодного соседа (нет строки в sync_peers) сеет из
-- самих таблиц отправитель (Задача 4) — бэкфилл журнала добавлял бы ~1 запись
-- на КАЖДУЮ уже существующую строку НАВСЕГДА, в каждой клинике.
CREATE TABLE sync_journal (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,  -- локальный порядок отдачи
  tbl        TEXT NOT NULL,
  uid        TEXT NOT NULL,
  op         TEXT NOT NULL CHECK (op IN ('put', 'del')),
  at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))  -- время правки; из него отправитель чеканит метку HLC
);

-- Хвост читают по seq — это alias rowid'а (INTEGER PRIMARY KEY AUTOINCREMENT),
-- отдельный индекс по нему не нужен: то же дерево. Сжатие перед отправкой —
-- по (tbl, uid): у строки, изменённой сто раз, отдавать надо последнее
-- состояние, а не сто записей.
CREATE INDEX idx_sync_journal_row ON sync_journal(tbl, uid);

-- ВСТАВКА ЧИТАЕТ СТРОКУ, А НЕ NEW. В AFTER INSERT триггере NEW.uid — значение,
-- КАК ВСТАВИЛИ: NULL, потому что приложение uid не задаёт. Триггер
-- *_uid_autogen (083) чинит СТРОКУ, но соседний AFTER INSERT триггер этого
-- UPDATE в своём NEW не увидит ни при каком порядке срабатывания, а порядок
-- AFTER-триггеров SQLite не определяет вовсе (на деле — обратный порядку
-- создания, и patients_mrn_autogen в этом репозитории пересоздавали уже
-- дважды: 034, 080). Записать NEW.uid значило бы NOT NULL constraint failed на
-- КАЖДОЙ регистрации пациента (проверено ревью Задачи 1). Поэтому — SELECT из
-- самой таблицы, и только если uid уже есть; если нет, строку зажурналит
-- UPDATE uid-триггера через *_journal_upd мгновением позже. Один INSERT даёт
-- ДВЕ записи журнала — это нормально, buildBatch уплотняет по (tbl, uid).
--
-- ТО ЖЕ ПРАВИЛО ДЛЯ UPDATE. patients_mrn_autogen тоже делает UPDATE строки из
-- своего AFTER INSERT; сработай он РАНЬШЕ uid-триггера — *_journal_upd с
-- NEW.uid записал бы NULL и уронил регистрацию. Проверено в обоих порядках:
-- с SELECT из таблицы — зелено, с NEW.uid — падает. Порядок, напомню, не
-- определён и в этом репозитории уже менялся. *_journal_del получает
-- WHEN OLD.uid IS NOT NULL — достижимого NULL там не построить, это страховка.
--
-- op='put', а не 'insert'/'update': принимающей стороне разница не нужна —
-- у неё этой строки либо нет (создаст), либо есть (сольёт). Две операции
-- вместо трёх убирают целый класс вопросов «а что если insert приехал после
-- update».
CREATE TRIGGER patients_journal_ins AFTER INSERT ON patients
  BEGIN INSERT INTO sync_journal (tbl, uid, op)
        SELECT 'patients', uid, 'put' FROM patients
         WHERE id = NEW.id AND uid IS NOT NULL; END;
CREATE TRIGGER patients_journal_upd AFTER UPDATE ON patients
  BEGIN INSERT INTO sync_journal (tbl, uid, op)
        SELECT 'patients', uid, 'put' FROM patients
         WHERE id = NEW.id AND uid IS NOT NULL; END;
CREATE TRIGGER patients_journal_del AFTER DELETE ON patients
  WHEN OLD.uid IS NOT NULL
  BEGIN INSERT INTO sync_journal (tbl, uid, op) VALUES ('patients', OLD.uid, 'del'); END;

CREATE TRIGGER visits_journal_ins AFTER INSERT ON visits
  BEGIN INSERT INTO sync_journal (tbl, uid, op)
        SELECT 'visits', uid, 'put' FROM visits
         WHERE id = NEW.id AND uid IS NOT NULL; END;
CREATE TRIGGER visits_journal_upd AFTER UPDATE ON visits
  BEGIN INSERT INTO sync_journal (tbl, uid, op)
        SELECT 'visits', uid, 'put' FROM visits
         WHERE id = NEW.id AND uid IS NOT NULL; END;
CREATE TRIGGER visits_journal_del AFTER DELETE ON visits
  WHEN OLD.uid IS NOT NULL
  BEGIN INSERT INTO sync_journal (tbl, uid, op) VALUES ('visits', OLD.uid, 'del'); END;

CREATE TRIGGER visit_services_journal_ins AFTER INSERT ON visit_services
  BEGIN INSERT INTO sync_journal (tbl, uid, op)
        SELECT 'visit_services', uid, 'put' FROM visit_services
         WHERE id = NEW.id AND uid IS NOT NULL; END;
CREATE TRIGGER visit_services_journal_upd AFTER UPDATE ON visit_services
  BEGIN INSERT INTO sync_journal (tbl, uid, op)
        SELECT 'visit_services', uid, 'put' FROM visit_services
         WHERE id = NEW.id AND uid IS NOT NULL; END;
CREATE TRIGGER visit_services_journal_del AFTER DELETE ON visit_services
  WHEN OLD.uid IS NOT NULL
  BEGIN INSERT INTO sync_journal (tbl, uid, op) VALUES ('visit_services', OLD.uid, 'del'); END;

CREATE TRIGGER lab_results_journal_ins AFTER INSERT ON lab_results
  BEGIN INSERT INTO sync_journal (tbl, uid, op)
        SELECT 'lab_results', uid, 'put' FROM lab_results
         WHERE id = NEW.id AND uid IS NOT NULL; END;
CREATE TRIGGER lab_results_journal_upd AFTER UPDATE ON lab_results
  BEGIN INSERT INTO sync_journal (tbl, uid, op)
        SELECT 'lab_results', uid, 'put' FROM lab_results
         WHERE id = NEW.id AND uid IS NOT NULL; END;
CREATE TRIGGER lab_results_journal_del AFTER DELETE ON lab_results
  WHEN OLD.uid IS NOT NULL
  BEGIN INSERT INTO sync_journal (tbl, uid, op) VALUES ('lab_results', OLD.uid, 'del'); END;

-- Записи, у которых ещё нет родителя. Хранятся целиком (JSON) и применяются,
-- когда родитель приезжает. Ключ — (tbl, uid): у одной строки одно последнее
-- состояние; более поздняя запись про ту же строку замещает более раннюю.
CREATE TABLE sync_pending (
  tbl          TEXT NOT NULL,
  uid          TEXT NOT NULL,
  stamp        TEXT NOT NULL,
  record       TEXT NOT NULL,          -- JSON всей записи, как приехала
  waits_tbl    TEXT NOT NULL,          -- какого родителя ждёт
  waits_uid    TEXT NOT NULL,
  received_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),  -- для выселения: ребёнок, чей родитель удалён у источника, ждал бы вечно
  PRIMARY KEY (tbl, uid)
);
CREATE INDEX idx_sync_pending_parent ON sync_pending(waits_tbl, waits_uid);

-- Метка последнего ПРИНЯТОГО изменения КАЖДОЙ колонки строки: слияние
-- поколоночное (телефон из B и адрес из C выживают оба). Местная правка метки
-- не имеет — до отправки её защищает журнал (см. records.js).
-- col = '*' — надгробие: строка удалена с этой меткой; put старше него не
-- воскрешает строку.
CREATE TABLE sync_seen (
  tbl   TEXT NOT NULL,
  uid   TEXT NOT NULL,
  col   TEXT NOT NULL,
  stamp TEXT NOT NULL,
  PRIMARY KEY (tbl, uid, col)
);

-- Докуда каждому соседу уже отдано. Ключ — буква узла. Что от него принято по
-- колонкам отслеживает sync_seen, а не эта таблица.
CREATE TABLE sync_peers (
  node       TEXT PRIMARY KEY,
  sent_seq   INTEGER NOT NULL DEFAULT 0,  -- наш журнал: докуда отдали
  last_ok    TEXT                         -- когда последний раз отдали успешно
);
