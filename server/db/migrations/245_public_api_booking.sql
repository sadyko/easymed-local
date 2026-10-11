-- 245 — PUBLIC_API_V1 (2026-10-11): ЗАЯВКИ И ОНЛАЙН-ЗАПИСЬ ИЗ API — сторона
-- клиники (шаг 8a API клиники, docs/specs/2026-10-06-clinic-api-design.md;
-- план docs/plans/2026-10-11-clinic-api-8a-clinic-side.md).
--
-- ТОЛЬКО CREATE TABLE / CREATE INDEX и одна INSERT (строка состояния обмена).
-- Ни одна прежняя таблица не пересобирается и не правится.
--
-- Таблиц этого файла НЕТ в schema-registry.js (как api_connections, мигр. 242):
-- /api/db их не знает по построению, всё — через RPC rpc/api-bookings.js и фон
-- services/api/public-sync.js. Между зданиями они не ездят (их нет в
-- branch-sync/catalogue.js TABLES и journal.js SHIPPED): подключения API живут
-- в главном здании, заявки партнёров — там же. Визит, заведённый подтверждением,
-- — обычный визит и едет, как любой.

-- Заявка, пришедшая через публичный сервер. kind:
--   'request'     — «перезвоните мне» (без времени);
--   'appointment' — онлайн-запись на выбранное время.
-- Данные пациента (имя, телефон, комментарий) лежат здесь и в карточке CRM —
-- в базе клиники; наружу уходит только номер заявки и её статус.
CREATE TABLE api_requests (
  id                   INTEGER PRIMARY KEY,
  public_id            TEXT NOT NULL UNIQUE
                       CHECK (public_id GLOB 'rq_*' AND length(public_id) BETWEEN 9 AND 40
                              AND substr(public_id, 4) NOT GLOB '*[^A-Za-z0-9]*'),
  connection_id        INTEGER NOT NULL REFERENCES api_connections(id),
  external_id          TEXT NOT NULL DEFAULT '' CHECK (length(external_id) <= 64),
  kind                 TEXT NOT NULL CHECK (kind IN ('request', 'appointment')),
  status               TEXT NOT NULL CHECK (status IN ('new', 'accepted', 'pending', 'confirming', 'offered',
                         'confirmed', 'declined', 'expired', 'cancelled', 'arrived', 'no_show')),
  crm_request_id       INTEGER REFERENCES crm_requests(id) ON DELETE SET NULL,
  patient_name         TEXT NOT NULL DEFAULT '' CHECK (length(patient_name) <= 120),
  patient_phone        TEXT NOT NULL DEFAULT '' CHECK (length(patient_phone) <= 32),
  comment              TEXT NOT NULL DEFAULT '' CHECK (length(comment) <= 1000),
  lang                 TEXT NOT NULL DEFAULT '' CHECK (lang IN ('', 'ru', 'uz', 'en')),
  doctor_id            INTEGER REFERENCES users(id),
  branch_id            INTEGER REFERENCES branches(id),
  service_id           INTEGER REFERENCES services(id),
  consultation_type_id INTEGER REFERENCES consultation_types(id),
  package_id           INTEGER REFERENCES service_templates(id) ON DELETE SET NULL,
  start_at             TEXT,
  duration_minutes     INTEGER CHECK (duration_minutes IS NULL OR duration_minutes BETWEEN 5 AND 480),
  hold_until           TEXT,
  offered_start        TEXT,
  offer_until          TEXT,
  decline_reason       TEXT NOT NULL DEFAULT '' CHECK (decline_reason IN ('', 'slot_taken', 'doctor_unavailable',
                         'not_bookable', 'duplicate', 'expired', 'other')),
  patient_id           INTEGER REFERENCES patients(id),
  visit_id             INTEGER REFERENCES visits(id) ON DELETE SET NULL,
  partner_cancel_at    TEXT,
  received_at          TEXT NOT NULL,
  picked_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  handled_by           INTEGER REFERENCES users(id),
  -- Онлайн-запись знает врача и время; заявке они не обязательны. Исключение —
  -- отклонённая или истёкшая при приёме (ревью 8a, C1): врача могли удалить,
  -- пока заявка ждала в очереди, — её всё равно надо сохранить (карточка для
  -- звонка, отказ партнёру), иначе элемент не принять и очередь встаёт.
  CHECK (kind = 'request' OR status IN ('declined', 'expired')
         OR (doctor_id IS NOT NULL AND start_at IS NOT NULL AND duration_minutes IS NOT NULL)),
  -- Удержание и встречное предложение — только у онлайн-записи.
  CHECK (kind = 'appointment' OR (hold_until IS NULL AND offered_start IS NULL AND status IN
         ('new', 'accepted', 'confirmed', 'cancelled', 'arrived', 'no_show')))
);
-- Один номер заявки партнёра — одна заявка у подключения: повтор отправки не
-- заводит вторую карточку и второе удержание.
CREATE UNIQUE INDEX api_requests_external ON api_requests (connection_id, external_id) WHERE external_id <> '';
CREATE INDEX api_requests_crm    ON api_requests (crm_request_id);
CREATE INDEX api_requests_status ON api_requests (status);
CREATE INDEX api_requests_visit  ON api_requests (visit_id) WHERE visit_id IS NOT NULL;

-- УДЕРЖАНИЕ ВРЕМЕНИ БЕЗ КАРТЫ (решение владельца 3). Не визит: карты пациента
-- ещё нет, поэтому visits.patient_id (NOT NULL) держать время не может. Время
-- занято, пока released_at пуст И until_at впереди: истечение освобождает слот
-- само, без таймера (rpc/calendar.js loadBusy читает это условие). Фон только
-- записывает итог (expired) и сообщает партнёру.
CREATE TABLE slot_holds (
  id               INTEGER PRIMARY KEY,
  doctor_id        INTEGER NOT NULL REFERENCES users(id),
  start_at         TEXT NOT NULL,
  duration_minutes INTEGER NOT NULL CHECK (duration_minutes BETWEEN 5 AND 480),
  until_at         TEXT NOT NULL,
  api_request_id   INTEGER NOT NULL REFERENCES api_requests(id),
  kind             TEXT NOT NULL CHECK (kind IN ('booking', 'offer')),
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  released_at      TEXT,
  release_reason   TEXT NOT NULL DEFAULT '' CHECK (release_reason IN ('', 'confirmed', 'expired', 'declined',
                     'cancelled', 'offered', 'accepted')),
  CHECK ((released_at IS NULL) = (release_reason = ''))
);
CREATE INDEX slot_holds_live ON slot_holds (doctor_id, start_at) WHERE released_at IS NULL;
-- У заявки одно живое удержание.
CREATE UNIQUE INDEX slot_holds_one_live ON slot_holds (api_request_id) WHERE released_at IS NULL;

-- СОБЫТИЯ НАРУЖУ: статус заявки для партнёра и уведомление (вебхук). Тело —
-- без данных пациента (shared/api-booking.js webhookBody); подпись HMAC-SHA256
-- ставит КЛИНИКА секретом подключения (секрет не покидает клинику), публичный
-- сервер только доставляет. Уходит по порядку id; sent_at — публичный сервер
-- принял.
CREATE TABLE api_outbox (
  id             INTEGER PRIMARY KEY,
  api_request_id INTEGER REFERENCES api_requests(id),
  connection_id  INTEGER NOT NULL REFERENCES api_connections(id),
  event          TEXT NOT NULL,
  status         TEXT NOT NULL,
  body           TEXT NOT NULL CHECK (json_valid(body) AND json_type(body) = 'object'),
  webhook_url    TEXT NOT NULL DEFAULT '',
  signature      TEXT NOT NULL DEFAULT '',
  note           TEXT NOT NULL DEFAULT '' CHECK (note IN ('', 'no_webhook', 'not_subscribed', 'no_secret')),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  sent_at        TEXT,
  attempts       INTEGER NOT NULL DEFAULT 0,
  last_error     TEXT NOT NULL DEFAULT ''
);
CREATE INDEX api_outbox_unsent ON api_outbox (id) WHERE sent_at IS NULL;

-- Состояние обмена с публичным сервером: одна строка, id = 1 (как api_settings).
CREATE TABLE api_sync_state (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  inbox_cursor  TEXT NOT NULL DEFAULT '',
  snapshot_hash TEXT NOT NULL DEFAULT '',
  snapshot_at   TEXT,
  slots_hash    TEXT NOT NULL DEFAULT '',
  slots_at      TEXT,
  keys_hash     TEXT NOT NULL DEFAULT '',
  keys_at       TEXT,
  last_poll_at  TEXT,
  last_ok_at    TEXT,
  last_error    TEXT NOT NULL DEFAULT '',
  last_error_at TEXT,
  -- Ревью 8a, C1: элементы очереди, которые клиника не смогла принять (база
  -- отказала, или сбой программы на одном элементе 20 тактов подряд), —
  -- пропущены, чтобы очередь шла дальше. Счётчик и номера заявок (без данных
  -- пациента) живут, пока администратор их не сбросит: экран «API» говорит
  -- «обратитесь в Easy-Med», а не исчезает через такт.
  skipped_failed   INTEGER NOT NULL DEFAULT 0,
  -- Ревью 8a, I4: заявки, запечатанные не тем ключом (ключ клиники потерян и
  -- выпущен заново — риск 6 дизайна): открыть их нельзя никогда.
  skipped_sealed   INTEGER NOT NULL DEFAULT 0,
  skipped_last_at  TEXT,
  skipped_last_ids TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(skipped_last_ids) AND json_type(skipped_last_ids) = 'array'),
  -- Элемент, на котором приём стоит (сбой программы): его курсор и сколько тактов подряд.
  stuck_cursor     TEXT NOT NULL DEFAULT '',
  stuck_tries      INTEGER NOT NULL DEFAULT 0
);
INSERT INTO api_sync_state (id) VALUES (1);
