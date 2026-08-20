-- 038_seed_departments.sql
-- DEPARTMENTS_SEED_V1 — отделы, куда выдаётся товар и от чьего имени
-- создаются заявки (user-requested list). Guarded: не дублирует уже
-- заведённые вручную отделы; дальше список редактируется в
-- Настройки → Отделы.
INSERT INTO departments (name, kind)
  SELECT 'Стационар', 'inpatient'  WHERE NOT EXISTS (SELECT 1 FROM departments WHERE name = 'Стационар');
INSERT INTO departments (name, kind)
  SELECT 'Амбулаторный', 'clinical' WHERE NOT EXISTS (SELECT 1 FROM departments WHERE name = 'Амбулаторный');
INSERT INTO departments (name, kind)
  SELECT 'Операционная', 'procedure' WHERE NOT EXISTS (SELECT 1 FROM departments WHERE name = 'Операционная');
INSERT INTO departments (name, kind)
  SELECT 'ОЦС', 'administrative' WHERE NOT EXISTS (SELECT 1 FROM departments WHERE name = 'ОЦС');
