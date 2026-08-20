-- 046_crm_pipeline.sql
-- CRM_V6 — полноценная воронка из 8 статусов вместо 4:
--   in_process (В обработке) / recall (Перезвонить) / scheduled (Записан) /
--   approved (Подтверждён) / came (Пришёл = конверсия) / no_show (Не пришёл) /
--   stopped (Обработка остановлена) / not_qualified (Нецелевой).
-- SQLite не умеет менять CHECK — пересборка таблицы с переносом данных:
--   new,in_progress -> in_process; converted -> came; rejected -> stopped.
CREATE TABLE crm_requests_v2 (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name   TEXT NOT NULL,
  phone       TEXT NOT NULL DEFAULT '',
  source      TEXT NOT NULL DEFAULT 'call'
               CHECK (source IN ('call','instagram','telegram','website','walk_in','referral','other')),
  note        TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'in_process'
               CHECK (status IN ('in_process','recall','scheduled','approved','came','no_show','stopped','not_qualified')),
  patient_id  INTEGER REFERENCES patients(id),
  assigned_to INTEGER REFERENCES users(id),
  created_by  INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  service_id  INTEGER REFERENCES services(id)
);
INSERT INTO crm_requests_v2 (id, full_name, phone, source, note, status, patient_id, assigned_to, created_by, created_at, updated_at, service_id)
SELECT id, full_name, phone, source, note,
       CASE status
         WHEN 'new'         THEN 'in_process'
         WHEN 'in_progress' THEN 'in_process'
         WHEN 'converted'   THEN 'came'
         WHEN 'rejected'    THEN 'stopped'
         ELSE 'in_process'
       END,
       patient_id, assigned_to, created_by, created_at, updated_at, service_id
FROM crm_requests;
DROP TABLE crm_requests;
ALTER TABLE crm_requests_v2 RENAME TO crm_requests;
CREATE INDEX idx_crm_requests_status ON crm_requests(status);
