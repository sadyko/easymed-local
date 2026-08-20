import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachUser, requireAuth } from './middleware/auth.js';
import { compress } from './middleware/compress.js';   // PERF_GZIP_V1
import { slowLog } from './middleware/slow-log.js';   // PERF_SLOWLOG_V1
import { authRoutes } from './routes/auth.js';
import { userRoutes } from './routes/users.js';
import { dbRoutes } from './routes/db.js';
import { rpcRoutes } from './routes/rpc.js';
import { storageRoutes } from './routes/storage.js';
import { attachControl } from './services/control/gate.js';   // LICENCE_CORE_V1
import { setDataDir } from './services/control/config.js';   // LICENCE_CORE_V1

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export function createApp(db, { dataDir = path.join(ROOT, 'data') } = {}) {
  setDataDir(dataDir);   // LICENCE_CORE_V1 — RPC handlers get no `req`; they read it from here.
  const app = express();
  app.disable('x-powered-by');
  // PERF_SLOWLOG_V1 — самым первым: меряем полное время запроса, включая
  // разбор тела и отдачу ответа, а не только работу маршрута.
  app.use(slowLog());
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
  app.use('/api/users', userRoutes(db));
  app.use('/api/db', requireAuth, dbRoutes(db));
  app.use('/api/rpc', requireAuth, rpcRoutes(db));
  app.use('/api/storage', requireAuth, storageRoutes(path.join(dataDir, 'storage')));

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
  app.use(express.static(path.join(ROOT, 'public'), {
    extensions: ['html'],
    setHeaders: (res, filePath) => {
      if (REVALIDATE.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
    },
  }));

  // Last resort. Client errors (malformed JSON, oversized body) keep their
  // real status; only true server errors log a stack. NEVER log the error
  // object itself — body-parser puts the raw request body (passwords) on it.
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error('[server error]', err.stack || err);
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
