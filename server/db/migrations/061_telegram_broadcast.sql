-- TELEGRAM_BROADCAST_V1 — рассылка сообщений пациентам и её история.
--
-- Отличается от telegram_deliveries принципиально: там — ДОКУМЕНТ конкретного
-- пациента, тут — ТЕКСТ, уходящий многим сразу. Смешивать их в одной таблице
-- нельзя: у выдачи документа есть patient_id и doc_ref, у рассылки их нет, а
-- зато есть аудитория, отбор и общий итог.

CREATE TABLE telegram_broadcasts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  text_ru        TEXT NOT NULL,
  -- Узбекский текст уходит тем же сообщением следом за русским: у клиники
  -- часть пациентов читает только по-узбекски.
  text_uz        TEXT NOT NULL DEFAULT '',
  -- Условия отбора в том виде, в каком их задал администратор (JSON). Хранятся
  -- ради вопроса «кому это ушло?», который возникает всегда постфактум.
  filters        TEXT NOT NULL DEFAULT '{}',
  -- Сколько получателей насчитал предпросмотр в момент отправки. Отдельно от
  -- фактических итогов: расхождение — это и есть сигнал, что что-то не так.
  audience_count INTEGER NOT NULL DEFAULT 0,
  sent_count     INTEGER NOT NULL DEFAULT 0,
  failed_count   INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','done','failed')),
  created_by     INTEGER REFERENCES users(id),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  finished_at    TEXT
);
CREATE INDEX idx_telegram_broadcasts_created ON telegram_broadcasts(created_at DESC);

-- Построчный итог по каждому получателю: без него «отправлено 380 из 412» —
-- число, с которым ничего нельзя сделать.
CREATE TABLE telegram_broadcast_targets (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  broadcast_id INTEGER NOT NULL REFERENCES telegram_broadcasts(id),
  chat_id      TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','blocked')),
  error        TEXT NOT NULL DEFAULT '',
  sent_at      TEXT
);
CREATE INDEX idx_telegram_broadcast_targets_bc ON telegram_broadcast_targets(broadcast_id);
CREATE UNIQUE INDEX idx_telegram_broadcast_targets_once ON telegram_broadcast_targets(broadcast_id, chat_id);

-- Пациент заблокировал бота.
--
-- Telegram отвечает на это 403, и такой чат надо перестать беспокоить: иначе
-- каждая рассылка снова стучится к человеку, который ушёл, а счётчик неудач
-- перестаёт что-либо значить. Отдельно от revoked_at: revoked — решение
-- КЛИНИКИ закрыть доступ, blocked — решение ПАЦИЕНТА. Свои документы по
-- запросу заблокировавший всё ещё получит, если разблокирует бота; в рассылку
-- он больше не попадает.
ALTER TABLE telegram_links ADD COLUMN blocked_at TEXT;
