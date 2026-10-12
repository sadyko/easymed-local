-- 011_public_api.sql — PUBLIC_LICENCE_V1, шаг 8c API клиники: сервер лицензий
-- включает клинике онлайн-запись (публичный сервер api.easymed.uz), вписывает в
-- подписанную лицензию отпечаток её ключа обмена и «active» (неоплаченной
-- лицензии нет, как до 8c — план 8c Р14), ведёт срочный отзыв ключей. Данных пациентов здесь нет и не будет (страж
-- server/services/api/no-patient-data-to-vendor.test.js): только флаг, отпечатки
-- ключей и сроки выданной лицензии.

-- «Онлайн-запись / API» в панели. 0 — лицензия без api_sync_key: обмен клиники
-- (8a) молчит, партнёры клинику не видят (список производителя, clinics_off).
ALTER TABLE clinics ADD COLUMN api_enabled INTEGER NOT NULL DEFAULT 0 CHECK (api_enabled IN (0, 1));
-- Принятый отпечаток ключа подписи клиники (32 hex) — он и уходит в лицензию.
ALTER TABLE clinics ADD COLUMN api_sync_key TEXT;
-- Когда ключ принят впервые. Не NULL — у клиники уже был принятый ключ, и
-- новый (другой ПК) ждёт подтверждения в панели, а не принимается сам.
ALTER TABLE clinics ADD COLUMN api_sync_key_accepted_at TEXT;
-- Последний присланный при сверке отпечаток и когда он появился. Отличается от
-- принятого — «новый ключ обмена ждёт подтверждения».
ALTER TABLE clinics ADD COLUMN api_sync_key_seen TEXT;
ALTER TABLE clinics ADD COLUMN api_sync_key_seen_at TEXT;
-- Последняя выданная лицензия: issued_at — нижняя граница следующей (у каждой
-- выдачи issued_at строго больше); valid_until, subscription и api_sync_key —
-- что сейчас сказано клинике (панель показывает, дошло ли включение).
-- Неоплаченной лицензия не выдаётся, и эти колонки не трогаются (Р14).
ALTER TABLE clinics ADD COLUMN licence_issued_at TEXT;
ALTER TABLE clinics ADD COLUMN licence_valid_until TEXT;
ALTER TABLE clinics ADD COLUMN licence_subscription TEXT;
ALTER TABLE clinics ADD COLUMN licence_api_sync_key TEXT;

-- Срочный отзыв: ключи партнёров (SHA-256 ключа, 64 hex — самого ключа сервер
-- лицензий не видит) и ключи обмена клиник (отпечаток, 32 hex). Публичный сервер
-- получает действующие записи в подписанном списке производителя
-- (GET /cp/v1/public-feed). Снятие — отметка removed_at, строка остаётся: кто и
-- когда снял блокировку — тоже ответ на вопрос «что случилось».
-- clinic_id без внешнего ключа, как у checkins: удаление клиники не стирает
-- историю её блокировок.
CREATE TABLE revocations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  clinic_id   TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('partner_key', 'sync_key')),
  value       TEXT NOT NULL CHECK (
                (kind = 'partner_key' AND length(value) = 64 AND value NOT GLOB '*[^0-9a-f]*')
             OR (kind = 'sync_key'    AND length(value) = 32 AND value NOT GLOB '*[^0-9a-f]*')),
  note        TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  created_by  TEXT,
  removed_at  TEXT,
  removed_by  TEXT
);
-- Одна действующая запись на ключ; снятых может быть сколько угодно.
CREATE UNIQUE INDEX revocations_live ON revocations (kind, value) WHERE removed_at IS NULL;
CREATE INDEX revocations_clinic ON revocations (clinic_id, created_at DESC);
