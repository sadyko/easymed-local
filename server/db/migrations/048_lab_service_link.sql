-- LAB_SERVICE_LINK_V1 — make "this service is a lab test" mean ONE thing, and
-- make a service↔panel link unambiguous.
--
-- THE BUG THIS FIXES
-- `services` carries two answers to the same question:
--   * `is_lab`  (migration 006) — read by the lab queue, patient documents,
--                doctor's room and the visit wizard
--   * `type`    (migration 022) — written by Settings → Услуги, whose dropdown
--                offers «Лаборатория (лаб. модуль)»
-- Migration 022 backfilled `type` from `is_lab` ONCE and left no trigger, and the
-- two editors each write only their own column. So they drifted: in the live
-- database a service marked «Лаборатория» in the UI still had is_lab=0 and was
-- invisible to the laboratory screen, while the seeded CBC had is_lab=1 but
-- type='consultation'. Linking a panel to such a service achieved nothing,
-- because the order never reached the lab.
--
-- THE FIX
-- Reconcile the existing rows, then keep them in step with triggers so it cannot
-- drift again no matter which screen does the writing. `type` is the richer
-- column (five values, CHECK-constrained) so it is treated as the authority:
-- is_lab simply mirrors "type = 'lab'".

-- ── 1. reconcile what has already drifted ────────────────────────────────────
UPDATE services SET is_lab = 1 WHERE type = 'lab'  AND is_lab <> 1;
UPDATE services SET type = 'lab' WHERE is_lab = 1 AND type <> 'lab';

-- ── 2. keep them in step from either direction ───────────────────────────────
-- Two triggers rather than one: SQLite fires AFTER UPDATE OF <col> only for the
-- named columns, so each editor's write is caught by its own trigger. The WHEN
-- clauses make both idempotent — the update they perform cannot re-trigger the
-- other one into a loop, because it only writes when the value actually differs.

DROP TRIGGER IF EXISTS services_type_syncs_is_lab;
CREATE TRIGGER services_type_syncs_is_lab
AFTER UPDATE OF type ON services
FOR EACH ROW
WHEN (NEW.type = 'lab') <> (NEW.is_lab = 1)
BEGIN
  UPDATE services SET is_lab = CASE WHEN NEW.type = 'lab' THEN 1 ELSE 0 END
   WHERE id = NEW.id;
END;

DROP TRIGGER IF EXISTS services_is_lab_syncs_type;
CREATE TRIGGER services_is_lab_syncs_type
AFTER UPDATE OF is_lab ON services
FOR EACH ROW
WHEN (NEW.is_lab = 1) <> (NEW.type = 'lab')
BEGIN
  -- Leaving lab returns the service to the default type rather than guessing at
  -- what it used to be; the clinic re-picks it in Settings if it was something else.
  UPDATE services SET type = CASE WHEN NEW.is_lab = 1 THEN 'lab' ELSE 'consultation' END
   WHERE id = NEW.id;
END;

-- New rows too: an INSERT that sets only one of the pair must not start out split.
DROP TRIGGER IF EXISTS services_insert_syncs_lab;
CREATE TRIGGER services_insert_syncs_lab
AFTER INSERT ON services
FOR EACH ROW
WHEN (NEW.type = 'lab') <> (NEW.is_lab = 1)
BEGIN
  UPDATE services
     SET is_lab = CASE WHEN NEW.type = 'lab' THEN 1 ELSE NEW.is_lab END,
         type   = CASE WHEN NEW.is_lab = 1   THEN 'lab' ELSE NEW.type END
   WHERE id = NEW.id;
END;

-- ── 3. one panel per service ─────────────────────────────────────────────────
-- Result entry resolves visit_service → service → panel. Two panels claiming one
-- service makes that resolution arbitrary, so the database refuses it. PARTIAL,
-- because an unlinked panel (service_id NULL) is a legitimate work-in-progress and
-- several may exist at once.
DELETE FROM lab_panels
 WHERE service_id IS NOT NULL
   AND id NOT IN (SELECT MIN(id) FROM lab_panels WHERE service_id IS NOT NULL GROUP BY service_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_lab_panels_service_unique
  ON lab_panels(service_id) WHERE service_id IS NOT NULL;
