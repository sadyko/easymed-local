-- V3120_FINAL (C1, 2026-09-28) — СКИДКА ПОСЛЕ ПРОДАЖИ ХРАНИТСЯ У СЧЁТА.
--
-- Частичный возврат по оплаченному счёту уменьшает сумму счёта (V3120_FIX,
-- billing.js refundPayment): discount_amount += возвращённое, total = оплачено.
-- Прочитать ЭТУ часть скидки отдельно было не из чего, и отчёты разносили её
-- как ручную скидку — только по строкам без своей скидки (пакет): у счёта из
-- одних строк пакета она не доходила ни до одной строки, у смешанного её
-- забирала обычная строка до нуля, а фиксированная ставка врача и фикс
-- вознаграждения не уменьшались вовсе (коэффициент возврата после «сумма =
-- оплачено» равен 1).
--
-- post_sale_discount — сколько из discount_amount счёта дано ПОСЛЕ продажи.
-- Отчёты (reports.js ITEM_DISCOUNT_SQL) делят её на все строки
-- пропорционально их сумме после своих скидок, а фикс умножают на долю
-- total / (total + post_sale_discount) — ровно те же деньги, что при возврате
-- «с доплатой» или на койке. 0 — скидки после продажи нет (все прежние счета).
ALTER TABLE invoices ADD COLUMN post_sale_discount REAL NOT NULL DEFAULT 0
  CHECK (post_sale_discount >= 0);

-- Колонка — деньги документа, и документ ездит (мигр. 087): без неё сосед
-- разнёс бы скидку как ручную и разошёлся с нами в долях врачей. Журнальный
-- триггер правки счёта — с новой колонкой (перечень колонок обязан совпадать
-- с SHIPPED ∪ REFS ∪ CODE_REFS, journal.test.js сверяет).
DROP TRIGGER IF EXISTS invoices_journal_upd;
CREATE TRIGGER invoices_journal_upd AFTER UPDATE ON invoices
  BEGIN
    INSERT INTO sync_journal (tbl, uid, op, cols)
    SELECT 'invoices', uid, 'put', cols FROM (
      SELECT r.uid AS uid, CASE WHEN OLD.uid IS NULL THEN '*' ELSE rtrim(
             CASE WHEN NEW.invoice_number IS NOT OLD.invoice_number THEN 'invoice_number,' ELSE '' END ||
             CASE WHEN NEW.subtotal IS NOT OLD.subtotal THEN 'subtotal,' ELSE '' END ||
             CASE WHEN NEW.discount_amount IS NOT OLD.discount_amount THEN 'discount_amount,' ELSE '' END ||
             CASE WHEN NEW.post_sale_discount IS NOT OLD.post_sale_discount THEN 'post_sale_discount,' ELSE '' END ||
             CASE WHEN NEW.total_amount IS NOT OLD.total_amount THEN 'total_amount,' ELSE '' END ||
             CASE WHEN NEW.status IS NOT OLD.status THEN 'status,' ELSE '' END ||
             CASE WHEN NEW.created_at IS NOT OLD.created_at THEN 'created_at,' ELSE '' END ||
             CASE WHEN NEW.paid_at IS NOT OLD.paid_at THEN 'paid_at,' ELSE '' END ||
             CASE WHEN NEW.visit_id IS NOT OLD.visit_id THEN 'visit_id,' ELSE '' END ||
             CASE WHEN NEW.patient_id IS NOT OLD.patient_id THEN 'patient_id,' ELSE '' END, ',') END AS cols
        FROM invoices r WHERE r.id = NEW.id AND r.uid IS NOT NULL
    ) WHERE cols <> '';

    INSERT INTO sync_authored (tbl, uid, col, at)
    SELECT 'invoices', r.uid, v.col, strftime('%Y-%m-%dT%H:%M:%fZ','now')
      FROM invoices r
      JOIN (
            SELECT 'invoice_number' AS col WHERE NEW.invoice_number IS NOT OLD.invoice_number
            UNION ALL SELECT 'subtotal' WHERE NEW.subtotal IS NOT OLD.subtotal
            UNION ALL SELECT 'discount_amount' WHERE NEW.discount_amount IS NOT OLD.discount_amount
            UNION ALL SELECT 'post_sale_discount' WHERE NEW.post_sale_discount IS NOT OLD.post_sale_discount
            UNION ALL SELECT 'total_amount' WHERE NEW.total_amount IS NOT OLD.total_amount
            UNION ALL SELECT 'status' WHERE NEW.status IS NOT OLD.status
            UNION ALL SELECT 'created_at' WHERE NEW.created_at IS NOT OLD.created_at
            UNION ALL SELECT 'paid_at' WHERE NEW.paid_at IS NOT OLD.paid_at
            UNION ALL SELECT 'visit_id' WHERE NEW.visit_id IS NOT OLD.visit_id
            UNION ALL SELECT 'patient_id' WHERE NEW.patient_id IS NOT OLD.patient_id
           ) v
     WHERE r.id = NEW.id AND r.uid IS NOT NULL AND OLD.uid IS NOT NULL
    ON CONFLICT(tbl, uid, col) DO UPDATE SET at = excluded.at;
  END;
