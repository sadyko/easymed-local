-- CRM_ONE_WAY_V1 (2026-10-17) — УСЛУГИ ЗАПИСИ ЖИВУТ ТОЛЬКО В ВИЗИТЕ.
-- Спецификация docs/specs/2026-10-17-crm-one-way-booking-design.md (O1–O10), правила —
-- server/services/crm/one-way.js. Миграция 246 не покидала ветку feat/crm-link-all и
-- переписана до выпуска (O10): прежний файл 246_crm_card_patient_links.sql заводил триггер.
--
-- 1. ТРИГГЕР СМЕНЫ ПАЦИЕНТА СНЯТ (O10). Он снимал привязки «только для воронки», когда
--    карточку переводили на другого пациента, — и терял их навсегда при ошибочном клике
--    77 → 78 → 77 (отмена записи оставляла карточку «Записан»), а на каждую запись в
--    crm_requests.patient_id перебирал визиты. Приватность держится ПРИ ЧТЕНИИ: «Записи
--    пациента» (crm_card_bookings) и каждое правило ступени и даты требуют, чтобы визит был
--    визитом пациента карточки. Базы ветки, где прежняя 246 уже прошла, — тоже без триггера.
DROP TRIGGER IF EXISTS crm_requests_patient_display_links;

-- 2. ОТПУЩЕННАЯ СТРОКА КАРТОЧКИ (O3, O4). Запись отменили или её строку визита сняли в
--    другом окне — строка карточки остаётся желанием без дня и без визита; здесь — какой
--    визит её отпустил (released_from_visit_id) и на какую строку визита она указывала
--    (released_vs_id, для O5: ошибочную отмену отменили — строка снова указывает туда).
--    Сама такая строка ни в какой визит не садится (ни записью того же дня, ни опцией
--    «без даты» регистрации), пока оператор не назначит ей день или не запишет снова:
--    правка снимает отметку. Ссылок (REFERENCES) нет нарочно, как у visit_service_id
--    (миграция 187): визит и строку визита удаляют, а след должен остаться.
ALTER TABLE crm_request_services ADD COLUMN released_from_visit_id INTEGER;
ALTER TABLE crm_request_services ADD COLUMN released_vs_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_crm_req_services_released ON crm_request_services(released_from_visit_id);

-- 3. РАЗОВОЕ ИСПРАВЛЕНИЕ ПРИ УСТАНОВКЕ (O8, server/services/crm/one-way-repair.js): копии
--    строк визита, которые зеркало записи заводило в карточках, отмечаются (миграция 248:
--    решение контролёра по ревью r4 — исправление НИЧЕГО не удаляет); строки записи
--    отменённых визитов становятся отпущенными; строку оператора исправление не удаляет
--    никогда. Отметка «сделано» (done_at) ставится в той же транзакции, что и правки;
--    каждая правка — строка журнала.
CREATE TABLE IF NOT EXISTS crm_one_way_repair (
  id       INTEGER PRIMARY KEY CHECK (id = 1),
  done_at  TEXT,
  summary  TEXT
);
INSERT OR IGNORE INTO crm_one_way_repair (id, done_at, summary) VALUES (1, NULL, NULL);
CREATE TABLE IF NOT EXISTS crm_one_way_repair_log (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  line_id           INTEGER,
  request_id        INTEGER,
  visit_id          INTEGER,
  visit_service_id  INTEGER,
  action            TEXT NOT NULL,
  detail            TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
