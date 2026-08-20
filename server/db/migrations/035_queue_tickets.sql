-- 035_queue_tickets.sql
-- QUEUE_TICKET_V1 (local port of easymed's 122_service_queue_tickets) — each
-- registered service line can carry a queue ticket: queue_key names the
-- DESTINATION+day the number was counted against, queue_no is the place in
-- that line. Assigned atomically by the issue_queue_numbers RPC; a number
-- belongs to a destination (per-doctor / lab / procedures room / apparatus),
-- services to one destination share one number, reprints reuse it.
ALTER TABLE visit_services ADD COLUMN queue_key TEXT;
ALTER TABLE visit_services ADD COLUMN queue_no INTEGER;
CREATE INDEX idx_visit_services_queue ON visit_services(queue_key, queue_no);
