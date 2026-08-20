-- Dedicated per-year counter for invoice numbering. Replaces the
-- COUNT(invoices)+1 scheme, which collides / reuses a number if an invoice
-- is ever deleted or a number otherwise skipped. The counter is incremented
-- inside the same transaction as invoice creation, so a rolled-back invoice
-- also rolls back its counter increment (no gaps from failed attempts, and
-- no reuse from successful ones).
CREATE TABLE invoice_counters (
  year     TEXT PRIMARY KEY,
  next_seq INTEGER NOT NULL DEFAULT 1
);
