-- 039_visit_service_notes.sql
-- WS_NOTES_V1 — easymed's service workspace keeps the consultation document
-- (draft + signed history) as a JSON blob in visit_services.notes
-- (readPayload/writePayload in service-workspace.js). The local table lacked
-- the column, so saving threw «no writable columns provided».
ALTER TABLE visit_services ADD COLUMN notes TEXT;
