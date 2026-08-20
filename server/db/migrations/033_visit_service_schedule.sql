-- SCHED_V1 — per-line appointment time for the visit wizard: each service in a
-- visit can book its own slot with its own doctor (easymed-style inline
-- scheduler). Nullable — existing rows and non-scheduled lines keep NULL;
-- the visit's own visit_date remains the visit-level anchor.
ALTER TABLE visit_services ADD COLUMN scheduled_at TEXT;
