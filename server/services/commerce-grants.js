// COMMERCE_BLOCK_V1 (2026-11-07) — ВОРОТА «PUSH-УВЕДОМЛЕНИЙ» И «ССЫЛОК ДЛЯ РЕКЛАМЫ».
//
// Владелец: «make as commercial block and add there push and other commercial
// instrument». У обоих инструментов теперь свои строки в «Ролях»
// (permission-catalog.js: commerce_push, commerce_links) — раньше их открывало
// окно «Настройки → Telegram-бот», и рассылать акции значило заодно владеть
// токеном бота.
//
// ПРАВИЛО ПЕРЕХОДА — «КАК ВЧЕРА». Пока роль строку не настраивала, ворота
// спрашивают «Telegram-бот» тем же уровнем, что спрашивали до этого выпуска
// (rpc/telegram.js, rpc/deeplinks.js, routes/storage.js). То же правило знает
// экран «Роли» (gate-fallbacks.js FALLBACK_FN): он показывает роли ровно то, что
// эти ворота ей дают, а защита «Ролей» сравнивает по нему же.
//
// Ворота живут здесь одним местом: их зовут RPC рассылки, RPC ссылок и загрузка
// файла в корзину telegram-media, и три копии правила разошлись бы.
import { grantAllowsOr, grantAllowsAdminOr } from './grants.js';

/** Прежнее правило: «Telegram-бот» нужного уровня (или администратор). */
function botLevel(db, user, need) {
  return need === 'view'
    ? grantAllowsAdminOr(db, user, 'settings.telegram', 'view')
    : grantAllowsAdminOr(db, user, 'settings.telegram', 'edit');
}

/** Делать рассылку в Telegram (уровень у строки один — «Изменение»). */
export function canPush(db, user) {
  return grantAllowsOr(db, user, 'commerce_push', 'edit', () => botLevel(db, user, 'edit'));
}

/** Ссылки для рекламы: 'view' — таблица и счётчики, 'edit' — завести, править, удалить. */
export function canAdLinks(db, user, need = 'view') {
  return need === 'edit'
    ? grantAllowsOr(db, user, 'commerce_links', 'edit', () => botLevel(db, user, 'edit'))
    : grantAllowsOr(db, user, 'commerce_links', 'view', () => botLevel(db, user, 'view'));
}

/** Для gate-fallbacks.js: то же прежнее правило, по которому решают ворота выше. */
export const COMMERCE_LEGACY = Object.freeze({
  push: (db, user) => botLevel(db, user, 'edit'),
  linksView: (db, user) => botLevel(db, user, 'view'),
  linksEdit: (db, user) => botLevel(db, user, 'edit'),
});
