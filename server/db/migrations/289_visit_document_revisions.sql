-- DOC_HISTORY_V1 (3.25.0, 2026-11-18) — ИСТОРИЯ ИЗМЕНЕНИЙ ДОКУМЕНТА ПРИЁМА.
--
-- Решение владельца: каждая запись, которая МЕНЯЕТ содержание документа приёма
-- (visit_services.notes — JSON кабинета врача), оставляет постоянную версию: время и
-- сотрудник — от сервера (при входе «от имени» — и администратор), вид (черновик,
-- подписан, исправлен после подписи, отметка медсестры, изменение назначений и
-- диагнозов), тип документа, какие разделы изменились и снимок, по которому версию
-- можно показать и сравнить. Снимки исследования в версии не копируются — только их
-- отпечатки (число и хэши), и сколько добавлено / убрано.
--
-- ПИШЕТ ТОЛЬКО СЕРВЕР (services/domain/doc-history.js), в той же транзакции, что и
-- сама запись документа: /api/db (routes/db.js), «Выполнено» процедуры
-- (rpc/procedures.js), копия подписанного документа (rpc/patient-card.js
-- visit_document_archive). Тот же текст ещё раз — версии нет.
--
-- НИКТО НЕ МЕНЯЕТ И НЕ УДАЛЯЕТ, администратор тоже: таблицы нет в реестре /api/db
-- (schema-registry.js — «unknown table», 403), правящего RPC нет, а два триггера ниже
-- отказывают любому UPDATE и DELETE. Запрет на удаление снимает только «Удалить
-- тестовые данные» — на время своей транзакции, вместе с учебными документами
-- (test-data-wipe-plan.js GUARD_TRIGGERS — так же, как у депозитов, миграция 160).
--
-- ТОЛЬКО ДОБАВЛЕНИЕ. Новая таблица; ни одна существующая строка не меняется,
-- visit_services не пересобирается (шапка 084), журнальные триггеры не срабатывают.
-- Версий задним числом миграция не заводит: документ, написанный до неё, получает
-- «Версию до журнала изменений» при первой записи после обновления.
--
-- ССЫЛКИ НА СТРОКУ ВИЗИТА НЕТ нарочно, как у invoice_audit_log.visit_service_id
-- (миграция 287): строку визита снимают, а история документа остаётся. Номер строки
-- новой строке не достаётся (sqlite_sequence не сбрасывается ни удалением, ни
-- удалением тестовых данных). Кто изменил — ссылка на сотрудника (удалить сотрудника
-- с версиями нельзя: routes/users.js, как у документов визитов); имя и роль —
-- копией на момент записи.
--
-- СВЯЗЬ ЗДАНИЙ: таблица не ездит (её нет в branch-sync/journal.js SHIPPED), как и
-- сам документ (visit_services.notes) и его копии (visit_documents): история живёт
-- там же, где документ.
CREATE TABLE visit_document_revisions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  visit_service_id  INTEGER NOT NULL,                 -- строка визита (без REFERENCES — см. шапку)
  rev_no            INTEGER NOT NULL,                 -- 1, 2, 3… внутри строки
  kind              TEXT NOT NULL CHECK (kind IN ('baseline', 'draft', 'signed', 'amended', 'nurse', 'lists')),
  via               TEXT NOT NULL CHECK (via IN ('cabinet', 'nurse', 'archive', 'baseline')),   -- какая дверь записала
  doc_type          TEXT,                             -- 'conclusion' (Приём) | 'diag' (Диагностика)
  sections          TEXT NOT NULL DEFAULT '[]',       -- JSON: ключи изменённых разделов
  images_added      INTEGER NOT NULL DEFAULT 0,
  images_removed    INTEGER NOT NULL DEFAULT 0,
  snapshot          TEXT NOT NULL,                    -- JSON: содержание версии (снимки — отпечатками) и подписи
  content_hash      TEXT NOT NULL,                    -- отпечаток содержания (тот же текст — та же строка)
  signed_n          INTEGER NOT NULL DEFAULT 0,       -- сколько подписанных версий у документа после записи
  user_id           INTEGER REFERENCES users(id),     -- кто записал (NULL — версия до журнала)
  user_name         TEXT,
  user_role         TEXT,
  acting_admin_id   INTEGER REFERENCES users(id),     -- «Войти как сотрудник»: администратор, который действовал
  acting_admin_name TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (visit_service_id, rev_no)
);

CREATE TRIGGER visit_document_revisions_no_update BEFORE UPDATE ON visit_document_revisions
BEGIN
  SELECT RAISE(ABORT, 'История изменений документа не меняется.');
END;

CREATE TRIGGER visit_document_revisions_no_delete BEFORE DELETE ON visit_document_revisions
BEGIN
  SELECT RAISE(ABORT, 'История изменений документа не удаляется.');
END;
