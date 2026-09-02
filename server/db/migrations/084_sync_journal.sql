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
--      ТО ЖЕ САМОЕ КАСАЕТСЯ ПЕРЕСБОРКИ ТАБЛИЦЫ в будущих миграциях, и
--      это самый дорогой из всех случаев здесь. SQLite не умеет менять
--      ограничения и типы колонок на месте, и его собственный порядок из
--      12 шагов («создать новую, INSERT ... SELECT, удалить старую,
--      переименовать») переносит строки ВМЕСТЕ С uid. Значит
--      *_journal_ins сработает на КАЖДОЙ строке и запишет её как '*' —
--      а '*' для приёмника означает «мы авторы всей строки». Вся база
--      пациентов уедет заново каждому соседу под СВЕЖИМИ метками и
--      перебьёт там всё, что сосед правил у себя: не «много трафика», а
--      молчаливая потеря чужих правок во всей сети. Поэтому любая
--      такая миграция обязана оборачиваться DROP TRIGGER всех трёх
--      журнальных триггеров таблицы до пересборки и их повторным
--      созданием после — текстом из этого файла, а не по памяти.
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
  -- ВРЕМЯ ПРАВКИ С МИЛЛИСЕКУНДАМИ (%f), и это не педантизм (Задача 7d). Из
  -- этой колонки чеканится метка авторства, а по метке решается, чья правка
  -- колонки новее. С секундной точностью две правки одной колонки внутри
  -- одной секунды неразличимы, и вторая молча пропадала: приёмник видел метку,
  -- равную уже принятой, и запись отбрасывал. Секунда — целая вечность для
  -- регистратуры (заполнил поле, нажал «сохранить», исправил опечатку).
  at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),  -- время правки; из него чеканится метка авторства
  cols       TEXT NOT NULL DEFAULT '*'  -- какие колонки менялись: 'phone,address'; '*' — вся строка (вставка, удаление)
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

-- КАКИЕ КОЛОНКИ ИЗМЕНИЛИСЬ (cols) — не украшение, а условие того, чтобы
-- слияние вообще было поколоночным. Отправитель отдаёт СНИМОК всей строки под
-- ОДНОЙ меткой; приёмник, записав эту метку в sync_seen КАЖДОЙ колонке снимка,
-- объявляет отправителя автором колонок, которых тот не касался. Ревью Задачи 5
-- воспроизвело цену на обмене двух узлов: B правит телефон, C — адрес, оба ещё
-- не отправлены. B→C: C защищает строку и ОТБРАСЫВАЕТ запись целиком, а markSent
-- у B уже сдвинулся — правка B больше не уедет никогда. C→B: снимок C несёт
-- ПУСТОЙ телефон под меткой новее — и номер пропадает из СЕТИ, на обеих
-- сторонах сразу. Теперь журнал помнит, что именно правили, отправитель отдаёт
-- этот список полем `changed`, а приёмник применяет и защищает ровно эти
-- колонки, а не строку целиком.
--
-- Перечисляются только колонки, которые вообще уезжают: SHIPPED + ссылки
-- (journal.js). Правка ОДНОЙ неотправляемой колонки (updated_at, created_by,
-- queue_no) не даёт записи в журнал ВОВСЕ. Раньше давала — и каждое касание
-- служебного поля поднимало всю строку в сеть и «защищало» её от соседей.
--
-- OLD.uid IS NULL → '*', и это не мелочь. Проверено на этой самой схеме: у
-- нового пациента *_journal_ins срабатывает РАНЬШЕ *_uid_autogen (083), видит
-- uid IS NULL и не пишет ничего; всю запись о новой строке даёт UPDATE
-- uid-триггера мгновением позже. Считай мы «изменённой» только колонку uid
-- (её в списке нет) — вставка не попадала бы в журнал НИ ОДНОЙ записью, и
-- новый пациент не уехал бы соседу вовсе. Строка, у которой uid только что
-- появился, для сети новая целиком — отсюда '*'.
CREATE TRIGGER patients_journal_ins AFTER INSERT ON patients
  BEGIN INSERT INTO sync_journal (tbl, uid, op, cols)
        SELECT 'patients', uid, 'put', '*' FROM patients
         WHERE id = NEW.id AND uid IS NOT NULL; END;
CREATE TRIGGER patients_journal_upd AFTER UPDATE ON patients
  BEGIN
    INSERT INTO sync_journal (tbl, uid, op, cols)
    SELECT 'patients', uid, 'put', cols FROM (
      SELECT r.uid AS uid, CASE WHEN OLD.uid IS NULL THEN '*' ELSE rtrim(
             CASE WHEN NEW.mrn IS NOT OLD.mrn THEN 'mrn,' ELSE '' END ||
             CASE WHEN NEW.full_name IS NOT OLD.full_name THEN 'full_name,' ELSE '' END ||
             CASE WHEN NEW.first_name IS NOT OLD.first_name THEN 'first_name,' ELSE '' END ||
             CASE WHEN NEW.last_name IS NOT OLD.last_name THEN 'last_name,' ELSE '' END ||
             CASE WHEN NEW.middle_name IS NOT OLD.middle_name THEN 'middle_name,' ELSE '' END ||
             CASE WHEN NEW.date_of_birth IS NOT OLD.date_of_birth THEN 'date_of_birth,' ELSE '' END ||
             CASE WHEN NEW.gender IS NOT OLD.gender THEN 'gender,' ELSE '' END ||
             CASE WHEN NEW.blood_type IS NOT OLD.blood_type THEN 'blood_type,' ELSE '' END ||
             CASE WHEN NEW.phone IS NOT OLD.phone THEN 'phone,' ELSE '' END ||
             CASE WHEN NEW.email IS NOT OLD.email THEN 'email,' ELSE '' END ||
             CASE WHEN NEW.national_id IS NOT OLD.national_id THEN 'national_id,' ELSE '' END ||
             CASE WHEN NEW.address IS NOT OLD.address THEN 'address,' ELSE '' END ||
             CASE WHEN NEW.nationality IS NOT OLD.nationality THEN 'nationality,' ELSE '' END ||
             CASE WHEN NEW.occupation IS NOT OLD.occupation THEN 'occupation,' ELSE '' END ||
             CASE WHEN NEW.emergency_contact_name IS NOT OLD.emergency_contact_name THEN 'emergency_contact_name,' ELSE '' END ||
             CASE WHEN NEW.emergency_contact_phone IS NOT OLD.emergency_contact_phone THEN 'emergency_contact_phone,' ELSE '' END ||
             CASE WHEN NEW.allergies IS NOT OLD.allergies THEN 'allergies,' ELSE '' END ||
             CASE WHEN NEW.chronic_conditions IS NOT OLD.chronic_conditions THEN 'chronic_conditions,' ELSE '' END ||
             CASE WHEN NEW.notes IS NOT OLD.notes THEN 'notes,' ELSE '' END ||
             CASE WHEN NEW.active IS NOT OLD.active THEN 'active,' ELSE '' END ||
             CASE WHEN NEW.registration_date IS NOT OLD.registration_date THEN 'registration_date,' ELSE '' END, ',') END AS cols
        FROM patients r WHERE r.id = NEW.id AND r.uid IS NOT NULL
    ) WHERE cols <> '';

    -- Авторство колонок — тем же условием, что и журнал, но БЕЗ срока годности
    -- (журнал вычищается, авторство остаётся). Одним запросом, а не по запросу
    -- на колонку: правка пациента не должна стоить двух десятков вставок.
    INSERT INTO sync_authored (tbl, uid, col, at)
    SELECT 'patients', r.uid, v.col, strftime('%Y-%m-%dT%H:%M:%fZ','now')
      FROM patients r
      JOIN (
            SELECT 'mrn' AS col WHERE NEW.mrn IS NOT OLD.mrn
            UNION ALL SELECT 'full_name' WHERE NEW.full_name IS NOT OLD.full_name
            UNION ALL SELECT 'first_name' WHERE NEW.first_name IS NOT OLD.first_name
            UNION ALL SELECT 'last_name' WHERE NEW.last_name IS NOT OLD.last_name
            UNION ALL SELECT 'middle_name' WHERE NEW.middle_name IS NOT OLD.middle_name
            UNION ALL SELECT 'date_of_birth' WHERE NEW.date_of_birth IS NOT OLD.date_of_birth
            UNION ALL SELECT 'gender' WHERE NEW.gender IS NOT OLD.gender
            UNION ALL SELECT 'blood_type' WHERE NEW.blood_type IS NOT OLD.blood_type
            UNION ALL SELECT 'phone' WHERE NEW.phone IS NOT OLD.phone
            UNION ALL SELECT 'email' WHERE NEW.email IS NOT OLD.email
            UNION ALL SELECT 'national_id' WHERE NEW.national_id IS NOT OLD.national_id
            UNION ALL SELECT 'address' WHERE NEW.address IS NOT OLD.address
            UNION ALL SELECT 'nationality' WHERE NEW.nationality IS NOT OLD.nationality
            UNION ALL SELECT 'occupation' WHERE NEW.occupation IS NOT OLD.occupation
            UNION ALL SELECT 'emergency_contact_name' WHERE NEW.emergency_contact_name IS NOT OLD.emergency_contact_name
            UNION ALL SELECT 'emergency_contact_phone' WHERE NEW.emergency_contact_phone IS NOT OLD.emergency_contact_phone
            UNION ALL SELECT 'allergies' WHERE NEW.allergies IS NOT OLD.allergies
            UNION ALL SELECT 'chronic_conditions' WHERE NEW.chronic_conditions IS NOT OLD.chronic_conditions
            UNION ALL SELECT 'notes' WHERE NEW.notes IS NOT OLD.notes
            UNION ALL SELECT 'active' WHERE NEW.active IS NOT OLD.active
            UNION ALL SELECT 'registration_date' WHERE NEW.registration_date IS NOT OLD.registration_date
           ) v
     WHERE r.id = NEW.id AND r.uid IS NOT NULL AND OLD.uid IS NOT NULL
    ON CONFLICT(tbl, uid, col) DO UPDATE SET at = excluded.at;
  END;
-- Надгробие (sync_tombstones) пишется ТЕМ ЖЕ триггером, что и запись в
-- журнал, а не отдельно: смысл в том, что триггер обойти нельзя (см. шапку
-- файла), и то же самое должно быть верно для факта удаления, а не только
-- для журнальной записи о нём. Разбор — у самой таблицы sync_tombstones ниже.
CREATE TRIGGER patients_journal_del AFTER DELETE ON patients
  WHEN OLD.uid IS NOT NULL
  BEGIN
    INSERT INTO sync_journal (tbl, uid, op) VALUES ('patients', OLD.uid, 'del');
    INSERT OR REPLACE INTO sync_tombstones (tbl, uid) VALUES ('patients', OLD.uid);
    -- Строки больше нет — хранить, кто правил её колонки, незачем.
    DELETE FROM sync_authored WHERE tbl = 'patients' AND uid = OLD.uid;
  END;

CREATE TRIGGER visits_journal_ins AFTER INSERT ON visits
  BEGIN INSERT INTO sync_journal (tbl, uid, op, cols)
        SELECT 'visits', uid, 'put', '*' FROM visits
         WHERE id = NEW.id AND uid IS NOT NULL; END;
CREATE TRIGGER visits_journal_upd AFTER UPDATE ON visits
  BEGIN
    INSERT INTO sync_journal (tbl, uid, op, cols)
    SELECT 'visits', uid, 'put', cols FROM (
      SELECT r.uid AS uid, CASE WHEN OLD.uid IS NULL THEN '*' ELSE rtrim(
             CASE WHEN NEW.visit_date IS NOT OLD.visit_date THEN 'visit_date,' ELSE '' END ||
             CASE WHEN NEW.duration_minutes IS NOT OLD.duration_minutes THEN 'duration_minutes,' ELSE '' END ||
             CASE WHEN NEW.visit_kind IS NOT OLD.visit_kind THEN 'visit_kind,' ELSE '' END ||
             CASE WHEN NEW.visit_type IS NOT OLD.visit_type THEN 'visit_type,' ELSE '' END ||
             CASE WHEN NEW.status IS NOT OLD.status THEN 'status,' ELSE '' END ||
             CASE WHEN NEW.notes IS NOT OLD.notes THEN 'notes,' ELSE '' END ||
             CASE WHEN NEW.patient_id IS NOT OLD.patient_id THEN 'patient_id,' ELSE '' END, ',') END AS cols
        FROM visits r WHERE r.id = NEW.id AND r.uid IS NOT NULL
    ) WHERE cols <> '';

    -- Авторство колонок — тем же условием, что и журнал, но БЕЗ срока годности
    -- (журнал вычищается, авторство остаётся). Одним запросом, а не по запросу
    -- на колонку: правка пациента не должна стоить двух десятков вставок.
    INSERT INTO sync_authored (tbl, uid, col, at)
    SELECT 'visits', r.uid, v.col, strftime('%Y-%m-%dT%H:%M:%fZ','now')
      FROM visits r
      JOIN (
            SELECT 'visit_date' AS col WHERE NEW.visit_date IS NOT OLD.visit_date
            UNION ALL SELECT 'duration_minutes' WHERE NEW.duration_minutes IS NOT OLD.duration_minutes
            UNION ALL SELECT 'visit_kind' WHERE NEW.visit_kind IS NOT OLD.visit_kind
            UNION ALL SELECT 'visit_type' WHERE NEW.visit_type IS NOT OLD.visit_type
            UNION ALL SELECT 'status' WHERE NEW.status IS NOT OLD.status
            UNION ALL SELECT 'notes' WHERE NEW.notes IS NOT OLD.notes
            UNION ALL SELECT 'patient_id' WHERE NEW.patient_id IS NOT OLD.patient_id
           ) v
     WHERE r.id = NEW.id AND r.uid IS NOT NULL AND OLD.uid IS NOT NULL
    ON CONFLICT(tbl, uid, col) DO UPDATE SET at = excluded.at;
  END;
CREATE TRIGGER visits_journal_del AFTER DELETE ON visits
  WHEN OLD.uid IS NOT NULL
  BEGIN
    INSERT INTO sync_journal (tbl, uid, op) VALUES ('visits', OLD.uid, 'del');
    INSERT OR REPLACE INTO sync_tombstones (tbl, uid) VALUES ('visits', OLD.uid);
    -- Строки больше нет — хранить, кто правил её колонки, незачем.
    DELETE FROM sync_authored WHERE tbl = 'visits' AND uid = OLD.uid;
  END;

CREATE TRIGGER visit_services_journal_ins AFTER INSERT ON visit_services
  BEGIN INSERT INTO sync_journal (tbl, uid, op, cols)
        SELECT 'visit_services', uid, 'put', '*' FROM visit_services
         WHERE id = NEW.id AND uid IS NOT NULL; END;
CREATE TRIGGER visit_services_journal_upd AFTER UPDATE ON visit_services
  BEGIN
    INSERT INTO sync_journal (tbl, uid, op, cols)
    SELECT 'visit_services', uid, 'put', cols FROM (
      SELECT r.uid AS uid, CASE WHEN OLD.uid IS NULL THEN '*' ELSE rtrim(
             CASE WHEN NEW.quantity IS NOT OLD.quantity THEN 'quantity,' ELSE '' END ||
             CASE WHEN NEW.status IS NOT OLD.status THEN 'status,' ELSE '' END ||
             CASE WHEN NEW.visit_id IS NOT OLD.visit_id THEN 'visit_id,' ELSE '' END ||
             CASE WHEN NEW.service_id IS NOT OLD.service_id THEN 'service_id,' ELSE '' END, ',') END AS cols
        FROM visit_services r WHERE r.id = NEW.id AND r.uid IS NOT NULL
    ) WHERE cols <> '';

    -- Авторство колонок — тем же условием, что и журнал, но БЕЗ срока годности
    -- (журнал вычищается, авторство остаётся). Одним запросом, а не по запросу
    -- на колонку: правка пациента не должна стоить двух десятков вставок.
    INSERT INTO sync_authored (tbl, uid, col, at)
    SELECT 'visit_services', r.uid, v.col, strftime('%Y-%m-%dT%H:%M:%fZ','now')
      FROM visit_services r
      JOIN (
            SELECT 'quantity' AS col WHERE NEW.quantity IS NOT OLD.quantity
            UNION ALL SELECT 'status' WHERE NEW.status IS NOT OLD.status
            UNION ALL SELECT 'visit_id' WHERE NEW.visit_id IS NOT OLD.visit_id
            UNION ALL SELECT 'service_id' WHERE NEW.service_id IS NOT OLD.service_id
           ) v
     WHERE r.id = NEW.id AND r.uid IS NOT NULL AND OLD.uid IS NOT NULL
    ON CONFLICT(tbl, uid, col) DO UPDATE SET at = excluded.at;
  END;
CREATE TRIGGER visit_services_journal_del AFTER DELETE ON visit_services
  WHEN OLD.uid IS NOT NULL
  BEGIN
    INSERT INTO sync_journal (tbl, uid, op) VALUES ('visit_services', OLD.uid, 'del');
    INSERT OR REPLACE INTO sync_tombstones (tbl, uid) VALUES ('visit_services', OLD.uid);
    -- Строки больше нет — хранить, кто правил её колонки, незачем.
    DELETE FROM sync_authored WHERE tbl = 'visit_services' AND uid = OLD.uid;
  END;

CREATE TRIGGER lab_results_journal_ins AFTER INSERT ON lab_results
  BEGIN INSERT INTO sync_journal (tbl, uid, op, cols)
        SELECT 'lab_results', uid, 'put', '*' FROM lab_results
         WHERE id = NEW.id AND uid IS NOT NULL; END;
CREATE TRIGGER lab_results_journal_upd AFTER UPDATE ON lab_results
  BEGIN
    INSERT INTO sync_journal (tbl, uid, op, cols)
    SELECT 'lab_results', uid, 'put', cols FROM (
      SELECT r.uid AS uid, CASE WHEN OLD.uid IS NULL THEN '*' ELSE rtrim(
             CASE WHEN NEW.parameter IS NOT OLD.parameter THEN 'parameter,' ELSE '' END ||
             CASE WHEN NEW.value IS NOT OLD.value THEN 'value,' ELSE '' END ||
             CASE WHEN NEW.numeric_value IS NOT OLD.numeric_value THEN 'numeric_value,' ELSE '' END ||
             CASE WHEN NEW.unit IS NOT OLD.unit THEN 'unit,' ELSE '' END ||
             CASE WHEN NEW.reference_range IS NOT OLD.reference_range THEN 'reference_range,' ELSE '' END ||
             CASE WHEN NEW.ref_low IS NOT OLD.ref_low THEN 'ref_low,' ELSE '' END ||
             CASE WHEN NEW.ref_high IS NOT OLD.ref_high THEN 'ref_high,' ELSE '' END ||
             CASE WHEN NEW.flag IS NOT OLD.flag THEN 'flag,' ELSE '' END ||
             CASE WHEN NEW.notes IS NOT OLD.notes THEN 'notes,' ELSE '' END ||
             CASE WHEN NEW.entered_at IS NOT OLD.entered_at THEN 'entered_at,' ELSE '' END ||
             CASE WHEN NEW.verified_at IS NOT OLD.verified_at THEN 'verified_at,' ELSE '' END ||
             CASE WHEN NEW.visit_service_id IS NOT OLD.visit_service_id THEN 'visit_service_id,' ELSE '' END, ',') END AS cols
        FROM lab_results r WHERE r.id = NEW.id AND r.uid IS NOT NULL
    ) WHERE cols <> '';

    -- Авторство колонок — тем же условием, что и журнал, но БЕЗ срока годности
    -- (журнал вычищается, авторство остаётся). Одним запросом, а не по запросу
    -- на колонку: правка пациента не должна стоить двух десятков вставок.
    INSERT INTO sync_authored (tbl, uid, col, at)
    SELECT 'lab_results', r.uid, v.col, strftime('%Y-%m-%dT%H:%M:%fZ','now')
      FROM lab_results r
      JOIN (
            SELECT 'parameter' AS col WHERE NEW.parameter IS NOT OLD.parameter
            UNION ALL SELECT 'value' WHERE NEW.value IS NOT OLD.value
            UNION ALL SELECT 'numeric_value' WHERE NEW.numeric_value IS NOT OLD.numeric_value
            UNION ALL SELECT 'unit' WHERE NEW.unit IS NOT OLD.unit
            UNION ALL SELECT 'reference_range' WHERE NEW.reference_range IS NOT OLD.reference_range
            UNION ALL SELECT 'ref_low' WHERE NEW.ref_low IS NOT OLD.ref_low
            UNION ALL SELECT 'ref_high' WHERE NEW.ref_high IS NOT OLD.ref_high
            UNION ALL SELECT 'flag' WHERE NEW.flag IS NOT OLD.flag
            UNION ALL SELECT 'notes' WHERE NEW.notes IS NOT OLD.notes
            UNION ALL SELECT 'entered_at' WHERE NEW.entered_at IS NOT OLD.entered_at
            UNION ALL SELECT 'verified_at' WHERE NEW.verified_at IS NOT OLD.verified_at
            UNION ALL SELECT 'visit_service_id' WHERE NEW.visit_service_id IS NOT OLD.visit_service_id
           ) v
     WHERE r.id = NEW.id AND r.uid IS NOT NULL AND OLD.uid IS NOT NULL
    ON CONFLICT(tbl, uid, col) DO UPDATE SET at = excluded.at;
  END;
CREATE TRIGGER lab_results_journal_del AFTER DELETE ON lab_results
  WHEN OLD.uid IS NOT NULL
  BEGIN
    INSERT INTO sync_journal (tbl, uid, op) VALUES ('lab_results', OLD.uid, 'del');
    INSERT OR REPLACE INTO sync_tombstones (tbl, uid) VALUES ('lab_results', OLD.uid);
    -- Строки больше нет — хранить, кто правил её колонки, незачем.
    DELETE FROM sync_authored WHERE tbl = 'lab_results' AND uid = OLD.uid;
  END;

-- ЗАПИСИ, КОТОРЫЕ ОТВЕРГЛА САМА БАЗА (ревью 7/7b, I2). Приём заворачивает
-- каждую запись в savepoint: CHECK, внешний ключ, UNIQUE — это отказ базы уже
-- посреди вставки, и одна такая строка не должна отменять сотню здоровых.
-- Но до сих пор она исчезала совсем: счётчик skipped, строчка в консоли
-- сервера — и всё. Квитанция при этом всё равно уезжала (иначе один
-- «ядовитый» пациент повторялся бы в каждом блобе вечно), то есть отправитель
-- считал запись доставленной и второй раз её не слал.
--
-- Молчаливая потеря — худшее, что может сделать синхронизация, поэтому отказ
-- теперь ОСТАЁТСЯ: та же транзакция, что применяет порцию, пишет сюда строку.
-- Владелец видит «N записей не приняты» на экране синхронизации, а поддержка —
-- таблицу с таблицей, uid, соседом и текстом ошибки базы.
--
-- Ключ — (tbl, uid, peer): одна и та же строка от одного и того же соседа
-- отвергается по одной и той же причине, и копить это тысячами незачем.
CREATE TABLE sync_refused (
  tbl  TEXT NOT NULL,
  uid  TEXT NOT NULL,
  peer TEXT NOT NULL,               -- чей блоб её привёз; без имени соседа строка бесполезна, а в PRIMARY KEY NULL ещё и не склеивается
  err  TEXT NOT NULL,               -- что именно сказала база
  at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  PRIMARY KEY (tbl, uid, peer)
);

-- КТО И КОГДА ПРАВИЛ КОЛОНКУ ЗДЕСЬ (Задача 7e). Метка авторства нужна на
-- КАЖДОМ слиянии, а брать её было неоткуда, кроме журнала — и это ломалось
-- дважды.
--
-- Первое: журнал ЧИСТИТСЯ. Подтвердил сосед приём — pruneJournal сносит
-- строку, и наша собственная свежая правка остаётся БЕЗ метки; следующий блоб
-- соседа с его СТАРЫМ значением ложится поверх неё, и сеть сходится на более
-- ранней правке. Воспроизведено на обычном сбое: у филиала выгрузка отвечает
-- 500, а выборка работает.
--
-- Второе: у строки есть updated_at, и он ОДИН на строку. Подставлять его как
-- время правки КОЛОНКИ — значит объявлять, что правка заметки обновила и
-- возраст адреса; сосед после этого держит устаревший адрес вечно. А у
-- visit_services и lab_results updated_at нет вовсе.
--
-- Поэтому авторство хранится отдельно и поколоночно. Пишется теми же
-- триггерами, что и журнал (обойти нельзя — см. шапку файла), живёт столько же,
-- сколько строка, и чисткой журнала не затрагивается.
--
-- ВСТАВКА СЮДА НЕ ПИШЕТ: у новой строки пол авторства — её created_at, он и
-- так есть. Пишет только UPDATE, и только по тем колонкам, которые вправду
-- изменились (то же условие NEW.x IS NOT OLD.x, что и у журнала). Удаление
-- строки уносит и её авторство.
CREATE TABLE sync_authored (
  tbl TEXT NOT NULL,
  uid TEXT NOT NULL,
  col TEXT NOT NULL,
  at  TEXT NOT NULL,   -- время ПОСЛЕДНЕЙ здешней правки этой колонки, с миллисекундами
  PRIMARY KEY (tbl, uid, col)
);

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

-- Надгробия НЕЗАВИСИМО от журнала (обзор Задачи 4, C2). Журнал у отправителя
-- к моменту, когда забытый (pruneJournal, STALE_DAYS) сосед вернётся,
-- скорее всего уже вычищен — а холодный засев, который тогда собирается,
-- читает ТЕКУЩЕЕ СОСТОЯНИЕ таблиц и по построению не содержит удалённых
-- строк вообще. Без отдельного списка удалений вернувшийся сосед не узнал бы,
-- что строки, которой у него ещё нет, на самом деле уже не будет НИКОГДА —
-- он молча решил бы, что она просто ещё не доехала, и держал бы её у себя
-- вечно (в лучшем случае) или заново прислал бы её нам (в худшем).
--
-- Отдельная таблица, а не индекс поверх sync_journal: журнал хранит ИСТОРИЮ
-- (одна строка правится — много записей), а здесь по определению ровно одна
-- строка на когда-либо удалённый (tbl, uid) — INSERT OR REPLACE в триггерах
-- ниже это и обеспечивает (UNIQUE(tbl, uid), а не PRIMARY KEY по ним — seq
-- нужен отдельным первичным ключом, см. ниже).
--
-- seq — INTEGER PRIMARY KEY AUTOINCREMENT, ТА ЖЕ причина, что у sync_journal.seq
-- (см. её комментарий и 084.test.js «seq — AUTOINCREMENT»): страница засева
-- курсором помнит последнюю просмотренную запись как число и читает дальше
-- условием «> число». Без AUTOINCREMENT это число — обычный rowid, а после
-- pruneJournal, вычистившего ВСЕ надгробия разом (таблица опустела), SQLite
-- заново нумерует rowid с 1 — соседа, остановившегося курсором посреди фазы
-- надгробий на прошлой чистке, «уже пройденное» число 1 обманывает: НОВОЕ
-- надгробие с этим же переиспользованным id молча пропускается (обзор
-- Задачи 4, N1 — воспроизведено ревью). AUTOINCREMENT никогда не переиспользует
-- максимум, даже когда таблица становится совсем пустой.
CREATE TABLE sync_tombstones (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  tbl TEXT NOT NULL,
  uid TEXT NOT NULL,
  at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),   -- с миллисекундами, как sync_journal.at: из него тоже чеканится метка
  UNIQUE (tbl, uid)
);

-- Докуда каждому соседу уже отдано. Ключ — буква узла. Что от него принято по
-- колонкам отслеживает sync_seen, а не эта таблица.
--
-- ДВА ГОРИЗОНТА ОТДАЧИ, А НЕ ОДИН (Задача 7b — подтверждённая доставка). Блоб
-- узла на релее ОДИН и замещается следующей выгрузкой, поэтому «сервер принял
-- байты» и «сосед их прочитал» — разные события, и разъехаться они могут на
-- целую ночь (компьютер соседа выключен). Одной отметкой их не выразить:
--
--   pub_seq  — докуда мы ВЫЛОЖИЛИ. Двигается по ответу 2xx от релея. Снимает
--              защиту местной неотправленной правки (records.js
--              localUnshippedCols): наше авторство с этого момента ВИДНО
--              соседу, а настоящий спор двух правок разбирают поколоночные
--              метки (sync_seen), а не защита.
--   sent_seq — докуда сосед ПОДТВЕРДИЛ приём (квитанция в его блобе).
--              Двигается только по ней. По нему собирается срез (buildBatch)
--              и чистится журнал (pruneJournal): неподтверждённая запись
--              лежит в КАЖДОМ следующем блобе, пока квитанция не придёт.
--
-- Почему нельзя одной: пробная сборка с одним sent_seq по квитанции
-- зависала намертво — защита местной правки читала ТОТ ЖЕ sent_seq, и на
-- задержке подтверждения B не принимал адрес от C, C не принимал телефон от B,
-- ни один не подтверждал, и сеть не сходилась вовсе (воспроизведено сквозным
-- тестом Задачи 7). Разведя горизонты, защиту снимает выгрузка, а журнал
-- держит подтверждение — и то, и другое честно.
--
-- recv_upto — НАША квитанция соседу: до какого upto его среза мы дошли.
-- Уезжает в нашем блобе полем acks и там становится его sent_seq. Здесь же
-- она защищает от повторного применения: срез с upto не больше recv_upto уже
-- применён (сосед повторяет неподтверждённое), и разбирать его заново незачем.
--
-- seed_* — курсор ПОСТРАНИЧНОГО холодного засева (обзор Задачи 4, C1). Без
-- него первая же страница засева делала бы соседа тёплым на sent_seq этой
-- страницы, и всё, что не поместилось в лимит (у клиники на 70 000 пациентов
-- это почти весь засев), терялось бы навсегда: хвост журнала ниже этой точки
-- рано или поздно вычищается, а сосед уже считается тёплым и туда не
-- смотрит. Пока seed_floor NOT NULL, сосед ЗАСЕИВАЕТСЯ, а не тёплый:
-- горизонты всё это время держатся на seed_floor (пол журнала, замороженный
-- НА МОМЕНТ НАЧАЛА засева — см. buildBatch), и только когда засев
-- заканчивается, seed_floor/seed_tbl/seed_at обнуляются, а pub_seq остаётся
-- на нём же: дальше сосед читает хвост журнала как обычно, и ничего из
-- накопившегося за время засева не потеряно (оно всё выше пола).
--
-- СТРАНИЦЫ ЗАСЕВА ПОДТВЕРЖДАЮТСЯ ПО НОМЕРУ (Задача 7b, вторая половина). Все
-- страницы засева несут ОДИН И ТОТ ЖЕ upto — замороженный пол, — и по нему их
-- не различить; поэтому у страницы есть собственный номер (seed_page, от 1), и
-- он ездит и в срезе, и в квитанции. Курсор (seed_tbl/seed_at/seed_id) — это
-- ПОДТВЕРЖДЁННОЕ место: buildBatch собирает страницу от него, markPublished его
-- НЕ трогает, а конец выложенной страницы кладёт в seed_next_*; переносит
-- курсор туда только markConfirmed, получив номер этой самой страницы. Значит
-- страница, которую сосед не забрал (компьютер выключен на ночь), уезжает
-- снова — и уезжает ТА ЖЕ.
--
-- «ТА ЖЕ» держится на seed_started. Порядок (created_at, ранг, id) сам по себе
-- детерминирован, а вот НАБОР — нет: пока сосед молчал, клиника завела ещё
-- сорок пациентов, и повторный сбор «страницы 1» вернул бы другие строки.
-- Тогда сосед, отсеивающий страницу по номеру, этих сорока не увидел бы
-- никогда, а сосед, применяющий её заново, получал бы снимок с авторством '*'
-- под свежей меткой и терял бы СВОИ правки (воспроизведено сквозным тестом:
-- у филиала пропадали и телефон, и адрес). Поэтому засев отдаёт только то,
-- что существовало на его начало, а заведённое позже приезжает журналом: его
-- seq выше пола, и после засева оно уедет первой же тёплой порцией.
-- Без этого у клиники на 70 000 пациентов засев рвался посередине, а дыра
-- приходилась ровно на старых пациентов, которых никто не трогает, — то есть
-- была невидимой.
--
-- ОЖИДАНИЕ ОГРАНИЧЕНО last_ack. Раньше «забыть молчуна» решал last_ok, но он
-- обновляется на КАЖДОЙ нашей удачной выгрузке — то есть у выключенного
-- навсегда соседа он всё равно свежий, и такой сосед держал бы и свой засев, и
-- чистку нашего журнала вечно. last_ack — когда от соседа последний раз пришла
-- квитанция (у новой строки — момент её заведения, чтобы дать соседу фору), и
-- STALE_DAYS считаются теперь по нему.
CREATE TABLE sync_peers (
  node           TEXT PRIMARY KEY,
  pub_seq        INTEGER NOT NULL DEFAULT 0,  -- наш журнал: докуда ВЫЛОЖЕНО (ответ 2xx релея)
  sent_seq       INTEGER NOT NULL DEFAULT 0,  -- наш журнал: докуда сосед ПОДТВЕРДИЛ приём
  recv_upto      INTEGER NOT NULL DEFAULT 0,  -- ЕГО журнал: докуда мы применили — это и есть наша квитанция
  recv_seed_page INTEGER NOT NULL DEFAULT 0,  -- ЕГО засев: до какой страницы мы дошли (номера считаются в пределах одного пола)
  last_ok        TEXT,                        -- когда последний раз отдали успешно
  last_ack       TEXT,                        -- когда последний раз пришла квитанция ОТ НЕГО; по нему и забываем молчуна
  clock_skew_ms  INTEGER NOT NULL DEFAULT 0,  -- на сколько его метки уходят в БУДУЩЕЕ: сбитые часы в филиале иначе замораживают колонку у всех
  seed_floor     INTEGER,                     -- пол журнала на начало засева; NULL = не засеивается (тёплый или ещё не приходил)
  seed_started   TEXT,                        -- время начала засева: НАБОР строк заморожен по нему — иначе «страница 1» во второй выгрузке — уже другие строки
  seed_tbl       TEXT,                        -- ПОДТВЕРЖДЁННЫЙ курсор: таблица (или 'sync_tombstones' — фаза надгробий)
  seed_at        TEXT,                        -- ПОДТВЕРЖДЁННЫЙ курсор: created_at последней принятой соседом строки
  seed_id        INTEGER NOT NULL DEFAULT 0,  -- ПОДТВЕРЖДЁННЫЙ курсор: id последней принятой строки — разрыв внутри одного created_at
  seed_page      INTEGER NOT NULL DEFAULT 0,  -- сколько страниц засева сосед подтвердил; выкладывается всегда следующая, seed_page + 1
  seed_next_tbl  TEXT,                        -- где ЗАКОНЧИЛАСЬ выложенная страница: сюда переедет курсор, когда её подтвердят
  seed_next_at   TEXT,
  seed_next_id   INTEGER NOT NULL DEFAULT 0,
  seed_next_done INTEGER NOT NULL DEFAULT 0   -- выложенная страница была последней: подтвердят её — засев закончен
);
