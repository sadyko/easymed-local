-- 078_custdev.sql
-- CUSTDEV_V1 — обзвон пациентов после визита
-- (docs/specs/2026-08-25-custdev-survey-design.md).
--
-- Колл-центр звонит тем, кто ПРИШЁЛ и ОПЛАТИЛ, и оценивает три точки
-- внутреннего CJM: регистратуру, кассу и врача. Из трёх оценок статус
-- карточки складывается сам — правило живёт в services/custdev/score.js,
-- не здесь: SQL умеет хранить результат, но не объяснять его.
--
-- Таблица СОЗНАТЕЛЬНО не регистрируется в server/db/schema-registry.js.
-- Реестр раздаёт права по жёстко зашитому списку ролей, а доступ сюда
-- выдаётся галочкой в «Настройки → Роли», то есть набор ролей заранее
-- неизвестен. Открыть таблицу ALL_STAFF значило бы дать врачу читать
-- оценки о себе обычным /api/db-запросом мимо галочки. Реестр — allow-list,
-- поэтому ОТСУТСТВИЕ в нём и есть защита: тот же приём, что у
-- telephony_settings в миграции 076.

CREATE TABLE custdev_cards (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Одна карточка на ВИЗИТ. UNIQUE — это и есть идемпотентность синхронизации:
  -- повторный прогон не создаёт дубль, а не «обычно не создаёт».
  visit_id    INTEGER NOT NULL UNIQUE REFERENCES visits(id),
  patient_id  INTEGER NOT NULL REFERENCES patients(id),
  -- Снимок: доска фильтрует и сортирует по нему. Хранится в том же виде, что
  -- visits.visit_date, — полный UTC-момент, а не голая дата.
  visit_date  TEXT NOT NULL,
  -- Снимок суммы оплат по визиту. Возврат, сделанный позже, его не меняет:
  -- для опроса это неважно, а источником истины по деньгам карточка не является.
  paid_amount REAL NOT NULL DEFAULT 0,

  -- Кто обслуживал — ПОИМЁННО, снимком. Отчёт «доволен врачом» по конкретному
  -- врачу — единственная причина, по которой опрос вообще собирают.
  --
  -- ON DELETE SET NULL, а не голая ссылка: routes/users.js решает
  -- «удаляем сотрудника или нет» по жёстко зашитому списку таблиц, которого эта
  -- таблица не знает. Голый FK позволил бы объявить удаление разрешённым и
  -- умереть на нём непрозрачной пятисоткой — ловушка, описанная в 073 и 076.
  registrar_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  cashier_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  doctor_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,

  -- 'na' = «не применимо», и это не украшение. Лабораторный визит идёт без
  -- врача, бесплатная услуга — без кассира. Без 'na' такая карточка не собрала
  -- бы три «доволен» НИКОГДА и навсегда осела бы в «Частично доволен», а отчёт
  -- считал бы несуществующего врача недоработавшим.
  score_registrar TEXT NOT NULL DEFAULT 'unrated'
                    CHECK (score_registrar IN ('unrated','good','bad','na')),
  score_cashier   TEXT NOT NULL DEFAULT 'unrated'
                    CHECK (score_cashier   IN ('unrated','good','bad','na')),
  score_doctor    TEXT NOT NULL DEFAULT 'unrated'
                    CHECK (score_doctor    IN ('unrated','good','bad','na')),

  -- new/unreachable ставит человек; остальные три ВЫЧИСЛЯЮТСЯ из оценок.
  status  TEXT NOT NULL DEFAULT 'new'
            CHECK (status IN ('new','unreachable','satisfied','partial','unsatisfied')),
  comment TEXT NOT NULL DEFAULT '',

  called_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  called_at  TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE INDEX idx_custdev_status_date ON custdev_cards(status, visit_date);
CREATE INDEX idx_custdev_patient     ON custdev_cards(patient_id);

-- --------------------------------------------------------------------------
-- Право «Cust Dev» в «Настройки → Роли»
-- --------------------------------------------------------------------------
-- Тот же приём, что в 062 для «Чата с пациентами».
--
-- Выдать надо ОБЕИМ ролям явно. У callcenter есть настроенная строка прав
-- (миграция 059), а настроенная роль ограничена ровно своим списком — без
-- этих строк колл-центр не увидел бы функцию, ради которой всё написано.
--
-- Владельцу — 'admin', колл-центру — 'editor': читать отчёт и звонить это
-- разные работы. NOT LIKE защищает от задвоения при повторном накате.
UPDATE role_permissions
   SET permissions = json_set(
         json_insert(permissions, '$.sections[#]', 'custdev'),
         '$.levels.custdev', 'admin')
 WHERE role = 'admin'
   AND json_valid(permissions)
   AND permissions NOT LIKE '%"custdev"%';

UPDATE role_permissions
   SET permissions = json_set(
         json_insert(permissions, '$.sections[#]', 'custdev'),
         '$.levels.custdev', 'editor')
 WHERE role = 'callcenter'
   AND json_valid(permissions)
   AND permissions NOT LIKE '%"custdev"%';
