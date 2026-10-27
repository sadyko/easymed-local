-- TG_DEEPLINK_V1 (2026-10-26, владелец: «here generation of Deeplink, sample is
-- provided in the photo — go on now») — ССЫЛКИ ДЛЯ РЕКЛАМЫ В TELEGRAM.
--
-- Ссылка вида https://t.me/<бот>?start=<ключ> ставится в рекламу. Человек
-- открывает бота по ней — ещё не пациент, без номера в базе — и сразу получает
-- заданный ответ (прайс, фото палаты, описание пакета) с файлом и кнопками;
-- кнопка «Оставить заявку» заводит карточку в CRM. По каждой ссылке видно,
-- сколько пришло и сколько оставили заявку (server/services/telegram/deeplinks.js).
--
-- Три таблицы, только CREATE TABLE:
--   telegram_deeplinks      — сами ссылки: ключ (попадает в адрес; строчные
--                             латиница, цифры, «-» и «_»; UNIQUE без учёта регистра —
--                             Telegram передаёт параметр как есть, люди набирают как
--                             попало), название, тип заявки, ответ бота на трёх языках,
--                             кнопки (массив JSON), файл из корзины telegram-media,
--                             включена ли.
--   telegram_deeplink_hits  — переходы: кто и когда открыл бота по ссылке.
--   telegram_deeplink_leads — заявки, заведённые по ссылке, со ссылкой на карточку CRM.
--
-- Удаление ссылки уносит её журналы (ON DELETE CASCADE): счётчики — часть ссылки.
-- Удаление карточки CRM только отвязывает запись о заявке (ON DELETE SET NULL):
-- переход и заявка были, и статистика рекламы врать не должна.

CREATE TABLE telegram_deeplinks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  key           TEXT    NOT NULL COLLATE NOCASE UNIQUE CHECK (length(key) BETWEEN 1 AND 32),
  name          TEXT    NOT NULL DEFAULT '',
  lead_kind     TEXT    NOT NULL DEFAULT 'callback' CHECK (lead_kind IN ('callback', 'appointment', 'question')),
  answer_ru     TEXT    NOT NULL DEFAULT '',
  answer_uz     TEXT    NOT NULL DEFAULT '',
  answer_en     TEXT    NOT NULL DEFAULT '',
  buttons_json  TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(buttons_json) AND json_type(buttons_json) = 'array'),
  file_path     TEXT    NOT NULL DEFAULT '',
  file_kind     TEXT    NOT NULL DEFAULT '' CHECK (file_kind IN ('', 'photo', 'document')),
  file_name     TEXT    NOT NULL DEFAULT '',
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_by    INTEGER,
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE telegram_deeplink_hits (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  deeplink_id  INTEGER NOT NULL REFERENCES telegram_deeplinks(id) ON DELETE CASCADE,
  chat_id      TEXT    NOT NULL DEFAULT '',
  tg_user_id   TEXT    NOT NULL DEFAULT '',
  lang         TEXT    NOT NULL DEFAULT 'ru',
  hit_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX telegram_deeplink_hits_link ON telegram_deeplink_hits (deeplink_id, hit_at);

CREATE TABLE telegram_deeplink_leads (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  deeplink_id     INTEGER NOT NULL REFERENCES telegram_deeplinks(id) ON DELETE CASCADE,
  crm_request_id  INTEGER REFERENCES crm_requests(id) ON DELETE SET NULL,
  chat_id         TEXT    NOT NULL DEFAULT '',
  created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX telegram_deeplink_leads_link ON telegram_deeplink_leads (deeplink_id);
CREATE INDEX telegram_deeplink_leads_crm ON telegram_deeplink_leads (crm_request_id);
