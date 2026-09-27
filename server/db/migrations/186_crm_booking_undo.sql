-- FINAL_ROLES_SYNC_FIX_V1 (M4, 2026-09-27) — ЧТО ЗАПИСЬ СДЕЛАЛА С ЗАЯВКОЙ.
--
-- ensure_visit с записью (мастер визита) двигает заявку колл-центра пациента:
-- «Новая» → «Записан», день заявки — день визита (settleCrmOnBooking,
-- rpc/visits.js). Если затем ни одна строка услуги не легла, мастер убирает
-- пустой визит (discard_empty_visit) — а заявка оставалась «Записан» на
-- визит, которого больше нет.
--
-- Здесь запись оставляет след: какая заявка, что стояло до и что поставлено.
-- discard_empty_visit возвращает заявку, если с тех пор её никто не трогал
-- (статус и день — те, что поставила запись). Следы живут недолго: удалить
-- визит этим путём можно только в первые 30 минут, поэтому строки старше суток
-- вычищает сама запись.
--
-- Ссылки на visits НЕТ нарочно: след не должен держать удаление визита.
CREATE TABLE crm_booking_undo (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  visit_id            INTEGER NOT NULL,
  request_id          INTEGER NOT NULL,
  prev_status         TEXT,
  prev_scheduled_date TEXT,
  set_status          TEXT,
  set_scheduled_date  TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_crm_booking_undo_visit ON crm_booking_undo(visit_id);
