-- TELEGRAM_CHAT_V1 — переписка с пациентами.
--
-- До сих пор бот читал входящие сообщения и забывал их: сценарий был
-- «нажал кнопку — получил PDF», и хранить там было нечего. Но пациенты пишут
-- боту словами («когда будут анализы?», «поменяйте время»), и эти сообщения
-- уходили в никуда — их никто в клинике не видел. Теперь они сохраняются, и в
-- левом меню появляется раздел «Чат с пациентами».

CREATE TABLE telegram_messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id      TEXT NOT NULL,
  -- 'in'  — написал пациент
  -- 'out' — ушло из клиники: ответ сотрудника, рассылка или служебный ответ бота
  direction    TEXT NOT NULL CHECK (direction IN ('in','out')),
  text         TEXT NOT NULL DEFAULT '',
  -- Что это было, чтобы в ленте отличать живой разговор от автоматики:
  -- 'text' — обычное сообщение, 'document' — выдан документ,
  -- 'system' — служебный ответ бота (приветствие, «номер не найден»),
  -- 'broadcast' — рассылка.
  kind         TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text','document','system','broadcast')),
  -- Кто ответил из клиники. NULL для входящих и для автоматических ответов.
  sent_by      INTEGER REFERENCES users(id),
  tg_message_id TEXT NOT NULL DEFAULT '',
  -- Прочитано сотрудником: непрочитанные считаются для значка в меню.
  read_at      TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_telegram_messages_chat ON telegram_messages(chat_id, created_at);
CREATE INDEX idx_telegram_messages_unread ON telegram_messages(read_at) WHERE direction = 'in';

-- Новый раздел меню — грантуемый ключ `telegram-chat`.
--
-- Уровень доступа решает, что сотрудник может: viewer — только читать
-- переписку, editor и выше — ещё и отвечать пациенту. Переписка с пациентом от
-- имени клиники — это не то же самое, что её чтение, и разделять их надо
-- правами, а не договорённостью.
--
-- Выдаётся администратору и call-центру: телефонный оператор и так ведёт
-- разговоры с пациентами, это ровно его работа. Остальные роли раздел не
-- видят, пока его явно не выдадут в «Настройки → Роли».
UPDATE role_permissions
   SET permissions = json_set(
         json_insert(permissions, '$.sections[#]', 'telegram-chat'),
         '$.levels.telegram-chat', 'admin')
 WHERE role = 'admin'
   AND json_valid(permissions)
   AND permissions NOT LIKE '%"telegram-chat"%';

UPDATE role_permissions
   SET permissions = json_set(
         json_insert(permissions, '$.sections[#]', 'telegram-chat'),
         '$.levels.telegram-chat', 'editor')
 WHERE role = 'callcenter'
   AND json_valid(permissions)
   AND permissions NOT LIKE '%"telegram-chat"%';
