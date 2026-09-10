-- LIS_INGEST_V1 — приём результатов с анализаторов.
--
-- Пробирка уже несёт штрихкод Easy-Med (lab-barcode.js, шаг «Забор пробы»), и
-- до сих пор его никто не читал: лаборант перебивал числа с экрана прибора
-- руками. Здесь появляется обратное направление — прибор присылает результат,
-- Easy-Med находит заказ по тому же номеру и раскладывает значения по бланку.
--
-- ЧЕГО ЗДЕСЬ НАМЕРЕННО НЕТ:
--   * никакого UPDATE существующих строк — lab_results журналируется для
--     филиалов (084), и массовая правка означала бы выгрузку каждой тронутой
--     строки соседям под свежими метками, то есть молчаливую потерю их правок.
--     Проверяется 123.test.js.
--   * lab_results.source НЕ добавляется в SHIPPED (branch-sync/journal.js).
--     Список уже исключает entered_by и verified_by: правило установлено —
--     клиническое содержание едет, а КТО и КАК его получил остаётся в здании,
--     где он получен. Происхождение значения — ровно этот класс факта.
--     Поэтому журнальный триггер lab_results НЕ пересобирается.
--   * device_id и сопоставление не попадают в справочник филиалов
--     (branch-sync/catalogue.js): там перечни колонок явные, а анализатор
--     соседнего здания в нашей базе не означает ничего. Пин — в 123.test.js.

-- Анализаторы клиники. Принадлежность ЗДАНИЮ: в справочник филиалов не едут.
CREATE TABLE lab_devices (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  profile       TEXT NOT NULL,
  transport     TEXT NOT NULL DEFAULT 'mllp'
                  CHECK (transport IN ('mllp','folder','serial')),
  host          TEXT NOT NULL DEFAULT '',
  port          INTEGER,
  folder_path   TEXT NOT NULL DEFAULT '',
  serial_port   TEXT NOT NULL DEFAULT '',
  serial_baud   INTEGER,
  enabled       INTEGER NOT NULL DEFAULT 1,
  last_seen_at  TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- Панель кормится одним анализатором. NULL — законно: панель заполняется руками.
ALTER TABLE lab_panels ADD COLUMN device_id INTEGER REFERENCES lab_devices(id);

-- Сопоставление поле-в-поле (решение владельца D3) и доказательство того, что
-- человек строку подтвердил (D4). Приём применяет ТОЛЬКО подтверждённые.
ALTER TABLE lab_panel_analytes ADD COLUMN device_code TEXT NOT NULL DEFAULT '';
ALTER TABLE lab_panel_analytes ADD COLUMN device_code_confirmed INTEGER NOT NULL DEFAULT 0;

-- Происхождение значения. 'manual' по умолчанию — прежние строки сохраняют смысл.
ALTER TABLE lab_results ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';

-- Лоток: каждое сообщение, дошедшее до порта, чем бы дело ни кончилось.
-- Инвариант 2: ничего не теряется. Смазанный штрихкод обязан стоить клика, а
-- не повторного забора крови.
CREATE TABLE lab_device_messages (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id        INTEGER REFERENCES lab_devices(id),
  peer             TEXT NOT NULL DEFAULT '',
  raw              TEXT NOT NULL,
  sample_id        TEXT NOT NULL DEFAULT '',
  visit_service_id INTEGER REFERENCES visit_services(id),
  status           TEXT NOT NULL
                     CHECK (status IN ('applied','unmatched','unmapped','rejected','superseded')),
  detail           TEXT NOT NULL DEFAULT '',
  received_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  resolved_at      TEXT
);
CREATE INDEX idx_lab_device_messages_status ON lab_device_messages(status);
CREATE INDEX idx_lab_device_messages_vs ON lab_device_messages(visit_service_id);
