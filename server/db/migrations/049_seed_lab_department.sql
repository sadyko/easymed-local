-- LAB_SERVICE_ROUTING_V1 — give the clinic a Laboratory department to route to.
--
-- `departments.kind` has allowed 'laboratory' and 'diagnostics' since migration
-- 011, and production easymed.uz treats department.kind='laboratory' as a PRIMARY
-- signal that a service is lab work (laboratory.js: _isLab checks
-- services.departments.kind === 'laboratory'). But migration 038 seeded only
-- Стационар / Амбулаторный / Операционная / ОЦС — so this build shipped with no
-- laboratory department at all.
--
-- The consequence was quiet and confusing: an operator following the way the
-- server works would open a service, look for the Laboratory department to put it
-- in, find none, and end up with a service the lab module could not see. The
-- panel they then linked to it did nothing, because the order never arrived.
--
-- Guarded the same way 038 guards its rows, so a clinic that already created its
-- own «Лаборатория» keeps theirs and gets no duplicate.
INSERT INTO departments (name, kind)
  SELECT 'Лаборатория', 'laboratory'
   WHERE NOT EXISTS (SELECT 1 FROM departments WHERE kind = 'laboratory')
     AND NOT EXISTS (SELECT 1 FROM departments WHERE name = 'Лаборатория');

-- Diagnostics is the other half of the same split — the panel editor has offered
-- a «Диагностика» modality since LAB_SETTINGS_V1, with no department to match.
INSERT INTO departments (name, kind)
  SELECT 'Диагностика', 'diagnostics'
   WHERE NOT EXISTS (SELECT 1 FROM departments WHERE kind = 'diagnostics')
     AND NOT EXISTS (SELECT 1 FROM departments WHERE name = 'Диагностика');

-- Any service already sitting in a laboratory department is lab work by the
-- server's rule; make the flags agree so the queue, the pickers and the reports
-- all see the same thing. Migration 048's triggers keep type/is_lab in step from
-- here on, so setting one is enough.
UPDATE services
   SET type = 'lab'
 WHERE type <> 'lab'
   AND department_id IN (SELECT id FROM departments WHERE kind = 'laboratory');
