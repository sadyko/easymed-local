-- CRM_LINK_ALL_V1 (2026-10-16, повторное ревью воронки F-10) — ВИЗИТ, КОТОРЫЙ КАРТОЧКА
-- ТОЛЬКО ПОКАЗЫВАЕТ.
--
-- Стойка закрывает карточку «Пришёл» (P-7) — карточка обязана видеть свой визит в «Записях
-- пациента» (crm_card_bookings). Привязка записи у визита одна (crm_booking_links, PRIMARY
-- KEY visit_id, миграция 187): когда визит уже держит привязка другой карточки (колл-центр
-- записал из своей), закрытая стойкой карточка не видела ничего. Эта таблица — только показ:
-- её читает одна crm_card_bookings; ни ступень, ни дату, ни строки, ни деньги она не двигает.
-- Ссылок на visits/crm_requests нет по той же причине, что у 186/187: след не держит удаление.
CREATE TABLE IF NOT EXISTS crm_card_visit_views (
  request_id  INTEGER NOT NULL,
  visit_id    INTEGER NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  PRIMARY KEY (request_id, visit_id)
);
CREATE INDEX IF NOT EXISTS idx_crm_card_visit_views_visit ON crm_card_visit_views(visit_id);
