import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachUser, requireAuth, requirePasswordChanged } from './middleware/auth.js';   // FIRST_RUN_PASSWORD_V1
import { compress } from './middleware/compress.js';   // PERF_GZIP_V1
import { slowLog } from './middleware/slow-log.js';   // PERF_SLOWLOG_V1
import { authRoutes } from './routes/auth.js';
import { userRoutes } from './routes/users.js';
import { dbRoutes } from './routes/db.js';
import { rpcRoutes } from './routes/rpc.js';
import { storageRoutes } from './routes/storage.js';
import { attachControl } from './services/control/gate.js';   // LICENCE_CORE_V1
import { setDataDir } from './services/control/config.js';   // LICENCE_CORE_V1
import { recordEvent } from './services/ops-log.js';   // OPS_EVENTS_V1
import { telephonyWebhooks } from './services/telephony/webhooks.js';   // TELEPHONY_V1
import { branchSyncRoutes } from './routes/branch-sync.js';   // BRANCH_SYNC_V1

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export function createApp(db, { dataDir = path.join(ROOT, 'data') } = {}) {
  setDataDir(dataDir);   // LICENCE_CORE_V1 — RPC handlers get no `req`; they read it from here.
  const app = express();
  app.disable('x-powered-by');
  // PERF_SLOWLOG_V1 — самым первым: меряем полное время запроса, включая
  // разбор тела и отдачу ответа, а не только работу маршрута.
  app.use(slowLog(db));   // OPS_EVENTS_V1 — same db-first factory shape as the route modules below.
  // PERF_GZIP_V1 — до статики и до маршрутов: сжимаем и файлы, и ответы API.
  app.use(compress());
  app.use((req, res, next) => { res.set('X-Content-Type-Options', 'nosniff'); next(); });
  // PROCUREMENT_REDESIGN_V1 — Excel import posts up to MAX_IMPORT_ROWS (2000)
  // rows in one RPC call; 2000 Cyrillic rows is ~460 KB. Registered before the
  // global /api parser so body-parser's first-wins rule gives RPCs the larger
  // budget while every other endpoint keeps the tight 100 KB limit.
  app.use('/api/rpc', express.json({ limit: '2mb' }));
  app.use('/api', express.json({ limit: '100kb' }));
  app.use(attachUser(db));
  app.use(attachControl(db, dataDir));   // LICENCE_CORE_V1

  app.get('/api/health', (req, res) => res.json({ ok: true }));
  app.use('/api/auth', authRoutes(db));
  // TELEPHONY_V1 — Binotel's webhook receivers, in /api/auth's slot: BEFORE
  // requirePasswordChanged and carrying no requireAuth, because Binotel sends
  // no cookies — a session gate would 401 every real webhook. The router does
  // its own gating instead (settings toggle, the callcenter module via
  // req.control from attachControl above, the vendor source-IP allowlist and
  // the Company ID check), and every refusal is a non-advertising 404.
  app.use('/api/telephony/binotel', telephonyWebhooks(db));

  // BRANCH_SYNC_V1 — раздача справочника другому ФИЛИАЛУ той же клиники.
  // Стоит здесь же и по той же причине, что вебхуки выше: запрос приходит от
  // другой установки Easy-Med, а не из браузера сотрудника, и cookie сессии у
  // него нет — requireAuth отказал бы каждому честному запросу. Гейт у
  // маршрута свой: подпись на общем секрете пары (routes/branch-sync.js).
  // Стоит ДО requirePasswordChanged намеренно: филиал не должен переставать
  // получать прайс из-за того, что в главном филиале кто-то не сменил пароль
  // при первом входе.
  app.use('/api/branch-sync', branchSyncRoutes(db, dataDir));
  // FIRST_RUN_PASSWORD_V1 — placed AFTER /api/auth (the way out of the state)
  // and BEFORE every other router, so anything mounted later is gated by
  // default instead of by someone remembering to add it.
  app.use('/api', requirePasswordChanged);
  app.use('/api/users', userRoutes(db));
  app.use('/api/db', requireAuth, dbRoutes(db));
  app.use('/api/rpc', requireAuth, rpcRoutes(db));
  // PATIENT_FILE_ATTACH_V1 — хранилище получает базу: файлы документов
  // пациента (clinic-docs/patients/<id>/docs/...) отдаются и принимаются по
  // тому же праву вкладки «Документы», которым закрыта сама карта. Без базы
  // ссылка на файл обходила бы закрытую вкладку.
  app.use('/api/storage', requireAuth, storageRoutes(path.join(dataDir, 'storage'), db));

  // Unknown /api paths answer JSON, not an HTML 404 page.
  app.use('/api', (req, res) => res.status(404).json({ error: { code: 'not_found', message: 'Unknown API endpoint.' } }));

  // extensions:['html'] gives clean URLs: /users serves public/users.html.
  // NO_STALE_CODE_V1 — код всегда сверяется с сервером.
  //
  // Раньше браузер кэшировал js/css «навсегда», а свежесть обеспечивалась
  // руками — суффиксом ?v=... в каждом импорте. Достаточно было забыть один
  // (а забыть в admin.html означало заморозить ВСЕ остальные), и клиника
  // продолжала работать на старом коде: правка есть в файле, на экране её нет,
  // и понять это со стороны невозможно. Так был потерян почти день.
  //
  // 'no-cache' — это НЕ «не кэшировать», а «кэшировать, но перед каждым
  // использованием переспросить». С ETag ответ почти всегда 304 Not Modified:
  // несколько байт по локальной сети вместо целого файла. Картинки и шрифты
  // под это правило не попадают — они не меняются молча.
  const REVALIDATE = /\.(?:html|js|mjs|css)$/i;
  // ONEST_TYPOGRAPHY_V1 — шрифты НЕ no-cache, а long-cache (30 дней).
  //
  // Почему не как js/css: код меняется молча и часто — его свежесть критична.
  // woff2 стабилен по содержимому: Onest не «правится», он либо есть, либо
  // однажды будет заменён целиком. no-cache значит «переспроси при каждом
  // использовании» — для шрифта это условный запрос на каждую загрузку
  // страницы в каждой вкладке каждой регистратуры: бессмысленный трафик по
  // клинической LAN ради файла, который не менялся и не изменится.
  //
  // Почему не год/immutable: если сабсет когда-нибудь пересоберут ПОД ТЕМ ЖЕ
  // именем, клиники с годовым кэшем молча останутся на старых глифах — и
  // никто этого не увидит. 30 дней ограничивают такое расхождение месяцем,
  // не требуя дисциплины «новое имя файла на каждую замену». ETag остаётся:
  // по истечении срока обновление — это 304, не полная перекачка.
  const FONT = /\.(?:woff2?|ttf|otf)$/i;
  app.use(express.static(path.join(ROOT, 'public'), {
    extensions: ['html'],
    setHeaders: (res, filePath) => {
      if (REVALIDATE.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
      else if (FONT.test(filePath)) res.setHeader('Cache-Control', 'public, max-age=2592000');
    },
  }));

  // Last resort. Client errors (malformed JSON, oversized body) keep their
  // real status; only true server errors log a stack. NEVER log the error
  // object itself — body-parser puts the raw request body (passwords) on it.
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) {
      console.error('[server error]', err.stack || err);
      // OPS_EVENTS_V1 — only real server errors count; a 4xx is the caller's
      // mistake, not an operational event. req.route.path is the matched
      // route TEMPLATE (e.g. "/api/patients/:id"), never req.url — a URL can
      // carry a patient id in the path or a name in the query string.
      recordEvent(db, 'server_error', req.route?.path ?? null);
    }
    else console.warn('[client error]', status, err.type || err.code);
    if (res.headersSent) return next(err);
    res.status(status).json({
      error: status >= 500
        ? { code: 'internal', message: 'Server error.' }
        : { code: 'bad_request', message: 'Malformed request.' },
    });
  });

  return app;
}
