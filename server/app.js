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

// CABINET_FIX_V1_R5 (ревью 5, C) — предел тела для документа кабинета врача (см. ниже).   // CABINET_FIX_V1_R5
const CABINET_BODY_LIMIT = '8mb';   // CABINET_FIX_V1_R5
const CABINET_DOC_ROUTE = /^\/api\/(db|rpc\/visit_document_archive)(\/|\?|$)/;   // CABINET_FIX_V1_R5

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
  // V3120_FIX (M6) — ЗАГОЛОВКИ БЕЗОПАСНОСТИ ПРИЛОЖЕНИЯ.
  //   • X-Frame-Options / frame-ancestors: чужой сайт не вставит программу в
  //     свою рамку и не «прокликает» её за сотрудника;
  //   • connect-src 'self': страница ходит только на свой сервер — украденное
  //     скриптом некуда отправить;
  //   • скрипты — только свои. 'unsafe-inline' остаётся ради печатных окон:
  //     они пишутся в about:blank с коротким window.onload=print, а такое окно
  //     наследует эту политику; внешних скриптов и eval нет;
  //   • стили инлайн (экраны задают style= повсюду), картинки data:/blob:
  //     (логотип бланка, фото с камеры), шрифты — свои;
  //   • рамки — свои и https (предпросмотр страницы клиники на Symptex).
  // Хранилище файлов (routes/storage.js) для «скачиваемых» файлов ставит свою,
  // ещё более строгую политику поверх этой.
  const CSP = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "media-src 'self' data: blob: https:",
    "connect-src 'self'",
    "frame-src 'self' blob: data: https:",
    "worker-src 'self' blob:",
    "object-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
  ].join('; ');
  app.use((req, res, next) => {
    res.set('X-Frame-Options', 'SAMEORIGIN');
    res.set('Content-Security-Policy', CSP);
    res.set('Referrer-Policy', 'same-origin');
    next();
  });
  // PROCUREMENT_REDESIGN_V1 — Excel import posts up to MAX_IMPORT_ROWS (2000)
  // rows in one RPC call; 2000 Cyrillic rows is ~460 KB. Registered before the
  // global /api parser so body-parser's first-wins rule gives RPCs the larger
  // budget while every other endpoint keeps the tight 100 KB limit.
  // CABINET_FIX_V1_R5 (ревью 5, C) — ДОКУМЕНТ КАБИНЕТА ВРАЧА СО СНИМКАМИ.   // CABINET_FIX_V1_R5
  // Записи кабинета (visit_services.notes через /api/db) и снимок подписи   // CABINET_FIX_V1_R5
  // (rpc visit_document_archive) несут снимки исследования: кабинет сжимает   // CABINET_FIX_V1_R5
  // каждый до 1400 px JPEG 0,82 (~0,2–0,5 МБ в base64), их до 12 на документ —   // CABINET_FIX_V1_R5
  // до ~6 МБ, плюс текст версий. При 100 КБ строка с одним снимком не   // CABINET_FIX_V1_R5
  // сохранялась и не подписывалась («Некорректный запрос»). Предел этих двух   // CABINET_FIX_V1_R5
  // дверей — 8 МБ; остальное — как было.   // CABINET_FIX_V1_R5
  app.use('/api/db', express.json({ limit: CABINET_BODY_LIMIT }));   // CABINET_FIX_V1_R5
  app.use('/api/rpc/visit_document_archive', express.json({ limit: CABINET_BODY_LIMIT }));   // CABINET_FIX_V1_R5
  app.use('/api/rpc', express.json({ limit: '2mb' }));
  app.use('/api', express.json({ limit: '100kb' }));
  // V3120_FIX — /api/health ТРОГАЕТ БАЗУ. Раньше он отвечал {ok:true}, даже
  // когда база была недоступна (файл заблокирован, диск отвалился), и проверка
  // «новая версия поднялась» после обновления (boot-confirm.js) подтверждала
  // бы сервер, который не может принять ни одного пациента. Один тривиальный
  // SELECT — микросекунды. Стоит ДО attachUser/attachControl: при мёртвой базе
  // они сами бросили бы 500 раньше, чем здесь успели бы сказать 503.
  app.get('/api/health', (req, res) => {
    try {
      db.prepare('SELECT 1 AS ok').get();
    } catch (e) {
      return res.status(503).json({ ok: false, error: { code: 'db_unavailable', message: 'База данных недоступна: ' + (e && e.message) } });
    }
    res.json({ ok: true });
  });
  app.use(attachUser(db));
  app.use(attachControl(db, dataDir));   // LICENCE_CORE_V1
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
  app.use('/api', (req, res) => res.status(404).json({ error: { code: 'not_found', message: 'Неизвестный адрес API.' } }));

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
    // CABINET_FIX_V1_R5 (ревью 5, C) — слишком большое тело — честно и что делать,   // CABINET_FIX_V1_R5
    // а не «Некорректный запрос».   // CABINET_FIX_V1_R5
    if (status === 413 || err.type === 'entity.too.large') {   // CABINET_FIX_V1_R5
      const doc = CABINET_DOC_ROUTE.test(req.originalUrl || req.url || '');   // CABINET_FIX_V1_R5
      return res.status(413).json({ error: { code: 'too_large', message: doc   // CABINET_FIX_V1_R5
        ? 'Документ слишком большой для сохранения (больше 8 МБ) — уберите часть снимков или замените их снимками поменьше и сохраните снова.'   // CABINET_FIX_V1_R5
        : 'Запрос слишком большой — сократите данные и повторите.' } });   // CABINET_FIX_V1_R5
    }   // CABINET_FIX_V1_R5
    res.status(status).json({
      error: status >= 500
        ? { code: 'internal', message: 'Ошибка сервера. Повторите позже.' }
        : { code: 'bad_request', message: 'Некорректный запрос.' },
    });
  });

  return app;
}
