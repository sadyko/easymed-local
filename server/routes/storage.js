import { Router, raw } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { lockedResponse } from '../services/control/gate.js';   // LICENCE_CORE_V1
import { canViewSection, canViewPatientTab, canEditPatientTab } from '../services/roles.js';   // PATIENT_FILE_ATTACH_V1
import { MAX_PATIENT_FILE_BYTES, patientFileRefusal, refusalText } from '../../public/js/shared/patient-file-limits.js';   // PATIENT_FILE_ATTACH_V1

// Local file storage — the offline stand-in for Supabase Storage. Objects live
// on disk under <storageDir>/<bucket>/<path>. Buckets are an allow-list; every
// object path is sanitised so a request can never escape its bucket directory.
// Serving is done by this same-origin authenticated endpoint (the route is
// mounted behind requireAuth), so the client's "signed URL" is simply the
// object's path here — the session cookie authorises the GET.
// TELEGRAM_BROADCAST_IMG_V1 — `telegram-media` держим ОТДЕЛЬНО от clinic-docs:
// туда уходит то, что видит пациент в боте (баннер рассылки), а не внутренние
// документы клиники. Разные корзины — разная судьба при чистке и разный ответ
// на вопрос «что здесь вообще лежит».
const BUCKETS = new Set(['clinic-docs', 'telegram-media']);

const CONTENT_TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8', '.csv': 'text/csv; charset=utf-8',
};
function contentType(abs) {
  return CONTENT_TYPES[path.extname(abs).toLowerCase()] || 'application/octet-stream';
}

// PATIENT_FILE_ATTACH_V1 — исполняемое не кладём НИ В ОДНУ корзину. Это не
// теория: файлы лежат на том самом компьютере, где работает регистратура, и
// «скачать вложение и открыть» — обычное действие. Список короткий и без
// ложных срабатываний: ни один из этих форматов клинике приложить не нужно.
const NEVER_STORE_EXT = new Set([
  '.exe', '.com', '.bat', '.cmd', '.scr', '.pif', '.msi', '.msp', '.dll', '.sys',
  '.ps1', '.psm1', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh', '.hta', '.jar',
  '.lnk', '.reg', '.cpl', '.scf', '.url',
]);

// Resolve <storageDir>/<bucket>/<segments...> and PROVE the result stays inside
// the bucket dir. Returns the absolute path, or null for a bad bucket /
// traversal / empty path. Express 5's `*rest` wildcard hands us the remaining
// path as an array of already-decoded segments; each is checked individually so
// no '.', '..', or nested separator survives.
function safeResolve(storageDir, bucket, rest) {
  if (!BUCKETS.has(bucket)) return null;
  const raw = Array.isArray(rest) ? rest : String(rest || '').split('/');
  const segments = raw.filter(Boolean);
  if (!segments.length) return null;
  if (segments.some((s) => s === '.' || s === '..' || s.includes('/') || s.includes('\\') || s.includes('\0'))) return null;
  const baseDir = path.resolve(storageDir, bucket);
  const abs = path.resolve(baseDir, ...segments);
  if (abs !== baseDir && !abs.startsWith(baseDir + path.sep)) return null;
  return abs;
}
const segmentsOf = (rest) => (Array.isArray(rest) ? rest : String(rest || '').split('/')).filter(Boolean);
const relPath = (rest) => segmentsOf(rest).join('/');

const badPath = (res) => res.status(400).json({ error: { code: 'bad_request', message: 'Invalid storage path.' } });
const refuse = (res, status, code, message) => res.status(status).json({ error: { code, message } });

// PATIENT_FILE_ATTACH_V1 — ФАЙЛ ПАЦИЕНТА УЗНАЁТСЯ ПО ПУТИ, и путь придумывает
// не клиент: карта пациента кладёт вложения ровно в
// clinic-docs/patients/<id>/docs/<ключ> (views/patient-card.js). Четыре
// сегмента ровно в этом порядке — единственная форма, которая считается
// документом пациента, поэтому фотография пациента (`patients/<ключ>`, два
// сегмента) под правило не попадает и ничего не ломает.
//
// Если бы признак жил в теле запроса, его выбирал бы вызывающий, и любой
// авторизованный сотрудник объявил бы свой файл «не документом», чтобы обойти
// проверку вкладки. Путь выбирает не он: по нему же файл потом и читают.
function patientDocId(bucket, rest) {
  if (bucket !== 'clinic-docs') return null;
  const s = segmentsOf(rest);
  if (s.length !== 4 || s[0] !== 'patients' || s[2] !== 'docs') return null;
  const id = Number(s[1]);
  return Number.isInteger(id) && id > 0 ? id : null;
}

// Отказ вкладки «Документы» тем же текстом, каким отказывает карта пациента
// (rpc/patient-card.js DENIED_TEMPLATE) — человек читает одно и то же
// объяснение, откуда бы он ни пришёл: со списка документов или по прямой
// ссылке на файл.
const DOCS_DENIED = 'Вкладка «Документы» закрыта для вашей роли.'
  + ' Доступ открывает администратор клиники: «Настройки» → «Роли» → «Карта пациента — вкладки».';

/**
 * @param {string} storageDir  <dataDir>/storage
 * @param {object} [db]        нужен ТОЛЬКО для документов пациента (права вкладки).
 *   Без него патиент-документы не обслуживаются вовсе — «не смог проверить»
 *   обязан значить «отказ», а не «пропустил». Приложение всегда передаёт базу
 *   (app.js); без базы модуль остаётся тем же тупым хранилищем байтов, каким
 *   был, для остальных путей.
 */
export function storageRoutes(storageDir, db = null) {
  const r = Router();

  // Кто вправе трогать файл документа пациента. Возвращает текст отказа или
  // null. Проверка ТА ЖЕ, что у rpc patient_card_* (services/roles.js), потому
  // что закрытая вкладка, которую можно обойти прямой ссылкой на файл, — это
  // не закрытая вкладка: сканы паспорта и заключения лежат по предсказуемому
  // пути `patients/<id>/docs/…`, а id пациента видит любой сотрудник.
  function patientDocDenial(req, { write }) {
    if (!db) return 'Хранилище документов пациента недоступно.';
    const user = req.user;
    if (!user) return 'Требуется вход.';
    if (!canViewSection(db, user, 'patients')) return 'Раздел «Пациенты» вашей роли не выдан.';
    const ok = write ? canEditPatientTab(db, user, 'docs') : canViewPatientTab(db, user, 'docs');
    return ok ? null : DOCS_DENIED;
  }

  // Upload: raw body (any content type) written verbatim to disk.
  r.post('/:bucket/*rest', raw({ type: () => true, limit: '20mb' }), (req, res) => {
    // LICENCE_CORE_V1 — this is the OTHER write path: patient photos, lab scans
    // and Telegram attachments go straight here, never through /api/db. A
    // lapsed clinic must not be able to create a document any more than it can
    // insert a row — gated first, before touching the filesystem at all.
    if (req.control?.locked) return lockedResponse(res, req.control);
    const abs = safeResolve(storageDir, req.params.bucket, req.params.rest);
    if (!abs) return badPath(res);
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      return res.status(400).json({ error: { code: 'bad_request', message: 'Empty upload.' } });
    }
    if (NEVER_STORE_EXT.has(path.extname(abs).toLowerCase())) {
      return refuse(res, 415, 'file_type_not_allowed',
        'Исполняемые файлы в клинику не загружаются.');
    }
    const pid = patientDocId(req.params.bucket, req.params.rest);
    if (pid !== null) {
      const denial = patientDocDenial(req, { write: true });
      if (denial) return refuse(res, 403, 'forbidden', denial);
      // Те же правила, что отбивает браузер ДО загрузки, — ещё раз здесь.
      // Браузер обойти можно; этот маршрут — нет.
      const bad = patientFileRefusal({ name: path.basename(abs), size: body.length });
      if (bad) return refuse(res, bad.code === 'file_too_large' ? 413 : 415, bad.code, refusalText(bad));
    }
    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, body);
    } catch (e) {
      console.error('[storage write]', e.message);
      return res.status(500).json({ error: { code: 'internal', message: 'Could not store file.' } });
    }
    return res.json({ data: { path: relPath(req.params.rest), size: body.length } });
  });

  // PATIENT_FILE_ATTACH_V1 — тело больше 20 МБ express отбивает САМ, ещё до
  // обработчика, и по умолчанию это уходит в общий обработчик ошибок HTML-ом
  // «PayloadTooLargeError». Телефонная фотография на 40 МБ — не редкость, а
  // обычный вторник в регистратуре, и ответ на неё обязан быть тем же
  // понятным JSON-отказом, что и все остальные: с размером, пределом и тем,
  // что делать. Обработчик ошибок ставится СРАЗУ за POST, до GET/DELETE, —
  // express подбирает ближайший следующий за упавшим слоем.
  r.use((err, req, res, next) => {
    if (err && (err.type === 'entity.too.large' || err.status === 413)) {
      return refuse(res, 413, 'file_too_large', refusalText({
        template: 'Файл больше предела в {max} МБ. Переснимите фотографию в меньшем качестве или приложите PDF.',
        params: { max: String(Math.round(MAX_PATIENT_FILE_BYTES / (1024 * 1024))) },
      }));
    }
    return next(err);
  });

  // Serve an object (same-origin, session-authenticated — works for <img src>).
  r.get('/:bucket/*rest', (req, res) => {
    const abs = safeResolve(storageDir, req.params.bucket, req.params.rest);
    if (!abs) return badPath(res);
    const pid = patientDocId(req.params.bucket, req.params.rest);
    if (pid !== null) {
      const denial = patientDocDenial(req, { write: false });
      if (denial) return refuse(res, 403, 'forbidden', denial);
      // Отозванный документ (миграция 105) перестаёт открываться. Строка и
      // байты остаются — карта клиники ничего не теряет, — но ссылка,
      // разосланная до отзыва, больше не отдаёт файл.
      const row = db.prepare('SELECT voided_at FROM visit_documents WHERE file_path = ? LIMIT 1')
        .get(relPath(req.params.rest));
      if (row && row.voided_at) {
        return refuse(res, 410, 'document_voided', 'Документ отозван и больше не открывается.');
      }
    }
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      return res.status(404).json({ error: { code: 'not_found', message: 'File not found.' } });
    }
    res.setHeader('Content-Type', contentType(abs));
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    fs.createReadStream(abs).pipe(res);
  });

  // Best-effort delete.
  r.delete('/:bucket/*rest', (req, res) => {
    // LICENCE_CORE_V1 — deleting a stored file is a write, same as DELETE
    // /api/db; a lapsed clinic keeps read access to everything already there.
    if (req.control?.locked) return lockedResponse(res, req.control);
    const abs = safeResolve(storageDir, req.params.bucket, req.params.rest);
    if (!abs) return badPath(res);
    // PATIENT_FILE_ATTACH_V1 — ДОКУМЕНТ ПАЦИЕНТА НЕ УДАЛЯЕТСЯ, он отзывается
    // (rpc patient_card_doc_void, миграция 105). Раньше карта звала этот
    // маршрут сразу после удаления строки, и файл исчезал безвозвратно — при
    // том, что весь остальной продукт клинические записи гасит, а не стирает
    // (отметки медсестры — voided_at, счета — 'void'). Отказ здесь нужен и
    // после того, как карту поправили: маршрут открыт curl'ом.
    if (patientDocId(req.params.bucket, req.params.rest) !== null) {
      return refuse(res, 403, 'forbidden',
        'Документ пациента не удаляется — его можно только отозвать в карте пациента.');
    }
    try { fs.unlinkSync(abs); } catch { /* already gone */ }
    return res.json({ data: {} });
  });

  return r;
}
