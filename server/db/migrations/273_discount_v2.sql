-- 273_discount_v2.sql — DISCOUNT_V2 · CASHIER_DISCOUNT_V1 (3.22.0, решения владельца 2026-11-07)
--
-- Только ДОБАВЛЯЕТ колонки. Ни одна прежняя настройка, скидка, группа или счёт не
-- меняется: у всех прежних строк значения по умолчанию дают ровно сегодняшнее
-- поведение.
--
-- 1. «Скидка уменьшает долю врача» — переключатель у скидки («Скидки и
--    сертификаты») и у группы пациентов. 1 — как всегда было: доля врача считается
--    от цены ПОСЛЕ скидки. 0 — клиника берёт скидку на себя: доля врача — от цены
--    ДО скидки. Прежние скидки и группы — 1.
ALTER TABLE patient_discounts ADD COLUMN reduces_doctor_share INTEGER NOT NULL DEFAULT 1
  CHECK (reduces_doctor_share IN (0, 1));
ALTER TABLE patient_categories ADD COLUMN reduces_doctor_share INTEGER NOT NULL DEFAULT 1
  CHECK (reduces_doctor_share IN (0, 1));

-- 2. Счёт помнит, КАКАЯ скидка выбрана и ПОЧЕМУ (п. 4: регистратор выбирает одну
--    скидку, и всегда видно, откуда она):
--      discount_source — 'group' | 'manual' | 'none' | 'promo:<id>'; NULL — счёт до
--                        3.22 (правило прежнее: пол скидки группы пациента);
--      discount_note   — причина словами: «Скидка группы «VIP» — 10%», «Промокод
--                        «ЛЕТО» — 15%», «Касса: постоянный пациент — 5%»;
--      doctor_discount_share — какая ДОЛЯ скидки счёта (без своих скидок строк
--                        пакета и без скидки после продажи) уменьшает долю врача:
--                        1 — вся (как всегда), 0 — никакая; между — смесь, когда к
--                        скидке регистратуры касса добавила свою с другим
--                        переключателем. Прежние счета — 1: отчёты считают их бит
--                        в бит как в 3.21.
--    Колонки свои у здания (как manual_discount, мигр. 219): долю врача по счёту
--    считает только здание счёта — строки соседа приезжают без врача.
ALTER TABLE invoices ADD COLUMN discount_source TEXT;
ALTER TABLE invoices ADD COLUMN discount_note TEXT
  CHECK (discount_note IS NULL OR length(discount_note) <= 500);
ALTER TABLE invoices ADD COLUMN doctor_discount_share REAL NOT NULL DEFAULT 1
  CHECK (doctor_discount_share >= 0 AND doctor_discount_share <= 1);
