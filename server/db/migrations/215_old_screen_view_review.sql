-- V3121_ROLES (2026-09-28) — «ПРОСМОТР» ОТ СТАРОГО ЭКРАНА «РОЛИ» НА СТАЦИОНАРЕ И СКЛАДЕ.
--
-- ЧТО СЛУЧИЛОСЬ. Экран «Роли» версий 0.9–3.0 называл права действиями, и
-- раздел без своих действий («Стационар», «Закупки») сохранял с уровнем
-- «viewer»: уровень тогда ничего не значил. С 3.1 роль открывается матрицей, и
-- её «Сохранить» переводит старый «viewer» в явный «Просмотр» на КАЖДОМ окне
-- и действии раздела (permission-catalog.js grantsFromLegacy), а «Выписку» и
-- «Выдачу со склада», у которых просмотра нет, — в «Нет». С 3.2 сервер эти
-- ключи проверяет: медсестра не записывает измерения, не отмечает введение
-- препарата; склад не выдаёт со склада.
--
-- ПОЧЕМУ НЕ ИСПРАВЛЯЕМ САМИ. Такую строку нельзя отличить от НАМЕРЕННОГО
-- «только просмотр», выставленного на нынешнем экране: сохранение даёт те же
-- байты. Поэтому права здесь не меняются. Строки с точным отпечатком старого
-- перевода (public/js/shared/old-screen-view.js — тот же отпечаток, тест
-- сверяет) записываются в role_permission_reviews, и экран «Роли» показывает
-- администратору такую роль с выбором: «Вернуть права по умолчанию» или
-- «Оставить как есть». Повторный накат ничего не меняет.
CREATE TABLE IF NOT EXISTS role_permission_reviews (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  role        TEXT NOT NULL,
  area        TEXT NOT NULL CHECK (area IN ('inpatient', 'procurement')),
  found_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  resolution  TEXT CHECK (resolution IS NULL OR resolution IN ('restored', 'kept')),
  resolved_at TEXT,
  resolved_by INTEGER REFERENCES users(id),
  UNIQUE (role, area)
);

-- Стационар: разделы inpatient, mar, kitchen, discharges (старый ключ beds).
INSERT OR IGNORE INTO role_permission_reviews (role, area)
SELECT role, 'inpatient' FROM role_permissions
 WHERE role <> 'admin'
   AND json_valid(permissions)
   AND json_extract(permissions, '$.levels.beds') = 'viewer'
   AND json_extract(permissions, '$.grants."inpatient"') = 'view'
   AND json_extract(permissions, '$.grants."inpatient.requests"') = 'view'
   AND json_extract(permissions, '$.grants."inpatient.patients"') = 'view'
   AND json_extract(permissions, '$.grants."inpatient.beds"') = 'view'
   AND json_extract(permissions, '$.grants."inpatient.history"') = 'view'
   AND json_extract(permissions, '$.grants."inpatient.prescriptions"') = 'view'
   AND json_extract(permissions, '$.grants."inpatient.marks"') = 'view'
   AND json_extract(permissions, '$.grants."inpatient.vitals"') = 'view'
   AND json_extract(permissions, '$.grants."inpatient.reviews"') = 'view'
   AND json_extract(permissions, '$.grants."inpatient.services"') = 'view'
   AND json_extract(permissions, '$.grants."inpatient.discharge"') = 'none'
   AND json_extract(permissions, '$.grants."mar"') = 'view'
   AND json_extract(permissions, '$.grants."mar.outpatient"') = 'view'
   AND json_extract(permissions, '$.grants."mar.inpatient"') = 'view'
   AND json_extract(permissions, '$.grants."kitchen"') = 'view'
   AND json_extract(permissions, '$.grants."discharges"') = 'view';

-- Закупки (старый ключ inventory): «Просмотр» раздела и «Нет» у выдачи.
INSERT OR IGNORE INTO role_permission_reviews (role, area)
SELECT role, 'procurement' FROM role_permissions
 WHERE role <> 'admin'
   AND json_valid(permissions)
   AND json_extract(permissions, '$.levels.inventory') = 'viewer'
   AND json_extract(permissions, '$.grants."procurement"') = 'view'
   AND json_extract(permissions, '$.grants."procurement.issue"') = 'none';
