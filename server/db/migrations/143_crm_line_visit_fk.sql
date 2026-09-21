-- 143_crm_line_visit_fk.sql — CRM_REAL_BOOKING_V1: ССЫЛКА НА ВИЗИТ ГАСНЕТ, А НЕ ЗАПИРАЕТ.
--
-- ЧТО СЛУЧИЛОСЬ. Миграция 142 завела crm_request_services.visit_id ссылкой без
-- ON DELETE, то есть с поведением по умолчанию — NO ACTION, а при
-- `foreign_keys = ON` (connection.js) это ЗАПРЕТ. Окно визита умеет удалять
-- визит целиком (visit-modal.js deleteVisit), и с этой ссылкой любой визит,
-- записанный колл-центром, переставал удаляться: регистратура получала
-- «FOREIGN KEY constraint failed» — сообщение, из которого не следует ничего.
--
-- Сама 142 исправлена (она ещё не выпущена ни одной клинике), но на машинах
-- разработки она УЖЕ НАКАЧЕНА, а миграции помнятся по имени файла и второй раз
-- не идут. Поэтому — отдельная миграция, и ей приходится ПЕРЕСОБИРАТЬ таблицу:
-- ALTER TABLE в SQLite не умеет менять внешний ключ.
--
-- ПОЧЕМУ ПЕРЕСБОРКА ЗДЕСЬ БЕЗОПАСНА, А В 109 БЫЛА НЕТ. Шапка миграции 109
-- описывает, как ровно эта операция уронила клинику с настоящими данными: при
-- `foreign_keys = ON` DROP TABLE делает неявное удаление строк и падает на
-- первой же ЧУЖОЙ строке, которая на таблицу ссылается (там это были визиты,
-- ссылающиеся на услугу). Обойти это внутри миграции нечем: PRAGMA
-- foreign_keys в транзакции не действует (migrate.js гоняет файл в
-- транзакции), defer_foreign_keys падает на COMMIT, legacy_alter_table тоже не
-- срабатывает.
--
-- Разница в одном: НА СТРОКИ ЗАЯВКИ НЕ ССЫЛАЕТСЯ НИ ОДНА ТАБЛИЦА. Ссылки у неё
-- только исходящие (заявка, услуга, врач, визит), а входящих нет ни одной —
-- удалять при DROP нечего, и падать нечему. Это не наблюдение на глаз: в
-- 143.test.js стоит проверка, которая обойдёт схему и упадёт в тот день, когда
-- на эту таблицу сошлётся первая чужая колонка.
--
-- ИДЕМПОТЕНТНОСТЬ. Миграция помнится по имени файла и на одной базе идёт РОВНО
-- ОДИН РАЗ. На свежей базе, где 142 уже завела гаснущую ссылку, пересборка
-- даёт тот же результат, что и был, — поэтому условие «сделать, только если
-- ссылка запрещающая» здесь не нужно и не выразимо: .sql-файл ветвиться не
-- умеет, а выигрыш был бы нулевым (строк заявок в клинике сотни, не миллионы).
-- Зато схема после обновления ОДНА И ТА ЖЕ у всех, чем бы ни была 142 на
-- конкретной машине.
--
-- Колонки перечислены целиком и дословно, включая заведённые более поздними
-- миграциями (058 — doctor_id, 142 — visit_id): пересборка обязана вернуть
-- таблицу такой же, а не такой, какой она была в 057.

CREATE TABLE crm_request_services_new (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id     INTEGER NOT NULL REFERENCES crm_requests(id) ON DELETE CASCADE,
  service_id     INTEGER REFERENCES services(id),
  scheduled_date TEXT,
  -- 'pending'  — booked, waiting for the patient
  -- 'done'     — the registrar attached it to a visit
  -- 'cancelled'— dropped before the visit
  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','done','cancelled')),
  note           TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  -- CRM_LINE_DOCTOR_V1 (миграция 058) — врач, которого пообещали по телефону.
  doctor_id      INTEGER REFERENCES users(id),
  -- CRM_REAL_BOOKING_V1 (миграция 142) — слот, который держит эта строка.
  visit_id       INTEGER REFERENCES visits(id) ON DELETE SET NULL
);

INSERT INTO crm_request_services_new
  (id, request_id, service_id, scheduled_date, status, note, created_at, doctor_id, visit_id)
SELECT id, request_id, service_id, scheduled_date, status, note, created_at, doctor_id, visit_id
  FROM crm_request_services;

DROP TABLE crm_request_services;
ALTER TABLE crm_request_services_new RENAME TO crm_request_services;

-- Индексы уходят вместе со старой таблицей и заводятся заново — теми же тремя,
-- что стояли на ней (057 и 142). Без третьего «из какой заявки эта запись»
-- снова станет полным перебором на каждую перерисовку календаря.
CREATE INDEX IF NOT EXISTS idx_crm_req_services_request ON crm_request_services(request_id);
CREATE INDEX IF NOT EXISTS idx_crm_req_services_date    ON crm_request_services(scheduled_date, status);
CREATE INDEX IF NOT EXISTS idx_crm_req_services_visit   ON crm_request_services(visit_id);
