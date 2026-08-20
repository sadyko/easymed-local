CREATE TABLE role_permissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL UNIQUE,
  permissions TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

INSERT INTO role_permissions (role, permissions) VALUES
 ('admin',     '{"sections":["dashboard","reports-hub","patients","labs","inventory","patient-documents","settings"],"levels":{"dashboard":"admin","reports-hub":"admin","patients":"admin","labs":"admin","inventory":"admin","patient-documents":"admin","settings":"admin"}}'),
 ('registrar', '{"sections":["patients","dashboard","patient-documents"],"levels":{"patients":"editor","dashboard":"viewer","patient-documents":"editor"}}'),
 ('doctor',    '{"sections":["patients","labs","dashboard","patient-documents"],"levels":{"patients":"editor","labs":"editor","dashboard":"viewer","patient-documents":"editor"}}'),
 ('cashier',   '{"sections":["patients","dashboard","reports-hub"],"levels":{"patients":"editor","dashboard":"viewer","reports-hub":"viewer"}}'),
 ('lab',       '{"sections":["labs","patients","dashboard"],"levels":{"labs":"editor","patients":"viewer","dashboard":"viewer"}}'),
 ('nurse',     '{"sections":["patients","labs","dashboard"],"levels":{"patients":"editor","labs":"viewer","dashboard":"viewer"}}'),
 ('inventory', '{"sections":["inventory","dashboard","reports-hub"],"levels":{"inventory":"editor","dashboard":"viewer","reports-hub":"viewer"}}');
