-- 077_crm_config.sql
-- CRM_CONFIG_V1 — колонки канбана, источники и маршрутизация звонков
-- становятся ДАННЫМИ (docs/plans/2026-08-24-crm-kanban-settings.md).
--
-- До сих пор обе номенклатуры были зашиты дважды: в CHECK-ограничениях
-- crm_requests (mig 044/046) и в массивах STATUSES/SOURCES в views/crm.js.
-- Добавить колонку «Ждёт оплаты» значило выпустить релиз. Теперь это строка
-- в таблице.
--
-- Три вещи ОСТАЮТСЯ поведением, а не подписью, и потому переезжают в
-- crm_stages.kind, а не в свободный текст:
--   won  — конверсия (сегодня 'came'): единственный путь, который заводит
--          карту пациента. Ровно одна такая колонка — частичный UNIQUE ниже.
--   lost — LOST_STATUSES воронки.
--   open — ACTIVE_STATUSES воронки.
-- Переименовать «Пришёл» в «Дошёл» можно; сделать две конверсии — нет.

-- --------------------------------------------------------------------------
-- Колонки канбана
-- --------------------------------------------------------------------------
CREATE TABLE crm_stages (
  -- Ключ попадает в crm_requests.status, в фильтры и в URL, поэтому набор
  -- символов узкий и проверяется ещё и на сервере (services/crm/config.js).
  key       TEXT PRIMARY KEY,
  label     TEXT NOT NULL,
  -- НЕ свободный hex: это имена токенов Tag() из public/js/admin/ui.js.
  -- Доска должна остаться в домашней палитре, что бы ни выбрал владелец в
  -- настройках — цвет-пипетка через месяц превращает канбан в радугу.
  -- '' = без цвета (именно так сегодня выглядят «Обработка остановлена» и
  -- «Нецелевой» в views/crm.js).
  color     TEXT NOT NULL DEFAULT ''
             CHECK (color IN ('info','warn','purple','teal','ok','crit','')),
  position  INTEGER NOT NULL DEFAULT 0,
  -- Колонку, в которой уже лежат заявки, УДАЛИТЬ нельзя — только спрятать:
  -- иначе у существующих карточек остался бы статус, которого нет. Запрет
  -- живёт в services/crm/config.js, здесь — само поле.
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  kind      TEXT NOT NULL DEFAULT 'open' CHECK (kind IN ('open','won','lost'))
);

-- Сегодняшние 8 колонок из views/crm.js — те же ключи, те же подписи, те же
-- цвета, тот же порядок. Это условие «доска выглядит ровно так же в момент
-- накатывания миграции», а не косметика.
INSERT INTO crm_stages (key, label, color, position, is_active, kind) VALUES
  ('in_process',    'В обработке',           'info',   1, 1, 'open'),
  ('recall',        'Перезвонить',           'warn',   2, 1, 'open'),
  ('scheduled',     'Записан',               'purple', 3, 1, 'open'),
  ('approved',      'Подтверждён',           'teal',   4, 1, 'open'),
  ('came',          'Пришёл',                'ok',     5, 1, 'won'),
  ('no_show',       'Не пришёл',             'crit',   6, 1, 'lost'),
  ('stopped',       'Обработка остановлена', '',       7, 1, 'lost'),
  ('not_qualified', 'Нецелевой',             '',       8, 1, 'lost');

-- Ровно одна колонка-конверсия. Не проверка в коде, а ограничение схемы:
-- конверсия открывает попап регистрации пациента, и две таких колонки — это
-- развилка, у которой нет хозяина. Частичный индекс, потому что колонок
-- 'open' и 'lost' может быть сколько угодно.
CREATE UNIQUE INDEX crm_stages_one_won ON crm_stages(kind) WHERE kind = 'won';

-- --------------------------------------------------------------------------
-- Источники
-- --------------------------------------------------------------------------
CREATE TABLE crm_sources (
  key       TEXT PRIMARY KEY,
  label     TEXT NOT NULL,
  position  INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1))
);

-- Сегодняшние 7 из views/crm.js + 'telephony': строка, под которой падают
-- лиды, созданные из звонка (crm_call_routing ниже). 'call' — это «позвонили,
-- оператор завёл руками», 'telephony' — «АТС сообщила о звонке сама»; смешав
-- их, отчёт по источникам перестал бы отвечать на вопрос «что даёт АТС».
INSERT INTO crm_sources (key, label, position, is_active) VALUES
  ('call',      'Звонок',       1, 1),
  ('instagram', 'Instagram',    2, 1),
  ('telegram',  'Telegram',     3, 1),
  ('website',   'Сайт',         4, 1),
  ('walk_in',   'Пришёл сам',   5, 1),
  ('referral',  'Рекомендация', 6, 1),
  ('other',     'Другое',       7, 1),
  ('telephony', 'Телефония',    8, 1);

-- --------------------------------------------------------------------------
-- Звонок -> карточка
-- --------------------------------------------------------------------------
-- Словарь disposition — вендорский (Binotel), хранится как есть, ровно как в
-- calls.disposition (mig 076). Таблица отвечает на один вопрос: «звонок с
-- таким исходом — это лид, и если да, в какую колонку».
CREATE TABLE crm_call_routing (
  -- Колонка, а не константа: второй вендор АТС когда-нибудь — это данные,
  -- а не миграция (то же решение, что telephony_settings.provider).
  provider    TEXT NOT NULL DEFAULT 'binotel',
  disposition TEXT NOT NULL,
  action      TEXT NOT NULL DEFAULT 'ignore' CHECK (action IN ('create','ignore')),
  stage_key   TEXT REFERENCES crm_stages(key),
  -- Правило «создавать» обязано назвать колонку: лид, которому некуда лечь,
  -- молча не создался бы, и владелец три недели ждал бы карточек.
  CHECK (action = 'ignore' OR stage_key IS NOT NULL),
  PRIMARY KEY (provider, disposition)
);

-- Каждая строка ниже — ЗНАЧЕНИЕ ПО УМОЛЧАНИЮ, которое владелец меняет на
-- экране настроек, а не правило системы.
--   ANSWER / TRANSFER    — с человеком поговорили: обычный новый лид, в первую
--                          открытую колонку по порядку (сегодня «В обработке»).
--   NOANSWER/BUSY/CANCEL — до клиники дозванивались и не дозвонились. Это самый
--                          дорогой пропущенный звонок, и он должен попасть
--                          именно в «Перезвонить», а не потеряться.
--   всё остальное        — не лид: ONLINE это состояние линии, VM-*/SMS-* —
--                          сообщения, CONGESTION/CHANUNAVAIL — авария на канале,
--                          SUCCESS/FAILED — исход отправки, а не разговора.
INSERT INTO crm_call_routing (provider, disposition, action, stage_key) VALUES
  ('binotel', 'ANSWER',      'create', (SELECT key FROM crm_stages WHERE kind = 'open' AND is_active = 1 ORDER BY position LIMIT 1)),
  ('binotel', 'TRANSFER',    'create', (SELECT key FROM crm_stages WHERE kind = 'open' AND is_active = 1 ORDER BY position LIMIT 1)),
  ('binotel', 'NOANSWER',    'create', 'recall'),
  ('binotel', 'BUSY',        'create', 'recall'),
  ('binotel', 'CANCEL',      'create', 'recall'),
  ('binotel', 'ONLINE',      'ignore', NULL),
  ('binotel', 'CONGESTION',  'ignore', NULL),
  ('binotel', 'CHANUNAVAIL', 'ignore', NULL),
  ('binotel', 'VM',          'ignore', NULL),
  ('binotel', 'VM-SUCCESS',  'ignore', NULL),
  ('binotel', 'SMS-SENDING', 'ignore', NULL),
  ('binotel', 'SMS-SUCCESS', 'ignore', NULL),
  ('binotel', 'SMS-FAILED',  'ignore', NULL),
  ('binotel', 'SUCCESS',     'ignore', NULL),
  ('binotel', 'FAILED',      'ignore', NULL);

-- --------------------------------------------------------------------------
-- Пересборка crm_requests: снять CHECK, повесить ссылки на справочники
-- --------------------------------------------------------------------------
-- SQLite не умеет DROP CONSTRAINT, поэтому таблицу пересобирают (mig 046).
-- Но с 046 кое-что изменилось, и это ловушка, найденная опытом, а не по книге:
--
--   1. На crm_requests теперь ссылается crm_request_services (mig 057) с
--      ON DELETE CASCADE. При включённом foreign_keys (connection.js) DROP
--      TABLE делает неявный DELETE всех строк — и КАСКАД СРАБАТЫВАЕТ:
--      проверено на SQLite 3.53.4, все строки crm_request_services исчезают.
--      defer_foreign_keys это не отменяет — он откладывает жалобу на нарушение,
--      а не выполнение действия. Поэтому дочерние строки снимаются в копию
--      до DROP и возвращаются после.
--   2. RENAME здесь запрещён (та же причина, что в mig 023): ALTER TABLE ...
--      RENAME переписывает REFERENCES в чужих таблицах, и crm_request_services
--      начал бы ссылаться на временное имя. Имя таблицы не меняется вовсе:
--      копия -> DROP -> CREATE под тем же именем -> вернуть строки.
--   3. Вместе с таблицей DROP уносит её строку в sqlite_sequence, и счётчик
--      AUTOINCREMENT откатывается к MAX(id). Заявка, удалённая до миграции,
--      отдала бы свой id следующей новой — а AUTOINCREMENT существует ровно
--      затем, чтобы id никогда не переиспользовался. Счётчик сохраняется
--      отдельной копией и возвращается на место.
PRAGMA defer_foreign_keys=ON;

CREATE TABLE _crm_requests_bak AS SELECT * FROM crm_requests;
CREATE TABLE _crm_request_services_bak AS SELECT * FROM crm_request_services;
CREATE TABLE _crm_seq_bak AS SELECT seq FROM sqlite_sequence WHERE name = 'crm_requests';

DROP TABLE crm_requests;

CREATE TABLE crm_requests (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name   TEXT NOT NULL,
  phone       TEXT NOT NULL DEFAULT '',
  -- Был CHECK со списком из семи слов — стала ссылка на справочник.
  -- DEFAULT 'call' / 'in_process' остаются: их пишет /api/db, когда экран не
  -- прислал поле. Именно поэтому config.js запрещает УДАЛЯТЬ эти две строки
  -- справочников — DEFAULT, указывающий в пустоту, ломает любую вставку.
  source      TEXT NOT NULL DEFAULT 'call'       REFERENCES crm_sources(key),
  note        TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'in_process' REFERENCES crm_stages(key),
  patient_id  INTEGER REFERENCES patients(id),
  assigned_to INTEGER REFERENCES users(id),
  created_by  INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  service_id  INTEGER REFERENCES services(id),
  scheduled_date TEXT,
  -- CRM_CONFIG_V1 — из какого звонка вырос лид, чтобы карточка могла сказать
  -- «звонок в 14:32». SET NULL, а не CASCADE, по причине calls.patient_id:
  -- удаление записи о звонке не должно уносить заявку, заведённую по нему.
  call_id     INTEGER REFERENCES calls(id) ON DELETE SET NULL
);

INSERT INTO crm_requests (id, full_name, phone, source, note, status, patient_id,
                          assigned_to, created_by, created_at, updated_at,
                          service_id, scheduled_date)
  SELECT id, full_name, phone, source, note, status, patient_id,
         assigned_to, created_by, created_at, updated_at,
         service_id, scheduled_date
    FROM _crm_requests_bak;

-- Возврат дочерних строк. DELETE перед вставкой — не осторожность ради
-- осторожности: если сборка SQLite каскад не выполнит, повторная вставка тех
-- же id упала бы на первичном ключе. Так шаг ведёт себя одинаково в обоих
-- случаях.
DELETE FROM crm_request_services;
INSERT INTO crm_request_services SELECT * FROM _crm_request_services_bak;

-- Счётчик AUTOINCREMENT на место. Строку, которую только что записали
-- вставки выше (seq = MAX(id)), заменяем сохранённой — она всегда не меньше.
-- Пустая копия = таблица никогда ничего не вставляла, и восстанавливать нечего.
DELETE FROM sqlite_sequence WHERE name = 'crm_requests';
INSERT INTO sqlite_sequence (name, seq) SELECT 'crm_requests', seq FROM _crm_seq_bak;

DROP TABLE _crm_requests_bak;
DROP TABLE _crm_request_services_bak;
DROP TABLE _crm_seq_bak;

-- Оба индекса жили на старой таблице и ушли вместе с ней:
-- idx_crm_requests_status (mig 046), idx_crm_requests_patient (mig 053).
CREATE INDEX idx_crm_requests_status  ON crm_requests(status);
CREATE INDEX idx_crm_requests_patient ON crm_requests(patient_id);
