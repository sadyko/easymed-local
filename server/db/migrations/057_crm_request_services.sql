-- CRM_MULTI_SERVICE_V1 — a call-centre request may cover SEVERAL services, each
-- booked for its own date.
--
-- `crm_requests` carries one `service_id` and one `scheduled_date`, so a patient
-- calling to book three things needed three separate leads — and the registrar
-- picking them up on the day saw them as three unrelated requests. The services
-- move to a child table; each line owns its date, so «УЗИ on the 20th, анализы
-- on the 21st» is one request.
--
-- The parent columns are LEFT IN PLACE and kept in sync with the first line
-- (see the client's persist()): the kanban card, the Excel export and the
-- existing `services` embed all read crm_requests.service_id, and rewriting
-- every one of them is a bigger change than this table earns. Nothing reads the
-- parent columns as the authoritative list any more — that is this table.

CREATE TABLE crm_request_services (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id     INTEGER NOT NULL REFERENCES crm_requests(id) ON DELETE CASCADE,
  service_id     INTEGER REFERENCES services(id),
  scheduled_date TEXT,
  -- 'pending'  — booked, waiting for the patient
  -- 'done'     — the registrar attached it to a visit
  -- 'cancelled'— dropped before the visit
  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','done','cancelled')),
  note           TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- The registrar's lookup is «this patient, this day», which reaches this table
-- through request_id; the date is the selective half of it.
CREATE INDEX idx_crm_req_services_request ON crm_request_services(request_id);
CREATE INDEX idx_crm_req_services_date    ON crm_request_services(scheduled_date, status);

-- Carry existing single-service requests across so nothing booked before this
-- migration is lost to the registrar. Only rows that actually name a service.
INSERT INTO crm_request_services (request_id, service_id, scheduled_date, status)
SELECT r.id, r.service_id, r.scheduled_date,
       CASE
         WHEN r.status = 'came' THEN 'done'
         WHEN r.status IN ('no_show','stopped','not_qualified') THEN 'cancelled'
         ELSE 'pending'
       END
  FROM crm_requests r
 WHERE r.service_id IS NOT NULL;
