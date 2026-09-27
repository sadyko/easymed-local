-- CRM_CALENDAR_MIRROR_V1 (2026-09-27) — ЗАЯВКА И КАЛЕНДАРЬ — ОДНА ЗАПИСЬ.
--
-- Владелец: «they mirror each other, also the calendar. and the services».
-- Строка заявки (crm_request_services) и строка визита (visit_services) — две
-- стороны одной услуги записи. Правило сверки — server/services/crm/booking-mirror.js.
--
-- visit_service_id — какая строка визита отвечает этой строке заявки. ВНЕШНЕГО
-- КЛЮЧА НЕТ НАРОЧНО: «строка визита исчезла» — это событие (её сняли в
-- календаре или в окне визита), и зеркало должно его увидеть, а ON DELETE SET
-- NULL стёр бы след так же, как «ещё не заводили».
--
-- visit_service_auto = 1 — строку визита завело само зеркало (из записи CRM), а
-- не человек. Такую строку заменяет строка, которую в день приёма вставит
-- регистратура (подстановка заявки в смету): второй строки той же услуги не
-- бывает.
ALTER TABLE crm_request_services ADD COLUMN visit_service_id INTEGER;
ALTER TABLE crm_request_services ADD COLUMN visit_service_auto INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_crm_req_services_vs ON crm_request_services(visit_service_id);

-- Запись из календаря, привязанная к заявке, пока у неё нет ни одной строки
-- (слот поставлен, услуги ещё не выбраны). Ссылки на visits/crm_requests нет по
-- той же причине, что у crm_booking_undo (миграция 186): след не держит удаление.
CREATE TABLE crm_booking_links (
  visit_id    INTEGER PRIMARY KEY,
  request_id  INTEGER NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_crm_booking_links_request ON crm_booking_links(request_id);
