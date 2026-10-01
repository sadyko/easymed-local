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
