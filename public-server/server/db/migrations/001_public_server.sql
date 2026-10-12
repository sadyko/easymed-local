-- PUBLIC_SERVER_V1 — публичный сервер api.easymed.uz (шаг 8b API клиники).
--
-- ЧЕГО ЗДЕСЬ НЕТ И НЕ БУДЕТ (дизайн шага 8, §1; решения владельца 5 и 16):
--   • имени, телефона, комментария пациента открытым текстом — данные
--     пациента лежат ТОЛЬКО в inbox.sealed, запечатанными ключом-ящиком
--     клиники (сервер их открыть не может), и строка очереди стирается целиком,
--     как только клиника подтвердила курсор;
--   • ключей API и секретов вебхуков — только SHA-256 ключа (connections.key_hash);
--   • install_token клиники, карт пациентов, визитов, сотрудников (кроме
--     показанных врачей в снимке).
-- Страж: server/db/schema.test.js сверяет колонки каждой таблицы со списком.

-- Клиника: личность — из подписанной лицензии (самой новой из виденных),
-- снимок и время — последние присланные.
CREATE TABLE clinics (
  clinic_id            TEXT PRIMARY KEY,
  slug                 TEXT,
  key_fp               TEXT NOT NULL,
  box_key              TEXT,
  licence_issued_at    TEXT,
  licence_valid_until  TEXT,
  licence_subscription TEXT NOT NULL DEFAULT 'active' CHECK (licence_subscription IN ('active', 'unpaid')),
  first_seen_at        TEXT NOT NULL,
  last_seen_at         TEXT NOT NULL,
  keys_at              TEXT,
  snapshot             TEXT,
  snapshot_at          TEXT,
  slots                TEXT,
  slots_at             TEXT
);
CREATE UNIQUE INDEX clinics_slug ON clinics (slug) WHERE slug IS NOT NULL;

-- Прежнее имя в адресе работает 30 дней после смены (макет «API и подключения»).
CREATE TABLE slug_aliases (
  slug      TEXT PRIMARY KEY,
  clinic_id TEXT NOT NULL REFERENCES clinics (clinic_id) ON DELETE CASCADE,
  until_at  TEXT NOT NULL
);

-- Подключения клиники (быстрый канал PUT /keys): отпечаток ключа, права, лимиты.
CREATE TABLE connections (
  clinic_id      TEXT NOT NULL REFERENCES clinics (clinic_id) ON DELETE CASCADE,
  id             INTEGER NOT NULL CHECK (id > 0),
  kind           TEXT NOT NULL,
  active         INTEGER NOT NULL CHECK (active IN (0, 1)),
  key_hash       TEXT NOT NULL CHECK (length(key_hash) = 64),
  scopes         TEXT NOT NULL DEFAULT '[]',
  rate_limit     INTEGER NOT NULL CHECK (rate_limit > 0),
  key_expires_at TEXT,
  ip_allow       TEXT NOT NULL DEFAULT '[]',
  origins        TEXT NOT NULL DEFAULT '[]',
  last_used_at   TEXT,
  PRIMARY KEY (clinic_id, id)
);
CREATE UNIQUE INDEX connections_key ON connections (clinic_id, key_hash);

-- Файлы снимка (логотипы, фото показанных врачей): байты — на диске, по отпечатку.
CREATE TABLE media (
  clinic_id TEXT NOT NULL REFERENCES clinics (clinic_id) ON DELETE CASCADE,
  sha256    TEXT NOT NULL CHECK (length(sha256) = 64),
  ext       TEXT NOT NULL CHECK (ext IN ('png', 'jpg', 'jpeg', 'webp')),
  bytes     INTEGER NOT NULL,
  stored_at TEXT NOT NULL,
  PRIMARY KEY (clinic_id, sha256)
);

-- Заявка партнёра — статус для GET /requests/{id}, БЕЗ данных пациента; живёт 90 дней.
CREATE TABLE requests (
  id                  TEXT PRIMARY KEY,
  clinic_id           TEXT NOT NULL REFERENCES clinics (clinic_id) ON DELETE CASCADE,
  connection_id       INTEGER NOT NULL,
  kind                TEXT NOT NULL CHECK (kind IN ('request', 'appointment')),
  external_id         TEXT,
  doctor_id           INTEGER,
  branch_id           INTEGER,
  service_id          INTEGER,
  package_id          INTEGER,
  consultation        TEXT,
  start_at            TEXT,
  duration_min        INTEGER,
  status              TEXT NOT NULL CHECK (status IN ('new', 'accepted', 'pending', 'offered', 'booked', 'declined',
                        'expired', 'cancelled', 'arrived', 'no_show', 'closed')),
  reason              TEXT,
  hold_until          TEXT,
  offered_start       TEXT,
  offer_until         TEXT,
  cancel_requested_at TEXT,
  created_at          TEXT NOT NULL,
  delivered_at        TEXT,
  answered_at         TEXT,
  updated_at          TEXT NOT NULL
);
CREATE UNIQUE INDEX requests_external ON requests (clinic_id, connection_id, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX requests_status ON requests (clinic_id, status);

-- Очередь заявок клинике (GET /_sync/v1/inbox). sealed — данные пациента,
-- запечатанные box_key клиники; строка стирается при подтверждении курсора.
-- handed_out_at — когда элемент последний раз отдан клинике: уборка не
-- закрывает отданное, пока клиника его подтверждает (ревью 8b, C11).
CREATE TABLE inbox (
  cursor        INTEGER PRIMARY KEY AUTOINCREMENT,
  clinic_id     TEXT NOT NULL REFERENCES clinics (clinic_id) ON DELETE CASCADE,
  type          TEXT NOT NULL CHECK (type IN ('request.new', 'appointment.new', 'appointment.cancel', 'offer.accept', 'offer.decline')),
  request_id    TEXT NOT NULL,
  connection_id INTEGER NOT NULL,
  received_at   TEXT NOT NULL,
  data          TEXT NOT NULL DEFAULT '{}',
  sealed        TEXT,
  handed_out_at TEXT
);
CREATE INDEX inbox_clinic ON inbox (clinic_id, cursor);

-- Принятые события клиники (POST /_sync/v1/events) — повтор того же seq с тем
-- же содержимым (identity — sha256 вида и тела события) ничего не меняет. Тот же
-- seq с другим содержимым — новое событие: клиника восстановила базу из копии,
-- и номера пошли заново (ревью 8b, C2).
CREATE TABLE events_seen (
  clinic_id   TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  identity    TEXT NOT NULL,
  received_at TEXT NOT NULL,
  PRIMARY KEY (clinic_id, seq)
);

-- Уведомления партнёрам: тело и подпись — готовые от клиники (данных пациента нет);
-- тело стирается, как только доставка кончилась (доставлено или попытки вышли).
CREATE TABLE deliveries (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  clinic_id     TEXT NOT NULL,
  connection_id INTEGER,
  request_id    TEXT,
  event_id      TEXT NOT NULL,
  event         TEXT NOT NULL,
  url           TEXT NOT NULL,
  body          TEXT,
  signature     TEXT NOT NULL,
  attempts      INTEGER NOT NULL DEFAULT 0,
  state         TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'delivered', 'failed')),
  next_at       TEXT,
  last_code     INTEGER,
  last_error    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX deliveries_due ON deliveries (state, next_at);

-- Журнал доставок для клиники (8d — вкладка «Уведомления»): попытка за попыткой, без тел.
CREATE TABLE delivery_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  clinic_id     TEXT NOT NULL,
  delivery_id   INTEGER,
  connection_id INTEGER,
  request_id    TEXT,
  event_id      TEXT,
  event         TEXT NOT NULL,
  attempt       INTEGER NOT NULL,
  code          INTEGER,
  error         TEXT,
  at            TEXT NOT NULL,
  next_at       TEXT,
  final         TEXT
);
CREATE INDEX delivery_log_clinic ON delivery_log (clinic_id, id);

-- Журнал запросов партнёров (30 дней): метод, путь без лишнего, ответ — без тел.
CREATE TABLE access_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  clinic_id     TEXT NOT NULL,
  connection_id INTEGER,
  at            TEXT NOT NULL,
  method        TEXT NOT NULL,
  path          TEXT NOT NULL,
  status        INTEGER NOT NULL,
  ip            TEXT,
  ms            INTEGER
);
CREATE INDEX access_log_clinic ON access_log (clinic_id, id);
CREATE INDEX access_log_at ON access_log (at);
