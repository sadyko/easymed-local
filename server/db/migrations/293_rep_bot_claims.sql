-- REP_BOT_CLAIMS_V1 (2026-11-20) — ЗАЯВКА ПРЕДСТАВИТЕЛЯ НА ЗАКРЕПЛЕНИЕ
-- УЖЕ СУЩЕСТВУЮЩЕГО ВРАЧА.
--
-- Владелец (снимок бота): «if there is doctor with the same number it should go
-- to approvement before adding to medical representative». Раньше бот на
-- совпадение номера отвечал «второго не заводим, попросите администратора» — и
-- на этом всё: администратор о просьбе не узнавал. Теперь совпадение номера
-- заводит заявку: второй карточки по-прежнему нет (два врача с одним номером
-- не подключатся к боту врачей), а администратор на вкладке «Бот
-- представителей» подтверждает (врач переходит к заявителю) или отклоняет.
--
-- entered_name — ФИО, как его ввёл представитель: только для сведения
-- администратору (сверить, тот ли это врач). Карточку врача заявка не меняет.
-- prev_representative_id — кто был закреплён в МОМЕНТ РЕШЕНИЯ (не в момент
-- заявки): именно ему уходит «врач передан другому представителю».
-- status: pending — ждёт; approved / rejected — решение администратора;
-- void — к моменту решения заявка потеряла смысл (врача удалили, заявителя
-- уволили или сняли с него роль).
--
-- Одна ОТКРЫТАЯ заявка на пару врач+представитель — частичный уникальный
-- индекс: повтор той же анкеты находит прежнюю заявку, а не плодит вторую.
-- Закрытые заявки историю не ограничивают.
CREATE TABLE rep_bot_claims (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  referral_source_id     INTEGER NOT NULL REFERENCES referral_sources(id) ON DELETE CASCADE,
  user_id                INTEGER REFERENCES users(id) ON DELETE SET NULL,
  link_id                INTEGER REFERENCES rep_bot_links(id) ON DELETE SET NULL,
  chat_id                TEXT NOT NULL,
  entered_name           TEXT NOT NULL DEFAULT '',
  status                 TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'void')),
  prev_representative_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  decided_by             INTEGER REFERENCES users(id) ON DELETE SET NULL,
  decided_at             TEXT,
  created_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE UNIQUE INDEX rep_bot_claims_open_uniq ON rep_bot_claims(referral_source_id, user_id) WHERE status = 'pending';
CREATE INDEX idx_rep_bot_claims_status ON rep_bot_claims(status, created_at);
