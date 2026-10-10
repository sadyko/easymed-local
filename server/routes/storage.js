import { Router, raw } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { lockedResponse } from '../services/control/gate.js';   // LICENCE_CORE_V1
import { canViewSection, canEditSection, canViewPatientTab, canEditPatientTab } from '../services/roles.js';   // PATIENT_FILE_ATTACH_V1 + PATIENT_PHOTO_V1
import { MAX_PATIENT_FILE_BYTES, patientFileRefusal, photoRefusal, refusalText, ALLOWED_PATIENT_FILE_EXT, ALLOWED_PHOTO_EXT } from '../../public/js/shared/patient-file-limits.js';   // PATIENT_FILE_ATTACH_V1 + PATIENT_PHOTO_V1
import { grantAllowsAdminOr, isAdminUser } from '../services/grants.js';   // V3120_FIX (M7) — корзина Telegram по праву бота
import { LOGO_BUCKET, LOGO_KINDS, logoRefusal } from '../../public/js/shared/clinic-logo-rules.js';   // CLINIC_PROFILE_V1
import { readIdentity } from '../services/branch-sync/identity.js';   // CLINIC_PROFILE_V1

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
// PATIENT_PHOTO_V1 — `patient-photos` и `doctor-photos` СУЩЕСТВОВАЛИ в
// приложении с самого переезда с Supabase (views/patient-create-modal.js,
// views/doctor-profile.js грузят именно в них), но в этом списке их не было, и
// поэтому КАЖДАЯ загрузка фотографии отвечала 400 «Invalid storage path»:
// съёмка с веб-камеры, выбор файла в окне заведения пациента и фото врача в
// «Моём профиле». Список — единственная дверь, и молчание о собственных
// корзинах закрывало её наглухо.
//
// Корзины РАЗНЫЕ, а не одна «photos», по той же причине, по какой
// telegram-media отделён от clinic-docs: у них разный ответ на вопрос «кто
// вправе это менять» (фото пациента — тот, кто правит пациента; фото врача —
// сам врач) и разная судьба (карточка врача уезжает на Symptex, фотография
// пациента не покидает клинику).
//
// CLINIC_PROFILE_V1 — `clinic-logos`: два логотипа клиники («Компания»).
const BUCKETS = new Set(['clinic-docs', 'telegram-media', 'patient-photos', 'doctor-photos', LOGO_BUCKET]);   // CLINIC_PROFILE_V1

// V3120_FIX (M6) — ЧТО ОТДАЁТСЯ «ВНУТРИ СТРАНИЦЫ». Файл из хранилища открыт
// тем же адресом, что и само приложение, и SVG или HTML, отданные как есть,
// исполнились бы с сессией открывшего (загрузил один — сработало у другого).
// Поэтому внутри страницы показываются только растровые картинки и PDF; всё
// остальное уходит «скачать» (Content-Disposition: attachment), а SVG/XHTML
// вовсе не получают своего типа.
const CONTENT_TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8', '.csv': 'text/csv; charset=utf-8',
};
const INLINE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.pdf']);
function contentType(abs) {
  return CONTENT_TYPES[path.extname(abs).toLowerCase()] || 'application/octet-stream';
}

// V3120_FIX (M8) — какие файлы вообще кладутся в корзину. Фото — только
// картинки; документы клиники и пациента — картинки, PDF, офис и текст (тот же
// список, что у карты пациента); Telegram — то же плюс голос и видео из
// переписки. SVG/HTML — никуда.
const DOC_EXT = new Set(ALLOWED_PATIENT_FILE_EXT);
const BUCKET_EXT = {
  'clinic-docs': DOC_EXT,
  'telegram-media': new Set([...ALLOWED_PATIENT_FILE_EXT, '.mp3', '.ogg', '.oga', '.opus', '.m4a', '.wav', '.mp4', '.mov', '.webm']),
  'patient-photos': new Set(ALLOWED_PHOTO_EXT),
  'doctor-photos': new Set(ALLOWED_PHOTO_EXT),
  [LOGO_BUCKET]: new Set(['.png']),   // CLINIC_PROFILE_V1
};
const TYPE_REFUSED = 'Файлы такого типа в хранилище не кладутся. Подойдут картинки (JPG, PNG), PDF, документы Word и Excel, обычный текст.';

// V3120_FIX (M8) — имена, которые Windows не создаст или создаст не тем
// файлом: зарезервированные устройства (CON, AUX, NUL, COM1…), двоеточие
// (альтернативный поток NTFS: «a.pdf:evil»), точка или пробел в конце
// (Windows их молча срезает — «a.pdf.» станет «a.pdf»), и слишком длинные
// имена, которые раньше роняли запись в 500.
const RESERVED_WIN = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;
const MAX_SEGMENT = 180;
const BAD_NAME = 'Такое имя файла недопустимо. Переименуйте файл: без двоеточий, без точки или пробела в конце, не длиннее 180 символов.';
function badSegment(seg) {
  return seg.length > MAX_SEGMENT || seg.includes(':') || /[. ]$/.test(seg) || RESERVED_WIN.test(seg)
    || /[<>"|?*\x00-\x1f]/.test(seg);
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

const badPath = (res) => res.status(400).json({ error: { code: 'bad_request', message: 'Неверный путь к файлу.' } });
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

// V3120_FIX (M7) — ЛЮБОЙ путь под clinic-docs/patients/ — это файл пациента.
// Правило вкладки «Документы» стояло только на точной форме из четырёх
// сегментов, и файл, положенный на сегмент глубже или мельче, читал и писал
// любой вошедший. Форма документа (patientDocId) по-прежнему решает, что
// считается ДОКУМЕНТОМ (отзыв, 410); право — на всё дерево.
function underPatients(bucket, rest) {
  if (bucket !== 'clinic-docs') return false;
  const s = segmentsOf(rest);
  return s.length > 0 && s[0] === 'patients';
}

// PATIENT_PHOTO_V1 — ФОТОГРАФИЯ УЗНАЁТСЯ ПО ПУТИ, ровно как документ выше, и
// по той же причине: признак, живущий в теле запроса, выбирает вызывающий.
//
// Форма пути ЕДИНСТВЕННАЯ на корзину, и всё остальное в этих корзинах —
// «неверный путь», а не «файл без правил». Это и есть разница между
// «проверяем, если похоже» и «в корзине не может лежать ничего, кроме того,
// что проверено»: перебрать глубину или переименовать сегмент, чтобы обойти
// право, нельзя — такой путь просто не существует.
//
//   patient-photos/patients/<ключ>              — портрет пациента (2 сегмента)
//   doctor-photos/doctors/<id врача>/<ключ>      — портрет врача   (3 сегмента)
//
// id врача попал В ПУТЬ намеренно: без него нельзя ответить на вопрос «чьё это
// фото», а значит нельзя и выполнить правило «свою фотографию врач меняет
// сам». Раньше путь был `doctors/<ключ>` — по нему любой сотрудник мог бы
// положить файл, который карточка чужого врача покажет как его лицо.
//
// У пациента id в пути НЕТ, и это не забывчивость: фотографию снимают в окне
// заведения пациента ДО того, как пациент появился, — карты, к которой можно
// было бы привязать путь, в этот момент ещё не существует. Право поэтому
// спрашивается о ПАЦИЕНТАХ ВООБЩЕ (см. patientPhotoDenial), а не об одном.
export function photoTarget(bucket, rest) {
  const s = segmentsOf(rest);
  if (bucket === 'patient-photos') {
    return (s.length === 2 && s[0] === 'patients' && s[1]) ? { kind: 'patient' } : null;
  }
  if (bucket === 'doctor-photos') {
    if (s.length !== 3 || s[0] !== 'doctors' || !s[2]) return null;
    const id = Number(s[1]);
    return Number.isInteger(id) && id > 0 ? { kind: 'doctor', doctorId: id } : null;
  }
  return null;
}
const isPhotoBucket = (bucket) => bucket === 'patient-photos' || bucket === 'doctor-photos';

// CLINIC_PROFILE_V1 — ЛОГОТИП КЛИНИКИ УЗНАЁТСЯ ПО ПУТИ, как фото врача:
//   clinic-logos/square/<ключ>.png    — квадратный (шапка, печать, карточки)
//   clinic-logos/portrait/<ключ>.png  — вертикальный (страница клиники у партнёров)
// Вид логотипа — в пути, поэтому правило «квадратный — квадратный» проверяется
// по тому месту, куда файл ложится, а не по слову в теле запроса.
// clinic-logos/legacy/… пишет только сервер (services/clinic-logo-legacy.js).
export function logoTarget(bucket, rest) {
  if (bucket !== LOGO_BUCKET) return null;
  const s = segmentsOf(rest);
  return (s.length === 2 && LOGO_KINDS.includes(s[0]) && s[1]) ? { kind: s[0] } : null;
}
const LOGO_DENIED = 'Логотипы клиники меняет администратор или тот, кому выдано изменение «Компании».';   // CLINIC_PROFILE_V1
const LOGO_MAIN_ONLY = 'Логотипы клиники меняются в главном здании.';   // CLINIC_PROFILE_V1
const LOGO_NO_DELETE = 'Логотип не удаляется — новая загрузка заменяет прежний, а «Удалить» в «Компании» снимает его с бланков.';   // CLINIC_PROFILE_V1

// Отказ вкладки «Документы» тем же текстом, каким отказывает карта пациента
// (rpc/patient-card.js DENIED_TEMPLATE) — человек читает одно и то же
// объяснение, откуда бы он ни пришёл: со списка документов или по прямой
// ссылке на файл.
const DOCS_DENIED = 'Вкладка «Документы» закрыта для вашей роли.'
  + ' Доступ открывает администратор клиники: «Настройки» → «Роли» → «Карта пациента — вкладки».';

// PATIENT_PHOTO_V1 — отказ называет ПРАВО, а не «нельзя»: фотография пациента
// — часть его анкеты, и меняет её тот, кому анкету менять разрешено.
const PATIENT_PHOTO_DENIED = 'Фотографию пациента меняет тот, кому разрешено изменять карту пациента.'
  + ' Доступ открывает администратор клиники: «Настройки» → «Роли» → раздел «Пациенты» и вкладка «Детали».';
const DOCTOR_PHOTO_DENIED = 'Своё фото врач меняет сам — в «Моём профиле».'
  + ' Чужое может поставить только администратор клиники.';

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
  // V3120_FIX (M7) — корзина Telegram: то, что видит пациент в боте, и
  // вложения переписки. Читает тот, у кого «Чат с пациентами» или бот
  // («Настройки → Telegram» / отчёт); кладёт — тот, кто в чате отвечает или
  // настраивает бота. Раньше — любой вошедший.
  function telegramDenial(req, { write }) {
    if (!db) return 'Хранилище Telegram недоступно.';
    const user = req.user;
    if (!user) return 'Требуется вход.';
    try {
      if (write) {
        if (canEditSection(db, user, 'telegram-chat') || grantAllowsAdminOr(db, user, 'settings.telegram', 'edit')) return null;
      } else if (canViewSection(db, user, 'telegram-chat') || grantAllowsAdminOr(db, user, 'settings.telegram', 'view')
          || grantAllowsAdminOr(db, user, 'reports.telegram', 'view')) {
        return null;
      }
    } catch { /* права не прочитались — отказ */ }
    return 'Файлы Telegram-бота недоступны вашей роли. Права выдаёт администратор в «Настройки → Роли».';
  }

  // V3120_FINAL (I2) — ФАЙЛЫ КЛИНИКИ вне папки пациентов (clinic-docs:
  // лицензия и сертификат, логотипы и прочее из «Настроек»). Удалить или
  // ПЕРЕПИСАТЬ их (загрузка на тот же путь заменяет файл) мог любой вошедший:
  // склад стирал лицензию клиники одним DELETE. Теперь — администратор или
  // тот, кто вправе изменять «Настройки»: все экраны, которые кладут сюда
  // файлы, — экраны настроек. Читать по-прежнему может всякий вошедший —
  // логотип печатается на бланках. Без базы (юнит-монтирование маршрута) —
  // не применяется: приложение базу передаёт всегда.
  function clinicFilesDenial(req) {
    if (!db) return null;
    const user = req.user;
    if (!user) return 'Требуется вход.';
    try {
      if (isAdminUser(user) || canEditSection(db, user, 'settings')) return null;
    } catch { /* права не прочитались — отказ */ }
    return 'Файлы клиники (лицензия, сертификаты, логотипы) меняет администратор или тот, кому выдано изменение «Настроек».';
  }

  function patientDocDenial(req, { write }) {
    if (!db) return 'Хранилище документов пациента недоступно.';
    const user = req.user;
    if (!user) return 'Требуется вход.';
    if (!canViewSection(db, user, 'patients')) return 'Раздел «Пациенты» вашей роли не выдан.';
    const ok = write ? canEditPatientTab(db, user, 'docs') : canViewPatientTab(db, user, 'docs');
    return ok ? null : DOCS_DENIED;
  }

  // PATIENT_PHOTO_V1 — КТО ВПРАВЕ ПОСТАВИТЬ ПАЦИЕНТУ ЛИЦО.
  //
  // Ключ выбран ТОТ ЖЕ, которым карта пациента защищает анкету: раздел
  // «Пациенты» на уровне изменения ПЛЮС вкладка «Детали» (7ff82a6,
  // PATIENT_TAB_CAPS.details = { edit: true }). Фотография и есть анкета —
  // она отвечает на вопрос «тот ли это человек», как отвечают на него ФИО,
  // дата рождения и номер документа, и лежит в той же строке `patients`
  // (колонка photo_url).
  //
  // Почему НЕ ключ «Регистрация» (`registration`), которым закрыто окно
  // заведения пациента: фотографию ставят не только новому — её меняют и
  // существующему. Право «может завести карту» ответило бы «нет» тому, кто
  // карту ведёт, но не заводит, и «да» тому, кто заводит, но править чужую
  // анкету не должен. Право «может изменить пациента» отвечает ровно на
  // заданный вопрос.
  //
  // Просмотр — «Детали» на уровне просмотра. Отдельный уровень нужен потому,
  // что вкладку можно закрыть, а ссылка на файл предсказуема (одна корзина,
  // одна форма пути): закрытая вкладка, обходимая прямой ссылкой, — не
  // закрытая вкладка. Это тот же довод, что у документов выше.
  function patientPhotoDenial(req, { write }) {
    if (!db) return 'Хранилище фотографий недоступно.';
    const user = req.user;
    if (!user) return 'Требуется вход.';
    if (!canViewSection(db, user, 'patients')) return 'Раздел «Пациенты» вашей роли не выдан.';
    if (!write) return canViewPatientTab(db, user, 'details') ? null : PATIENT_PHOTO_DENIED;
    // Оба условия обязательны. Лаборант получает раздел «Пациенты» на уровне
    // просмотра (миграция 013) и вкладками не ограничен — то есть одной
    // проверки вкладки ему хватило бы, чтобы переписать чужое лицо.
    if (!canEditSection(db, user, 'patients')) return PATIENT_PHOTO_DENIED;
    return canEditPatientTab(db, user, 'details') ? null : PATIENT_PHOTO_DENIED;
  }

  // PATIENT_PHOTO_V1 — ФОТО ВРАЧА: СВОЁ — СВОЁ.
  //
  // «Мой профиль» (views/doctor-profile.js) — это публичная карточка врача,
  // которая уезжает на Symptex и которую видят пациенты. Её ставит сам врач:
  // сравнение с req.user.id — не украшение, а всё правило целиком, и работает
  // оно только потому, что id врача стоит В ПУТИ, а не в теле запроса.
  //
  // Плюс администратор клиники. Не «на всякий случай»: карточки врачей
  // заводит и дополняет тот же человек, который правит строку сотрудника в
  // «Настройки → Сотрудники». Ключ `settings` на уровне изменения и есть
  // право на этот раздел; шире круг не делаем.
  //
  // ЧТЕНИЕ НЕ ОГРАНИЧЕНО ВОВСЕ, и это решение, а не пропуск: фотография врача
  // публична по назначению — она печатается на бланках, показывается в
  // расписании и уходит на Symptex. Маршрут и так стоит за requireAuth.
  function doctorPhotoDenial(req, doctorId, { write }) {
    if (!write) return null;
    const user = req.user;
    if (!user) return 'Требуется вход.';
    if (Number(user.id) === Number(doctorId)) return null;
    if (!db) return 'Хранилище фотографий недоступно.';
    return canEditSection(db, user, 'settings') ? null : DOCTOR_PHOTO_DENIED;
  }

  // CLINIC_PROFILE_V1 — кто кладёт логотип клиники: не в филиале (логотипы
  // главного здания приезжают к нему печатной копией), администратор или
  // «Компания: Изменение» — тот же ключ, что пишет doc_settings.
  function logoDenial(req) {
    const user = req.user;
    if (!user) return { status: 401, code: 'unauthorized', message: 'Требуется вход.' };
    if (!db) return { status: 403, code: 'forbidden', message: LOGO_DENIED };
    try { if (readIdentity(db).role === 'secondary') return { status: 409, code: 'conflict', message: LOGO_MAIN_ONLY }; }
    catch { /* строки нет — установка не филиал */ }
    try { if (grantAllowsAdminOr(db, user, 'settings.company', 'edit')) return null; } catch { /* права не прочитались — отказ */ }
    return { status: 403, code: 'forbidden', message: LOGO_DENIED };
  }

  // Одна дверь для обеих фотокорзин: форма пути → право. Возвращает false
  // (можно продолжать) либо уже отправленный ответ.
  function photoGate(req, res, { write }) {
    const target = photoTarget(req.params.bucket, req.params.rest);
    if (!target) return badPath(res);
    const denial = target.kind === 'patient'
      ? patientPhotoDenial(req, { write })
      : doctorPhotoDenial(req, target.doctorId, { write });
    if (denial) return refuse(res, 403, 'forbidden', denial);
    return false;
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
    if (segmentsOf(req.params.rest).some(badSegment)) return refuse(res, 400, 'bad_file_name', BAD_NAME);
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      return res.status(400).json({ error: { code: 'bad_request', message: 'Файл пустой — загружать нечего.' } });
    }
    if (NEVER_STORE_EXT.has(path.extname(abs).toLowerCase())) {
      return refuse(res, 415, 'file_type_not_allowed',
        'Исполняемые файлы в клинику не загружаются.');
    }
    // CLINIC_PROFILE_V1 — логотип клиники: путь → здание и право → PNG с прозрачностью.
    if (req.params.bucket === LOGO_BUCKET) {
      const target = logoTarget(req.params.bucket, req.params.rest);
      if (!target) return badPath(res);
      const d = logoDenial(req);
      if (d) return refuse(res, d.status, d.code, d.message);
      const bad = logoRefusal({ kind: target.kind, name: path.basename(abs), bytes: body });
      if (bad) {
        return res.status(bad.code === 'file_too_large' ? 413 : 415)
          .json({ error: { code: bad.code, message: refusalText(bad), template: bad.template, params: bad.params } });
      }
    }
    // V3120_FIX (M8) — расширение по корзине. Фото проверяет photoRefusal
    // ниже своим, более понятным текстом, поэтому здесь — остальные корзины.
    const allowedExt = BUCKET_EXT[req.params.bucket];
    if (allowedExt && !isPhotoBucket(req.params.bucket) && req.params.bucket !== LOGO_BUCKET   // CLINIC_PROFILE_V1 — логотип проверен выше
        && !allowedExt.has(path.extname(abs).toLowerCase())) {
      return refuse(res, 415, 'file_type_not_allowed', TYPE_REFUSED);
    }
    if (req.params.bucket === 'telegram-media') {
      const denial = telegramDenial(req, { write: true });
      if (denial) return refuse(res, 403, 'forbidden', denial);
    }
    if (underPatients(req.params.bucket, req.params.rest) && patientDocId(req.params.bucket, req.params.rest) === null) {
      const denial = patientDocDenial(req, { write: true });
      if (denial) return refuse(res, 403, 'forbidden', denial);
    }
    if (req.params.bucket === 'clinic-docs' && !underPatients(req.params.bucket, req.params.rest)) {   // V3120_FINAL (I2)
      const denial = clinicFilesDenial(req);
      if (denial) return refuse(res, 403, 'forbidden', denial);
    }
    // PATIENT_PHOTO_V1 — фотография: право, формат и предел. Проверяется
    // ЗДЕСЬ ещё раз, хотя браузер уменьшил и отсеял то же самое до отправки:
    // браузер обойти можно, curl проверку не спрашивает.
    if (isPhotoBucket(req.params.bucket)) {
      const stop = photoGate(req, res, { write: true });
      if (stop) return stop;
      const bad = photoRefusal({ name: path.basename(abs), size: body.length });
      if (bad) return refuse(res, bad.code === 'file_too_large' ? 413 : 415, bad.code, refusalText(bad));
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
    // V3120_FIX (M8) — документ и фото пациента НЕ ПЕРЕЗАПИСЫВАЮТСЯ. Их имена
    // уникальны (время + случайный хвост), и честной загрузке совпасть не с
    // чем; совпадение — это попытка подменить уже приложенный скан или лицо
    // под тем же адресом, на который ссылается карта. Флаг 'wx' — проверка и
    // создание одним действием, без окна между ними.
    const noOverwrite = underPatients(req.params.bucket, req.params.rest) || isPhotoBucket(req.params.bucket)
      || req.params.bucket === LOGO_BUCKET;   // CLINIC_PROFILE_V1 — логотип не подменяется под тем же адресом
    // V3120_FINAL — папка в пути занята ФАЙЛОМ с тем же именем
    // (misc/a.pdf/b.pdf при существующем misc/a.pdf). mkdir отвечал EEXIST, и
    // человек читал «файл с таким именем уже есть — программа даст новое имя»,
    // что неправда: повтор упал бы так же.
    {
      const bucketRoot = path.join(storageDir, req.params.bucket);
      for (let dir = path.dirname(abs); dir.length > bucketRoot.length && dir.startsWith(bucketRoot); dir = path.dirname(dir)) {
        let st = null;
        try { st = fs.statSync(dir); } catch { st = null; }
        if (st && !st.isDirectory()) {
          return refuse(res, 409, 'parent_is_file', 'В этом пути вместо папки лежит файл с тем же именем. Сохраните файл в другую папку или под другим именем.');
        }
        if (st) break;
      }
    }
    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, body, noOverwrite ? { flag: 'wx' } : undefined);
    } catch (e) {
      if (e && e.code === 'EEXIST') {
        return refuse(res, 409, 'file_exists', 'Файл с таким именем уже есть — загрузите его ещё раз, программа даст ему новое имя.');
      }
      if (e && (e.code === 'ENAMETOOLONG' || e.code === 'EINVAL' || e.code === 'ENOENT')) {
        return refuse(res, 400, 'bad_file_name', BAD_NAME);
      }
      console.error('[storage write]', e.message);
      return res.status(500).json({ error: { code: 'internal', message: 'Файл не сохранился — попробуйте ещё раз.' } });
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
    if (req.params.bucket === LOGO_BUCKET && !logoTarget(req.params.bucket, req.params.rest)) return badPath(res);   // CLINIC_PROFILE_V1
    if (isPhotoBucket(req.params.bucket)) {
      const stop = photoGate(req, res, { write: false });
      if (stop) return stop;
    }
    if (req.params.bucket === 'telegram-media') {
      const denial = telegramDenial(req, { write: false });
      if (denial) return refuse(res, 403, 'forbidden', denial);
    }
    if (underPatients(req.params.bucket, req.params.rest)) {
      const denial = patientDocDenial(req, { write: false });
      if (denial) return refuse(res, 403, 'forbidden', denial);
    }
    const pid = patientDocId(req.params.bucket, req.params.rest);
    if (pid !== null) {
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
      return res.status(404).json({ error: { code: 'not_found', message: 'Файл не найден.' } });
    }
    res.setHeader('Content-Type', contentType(abs));
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // V3120_FIX (M6) — не картинка и не PDF — только «скачать», под своим
    // именем, и без права исполняться, даже если браузер откроет его сам.
    if (!INLINE_EXT.has(path.extname(abs).toLowerCase())) {
      const name = path.basename(abs);
      const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
      res.setHeader('Content-Disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`);
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    }
    fs.createReadStream(abs).pipe(res);
  });

  // Best-effort delete.
  r.delete('/:bucket/*rest', (req, res) => {
    // LICENCE_CORE_V1 — deleting a stored file is a write, same as DELETE
    // /api/db; a lapsed clinic keeps read access to everything already there.
    if (req.control?.locked) return lockedResponse(res, req.control);
    const abs = safeResolve(storageDir, req.params.bucket, req.params.rest);
    if (!abs) return badPath(res);
    // CLINIC_PROFILE_V1 — логотип не удаляется (Р7): восстановление копии
    // откатывает строки, а файлы только сливает — вчерашняя ссылка обязана открыться.
    if (req.params.bucket === LOGO_BUCKET) return refuse(res, 403, 'forbidden', LOGO_NO_DELETE);
    // PATIENT_FILE_ATTACH_V1 — ДОКУМЕНТ ПАЦИЕНТА НЕ УДАЛЯЕТСЯ, он отзывается
    // (rpc patient_card_doc_void, миграция 105). Раньше карта звала этот
    // маршрут сразу после удаления строки, и файл исчезал безвозвратно — при
    // том, что весь остальной продукт клинические записи гасит, а не стирает
    // (отметки медсестры — voided_at, счета — 'void'). Отказ здесь нужен и
    // после того, как карту поправили: маршрут открыт curl'ом.
    if (underPatients(req.params.bucket, req.params.rest)) {   // V3120_FIX (M7) — любое место под patients/
      return refuse(res, 403, 'forbidden',
        'Документ пациента не удаляется — его можно только отозвать в карте пациента.');
    }
    // PATIENT_PHOTO_V1 — НОВОЕ ФОТО ЗАМЕНЯЕТ СТАРОЕ, НО НЕ СТИРАЕТ ЕГО.
    //
    // Заменить фотографию — это переписать одну колонку (patients.photo_url,
    // users.photo_url). Прежний файл после этого никем не показывается, и
    // соблазн удалить его понятен. Не удаляем, по трём причинам подряд:
    //
    //  1. На него ЕЩЁ МОЖЕТ УКАЗЫВАТЬ база. Восстановление копии откатывает
    //     строки на вчера, а файлы только СЛИВАЕТ (services/backup.js
    //     mergeTree) — вчерашний photo_url обязан открыться. Удаляя файл
    //     сегодня, мы готовим битый квадрат вместо лица на любом откате.
    //  2. Место больше не довод. Раньше он был бы весомым — исходник с
    //     телефона 5–12 МБ; после уменьшения портрет весит 100–250 КБ, и
    //     «сэкономить», стерев предшественника, значит сэкономить четверть
    //     мегабайта ценой пункта 1.
    //  3. Так поступает весь остальной продукт: отметку медсестры гасят, счёт
    //     аннулируют, документ пациента отзывают (см. отказ выше). Фотография
    //     пациента — часть его анкеты, то есть запись о человеке; лицо,
    //     стёртое без следа, — ровно то, чего это правило не допускает.
    //
    // Фото врача заодно: своё он МЕНЯЕТ (загрузив новое), а не удаляет, — в
    // «Моём профиле» кнопки «убрать фото» нет, и пустая карточка на Symptex
    // не лучше устаревшего снимка.
    if (isPhotoBucket(req.params.bucket)) {
      return refuse(res, 403, 'forbidden',
        'Фотография не удаляется — новая загрузка заменяет прежнюю.');
    }
    // V3120_FINAL (I2) — удаление закрыто тем же замком, что и загрузка:
    // вложения Telegram — отвечающему в чате или настраивающему бота; файлы
    // клиники — администратору или «Настройкам» на изменение.
    if (req.params.bucket === 'telegram-media') {
      const denial = telegramDenial(req, { write: true });
      if (denial) return refuse(res, 403, 'forbidden', denial);
    }
    if (req.params.bucket === 'clinic-docs') {
      const denial = clinicFilesDenial(req);
      if (denial) return refuse(res, 403, 'forbidden', denial);
    }
    try { fs.unlinkSync(abs); } catch { /* already gone */ }
    return res.json({ data: {} });
  });

  return r;
}
