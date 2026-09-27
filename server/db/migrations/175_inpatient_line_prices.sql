-- INPATIENT_MONEY_FIX_V1 (2026-09-27) — НЕВЫСТАВЛЕННЫЕ УСЛУГИ СТАЦИОНАРА
-- ПОЛУЧАЮТ ТУ ЦЕНУ, КОТОРУЮ ВОЗЬМЁТ СЧЁТ.
--
-- Строку услуги стационара заводили по цене КАТАЛОГА, а счёт брал личную цену
-- врача (users.service_rates → price): акт показывал 500 000, пациенту
-- выставляли 700 000, а остаток к выписке был меньше счёта-долга. С этой
-- версии строку оценивают при заведении тем же правилом, что и счёт
-- (domain/pricing.js lineUnitPrice). Здесь — то же для строк, заведённых
-- раньше и ещё не выставленных: своя цена врача, иначе каталог. Выставленные
-- строки не трогаются — за ними уже счёт. Денег это не меняет: ровно эту
-- сумму счёт взял бы и без миграции; меняется только то, что показывает акт.
UPDATE admission_services
   SET unit_price = COALESCE(
         (SELECT CAST(json_extract(j.value, '$.price') AS REAL)
            FROM users u,
                 json_each(CASE WHEN json_valid(u.service_rates) THEN u.service_rates ELSE '[]' END) j
           WHERE u.id = admission_services.doctor_id
             AND CAST(json_extract(j.value, '$.service_id') AS INTEGER) = admission_services.service_id
             AND json_extract(j.value, '$.price') IS NOT NULL
             AND CAST(json_extract(j.value, '$.price') AS REAL) >= 0
           LIMIT 1),
         (SELECT price FROM services s WHERE s.id = admission_services.service_id),
         unit_price)
 WHERE invoice_item_id IS NULL AND service_id IS NOT NULL;

UPDATE admission_services
   SET total = ROUND(unit_price * quantity, 2)
 WHERE invoice_item_id IS NULL AND service_id IS NOT NULL;
