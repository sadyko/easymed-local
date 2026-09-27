-- PAY_PERIOD_CLOSE_V1 (владелец, 2026-09-27) — «ЗАКРЫТЫЙ МЕСЯЦ ЗАМОРОЖЕН».
--
-- Выплата врачу считается по выполненной работе на лету, и прошлый месяц
-- менялся задним числом: поздно отмеченный анализ, возврат, скидка, отмена
-- счёта, пересчёт ступени — и выплаченная уже сумма в отчёте становилась
-- другой. Теперь месяц можно ЗАКРЫТЬ (pay_period_close): строки выплаты каждого
-- врача за этот месяц — работа, стационар, вознаграждения за направления и
-- корректировки прошлых месяцев — записываются сюда как есть, и отчёты и
-- кабинет за закрытый месяц показывают именно эту запись. Изменение, задевшее
-- закрытый месяц, появляется строкой КОРРЕКТИРОВКИ в первом открытом месяце
-- после него (reports.js, payAdjustments), и итог закрытого месяца не двигается.
--
-- Открыть месяц обратно — только администратор (pay_period_reopen), с записью
-- в журнале.
CREATE TABLE pay_periods (
  month       TEXT PRIMARY KEY CHECK (month GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'),
  closed_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  closed_by   INTEGER REFERENCES users(id),
  total       REAL NOT NULL DEFAULT 0,
  lines       INTEGER NOT NULL DEFAULT 0
);

-- Строка снимка: одна строка выплаты, как её показывал отчёт в момент закрытия.
--   kind     — out (амбулатория), in (стационар), ref (за направление),
--              ref_in (за направление в стационар), adj (корректировка);
--   line_key — постоянный ключ исходной строки (по нему считается разница
--              с живым расчётом; у корректировки — ключ исправленной строки);
--   for_month — у корректировки: какой закрытый месяц она исправляет;
--   data     — вся строка JSON-ом, ровно как её читают отчёты.
CREATE TABLE pay_period_lines (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  month       TEXT NOT NULL REFERENCES pay_periods(month) ON DELETE CASCADE,
  doctor_id   INTEGER,
  kind        TEXT NOT NULL CHECK (kind IN ('out', 'in', 'ref', 'ref_in', 'adj')),
  line_key    TEXT NOT NULL,
  for_month   TEXT,
  date        TEXT,
  fee         REAL NOT NULL DEFAULT 0,
  data        TEXT NOT NULL
);
CREATE INDEX idx_pay_period_lines_month ON pay_period_lines(month, doctor_id);
CREATE INDEX idx_pay_period_lines_for ON pay_period_lines(for_month);

-- Журнал: кто и когда закрыл и открыл месяц. Не удаляется вместе с месяцем.
CREATE TABLE pay_period_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  month       TEXT NOT NULL,
  action      TEXT NOT NULL CHECK (action IN ('close', 'reopen')),
  user_id     INTEGER REFERENCES users(id),
  total       REAL,
  note        TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
