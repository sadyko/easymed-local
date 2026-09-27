-- CARD_SALE_V1 (2026-09-27) — ПРОДАЖА ПОДАРОЧНЫХ КАРТ И СЕРТИФИКАТОВ В КАССЕ.
--
-- Владелец (B2): продажа карты — настоящая продажа. Кассир продаёт карту за её
-- номинал: создаётся счёт CARD-<буква здания>-<ГГ>-<00001> (как DEP- у
-- депозита) со строкой «Подарочная карта …» и платёж наличными / картой /
-- переводом / эквайрингом — это ПРИХОД дня. Погашение картой (способ
-- gift_card) приходом по-прежнему не считается: одни деньги — один приход.
--
--   sale_invoice_id — счёт продажи (NULL — карта выдана без оплаты в
--                     настройках: промо / подарок клиники);
--   sale_number     — номер счёта продажи (CARD-…), его печатают на карте.
--
-- Обе колонки пишет только сервер (rpc/card-sales.js); в реестре они только
-- для чтения.
ALTER TABLE patient_discounts ADD COLUMN sale_invoice_id INTEGER REFERENCES invoices(id);
ALTER TABLE patient_discounts ADD COLUMN sale_number TEXT;
CREATE UNIQUE INDEX idx_patient_discounts_sale_invoice ON patient_discounts(sale_invoice_id) WHERE sale_invoice_id IS NOT NULL;

-- Счётчик номеров CARD- по годам — как invoice_counters / deposit_counters.
CREATE TABLE card_sale_counters (
  year     TEXT PRIMARY KEY,
  next_seq INTEGER NOT NULL DEFAULT 1
);

-- Номинал проданной карты оплачен в кассе: изменить его в настройках значило
-- бы подарить или отнять деньги, за которыми стоит платёж. Вид тоже не
-- меняется (промокод без остатка стёр бы оплаченные деньги).
CREATE TRIGGER patient_discounts_sold_card_frozen
BEFORE UPDATE OF amount, kind, sale_invoice_id, sale_number ON patient_discounts
WHEN OLD.sale_invoice_id IS NOT NULL
 AND (NEW.amount IS NOT OLD.amount OR NEW.kind IS NOT OLD.kind
      OR NEW.sale_invoice_id IS NOT OLD.sale_invoice_id OR NEW.sale_number IS NOT OLD.sale_number)
BEGIN
  SELECT RAISE(ABORT, 'Карта продана в кассе — её номинал и вид менять нельзя. Верните остаток в кассе и продайте новую.');
END;
