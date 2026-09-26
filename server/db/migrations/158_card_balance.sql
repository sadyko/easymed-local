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
UPDATE patient_discounts SET remaining = amount WHERE kind IN ('gift_card', 'certificate');

-- Карту заводит админ в «Скидки и сертификаты» (обычная вставка строки) — её
-- остаток рождается равным номиналу.
CREATE TRIGGER patient_discounts_card_remaining_ins
AFTER INSERT ON patient_discounts
WHEN NEW.kind IN ('gift_card', 'certificate') AND NEW.remaining IS NULL
BEGIN
  UPDATE patient_discounts SET remaining = MAX(NEW.amount, 0) WHERE id = NEW.id;
END;

-- Правка номинала или вида в настройках. Номинал поднят/опущен — остаток
-- сдвигается на ту же разницу (не ниже нуля): потраченное не возвращается и не
-- теряется. Промокод стал картой — остаток = номинал; карта стала промокодом —
-- остатка нет.
CREATE TRIGGER patient_discounts_card_remaining_upd
AFTER UPDATE OF amount, kind ON patient_discounts
BEGIN
  UPDATE patient_discounts SET remaining = CASE
      WHEN NEW.kind NOT IN ('gift_card', 'certificate') THEN NULL
      WHEN OLD.kind NOT IN ('gift_card', 'certificate') OR OLD.remaining IS NULL THEN MAX(NEW.amount, 0)
      ELSE MAX(OLD.remaining + (NEW.amount - OLD.amount), 0)
    END
  WHERE id = NEW.id;
END;

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
