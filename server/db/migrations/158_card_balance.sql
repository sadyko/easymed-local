-- CARD_BALANCE_V1 (2026-09-26) — ПОДАРОЧНЫЕ КАРТЫ И СЕРТИФИКАТЫ С ОСТАТКОМ.
--
-- Владелец: «amount should be set». Офлайн карта (patient_discounts вида
-- gift_card / certificate) остатка не имела и снимала свою ПОЛНУЮ сумму с
-- каждого визита, пока не истечёт срок. Теперь карта — хранимые деньги:
--
--   amount    — номинал (как был);
--   remaining — остаток; уменьшается оплатой способом 'gift_card' и
--               возвращается возвратом платежа. У промокода — NULL.
--
-- Остаток пишет ТОЛЬКО сервер (domain/cards.js), в реестре он только для
-- чтения. CHECK — последняя стена: даже ошибка в коде не уведёт карту в минус.
ALTER TABLE patient_discounts ADD COLUMN remaining REAL CHECK (remaining IS NULL OR remaining >= 0);

-- Выпущенные карты — полным номиналом: по ним ещё не было ни одного списания
-- остатка (раньше остатка просто не существовало).
UPDATE patient_discounts SET remaining = MAX(amount, 0) WHERE kind IN ('gift_card', 'certificate');

-- Журнал движения остатка: −списание (оплата счёта), +возврат. По нему возврат
-- платежа находит, на какую карту вернуть деньги.
CREATE TABLE card_ledger (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  discount_id      INTEGER NOT NULL REFERENCES patient_discounts(id),
  invoice_id       INTEGER REFERENCES invoices(id) ON DELETE SET NULL,
  payment_id       INTEGER REFERENCES payments(id) ON DELETE SET NULL,
  amount           REAL NOT NULL,
  remaining_after  REAL,
  note             TEXT,
  created_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_card_ledger_discount ON card_ledger(discount_id);
CREATE INDEX idx_card_ledger_payment ON card_ledger(payment_id);

-- Номинал карты не бывает отрицательным (ревью I2): отрицательная карта —
-- это не подарок, а долг, который нечем объяснить.
CREATE TRIGGER patient_discounts_card_amount_ins
BEFORE INSERT ON patient_discounts
WHEN NEW.kind IN ('gift_card', 'certificate') AND NEW.amount < 0
BEGIN
  SELECT RAISE(ABORT, 'Номинал карты или сертификата не может быть отрицательным.');
END;

-- Карту заводит админ в «Скидки и сертификаты» (обычная вставка строки) — её
-- остаток рождается равным номиналу.
CREATE TRIGGER patient_discounts_card_remaining_ins
AFTER INSERT ON patient_discounts
WHEN NEW.kind IN ('gift_card', 'certificate') AND NEW.remaining IS NULL
BEGIN
  UPDATE patient_discounts SET remaining = NEW.amount WHERE id = NEW.id;
END;

-- Ревью I2 — ОСТАТОК СЧИТАЕТСЯ ИЗ ЖУРНАЛА, А НЕ СДВИГАЕТСЯ.
--
-- Прежний триггер сдвигал остаток на разницу номинала и зажимал его нулём:
-- опустил номинал ниже потраченного — остаток 0, поднял обратно — появились
-- деньги, которых на карте не было. Теперь остаток = номинал + сумма журнала
-- (списания там со знаком минус, возвраты — плюс), а номинал ниже уже
-- потраченного — отказ.
CREATE TRIGGER patient_discounts_card_amount_upd
BEFORE UPDATE OF amount ON patient_discounts
WHEN NEW.kind IN ('gift_card', 'certificate')
 AND (NEW.amount < 0
      OR NEW.amount + COALESCE((SELECT SUM(amount) FROM card_ledger WHERE discount_id = NEW.id), 0) < 0)
BEGIN
  SELECT RAISE(ABORT, 'Номинал меньше того, что по карте уже потрачено, — так нельзя.');
END;

-- Вид карты с движениями не меняется: промокод без остатка стёр бы её деньги,
-- а смена карты на сертификат — её историю.
CREATE TRIGGER patient_discounts_card_kind_upd
BEFORE UPDATE OF kind ON patient_discounts
WHEN NEW.kind IS NOT OLD.kind
 AND OLD.kind IN ('gift_card', 'certificate')
 AND EXISTS (SELECT 1 FROM card_ledger WHERE discount_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'У карты уже есть оплаты — её вид менять нельзя. Выключите её и заведите новую.');
END;

CREATE TRIGGER patient_discounts_card_remaining_upd
AFTER UPDATE OF amount, kind ON patient_discounts
BEGIN
  UPDATE patient_discounts SET remaining = CASE
      WHEN NEW.kind NOT IN ('gift_card', 'certificate') THEN NULL
      ELSE NEW.amount + COALESCE((SELECT SUM(amount) FROM card_ledger WHERE discount_id = NEW.id), 0)
    END
  WHERE id = NEW.id;
END;

