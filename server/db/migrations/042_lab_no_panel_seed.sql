-- LAB_NO_PANEL_SEED_V1 — remove the seeded CBC panel fixture (user decision
-- 2026-08-08: the lab runs panel-less for now; clinics build their own panels
-- in Настройки → Лаборатория when ready).
--
-- Only the fixture rows (explicit id -41 from migration 041) are touched —
-- any panel a clinic created itself has a positive id and survives. The
-- seeded CBC *service* stays: it keeps the workflow orderable, may already be
-- referenced by orders/invoices, and result entry falls back to the
-- single-value form fed by the service's own ref fields (blank until the
-- clinic fills them — no ranges are ever shipped).
DELETE FROM lab_panel_analytes WHERE panel_id = -41;
DELETE FROM lab_panels WHERE id = -41;
