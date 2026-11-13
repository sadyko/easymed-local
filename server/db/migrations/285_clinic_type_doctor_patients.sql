-- 285 — SYMPTEX_FIELDS_V1 (2026-11-13): ТИП КЛИНИКИ И «ПРИНИМАЕТ» У ВРАЧА ДЛЯ ПАРТНЁРОВ
-- (план docs/plans/2026-11-13-symptex-fields-type-patients.md).
--
-- Владелец: «add to easymed and also add to the doctor the children/adult option too…
-- make changes so it won't affect real clinics settings». Symptex показывал тип клиники
-- пустым: в Easy-Med такой настройки не было вовсе.
--
-- ТОЛЬКО ADD COLUMN, без бэкфилла: пустое значение — «не указано». После обновления у
-- каждой клиники и каждого врача «не указано», и партнёры получают то же, что до него
-- ("" в /clinic и /doctors), пока клиника сама не выберет.
--
-- doc_settings.clinic_type — тип клиники, слова Symptex: clinic «Клиника»,
--   diagnostics «Диагностический центр», lab «Лаборатория», children «Детская клиника».
--   Общий для клиники (как название): правит главное здание, филиал получает справочником.
-- users.patients_age — кого принимает врач: adults «Взрослых», children «Детей»,
--   all «Взрослых и детей». Часть публичного профиля врача («Мой профиль» и карточка).

ALTER TABLE doc_settings ADD COLUMN clinic_type TEXT NOT NULL DEFAULT ''
  CHECK (clinic_type IN ('', 'clinic', 'diagnostics', 'lab', 'children'));
ALTER TABLE users ADD COLUMN patients_age TEXT NOT NULL DEFAULT ''
  CHECK (patients_age IN ('', 'adults', 'children', 'all'));
