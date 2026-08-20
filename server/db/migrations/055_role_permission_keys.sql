-- ROLE_KEYS_V2 — repair role_permissions rows written against dead keys.
--
-- The Roles editor offered «Doctor's room» and saved the key `doctor-room`.
-- Nothing reads that key: the sidebar gates the doctor's cabinet on
-- `consultation` (admin.js NAV). So every doctor was denied their own cabinet
-- however the admin configured the role, and no amount of re-ticking could fix
-- it. The editor keys are now built from permissions.js NAV_MODULES (one source
-- of truth) — this migration repairs what the old editor already wrote.
--
-- 1. RENAME the dead key. A plain string replace over the stored JSON keeps the
--    admin's intent exactly: whoever was granted «Doctor's room» is granted the
--    cabinet, at the level they were given. Runs over `sections` and `levels`
--    alike, which is why it is done textually rather than per-array.
UPDATE role_permissions
   SET permissions = replace(permissions, '"doctor-room"', '"consultation"')
 WHERE permissions LIKE '%"doctor-room"%';

-- 2. Grant the gates no editor could offer, to the roles whose job needs them.
--    These are additive and scoped to the three roles that are blocked without
--    them; every other grant an admin has configured is left untouched.
--
--    registrar → `registration`: the «+ Новый пациент» button is gated on this
--    key (admin.js renderSidebar). No role had it, so the registrar could not
--    register a patient — the clinic's first workflow step.
UPDATE role_permissions
   SET permissions = json_set(
         json_insert(permissions, '$.sections[#]', 'registration'),
         '$.levels.registration', 'editor')
 WHERE role = 'registrar'
   AND json_valid(permissions)
   AND permissions NOT LIKE '%"registration"%';

--    registrar → `crm`: converting a lead into a patient is the registrar's
--    task; the module existed with no way to grant it.
UPDATE role_permissions
   SET permissions = json_set(
         json_insert(permissions, '$.sections[#]', 'crm'),
         '$.levels.crm', 'editor')
 WHERE role = 'registrar'
   AND json_valid(permissions)
   AND permissions NOT LIKE '%"crm"%';

--    nurse → `procedures`: the procedures queue is the nurse's screen
--    (PROCEDURES_V1) and was ungrantable.
UPDATE role_permissions
   SET permissions = json_set(
         json_insert(permissions, '$.sections[#]', 'procedures'),
         '$.levels.procedures', 'editor')
 WHERE role = 'nurse'
   AND json_valid(permissions)
   AND permissions NOT LIKE '%"procedures"%';

--    doctor → `consultation`: covers a doctor row that never had the old key at
--    all (the shipped seed in migration 013 did not include any cabinet grant),
--    so step 1's rename would leave it without one.
UPDATE role_permissions
   SET permissions = json_set(
         json_insert(permissions, '$.sections[#]', 'consultation'),
         '$.levels.consultation', 'editor')
 WHERE role = 'doctor'
   AND json_valid(permissions)
   AND permissions NOT LIKE '%"consultation"%';
