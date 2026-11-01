-- META_INBOX_V1 (мигр. 263, 2026-10-31, владелец: «i need one more window for
-- facebook comments and messages … yes instagram too, yes build Chat facebook»)
-- — «Чат Facebook и Instagram»: личные сообщения страницы клиники (Messenger и
-- Direct) и комментарии под её постами и рекламой.
--
-- Связь с Meta — та же, что у заявок из рекламы (meta_settings: токен и
-- страница). Клиника локальная и адреса в интернете у неё нет, поэтому Meta
-- не может прислать событие сама: сервер опрашивает Graph API раз в минуту
-- (meta/inbox-poller.js), как опрос заявок. Всё, что пришло, лежит здесь, и
-- экран читает только отсюда.
--
-- Все id Meta — TEXT UNIQUE: повтор опроса (окно перекрытия) не плодит строк.

-- Состояние опроса. Отдельной строкой, а не столбцами meta_settings: опрос
-- заявок и опрос переписки включаются порознь и отказывают по-разному.
CREATE TABLE meta_inbox_state (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  enabled       INTEGER NOT NULL DEFAULT 0,
  -- когда включили: история старше этого приходит прочитанной, а не сотней
  -- «непрочитанных» в первую минуту
  enabled_at    TEXT,
  ig_account_id TEXT    NOT NULL DEFAULT '',   -- Instagram, привязанный к странице ('' — нет)
  ig_username   TEXT    NOT NULL DEFAULT '',
  -- слово причины по каждой части: {"messenger":"no_permission","instagram":"",…}
  errors_json   TEXT    NOT NULL DEFAULT '{}',
  last_poll_at  TEXT,
  last_ok_at    TEXT,
  updated_at    TEXT,
  updated_by    INTEGER REFERENCES users(id) ON DELETE SET NULL
);
INSERT INTO meta_inbox_state (id) VALUES (1);

-- Переписка: Messenger (страница) или Direct (Instagram страницы).
CREATE TABLE meta_conversations (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  platform       TEXT    NOT NULL CHECK (platform IN ('messenger', 'instagram')),
  conv_id        TEXT    NOT NULL UNIQUE,
  peer_id        TEXT    NOT NULL DEFAULT '',   -- PSID / IGSID — адресат ответа
  peer_name      TEXT    NOT NULL DEFAULT '',
  peer_username  TEXT    NOT NULL DEFAULT '',
  updated_time   TEXT,                          -- как его отдала Meta: отметка опроса
  last_text      TEXT    NOT NULL DEFAULT '',
  last_direction TEXT    NOT NULL DEFAULT 'in' CHECK (last_direction IN ('in', 'out')),
  last_at        TEXT,
  -- последнее ВХОДЯЩЕЕ: окно 24 часа, в которое Meta разрешает ответить
  last_in_at     TEXT,
  crm_request_id INTEGER REFERENCES crm_requests(id) ON DELETE SET NULL,
  created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX meta_conversations_last ON meta_conversations (last_at DESC);

CREATE TABLE meta_messages (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id  INTEGER NOT NULL REFERENCES meta_conversations(id) ON DELETE CASCADE,
  msg_id           TEXT    UNIQUE,              -- NULL у неотправленного ответа
  direction        TEXT    NOT NULL CHECK (direction IN ('in', 'out')),
  text             TEXT    NOT NULL DEFAULT '',
  attachments_json TEXT    NOT NULL DEFAULT '[]',
  created_at       TEXT    NOT NULL,
  read_at          TEXT,
  status           TEXT    NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'failed')),
  error            TEXT    NOT NULL DEFAULT '',
  sent_by          INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX meta_messages_conv ON meta_messages (conversation_id, created_at);
CREATE INDEX meta_messages_unread ON meta_messages (conversation_id) WHERE read_at IS NULL AND direction = 'in';

-- Комментарий под постом или рекламой (Facebook) / публикацией (Instagram).
-- Ответы клиники — тоже строки (is_page = 1): нитка читается целиком.
CREATE TABLE meta_comments (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  platform           TEXT    NOT NULL CHECK (platform IN ('facebook', 'instagram')),
  comment_id         TEXT    NOT NULL UNIQUE,
  parent_id          TEXT    NOT NULL DEFAULT '',   -- '' — комментарий верхнего уровня
  root_id            TEXT    NOT NULL DEFAULT '',   -- комментарий верхнего уровня нитки ('' — сам он)
  post_id            TEXT    NOT NULL DEFAULT '',
  post_text          TEXT    NOT NULL DEFAULT '',
  post_url           TEXT    NOT NULL DEFAULT '',
  post_is_ad         INTEGER NOT NULL DEFAULT 0,
  author_id          TEXT    NOT NULL DEFAULT '',
  author_name        TEXT    NOT NULL DEFAULT '',
  text               TEXT    NOT NULL DEFAULT '',
  created_at         TEXT    NOT NULL,
  is_page            INTEGER NOT NULL DEFAULT 0,
  is_hidden          INTEGER NOT NULL DEFAULT 0,
  read_at            TEXT,
  private_replied_at TEXT,
  sent_by            INTEGER REFERENCES users(id) ON DELETE SET NULL,
  crm_request_id     INTEGER REFERENCES crm_requests(id) ON DELETE SET NULL
);
CREATE INDEX meta_comments_created ON meta_comments (created_at DESC);
CREATE INDEX meta_comments_root ON meta_comments (root_id);
