// WEBSITE_V1 — публичный сайт клиники: отдельный Express-app без сессий,
// без /api/db и /api/rpc. Единственный слушатель, который можно выставлять
// в интернет; ЕРП-порт наружу не открывается никогда (спека §4).
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compress } from '../middleware/compress.js';
import { slowLog } from '../middleware/slow-log.js';
export { LANGS, DEFAULT_LANG } from './i18n.js';
import { LANGS, DEFAULT_LANG, langUrl } from './i18n.js';
import { enabledLangs, defaultLang, configureContent } from './content.js';
import { getDataDir } from '../services/control/config.js';
import { renderNotFound } from './render/notfound.js';
import { renderHome } from './render/home.js';
import { renderDoctors, renderDoctor } from './render/doctors.js';
import { renderServices, renderService } from './render/services.js';
import { renderDepartments, renderDepartment } from './render/departments.js';
import { renderAbout, renderContact, renderFaq, renderLegal } from './render/static-pages.js';
import { renderNews, renderPost } from './render/news.js';
import { renderAppointment, renderThanks } from './render/appointment.js';
import { handleRequest } from './requests.js';
import { rateLimit } from './rate-limit.js';
import { recordBeacon, parseCookies, beaconLimiter } from './analytics.js';
import { sitemapXml, robotsTxt } from './seo.js';
import { mediaRoute } from './media.js';
import { getSettings } from './content.js';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

export function siteError(res, status, code, message) {
  return res.status(status).json({ error: { code, message } });
}

// Fix 1 (W4, launch-gate review) — CSP по умолчанию максимально строгая (ни
// одного стороннего хоста), но снипет аналитики (settings.analytics.
// inject_snippet, W4-R3) и карта на странице (settings.contact.map_embed,
// см. home.js/static-pages.js) — оба admin-opt-in функции: администратор
// клиники сам решает их включить через вкладку «SEO»/«Основное» настроек
// сайта. Раз решение осознанное и явное, а не поведение по умолчанию для
// анонимного посетителя, CSP имеет смысл ослаблять РОВНО настолько, чтобы
// включённая функция реально заработала, и не шире. getSettings(db) уже
// кэширован на 30с (content.js) — вызывать его на каждый запрос дёшево,
// отдельного кэша для самой строки CSP заводить незачем.
function buildCsp(db) {
  const settings = getSettings(db);
  const hasSnippet = typeof settings.analytics?.inject_snippet === 'string' &&
    settings.analytics.inject_snippet.trim() !== '';
  const hasMap = typeof settings.contact?.map_embed === 'string' &&
    settings.contact.map_embed.trim() !== '';

  const imgSrc = "img-src 'self' data:" + (hasSnippet ? ' https://mc.yandex.ru' : '');
  const parts = [
    "default-src 'self'",
    imgSrc,
    "frame-ancestors 'none'",
    "form-action 'self'",
    "base-uri 'none'",
  ];
  if (hasSnippet) {
    parts.push("script-src 'self' 'unsafe-inline' https://www.googletagmanager.com https://mc.yandex.ru");
    parts.push("connect-src 'self' https://*.google-analytics.com https://mc.yandex.ru");
  }
  if (hasMap) {
    parts.push('frame-src https://www.google.com https://yandex.ru https://maps.google.com');
  }
  return parts.join('; ');
}

// WEBSITE_V1 — страницы регистрируются по-языково: Express 5 не поддерживает
// :param(regex), поэтому на каждый язык монтируется свой Router (задачи 6–11
// добавляют маршруты в langRouter).
export function langRouter(db, lang) {
  const router = express.Router();
  // W2 — язык отключён администратором (settings.langs): маршрут остаётся
  // смонтированным (см. комментарий у app.use('/'+lang,...) ниже), но любой
  // запрос к нему уводит на языковой эквивалент того же пути в языке по
  // умолчанию. Проверяем на каждый запрос (не при монтировании роутера),
  // потому что настройки могут поменяться в рантайме.
  router.use((req, res, next) => {
    if (!enabledLangs(db).includes(lang)) {
      return res.redirect(302, langUrl(defaultLang(db), req.originalUrl));
    }
    next();
  });
  router.get('/', (req, res) => res.type('html').send(renderHome(db, lang)));
  router.get('/doctors', (req, res) => res.type('html').send(renderDoctors(db, lang, req.query)));   // DOC_FILTER_V1
  router.get('/doctors/:slug', (req, res) => {
    const html = renderDoctor(db, lang, req.params.slug);
    if (!html) return res.status(404).type('html').send(renderNotFound(db, lang));
    res.type('html').send(html);
  });
  // SERVICES_FILTER_V1 — ?q= и ?group= фильтруют каталог на сервере: ссылка
  // на найденное должна открываться у любого, в том числе с выключенным JS.
  router.get('/services', (req, res) => res.type('html').send(renderServices(db, lang, req.query)));
  router.get('/services/:slug', (req, res) => {
    const html = renderService(db, lang, req.params.slug);
    if (!html) return res.status(404).type('html').send(renderNotFound(db, lang));
    res.type('html').send(html);
  });
  router.get('/departments', (req, res) => res.type('html').send(renderDepartments(db, lang)));
  router.get('/departments/:slug', (req, res) => {
    const html = renderDepartment(db, lang, req.params.slug);
    if (!html) return res.status(404).type('html').send(renderNotFound(db, lang));
    res.type('html').send(html);
  });
  router.get('/news', (req, res) => res.type('html').send(renderNews(db, lang)));
  router.get('/news/:slug', (req, res) => {
    const html = renderPost(db, lang, req.params.slug);
    if (!html) return res.status(404).type('html').send(renderNotFound(db, lang));
    res.type('html').send(html);
  });
  router.get('/appointment', (req, res) => res.type('html').send(renderAppointment(db, lang, req.query)));
  router.get('/appointment/thanks', (req, res) => res.type('html').send(renderThanks(db, lang)));
  router.get('/about', (req, res) => res.type('html').send(renderAbout(db, lang)));
  router.get('/contact', (req, res) => res.type('html').send(renderContact(db, lang)));
  router.get('/faq', (req, res) => res.type('html').send(renderFaq(db, lang)));
  router.get('/privacy', (req, res) => res.type('html').send(renderLegal(db, lang, 'privacy')));
  router.get('/terms', (req, res) => res.type('html').send(renderLegal(db, lang, 'terms')));
  return router;
}

export function createSiteApp(db, { storageDir, ...opts } = {}) {
  // WEBSITE_V1 (Easy-Med) — хранилище то же, что у /api/storage ЕРП:
  // <dataDir>/storage, где dataDir — EASYMED_DATA_DIR, опубликованный
  // index.js через setDataDir() при загрузке (server/app.js берёт тот же
  // каталог). В Chilla здесь стоял ROOT/data — у клиники с EASYMED_DATA_DIR
  // сайт искал бы картинки и фото врачей не там, где их кладёт ЕРП.
  const storage = storageDir || path.join(getDataDir(), 'storage');
  // Тот же каталог нужен content.js — проверить, что файл фото врача на
  // диске есть (иначе аватар с инициалами вместо сломанной картинки).
  configureContent({ storageDir: storage });
  // WEBSITE_V1 (задача 12) — mediaDir подменяется в тестах опцией opts.mediaDir,
  // в бою всегда <storage>/website.
  const mediaDir = opts.mediaDir || path.join(storage, 'website');
  const app = express();
  app.disable('x-powered-by');

  // W4 — жёсткое предусловие спеки §4 («Hard precondition for going live
  // behind any proxy/tunnel»): без app.set('trust proxy', …) Express видит у
  // КАЖДОГО посетителя IP-адрес прокси/туннеля (req.ip — это адрес сокета, а
  // не X-Forwarded-For), и тогда rateLimit()/beaconLimiter() (оба читают
  // req.ip — см. rate-limit.js и analytics.js) считают весь интернет ОДНИМ
  // клиентом: лимит 5 заявок/мин душит всех посетителей разом, а ip_hash
  // заявок теряет смысл защиты от злоупотреблений (все хэши совпадают).
  // opts.trustProxy — для тестируемости (app.test.js подменяет им env, не
  // трогая process.env глобально); в бою источник — SITE_TRUST_PROXY,
  // выставляемый в хостинг-гайде (docs/website-hosting.md) при выходе за
  // прокси/туннель. Значение не задано вовсе — trust proxy не трогаем: сайт
  // без прокси (голый LAN) НЕ должен доверять X-Forwarded-For кому попало.
  const trustProxy = opts.trustProxy !== undefined ? opts.trustProxy : process.env.SITE_TRUST_PROXY;
  if (trustProxy !== undefined && trustProxy !== null && trustProxy !== '') {
    const v = String(trustProxy);
    app.set('trust proxy', (v === '1' || v === 'true') ? 1 : trustProxy);
  }

  // Easy-Med: slowLog(db, …) — первым аргументом база (OPS_EVENTS_V1 пишет
  // событие slow_request с шаблоном маршрута, не путём), в Chilla был slowLog().
  app.use(slowLog(db));
  app.use(compress());
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Frame-Options', 'DENY');
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.set('Content-Security-Policy', buildCsp(db));
    // HSTS только когда TLS уже снят прокси — на голом LAN-HTTP он вреден.
    if (req.headers['x-forwarded-proto'] === 'https')
      res.set('Strict-Transport-Security', 'max-age=31536000');
    next();
  });
  // W2 — язык по умолчанию читается из settings.default_lang на каждый
  // запрос (не при старте приложения): админка может поменять его в любой
  // момент, а редирект должен реагировать без рестарта сервера.
  app.get('/', (req, res) => res.redirect(302, `/${defaultLang(db)}/`));

  // WEBSITE_V1 — sitemap.xml/robots.txt: одни на весь сайт (не по языку),
  // до langRouter-ов, чтобы не путаться с /:lang-разбором путей ниже.
  app.get('/sitemap.xml', (req, res) => res.type('application/xml').send(sitemapXml(db)));
  app.get('/robots.txt', (req, res) => res.type('text/plain').send(robotsTxt(db)));

  // WEBSITE_V1 (задача 12) — публичные картинки сайта: без языка в пути (как
  // sitemap/robots выше), поэтому маршрут стоит на уровне app, ДО langRouter-ов.
  app.get('/media/*rest', mediaRoute(mediaDir, db, { storageDir: storage }));

  // Статика сайта — СВОЯ папка public/site, не public/ ЕРП: admin.html и
  // js/admin/* не должны существовать на этом слушателе даже случайно.
  app.use('/assets', express.static(path.join(ROOT, 'public', 'site'), {
    setHeaders: (res, fp) => {
      if (/\.(?:css|js|mjs)$/i.test(fp)) res.setHeader('Cache-Control', 'no-cache');
      else res.setHeader('Cache-Control', 'public, max-age=604800');
    },
  }));

  // WEBSITE_V1 — приём заявок (задача 10). Один маршрут на ВСЕ языки (не
  // внутри langRouter): у формы уже есть скрытое поле lang, различать язык
  // по URL здесь незачем. Работает и без JS: обычный <form method=post>
  // получает 303 на страницу «Спасибо» своего языка, fetch-клиент — JSON.
  //
  // Порядок middleware важен: rateLimit() стоит ПЕРЕД разбором тела — так
  // шторм запросов с одного IP получает 429 до того, как процесс потратит
  // время на парсинг (пусть даже 32kb) каждого из них. Парсеры body поэтому
  // навешаны прямо на этот маршрут, а не на весь '/api' уровнем выше.
  app.post('/api/requests', rateLimit({ windowMs: 60_000, max: 5 }),
    express.json({ limit: '32kb' }),
    express.urlencoded({ extended: false, limit: '32kb' }),
    (req, res) => {
      try {
        // W3-2 — куку wsid читаем тем же парсером, что и маячок (app.js не
        // должен заводить второй способ разбора Cookie): заявка без куки
        // (форма без JS, кука ещё не пришла) просто идёт с wsid=undefined —
        // requests.js трактует это как «не связано», а не как ошибку.
        const c = parseCookies(req.headers.cookie || '');
        const out = handleRequest(db, req.body || {}, { ip: req.ip, ua: req.headers['user-agent'] || '', wsid: c.wsid });
        const accept = String(req.headers.accept || '');
        const contentType = String(req.headers['content-type'] || '');
        const isNoJsFormPost = !accept.includes('application/json') &&
          contentType.includes('application/x-www-form-urlencoded');
        if (isNoJsFormPost) {
          const lang = LANGS.includes(req.body?.lang) ? req.body.lang : DEFAULT_LANG;
          return res.redirect(303, `/${lang}/appointment/thanks`);
        }
        res.json({ data: out });
      } catch (e) {
        // Доверяем только ошибкам с err(status, code, message) из requests.js —
        // у них status ЧИСЛО. Всё остальное (например "database is locked" от
        // better-sqlite3) — неожиданный сбой: наружу уходит непрозрачное 500,
        // а подробности — только в лог.
        if (typeof e?.status === 'number') {
          siteError(res, e.status, e.code || 'bad_request', e.message || 'Invalid request.');
        } else {
          console.error('[site request]', e);
          siteError(res, 500, 'internal', 'Server error.');
        }
      }
    });

  // WEBSITE_V1 (задача W3) — маячок аналитики: sendBeacon/fetch с каждой
  // страницы (public/site/site.js). Правило W3-R3: ответ ВСЕГДА 204 — даже
  // при мусорном теле, боте или превышении лимита, — аналитика не имеет
  // права мешать посетителю. beaconLimiter() поэтому НЕ переиспользует
  // rateLimit() (тот отвечает 429): свой лимитер сам закрывает ответ 204 и
  // не пускает запрос дальше, до express.json/записи в БД дело не доходит.
  //
  // Битый JSON — тоже "мусорное тело", а не повод для 400: express.json()
  // сообщает о нём через next(err), минуя обычный обработчик маршрута, —
  // поэтому четвёртым звеном стоит error-обработчик Express (err, req, res,
  // next), пойманный именно этим маршрутом (route.dispatch пропускает слои
  // не той арности сам, отдельно навешивать app.use((err,...)) не нужно).
  app.post('/api/beacon',
    beaconLimiter({ windowMs: 60_000, max: 60 }),
    express.json({ limit: '8kb' }),
    (req, res) => {
      try {
        const c = parseCookies(req.headers.cookie || '');
        const out = recordBeacon(db, req.body || {}, {
          wsid: c.wsid, wvid: c.wvid, ua: req.headers['user-agent'] || '', host: req.headers.host || '',
        });
        if (out) {
          // Fix 4 — обе куки аналитики никогда не читаются клиентским JS
          // (see public/site/site.js — cookies read only server-side), поэтому
          // HttpOnly ничего не ломает и закрывает кражу значения через XSS.
          // Secure — по тому же признаку, что и HSTS выше (req.headers
          // x-forwarded-proto === 'https'): на голом LAN-HTTP без TLS кука с
          // Secure браузер не отправит вовсе.
          const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
          res.setHeader('Set-Cookie', [
            `wsid=${out.wsid}; Path=/; Max-Age=1800; SameSite=Lax; HttpOnly${secure}`,
            `wvid=${out.wvid}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly${secure}`,
          ]);
        }
      } catch (e) { console.error('[beacon]', e.message); }
      res.status(204).end();   // ВСЕГДА 204 — аналитика никогда не мешает сайту
    },
    (err, req, res, next) => {  // eslint-disable-line no-unused-vars
      res.status(204).end();   // битое тело — тоже 204, не 400
    });

  // WEBSITE_V1 — страницы регистрируются по-языково: Express 5 не поддерживает
  // :param(regex), поэтому на каждый язык монтируется свой Router (задачи 6–11
  // добавляют маршруты в langRouter).
  for (const lang of LANGS) app.use('/' + lang, langRouter(db, lang));

  app.use((req, res) => {
    const m = /^\/(uz|ru|en)(\/|$)/.exec(req.path);
    res.status(404).type('html').send(renderNotFound(db, m ? m[1] : DEFAULT_LANG));
  });
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error('[site error]', err.stack || err);
    if (res.headersSent) return next(err);
    if (req.path.startsWith('/api/')) {
      return siteError(res, status, status >= 500 ? 'internal' : 'bad_request',
        status >= 500 ? 'Server error.' : 'Malformed request.');
    }
    const m = /^\/(uz|ru|en)(\/|$)/.exec(req.path);
    // Последний рубеж: если и рендер упал (например, БД недоступна), отдаём
    // голый HTML — обработчик ошибок сам ошибаться не имеет права.
    let html;
    try { html = renderNotFound(db, m ? m[1] : DEFAULT_LANG); }
    catch { html = `<!doctype html><html lang="${m ? m[1] : DEFAULT_LANG}"><meta charset="utf-8"><title>Error</title><h1>Error</h1>`; }
    res.status(status).type('html').send(html);
  });
  return app;
}
