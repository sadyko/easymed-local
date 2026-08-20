-- PAGED_LIST_V1 — индексы под большую картотеку (70k+ пациентов).
--
-- Раздел «Пациенты» читается страницами: ORDER BY created_at DESC LIMIT 50.
-- Без индекса SQLite обязан прочитать и отсортировать ВСЮ таблицу, чтобы отдать
-- первые полсотни строк; с индексом он идёт по нему и останавливается на 50-й.
-- id добавлен вторым ключом — тот же порядок, что и в запросе (устойчивое
-- листание при одинаковом created_at).
CREATE INDEX IF NOT EXISTS idx_patients_created_at ON patients(created_at DESC, id DESC);

-- Регистрация проверяет дубли по ПИНФЛ на КАЖДОМ сохранении пациента
-- (savePatient → duplicate guard). Без индекса это полный скан картотеки.
CREATE INDEX IF NOT EXISTS idx_patients_national_id ON patients(national_id);

-- MRN печатается на всех документах и служит ключом при реимпорте Excel
-- (matchFields: mrn, national_id) — поиск по нему точный, индекс работает.
CREATE INDEX IF NOT EXISTS idx_patients_mrn ON patients(mrn);

-- Сортировки и поиск по фамилии в подборе пациента (регистрация, CRM, мастер
-- услуг). Подстроковый поиск '%x%' индекс не использует, но префиксный и
-- ORDER BY — да.
CREATE INDEX IF NOT EXISTS idx_patients_last_name ON patients(last_name);
CREATE INDEX IF NOT EXISTS idx_patients_full_name ON patients(full_name);

-- Дочерние таблицы: карта пациента и касса открываются «по patient_id», и на
-- большой базе это тоже должно быть точечным поиском, а не сканом.
CREATE INDEX IF NOT EXISTS idx_visits_patient      ON visits(patient_id);
CREATE INDEX IF NOT EXISTS idx_invoices_patient    ON invoices(patient_id);
CREATE INDEX IF NOT EXISTS idx_crm_requests_patient ON crm_requests(patient_id);
