-- V3120_FIX (MAJOR, 2026-09-27) — СМЕНА, ЗАКРЫТАЯ В ПОЛНОЧЬ АВТОМАТИЧЕСКИ,
-- НЕ ПЕРЕСЧИТАНА.
--
-- autoCloseStaleShifts (rpc/cashier.js) закрывал забытую через полночь смену
-- так, будто кассир её пересчитал: counted_amount = expected, over_short = 0.
-- История смен показывала «сошлось, 0», хотя ящик никто не открывал, а
-- недостача, случись она, пропадала бесследно — а наличные той смены новая
-- смена начинала с нулевого остатка, хотя они лежали в том же ящике.
--
-- Теперь у такой смены отметка auto_closed = 1, counted_amount и over_short
-- пустые («не пересчитана»), expected_amount — сколько должно лежать; новая
-- смена этого кассира начинается с этой суммы (opening_float), и её пересчёт
-- на закрытии проверяет и вчерашние деньги.
--
-- Старые автозакрытые смены узнаются по примечанию, которое ставил прежний
-- код; их «пересчёт» был выдуман — он стирается.
ALTER TABLE cash_shifts ADD COLUMN auto_closed INTEGER NOT NULL DEFAULT 0;

UPDATE cash_shifts
   SET auto_closed = 1, counted_amount = NULL, over_short = NULL
 WHERE status = 'closed'
   AND instr(COALESCE(notes, ''), 'Закрыта автоматически (конец дня 00:00)') > 0
   AND COALESCE(over_short, 0) = 0
   AND counted_amount IS expected_amount;
