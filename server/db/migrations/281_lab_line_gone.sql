-- LAB_ONE_BARCODE_V1 (мигр. 281, 2026-11-08, выпуск 3.22.0, ревью S3 L-4) —
-- СЛЕД УДАЛЁННОЙ СТРОКИ ВИЗИТА ДЛЯ ЭТИКЕТКИ ДНЯ.
--
-- Этикетка дня визита — 90000000 + номер самой старой открытой строки дня
-- (public/js/shared/lab-day-label.js). Строку потом могут удалить (счёт
-- аннулировали, неоплаченную строку сняли), а номер уже наклеен на пробирки — и
-- приём отвечал «заказ по номеру пробы не найден». Здесь остаётся визит и даты
-- удалённой строки: приём (server/lis/ingest.js goneDayKey) находит по ним
-- другую строку того же визита и дня и кладёт пробу, как по живому номеру.
--
-- Пишется ТРИГГЕРОМ: путей удаления строки визита много (касса, регистратура,
-- CRM, склад, связь зданий, «Удалить тестовые данные»), и дописать след в каждый —
-- значит однажды забыть. Данных пациента здесь нет — только номера и даты.
--
-- Только добавление (таблица и триггер): ни одна существующая строка не
-- переписывается.
CREATE TABLE IF NOT EXISTS lab_line_gone (
  line_id      INTEGER PRIMARY KEY,   -- номер удалённой строки visit_services
  visit_id     INTEGER NOT NULL,      -- её визит (без внешнего ключа: визит тоже могут удалить)
  created_at   TEXT,                  -- даты строки — день считается, как у приёма (orderAge)
  scheduled_at TEXT,
  gone_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TRIGGER IF NOT EXISTS visit_services_lab_gone AFTER DELETE ON visit_services
  WHEN OLD.visit_id IS NOT NULL
  BEGIN
    INSERT OR REPLACE INTO lab_line_gone (line_id, visit_id, created_at, scheduled_at)
      VALUES (OLD.id, OLD.visit_id, OLD.created_at, OLD.scheduled_at);
  END;
