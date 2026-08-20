// TELEGRAM_BOT_V1 — RPC раздела «Telegram-бот» в настройках.
//
// Почему RPC, а не обычный /api/db: таблица telegram_settings намеренно НЕ
// зарегистрирована в schema-registry.js. Реестр — белый список, поэтому
// отсутствие в нём делает токен недостижимым через /api/db по построению.
// Здесь же токен не отдаётся наружу ни одним ответом: браузер видит только
// хвост из четырёх символов.

import { hasAnyRole, canViewSection, canEditSection } from '../roles.js';
import { listChats, chatMessages, markRead, unreadTotal, sendChatMessage, sendChatFile, linkChatToPhone,
         listFolders, createFolder, renameFolder, deleteFolder, setChatFolder } from '../telegram/chat.js';
import { publicSettings, saveSettings, clearToken, getDecryptedToken, recordCheck, SettingsError } from '../telegram/settings.js';
import { getMe, TelegramError } from '../telegram/api.js';
import { setupBot } from '../telegram/setup.js';   // TELEGRAM_BOT_SETUP_V1
import { wakeTelegramBot } from '../telegram/index.js';
import { findPatientsByPhone } from '../telegram/documents.js';
import { botStats, previewAudience, startBroadcast, broadcastStatus, broadcastHistory } from '../telegram/broadcast.js';

export class RpcError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

// Токен бота — это полный контроль над перепиской с пациентами, поэтому
// раздел админский целиком, включая чтение. Регистратору незачем видеть даже
// хвост токена.
function requireAdmin(user) {
  if (!hasAnyRole(user, ['admin'])) {
    throw new RpcError('Настройки Telegram-бота доступны только администратору.', 403);
  }
}

function rethrow(e) {
  if (e instanceof SettingsError) throw new RpcError(e.message, e.status);
  throw e;
}

export function telegramSettingsGet(db, _args, user) {
  requireAdmin(user);
  return publicSettings(db);
}

// Сохранение настроек.
//
// Если администратор ввёл ТОКЕН, то это единственное действие, которое от него
// требуется: дальше всё делается само — проверяется связь, бот включается и
// опросник просыпается. Раньше здесь было три отдельных шага (сохранить →
// проверить → включить), и бот молча не работал, если пропустить любой из них;
// «токен добавил, а бот не отвечает» — ровно этот случай.
//
// Асинхронная: при вводе токена ходит в Telegram. routes/rpc.js ждёт промис.
export async function telegramSettingsSave(db, args, user, deps = {}) {
  requireAdmin(user);
  const uid = user && user.id ? user.id : null;

  let settings;
  try {
    settings = saveSettings(db, args || {}, uid);
  } catch (e) { return rethrow(e); }

  const tokenAdded = args && args.bot_token && String(args.bot_token).trim() !== '';
  if (!tokenAdded) {
    wakeTelegramBot();   // могли переключить «включён» — не заставляем ждать
    return settings;
  }

  // Токен только что заменён. Проверяем связь и, если Telegram его принял,
  // включаем бота сами.
  try {
    const token = getDecryptedToken(db);
    const me = await getMe(token, deps);
    recordCheck(db, { ok: true, username: me.username, id: me.id });
    settings = saveSettings(db, { enabled: true }, uid);
    // TELEGRAM_BOT_SETUP_V1 — команды, описание и кнопка «Меню» ставятся здесь
    // же: администратор вводит ТОЛЬКО токен, всё остальное бот получает сам.
    // Неудача оформления не отменяет ни сохранения токена, ни включения бота.
    const setup = await setupBot(db, token, deps);
    wakeTelegramBot();
    return { ...settings, bot: me, auto_enabled: true, setup };
  } catch (e) {
    if (e instanceof TelegramError) {
      // Токен сохранён, но Telegram его не принял: бота НЕ включаем, иначе
      // интерфейс показывал бы работающего бота, которого нет.
      return { ...recordCheck(db, { ok: false, error: e.message }), check_error: e.message };
    }
    throw e;
  }
}

export function telegramTokenClear(db, _args, user) {
  requireAdmin(user);
  return clearToken(db, user && user.id ? user.id : null);
}

// Связанные чаты. Для каждого показываем, скольких пациентов он открывает:
// доступ по одному номеру телефона принят осознанно, и администратор должен
// видеть последствия — «этот чат читает документы четырёх человек».
export function telegramLinksList(db, _args, user) {
  requireAdmin(user);
  const rows = db.prepare(
    `SELECT * FROM telegram_links ORDER BY revoked_at IS NOT NULL, linked_at DESC LIMIT 200`).all();
  return rows.map((r) => ({
    id: r.id,
    chat_id: r.chat_id,
    phone: r.phone,
    tg_username: r.tg_username,
    tg_name: r.tg_name,
    linked_at: r.linked_at,
    last_seen_at: r.last_seen_at,
    revoked: !!r.revoked_at,
    patients: findPatientsByPhone(db, r.phone).map((p) => ({
      id: p.id, name: p.full_name, mrn: p.mrn,
      // «Когда последний раз приходил» — по журналу визитов. Это НЕ то же
      // самое, что last_seen_at связки: та говорит, когда человек последний
      // раз открывал бота. В таблице подключённых пациентов клинику
      // интересует именно посещение.
      last_visit: lastVisitOf(db, p.id),
    })),
  }));
}

function lastVisitOf(db, patientId) {
  const row = db.prepare(
    'SELECT MAX(visit_date) d FROM visits WHERE patient_id = ?').get(patientId);
  return (row && row.d) || null;
}

// «Отвязать» — средство против главного риска этой схемы: номер перешёл к
// другому человеку, а вместе с ним и доступ к чужой медкарте. Строка остаётся
// в базе отозванной, чтобы журнал выдач не потерял, кому и что уходило.
export function telegramLinkRevoke(db, args, user) {
  requireAdmin(user);
  const id = Number(args && args.id);
  if (!Number.isInteger(id) || id <= 0) throw new RpcError('Не указана связка.', 400);
  db.prepare(`UPDATE telegram_links
                 SET revoked_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'), revoked_by = ?
               WHERE id = ? AND revoked_at IS NULL`).run(user && user.id ? user.id : null, id);
  return telegramLinksList(db, {}, user);
}

// Журнал выдач — то, чем клиника разбирается, если документ ушёл не туда.
export function telegramDeliveriesList(db, args, user) {
  requireAdmin(user);
  const limit = Math.min(Math.max(Number(args && args.limit) || 50, 1), 200);
  return db.prepare(
    `SELECT d.*, p.full_name AS patient_name, l.tg_name, l.phone
       FROM telegram_deliveries d
       LEFT JOIN patients p ON p.id = d.patient_id
       LEFT JOIN telegram_links l ON l.chat_id = d.chat_id AND l.revoked_at IS NULL
      ORDER BY d.created_at DESC LIMIT ?`).all(limit);
}

// ---------------------------------------------------------------------------
// TELEGRAM_CHAT_V1 — переписка с пациентами
// ---------------------------------------------------------------------------
//
// В отличие от настроек бота, этот раздел НЕ admin-only: он выдаётся ролям в
// «Настройки → Роли», и его уровень решает, что можно. Проверяем по той же
// таблице role_permissions, из которой рисуется меню, — иначе право «читать
// переписку» жило бы только в браузере, где его нечего защищать.
const CHAT_KEY = 'telegram-chat';

function requireChatView(db, user) {
  if (!canViewSection(db, user, CHAT_KEY)) {
    throw new RpcError('Раздел «Чат с пациентами» вам не выдан.', 403);
  }
}
function requireChatReply(db, user) {
  requireChatView(db, user);
  if (!canEditSection(db, user, CHAT_KEY)) {
    // Читать переписку и писать от имени клиники — разные права.
    throw new RpcError('У вас доступ «только чтение»: отвечать пациентам нельзя.', 403);
  }
}

export function telegramChatsList(db, args, user) {
  requireChatView(db, user);
  return { chats: listChats(db, args || {}), unread: unreadTotal(db), folders: listFolders(db) };
}

// Папки — общие для клиники, поэтому менять их может тот, кто вообще ведёт
// переписку (editor), а не только администратор. Читатель их видит, но
// перекладывать чаты не может: это изменение общего рабочего пространства.
export function telegramFolderSave(db, args, user) {
  requireChatReply(db, user);
  const a = args || {};
  try {
    if (a.delete_id) return { ok: true, folders: (deleteFolder(db, a.delete_id), listFolders(db)) };
    if (a.id) { renameFolder(db, a.id, a.name); return { ok: true, folders: listFolders(db) }; }
    createFolder(db, a.name, user && user.id ? user.id : null);
    return { ok: true, folders: listFolders(db) };
  } catch (e) { throw new RpcError(e.message || 'Не удалось сохранить папку.', 400); }
}

export function telegramFolderSetChat(db, args, user) {
  requireChatReply(db, user);
  const a = args || {};
  if (!a.chat_id) throw new RpcError('Не указан чат.', 400);
  try {
    setChatFolder(db, a.folder_id, a.chat_id, !!a.member, user && user.id ? user.id : null);
  } catch (e) { throw new RpcError(e.message || 'Не удалось изменить папку.', 400); }
  return { ok: true, chats: listChats(db), folders: listFolders(db) };
}

export function telegramChatMessages(db, args, user) {
  requireChatView(db, user);
  const chatId = String((args && args.chat_id) || '');
  if (!chatId) throw new RpcError('Не указан чат.', 400);
  const data = chatMessages(db, chatId, args || {});
  // Открыл переписку — входящие считаются прочитанными. Отдельной кнопки
  // «прочитано» в мессенджерах не бывает, и здесь она была бы лишним шагом.
  markRead(db, chatId);
  return data;
}

// TELEGRAM_ORPHAN_CHAT_V1 — связать «ничей» чат с пациентом вручную.
//
// Требует права ОТВЕЧАТЬ, а не просто смотреть: связка открывает этому чату
// доступ к документам пациента, и это решение того же веса, что и ответ от
// имени клиники. Бот сам по набранному тексту не связывает — набранный номер
// ничего не подтверждает (см. chat.js), поэтому решение принимает человек,
// который видит переписку.
export function telegramChatLink(db, args, user) {
  requireChatReply(db, user);
  try {
    return linkChatToPhone(db, args, user);
  } catch (e) {
    throw new RpcError((e && e.message) || 'Не удалось связать чат.', 400);
  }
}

export function telegramChatUnread(db, _args, user) {
  requireChatView(db, user);
  return { unread: unreadTotal(db) };
}

// Условия, без которых из клиники не уходит НИЧЕГО: бот включён и токен
// читается. Общие для текста и для файла — разъехавшись, они дали бы «текст
// уходит, а файл нет» без внятной причины на экране.
function sendingToken(db) {
  const enabled = db.prepare('SELECT enabled FROM telegram_settings WHERE id = 1').get();
  if (!enabled || !enabled.enabled) throw new RpcError('Бот выключен — сообщение не уйдёт.', 400);
  let token = '';
  try { token = getDecryptedToken(db); } catch { throw new RpcError('Токен бота не читается.', 400); }
  if (!token) throw new RpcError('Токен бота не задан.', 400);
  return token;
}

// Ошибка отправки — это всегда 400 с человеческим текстом: «не дошло» сотрудник
// должен прочитать и понять, что делать, а не увидеть 500.
function asRpcError(e, fallback) {
  if (e instanceof TelegramError) return new RpcError(e.message, 400);
  return new RpcError((e && e.message) || fallback, 400);
}

export async function telegramChatSend(db, args, user, deps = {}) {
  requireChatReply(db, user);
  const a = args || {};
  const token = sendingToken(db);
  try {
    return await sendChatMessage(db, token, String(a.chat_id || ''), a.text, user, deps);
  } catch (e) {
    throw asRpcError(e, 'Не удалось отправить сообщение.');
  }
}

// TELEGRAM_CHAT_FILE_V1 — отправка файла пациенту.
//
// Право то же, что и на текст: отправить пациенту файл от имени клиники — это
// ответ от имени клиники, не «просмотр». Уровень «только чтение» сюда не
// проходит, и кнопки скрепки в интерфейсе у него тоже нет.
//
// В args приходит ПУТЬ файла в корзине telegram-media, а не сам файл: браузер
// уже положил его туда через /api/storage. Путь здесь не разбираем — его
// проверяет readMedia() перед чтением с диска, в единственном месте, которое
// вообще трогает файловую систему.
export async function telegramChatSendFile(db, args, user, deps = {}) {
  requireChatReply(db, user);
  const a = args || {};
  const token = sendingToken(db);
  try {
    return await sendChatFile(db, token, String(a.chat_id || ''), a, user, deps);
  } catch (e) {
    throw asRpcError(e, 'Не удалось отправить файл.');
  }
}

// ---------------------------------------------------------------------------
// TELEGRAM_BROADCAST_V1 — статистика и рассылка
// ---------------------------------------------------------------------------

export function telegramStats(db, _args, user) {
  requireAdmin(user);
  return botStats(db);
}

export function telegramBroadcastPreview(db, args, user) {
  requireAdmin(user);
  return previewAudience(db, (args && args.filters) || {});
}

// Отправка. Подтверждение числом получателей проверяется ЗДЕСЬ, а не только в
// браузере: диалог в интерфейсе — это удобство, а защита от «разослал черновик
// всей базе» должна стоять на сервере, где её нельзя обойти.
export function telegramBroadcastSend(db, args, user) {
  requireAdmin(user);
  const a = args || {};
  const textRu = String(a.text_ru || '').trim();
  if (!textRu) throw new RpcError('Сообщение не может быть пустым.', 400);
  if (textRu.length > 3500) throw new RpcError('Сообщение длиннее 3500 символов — Telegram его не примет.', 400);

  const filters = a.filters || {};
  const actual = previewAudience(db, filters).count;
  if (!actual) throw new RpcError('Под эти условия не подходит ни один подключённый пациент.', 400);

  // Число, которое подтвердил администратор, должно совпасть с текущим. Если
  // за время раздумий кто-то подключился или отвязался — отправку не начинаем
  // молча, а показываем новое число.
  if (Number(a.confirm_count) !== actual) {
    throw new RpcError(`Число получателей изменилось: сейчас ${actual}. Проверьте и подтвердите заново.`, 409);
  }

  let token = '';
  try { token = getDecryptedToken(db); } catch (e) { throw new RpcError('Токен бота не читается.', 400); }
  if (!token) throw new RpcError('Токен бота не задан.', 400);

  const enabled = db.prepare('SELECT enabled FROM telegram_settings WHERE id = 1').get();
  if (!enabled || !enabled.enabled) throw new RpcError('Бот выключен — включите его в настройках.', 400);

  // TELEGRAM_BROADCAST_IMG_V1 — путь внутри корзины telegram-media, без имени
  // самой корзины. Пришедшее из браузера значение здесь не разбираем: его
  // проверяет readBroadcastImage() перед чтением с диска, где и находится
  // единственное место, которое вообще трогает файловую систему.
  const imagePath = String(a.image_path || '').trim() || null;

  try {
    return startBroadcast(db, token, {
      textRu, textUz: String(a.text_uz || ''), filters,
      userId: user && user.id ? user.id : null,
      imagePath,
    });
  } catch (e) {
    // Пропавшая картинка — это ошибка администратора, а не сбой сервера:
    // отвечаем 400 с текстом, который говорит, что делать.
    throw new RpcError(e.message || 'Не удалось запустить рассылку.', 400);
  }
}

export function telegramBroadcastStatus(db, args, user) {
  requireAdmin(user);
  const st = broadcastStatus(db, args && args.id);
  if (!st) throw new RpcError('Рассылка не найдена.', 404);
  return st;
}

export function telegramBroadcastHistory(db, args, user) {
  requireAdmin(user);
  return broadcastHistory(db, args && args.limit);
}

// Проверка связи. Асинхронная — единственный RPC в проекте, который ходит в
// сеть; ради него routes/rpc.js научился ждать промис.
//
// Ошибка Telegram здесь НЕ роняет запрос: неверный токен — это нормальный
// результат проверки, который надо показать в интерфейсе, а не 400 без
// подробностей. Поэтому ответ всегда 200 с полем ok.
export async function telegramTestConnection(db, args, user, deps = {}) {
  requireAdmin(user);
  let token;
  try {
    token = getDecryptedToken(db);
  } catch (e) {
    // Сюда попадает повреждённый ключ или подменённый шифротекст.
    return { ok: false, error: 'Сохранённый токен не читается: ' + e.message, settings: publicSettings(db) };
  }
  if (!token) throw new RpcError('Токен бота не задан.', 400);

  try {
    const me = await getMe(token, deps);
    return { ok: true, bot: me, settings: recordCheck(db, { ok: true, username: me.username, id: me.id }) };
  } catch (e) {
    if (e instanceof TelegramError) {
      return { ok: false, error: e.message, settings: recordCheck(db, { ok: false, error: e.message }) };
    }
    throw e;
  }
}
