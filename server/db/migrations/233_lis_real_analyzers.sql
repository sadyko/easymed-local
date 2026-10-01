-- LIS_REAL_ANALYZERS_V1 (2026-10-01) — НАСТОЯЩИЕ АНАЛИЗАТОРЫ КЛИНИКИ:
-- Mindray BS-200, Mindray BC-780(R), Autobio AutoLumo A1000
-- (docs/specs/2026-10-01-lis-real-analyzers-design.md, раздел «Схема»).
--
-- ТОЛЬКО ADD COLUMN. Таблицы не пересобираются: пересборка таблицы, на которую
-- ссылаются, внутри migrate() роняет клинику при запуске (урок v1.1.0), а в
-- lab_device_messages лежат мегабайты сырых проб. CHECK миграции 123 на
-- transport и status не трогаются. Бэкфилла нет.

-- dial = 1 — Easy-Med подключается к прибору сам (прибор ждёт звонка, как
-- Mindray BC-3600). transport остаётся 'mllp'. 0 — прибор звонит на порт
-- Easy-Med, как у всех, кого заводили до этой миграции.
ALTER TABLE lab_devices ADD COLUMN dial INTEGER NOT NULL DEFAULT 0 CHECK (dial IN (0, 1));

-- MSH-4 первого сообщения прибора — для показа «как назвался: Mindray ·
-- BS-200E» и для догадки о модели. Пишет только сервер (discover.js), как
-- sending_app (мигр. 229); запомненное не перезаписывается. Различение
-- приборов по-прежнему — адрес и MSH-3. NULL — строка узнает MSH-4 со
-- следующей пробы.
ALTER TABLE lab_devices ADD COLUMN sending_facility TEXT;

-- Вид сообщения: проба пациента (result), контроль качества (qc, MSH-16 = 2),
-- калибровка (calibration, MSH-16 = 1), запрос рабочего списка (query).
-- Служебные в бланк и лоток не идут, но хранятся целиком (инвариант 2).
-- Прежние строки — result.
ALTER TABLE lab_device_messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'result'
  CHECK (kind IN ('result', 'qc', 'calibration', 'query'));

-- Счётчик служебных у прибора за сегодня (lis_service_counts). kind лежит в
-- записи ПОСЛЕ raw: без индекса подсчёт читал бы каждую пробу целиком, с
-- картинками, за все месяцы. Частичный и покрывающий: в нём только служебные
-- строки, а их немного.
CREATE INDEX IF NOT EXISTS idx_lab_device_messages_service
  ON lab_device_messages(received_at, device_id, kind) WHERE kind <> 'result';

-- Ревью R4, п. A — у BS-200 номер теста свой у КАЖДОГО прибора (ItemID.ini):
-- «2» у второго BS-200 бывает креатинином, а не глюкозой. Подтверждение
-- сопоставления (D4) поэтому помнит, ДЛЯ КАКОГО ПРИБОРА оно дано. NULL — не
-- подтверждено ни для какого (в том числе всё, что подтверждали до этой
-- миграции: бэкфилла нет). Приём (server/lis/ingest.js) у приборов с номерами
-- тестов, своими у каждого прибора (codesPerInstrument), применяет только
-- строки, подтверждённые для прибора панели; у кодов производителя отметка не
-- читается. Смена прибора панели ничего не переписывает: отметка остаётся
-- прежней и просто не совпадает с новым прибором (триггер R3, снимавший
-- подтверждения при смене lab_panels.device_id, убран — он не защищал
-- сохранение редактора: правка панели, потом вставка строк заново).
ALTER TABLE lab_panel_analytes ADD COLUMN device_code_confirmed_device_id INTEGER;

-- Ставит отметку база, на каждом пути записи. Вставка (редактор панелей
-- сохраняет так: правка lab_panels, вставка новых строк, удаление прежних —
-- lab-panels.js savePanel):
--   не подтверждено или кода нет — NULL;
--   редактор назвал прибор, для которого человек подтвердил, — он;
--   иначе (старая вкладка) — отметка прежней подтверждённой строки этой панели
--   с тем же кодом, какой бы она ни была (в том числе NULL): иначе сохранение
--   «отмыло» бы подтверждение старого прибора под новым;
--   иначе (новый код) — прибор панели сейчас.
CREATE TRIGGER IF NOT EXISTS trg_lab_panel_analytes_confirm_ins
AFTER INSERT ON lab_panel_analytes
BEGIN
  UPDATE lab_panel_analytes SET device_code_confirmed_device_id = CASE
      WHEN NEW.device_code_confirmed IS NOT 1 OR TRIM(COALESCE(NEW.device_code, '')) = '' THEN NULL
      WHEN NEW.device_code_confirmed_device_id IS NOT NULL THEN NEW.device_code_confirmed_device_id
      WHEN EXISTS (SELECT 1 FROM lab_panel_analytes o
                    WHERE o.panel_id = NEW.panel_id AND o.id < NEW.id AND o.device_code_confirmed = 1
                      AND UPPER(TRIM(o.device_code)) = UPPER(TRIM(NEW.device_code)))
        THEN (SELECT o.device_code_confirmed_device_id FROM lab_panel_analytes o
               WHERE o.panel_id = NEW.panel_id AND o.id < NEW.id AND o.device_code_confirmed = 1
                 AND UPPER(TRIM(o.device_code)) = UPPER(TRIM(NEW.device_code))
               ORDER BY o.id LIMIT 1)
      ELSE (SELECT p.device_id FROM lab_panels p WHERE p.id = NEW.panel_id)
    END
  WHERE id = NEW.id;
END;

-- Правка строки: подтвердили (было не подтверждено) или сменили код — прибор
-- панели сейчас; подтверждение и код прежние — прежняя отметка; не
-- подтверждено или кода нет — NULL. Через /api/db отметку правкой не задать
-- (реестр), и без смены подтверждения или кода триггер её не трогает.
CREATE TRIGGER IF NOT EXISTS trg_lab_panel_analytes_confirm_upd
AFTER UPDATE OF device_code_confirmed, device_code ON lab_panel_analytes
BEGIN
  UPDATE lab_panel_analytes SET device_code_confirmed_device_id = CASE
      WHEN NEW.device_code_confirmed IS NOT 1 OR TRIM(COALESCE(NEW.device_code, '')) = '' THEN NULL
      WHEN OLD.device_code_confirmed IS 1
       AND UPPER(TRIM(COALESCE(OLD.device_code, ''))) = UPPER(TRIM(NEW.device_code)) THEN OLD.device_code_confirmed_device_id
      ELSE (SELECT p.device_id FROM lab_panels p WHERE p.id = NEW.panel_id)
    END
  WHERE id = NEW.id;
END;

-- Ревью R4, п. B — какая строка лотка записала это значение прибора в бланк
-- (ставит приём; NULL — набрано руками или записано до этой миграции).
-- «Привязать» к другому заказу снимает из прежнего ровно значения этой строки.
ALTER TABLE lab_results ADD COLUMN source_message_id INTEGER;

-- Ревью R4, п. D — споры «повтор» этой строки лотка структурой:
-- JSON [{"code": "2", "a": "5.1", "b": "5.4"}] (код поля бланка, два значения
-- без хвостовых нулей). Разобранный человеком спор узнаётся по ней, а не по
-- тексту журнала. NULL — споров нет.
ALTER TABLE lab_device_messages ADD COLUMN disputes TEXT;

-- Ревью R4, п. C — статус заказа до того, как прибор поставил «результаты
-- внесены». «Привязать» к другому заказу, опустошившее бланк, возвращает
-- ровно его (неизвестен — «в работе», не «ждёт оплату» и не «ждёт забора»).
ALTER TABLE visit_services ADD COLUMN lis_status_before TEXT;
