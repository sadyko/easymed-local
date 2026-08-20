-- TELEGRAM_BOT_V1 — пациент получает свои документы в Telegram.
--
-- Клиника раньше держала для этого отдельный бинарник (D:\server\telegram_Bot,
-- .NET + Npgsql), который спрашивал у пациента выданный на стойке пароль и
-- отдавал только результаты анализов. Здесь пациент идентифицируется номером
-- телефона, который подтвердил сам Telegram, а бот живёт внутри сервера
-- Easy-Med — один процесс, один `npm start`.
--
-- Слайс 1 (эта миграция) — только хранилище: раздел настроек с токеном.
-- Опрос Telegram, связывание чатов и выдача PDF идут следующими слайсами;
-- их таблицы заводятся здесь же, чтобы схема не менялась под работающим ботом.

-- Настройки бота. Строка ровно одна (id = 1), как у doc_settings.
--
-- НАМЕРЕННО НЕ РЕГИСТРИРУЕТСЯ в server/db/schema-registry.js: реестр — это
-- белый список, поэтому отсутствие таблицы в нём делает токен недостижимым
-- через /api/db по построению, а не по правилу, которое нужно помнить.
-- Единственный путь к этой строке — admin-only RPC, и наружу токен не уходит.
CREATE TABLE telegram_settings (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  -- Бот молчит, пока администратор его не включил, даже если токен уже введён.
  enabled           INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  -- AES-256-GCM, ключ — в data/.telegram-key. Пустая строка = токен не задан.
  bot_token_enc     TEXT NOT NULL DEFAULT '',
  -- Последние 4 символа токена — чтобы UI мог показать, какой токен сохранён,
  -- ни разу не отдав его в браузер.
  bot_token_hint    TEXT NOT NULL DEFAULT '',
  -- Ответ getMe, кэшируется при проверке связи: из username строится ссылка
  -- t.me и QR-код для стойки регистрации.
  bot_username      TEXT NOT NULL DEFAULT '',
  bot_id            TEXT NOT NULL DEFAULT '',
  -- Результат последней проверки связи: 'ok' | 'error' | '' (не проверяли).
  last_check_status TEXT NOT NULL DEFAULT '' CHECK (last_check_status IN ('','ok','error')),
  last_check_error  TEXT NOT NULL DEFAULT '',
  last_check_at     TEXT,
  -- Какие виды документов вообще разрешено ВЫДАВАТЬ по запросу пациента.
  --
  -- Счета входят в список наравне с остальным. Не путать с рассылкой: счета
  -- никогда не летят на телефон автоматически (см. PUSH_KINDS в push.js), но
  -- забрать свой счёт из меню пациент вправе. Раньше здесь их не было, и это
  -- была ошибка: пациент с одними счетами видел «готовых документов нет».
  doc_kinds         TEXT NOT NULL DEFAULT 'lab,conclusion,diag,invoice,file',
  -- Автоотправка готового документа. Выключение оставляет бота отвечающим
  -- на запросы, но молчащим по своей инициативе.
  push_enabled      INTEGER NOT NULL DEFAULT 1 CHECK (push_enabled IN (0,1)),
  -- Приветствие перед кнопкой «Поделиться номером». Пустое — берётся дефолт.
  welcome_text      TEXT NOT NULL DEFAULT '',
  -- Путь к chrome.exe/msedge.exe, если автоопределение промахнулось.
  chrome_path       TEXT NOT NULL DEFAULT '',
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_by        INTEGER REFERENCES users(id)
);
INSERT INTO telegram_settings (id) VALUES (1);

-- Связка «чат Telegram ↔ номер телефона».
--
-- Хранится ИМЕННО телефон, а не patient_id: пациенты подбираются по номеру
-- заново при каждом запросе. Поэтому новый член семьи, записанный на тот же
-- номер, попадает в выдачу без всякой синхронизации, а пациент, сменивший
-- номер, из неё выпадает сам.
CREATE TABLE telegram_links (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id     TEXT NOT NULL,
  -- Только цифры, как их отдаёт digitsOf() из crm-phone-match.js: сопоставление
  -- с patients.phone делает тот же модуль, что и подбор пациента в CRM, чтобы
  -- два места не начали считать «тот же номер» по-разному.
  phone       TEXT NOT NULL,
  tg_user_id  TEXT NOT NULL DEFAULT '',
  tg_username TEXT NOT NULL DEFAULT '',
  tg_name     TEXT NOT NULL DEFAULT '',
  linked_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  last_seen_at TEXT,
  -- Кнопка «Отвязать» у администратора. Строка остаётся ради истории выдач.
  revoked_at  TEXT,
  revoked_by  INTEGER REFERENCES users(id)
);
-- Активная связка у чата ровно одна; отозванные не мешают связаться заново.
CREATE UNIQUE INDEX idx_telegram_links_chat_active ON telegram_links(chat_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_telegram_links_phone ON telegram_links(phone);

-- Журнал выдач — одновременно очередь отправки и аудит.
--
-- Аудит здесь не «на всякий случай»: доступ по одному лишь номеру телефона
-- принят сознательно, и журнал вместе с кнопкой «Отвязать» — то, чем клиника
-- разбирается, если номер перешёл к другому человеку.
CREATE TABLE telegram_deliveries (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id    TEXT NOT NULL,
  patient_id INTEGER REFERENCES patients(id),
  doc_kind   TEXT NOT NULL CHECK (doc_kind IN ('lab','conclusion','diag','invoice','file')),
  -- Что именно отправлено: 'visit:123' / 'visit_service:456' / 'visit_document:78'.
  doc_ref    TEXT NOT NULL,
  trigger    TEXT NOT NULL CHECK (trigger IN ('push','pull')),
  status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','skipped')),
  attempts   INTEGER NOT NULL DEFAULT 0,
  error      TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  sent_at    TEXT
);
-- Автоотправка — ровно один раз на документ и чат, навсегда: перезапуск
-- сервера не должен повторно прислать пациенту тот же анализ. Запросы
-- пациента (trigger='pull') под ограничение не попадают — он вправе
-- перезапросить документ столько раз, сколько нужно.
CREATE UNIQUE INDEX idx_telegram_deliveries_push_once
  ON telegram_deliveries(chat_id, doc_kind, doc_ref) WHERE trigger = 'push';
CREATE INDEX idx_telegram_deliveries_pending ON telegram_deliveries(status, created_at);
CREATE INDEX idx_telegram_deliveries_chat ON telegram_deliveries(chat_id, created_at);

-- Служебные курсоры бота: offset getUpdates и отметки сканирования push.
-- Отдельная таблица, а не колонки в telegram_settings, потому что это
-- состояние работающего процесса, а не настройка, которую правит человек.
CREATE TABLE telegram_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
