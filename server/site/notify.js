// WEBSITE_V1 (задача W3-5) — уведомление администратора клиники в Telegram о
// новой заявке с сайта.
//
// Отправка идёт ТЕМ ЖЕ клиентом Bot API, что и у бота/рассылки
// (server/services/telegram/api.js::sendMessage) — здесь не заводится вторая
// копия HTTP-похода в Telegram.
//
// Это уведомление НИКОГДА не должно повлиять на заявку пациента: ни задержать
// ответ (вызывающая сторона — requests.js — зовёт notifyNewRequest() вне
// транзакции и не блокируясь), ни тем более уронить запрос при недоступном
// Telegram — поэтому все ошибки здесь глотаются и уходят только в лог.
import { sendMessage } from '../services/telegram/api.js';
import { readSettingsRow, getDecryptedToken } from '../services/telegram/settings.js';
import { getSettings } from './content.js';

const TYPE_LABELS = {
  appointment: 'Запись на приём',
  contact: 'Обратная связь',
  callback: 'Обратный звонок',
};

// sendMessage() (см. api.js) шлёт с parse_mode='HTML' по умолчанию — тем же
// путём, что и вся остальная переписка бота (chat.js/flow.js). full_name и
// phone приходят с формы сайта и могут содержать «&», «<», «>»: без
// экранирования Telegram либо откажет в разборе сущностей (сообщение молча
// не уйдёт — ровно то, чего нельзя допустить в уведомлении), либо «<b>»,
// случайно попавший в имя, отрисуется как разметка. Экранируем ТОЛЬКО то, что
// набрал посетитель сайта — id (число), preferred_date (уже проверен regex
// в requests.js) и label (наша фиксированная строка) экранирования не требуют.
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

// Реальный отправитель — тонкая обёртка над house-хелпером sendMessage.
// Тесты подменяют этот слот через _setSender(), не трогая сеть: тот же приём,
// что стаб fetchImpl у api.js, но без протаскивания deps через requests.js,
// у которого сигнатура вызова уже зафиксирована задачей (db, {..данные..}).
let sender = (token, chatId, text) => sendMessage(token, chatId, text);

export function _setSender(fn) {
  sender = fn || ((token, chatId, text) => sendMessage(token, chatId, text));
}

// Chat ID у Telegram — строка цифр; у групп/каналов она начинается с минуса.
// Всё остальное (пусто, буквы, мусор из формы) — «не настроено», а не ошибка.
function validChatId(v) {
  const s = String(v || '').trim();
  return /^-?\d+$/.test(s) ? s : '';
}

export async function notifyNewRequest(db, { id, type, full_name, phone, preferred_date } = {}) {
  try {
    const row = readSettingsRow(db);
    if (!row || !row.enabled) return; // бот выключен — слать некому и незачем
    const chatId = validChatId(getSettings(db)?.notify?.telegram_chat_id);
    if (!chatId) return; // администратор ещё не указал чат — тихо выходим
    const token = getDecryptedToken(db);
    if (!token) return; // включён, но без токена — до этого не должно доходить, но на всякий случай

    const label = TYPE_LABELS[type] || type;
    let text = `🌐 Новая заявка с сайта №${id}\nТип: ${label}\nИмя: ${escapeHtml(full_name)}\nТелефон: ${escapeHtml(phone)}`;
    if (preferred_date) text += `\nДата: ${preferred_date}`;

    await sender(token, chatId, text);
  } catch (e) {
    // Токен в это сообщение никогда не попадает: TelegramError.message уже
    // человекочитаемый ("Telegram отклонил токен…"), сырой токен в него не
    // подмешивается (см. server/services/telegram/api.js::humanize).
    console.warn('[site notify]', e && e.message);
  }
}
