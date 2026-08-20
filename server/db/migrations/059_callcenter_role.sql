-- CALLCENTER_ROLE_V1 — the call centre becomes a role of its own.
--
-- Until now there was none. The clinic ran the phone desk on the 'inventory'
-- (склад) role and granted it the `crm` section by hand in Settings → Роли.
-- That opened the board and nothing else: crm_requests.read is ALL_STAFF, so
-- the kanban rendered, while every write stayed hard-coded to
-- ['admin','registrar'] in the schema registry — which role_permissions cannot
-- reach. The operator filled «Даты приёма» and got a bare «not allowed».
--
-- The other half of the workaround was worse: one account carried 'registrar'
-- in «Дополнительные роли», which hands a phone operator patients, visits and
-- invoices in full.
--
-- A role with no row here sees no sections at all, so the grant ships with the
-- role rather than being rebuilt by hand in every install. INSERT OR IGNORE
-- keeps the runner's re-run a no-op against role.UNIQUE.
INSERT OR IGNORE INTO role_permissions (role, permissions) VALUES
 ('callcenter', '{"sections":["crm","dashboard"],"levels":{"crm":"admin","dashboard":"viewer"}}');
