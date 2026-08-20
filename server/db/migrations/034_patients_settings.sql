-- 034_patients_settings.sql
-- PATIENTS_SECTION_V1 — columns easymed's Settings → Пациенты section
-- (sections.js `patients` spec: form fields + list columns) reads and writes,
-- so the section-CRUD register runs unmodified on the local backend.
ALTER TABLE patients ADD COLUMN marital_status TEXT;
ALTER TABLE patients ADD COLUMN emergency_contact_relation TEXT;
ALTER TABLE patients ADD COLUMN payer_policy_id INTEGER REFERENCES payer_policies(id);
ALTER TABLE patients ADD COLUMN insurance_policy_number TEXT;
ALTER TABLE patients ADD COLUMN insurance_expiry_date TEXT;

-- MRN autogen: COUNT(*)-based numbering collides the moment rows with
-- EXPLICIT MRNs exist (the Excel importer brings them in): count 1 ->
-- 'P-26-00001' duplicates an imported 'P-26-00001'. Renumber from the MAX
-- numeric suffix + 1 instead — always past every imported number.
DROP TRIGGER IF EXISTS patients_mrn_autogen;
CREATE TRIGGER patients_mrn_autogen AFTER INSERT ON patients
WHEN NEW.mrn IS NULL
BEGIN
  UPDATE patients
     SET mrn = 'P-' || substr(strftime('%Y','now'), 3, 2) || '-' ||
               substr('00000' || (
                 SELECT COALESCE(MAX(CAST(substr(mrn, 6) AS INTEGER)), 0) + 1
                   FROM patients
                  WHERE mrn LIKE 'P-' || substr(strftime('%Y','now'), 3, 2) || '-%'
               ), -5)
   WHERE id = NEW.id;
END;
