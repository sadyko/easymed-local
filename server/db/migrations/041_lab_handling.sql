-- LAB_HANDLING_V1 — laboratory workflow columns (design doc 2026-08-08 v2).
-- The handling state machine on visit_services.status:
--   added (= awaiting payment) → queued (set by record_payment)
--   → collected   («Забор пробы», stamps sample_collected_at)
--   → in_progress («В работу»)
--   → resulted    (results entered via the lab modal)
--   → completed   («Проверить и выдать», stamps verified_by/verified_at)
-- status is TEXT without CHECK, so the two new values ('collected',
-- 'resulted') need no schema change — only these columns:

ALTER TABLE visit_services ADD COLUMN sample_collected_at TEXT;
ALTER TABLE visit_services ADD COLUMN verified_by INTEGER REFERENCES users(id);
ALTER TABLE visit_services ADD COLUMN verified_at TEXT;

-- Drives the tube-colour pill in the lab queue (per-service, set in Services).
ALTER TABLE services ADD COLUMN tube_color TEXT;

-- Numeric reference range on the result row itself (local previously stored
-- only the text reference_range) — result entry writes both.
ALTER TABLE lab_results ADD COLUMN ref_low  REAL;
ALTER TABLE lab_results ADD COLUMN ref_high REAL;

-- ---------------------------------------------------------------------------
-- One CBC fixture (STRUCTURE ONLY) so the workflow is clickable on a fresh
-- install. Design rule (v2, verbatim): «Reference range values of any kind»
-- are excluded from seeds — ranges depend on the analyser and method each lab
-- uses, so EVERY range field ships NULL and the clinic fills its own numbers
-- in Настройки → Лаборатория. 041.test.js pins this guarantee.
-- Skipped entirely when ANY panel already exists (never duplicates itself).
-- NEGATIVE explicit ids: test fixtures across the suite insert services /
-- panels with explicit low positive ids (1..7) into fresh DBs — negative ids
-- can never collide with them and do not advance the AUTOINCREMENT sequence.
-- ---------------------------------------------------------------------------
INSERT INTO services (id, name, code, price, is_lab, specimen, requires_doctor, tube_color)
SELECT -41, 'Общий анализ крови (CBC)', 'LAB-CBC', 50000, 1, 'Венозная кровь (ЭДТА)', 0, 'lavender'
WHERE NOT EXISTS (SELECT 1 FROM lab_panels)
  AND NOT EXISTS (SELECT 1 FROM services WHERE code = 'LAB-CBC');

INSERT INTO lab_panels (id, name, code, modality, service_id)
SELECT -41, 'Общий анализ крови (CBC)', 'CBC', 'lab', s.id
FROM services s
WHERE s.code = 'LAB-CBC'
  AND NOT EXISTS (SELECT 1 FROM lab_panels);

INSERT INTO lab_panel_analytes (panel_id, code, name, unit, value_type, decimals, sort_order)
SELECT p.id, 'WBC', 'Лейкоциты (WBC)', '10^9/л', 'numeric', 1, 1
  FROM lab_panels p WHERE p.code = 'CBC'
   AND NOT EXISTS (SELECT 1 FROM lab_panel_analytes a WHERE a.panel_id = p.id AND a.code = 'WBC');

INSERT INTO lab_panel_analytes (panel_id, code, name, unit, value_type, decimals, sort_order)
SELECT p.id, 'RBC', 'Эритроциты (RBC)', '10^12/л', 'numeric', 2, 2
  FROM lab_panels p WHERE p.code = 'CBC'
   AND NOT EXISTS (SELECT 1 FROM lab_panel_analytes a WHERE a.panel_id = p.id AND a.code = 'RBC');

INSERT INTO lab_panel_analytes (panel_id, code, name, unit, value_type, decimals, sort_order)
SELECT p.id, 'HGB', 'Гемоглобин (HGB)', 'г/л', 'numeric', 0, 3
  FROM lab_panels p WHERE p.code = 'CBC'
   AND NOT EXISTS (SELECT 1 FROM lab_panel_analytes a WHERE a.panel_id = p.id AND a.code = 'HGB');

INSERT INTO lab_panel_analytes (panel_id, code, name, unit, value_type, decimals, sort_order)
SELECT p.id, 'HCT', 'Гематокрит (HCT)', '%', 'numeric', 1, 4
  FROM lab_panels p WHERE p.code = 'CBC'
   AND NOT EXISTS (SELECT 1 FROM lab_panel_analytes a WHERE a.panel_id = p.id AND a.code = 'HCT');

INSERT INTO lab_panel_analytes (panel_id, code, name, unit, value_type, decimals, sort_order)
SELECT p.id, 'PLT', 'Тромбоциты (PLT)', '10^9/л', 'numeric', 0, 5
  FROM lab_panels p WHERE p.code = 'CBC'
   AND NOT EXISTS (SELECT 1 FROM lab_panel_analytes a WHERE a.panel_id = p.id AND a.code = 'PLT');
