// WEBSITE_V1, этап 2 — настройки публичного сайта из редактора «Веб-сайт».
//
// Перенос из Chilla (server/services/rpc/website.js) — ТОЛЬКО настройки:
// заявки с сайта и счётчик для меню — этап 3. Отличия от Chilla
// (docs/superpowers/plans/2026-11-24-website-stage2-editor.md):
//  1. Право — строка каталога `commerce_website` (как `commerce_ai` у
//     ИИ-помощника), а не раздел 'website' в role_permissions.
//  2. Лицензия — каждый website_* RPC без модуля `website` отвечает 402
//     module_missing. Чтения стоят в READ_ONLY_RPCS (control/gate.js), чтобы
//     клиника с истёкшей лицензией могла посмотреть, что у неё на сайте.
//  3. Выключатель `settings.enabled` — сохранение сразу пересчитывает слушатель
//     (requestSiteRefresh), без перезапуска и без ожидания минутного таймера.
import { grantAllowsAdminOr } from '../grants.js';
import { controlState } from '../control/state.js';
import { getDataDir } from '../control/config.js';
import { invalidateContentCache } from '../../site/content.js';
import { requestSiteRefresh, siteRunning } from '../../site/controller.js';

export class RpcError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

// Тот же приём, что hasAiModule (services/ai/settings.js): лицензия не
// прочиталась — модуля нет. Тесты подменяют его опцией hasModule.
export function hasWebsiteModule(db) {
  try { return controlState(db, getDataDir()).has('website'); } catch { return false; }
}

const VIEW_DENIED = 'Редактор сайта недоступен вашей роли. Права выдаёт администратор в «Настройки → Роли» (строка «Веб-сайт»).';
const EDIT_DENIED = 'У вас доступ «Просмотр»: менять сайт нельзя. Права выдаёт администратор в «Настройки → Роли» (строка «Веб-сайт»).';
const NO_MODULE = 'Модуль «Веб-сайт» не подключён. Обратитесь к менеджеру Easy-Med.';

/**
 * Общие ворота всех website_* RPC (и website-content.js): сначала лицензия —
 * некупленный модуль клиника видит экраном предложения при любой роли, — потом
 * право. need: 'view' | 'edit'. Права не настроены — только администратор
 * (adminDefault строки каталога).
 */
export function requireWebsite(db, user, need, hasModule = hasWebsiteModule) {
  if (!hasModule(db)) {
    const err = new RpcError(NO_MODULE, 402);
    err.code = 'module_missing';
    throw err;
  }
  if (!grantAllowsAdminOr(db, user, 'commerce_website', 'view')) throw new RpcError(VIEW_DENIED, 403);
  if (need === 'edit' && !grantAllowsAdminOr(db, user, 'commerce_website', 'edit')) throw new RpcError(EDIT_DENIED, 403);
}

const LANGS = ['uz', 'ru', 'en'];
const MAX_BYTES = 64 * 1024;

function readRow(db) {
  const row = db.prepare('SELECT settings, updated_at FROM website_settings WHERE id = 1').get();
  let settings = {};
  try { settings = JSON.parse((row && row.settings) || '{}'); } catch { settings = {}; }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) settings = {};
  return { settings, updated_at: row ? row.updated_at : null };
}

// site — состояние слушателя ЭТОГО процесса (server/site/controller.js):
// «Сайт включён» стоит, а running=false — значит, порт занят или SITE_PORT=0,
// и экран говорит об этом, а не делает вид, что сайт открыт.
export function websiteSettingsGet(db, _args, user, { hasModule = hasWebsiteModule } = {}) {
  requireWebsite(db, user, 'view', hasModule);
  const { settings, updated_at } = readRow(db);
  return { settings, updated_at, site: siteRunning() };
}

// Сохранение доверяет содержимому строк (тот же уровень доверия, что у
// doc_settings): это ввод администратора, а не публичной формы, поэтому
// HTML внутри значений не экранируется здесь — экранирует рендер сайта.
// Проверяются форма и размер объекта.
export function websiteSettingsSave(db, args, user, { hasModule = hasWebsiteModule, refresh = requestSiteRefresh } = {}) {
  requireWebsite(db, user, 'edit', hasModule);
  const a = args || {};
  const input = a.settings;
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new RpcError('Настройки сайта должны быть объектом.', 400);
  }

  // Круговой проход через JSON: функции/undefined/символы молча выпадают, а не
  // падают на сохранении или на публичной отдаче content.js.
  let settings;
  try { settings = JSON.parse(JSON.stringify(input)); }
  catch { throw new RpcError('Настройки сайта нельзя сохранить: в них есть значения, которые не записываются.', 400); }

  const json = JSON.stringify(settings);
  if (Buffer.byteLength(json, 'utf8') > MAX_BYTES) {
    throw new RpcError('Настройки сайта превышают 64 КБ.', 400);
  }
  // WEBSITE_V1 — «Сайт включён» открывает порт в сети клиники. Строка «false»
  // или 0 не должна его открывать (тот же довод, что у ai_settings_save), поэтому
  // принимается только настоящее true/false.
  if (settings.enabled !== undefined && typeof settings.enabled !== 'boolean') {
    throw new RpcError('«Сайт включён» — только да или нет.', 400);
  }
  if (settings.default_lang !== undefined && !LANGS.includes(settings.default_lang)) {
    throw new RpcError('Язык по умолчанию — узбекский, русский или английский.', 400);
  }
  if (settings.langs !== undefined) {
    if (!Array.isArray(settings.langs) || settings.langs.some((l) => !LANGS.includes(l))) {
      throw new RpcError('Языки сайта — только узбекский, русский и английский.', 400);
    }
  }
  // Chilla W2 (fix-wave 2) — {default_lang:'uz', langs:['ru','en']} на сайте
  // означает бесконечный редирект (/uz/ отключён -> уводит на default_lang, а
  // он сам отключён). Отклоняется здесь, до записи; content.js
  // defaultLangFromSettings — вторая линия обороны на чтении.
  if (settings.default_lang !== undefined && Array.isArray(settings.langs) && settings.langs.length
      && !settings.langs.includes(settings.default_lang)) {
    throw new RpcError('Язык по умолчанию должен быть среди включённых языков — иначе сайт не открывается.', 400);
  }

  // Chilla WEBSITE_SETTINGS_LOST_UPDATE_V1 — защита от «потерянного обновления».
  // Экран шлёт ВЕСЬ объект (read-modify-write); вкладка, открытая час назад,
  // своей устаревшей копией затёрла бы всё, что сохранили после неё (так в
  // Chilla пропал заполненный герой). Клиент присылает updated_at, который
  // прочитал; не совпал — отказ 409 вместо молчаливой потери чужой работы.
  // Поле необязательное: вызов без него работает как раньше.
  const prev = a.prev_updated_at;
  if (prev !== undefined && prev !== null && prev !== '') {
    const cur = db.prepare('SELECT updated_at FROM website_settings WHERE id = 1').get();
    if (cur && String(cur.updated_at) !== String(prev)) {
      throw new RpcError(
        'Настройки сайта изменились в другом окне уже после того, как эта страница их прочитала. '
        + 'Обновите страницу и внесите правку заново — иначе вы сотрёте чужие изменения.', 409);
    }
  }

  // Метка с МИЛЛИСЕКУНДАМИ (%f): два сохранения внутри одной секунды иначе
  // неразличимы, и проверка версии выше их пропускала бы.
  db.prepare(`UPDATE website_settings
                 SET settings = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
               WHERE id = 1`).run(json);
  // Сайт кэширует настройки на 30 с (site/content.js) — сброс, чтобы посетитель
  // увидел правку сразу; затем слушатель пересчитывается: «Сайт включён» поднимает
  // или закрывает порт 8001 прямо сейчас.
  invalidateContentCache();
  try { refresh(); } catch { /* слушатель — отдельная беда; видна в site.running */ }
  const { updated_at } = readRow(db);
  return { ok: true, updated_at, site: siteRunning() };
}
