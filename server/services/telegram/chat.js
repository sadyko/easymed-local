// TELEGRAM_CHAT_V1 — переписка с пациентами для раздела «Чат с пациентами».
//
// Читать переписку и отвечать в неё — разные права: чтение показывает, что
// пациент написал, а ответ уходит от имени КЛИНИКИ. Поэтому уровень доступа
// разделён (viewer читает, editor отвечает), а решает его вызывающий RPC.

import { sendMessage, sendDocument, sendPhoto } from './api.js';
// TELEGRAM_CHAT_FILE_V1 — правила вложения общие с браузером (см. модуль).
import { isImageName, safeAttachmentName, attachmentError,
         CAPTION_LIMIT } from '../../../public/js/shared/chat-attachment.js';
import { readMedia } from './media.js';
import { findPatientsByPhone } from './documents.js';
// TELEGRAM_ORPHAN_CHAT_V1 — те же правила разбора номера, что у CRM и у бота:
// «тот же номер» должно значить одно и то же во всех трёх местах.
import { digitsOf, MIN_PHONE_DIGITS } from '../../../public/js/admin/views/crm-phone-match.js';
import { logMessage } from './flow.js';

// ---------------------------------------------------------------------------
// Папки чатов
// ---------------------------------------------------------------------------
// «Все» и «Непрочитанные» здесь не заводятся: это не папки, а вычисляемые
// наборы, и хранить их — значит однажды разойтись с реальностью. В базе живут
// только группы, которые придумала клиника.
export function listFolders(db) {
  const folders = db.prepare(
    'SELECT * FROM telegram_chat_folders ORDER BY sort_order, id').all();
  const counts = db.prepare(
    'SELECT folder_id, COUNT(*) c FROM telegram_chat_folder_items GROUP BY folder_id').all();
  const byId = new Map(counts.map((r) => [r.folder_id, r.c]));
  return folders.map((f) => ({ id: f.id, name: f.name, sort_order: f.sort_order, count: byId.get(f.id) || 0 }));
}

export function createFolder(db, name, userId = null) {
  const clean = String(name || '').trim().slice(0, 40);
  if (!clean) throw new Error('Название папки не может быть пустым.');
  const dup = db.prepare('SELECT 1 FROM telegram_chat_folders WHERE name = ?').get(clean);
  if (dup) throw new Error('Папка с таким названием уже есть.');
  const next = db.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM telegram_chat_folders').get().n;
  const row = db.prepare(
    'INSERT INTO telegram_chat_folders (name, sort_order, created_by) VALUES (?,?,?) RETURNING id').get(clean, next, userId);
  return { id: row.id, name: clean };
}

export function renameFolder(db, id, name) {
  const clean = String(name || '').trim().slice(0, 40);
  if (!clean) throw new Error('Название папки не может быть пустым.');
  const dup = db.prepare('SELECT 1 FROM telegram_chat_folders WHERE name = ? AND id <> ?').get(clean, Number(id));
  if (dup) throw new Error('Папка с таким названием уже есть.');
  db.prepare('UPDATE telegram_chat_folders SET name = ? WHERE id = ?').run(clean, Number(id));
  return { ok: true };
}

// Удаляем папку вместе с её составом, но НЕ трогая чаты: папка — это ярлык,
// а не место хранения. Пациент, лежавший в «Долгах», никуда не девается.
export function deleteFolder(db, id) {
  const fid = Number(id);
  db.prepare('DELETE FROM telegram_chat_folder_items WHERE folder_id = ?').run(fid);
  db.prepare('DELETE FROM telegram_chat_folders WHERE id = ?').run(fid);
  return { ok: true };
}

export function setChatFolder(db, folderId, chatId, member, userId = null) {
  const fid = Number(folderId);
  if (!db.prepare('SELECT 1 FROM telegram_chat_folders WHERE id = ?').get(fid)) {
    throw new Error('Папка не найдена.');
  }
  if (member) {
    db.prepare(
      'INSERT OR IGNORE INTO telegram_chat_folder_items (folder_id, chat_id, added_by) VALUES (?,?,?)')
      .run(fid, String(chatId), userId);
  } else {
    db.prepare('DELETE FROM telegram_chat_folder_items WHERE folder_id = ? AND chat_id = ?')
      .run(fid, String(chatId));
  }
  return { ok: true };
}

// Список чатов для левой колонки: последнее сообщение, счётчик непрочитанных,
// и кто это вообще — имя из Telegram плюс карты пациентов на его номере.
export function listChats(db, { limit = 100 } = {}) {
  const links = db.prepare(
    'SELECT * FROM telegram_links WHERE revoked_at IS NULL ORDER BY id DESC LIMIT ?').all(Math.min(limit, 300));

  const lastMsg = db.prepare(
    'SELECT text, direction, kind, created_at FROM telegram_messages WHERE chat_id = ? ORDER BY id DESC LIMIT 1');
  const unread = db.prepare(
    "SELECT COUNT(*) c FROM telegram_messages WHERE chat_id = ? AND direction = 'in' AND read_at IS NULL");

  // Принадлежность к папкам — одним запросом на весь список: спрашивать её
  // отдельно на каждый чат значит N запросов там, где хватает одного.
  const folderRows = db.prepare('SELECT folder_id, chat_id FROM telegram_chat_folder_items').all();
  const foldersByChat = new Map();
  for (const r of folderRows) {
    if (!foldersByChat.has(r.chat_id)) foldersByChat.set(r.chat_id, []);
    foldersByChat.get(r.chat_id).push(r.folder_id);
  }

  const rows = links.map((l) => {
    const last = lastMsg.get(l.chat_id);
    return {
      folders: foldersByChat.get(l.chat_id) || [],
      chat_id: l.chat_id,
      tg_name: l.tg_name || '',
      tg_username: l.tg_username || '',
      tg_user_id: l.tg_user_id || '',
      phone: l.phone,
      blocked: !!l.blocked_at,
      patients: findPatientsByPhone(db, l.phone).map((p) => ({ id: p.id, name: p.full_name, mrn: p.mrn })),
      last_text: last ? last.text : '',
      last_direction: last ? last.direction : '',
      last_at: last ? last.created_at : l.linked_at,
      unread: unread.get(l.chat_id).c,
    };
  });

  // Сверху — те, кто написал последними: сотрудник открывает раздел, чтобы
  // ответить на новое, а не листать архив.
  rows.sort((a, b) => String(b.last_at || '').localeCompare(String(a.last_at || '')));
  // TELEGRAM_ORPHAN_CHAT_V1 — к связанным чатам добавляем «ничьи»: они тоже
  // ждут ответа, и их непрочитанные всё равно попадают в бейдж.
  return rows.concat(orphanChats(db, limit));
}

export function chatMessages(db, chatId, { limit = 200 } = {}) {
  const link = db.prepare('SELECT * FROM telegram_links WHERE chat_id = ? ORDER BY id DESC LIMIT 1').get(String(chatId));
  const messages = db.prepare(
    `SELECT m.*, u.full_name AS author FROM telegram_messages m
       LEFT JOIN users u ON u.id = m.sent_by
      WHERE m.chat_id = ? ORDER BY m.id DESC LIMIT ?`).all(String(chatId), Math.min(limit, 500)).reverse();

  return {
    chat_id: String(chatId),
    link: link ? {
      tg_name: link.tg_name, tg_username: link.tg_username, tg_user_id: link.tg_user_id,
      phone: link.phone, linked_at: link.linked_at,
      revoked: !!link.revoked_at, blocked: !!link.blocked_at,
    } : null,
    patients: link ? findPatientsByPhone(db, link.phone).map((p) => ({ id: p.id, name: p.full_name, mrn: p.mrn })) : [],
    messages,
  };
}

// Отметить входящие прочитанными — счётчик в меню должен гаснуть.
export function markRead(db, chatId) {
  db.prepare(
    `UPDATE telegram_messages SET read_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
      WHERE chat_id = ? AND direction = 'in' AND read_at IS NULL`).run(String(chatId));
  return { ok: true };
}

export function unreadTotal(db) {
  return db.prepare(
    "SELECT COUNT(*) c FROM telegram_messages WHERE direction = 'in' AND read_at IS NULL").get().c;
}

// Чат, в который вообще можно писать. Три отказа — отвязан, заблокирован,
// не существует — одни и те же для текста и для файла, и разъехаться они не
// должны: «отправилось» и «не отправилось» обязаны значить одно и то же
// независимо от того, что именно отправляли.
function writableLink(db, chatId) {
  const link = db.prepare(
    'SELECT * FROM telegram_links WHERE chat_id = ? AND revoked_at IS NULL').get(String(chatId));
  if (!link) throw new Error('Этот чат отвязан — написать в него нельзя.');
  if (link.blocked_at) throw new Error('Пациент заблокировал бота — сообщение не дойдёт.');
  return link;
}

// Текст сотрудника уходит с parse_mode='HTML' (см. api.js): так бот оформляет
// свои собственные сообщения. Но сотрудник HTML не пишет — он пишет «температура
// < 37», и Telegram отвечает на это ошибкой разбора, то есть сообщение просто
// НЕ УХОДИТ. Экранируем то, что набрал человек; в ленту при этом пишем
// исходный текст, иначе оператор увидел бы у себя «&lt;» вместо «<».
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Подпись сотрудника под ответом: пациент должен понимать, что ему пишет живой
// регистратор, а не автомат.
function signatureOf(user) {
  return user && user.full_name ? '\n\n— ' + user.full_name : '';
}

// Ответ сотрудника. Уходит от имени бота — для пациента это то же окно, в
// котором он получает документы, поэтому сообщение подписываем сотрудником.
export async function sendChatMessage(db, token, chatId, text, user, deps = {}) {
  const body = String(text || '').trim();
  if (!body) throw new Error('Пустое сообщение не отправляется.');
  writableLink(db, chatId);

  const signature = signatureOf(user);
  const res = await sendMessage(token, chatId, escapeHtml(body) + escapeHtml(signature), {}, deps);
  logMessage(db, chatId, 'out', body + signature, {
    kind: 'text', sentBy: (user && user.id) || null, tgMessageId: res && res.message_id,
  });
  return { ok: true, message_id: res && res.message_id };
}

// TELEGRAM_CHAT_FILE_V1 — оператор отвечает пациенту ФАЙЛОМ.
//
// Файл уже лежит в корзине telegram-media: браузер положил его туда через
// /api/storage и прислал сюда только путь. Загружать его повторно в теле RPC
// смысла нет — /api/db и /api/rpc принимают JSON, и двадцатимегабайтный
// снимок пришлось бы гонять в base64, на треть длиннее и целиком в памяти.
//
// Картинка уходит фотографией, остальное — документом (правило общее с
// браузером, shared/chat-attachment.js): снимок пациент видит прямо в
// переписке, а не «скачайте файл, чтобы посмотреть».
export async function sendChatFile(db, token, chatId, args, user, deps = {}) {
  const a = args || {};
  writableLink(db, chatId);

  const relPath = String(a.path || '').trim();
  if (!relPath) throw new Error('Файл не загружен.');
  // Путь пришёл из браузера — проверку обхода каталога делает readMedia().
  const file = readMedia(relPath);
  if (!file) throw new Error('Файл не найден на диске — загрузите его заново.');

  // Имя показываем ПАЦИЕНТУ, поэтому берём то, как файл назвал оператор, а не
  // обезличенный ключ с диска: «Анализ крови.pdf» понятнее, чем «1737…-a3f9».
  const name = safeAttachmentName(a.name || file.filename);
  // Размер проверяем ещё раз здесь, по факту с диска: проверка в браузере —
  // это удобство, а не защита, и обойти её ничего не стоит.
  const tooBig = attachmentError({ name, size: file.buffer.length });
  if (tooBig) throw new Error(tooBig);

  const typed = String(a.caption || '').trim();
  const caption = typed ? typed + signatureOf(user) : '';
  const uid = (user && user.id) || null;

  // Подпись к файлу Telegram ограничивает 1024 символами против 4096 у обычного
  // сообщения. Молча обрезать написанное клиникой нельзя — по той же причине,
  // что и в рассылке: длинный текст уходит отдельным сообщением ЦЕЛИКОМ, а
  // файл следом без подписи.
  let asCaption = caption;
  if (caption.length > CAPTION_LIMIT) {
    const pre = await sendMessage(token, chatId, escapeHtml(caption), {}, deps);
    logMessage(db, chatId, 'out', caption, {
      kind: 'text', sentBy: uid, tgMessageId: pre && pre.message_id,
    });
    asCaption = '';
  }

  const res = isImageName(name)
    ? await sendPhoto(token, chatId, file.buffer,
        { caption: escapeHtml(asCaption), filename: name, ...deps })
    : await sendDocument(token, chatId, file.buffer, name,
        { caption: escapeHtml(asCaption), ...deps });

  // В ленте это сообщение вида «документ»: тем же видом помечена выдача
  // документа ботом, и для оператора это одно и то же событие — «пациенту ушёл
  // файл». Путь сохраняем, чтобы «что мы ему вчера отправили?» открывалось
  // одним щелчком, а не восстанавливалось по памяти.
  logMessage(db, chatId, 'out', name, {
    kind: 'document', sentBy: uid, tgMessageId: res && res.message_id, filePath: relPath,
  });
  return { ok: true, message_id: res && res.message_id, name, file_path: relPath };
}

// TELEGRAM_ORPHAN_CHAT_V1 — номер, НАБРАННЫЙ пациентом текстом.
//
// Связка создаётся только по контакту от Telegram: он подтверждает, что номер
// принадлежит этому аккаунту. Набранный текстом номер такого подтверждения НЕ
// даёт, поэтому он здесь — лишь подсказка сотруднику, кого этот чат напоминает.
// Автоматически связывать по нему нельзя: тогда любой, кто наберёт чужой номер,
// получил бы чужие анализы.
export function phoneFromChat(db, chatId) {
  const rows = db.prepare(
    `SELECT text FROM telegram_messages
      WHERE chat_id = ? AND direction = 'in' AND text IS NOT NULL AND text <> ''
      ORDER BY id`).all(String(chatId));
  for (const r of rows) {
    const d = digitsOf(r.text);
    if (d.length >= MIN_PHONE_DIGITS) return d;
  }
  return '';
}

// Чаты, у которых есть переписка, но нет активной связки.
//
// Их не было в списке вовсе — он строится из telegram_links, — а счётчик
// непрочитанных читает telegram_messages напрямую. Бейдж горел, открыть было
// нечего, отметить прочитанным невозможно, вопрос пациента никто не видел.
function orphanChats(db, limit) {
  const rows = db.prepare(
    `SELECT m.chat_id AS chat_id,
            COUNT(*) AS total,
            SUM(m.direction = 'in' AND m.read_at IS NULL) AS unread
       FROM telegram_messages m
      WHERE NOT EXISTS (
              SELECT 1 FROM telegram_links l
               WHERE l.chat_id = m.chat_id AND l.revoked_at IS NULL)
      GROUP BY m.chat_id
      ORDER BY MAX(m.id) DESC
      LIMIT ?`).all(Math.min(limit, 300));

  const lastMsg = db.prepare(
    'SELECT text, direction, kind, created_at FROM telegram_messages WHERE chat_id = ? ORDER BY id DESC LIMIT 1');

  return rows.map((r) => {
    const last = lastMsg.get(r.chat_id);
    const phone = phoneFromChat(db, r.chat_id);
    return {
      folders: [],
      chat_id: r.chat_id,
      tg_name: '', tg_username: '', tg_user_id: '',
      phone: '',
      blocked: false,
      patients: [],
      last_text: last ? last.text : '',
      last_direction: last ? last.direction : '',
      last_at: last ? last.created_at : null,
      unread: Number(r.unread) || 0,
      // Отличие от обычного чата: писать в него нельзя, пока не связали, а
      // подсказки ниже помогают связать за один щелчок.
      unlinked: true,
      candidate_phone: phone,
      candidates: phone ? findPatientsByPhone(db, phone).map((p) => ({ id: p.id, name: p.full_name, mrn: p.mrn })) : [],
    };
  });
}

// Связать чат с номером — РУЧНОЕ действие сотрудника, а не автоматика.
//
// Человек видит переписку, набранный номер и найденную карточку и решает сам.
// Это и есть та проверка, которой не даёт набранный текст: связывает не бот, а
// тот, кто отвечает за выдачу документов.
export function linkChatToPhone(db, args, user) {
  const chatId = String((args && args.chat_id) || '').trim();
  if (!chatId) throw new Error('Не указан чат.');
  const phone = digitsOf((args && args.phone) || '');
  if (phone.length < MIN_PHONE_DIGITS) throw new Error('Укажите номер телефона пациента.');

  return db.transaction(() => {
    // Активная связка у чата ровно одна (уникальный индекс, миграция 060):
    // прежнюю отзываем, а не удаляем — история выдач должна остаться.
    db.prepare(
      "UPDATE telegram_links SET revoked_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'), revoked_by = ? WHERE chat_id = ? AND revoked_at IS NULL")
      .run((user && user.id) || null, chatId);
    const info = db.prepare(
      `INSERT INTO telegram_links (chat_id, phone, tg_user_id, tg_username, tg_name, last_seen_at)
       VALUES (?,?,'','','', strftime('%Y-%m-%dT%H:%M:%SZ','now'))`).run(chatId, phone);
    return { link: db.prepare('SELECT * FROM telegram_links WHERE id = ?').get(info.lastInsertRowid) };
  })();
}
