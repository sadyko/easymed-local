-- CALLCENTER_OPERATOR_V1 (2026-09-21) — РАБОТА ОПЕРАТОРА КОЛЛ-ЦЕНТРА СТАНОВИТСЯ ПРАВАМИ.
--
-- Владелец: сделать оператора колл-центра полноценной ролью — не только доской
-- заявок, а тем, что он на ней ДЕЛАЕТ: звонит, слушает записи, ведёт Cust Dev,
-- заводит пациента из заявки.
--
-- ЧТО БЫЛО. Доска выдавалась галочкой `crm` (миграция 059), а всё остальное
-- решал КОД списками ролей: DIAL_ROLES и CALL_LOG_ROLES в
-- server/services/rpc/telephony.js — ['admin','registrar','callcenter']. Экран
-- «Роли» об этих списках не знал: заведующая видела «CRM · Заявки: изменение» и
-- не могла ни узнать, что за этой строкой ещё и право позвонить и прослушать
-- чужой разговор, ни выдать это право своей роли клиники, ни отнять.
--
-- Заведение карты было сломано иначе и заметнее: сервер оператору это ВСЕГДА
-- разрешал (реестр таблиц, schema-registry.js — вставка в patients открыта
-- callcenter), а оболочка отказывала, потому что ключ `registration` выдан
-- только регистратуре (миграция 055). Оператор разговаривал с человеком и не
-- мог завести ему карту — ради чего и звонил.
--
-- ЧТО ТЕПЕРЬ. У справочника прав (public/js/shared/permission-catalog.js)
-- появились строки crm.calls / crm.dial / crm.recording / crm.convert и раздел
-- custdev со строками custdev.list / custdev.rate. Эта миграция выдаёт ЧЕТЫРЕ
-- первые тем, у кого эта работа есть СЕГОДНЯ, и закрывает их явным «Нет» у
-- всех остальных, — чтобы после обновления ни у кого ничего не изменилось
-- молча. Строки custdev.* она не трогает вовсе: почему — в разделе 1.
--
-- ПОЧЕМУ ВООБЩЕ НАДО ВЫДАВАТЬ, если ворота и так живут правилом перехода
-- (grants.js: ключ не настроен — решает прежний список ролей). Потому что
-- правило перехода защищает только ДО первой настройки. Клиника, открывшая
-- «Настройки → Роли» и нажавшая «Сохранить роль», записывает матрицу целиком —
-- и с этого мига прежние списки для этой роли молчат. Выданный ключ переживает
-- такое сохранение, невыданный — нет.
--
-- ИДИОМА — 062/078/092, с одной поправкой. Там json_insert в массив sections;
-- здесь словарь grants, которого у роли может не быть вовсе, а json_set
-- промежуточный объект не создаёт. json_patch (слияние по RFC 7386) создаёт
-- `grants`, если его нет, и ДОПОЛНЯЕТ, если есть, не трогая чужие ключи.
-- Защита та же: NOT LIKE по имени ключа — повторный накат и клиника, уже
-- настроившая этот ключ руками, ничего не получают заново.
--
-- ЗАЧЕМ ЗАПИСЫВАТЬ «НЕТ» ТЕМ, КОМУ НИЧЕГО НЕ ВЫДАЁМ (раздел 3). По той же
-- причине, только с другой стороны. Экран достраивает КАЖДЫЙ ненастроенный
-- ключ из старых полей (roles-matrix.js grantsFromLegacy: «раздел выдан —
-- значит, внутри доступно всё»), а старая галочка `crm` значила ДОСКУ ЗАЯВОК и
-- никогда — право позвонить и прослушать чужой разговор: это решал список
-- ролей в коде. Оставь ключи пустыми — и первое же «Сохранить роль» у любой
-- роли с доской CRM (врач, медсестра, своя роль клиники) молча выдало бы ей
-- телефон. Явное «Нет» не отнимает ничего: этих прав у них нет и сегодня.
--
-- АДМИНИСТРАТОРА ЗДЕСЬ НЕТ, и это решение. Его строка в «Настройки → Роли» не
-- редактируется (ROLE_LIST админа не содержит), поэтому матрица его роли
-- никогда не будет записана; а ворота пускают администратора отдельным
-- правилом (grants.js isAdminUser) — в том числе администратора-врача, у
-- которого основная роль `doctor` и чьё «Нет» из раздела 3 иначе заперло бы
-- заведующего без телефона (ADMIN_DOCTOR_V1).

-- ---------------------------------------------------------------------------
-- 1. Оператор колл-центра: вся его работа — строками матрицы
-- ---------------------------------------------------------------------------
-- crm.calls «Просмотр» — журнал звонков в карточке заявки (rpc crm_lead_calls);
-- crm.dial «Изменение» — набор номера из программы (rpc telephony_dial);
-- crm.recording «Изменение» — прослушать запись (rpc telephony_call_recording);
-- crm.convert «Изменение» — завести пациента из заявки (ключ `registration`).
--
-- CUST DEV ЗДЕСЬ НЕТ НАМЕРЕННО. Раздел выдан оператору старой галочкой
-- (миграция 078), и его ворота живут тем же правилом перехода — пока ключ не
-- настроен, решает галочка. Выдай мы `custdev.rate: edit` — и решение клиники,
-- понизившей оператора до просмотра, было бы молча отменено: настроенный ключ
-- старую галочку перебивает. Строки custdev.* существуют на экране, чтобы их
-- можно было настроить; выдавать их обновлением незачем и нельзя.
UPDATE role_permissions SET permissions = json_patch(permissions, '{"grants":{"crm.calls":"view"}}')
 WHERE role = 'callcenter' AND json_valid(permissions) AND permissions NOT LIKE '%"crm.calls"%';

UPDATE role_permissions SET permissions = json_patch(permissions, '{"grants":{"crm.dial":"edit"}}')
 WHERE role = 'callcenter' AND json_valid(permissions) AND permissions NOT LIKE '%"crm.dial"%';

UPDATE role_permissions SET permissions = json_patch(permissions, '{"grants":{"crm.recording":"edit"}}')
 WHERE role = 'callcenter' AND json_valid(permissions) AND permissions NOT LIKE '%"crm.recording"%';

UPDATE role_permissions SET permissions = json_patch(permissions, '{"grants":{"crm.convert":"edit"}}')
 WHERE role = 'callcenter' AND json_valid(permissions) AND permissions NOT LIKE '%"crm.convert"%';

-- ---------------------------------------------------------------------------
-- 2. Регистратура — ровно то, что у неё есть сегодня, и ни ключом больше
-- ---------------------------------------------------------------------------
-- Регистратура стоит в обоих списках из кода: она звонит, видит журнал и
-- слушает записи. Эти три ключа записываются ей ЯВНО, чтобы сохранение её роли
-- на экране не могло когда-нибудь отнять телефон: `crm.convert` ей не нужен —
-- ключ `registration` у неё свой с миграции 055, и правило перехода его
-- сохраняет.
UPDATE role_permissions SET permissions = json_patch(permissions, '{"grants":{"crm.calls":"view"}}')
 WHERE role = 'registrar' AND json_valid(permissions) AND permissions NOT LIKE '%"crm.calls"%';

UPDATE role_permissions SET permissions = json_patch(permissions, '{"grants":{"crm.dial":"edit"}}')
 WHERE role = 'registrar' AND json_valid(permissions) AND permissions NOT LIKE '%"crm.dial"%';

UPDATE role_permissions SET permissions = json_patch(permissions, '{"grants":{"crm.recording":"edit"}}')
 WHERE role = 'registrar' AND json_valid(permissions) AND permissions NOT LIKE '%"crm.recording"%';

-- ---------------------------------------------------------------------------
-- 3. Всем остальным — явное «Нет», чтобы первое сохранение никому не расширило
-- ---------------------------------------------------------------------------
-- См. шапку: ненастроенный ключ экран достраивает из старой галочки раздела, а
-- она этих прав никогда не значила. Роль, у которой ключ УЖЕ настроен (клиника
-- решила сама, или это повторный накат), не трогается — тот же NOT LIKE.
--
-- РОЛЬ, У КОТОРОЙ НАСТРОЕК НЕТ ВОВСЕ, ПРОПУСКАЛАСЬ МОЛЧА — и оставалась
-- открытой для расширения ровно в том смысле, ради которого этот раздел и
-- написан. json_valid(NULL) и json_valid('') истиной не бывают, а `permissions
-- NOT LIKE …` по NULL и вовсе NULL: строка, которую завели, а матрицу ни разу
-- не трогали, не получала ни одного «Нет». COALESCE(NULLIF(...), '{}') читает
-- такую строку как пустой словарь — это и есть правда о ней. Строку с
-- ИСПОРЧЕННЫМ содержимым (не JSON) миграция по-прежнему не трогает, и это
-- решение: json_patch по не-JSON вернул бы NULL и стёр бы то немногое, что там
-- лежит; такую строку чинит человек, а не обновление.
--
-- СВОИ РОЛИ КЛИНИКИ (CUSTOM_ROLES_V1) ПОПАДАЮТ СЮДА ПО ОСНОВЕ, а не по имени:
-- имён их никто заранее не знает, а звонит роль сегодня ровно потому, что её
-- ОСНОВА стоит в списках из кода (hasAnyRole смотрит users.role, то есть
-- основу). Поэтому «Старший регистратор» на основе регистратуры не трогается —
-- у него это право есть, — а «Старшая смена» на основе врача закрывается, как
-- и сам врач. Роль, заведённая ПОСЛЕ обновления, берёт права своей основы
-- копией (roles-editor.js createRole), то есть получает то же «Нет» сама.
UPDATE role_permissions SET permissions = json_patch(COALESCE(NULLIF(permissions, ''), '{}'), '{"grants":{"crm.calls":"none"}}')
 WHERE json_valid(COALESCE(NULLIF(permissions, ''), '{}')) AND COALESCE(permissions, '') NOT LIKE '%"crm.calls"%'
   AND role NOT IN ('admin', 'registrar', 'callcenter')
   AND role NOT IN (SELECT code FROM custom_roles WHERE base_role IN ('admin', 'registrar', 'callcenter'));

UPDATE role_permissions SET permissions = json_patch(COALESCE(NULLIF(permissions, ''), '{}'), '{"grants":{"crm.dial":"none"}}')
 WHERE json_valid(COALESCE(NULLIF(permissions, ''), '{}')) AND COALESCE(permissions, '') NOT LIKE '%"crm.dial"%'
   AND role NOT IN ('admin', 'registrar', 'callcenter')
   AND role NOT IN (SELECT code FROM custom_roles WHERE base_role IN ('admin', 'registrar', 'callcenter'));

UPDATE role_permissions SET permissions = json_patch(COALESCE(NULLIF(permissions, ''), '{}'), '{"grants":{"crm.recording":"none"}}')
 WHERE json_valid(COALESCE(NULLIF(permissions, ''), '{}')) AND COALESCE(permissions, '') NOT LIKE '%"crm.recording"%'
   AND role NOT IN ('admin', 'registrar', 'callcenter')
   AND role NOT IN (SELECT code FROM custom_roles WHERE base_role IN ('admin', 'registrar', 'callcenter'));

-- `crm.convert` — то же самое, и «Нет» по нему НИЧЕГО не отнимает: оболочка
-- спрашивает новый ключ ТОЛЬКО как прибавку, а отказ по нему возвращает
-- вопрос прежнему ключу `registration` (permissions.js canCreatePatient).
UPDATE role_permissions SET permissions = json_patch(COALESCE(NULLIF(permissions, ''), '{}'), '{"grants":{"crm.convert":"none"}}')
 WHERE json_valid(COALESCE(NULLIF(permissions, ''), '{}')) AND COALESCE(permissions, '') NOT LIKE '%"crm.convert"%'
   AND role NOT IN ('admin', 'registrar', 'callcenter')
   AND role NOT IN (SELECT code FROM custom_roles WHERE base_role IN ('admin', 'registrar', 'callcenter'));
