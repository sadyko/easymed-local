-- V3121_ROLES (2026-09-28) — «ПРОСМОТР» ОТ СТАРОГО ЭКРАНА «РОЛИ» НА СТАЦИОНАРЕ И СКЛАДЕ.
--
-- ЧТО СЛУЧИЛОСЬ. Экран «Роли» версий 0.9–3.0 называл права действиями, и
-- раздел без своих действий («Стационар», «Закупки») сохранял с уровнем
-- «viewer»: уровень тогда ничего не значил. С 3.1 роль открывается матрицей, и
-- её «Сохранить» переводит старый «viewer» в явный «Просмотр» на КАЖДОМ окне
-- и действии раздела (permission-catalog.js grantsFromLegacy), а «Выписку» и
-- «Выдачу со склада», у которых просмотра нет, — в «Нет». С 3.2 сервер эти
-- ключи проверяет: медсестра не записывает измерения, не отмечает введение
-- препарата, не добавляет услугу в стационаре; склад не выдаёт со склада.
--
-- ЧТО ДЕЛАЕМ. Только у строки с ТОЧНЫМ отпечатком того перевода — старый
-- уровень раздела «viewer» и ВСЕ ключи раздела ровно такие, какими их пишет
-- grantsFromLegacy из «viewer», — ключи снимаются. Решение возвращается
-- прежнему правилу ролей в коде, то есть тому, что основа роли получает по
-- умолчанию (штатная медсестра — та же): ни одной строки выше основы, ни
-- одного ключа «только администратор» или денег. Уровень раздела ставится
-- «editor», как у штатных ролей: иначе следующее «Сохранить» на матрице снова
-- вывело бы из «viewer» тот же «Просмотр». Строку, где хоть один ключ
-- выставлен иначе (руками), не трогаем. Повторный накат ничего не меняет.

-- Стационар: разделы inpatient, mar, kitchen, discharges (старый ключ beds).
UPDATE role_permissions
   SET permissions = json_set(json_remove(permissions,
         '$.grants."inpatient"', '$.grants."inpatient.requests"', '$.grants."inpatient.patients"',
         '$.grants."inpatient.beds"', '$.grants."inpatient.history"', '$.grants."inpatient.prescriptions"',
         '$.grants."inpatient.marks"', '$.grants."inpatient.vitals"', '$.grants."inpatient.reviews"',
         '$.grants."inpatient.services"', '$.grants."inpatient.discharge"',
         '$.grants."mar"', '$.grants."mar.outpatient"', '$.grants."mar.inpatient"',
         '$.grants."kitchen"', '$.grants."discharges"'),
         '$.levels.beds', 'editor')
 WHERE role <> 'admin'
   AND json_valid(permissions)
   AND json_extract(permissions, '$.levels.beds') = 'viewer'
   AND json_extract(permissions, '$.grants."inpatient"') = 'view'
   AND json_extract(permissions, '$.grants."inpatient.requests"') = 'view'
   AND json_extract(permissions, '$.grants."inpatient.patients"') = 'view'
   AND json_extract(permissions, '$.grants."inpatient.beds"') = 'view'
   AND json_extract(permissions, '$.grants."inpatient.history"') = 'view'
   AND json_extract(permissions, '$.grants."inpatient.prescriptions"') = 'view'
   AND json_extract(permissions, '$.grants."inpatient.marks"') = 'view'
   AND json_extract(permissions, '$.grants."inpatient.vitals"') = 'view'
   AND json_extract(permissions, '$.grants."inpatient.reviews"') = 'view'
   AND json_extract(permissions, '$.grants."inpatient.services"') = 'view'
   AND json_extract(permissions, '$.grants."inpatient.discharge"') = 'none'
   AND json_extract(permissions, '$.grants."mar"') = 'view'
   AND json_extract(permissions, '$.grants."mar.outpatient"') = 'view'
   AND json_extract(permissions, '$.grants."mar.inpatient"') = 'view'
   AND json_extract(permissions, '$.grants."kitchen"') = 'view'
   AND json_extract(permissions, '$.grants."discharges"') = 'view';

-- Закупки (старый ключ inventory): «Просмотр» раздела и «Нет» у выдачи.
UPDATE role_permissions
   SET permissions = json_set(json_remove(permissions, '$.grants."procurement"', '$.grants."procurement.issue"'),
         '$.levels.inventory', 'editor')
 WHERE role <> 'admin'
   AND json_valid(permissions)
   AND json_extract(permissions, '$.levels.inventory') = 'viewer'
   AND json_extract(permissions, '$.grants."procurement"') = 'view'
   AND json_extract(permissions, '$.grants."procurement.issue"') = 'none';
