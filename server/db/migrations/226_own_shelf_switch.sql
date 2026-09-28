-- OWN_SHELF_ONLY_V1 (ревью F5, F6; 2026-09-28) — ПЕРЕКЛЮЧАТЕЛЬ «ТОЛЬКО СО СВОИХ
-- ПОЛОК» И ОЧЕРЕДЬ «НЕ СПИСАНО СО СКЛАДА».
--
-- F5. Владелец: «Clinics keep working as today. The admin turns it on in
-- settings once the warehouse has issued stock to rooms and nurses. The
-- settings screen shows what is still missing.» Правило «врач и медсестра
-- выдают пациенту только со своих полок» — ПЕРЕКЛЮЧАТЕЛЬ клиники, и он
-- ВЫКЛЮЧЕН у каждой клиники, старой и новой: выключенный — всё как в 3.12.1
-- (своих полок не хватило — добирает склад). Остаток склада врачу и медсестре
-- не показывается при любом положении — это вторая просьба владельца, и она
-- от переключателя не зависит. Включает и выключает только администратор;
-- кто и когда — в журнале (stock_settings_log), с тем, что готовность в эту
-- минуту называла недостающим.
--
-- Настройка — этой установки (этого здания), а не всей сети: склад, полки и
-- их готовность у каждого здания свои, поэтому таблица не ездит соседям.
CREATE TABLE stock_settings (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  own_shelf_only  INTEGER NOT NULL DEFAULT 0 CHECK (own_shelf_only IN (0, 1)),
  changed_by      INTEGER REFERENCES users(id),
  changed_at      TEXT
);
INSERT INTO stock_settings (id, own_shelf_only) VALUES (1, 0);

CREATE TABLE stock_settings_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  own_shelf_only  INTEGER NOT NULL CHECK (own_shelf_only IN (0, 1)),
  changed_by      INTEGER REFERENCES users(id),
  changed_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  missing         TEXT NOT NULL DEFAULT '[]'
);

-- F6. Владелец: «The dose is recorded, so the patient's chart is never
-- blocked. The drug is marked «не списано со склада», and the warehouse sees
-- it in a list to settle.» Отметка «введено» (и «расход сверх дозы») при
-- включённом переключателе, когда препарата нет на полках медсестры, НЕ
-- отказывается: доза записана, начисление пациенту — та же строка
-- admission_services, что у обычной выдачи (деньги — один раз, в момент
-- отметки), склад не тронут, а сюда ложится «не списано со склада»,
-- привязанное к строке и к отметке. Склад («Списать») берёт товар со склада
-- или с выбранной полки ровно один раз обычным движением журнала на ту же
-- строку — и отмена отметки после этого возвращает товар обычным путём.
-- Отмена до списания снимает и строку (деньги), и эту запись; строка,
-- удалённая любым путём, закрывает запись триггером ниже.
CREATE TABLE stock_pending_writeoffs (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  admission_service_id  INTEGER NOT NULL UNIQUE,
  administration_id     INTEGER REFERENCES treatment_administrations(id),
  admission_id          INTEGER NOT NULL REFERENCES admissions(id),
  product_id            INTEGER NOT NULL REFERENCES products(id),
  base_qty              REAL NOT NULL CHECK (base_qty > 0),
  qty                   REAL NOT NULL CHECK (qty > 0),
  unit                  TEXT NOT NULL DEFAULT '',
  kind                  TEXT NOT NULL DEFAULT 'dose' CHECK (kind IN ('dose', 'extra')),
  given_by              INTEGER REFERENCES users(id),
  given_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  status                TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'settled', 'cancelled')),
  settled_by            INTEGER REFERENCES users(id),
  settled_at            TEXT,
  settled_from_type     TEXT CHECK (settled_from_type IS NULL OR settled_from_type IN ('warehouse', 'staff', 'room', 'department')),
  settled_from_id       INTEGER,
  cancelled_at          TEXT,
  cancel_note           TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_stock_pending_open ON stock_pending_writeoffs(status, given_at);

CREATE TRIGGER admission_services_pending_cancel AFTER DELETE ON admission_services
BEGIN
  UPDATE stock_pending_writeoffs
     SET status = 'cancelled', cancelled_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'),
         cancel_note = CASE WHEN cancel_note = '' THEN 'строка начисления удалена' ELSE cancel_note END
   WHERE admission_service_id = OLD.id AND status = 'pending';
END;
