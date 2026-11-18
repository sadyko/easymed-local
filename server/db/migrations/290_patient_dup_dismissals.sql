-- PATIENT_DUP_RULE_V3 (3.25.0, 2026-11-18) — ОТМЕТКИ «НЕ ДУБЛИКАТ».
--
-- Решение владельца: к уверенным дубликатам (тот же ПИНФЛ; тот же телефон и то же
-- имя) добавляется второй список «Возможные дубликаты — проверьте»: тот же телефон
-- и та же дата рождения при разных именах, или то же ФИО и та же дата рождения
-- (public/js/admin/patient-duplicates.js). Регистратор смотрит группу и либо
-- объединяет карты, либо нажимает «Не дубликат» — и эта ПАРА карт больше во втором
-- списке не показывается: ни завтра, ни на другом компьютере. Здесь хранятся такие
-- пары — кто и когда отметил.
--
-- ТОЛЬКО ДОБАВЛЕНИЕ. Новая таблица; ни одна карта пациента не меняется, журнал
-- связи зданий (084) не пишется. Отметка карты не трогает вовсе — уверенные группы
-- она тоже не скрывает (их правило не меняется).
--
-- ПАРА ОДИН РАЗ: младший id — в a (CHECK), пара уникальна. Пишет только сервер
-- (rpc/patient-duplicates.js patient_dup_dismiss; таблицы нет в реестре /api/db),
-- право — то же, что у объединения карт (администратор).
--
-- ССЫЛКИ. Карта удалена — её отметки уходят с ней (ON DELETE CASCADE): пары больше
-- нет. Объединение карт переносит отметки дубля на оставленную карту
-- (rpc/patient-merge.js MERGE_TABLES, how 'dismissals'): «A — не дубль» остаётся
-- правдой и для карты, в которую дубль влился. Кто отметил — ссылка на сотрудника
-- с ON DELETE SET NULL и копия имени: удалению сотрудника отметка не мешает.
--
-- СВЯЗЬ ЗДАНИЙ: таблица не ездит (её нет в branch-sync/journal.js SHIPPED), как и
-- родство карт (patient_relationships). id карт у каждого здания свои, а список
-- «Возможные дубликаты» каждое здание считает по своей картотеке и разбирает само.
-- «Удалить тестовые данные» её оставляет: карты остаются — остаётся и разбор их пар
-- (test-data-wipe-plan.js, keep('patients')).
CREATE TABLE patient_dup_dismissals (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id_a      INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  patient_id_b      INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  reasons           TEXT NOT NULL DEFAULT '',              -- 'phone_dob', 'name_dob' через запятую — почему пара была в списке
  dismissed_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  dismissed_by_name TEXT NOT NULL DEFAULT '',
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (patient_id_a < patient_id_b),
  UNIQUE (patient_id_a, patient_id_b)
);
-- Поиск по второй карте пары (удаление и объединение карты b); по первой — индекс UNIQUE.
CREATE INDEX idx_patient_dup_dismissals_b ON patient_dup_dismissals(patient_id_b);
