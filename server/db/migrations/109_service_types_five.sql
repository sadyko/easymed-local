-- 109_service_types_five.sql
-- SERVICE_TYPES_FIVE_V1 — пять разделов услуги вместо шести.
--
-- Владелец: «we need to make 5 types of the services type: lab goes to lab
-- route, consultation goes to doctors cabinet, procedure is procedure route,
-- diagnostics too goes to the doctors cabinet, and the surgery is bundled so it
-- goes with the hospitalization».
--
-- БЫЛО: consultation, lab, procedure, imaging, other, radiology.
-- СТАЛО: consultation, lab, procedure, imaging, surgery.
--
--   radiology («Рентген») — УДАЛЁН. Он не значил ничего: в маршрутизации
--     очереди своей ветки у него не было, и он падал в тот же else, что и
--     other. Два пункта в списке, одно поведение. Услуг с этим типом нет ни в
--     одной базе — ни одной строки не задето.
--   other («Другое») — УДАЛЁН и переведён в SURGERY. Здесь была ошибка, и её
--     стоит записать: сначала эти услуги собирались перевести в procedure,
--     потому что «Другое» звучит как свалка. Но в настройках услуг (sections.js)
--     этот же тип уже подписан «Хирургия» — то есть сотрудник, выбиравший
--     «Хирургия», записывал 'other'. Проверка данных подтвердила: ВСЕ 183 такие
--     услуги — операции (нефрэктомия, уретропластика, варикоцелэктомия), и у
--     всех 183 тип каталога называется «Хирургия».
--     Перевод в procedure сделал бы ровно обратное задуманному: операции стали
--     бы процедурами и снова оформлялись бы БЕЗ КОЙКИ.
--   surgery («Хирургия») — ДОБАВЛЕН. Своей очереди у него нет намеренно:
--     операция оформляется на госпитализацию, а не на талон.
--
-- SQLite не умеет менять CHECK — пересборка таблицы с переносом данных, тем же
-- приёмом, что и 046_crm_pipeline.sql.

-- Перевод сделан ВНУТРИ переноса, а не отдельным UPDATE до него: старое
-- ограничение ещё действует на старой таблице и 'surgery' в неё не пускает
-- (CHECK constraint failed) — первая попытка именно на этом и споткнулась.
-- Таблица с новым ограничением.
CREATE TABLE services_v2 (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT NOT NULL,
  code             TEXT,
  price            REAL NOT NULL DEFAULT 0,
  tax_rate         REAL NOT NULL DEFAULT 0,
  duration_minutes INTEGER NOT NULL DEFAULT 30,
  requires_doctor  INTEGER NOT NULL DEFAULT 0,
  active           INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  is_lab           INTEGER NOT NULL DEFAULT 0,
  specimen         TEXT,
  result_unit      TEXT,
  ref_low          REAL,
  ref_high         REAL,
  ref_text         TEXT,
  type             TEXT NOT NULL DEFAULT 'consultation'
                     CHECK (type IN ('consultation','lab','procedure','imaging','surgery')),
  type_id                INTEGER REFERENCES service_types(id),
  category_id            INTEGER REFERENCES service_categories(id),
  department_id          INTEGER REFERENCES departments(id),
  tube_color             TEXT,
  default_doctor_percent REAL NOT NULL DEFAULT 0,
  room_id                INTEGER REFERENCES rooms(id)
);

INSERT INTO services_v2 (id, name, code, price, tax_rate, duration_minutes, requires_doctor,
                         active, created_at, updated_at, is_lab, specimen, result_unit,
                         ref_low, ref_high, ref_text, type, type_id, category_id,
                         department_id, tube_color, default_doctor_percent, room_id)
SELECT id, name, code, price, tax_rate, duration_minutes, requires_doctor,
       active, created_at, updated_at, is_lab, specimen, result_unit,
       ref_low, ref_high, ref_text,
       CASE type
         WHEN 'other'     THEN 'surgery'   -- подпись в настройках была «Хирургия»
         WHEN 'radiology' THEN 'imaging'   -- строк нет ни в одной базе, на всякий случай
         ELSE type
       END,
       type_id, category_id,
       department_id, tube_color, default_doctor_percent, room_id
FROM services;

DROP TABLE services;
ALTER TABLE services_v2 RENAME TO services;

-- Группа услуги (service_types) для нового типа. Миграция 056 раскладывала
-- услуги по группам ПО ТИПУ и знала шесть старых значений; 'surgery' появился
-- позже неё, и без этой строки операция осталась бы без группы — а по группам
-- собран весь прейскурант.
INSERT INTO service_types (name, active)
  SELECT 'Хирургия', 1 WHERE NOT EXISTS (SELECT 1 FROM service_types WHERE name = 'Хирургия');
UPDATE services SET type_id = (SELECT id FROM service_types WHERE name = 'Хирургия')
 WHERE type_id IS NULL AND type = 'surgery';

-- ТРИГГЕРЫ, УБИТЫЕ ПЕРЕСБОРКОЙ. DROP TABLE уносит с собой все триггеры
-- таблицы, и три из миграции 048 исчезли молча: тип услуги и признак
-- «лабораторная» перестали держаться друг за друга. Поймали тесты 048 — без
-- них расхождение всплыло бы у клиники, где анализ с type='lab' и is_lab=0 не
-- попадает ни в лабораторный модуль, ни в очередь забора.
--
-- Воспроизведены дословно (048_lab_service_link.sql): условие WHEN пишет
-- только при реальном расхождении, поэтому пара не зацикливается.
DROP TRIGGER IF EXISTS services_type_syncs_is_lab;
CREATE TRIGGER services_type_syncs_is_lab
AFTER UPDATE OF type ON services
FOR EACH ROW
WHEN (NEW.type = 'lab') <> (NEW.is_lab = 1)
BEGIN
  UPDATE services SET is_lab = CASE WHEN NEW.type = 'lab' THEN 1 ELSE 0 END
   WHERE id = NEW.id;
END;

DROP TRIGGER IF EXISTS services_is_lab_syncs_type;
CREATE TRIGGER services_is_lab_syncs_type
AFTER UPDATE OF is_lab ON services
FOR EACH ROW
WHEN (NEW.is_lab = 1) <> (NEW.type = 'lab')
BEGIN
  UPDATE services SET type = CASE WHEN NEW.is_lab = 1 THEN 'lab' ELSE 'consultation' END
   WHERE id = NEW.id;
END;

DROP TRIGGER IF EXISTS services_insert_syncs_lab;
CREATE TRIGGER services_insert_syncs_lab
AFTER INSERT ON services
FOR EACH ROW
WHEN (NEW.type = 'lab') <> (NEW.is_lab = 1)
BEGIN
  UPDATE services
     SET is_lab = CASE WHEN NEW.type = 'lab' THEN 1 ELSE NEW.is_lab END,
         type   = CASE WHEN NEW.is_lab = 1   THEN 'lab' ELSE NEW.type END
   WHERE id = NEW.id;
END;
