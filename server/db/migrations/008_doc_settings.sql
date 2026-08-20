CREATE TABLE doc_settings (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  clinic_name   TEXT NOT NULL DEFAULT '',
  address       TEXT NOT NULL DEFAULT '',
  phone         TEXT NOT NULL DEFAULT '',
  email         TEXT NOT NULL DEFAULT '',
  license       TEXT NOT NULL DEFAULT '',
  logo_data_url TEXT NOT NULL DEFAULT '',
  accent_color  TEXT NOT NULL DEFAULT '#167873',
  paper_size    TEXT NOT NULL DEFAULT 'A4' CHECK (paper_size IN ('A4','A5','Letter')),
  show_watermark INTEGER NOT NULL DEFAULT 1,
  footer_note   TEXT NOT NULL DEFAULT 'Thank you for choosing our clinic.',
  legal_note    TEXT NOT NULL DEFAULT '',
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
INSERT INTO doc_settings (id) VALUES (1);
