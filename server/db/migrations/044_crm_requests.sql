-- 044_crm_requests.sql
-- CRM_V1 — простой CRM: журнал обращений (звонок/соцсети/сайт/визит) с
-- фиксированными полями; заявка конвертируется в пациента одним действием
-- (patient_id заполняется при конверсии, статус -> converted).
CREATE TABLE crm_requests (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name   TEXT NOT NULL,
  phone       TEXT NOT NULL DEFAULT '',
  source      TEXT NOT NULL DEFAULT 'call'
               CHECK (source IN ('call','instagram','telegram','website','walk_in','referral','other')),
  note        TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'new'
               CHECK (status IN ('new','in_progress','converted','rejected')),
  patient_id  INTEGER REFERENCES patients(id),
  assigned_to INTEGER REFERENCES users(id),
  created_by  INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_crm_requests_status ON crm_requests(status);
