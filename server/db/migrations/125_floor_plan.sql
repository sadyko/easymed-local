-- 125_floor_plan.sql — FACILITY_PLAN_V1: ПЛАН КЛИНИКИ.
--
-- Владелец (2026-09-11): «the user should be able to visually build a hospital
-- … feel like building and arranging a real hospital».
--
-- Этажи, кабинеты, палаты, отделения и привязка врача к кабинету в схеме уже
-- есть, и по ним работают запись, очередь, стационар и зарплата. План их не
-- дублирует — он их РАСКЛАДЫВАЕТ: у помещения появляются координаты на плане
-- этажа, у клиники — справочник оборудования и что где стоит.
--
-- Координаты в px сетки плана; 0/0/0/0 = «на плане ещё не размещено» — тогда
-- экран раскладывает помещение сам и рисует пунктиром, а настоящие числа
-- пишутся, когда плитку сдвинули рукой. ТОЛЬКО ADD COLUMN / CREATE TABLE:
-- ни одна существующая строка не трогается.
ALTER TABLE rooms ADD COLUMN plan_x INTEGER NOT NULL DEFAULT 0;
ALTER TABLE rooms ADD COLUMN plan_y INTEGER NOT NULL DEFAULT 0;
ALTER TABLE rooms ADD COLUMN plan_w INTEGER NOT NULL DEFAULT 0;
ALTER TABLE rooms ADD COLUMN plan_h INTEGER NOT NULL DEFAULT 0;
ALTER TABLE wards ADD COLUMN plan_x INTEGER NOT NULL DEFAULT 0;
ALTER TABLE wards ADD COLUMN plan_y INTEGER NOT NULL DEFAULT 0;
ALTER TABLE wards ADD COLUMN plan_w INTEGER NOT NULL DEFAULT 0;
ALTER TABLE wards ADD COLUMN plan_h INTEGER NOT NULL DEFAULT 0;

-- Оборудование клиники: справочник (что вообще бывает) и размещение (что где
-- стоит и сколько). Кабинет и палата — разные таблицы, поэтому у размещения
-- две ссылки; заполнена ровно одна.
CREATE TABLE IF NOT EXISTS equipment (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT '',
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE TABLE IF NOT EXISTS room_equipment (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id       INTEGER REFERENCES rooms(id) ON DELETE CASCADE,
  ward_id       INTEGER REFERENCES wards(id) ON DELETE CASCADE,
  equipment_id  INTEGER NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
  quantity      INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_room_equipment_room ON room_equipment(room_id);
CREATE INDEX IF NOT EXISTS idx_room_equipment_ward ON room_equipment(ward_id);
