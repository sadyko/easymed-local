// TELEGRAM_BROADCAST_V1 — статистика бота и рассылка сообщений пациентам.
//
// Аудитория рассылки ограничена не нашим решением, а Telegram: бот может
// написать только тому, кто САМ его открыл. Поэтому «все пациенты клиники» —
// недостижимое множество в принципе, и получатели всегда берутся из
// telegram_links, а фильтры лишь сужают их.

import { sendMessage, sendPhoto, photoFileId, TelegramError } from './api.js';
import { logMessage } from './flow.js';
// FIX_318_V1 (H2) — то же правило «тот же номер», что findPatientsByPhone
// (documents.js): местные цифры номера связки подряд в цифрах номера карты.
import { digitsOf, uzLocalDigits, MIN_PHONE_DIGITS } from '../../../public/js/admin/views/crm-phone-match.js';
import { localDate } from '../domain/day.js';   // FIX_318_V1 (M4) — дата визита — местный день
import { readMedia } from './media.js';   // TELEGRAM_MEDIA_V1
// TELEGRAM_CHAT_FILE_V1 — лимит подписи к файлу общий с перепиской, а не
// вторая его копия здесь.
import { CAPTION_LIMIT } from '../../../public/js/shared/chat-attachment.js';

// Telegram душит рассылки примерно с 30 сообщений в секунду. Держимся ниже:
// потерянное сообщение дороже лишней секунды.
const SEND_INTERVAL_MS = 50;
const COVERAGE_WINDOW_DAYS = 90;

// TELEGRAM_BROADCAST_IMG_V1 — подпись к картинке ограничена 1024 символами,
// тогда как у обычного сообщения лимит 4096. Русский и узбекский тексты
// склеиваются, поэтому в подпись они помещаются далеко не всегда. Молча
// обрезать сообщение клиники пациентам НЕЛЬЗЯ: если текст длиннее — картинка
// уходит первой, а текст следом отдельным сообщением, целиком.


// TELEGRAM_MEDIA_V1 — проверка пути и чтение с диска вынесены в media.js:
// той же корзиной telegram-media пользуется вложение оператора в переписке
// (chat.js), и вторая копия проверки обхода каталога разошлась бы с этой.
// Имя сохранено — под ним функция известна тестам и рассылке.
export const readBroadcastImage = readMedia;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Статистика: подключения и охват
// ---------------------------------------------------------------------------
export function botStats(db) {
  const links = db.prepare('SELECT * FROM telegram_links').all();
  const active = links.filter((l) => !l.revoked_at && !l.blocked_at);

  // Сколько КАРТ открывают активные связки. Число больше количества чатов:
  // один номер — это часто вся семья, и администратор должен видеть именно
  // столько карт, сколько реально доступно через бота.
  // FIX_318_V1 (H2) — один проход картотеки на все связки (patientsByLinkPhone).
  const cards = new Set();
  for (const list of patientsByLinkPhone(db, active)) for (const p of list) cards.add(p.id);

  // Охват считаем от пациентов, которые ЛЕЧАТСЯ, а не от всего архива: в базе
  // почти 70 000 карт, и охват «от всех» навсегда остался бы околонулевым и
  // ничего бы не говорил.
  const recent = db.prepare(
    `SELECT COUNT(DISTINCT patient_id) c FROM visits
      WHERE visit_date >= date('now', ?)`).get(`-${COVERAGE_WINDOW_DAYS} days`).c;
  const recentConnected = db.prepare(
    `SELECT COUNT(DISTINCT v.patient_id) c FROM visits v
      WHERE v.visit_date >= date('now', ?) AND v.patient_id IN (${
        cards.size ? [...cards].join(',') : 'NULL'})`).get(`-${COVERAGE_WINDOW_DAYS} days`).c;

  // Подключения по неделям — видно, работает ли продвижение на стойке.
  const weekly = db.prepare(
    `SELECT strftime('%Y-%W', linked_at) AS week, COUNT(*) c
       FROM telegram_links
      WHERE linked_at >= date('now','-56 days')
      GROUP BY week ORDER BY week`).all();

  // Подключения по ДНЯМ за последний месяц — «какой темп сейчас», вопрос
  // владельца рядом с недельным «работает ли продвижение вообще». Считаются
  // ПОДКЛЮЧЕНИЯ (строки), не уникальные номера, и отозванные не вычитаются:
  // связка после «Отвязать» и повторное подключение — это дважды сработавшая
  // стойка, а история выдач у отозванной строки и так остаётся (см. схему
  // telegram_links). -29, а не -30: вместе с сегодняшним днём окно — ровно 30
  // календарных дней.
  const daily30 = db.prepare(
    `SELECT date(linked_at) AS day, COUNT(*) c
       FROM telegram_links
      WHERE linked_at >= date('now','-29 days')
      GROUP BY day ORDER BY day`).all();

  return {
    chats_active: active.length,
    chats_revoked: links.filter((l) => l.revoked_at).length,
    chats_blocked: links.filter((l) => l.blocked_at && !l.revoked_at).length,
    cards_reachable: cards.size,
    recent_patients: recent,
    recent_connected: recentConnected,
    coverage_pct: recent ? Math.round((recentConnected / recent) * 100) : 0,
    coverage_window_days: COVERAGE_WINDOW_DAYS,
    weekly,
    daily_30d: daily30,
    started_30d: daily30.reduce((n, d) => n + d.c, 0),
    documents_sent: db.prepare("SELECT COUNT(*) c FROM telegram_deliveries WHERE status='sent'").get().c,
  };
}

// ---------------------------------------------------------------------------
// Отбор получателей
// ---------------------------------------------------------------------------
//
// Возвращает [{link, patients}] — связки, у которых ХОТЯ БЫ ОДИН пациент
// проходит фильтр. Заблокировавшие бота и отвязанные исключены всегда.
//
// FIX_318_V1 (H2, ревью 3.18.0) — ЖИВОЙ СЧЁТЧИК МОРОЗИЛ СЕРВЕР. Здесь на
// каждую связку звался findPatientsByPhone — полный проход картотеки по
// LIKE '%9%9%…' (индекс не помогает), а на каждую карту — до десятка запросов
// фильтров. 20 000 карт и 1 000 чатов — 8 с, 50 000 и 2 000 — 24–30 с, и всё это
// синхронно: сервер клиники стоял на каждом открытии окна, каждом фильтре и
// дважды на отправке. Теперь:
//   * номер → карты — ОДНИМ проходом картотеки на все связки
//     (patientsByLinkPhone), по тому же правилу, что findPatientsByPhone;
//   * фильтры — одним запросом с параметрами по множеству найденных карт
//     (passingPatientIds), а не запросами на каждую карту;
//   * отправка берёт уже посчитанную аудиторию (startBroadcast { audience }),
//     а живой счётчик экрана — короткий кэш (previewAudience { cache }).
export function resolveAudience(db, filters = {}) {
  const f = normalizeFilters(filters);
  const links = db.prepare(
    'SELECT * FROM telegram_links WHERE revoked_at IS NULL AND blocked_at IS NULL ORDER BY id').all();

  const perLink = patientsByLinkPhone(db, links);
  const ids = new Set();
  for (const list of perLink) for (const p of list) ids.add(Number(p.id));
  const pass = Object.keys(f).length ? passingPatientIds(db, [...ids], f) : null;

  const out = [];
  links.forEach((link, i) => {
    const matching = pass ? perLink[i].filter((p) => pass.has(Number(p.id))) : perLink[i];
    if (matching.length) out.push({ link, patients: matching });
  });
  return out;
}

// FIX_318_V1 (H2) — НОМЕР СВЯЗКИ → КАРТЫ, одним проходом картотеки.
//
// Правило — ровно findPatientsByPhone (documents.js), которым бот выдаёт
// документы: номер связки короче MIN_PHONE_DIGITS цифр не ищет никого; иначе
// карта подходит, если её цифры СОДЕРЖАТ ПОДРЯД местные цифры номера
// (uzLocalDigits: без 998 и ведущего 0 — полный номер их тоже содержит);
// порядок — активные карты первыми, затем новые; не больше `limit` на номер.
// Вместо LIKE на каждую связку — один SELECT карт с телефоном и поиск каждой
// подстроки нужной длины в словаре номеров связок.
const CARDS_PER_NUMBER = 20;
export function patientsByLinkPhone(db, links, limit = CARDS_PER_NUMBER) {
  const out = links.map(() => []);
  const byKey = new Map();   // местные цифры → номера связок в links
  links.forEach((l, i) => {
    const d = digitsOf(l && l.phone);
    if (d.length < MIN_PHONE_DIGITS) return;
    const key = uzLocalDigits(d);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(i);
  });
  if (!byKey.size) return out;
  const lengths = [...new Set([...byKey.keys()].map((k) => k.length))];
  const rows = db.prepare(
    `SELECT id, full_name, mrn, phone, date_of_birth, gender, active
       FROM patients WHERE phone <> ''`).all();
  for (const p of rows) {
    const sf = digitsOf(p.phone);
    let hits = null;
    for (const len of lengths) {
      for (let i = 0; i + len <= sf.length; i++) {
        const key = sf.substr(i, len);
        if (byKey.has(key)) (hits || (hits = new Set())).add(key);
      }
    }
    if (!hits) continue;
    for (const key of hits) for (const li of byKey.get(key)) out[li].push(p);
  }
  const rank = (p) => (p.active === 1 ? 1 : 0);
  for (const list of out) {
    list.sort((a, b) => rank(b) - rank(a) || Number(b.id) - Number(a.id));
    if (list.length > limit) list.length = limit;
  }
  return out;
}

// TG_BROADCAST_FILTERS_V1 (2026-10-17, владелец: «make the pop up wide and to
// the right side put detailed filters») — СЛОВАРЬ ФИЛЬТРОВ ЗАКРЫТ. Фильтры
// приходят из браузера как есть и попадают в SQL параметрами, но ключ вне
// словаря или мусор в значении молча отбрасываются: лучше чуть более широкая
// рассылка, которую видно в предпросмотре числом, чем 500 на «мусор в поле».
// Ровно этот же нормализованный вид сохраняется в telegram_broadcasts.filters.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const GENDERS = new Set(['male', 'female', 'other']);
export function normalizeFilters(filters) {
  const src = filters && typeof filters === 'object' ? filters : {};
  const out = {};
  const posInt = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };
  for (const k of ['doctor_id', 'category_id', 'branch_id', 'service_id', 'service_type_id']) {
    const n = posInt(src[k]);
    if (n) out[k] = n;
  }
  for (const k of ['visited_from', 'visited_to', 'not_visited_since']) {
    const v = String(src[k] == null ? '' : src[k]).trim();
    if (DATE_RE.test(v)) out[k] = v;
  }
  const g = String(src.gender == null ? '' : src.gender).trim().toLowerCase();
  if (GENDERS.has(g)) out.gender = g;
  for (const k of ['age_from', 'age_to']) {
    if (src[k] === '' || src[k] == null) continue;
    const n = Number(src[k]);
    if (Number.isInteger(n) && n >= 0 && n <= 130) out[k] = n;
  }
  if (src.unpaid === true || src.unpaid === 1 || src.unpaid === '1' || src.unpaid === 'true') out.unpaid = true;
  return out;
}

// Полных лет на сегодня; null — даты рождения нет или она не читается.
function ageYears(dob) {
  const t = Date.parse(String(dob || ''));
  if (!Number.isFinite(t)) return null;
  const d = new Date(t), now = new Date();
  let age = now.getUTCFullYear() - d.getUTCFullYear();
  const m = now.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < d.getUTCDate())) age -= 1;
  return age >= 0 ? age : null;
}

// Каждый фильтр — своё условие, все вместе — пересечение. Пациент без даты
// рождения в выборку по возрасту не попадает: «не знаем» — не «подходит».
//
// FIX_318_V1 (H2) — одним запросом по множеству карт (json_each), все значения —
// параметрами; прежде — до десятка запросов на КАЖДУЮ карту.
// FIX_318_V1 (M4, ревью 3.18.0) — приход — это визит, который не отменили и на
// который пришли или ещё придут: отменённый и «не пришёл» (LIVE_VISIT) не
// считаются ни для «Приходил с», врача, услуги, типа и филиала, ни против «Не
// приходил с». Даты фильтров — местные дни, и визит сравнивается своим местным
// днём (localDate): строка UTC «2026-08-31T06:00:00Z» больше «2026-08-31», и
// визит в день «по» выпадал. Услуга — строкой визита, если её не убрали.
const LIVE_VISIT = "COALESCE(v.status, '') NOT IN ('cancelled', 'no_show')";
const LIVE_LINE = "COALESCE(vs.status, '') NOT IN ('cancelled', 'removed')";
function passingPatientIds(db, ids, f) {
  const out = new Set();
  if (!ids.length) return out;
  const where = [];
  const params = { ids: JSON.stringify(ids) };
  const visitDay = localDate('v.visit_date');
  const liveVisit = (cond) => `EXISTS (SELECT 1 FROM visits v WHERE v.patient_id = p.id AND ${LIVE_VISIT} AND ${cond})`;

  if (f.visited_from || f.visited_to) {
    params.vfrom = f.visited_from || '0000-01-01';
    params.vto = f.visited_to || '9999-12-31';
    where.push(liveVisit(`${visitDay} BETWEEN @vfrom AND @vto`));
  }
  // «Не приходил с даты»: ни одного визита начиная с неё — и те, кто не был никогда, тоже подходят.
  if (f.not_visited_since) {
    params.nvs = f.not_visited_since;
    where.push('NOT ' + liveVisit(`${visitDay} >= @nvs`));
  }
  if (f.doctor_id) { params.doctor = f.doctor_id; where.push(liveVisit('v.doctor_id = @doctor')); }
  if (f.gender) { params.gender = f.gender; where.push('p.gender = @gender'); }
  if (f.category_id) { params.category = f.category_id; where.push('p.category_id = @category'); }
  // Филиал — где пациент заведён или где он хоть раз был.
  if (f.branch_id) { params.branch = f.branch_id; where.push(`(p.branch_id = @branch OR ${liveVisit('v.branch_id = @branch')})`); }
  // Услуга — строкой визита (visit_services) или услугой самого визита.
  if (f.service_id) {
    params.service = f.service_id;
    where.push(liveVisit(`(v.service_id = @service
      OR EXISTS (SELECT 1 FROM visit_services vs WHERE vs.visit_id = v.id AND vs.service_id = @service AND ${LIVE_LINE}))`));
  }
  if (f.service_type_id) {
    params.stype = f.service_type_id;
    where.push(liveVisit(`(EXISTS (SELECT 1 FROM services s0 WHERE s0.id = v.service_id AND s0.type_id = @stype)
      OR EXISTS (SELECT 1 FROM visit_services vs JOIN services s ON s.id = vs.service_id
                  WHERE vs.visit_id = v.id AND s.type_id = @stype AND ${LIVE_LINE}))`));
  }
  if (f.unpaid) {
    // Долг — это невыкупленный счёт: статус unpaid/debt либо оплачено меньше
    // суммы. Аннулированные (void) в долг не считаются.
    where.push(`EXISTS (SELECT 1 FROM invoices i WHERE i.patient_id = p.id AND i.status <> 'void'
      AND (i.status IN ('unpaid','debt') OR COALESCE(i.paid_amount,0) < COALESCE(i.total_amount,0)))`);
  }
  const rows = db.prepare(`SELECT p.id, p.date_of_birth FROM patients p
                            WHERE p.id IN (SELECT value FROM json_each(@ids))
                              ${where.map((w) => 'AND ' + w).join('\n')}`).all(params);
  const byAge = f.age_from != null || f.age_to != null;
  for (const r of rows) {
    if (byAge) {
      const age = ageYears(r.date_of_birth);
      if (age == null) continue;
      if (f.age_from != null && age < f.age_from) continue;
      if (f.age_to != null && age > f.age_to) continue;
    }
    out.add(Number(r.id));
  }
  return out;
}

// TG_BROADCAST_FILTERS_V1 — справочники для выпадающих списков окна рассылки,
// одним вызовом: врачи, категории пациентов, филиалы, типы услуг и услуги.
// Каждый список терпим к базе без таблицы (пусто, не 500) — окно обязано
// открыться и без них.
export function broadcastOptions(db) {
  const q = (sql) => { try { return db.prepare(sql).all().map((r) => ({ ...r })); } catch { return []; } };
  return {
    doctors: q('SELECT id, full_name, specialty FROM users WHERE is_doctor = 1 AND COALESCE(is_active, 1) = 1 ORDER BY full_name'),
    categories: q('SELECT id, name FROM patient_categories WHERE COALESCE(active, 1) = 1 ORDER BY name'),
    branches: q('SELECT id, name FROM branches WHERE COALESCE(active, 1) = 1 ORDER BY id'),
    service_types: q('SELECT id, name FROM service_types WHERE COALESCE(active, 1) = 1 ORDER BY id'),
    services: q('SELECT id, name, type_id FROM services WHERE COALESCE(active, 1) = 1 ORDER BY name'),
  };
}

// FIX_318_V1 (H2) — КОРОТКИЙ КЭШ ЖИВОГО СЧЁТЧИКА. Окно рассылки пересчитывает
// получателей на каждый фильтр (с задержкой), а «Отправить» спрашивает число
// ещё раз; одинаковый набор фильтров за несколько секунд — один расчёт. Кэш —
// только для предпросмотра с { cache: true } (RPC живого счётчика): отбор для
// отправки (resolveAudience) и число, которое подтверждает администратор
// (fresh), считаются всегда заново. Ключ — нормализованные фильтры, у каждой
// базы свой кэш.
export const AUDIENCE_CACHE_MS = 10_000;
const audienceCache = new WeakMap();
export function clearAudienceCache(db) { audienceCache.delete(db); }
function cachedAudience(db, filters, now = Date.now()) {
  const key = JSON.stringify(normalizeFilters(filters));
  let byKey = audienceCache.get(db);
  if (!byKey) { byKey = new Map(); audienceCache.set(db, byKey); }
  const hit = byKey.get(key);
  if (hit && now - hit.at < AUDIENCE_CACHE_MS) return hit.audience;
  for (const [k, v] of byKey) if (now - v.at >= AUDIENCE_CACHE_MS) byKey.delete(k);
  const audience = resolveAudience(db, filters);
  byKey.set(key, { at: now, audience });
  return audience;
}

// Предпросмотр: точное число получателей и несколько имён — чтобы человек
// увидел, кому это уйдёт, ДО отправки, а не после.
export function previewAudience(db, filters = {}, sampleSize = 8, { cache = false } = {}) {
  const audience = cache ? cachedAudience(db, filters) : resolveAudience(db, filters);
  return {
    count: audience.length,
    cards: audience.reduce((n, a) => n + a.patients.length, 0),
    sample: audience.slice(0, sampleSize).map((a) => ({
      name: a.patients.map((p) => p.full_name).join(', '),
      tg: a.link.tg_name || a.link.tg_username || '',
    })),
  };
}

// ---------------------------------------------------------------------------
// Отправка
// ---------------------------------------------------------------------------
export function composeText(textRu, textUz) {
  const ru = String(textRu || '').trim();
  const uz = String(textUz || '').trim();
  return uz ? `${ru}\n\n${uz}` : ru;
}

// Запускает рассылку и возвращает её id СРАЗУ: сотня получателей — это
// несколько секунд, и держать всё это время открытым HTTP-запрос незачем.
// Ход выполнения читается из строки telegram_broadcasts.
// FIX_318_V1 (H2) — audience: отбор, уже посчитанный вызывающим (RPC отправки
// сверяет по нему подтверждённое число) — второй раз его не считаем.
export function startBroadcast(db, token, { textRu, textUz = '', filters = {}, userId = null, imagePath = null, audience: given = null }, deps = {}) {
  const text = composeText(textRu, textUz);
  if (!text) throw new Error('Пустое сообщение не рассылается.');

  // Картинку читаем ДО вставки строки и до первой отправки: если файл пропал,
  // честнее отказать сразу, чем разослать половине пациентов голый текст,
  // который администратор задумывал как баннер с подписью.
  const image = imagePath ? readBroadcastImage(imagePath) : null;
  if (imagePath && !image) throw new Error('Картинка не найдена на диске — загрузите её заново.');

  const audience = Array.isArray(given) ? given : resolveAudience(db, filters);
  const bc = db.prepare(
    `INSERT INTO telegram_broadcasts (text_ru, text_uz, filters, audience_count, created_by, image_path)
     VALUES (?,?,?,?,?,?) RETURNING id`)
    .get(String(textRu || ''), String(textUz || ''), JSON.stringify(normalizeFilters(filters)), audience.length, userId,
         imagePath || null);

  const addTarget = db.prepare(
    'INSERT OR IGNORE INTO telegram_broadcast_targets (broadcast_id, chat_id) VALUES (?,?)');
  for (const a of audience) addTarget.run(bc.id, a.link.chat_id);

  // Сама отправка — вне HTTP-запроса. Ошибки внутрь не пускаем: рассылка не
  // должна ронять сервер.
  runBroadcast(db, token, bc.id, text, deps, image).catch((e) => {
    console.warn('[telegram] broadcast', bc.id, 'failed:', (e && e.message) || e);
    try {
      db.prepare("UPDATE telegram_broadcasts SET status='failed', finished_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?").run(bc.id);
    } catch { /* база уже закрыта */ }
  });

  return { id: bc.id, audience_count: audience.length };
}

export async function runBroadcast(db, token, broadcastId, text, deps = {}, image = null) {
  const targets = db.prepare(
    "SELECT * FROM telegram_broadcast_targets WHERE broadcast_id = ? AND status = 'pending'").all(broadcastId);

  // Текст помещается в подпись — значит уходит ОДНИМ сообщением с картинкой.
  // Не помещается — картинка, следом текст: обрезать нельзя (см. CAPTION_LIMIT).
  const asCaption = !!image && text.length <= CAPTION_LIMIT;
  // file_id первой успешной загрузки. Дальше все получатели получают картинку
  // по нему, без повторной заливки тех же байтов.
  let fileId = null;

  let sent = 0, failed = 0;
  for (const t of targets) {
    try {
      let res;
      if (!image) {
        res = await sendMessage(token, t.chat_id, text, {}, deps);
      } else {
        const photoRes = await sendPhoto(token, t.chat_id, fileId || image.buffer, {
          caption: asCaption ? text : '', filename: image.filename, ...deps,
        });
        if (!fileId) fileId = photoFileId(photoRes);
        // Ответом считаем ТЕКСТОВОЕ сообщение, если оно было: именно его
        // message_id связывает ленту переписки с тем, что прочитал пациент.
        res = asCaption ? photoRes : await sendMessage(token, t.chat_id, text, {}, deps);
      }
      db.prepare("UPDATE telegram_broadcast_targets SET status='sent', sent_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?").run(t.id);
      // Рассылка ложится в ленту переписки: сотрудник, открывший чат, должен
      // видеть, что пациенту уже писала клиника, — иначе он ответит на вопрос,
      // на который час назад ответила рассылка. Картинку помечаем в тексте:
      // в ленте она не показывается, а знать о ней сотруднику нужно.
      logMessage(db, t.chat_id, 'out', (image ? '🖼 ' : '') + text,
        { kind: 'broadcast', tgMessageId: res && res.message_id });
      sent++;
    } catch (e) {
      // 403 — пациент заблокировал бота. Это не сбой отправки, а его решение:
      // помечаем связку и больше не беспокоим ни этой, ни следующей рассылкой.
      const blocked = e instanceof TelegramError && e.status === 403;
      db.prepare('UPDATE telegram_broadcast_targets SET status=?, error=? WHERE id=?')
        .run(blocked ? 'blocked' : 'failed', String((e && e.message) || e).slice(0, 300), t.id);
      if (blocked) {
        db.prepare(`UPDATE telegram_links SET blocked_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
                     WHERE chat_id = ? AND blocked_at IS NULL`).run(t.chat_id);
      }
      failed++;
    }
    db.prepare('UPDATE telegram_broadcasts SET sent_count=?, failed_count=? WHERE id=?').run(sent, failed, broadcastId);
    if (SEND_INTERVAL_MS) await sleep(SEND_INTERVAL_MS);
  }

  db.prepare(`UPDATE telegram_broadcasts SET status='done', sent_count=?, failed_count=?,
              finished_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?`).run(sent, failed, broadcastId);
  return { sent, failed };
}

export function broadcastStatus(db, id) {
  const bc = db.prepare('SELECT * FROM telegram_broadcasts WHERE id = ?').get(Number(id));
  if (!bc) return null;
  return {
    ...bc,
    blocked_count: db.prepare("SELECT COUNT(*) c FROM telegram_broadcast_targets WHERE broadcast_id=? AND status='blocked'").get(bc.id).c,
  };
}

export function broadcastHistory(db, limit = 20) {
  return db.prepare(
    `SELECT b.*, u.full_name AS author FROM telegram_broadcasts b
       LEFT JOIN users u ON u.id = b.created_by
      ORDER BY b.created_at DESC LIMIT ?`).all(Math.min(Math.max(Number(limit) || 20, 1), 100));
}

export { SEND_INTERVAL_MS, COVERAGE_WINDOW_DAYS };
