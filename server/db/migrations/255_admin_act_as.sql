-- 249_admin_act_as.sql — ADMIN_ACT_AS_V1 (2026-10-28): администратор работает
-- от имени сотрудника. Спецификация — docs/specs/2026-10-28-admin-act-as-design.md.
--
-- Сессия остаётся сессией АДМИНИСТРАТОРА (sessions.user_id). Три новые колонки
-- ставит вход от имени (POST /api/auth/act-as) и снимает возврат:
--   • act_as_user_id    — сотрудник, от имени которого работают;
--   • act_as_id         — запись журнала act_as_sessions. Пока сотрудника уже нет
--                         (act_as_user_id пуст), а запись ещё стоит, — вход от имени
--                         закончился сам (2 часа, сотрудник отключён …), а экран
--                         об этом ещё не узнал: сервер отвечает 409 act_as_ended,
--                         пока экран не скажет «Вернуться» (services/auth.js);
--   • act_as_started_at — начало: предел 2 часа считается от него.
ALTER TABLE sessions ADD COLUMN act_as_user_id INTEGER;
ALTER TABLE sessions ADD COLUMN act_as_id INTEGER;
ALTER TABLE sessions ADD COLUMN act_as_started_at TEXT;

-- Журнал — источник правды о том, кто действовал на самом деле.
-- Ссылок на users НЕТ намеренно: журнал не мешает удалить сотрудника (R4
-- «удалён» — одна из причин конца) и переживает удаление и сотрудника, и
-- администратора — поэтому имена обоих лежат здесь копией на момент входа.
CREATE TABLE act_as_sessions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id    INTEGER NOT NULL,
  admin_name  TEXT NOT NULL DEFAULT '',
  target_id   INTEGER NOT NULL,
  target_name TEXT NOT NULL DEFAULT '',
  started_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  ended_at    TEXT,
  end_reason  TEXT CHECK (end_reason IN ('Вернулся', 'Вышел', 'Истекло', 'Сессия завершена', 'Сотрудник недоступен')),
  CHECK ((ended_at IS NULL) = (end_reason IS NULL))
);
CREATE INDEX idx_act_as_sessions_target  ON act_as_sessions (target_id, started_at);
CREATE INDEX idx_act_as_sessions_admin   ON act_as_sessions (admin_id, started_at);
CREATE INDEX idx_act_as_sessions_started ON act_as_sessions (started_at);

-- Действия от имени: kind — db (запись /api/db: «таблица.операция»), rpc (имя
-- RPC), users (запись /api/users: «МЕТОД /users/…»), storage (загрузка и
-- удаление файла /api/storage: «МЕТОД /storage/корзина», без пути объекта);
-- status — HTTP-код ответа.
-- Данных пациента здесь нет и быть не должно: только имена таблиц, RPC и корзин.
CREATE TABLE act_as_actions (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  act_as_id INTEGER NOT NULL REFERENCES act_as_sessions(id),
  at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  kind      TEXT NOT NULL CHECK (kind IN ('db', 'rpc', 'users', 'storage')),
  name      TEXT NOT NULL,
  status    INTEGER
);
CREATE INDEX idx_act_as_actions_session ON act_as_actions (act_as_id, at);

-- Любое удаление сессии администратора (истечение при запуске сервера,
-- отключение или сброс пароля администратора другим, вход другого человека в
-- этом браузере) закрывает открытую запись журнала. Выход и возврат закрывают
-- её раньше со своей причиной (services/auth.js) — тогда здесь закрывать уже
-- нечего. Вход от имени не длится дольше 2 часов: запись, закрытая позже, —
-- «Истекло» ровно через 2 часа от начала (то же правило — services/auth.js
-- closeActAs, ACT_AS_MAX_HOURS в public/js/shared/act-as.js).
CREATE TRIGGER sessions_act_as_close AFTER DELETE ON sessions
WHEN OLD.act_as_id IS NOT NULL
BEGIN
  UPDATE act_as_sessions
     SET end_reason = CASE WHEN CAST(strftime('%s','now') AS INTEGER) - CAST(strftime('%s', started_at) AS INTEGER) >= 7200
                           THEN 'Истекло' ELSE 'Сессия завершена' END,
         ended_at   = CASE WHEN CAST(strftime('%s','now') AS INTEGER) - CAST(strftime('%s', started_at) AS INTEGER) >= 7200
                           THEN strftime('%Y-%m-%dT%H:%M:%SZ', started_at, '+2 hours')
                           ELSE strftime('%Y-%m-%dT%H:%M:%SZ','now') END
   WHERE id = OLD.act_as_id AND ended_at IS NULL;
END;
