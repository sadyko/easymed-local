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
-- custdev со строками custdev.list / custdev.rate. Эта миграция выдаёт их тем,
-- у кого эта работа есть СЕГОДНЯ, — чтобы после обновления ни у кого ничего не
-- изменилось молча.
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
-- АДМИНИСТРАТОРА ЗДЕСЬ НЕТ, и это решение. Его строка в «Настройки → Роли» не
-- редактируется (ROLE_LIST админа не содержит), поэтому матрица его роли
-- никогда не будет записана, и правило перехода действует для него вечно:
-- admin остаётся в обоих списках из кода и звонит, как звонил.

-- ---------------------------------------------------------------------------
-- 1. Оператор колл-центра: вся его работа — строками матрицы
-- ---------------------------------------------------------------------------
-- crm.calls «Просмотр» — журнал звонков в карточке заявки (rpc crm_lead_calls);
-- crm.dial «Изменение» — набор номера из программы (rpc telephony_dial);
-- crm.recording «Изменение» — прослушать запись (rpc telephony_call_recording);
-- crm.convert «Изменение» — завести пациента из заявки (ключ `registration`);
-- custdev.list / custdev.rate — обзвон после визита (миграция 078 уже выдала
-- ему раздел целиком, здесь это лишь сказано языком новой матрицы).
UPDATE role_permissions SET permissions = json_patch(permissions, '{"grants":{"crm.calls":"view"}}')
 WHERE role = 'callcenter' AND json_valid(permissions) AND permissions NOT LIKE '%"crm.calls"%';

UPDATE role_permissions SET permissions = json_patch(permissions, '{"grants":{"crm.dial":"edit"}}')
 WHERE role = 'callcenter' AND json_valid(permissions) AND permissions NOT LIKE '%"crm.dial"%';

UPDATE role_permissions SET permissions = json_patch(permissions, '{"grants":{"crm.recording":"edit"}}')
 WHERE role = 'callcenter' AND json_valid(permissions) AND permissions NOT LIKE '%"crm.recording"%';

UPDATE role_permissions SET permissions = json_patch(permissions, '{"grants":{"crm.convert":"edit"}}')
 WHERE role = 'callcenter' AND json_valid(permissions) AND permissions NOT LIKE '%"crm.convert"%';

UPDATE role_permissions SET permissions = json_patch(permissions, '{"grants":{"custdev.list":"view"}}')
 WHERE role = 'callcenter' AND json_valid(permissions) AND permissions NOT LIKE '%"custdev.list"%';

UPDATE role_permissions SET permissions = json_patch(permissions, '{"grants":{"custdev.rate":"edit"}}')
 WHERE role = 'callcenter' AND json_valid(permissions) AND permissions NOT LIKE '%"custdev.rate"%';

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
