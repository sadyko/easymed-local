-- SERVICE_GROUPS_V1 — link every service to a service_type.
--
-- `services.type` (the routing column: consultation | lab | procedure | imaging
-- | radiology | other) is populated for all 513 services and CHECK-constrained
-- by migration 023. `services.type_id` — the FK to the `service_types` rows that
-- Settings → «Типы услуг» manages — was NULL for every one of them.
--
-- Every grouping UI keys off type_id: the recommend picker builds its chips from
-- services.type_id -> service_types(name), the service picker filters by
-- comparing svc.type_id to the selected group id, and the consultation's
-- «Вставить результаты» buckets rows by service_types.name / departments.kind.
-- With type_id NULL those all collapse: one «Прочее» chip, an empty list on
-- every group click, and lab results that never route to the lab branch. The
-- five service_types rows existed the whole time with nothing pointing at them.
--
-- The mapping is the one the client already uses (SERVICE_TYPES in services.js /
-- visit-wizard.js). It was checked against the live catalogue before writing:
--   other   (158) -> Хирургия      — лапароскопия, уретропластика, TVT-O …
--   imaging (159) -> Диагностика   — УЗИ, ЭКГ, нейросонография …
--   lab      (86) -> Лаборатория   — agrees with is_lab on all 513 rows
--   procedure(79) -> Процедуры
--   consultation(31) -> Консультации
--
-- Only NULL type_id is touched, so a service an admin has already classified by
-- hand keeps its group, and re-running changes nothing.

-- The five (six with radiology) types must exist before anything can point at
-- them. Matching by NAME, not by a hardcoded id: the seeded ids are not
-- guaranteed on a database where an admin has added or removed types.
INSERT INTO service_types (name, active)
  SELECT 'Консультации', 1 WHERE NOT EXISTS (SELECT 1 FROM service_types WHERE name = 'Консультации');
INSERT INTO service_types (name, active)
  SELECT 'Лаборатория', 1 WHERE NOT EXISTS (SELECT 1 FROM service_types WHERE name = 'Лаборатория');
INSERT INTO service_types (name, active)
  SELECT 'Процедуры', 1 WHERE NOT EXISTS (SELECT 1 FROM service_types WHERE name = 'Процедуры');
INSERT INTO service_types (name, active)
  SELECT 'Диагностика', 1 WHERE NOT EXISTS (SELECT 1 FROM service_types WHERE name = 'Диагностика');
INSERT INTO service_types (name, active)
  SELECT 'Хирургия', 1 WHERE NOT EXISTS (SELECT 1 FROM service_types WHERE name = 'Хирургия');
INSERT INTO service_types (name, active)
  SELECT 'Лучевая диагностика', 1 WHERE NOT EXISTS (SELECT 1 FROM service_types WHERE name = 'Лучевая диагностика');

UPDATE services SET type_id = (SELECT id FROM service_types WHERE name = 'Консультации')
 WHERE type_id IS NULL AND type = 'consultation';
UPDATE services SET type_id = (SELECT id FROM service_types WHERE name = 'Лаборатория')
 WHERE type_id IS NULL AND type = 'lab';
UPDATE services SET type_id = (SELECT id FROM service_types WHERE name = 'Процедуры')
 WHERE type_id IS NULL AND type = 'procedure';
UPDATE services SET type_id = (SELECT id FROM service_types WHERE name = 'Диагностика')
 WHERE type_id IS NULL AND type = 'imaging';
UPDATE services SET type_id = (SELECT id FROM service_types WHERE name = 'Лучевая диагностика')
 WHERE type_id IS NULL AND type = 'radiology';
UPDATE services SET type_id = (SELECT id FROM service_types WHERE name = 'Хирургия')
 WHERE type_id IS NULL AND type = 'other';

-- Safety net: a service whose `type` is somehow outside the CHECK set (or NULL
-- on a pre-023 row) still gets a group rather than falling into the invisible
-- bucket the UI cannot show.
UPDATE services SET type_id = (SELECT id FROM service_types WHERE name = 'Консультации')
 WHERE type_id IS NULL;
