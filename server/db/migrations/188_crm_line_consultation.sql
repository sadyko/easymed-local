-- CRM_CALENDAR_MIRROR_V1 (часть 2, 2026-09-27) — КОНСУЛЬТАЦИЯ ПО ВИДУ ПРИЁМА В ЗАЯВКЕ.
--
-- Строка визита умеет быть консультацией: service_id NULL + consultation_type_id
-- (вид приёма, цена — по ценам врача, BILLING_AUDIT_FIX_V1 B7). Строка заявки
-- этого не умела, и такая услуга записи в заявку не зеркалилась вовсе. Теперь
-- строка заявки несёт тот же вид приёма; service_id у неё тогда NULL.
ALTER TABLE crm_request_services ADD COLUMN consultation_type_id INTEGER REFERENCES consultation_types(id);
