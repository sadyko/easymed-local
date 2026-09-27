-- V3120_PERF (2026-09-27) — индексы под дневные экраны и отчёты.
--
-- Инспекция 3.12.0 прогнала экраны на синтетической клинике за три года
-- (300 тыс. визитов, 1 млн строк визита, 350 тыс. счетов и оплат). База одна и
-- однопоточная: медленный запрос держит ВСЕ экраны клиники, пока не кончится.
-- Самые дорогие места читали таблицу целиком там, где хватило бы дерева:
--
--   * seenLetters() (domain/buildings.js) — на КАЖДЫЙ отчёт и дашборд шесть
--     `SELECT DISTINCT sync_origin … WHERE sync_origin IS NOT NULL` по шести
--     большим таблицам: 528 мс полного чтения. Частичный индекс по
--     sync_origin содержит только приехавшие от соседей строки (у одиночной
--     клиники — ноль), и буквы берутся из него прыжками по дереву.
--   * «последние N строк» (очередь процедур, кабинет врача, история кассы)
--     сортировали всю таблицу ради LIMIT 300/500: visit_services(created_at),
--     visit_services(doctor_id, created_at), payments(paid_at),
--     admission_services(created_at).
--   * периоды по дате: счета (created_at, paid_at, voided_at, status),
--     оплаты (paid_at), палатные услуги (performed_at), заявки CRM
--     (created_at), результаты анализов (verified_at — опрос Telegram-рассылки
--     `verified_at > сейчас−N` каждые полминуты читал 1,2 млн строк).
--     Индекс работает там, где предикат записан диапазоном по самой колонке
--     (day.js: utcRange / localRangeWhere); `date(col,'localtime')` индекс не
--     берёт — такие места переписываются по одному, с тестом равенства.
--   * admissions(patient_id) — карта пациента и проверка «уже лежит» искали
--     госпитализации пациента перебором.
--
-- Проверено по sqlite_master свежей базы: ни одного из этих индексов нет.
-- lab_results(visit_service_id) уже есть (idx_lab_results_vs) — не дублируется.
-- IF NOT EXISTS — на случай, если соседняя миграция успела завести тот же ИМЕННО
-- с этим именем.
--
-- БЕЗОПАСНО ДЛЯ ФИЛИАЛОВ: только CREATE INDEX. Ни одна строка не меняется, ни
-- один журнальный триггер (084_sync_journal.sql) не срабатывает, в sync_journal
-- не появляется ничего.
--
-- ЦЕНА ОБНОВЛЕНИЯ: на трёхлетней базе (1,1 ГБ) файл выполняется за ~6 с
-- (замер в отчёте V3120_PERF) — один раз, при установке версии.

-- Буквы соседних зданий (seenLetters) — частичные: только приехавшие строки.
CREATE INDEX IF NOT EXISTS idx_invoices_sync_origin       ON invoices(sync_origin)       WHERE sync_origin IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payments_sync_origin       ON payments(sync_origin)       WHERE sync_origin IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_visit_services_sync_origin ON visit_services(sync_origin) WHERE sync_origin IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_visits_sync_origin         ON visits(sync_origin)         WHERE sync_origin IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_patients_sync_origin       ON patients(sync_origin)       WHERE sync_origin IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_lab_results_sync_origin    ON lab_results(sync_origin)    WHERE sync_origin IS NOT NULL;

-- Строки визита: «последние» и периоды.
CREATE INDEX IF NOT EXISTS idx_visit_services_created        ON visit_services(created_at);
CREATE INDEX IF NOT EXISTS idx_visit_services_doctor_created ON visit_services(doctor_id, created_at);

-- Деньги.
CREATE INDEX IF NOT EXISTS idx_payments_paid_at       ON payments(paid_at);
CREATE INDEX IF NOT EXISTS idx_invoices_created       ON invoices(created_at);
CREATE INDEX IF NOT EXISTS idx_invoices_paid_at       ON invoices(paid_at);
-- (status, created_at), а не голый status: левый префикс отвечает на «все
-- неоплаченные» так же, а вторая колонка отдаёт их уже по дате.
CREATE INDEX IF NOT EXISTS idx_invoices_status_created ON invoices(status, created_at);
-- Аннулированных — единицы на тысячи; частичный индекс держит только их.
CREATE INDEX IF NOT EXISTS idx_invoices_voided_at     ON invoices(voided_at) WHERE voided_at IS NOT NULL;

-- Стационар.
CREATE INDEX IF NOT EXISTS idx_admission_services_performed ON admission_services(performed_at);
CREATE INDEX IF NOT EXISTS idx_admission_services_created   ON admission_services(created_at);
CREATE INDEX IF NOT EXISTS idx_admissions_patient           ON admissions(patient_id);

-- Лаборатория: «выдано после…» (Telegram-рассылка, статистика).
CREATE INDEX IF NOT EXISTS idx_lab_results_verified ON lab_results(verified_at) WHERE verified_at IS NOT NULL;

-- Колл-центр: отчёт за период и «мои заявки».
CREATE INDEX IF NOT EXISTS idx_crm_requests_created  ON crm_requests(created_at);
CREATE INDEX IF NOT EXISTS idx_crm_requests_assigned ON crm_requests(assigned_to);
