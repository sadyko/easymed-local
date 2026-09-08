-- 111_admission_title_sheet_papers.sql — INPATIENT_DOCS_V1: бумаги при поступлении.
--
-- Владелец: три документа при поступлении — договор на госпитализацию,
-- информированное согласие, памятка стационара — печатаются из окна
-- размещения, и медсестра отмечает, что пациент их подписал (памятку —
-- получил). Решение владельца: отметку ХРАНИТЬ, размещение ею НЕ блокировать.
--
-- Три отметки — три времени на титульном листе (миграция 110): NULL — не
-- подписан, иначе — когда отмечено. Хранится время, а не флаг: «подписан» без
-- «когда» на разборе ничего не стоит.
--
-- Только ADD COLUMN — пересборки нет (урок 1.1.0).
ALTER TABLE admission_title_sheets ADD COLUMN contract_signed_at TEXT;
ALTER TABLE admission_title_sheets ADD COLUMN consent_signed_at  TEXT;
ALTER TABLE admission_title_sheets ADD COLUMN memo_given_at      TEXT;
