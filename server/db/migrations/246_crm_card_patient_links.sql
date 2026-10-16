-- CRM_LINK_ALL_V1 (2026-10-16, повторное ревью приватности PRIV-3) — СМЕНИЛИ ПАЦИЕНТА
-- КАРТОЧКИ — ПРИВЯЗКИ «ТОЛЬКО ДЛЯ ВОРОНКИ» К ВИЗИТАМ ДРУГОГО ПАЦИЕНТА СНИМАЮТСЯ.
--
-- Привязки 'patient' (C′, P-7) и 'phone' (шаг D) карточка получает потому, что визит —
-- её пациента. Оператор понял, что карточка о другом человеке, и перевёл её на
-- пациента 78 (любой дверью: /api/db, окно карточки, API-запись) — привязки к визитам
-- пациента 77 остались, и карточка 78 показывала чужие визиты (врач, услуги), а их
-- отмена и приход двигали её ступень. Правило — здесь, у самой строки: какая бы дверь
-- ни сменила patient_id, привязки для воронки к визитам не этого пациента уходят.
-- Карточка без пациента их не держит вовсе.
--
-- Привязки колл-центра и шага C ('callcenter', 'match') — это запись, которую сделали
-- ИЗ карточки: они не снимаются (их показ и ход ступени отсекает проверка пациента в
-- crm_card_bookings и crm/visit-status.js).
--
-- Объединение пациентов (rpc/patient-merge.js) двигает visits РАНЬШЕ crm_requests:
-- к этому мигу визиты уже у оставшегося пациента, и привязки к ним не снимаются.
CREATE TRIGGER IF NOT EXISTS crm_requests_patient_display_links
AFTER UPDATE OF patient_id ON crm_requests
WHEN NEW.patient_id IS NOT OLD.patient_id
BEGIN
  DELETE FROM crm_booking_links
   WHERE request_id = NEW.id
     AND COALESCE(source, '') IN ('patient', 'phone')
     AND visit_id IN (SELECT id FROM visits WHERE patient_id IS NOT NEW.patient_id);
END;
