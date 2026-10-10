-- 242 — CLINIC_API_STEP7_V1 (2026-10-10): ПОДКЛЮЧЕНИЯ API, КЛЮЧИ, ЖУРНАЛ
-- (шаг 7 API клиники, docs/specs/2026-10-06-clinic-api-design.md;
-- план docs/plans/2026-10-10-clinic-api-7-api-screen.md).
--
-- ТОЛЬКО CREATE TABLE / CREATE INDEX и одна INSERT: ни одна таблица не
-- пересобирается. Прежняя заглушка api_tokens (мигр. 012) НЕ удаляется: её
-- значения сервер никогда не проверял, но клиника могла вписать туда что-то
-- руками, и стереть это миграцией — потерять данные без спроса. Она просто
-- больше не видна (реестр /api/db её не знает — задача 15 плана).
--
-- Таблиц этого файла НЕТ в schema-registry.js — как telegram_settings
-- (мигр. 060): реестр — белый список, поэтому /api/db не отдаст ни ключа, ни
-- секрета по построению; всё — через RPC rpc/api-connections.js. Между
-- зданиями они не ездят (их нет в branch-sync/catalogue.js TABLES и в
-- journal.js SHIPPED): подключения живут в главном здании.

-- Имя клиники в адресе https://api.easymed.uz/<slug>/v1/ (решение владельца 7).
-- Одна строка, id = 1, как doc_settings.
CREATE TABLE api_settings (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  slug       TEXT NOT NULL DEFAULT ''
             CHECK (slug = '' OR (length(slug) BETWEEN 3 AND 40 AND slug NOT GLOB '*[^a-z0-9-]*'
                                  AND slug NOT GLOB '-*' AND slug NOT GLOB '*-')),
  updated_at TEXT,
  updated_by INTEGER
);
INSERT INTO api_settings (id) VALUES (1);

-- Подключение: сайт клиники (создаётся сам, адрес — в «Компании»), Symptex,
-- партнёр. Ключ и секрет вебхука — ШИФРОТЕКСТОМ (key_sealed, secret_sealed:
-- «v1.<отпечаток KEK>.<base64>», services/api/secret-box.js) и отпечатком
-- ключа (key_hash, SHA-256 hex) для узнавания без расшифровки (шаг 8).
-- Лимит, срок и IP хранятся сейчас, действуют с публичным сервером (шаг 8).
CREATE TABLE api_connections (
  id                 INTEGER PRIMARY KEY,
  kind               TEXT NOT NULL CHECK (kind IN ('site', 'symptex', 'partner')),
  name               TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 64),
  site_url           TEXT NOT NULL DEFAULT '' CHECK (site_url = '' OR site_url LIKE 'https://_%'),
  contact            TEXT NOT NULL DEFAULT '' CHECK (length(contact) <= 120),
  scopes             TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(scopes) AND json_type(scopes) = 'array'),
  active             INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  crm_source_key     TEXT NOT NULL,
  owns_source        INTEGER NOT NULL DEFAULT 0 CHECK (owns_source IN (0, 1)),
  key_hash           TEXT NOT NULL DEFAULT '',
  key_sealed         TEXT NOT NULL DEFAULT '',
  key_tail           TEXT NOT NULL DEFAULT '',
  key_issued_at      TEXT,
  key_issued_by_name TEXT NOT NULL DEFAULT '',
  key_ttl            TEXT NOT NULL DEFAULT 'never' CHECK (key_ttl IN ('never', '3m', '6m', '1y')),
  key_expires_at     TEXT,
  rate_limit         INTEGER NOT NULL DEFAULT 60 CHECK (rate_limit IN (30, 60, 120, 300)),
  ip_allow           TEXT NOT NULL DEFAULT '' CHECK (length(ip_allow) <= 1000),
  webhook_url        TEXT NOT NULL DEFAULT '' CHECK (webhook_url = '' OR webhook_url LIKE 'https://_%'),
  webhook_events     TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(webhook_events) AND json_type(webhook_events) = 'array'),
  secret_sealed      TEXT NOT NULL DEFAULT '',
  secret_tail        TEXT NOT NULL DEFAULT '',
  last_used_at       TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  created_by         INTEGER,
  created_by_name    TEXT NOT NULL DEFAULT '',
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  deleted_at         TEXT,
  deleted_by         INTEGER,
  -- Сайт клиники берёт адрес из «Компании» (doc_settings.website): своего нет.
  CHECK (kind <> 'site' OR site_url = ''),
  -- Живое подключение держит ключ и секрет; удалённое (архив) — ни того, ни
  -- другого, и выключено.
  CHECK ((deleted_at IS NULL AND length(key_hash) = 64 AND key_sealed <> '' AND secret_sealed <> '')
      OR (deleted_at IS NOT NULL AND key_hash = '' AND key_sealed = '' AND secret_sealed = '' AND active = 0))
);
CREATE UNIQUE INDEX api_connections_key_hash   ON api_connections (key_hash) WHERE key_hash <> '';
CREATE UNIQUE INDEX api_connections_one_site   ON api_connections (kind) WHERE kind = 'site';
CREATE UNIQUE INDEX api_connections_own_source ON api_connections (crm_source_key) WHERE owns_source = 1;

-- Кто что сделал — БЕЗ значений ключей и секретов (решение владельца 5).
-- user_name — снимок: журнал переживает переименование и удаление сотрудника.
CREATE TABLE api_journal (
  id            INTEGER PRIMARY KEY,
  at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  connection_id INTEGER REFERENCES api_connections(id),
  user_id       INTEGER,
  user_name     TEXT NOT NULL DEFAULT '',
  action        TEXT NOT NULL CHECK (action IN ('slug_saved', 'created', 'updated', 'enabled', 'disabled',
                  'key_revealed', 'key_regenerated', 'secret_revealed', 'secret_regenerated', 'deleted')),
  detail        TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail) AND json_type(detail) = 'object')
);
CREATE INDEX api_journal_connection ON api_journal (connection_id, id);
