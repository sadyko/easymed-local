-- CALL_RING_V1 (2026-10-17) — СОБЫТИЯ СТАНЦИИ «ЗВОНОК НАЧАЛСЯ / ОТВЕТИЛИ / ЗАКОНЧИЛСЯ»
-- для панели «Телефон» клиники. Клиника за NAT, вебхук onlinePBX до неё не дойдёт:
-- станция шлёт его сюда (routes/pbx.js, /_pbx/v1/{clinic}/{token}), клиника
-- забирает длинным опросом по подписанному каналу (routes/sync.js /pbx-events).
--
-- ЧТО ХРАНИТСЯ И НА СКОЛЬКО. Только номера звонка (caller/callee), событие,
-- направление и время — десять минут (store/pbx-events.js стирает старое при
-- каждом приёме и выдаче). Имя пациента подбирает клиника у себя. keys — ИМЕНА
-- полей непонятного события (без значений): по ним уточняется схема станции.
--
-- ring_hash у клиники — SHA-256 секрета адреса (telephony_settings.ring_token
-- на клинике, приезжает в теле ключей PUT /_sync/v1/keys). Сам секрет здесь не
-- лежит — как и ключи партнёров (key_hash): страж схемы (db/schema.test.js)
-- не пускает колонки с секретами.
ALTER TABLE clinics ADD COLUMN ring_hash TEXT NOT NULL DEFAULT '';

CREATE TABLE pbx_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  clinic_id   TEXT NOT NULL REFERENCES clinics(clinic_id) ON DELETE CASCADE,
  uuid        TEXT NOT NULL,
  event       TEXT NOT NULL CHECK (event IN ('ring', 'answer', 'end', 'unknown')),
  direction   TEXT NOT NULL DEFAULT '',
  caller      TEXT NOT NULL DEFAULT '',
  callee      TEXT NOT NULL DEFAULT '',
  at          TEXT NOT NULL,
  received_at TEXT NOT NULL,
  keys        TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(keys) AND json_type(keys) = 'array')
);
CREATE INDEX pbx_events_clinic ON pbx_events (clinic_id, id);
CREATE INDEX pbx_events_received ON pbx_events (received_at);
