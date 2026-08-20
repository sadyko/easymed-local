-- QUEUE_BOARD_V1 — раздел «Очередь» в клиническом блоке меню.
--
-- Номера очереди выдавались с самого начала (issue_queue_numbers, QUEUE_TICKET_V1)
-- и печатались на талоне пациента, но обратно их никто не показывал: сотрудник
-- знал очередь только по коридору. Раздел собирает те же номера в доску по
-- назначениям — врачи, процедурная, лаборатория, аппараты.
--
-- Раздел ТОЛЬКО ЧИТАЕТ: ни одной кнопки, меняющей данные, в нём нет. Поэтому
-- всем, кроме администратора, хватает уровня viewer — выдавать editor значило
-- бы обещать право, которого у раздела не существует.
--
-- Кому выдаём и почему:
--   admin      — как и всё остальное;
--   registrar  — стойка направляет пациента к нужной двери, это её работа;
--   doctor     — своя очередь: сколько человек ждёт и кто следующий;
--   nurse      — процедурная очередь ведётся ею же (PROCEDURES_V1);
--   cashier    — видит, что оплаченный талон встал в линию.
-- Call-центр раздел не получает: он работает с теми, кто ещё не в клинике.
-- Остальным выдаётся вручную в «Настройки → Роли».

UPDATE role_permissions
   SET permissions = json_set(
         json_insert(permissions, '$.sections[#]', 'queue'),
         '$.levels.queue', 'admin')
 WHERE role = 'admin'
   AND json_valid(permissions)
   AND permissions NOT LIKE '%"queue"%';

UPDATE role_permissions
   SET permissions = json_set(
         json_insert(permissions, '$.sections[#]', 'queue'),
         '$.levels.queue', 'viewer')
 WHERE role IN ('registrar', 'doctor', 'nurse', 'cashier')
   AND json_valid(permissions)
   AND permissions NOT LIKE '%"queue"%';
