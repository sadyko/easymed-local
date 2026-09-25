-- 151_crm_merge_log.sql — CRM_HEAD_MERGE_TAGS_V1 (2026-09-25). Журнал слияния
-- дублей заявок CRM.
--
-- Владелец: «merge duplicates». Слияние УДАЛЯЕТ проигравшие карточки (их
-- услуги, задачи, заметки и метки переезжают в оставшуюся), и отменить его
-- нельзя. Поэтому каждое слияние оставляет запись: какая карточка осталась,
-- какие ушли, кто и когда это сделал и КАК ОНИ ВЫГЛЯДЕЛИ до слияния
-- (snapshot — JSON строк crm_requests вместе с номерами строк услуг, задач и
-- меток). По ней можно ответить на «куда делась заявка №123» и восстановить
-- её руками.
--
-- Без внешних ключей НАРОЧНО: журнал переживает и удалённую потом заявку, и
-- уволенного сотрудника — поэтому рядом с actor_id лежит его имя на тот день,
-- и строка журнала не мешает удалить сотрудника (routes/users.js).
--
-- В ОБМЕН МЕЖДУ ЗДАНИЯМИ НЕ ЕДЕТ: доски заявок в branch-sync нет вовсе
-- (SHIPPED), и номера заявок здесь — номера ЭТОЙ базы. Пришпилено в 151.test.js.
CREATE TABLE IF NOT EXISTS crm_merge_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kept_id     INTEGER NOT NULL,
  merged_ids  TEXT    NOT NULL,
  snapshot    TEXT    NOT NULL,
  actor_id    INTEGER,
  actor_name  TEXT,
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_crm_merge_log_kept ON crm_merge_log (kept_id);
