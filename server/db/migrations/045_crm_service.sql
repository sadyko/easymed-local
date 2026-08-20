-- 045_crm_service.sql
-- CRM_V3 — интересующая услуга на заявке: что спрашивает пациент.
ALTER TABLE crm_requests ADD COLUMN service_id INTEGER REFERENCES services(id);
