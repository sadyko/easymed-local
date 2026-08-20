-- QUEUE_IMG_DOCTOR_V1 — очередь диагностики принадлежит ВРАЧУ, а не аппарату.
--
-- Ключ выдавался как img:<service_id>:<день>, то есть отдельная линия на каждую
-- услугу. У одного УЗИ-специалиста в живой базе оказалось 18 талонов на 9 разных
-- услуг — девять параллельных очередей к одной двери, каждая со своим №1.
-- Пациенты в коридоре держали талоны 1, 1, 2, 1, 2 и никакого порядка из них не
-- следовало. Аллокатор (rpc/queue.js) теперь ключует img:doc:<doctor_id>:<день>,
-- ровно как процедуры (proc:doc:).
--
-- Здесь — перенос УЖЕ ВЫДАННЫХ талонов, иначе на переходе новый пациент получил
-- бы №1 рядом с человеком, у которого №1 уже на руках.
--
-- ГРАНИЦА: только сегодняшний день и будущие даты. Прошлое не переписываем —
-- те визиты закончились, их номера никому больше не нужны, а переписанная
-- история это переписанная история.
--
-- НУМЕРАЦИЯ: один номер на ПАЦИЕНТА (то же правило, что в аллокаторе: в одну
-- дверь человек стоит один раз, сколько бы услуг ему ни завели), порядок — по
-- первой заведённой строке, то есть в том порядке, в каком люди записывались.
--
-- Рентген (requires_doctor = 0, врача нет) под условие не попадает и остаётся
-- очередью аппарата.

WITH tgt AS (
  SELECT vs.id                      AS vs_id,
         vs.doctor_id               AS doctor_id,
         v.patient_id               AS patient_id,
         substr(vs.queue_key, -10)  AS day
    FROM visit_services vs
    JOIN visits v   ON v.id = vs.visit_id
    JOIN services s ON s.id = vs.service_id
   WHERE s.type = 'imaging'
     AND vs.doctor_id IS NOT NULL
     AND vs.queue_no IS NOT NULL
     AND vs.queue_key LIKE 'img:%'
     AND vs.queue_key NOT LIKE 'img:doc:%'
     -- Только настоящая дата в хвосте ключа: 'no-date' и прочий мусор не трогаем.
     AND substr(vs.queue_key, -10) GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
     AND substr(vs.queue_key, -10) >= date('now','localtime')
),
firsts AS (
  SELECT vs_id, doctor_id, day,
         MIN(vs_id) OVER (PARTITION BY doctor_id, day, patient_id) AS patient_first
    FROM tgt
),
numbered AS (
  SELECT vs_id,
         'img:doc:' || doctor_id || ':' || day AS new_key,
         DENSE_RANK() OVER (PARTITION BY doctor_id, day ORDER BY patient_first) AS new_no
    FROM firsts
)
UPDATE visit_services
   SET queue_key = (SELECT new_key FROM numbered n WHERE n.vs_id = visit_services.id),
       queue_no  = (SELECT new_no  FROM numbered n WHERE n.vs_id = visit_services.id)
 WHERE id IN (SELECT vs_id FROM numbered);
