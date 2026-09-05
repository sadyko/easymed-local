-- PATIENT_TAB_ACCESS_V1 — привести УЖЕ СОХРАНЁННЫЕ права вкладок карты
-- пациента в согласие с самой картой.
--
-- Ничего НЕ ОТНИМАЕТ и ничего не раздаёт: сеяные роли (013/059/091) поля
-- patient_tabs не содержат вовсе, а отсутствие ключа означает полный доступ
-- (server/services/roles.js patientTabLevel и public/js/admin/permissions.js).
-- В день обновления каждая роль видит карту ровно так, как видела вчера;
-- владелец ЗАКРЫВАЕТ вкладки осознанно, в «Настройки → Роли».
--
-- Чинится ровно два расхождения, оба — то же расхождение, что чинила 055:
-- право, записанное под именем, которого никто не спрашивает, молча не
-- работает, и человек не может понять почему.

-- 1. «Деталь» звалась `overview`, а карта зовёт её `details`
--    (views/patient-card.js TABS). Ключ `overview` писал старый редактор ролей;
--    вкладка карты его не спрашивала НИКОГДА — то есть настройка «скрыть
--    Деталь» просто не действовала. Текстовая замена, как в 055: она сохраняет
--    намерение администратора дословно, вместе с уровнем.
--
--    Старое имя продолжает читаться и после переименования (роли.js
--    PATIENT_TAB_ALIASES): кабинет врача спрашивает `overview`, и ломать его
--    ради красоты ключа незачем.
UPDATE role_permissions
   SET permissions = replace(permissions, '"overview"', '"details"')
 WHERE permissions LIKE '%"overview"%';

-- 2. Уровень, которого не существует, понижается до существующего.
--
--    Редактор до сих пор предлагал «Редактирование» и «Удаление» у КАЖДОЙ
--    вкладки, включая те, где ни того, ни другого нет:
--      • «Счёт»       — счета и оплаты пишут ТОЛЬКО RPC кассы, а удаления
--                       счёта нет нигде (schema-registry.js: invoices,
--                       invoice_items, payments — delete roles: []);
--      • «Лаборатория»— результаты вносит и правит раздел «Лаборатория»
--                       (lab_results: insert/update — admin+lab), карта их
--                       только показывает;
--      • «Визиты»     — удаления визита в карте нет;
--      • «Деталь»     — удаление пациента живёт в «Настройки → Пациенты».
--    Галочка, обещающая право, которого не существует, — это не лишняя
--    строчка, а ложь экрана: администратор считает, что выдал доступ, а он не
--    работает. Хранимое значение приводится к тому, что вкладка умеет
--    (server/services/roles.js PATIENT_TAB_CAPS), и редактор больше таких
--    галочек не показывает.
--
--    Понижение НИКОМУ не сужает реальный доступ: отнимаемое право не
--    исполнялось ни одной строкой кода.
UPDATE role_permissions
   SET permissions = json_set(permissions, '$.patient_tabs.billing', 'view')
 WHERE json_valid(permissions)
   AND json_extract(permissions, '$.patient_tabs.billing') IN ('edit', 'delete');

UPDATE role_permissions
   SET permissions = json_set(permissions, '$.patient_tabs.labs', 'view')
 WHERE json_valid(permissions)
   AND json_extract(permissions, '$.patient_tabs.labs') IN ('edit', 'delete');

UPDATE role_permissions
   SET permissions = json_set(permissions, '$.patient_tabs.visits', 'edit')
 WHERE json_valid(permissions)
   AND json_extract(permissions, '$.patient_tabs.visits') = 'delete';

UPDATE role_permissions
   SET permissions = json_set(permissions, '$.patient_tabs.details', 'edit')
 WHERE json_valid(permissions)
   AND json_extract(permissions, '$.patient_tabs.details') = 'delete';
