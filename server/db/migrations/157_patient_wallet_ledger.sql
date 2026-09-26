-- DEPOSIT_WALLET_V1 (2026-09-26) — БАЛАНС ПАЦИЕНТА КАК ОДИН ЖУРНАЛ.
--
-- Владелец: «deposit should work, because cashier cancels the payment and can
-- actually refund or push to the deposit so on the next service it can be
-- paid — e.g. when a doctor made an error: the neurologist says after payment
-- and review it's not his patient».
--
-- Журнал — та же таблица patient_deposits: формула баланса у неё уже есть
-- (received +, refunded + остаток, spent −). Не хватало двух видов строк и
-- ссылок, по которым строку можно объяснить:
--
--   kind = 'deposit' — предоплата, как была (все существующие строки);
--   kind = 'credit'  — «Зачислить на баланс пациента» при возврате платежа:
--                      status 'received', invoice_id — счёт, откуда пришли
--                      деньги, payment_id — возвращённый платёж, reason —
--                      причина кассира;
--   kind = 'spend'   — оплата счёта с баланса: status 'spent', invoice_id —
--                      оплаченный счёт, payment_id — платёж способом 'wallet'.
--
-- Строки пишет только сервер (rpc/billing.js, domain/wallet.js). Между
-- зданиями patient_deposits не ездит — как и раньше.
ALTER TABLE patient_deposits ADD COLUMN kind TEXT NOT NULL DEFAULT 'deposit'
  CHECK (kind IN ('deposit', 'credit', 'spend', 'cashback'));
ALTER TABLE patient_deposits ADD COLUMN payment_id INTEGER
  REFERENCES payments(id) ON DELETE SET NULL;
ALTER TABLE patient_deposits ADD COLUMN reason TEXT;
-- CASHBACK_SERVER_V2 — kind = 'cashback': кэшбэк, начисленный оплатой счёта
-- (rpc/cashback.js); cashback_base — новые деньги счёта, с которых он
-- посчитан: по ним возврат откатывает кэшбэк пропорционально.
ALTER TABLE patient_deposits ADD COLUMN cashback_base REAL;

CREATE INDEX idx_patient_deposits_payment ON patient_deposits(payment_id);
