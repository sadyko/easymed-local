// TG_DEEPLINK_V1 — RPC экрана «Ссылки для рекламы в Telegram» (Настройки →
// «Коммерческие инструменты»).
//
// Почему RPC, а не /api/db: таблицы ссылок намеренно НЕ заведены в
// schema-registry.js — проверка ключа, кнопок и файла живёт в одном месте
// (telegram/deeplinks.js), и обойти её запросным эндпоинтом нельзя по
// построению. Счётчики считаются там же, одним запросом.
//
// Право — окно «Telegram-бот» в «Ролях» (settings.telegram): «Просмотр» —
// таблица и счётчики, «Изменение» — создание, правка, удаление. Отдельного
// ключа нет нарочно: ссылка — это поведение бота, а бот выдаётся этим окном;
// туда же (settings.telegram edit) смотрит и загрузка файла в хранилище
// telegram-media (routes/storage.js, telegramDenial).

import { grantAllowsAdminOr } from '../grants.js';
import { listDeeplinks, saveDeeplink, deleteDeeplink, DeeplinkError, LEAD_KINDS } from '../telegram/deeplinks.js';

export class RpcError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

const KEY = 'settings.telegram';
function requireLevel(db, user, need) {
  if (!grantAllowsAdminOr(db, user, KEY, need)) {
    throw new RpcError('Ссылки для рекламы недоступны вашей роли. Права выдаёт администратор в «Настройки → Роли» (окно «Telegram-бот»).', 403);
  }
}
function rethrow(e) {
  if (e instanceof DeeplinkError) throw new RpcError(e.message, e.status);
  throw e;
}

// Имя бота — из проверки связи (telegram_settings.bot_username): без него
// ссылку собрать не из чего, и экран говорит об этом прямо.
export function telegramDeeplinksList(db, _args, user) {
  requireLevel(db, user, 'view');
  const row = db.prepare('SELECT bot_username, enabled FROM telegram_settings WHERE id = 1').get() || {};
  return {
    bot_username: String(row.bot_username || ''),
    bot_enabled: !!row.enabled,
    lead_kinds: LEAD_KINDS,
    links: listDeeplinks(db),
  };
}

export function telegramDeeplinkSave(db, args, user) {
  requireLevel(db, user, 'edit');
  try { return saveDeeplink(db, args || {}, user && user.id ? user.id : null); }
  catch (e) { rethrow(e); }
  return null;
}

export function telegramDeeplinkDelete(db, args, user) {
  requireLevel(db, user, 'edit');
  const id = Number(args && args.id);
  if (!Number.isInteger(id) || id <= 0) throw new RpcError('Не указано, какую ссылку удалить.');
  try { return deleteDeeplink(db, id); }
  catch (e) { rethrow(e); }
  return null;
}
