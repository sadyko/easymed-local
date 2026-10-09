-- CRM_UNIFY_V1 (2026-10-09) — НАСТРОЙКИ CRM-КАНБАНА ЭТОЙ УСТАНОВКИ.
--
-- booked_stage — «Колонка записи»: куда переходит карточка, когда пациента
-- записали. NULL — правило по умолчанию («Записан», если она есть и видна,
-- иначе последняя открытая видимая колонка до «Пришёл»). Внешнего ключа нет
-- намеренно: колонку можно скрыть, переставить или удалить, и правка колонок
-- не должна падать на этой настройке — недопустимый выбор просто не действует
-- (public/js/shared/crm-booked-stage.js).
--
-- «Колонка конверсии (пришёл)» здесь НЕ хранится: это вид won у колонки
-- (crm_stages.kind, единственность — индекс crm_stages_one_won, миграция 077),
-- и всё, что ищет конверсию, читает его (wonStageKey). Выбор в настройках
-- переносит вид одной транзакцией (services/crm/config.js saveCrmSettings) и
-- отмечается здесь же: кто и когда (changed_by, changed_at). ON DELETE SET NULL:
-- однажды сохранённая настройка не должна запрещать удаление сотрудника
-- (routes/users.js staffHistoryFkRefs считает такой ключ историей).
--
-- window_hours — окно повторного обращения (решение владельца 4): звонок или
-- запись в пределах окна от последнего движения карточки — та же карточка.
--
-- Настройка — этого здания: таблица соседям не ездит (как stock_settings).
CREATE TABLE crm_settings (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  booked_stage  TEXT,
  window_hours  INTEGER NOT NULL DEFAULT 72 CHECK (window_hours BETWEEN 1 AND 720),
  changed_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  changed_at    TEXT
);
INSERT INTO crm_settings (id, booked_stage, window_hours) VALUES (1, NULL, 72);
