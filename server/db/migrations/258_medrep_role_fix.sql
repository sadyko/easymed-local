-- FIX_318_V1 (L4, 2026-10-28) — РОЛЬ «МЕДПРЕДСТАВИТЕЛЬ»: БЕЗ ДУБЛЯ ПО ИМЕНИ И С
-- МИНИМАЛЬНЫМИ ПРАВАМИ ДО НАСТРОЙКИ.
--
-- Ревью выпуска 3.18.0. Миграция 252 заводит роль клиники medrep через
-- INSERT OR IGNORE, а он сверяет только КОД:
--   1. у клиники, уже заведшей свою роль «Медпредставитель» под другим кодом,
--      появлялась вторая роль с тем же именем — в «Ролях» и в карточке
--      сотрудника два одинаковых пункта;
--   2. своя роль без строки в role_permissions работает по своей основе
--      (roles.js rolesForPermissions: «ещё не дошли руки»), а основа medrep —
--      колл-центр: медпредставитель, которому ещё не настроили права, получал
--      весь колл-центр (CRM, пациентов, звонки).
-- 252 не правим: на базах, где она уже прошла, правка файла ничего бы не
-- исправила. Здесь:
--   1. дубль medrep убирается, если у клиники есть своя роль с этим именем под
--      другим кодом, а medrep никто не носит (ни основной, ни дополнительной
--      ролью) и прав ей не настраивали. Сотрудники своей роли клиники видны
--      экрану «Реферирование» как представители по имени роли
--      (rpc/referrals.js representativeCodes);
--   2. medrep, оставшейся без строки прав, — минимальные права: только
--      «Реферирование», просмотр. Расширяет их клиника в «Настройки → Роли».
--      Права, уже настроенные клиникой, не трогаются.
DELETE FROM custom_roles
 WHERE code = 'medrep'
   AND EXISTS (SELECT 1 FROM custom_roles o
                WHERE o.code <> 'medrep' AND trim(o.name) IN ('Медпредставитель', 'медпредставитель', 'МЕДПРЕДСТАВИТЕЛЬ'))
   AND NOT EXISTS (SELECT 1 FROM users u
                    WHERE u.custom_role_code = 'medrep' OR instr(COALESCE(u.extra_roles, ''), '"medrep"') > 0)
   AND NOT EXISTS (SELECT 1 FROM role_permissions WHERE role = 'medrep');

INSERT INTO role_permissions (role, permissions)
SELECT 'medrep', '{"sections":["referrals"],"levels":{"referrals":"viewer"},"patient_tabs":{}}'
 WHERE EXISTS (SELECT 1 FROM custom_roles WHERE code = 'medrep')
   AND NOT EXISTS (SELECT 1 FROM role_permissions WHERE role = 'medrep');
