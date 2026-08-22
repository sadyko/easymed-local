// TELEGRAM_BROADCAST_V1 — статистика бота и рассылка сообщений пациентам.
//
// Аудитория рассылки ограничена не нашим решением, а Telegram: бот может
// написать только тому, кто САМ его открыл. Поэтому «все пациенты клиники» —
// недостижимое множество в принципе, и получатели всегда берутся из
// telegram_links, а фильтры лишь сужают их.

import { sendMessage, sendPhoto, photoFileId, TelegramError } from './api.js';
import { findPatientsByPhone } from './documents.js';
import { logMessage } from './flow.js';
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
  const cards = new Set();
  for (const l of active) for (const p of findPatientsByPhone(db, l.phone)) cards.add(p.id);

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
export function resolveAudience(db, filters = {}) {
  const links = db.prepare(
    'SELECT * FROM telegram_links WHERE revoked_at IS NULL AND blocked_at IS NULL ORDER BY id').all();

  const out = [];
  for (const link of links) {
    const patients = findPatientsByPhone(db, link.phone);
    const matching = patients.filter((p) => matchesFilters(db, p.id, filters));
    if (matching.length) out.push({ link, patients: matching });
  }
  return out;
}

function matchesFilters(db, patientId, f) {
  const noFilters = !f || (!f.visited_from && !f.visited_to && !f.unpaid && !f.doctor_id);
  if (noFilters) return true;

  if (f.visited_from || f.visited_to) {
    const from = f.visited_from || '0000-01-01';
    const to = f.visited_to || '9999-12-31';
    const n = db.prepare(
      'SELECT COUNT(*) c FROM visits WHERE patient_id = ? AND visit_date BETWEEN ? AND ?')
      .get(patientId, from, to).c;
    if (!n) return false;
  }

  if (f.doctor_id) {
    const n = db.prepare('SELECT COUNT(*) c FROM visits WHERE patient_id = ? AND doctor_id = ?')
      .get(patientId, Number(f.doctor_id)).c;
    if (!n) return false;
  }

  if (f.unpaid) {
    // Долг — это невыкупленный счёт: статус unpaid/debt либо оплачено меньше
    // суммы. Аннулированные (void) в долг не считаются.
    const n = db.prepare(
      `SELECT COUNT(*) c FROM invoices
        WHERE patient_id = ? AND status <> 'void'
          AND (status IN ('unpaid','debt') OR COALESCE(paid_amount,0) < COALESCE(total_amount,0))`)
      .get(patientId).c;
    if (!n) return false;
  }
  return true;
}

// Предпросмотр: точное число получателей и несколько имён — чтобы человек
// увидел, кому это уйдёт, ДО отправки, а не после.
export function previewAudience(db, filters = {}, sampleSize = 8) {
  const audience = resolveAudience(db, filters);
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
export function startBroadcast(db, token, { textRu, textUz = '', filters = {}, userId = null, imagePath = null }, deps = {}) {
  const text = composeText(textRu, textUz);
  if (!text) throw new Error('Пустое сообщение не рассылается.');

  // Картинку читаем ДО вставки строки и до первой отправки: если файл пропал,
  // честнее отказать сразу, чем разослать половине пациентов голый текст,
  // который администратор задумывал как баннер с подписью.
  const image = imagePath ? readBroadcastImage(imagePath) : null;
  if (imagePath && !image) throw new Error('Картинка не найдена на диске — загрузите её заново.');

  const audience = resolveAudience(db, filters);
  const bc = db.prepare(
    `INSERT INTO telegram_broadcasts (text_ru, text_uz, filters, audience_count, created_by, image_path)
     VALUES (?,?,?,?,?,?) RETURNING id`)
    .get(String(textRu || ''), String(textUz || ''), JSON.stringify(filters || {}), audience.length, userId,
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
