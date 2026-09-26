-- DEPOSIT_WALLET_V1, ревью I1 (2026-09-26) — ЖУРНАЛ БАЛАНСА НЕ ПОДДЕЛАТЬ.
--
-- Баланс пациента — это сумма строк patient_deposits. Пока реестр пускал
-- клиента вставлять строки с любым статусом, править статус и сумму и
-- удалять их, «положить себе миллион» можно было одним запросом из браузера.
-- Клиентская запись закрыта в реестре (schema-registry.js). Здесь — правила
-- в самой базе. Честно о границе: триггер не знает, КТО пишет; от кода
-- сервера он не защищает, он страхует от ошибки в нём и от прямой правки
-- строк. Вставку строк с деньгами и перевод депозита в «принят» он пускает
-- только под разрешением ledger_write_token, которое серверная дверь кладёт
-- на время своей записи в той же транзакции (domain/wallet.js):
--
--   • строку зачисления (credit) и списания (spend) нельзя ни править, ни
--     удалять: это следы движения денег. Разрешено одно — обнуление
--     payment_id, которое делает сама база, если платёж удалён (ON DELETE SET
--     NULL);
--   • вид строки не меняется никогда;
--   • сумма меняется только у депозита, который ещё ждёт кассу (pending);
--   • удалить можно только депозит, по которому денег не брали (pending /
--     cancelled). Кэшбэк не удаляется — его откатывают статусом;
--   • возвращённое (refund_amount) — от 0 до суммы строки;
--   • строку с деньгами (зачисление, списание, кэшбэк, принятый/возвращённый
--     депозит) вставляет и депозит в «принят» переводит только сервер.
-- Плюс процент правила кэшбэка — от 0 до 100.
--
-- Штатные пути работают как прежде: приём депозита (pending → received),
-- отмена (→ cancelled), возврат депозита (→ refunded + refund_amount),
-- откат кэшбэка (→ refunded).

-- Кэшбэк, начисленный прежним экраном, — строка вида deposit с меткой
-- «cashback:<id счёта>» в примечании. Называем его своим видом и привязываем
-- к счёту: так его видит и откатывает серверное правило (rpc/cashback.js).
-- Ре-ревью п.7 — кэшбэк, чей счёт уже удалён, тоже становится кэшбэком (без
-- счёта): иначе он висел бы в кассе «принятым депозитом», который можно
-- выдать деньгами.
UPDATE patient_deposits
   SET kind = 'cashback',
       invoice_id = COALESCE(invoice_id,
         (SELECT i.id FROM invoices i WHERE i.id = CAST(substr(notes, instr(notes, 'cashback:') + 9) AS INTEGER)))
 WHERE kind = 'deposit' AND created_by_name = 'Cashback' AND instr(COALESCE(notes, ''), 'cashback:') > 0;

-- Разрешение серверной двери на запись денег (см. шапку). Строки живут только
-- внутри транзакции записи.
CREATE TABLE ledger_write_token (id INTEGER PRIMARY KEY AUTOINCREMENT);

CREATE TRIGGER patient_deposits_money_insert_server_only
BEFORE INSERT ON patient_deposits
WHEN (NEW.kind IN ('credit', 'spend', 'cashback') OR NEW.status IN ('received', 'refunded'))
 AND NOT EXISTS (SELECT 1 FROM ledger_write_token)
BEGIN
  SELECT RAISE(ABORT, 'Строку баланса с деньгами записывает только сервер (касса).');
END;

-- Третья проверка, M2 — статус и «возвращено» у строки с деньгами меняет
-- только сервер. Без разрешения можно одно: отменить ждущий депозит
-- (pending → cancelled), по которому денег не брали.
CREATE TRIGGER patient_deposits_money_change_server_only
BEFORE UPDATE OF status, refund_amount ON patient_deposits
WHEN (NEW.status IS NOT OLD.status OR NEW.refund_amount IS NOT OLD.refund_amount)
 AND NOT (OLD.kind = 'deposit' AND OLD.status = 'pending' AND NEW.status = 'cancelled' AND NEW.refund_amount IS OLD.refund_amount)
 AND NOT EXISTS (SELECT 1 FROM ledger_write_token)
BEGIN
  SELECT RAISE(ABORT, 'Статус и возвращённую сумму строки баланса меняет только сервер (касса).');
END;

-- Кэшбэк принадлежит своему счёту: по нему он оценивается и откатывается.
CREATE TRIGGER patient_deposits_cashback_invoice_frozen
BEFORE UPDATE OF invoice_id ON patient_deposits
WHEN OLD.kind = 'cashback' AND NEW.invoice_id IS NOT OLD.invoice_id
BEGIN
  SELECT RAISE(ABORT, 'Кэшбэк привязан к своему счёту — перевесить его на другой счёт нельзя.');
END;

CREATE TRIGGER patient_deposits_refund_range_ins
BEFORE INSERT ON patient_deposits
WHEN NEW.refund_amount IS NOT NULL AND (NEW.refund_amount < 0 OR NEW.refund_amount > NEW.amount)
BEGIN
  SELECT RAISE(ABORT, 'Возвращено (refund_amount) должно быть от 0 до суммы строки.');
END;

CREATE TRIGGER patient_deposits_refund_range_upd
BEFORE UPDATE OF refund_amount ON patient_deposits
WHEN NEW.refund_amount IS NOT NULL AND (NEW.refund_amount < 0 OR NEW.refund_amount > NEW.amount)
BEGIN
  SELECT RAISE(ABORT, 'Возвращено (refund_amount) должно быть от 0 до суммы строки.');
END;

-- Ре-ревью п.4 — процент кэшбэка от 0 до 100: правило «150 %» раздавало бы
-- больше, чем пациент заплатил.
CREATE TRIGGER cashback_rules_percent_ins
BEFORE INSERT ON cashback_rules
WHEN NEW.percent < 0 OR NEW.percent > 100
BEGIN
  SELECT RAISE(ABORT, 'Процент кэшбэка должен быть от 0 до 100.');
END;

CREATE TRIGGER cashback_rules_percent_upd
BEFORE UPDATE OF percent ON cashback_rules
WHEN NEW.percent < 0 OR NEW.percent > 100
BEGIN
  SELECT RAISE(ABORT, 'Процент кэшбэка должен быть от 0 до 100.');
END;

CREATE TRIGGER patient_deposits_ledger_frozen
BEFORE UPDATE ON patient_deposits
WHEN OLD.kind IN ('credit', 'spend')
 AND (NEW.amount IS NOT OLD.amount OR NEW.status IS NOT OLD.status OR NEW.kind IS NOT OLD.kind
      OR NEW.invoice_id IS NOT OLD.invoice_id
      OR NEW.refund_amount IS NOT OLD.refund_amount)
BEGIN
  SELECT RAISE(ABORT, 'Строки журнала баланса (зачисление, списание) не меняются — это следы движения денег.');
END;

-- PATIENT_MERGE_MONEY_V1 — ЕДИНСТВЕННАЯ смена владельца строки баланса —
-- объединение дублей (rpc/patient-merge-money.js). Сервер кладёт сюда пару
-- «дубль → оставленная карта» на время своей транзакции и убирает её в той же
-- транзакции; строка баланса переезжает только по такой паре. Любая другая
-- смена patient_id — отказ.
CREATE TABLE merge_money_moves (
  drop_id  INTEGER NOT NULL,
  keep_id  INTEGER NOT NULL,
  PRIMARY KEY (drop_id, keep_id)
);

CREATE TRIGGER patient_deposits_owner_frozen
BEFORE UPDATE OF patient_id ON patient_deposits
WHEN NEW.patient_id IS NOT OLD.patient_id
 AND NOT EXISTS (SELECT 1 FROM merge_money_moves WHERE drop_id = OLD.patient_id AND keep_id = NEW.patient_id)
BEGIN
  SELECT RAISE(ABORT, 'Строка журнала баланса переходит к другому пациенту только при объединении дублей.');
END;

CREATE TRIGGER patient_deposits_kind_frozen
BEFORE UPDATE OF kind ON patient_deposits
WHEN NEW.kind IS NOT OLD.kind
BEGIN
  SELECT RAISE(ABORT, 'Вид строки журнала баланса не меняется.');
END;

CREATE TRIGGER patient_deposits_amount_frozen
BEFORE UPDATE OF amount ON patient_deposits
WHEN NEW.amount IS NOT OLD.amount AND OLD.status <> 'pending'
BEGIN
  SELECT RAISE(ABORT, 'Сумма в журнале баланса меняется только у депозита, по которому ещё не взяли деньги.');
END;

CREATE TRIGGER patient_deposits_no_delete
BEFORE DELETE ON patient_deposits
WHEN OLD.kind <> 'deposit' OR OLD.status NOT IN ('pending', 'cancelled')
BEGIN
  SELECT RAISE(ABORT, 'Строку журнала баланса с деньгами удалить нельзя — её можно только вернуть.');
END;
