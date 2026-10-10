-- 244 — SERVICES_PACKAGES_V1 (2026-10-10): ПАКЕТЫ УСЛУГ ДЛЯ САЙТА И ПАРТНЁРОВ
-- (шаг 6 API клиники, docs/specs/2026-10-06-clinic-api-design.md; план
-- docs/plans/2026-10-10-clinic-api-6-services-packages.md).
--
-- ТОЛЬКО ADD COLUMN. Бэкфилл — только НОВЫХ колонок из прежних (как мигр. 231,
-- 243); прежние колонки, строки и их число не трогаются.
--
-- service_templates — пакет и шаблон сметы по-прежнему одна таблица (мигр.
-- 154), теперь их различает отметка:
--   is_package     — 1: пакет («Пакеты услуг», цена пакета, сайт и партнёры);
--                    0: шаблон сметы (список услуг из «Сохранить как шаблон»).
--                    Пакетом становится то, чему в «Пакетах услуг» дали скидку
--                    или срок — так и раньше (шаг 1, №10) чек отличал пакет.
--   name_uz/name_en — название на узбекском и английском (наружу); name —
--                    по-прежнему русское, его печатают чек и счёт.
--   discount_mode  — как задана скидка: 'percent' / 'amount' / 'price';
--   discount_value — процент (0..100), сумма скидки или итоговая цена пакета.
--                    Раскладку считает одна функция (shared/package-price.js).
--                    discount_percent остаётся: его пишет окно пакета (процент
--                    скидки на день сохранения) — для прежних читателей.
--   show_public    — показывать пакет на сайте и у партнёров. У прежних пакетов
--                    0: наружу ничего не уходит без слова клиники.
-- visit_services — ЦЕНА ПАКЕТА ФИКСИРУЕТСЯ НА СТРОКЕ ПРИ ЗАПИСИ:
--   package_full   — цена услуги без скидки, по которой считалась раскладка;
--   package_price  — цена услуги в пакете (за единицу). Ставит их только
--                    сервер (domain/package-lines.js через routes/db.js); счёт
--                    и оплата врача берут их, а не сегодняшний процент пакета.
--   Обе пусты — строка не из пакета (или из шаблона сметы): обычная строка.
--
-- БЭКФИЛЛ СТРОК, уже заведённых из пакета со скидкой:
--   • выставленные — из их позиции счёта (что выставлено, то и записано): если
--     строку вернут и выставят заново, деньги будут те же;
--   • ещё не выставленные — по прежнему правилу, которое им назвали при записи:
--     процент пакета, а если скидка группы пациента больше — она (так считала
--     смета до шага 6).
--
-- По филиалам ничего нового не ездит: пакеты не ездили (мигр. 154), денег
-- строки визита журнал не везёт (journal.js), а скидка позиции счёта едет, как
-- ехала. CHECK — запасной замок для /api/db: экран и сервер проверяют раньше.

ALTER TABLE service_templates ADD COLUMN is_package INTEGER NOT NULL DEFAULT 0 CHECK (is_package IN (0, 1));
ALTER TABLE service_templates ADD COLUMN name_uz TEXT;
ALTER TABLE service_templates ADD COLUMN name_en TEXT;
ALTER TABLE service_templates ADD COLUMN discount_mode TEXT NOT NULL DEFAULT 'percent'
  CHECK (discount_mode IN ('percent', 'amount', 'price'));
ALTER TABLE service_templates ADD COLUMN discount_value REAL NOT NULL DEFAULT 0
  CHECK (discount_value >= 0 AND (discount_mode <> 'percent' OR discount_value <= 100));
ALTER TABLE service_templates ADD COLUMN show_public INTEGER NOT NULL DEFAULT 0 CHECK (show_public IN (0, 1));

UPDATE service_templates SET is_package = 1
 WHERE discount_percent > 0 OR valid_from IS NOT NULL OR valid_until IS NOT NULL;
UPDATE service_templates SET discount_value = discount_percent WHERE discount_percent > 0;

ALTER TABLE visit_services ADD COLUMN package_full REAL CHECK (package_full IS NULL OR package_full >= 0);
ALTER TABLE visit_services ADD COLUMN package_price REAL
  CHECK (package_price IS NULL OR (package_full IS NOT NULL AND package_price >= 0 AND package_price <= package_full));

-- Выставленные строки пакета со скидкой — из позиции счёта.
UPDATE visit_services
   SET package_full  = (SELECT ii.unit_price FROM invoice_items ii WHERE ii.id = visit_services.invoice_item_id),
       package_price = (SELECT MIN(ii.unit_price, round((ii.total - ii.discount_amount) / ii.quantity, 2))
                          FROM invoice_items ii WHERE ii.id = visit_services.invoice_item_id)
 WHERE package_id IS NOT NULL AND invoice_item_id IS NOT NULL
   AND EXISTS (SELECT 1 FROM invoice_items ii
                WHERE ii.id = visit_services.invoice_item_id
                  AND ii.discount_amount > 0 AND ii.quantity > 0 AND ii.unit_price >= 0
                  AND ii.total >= ii.discount_amount);

-- Невыставленные строки пакета со скидкой — по правилу, которое им назвали:
-- бо́льшая из скидки пакета и скидки действующей группы пациента.
UPDATE visit_services
   SET package_full  = unit_price,
       package_price = round(unit_price * (100 - MAX(
           MIN((SELECT t.discount_percent FROM service_templates t WHERE t.id = visit_services.package_id), 100),
           COALESCE((SELECT MIN(c.discount_percent, 100) FROM visits v
                       JOIN patients p ON p.id = v.patient_id
                       JOIN patient_categories c ON c.id = p.category_id AND c.active = 1
                      WHERE v.id = visit_services.visit_id AND c.discount_percent > 0), 0))) / 100, 2)
 WHERE package_id IS NOT NULL AND invoice_item_id IS NULL AND unit_price >= 0
   AND (SELECT t.discount_percent FROM service_templates t WHERE t.id = visit_services.package_id) > 0;
