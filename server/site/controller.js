// WEBSITE_V1 — когда работает публичный сайт.
//
// В Chilla сайт поднимался при каждом старте (выключался только SITE_PORT=0).
// Здесь (спека 2026-11-23, §3) — только при ВСЕХ трёх условиях:
//   1) в лицензии есть модуль website (новый платный модуль);
//   2) администратор включил «Сайт включён» (website_settings.enabled);
//   3) SITE_PORT не 0 (аварийный выключатель остался).
// Иначе обновление клиники само открывало бы новый порт в её сети.
//
// refresh() сравнивает желаемый порт с текущим и открывает или закрывает
// слушатель; index.js зовёт его раз в минуту — так и выдача модуля через
// check-in, и сохранение настроек действуют без перезапуска сервера.
import { createSiteApp } from './app.js';
import { getSettings, invalidateContentCache } from './content.js';
import { controlState } from '../services/control/state.js';
import { getDataDir } from '../services/control/config.js';

const licensedWebsite = (db) => { try { return controlState(db, getDataDir()).has('website'); } catch { return false; } };

export function siteWanted(db, { env = process.env, hasModule } = {}) {
  const port = Number(env.SITE_PORT ?? 8001);
  if (!(Number.isInteger(port) && port > 0)) return 0;
  if (!(hasModule ? hasModule() : licensedWebsite(db))) return 0;
  invalidateContentCache();   // настройку читаем свежей, а не из 30-секундного кэша
  return getSettings(db).enabled === true ? port : 0;
}

export function createSiteController(db, { env = process.env, hasModule, listen, appOptions = {}, log = console } = {}) {
  const open = listen || ((app, p) => app.listen(p, '0.0.0.0'));
  let server = null;
  let port = 0;
  const stop = () => { if (server) { try { server.close(); } catch { /* уже закрыт */ } } server = null; port = 0; };
  return {
    refresh() {
      let want = 0;
      try { want = siteWanted(db, { env, hasModule }); } catch (e) { log.warn('[website]', e.message); }
      if (want === port) return port;
      stop();
      if (want) {
        server = open(createSiteApp(db, appOptions), want);
        port = want;
        server.on('listening', () => log.log(`  Public website:  http://localhost:${want}`));
        server.on('error', (err) => {
          log.error(err && err.code === 'EADDRINUSE'
            ? `Public website not started: port ${want} is already in use.`
            : `Public website error: ${err && err.message}`);
          server = null; port = 0;
        });
      }
      return port;
    },
    stop,
    get port() { return port; },
  };
}

// WEBSITE_V1, этап 2 — РЕЕСТР ЖИВОГО КОНТРОЛЛЕРА.
//
// Контроллер создаёт index.js, а сохранение настроек приходит через RPC
// (rpc/website.js), у которого нет ни req, ни ссылки на index.js. Без этого
// реестра «Сайт включён» срабатывал бы только на следующем минутном refresh(),
// и администратор, нажавший «Сохранить», видел бы «сайт не запущен» до минуты.
// Один процесс — один сайт, поэтому реестр — одна переменная модуля.
//
// requestSiteRefresh() НЕ БРОСАЕТ и ничего не делает без контроллера: в тестах
// RPC и в утилитах контроллера нет вовсе, а сохранение настроек не должно
// падать из-за того, что слушатель не поднялся (порт занят и т.п.) — это
// отдельная беда, её видно в site.running у website_settings_get.
let registered = null;

export function registerSiteController(c) {
  registered = c || null;
  return registered;
}

export function requestSiteRefresh() {
  if (!registered) return 0;
  try { return registered.refresh(); } catch { return 0; }
}

/** Слушатель сайта поднят: { running, port }. Без контроллера — не поднят. */
export function siteRunning() {
  const port = registered ? Number(registered.port) || 0 : 0;
  return { running: port > 0, port };
}
