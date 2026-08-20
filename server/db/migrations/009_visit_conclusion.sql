ALTER TABLE visits ADD COLUMN conclusion TEXT NOT NULL DEFAULT '';
ALTER TABLE visits ADD COLUMN conclusion_type TEXT NOT NULL DEFAULT 'consultation'
  CHECK (conclusion_type IN ('consultation','diagnostic'));
