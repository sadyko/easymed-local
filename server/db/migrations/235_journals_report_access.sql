-- JOURNALS_V1_ACCESS (2026-10-02) — ГРУППА ОТЧЁТОВ «ЖУРНАЛЫ»: КОМУ ОТКРЫТА СРАЗУ.
--
-- Журнал услуг и реестр стационарных пациентов несут диагнозы, заключения,
-- паспорта, телефоны и оплаты пациентов. Владелец доверил настройку ролей
-- (спецификация 2026-10-02, «Права»). Группа, которую роль не настраивала,
-- живёт прежним правилом: администратор и раздел «Отчёты» (reports-hub).
--
-- ШТАТНЫЙ ГЛАВНЫЙ ВРАЧ. Раздела «Отчёты» у него нет, а медицинские журналы —
-- его работа. Ему — одна группа «Журналы: Просмотр» (как операторам 152-я
-- выдала «Колл-центр»): хаб отчётов откроется ему с двумя плитками журналов.
-- Ставится ПЕРВЫМ: правило «настроенных» ниже его уже не тронет.
--
-- РОЛИ С НАСТРОЕННЫМИ ГРУППАМИ ОТЧЁТОВ (JOURNALS_V1_RJ1, ревью п. 2). Роль, у
-- которой в правах есть хоть один ключ «reports.…» (тот же признак
-- «настроена», что у миграции 179), свои «Отчёты» сузила руками. Новая группа
-- открылась бы ей прежним правилом сама — кассиру, копии кассира, роли «только
-- Касса», копии склада, оператору колл-центра. Ей — «Журналы: Нет», ЛЮБОЙ
-- такой роли, и штатной, и своей роли клиники. Штатные кассир и склад
-- (группы записаны 179-й) попадают сюда же; их строка оставлена явной.
-- Роль без единого ключа «reports.…» живёт прежним правилом, как все группы.
--
-- ЧЕГО НЕ ТРОГАЕМ: уже записанный ключ «reports.journals» — ни у кого.
-- Идиома — 141/152/179: json_patch дополняет grants, не трогая чужих ключей;
-- повторный накат ничего не меняет (ключ уже есть).
UPDATE role_permissions
   SET permissions = json_patch(permissions, '{"grants":{"reports.journals":"view"}}')
 WHERE role = 'head_doctor'
   AND json_valid(permissions)
   AND permissions NOT LIKE '%"reports.journals"%';

UPDATE role_permissions
   SET permissions = json_patch(permissions, '{"grants":{"reports.journals":"none"}}')
 WHERE role IN ('cashier', 'inventory')
   AND json_valid(permissions)
   AND permissions NOT LIKE '%"reports.journals"%';

UPDATE role_permissions
   SET permissions = json_patch(permissions, '{"grants":{"reports.journals":"none"}}')
 WHERE json_valid(permissions)
   AND permissions LIKE '%"reports.%'
   AND permissions NOT LIKE '%"reports.journals"%';
