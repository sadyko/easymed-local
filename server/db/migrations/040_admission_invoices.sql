-- 040_admission_invoices.sql
-- BED_CONSOLE_V1 — стационарные счета: invoice может принадлежать
-- госпитализации (easymed's admission-modal lists invoices by admission_id).
ALTER TABLE invoices ADD COLUMN admission_id INTEGER REFERENCES admissions(id);
