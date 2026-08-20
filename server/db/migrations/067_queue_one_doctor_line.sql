-- QUEUE_ONE_DOCTOR_LINE_V1 — у врача ОДНА очередь на весь его день.
--
-- 066 свело диагностику одного врача в одну линию, но линий у врача осталось
-- три: приём (doc:), процедуры (proc:doc:) и диагностика (img:doc:). Каждая
-- начиналась с №1, и в живой базе у ЛОРа вышло два РАЗНЫХ пациента с талоном
-- №7 на один и тот же день: один в приёме, другой на «Кукушке». Регистратура
-- искала седьмого в колонке приёма и не находила — он стоял в соседней.
--
-- Дверь у врача одна, значит и очередь одна: аллокатор (rpc/queue.js) теперь
-- ключует ЛЮБУЮ услугу с врачом как doc:<doctor_id>:<день>.
--
-- Здесь — перенос УЖЕ ВЫДАННЫХ талонов. В отличие от 066 целевая линия НЕ
-- пуста: в ней уже сидят приёмы с номерами 1..N, поэтому переносимые талоны
-- дописываются ПОСЛЕ них (MAX + порядок), а не нумеруются заново с единицы —
-- иначе перенос сам создал бы ту самую пару одинаковых номеров, ради которой
-- всё и затевалось.
--
-- ГРАНИЦА: сегодня и будущее, как в 066. Прошлое не переписываем.
--
-- НУМЕРАЦИЯ: один номер на ПАЦИЕНТА. Если человек уже стоит в линии этого
-- врача (пришёл на приём, и ему же завели процедуру) — он остаётся со СВОИМ
-- номером, а не получает второй: это то же правило, что в аллокаторе.
-- Остальные дописываются в порядке первой заведённой строки.

WITH src AS (
  SELECT vs.id                     AS vs_id,
         vs.doctor_id              AS doctor_id,
         v.patient_id              AS patient_id,
         substr(vs.queue_key, -10) AS day
    FROM visit_services vs
    JOIN visits v ON v.id = vs.visit_id
   WHERE vs.queue_no IS NOT NULL
     AND vs.doctor_id IS NOT NULL
     AND (vs.queue_key LIKE 'proc:doc:%' OR vs.queue_key LIKE 'img:doc:%')
     AND substr(vs.queue_key, -10) GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
     AND substr(vs.queue_key, -10) >= date('now','localtime')
),
-- Пациент уже стоит в линии врача — забирает свой номер, а не новый.
reuse AS (
  SELECT s.vs_id, MIN(t.queue_no) AS n
    FROM src s
    JOIN visit_services t ON t.queue_key = 'doc:' || s.doctor_id || ':' || s.day
                         AND t.queue_no IS NOT NULL
    JOIN visits tv        ON tv.id = t.visit_id AND tv.patient_id = s.patient_id
   GROUP BY s.vs_id
),
-- Сколько мест в линии врача уже занято.
base AS (
  SELECT d.doctor_id, d.day, COALESCE(MAX(t.queue_no), 0) AS mx
    FROM (SELECT DISTINCT doctor_id, day FROM src) d
    LEFT JOIN visit_services t ON t.queue_key = 'doc:' || d.doctor_id || ':' || d.day
   GROUP BY d.doctor_id, d.day
),
rest AS (
  SELECT s.vs_id, s.doctor_id, s.day, s.patient_id,
         MIN(s.vs_id) OVER (PARTITION BY s.doctor_id, s.day, s.patient_id) AS patient_first
    FROM src s
   WHERE s.vs_id NOT IN (SELECT vs_id FROM reuse)
),
numbered AS (
  SELECT r.vs_id,
         b.mx + DENSE_RANK() OVER (PARTITION BY r.doctor_id, r.day ORDER BY r.patient_first) AS new_no
    FROM rest r
    JOIN base b ON b.doctor_id = r.doctor_id AND b.day = r.day
),
final AS (
  SELECT s.vs_id,
         'doc:' || s.doctor_id || ':' || s.day AS new_key,
         COALESCE((SELECT n      FROM reuse    WHERE reuse.vs_id    = s.vs_id),
                  (SELECT new_no FROM numbered WHERE numbered.vs_id = s.vs_id)) AS new_no
    FROM src s
)
UPDATE visit_services
   SET queue_key = (SELECT new_key FROM final f WHERE f.vs_id = visit_services.id),
       queue_no  = (SELECT new_no  FROM final f WHERE f.vs_id = visit_services.id)
 WHERE id IN (SELECT vs_id FROM final);
