-- REPORTS_AUDIT_FIX_V1 (2026-09-27) — ШТАТНЫМ КАССИРУ И СКЛАДУ — ИХ ГРУППЫ ОТЧЁТОВ.
--
-- ЧТО БЫЛО. Миграция 013 выдала штатным ролям `cashier` и `inventory` раздел
-- «Отчёты» (`reports-hub`) целиком — ради кассы и склада. С
-- ROLE_REPORTS_SETTINGS_V1 отчёты разложены по группам, но группа, которую
-- роль не настраивала, живёт ПРЕЖНИМ правилом «Отчёты выданы — видно всё».
-- Значит, штатный кассир и кладовщик видели и «Оплату врачей» — зарплаты
-- каждого врача, — и рефералы, и выручку по услугам.
--
-- ЧТО ТЕПЕРЬ. Этим двум ШТАТНЫМ ролям группы записаны явно:
--   кассир — «Выручка и счета» и «Касса»;
--   склад  — «Закупки и склад»;
-- остальные группы — «Нет». Охват Telegram-бота не трогается: у него своё
-- правило перехода (только администратор).
--
-- ЧЕГО НЕ ТРОГАЕМ. Своих ролей клиники (custom_roles) — это решение
-- заведующей, а не наше; и штатную роль, у которой в словаре grants уже есть
-- хоть один ключ «reports.…» (клиника её уже настраивала — в том числе
-- в «Нет»). Идиома — 141/144/152: json_patch дополняет grants, не трогая
-- чужих ключей; повторный накат ничего не меняет (ключи уже есть).
UPDATE role_permissions
   SET permissions = json_patch(permissions, '{"grants":{
         "reports.revenue":"view","reports.cashier":"view","reports.doctor_pay":"none",
         "reports.referrals":"none","reports.services":"none","reports.stock":"none",
         "reports.callcenter":"none"}}')
 WHERE role = 'cashier'
   AND json_valid(permissions)
   AND permissions NOT LIKE '%"reports.%';

UPDATE role_permissions
   SET permissions = json_patch(permissions, '{"grants":{
         "reports.revenue":"none","reports.cashier":"none","reports.doctor_pay":"none",
         "reports.referrals":"none","reports.services":"none","reports.stock":"view",
         "reports.callcenter":"none"}}')
 WHERE role = 'inventory'
   AND json_valid(permissions)
   AND permissions NOT LIKE '%"reports.%';
