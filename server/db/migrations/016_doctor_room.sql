-- Doctor's room (Кабинет врача) — grant the module to the doctor role by default,
-- and add it to the admin row for completeness (admin has full access regardless).
UPDATE role_permissions
SET permissions = '{"sections":["patients","doctor-room","labs","dashboard","patient-documents"],"levels":{"patients":"editor","doctor-room":"editor","labs":"editor","dashboard":"viewer","patient-documents":"editor"}}'
WHERE role = 'doctor';

UPDATE role_permissions
SET permissions = '{"sections":["dashboard","reports-hub","patients","doctor-room","labs","beds","inventory","patient-documents","cashier","cashier-head","settings"],"levels":{"dashboard":"admin","reports-hub":"admin","patients":"admin","doctor-room":"admin","labs":"admin","beds":"admin","inventory":"admin","patient-documents":"admin","cashier":"admin","cashier-head":"admin","settings":"admin"}}'
WHERE role = 'admin';
