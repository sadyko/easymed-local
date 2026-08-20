ALTER TABLE services ADD COLUMN type TEXT NOT NULL DEFAULT 'consultation'
  CHECK (type IN ('consultation','lab','procedure','imaging','other'));
-- backfill: existing lab services get type 'lab'
UPDATE services SET type='lab' WHERE is_lab=1;
