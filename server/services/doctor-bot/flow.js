// REFERRALS_CRM_V1 (2026-10-26) — диалог бота для врачей-источников.
//
// Снимок владельца («Как подключиться врачу»): врач открывает бота, нажимает
// «Start» и отправляет свой номер кнопкой; номер должен совпасть с телефоном
// врача во вкладке «Врачи-источники». После этого бот сам присылает ФИО
// пришедшего пациента и список услуг (notify.js); ответов здесь не читают.
//
// Номер сравнивается ключом phoneKey() из crm-phone-match.js — теми же девятью
// цифрами, которыми CRM считает «тот же номер»: в справочнике телефоны записаны
// и как «+998 90 310 65 70», и как «998903106570». Короче полного номера не
// ищем вовсе — иначе чужой короткий номер мог бы привязаться к врачу.
import { sendMessage, ackQuietly } from '../telegram/api.js';
import { phoneKey, digitsOf, isWholeUzPhone } from '../../../public/js/admin/views/crm-phone-match.js';

export const T = {
  shareBtn: 'Отправить номер · Raqamni yuborish',
  greeting: [
    'Это бот клиники для врачей, которые направляют к нам пациентов. Отправьте свой номер телефона кнопкой ниже — он должен совпадать с номером, который указан у вас в клинике.',
    '',
    'Bu — bemorlarni bizga yo‘naltiradigan shifokorlar uchun klinika boti. Quyidagi tugma orqali telefon raqamingizni yuboring — u klinikada siz uchun ko‘rsatilgan raqam bilan mos kelishi kerak.',
  ].join('\n'),
  notOwn: 'Пожалуйста, отправьте СВОЙ номер — кнопкой «Отправить номер».\nIltimos, O‘Z raqamingizni «Raqamni yuborish» tugmasi orqali yuboring.',
  needContact: 'Чтобы подключиться, отправьте номер телефона кнопкой ниже.\nUlanish uchun quyidagi tugma orqali telefon raqamingizni yuboring.',
  unknown: [
    'Этот номер не найден среди врачей клиники. Если вы направляете к нам пациентов, попросите клинику проверить ваш телефон в списке врачей-источников и отправьте номер ещё раз.',
    '',
    'Bu raqam klinika shifokorlari orasida topilmadi. Agar siz bizga bemor yo‘naltirsangiz, klinikadan manba shifokorlar ro‘yxatidagi telefoningizni tekshirishni so‘rang va raqamni qayta yuboring.',
  ].join('\n'),
  linked: (name) => [
    `Вы подключены как ${name}. Когда направленный вами пациент придёт в клинику, бот пришлёт его ФИО и список услуг.`,
    '',
    `Siz ${name} sifatida ulandingiz. Siz yo‘naltirgan bemor klinikaga kelganda bot uning F.I.Sh. va xizmatlar ro‘yxatini yuboradi.`,
  ].join('\n'),
  gotMessage: 'Бот присылает уведомления сам, когда направленный вами пациент пришёл. Сообщения здесь не читаются — по вопросам звоните в клинику.\nBot siz yo‘naltirgan bemor kelganda xabarni o‘zi yuboradi. Bu yerdagi xabarlar o‘qilmaydi — savollar bo‘yicha klinikaga qo‘ng‘iroq qiling.',
  seen: 'Отмечено · Belgilandi',
};

const contactKeyboard = {
  keyboard: [[{ text: T.shareBtn, request_contact: true }]],
  resize_keyboard: true, one_time_keyboard: true,
};
const removeKeyboard = { remove_keyboard: true };

export function activeLink(db, chatId) {
  return db.prepare('SELECT * FROM doctor_bot_links WHERE chat_id = ? AND revoked_at IS NULL').get(String(chatId)) || null;
}

/** Внешний активный источник с тем же номером (ключ phoneKey), или null. */
export function findSourceByPhone(db, rawPhone) {
  const digits = digitsOf(rawPhone);
  if (!isWholeUzPhone(digits)) return null;
  const key = phoneKey(rawPhone);
  const rows = db.prepare(`SELECT id, name, phone FROM referral_sources
                            WHERE doctor_id IS NULL AND active = 1 AND COALESCE(phone, '') <> ''`).all();
  return rows.find((r) => phoneKey(r.phone) === key) || null;
}

export async function handleUpdate(db, token, update, deps = {}) {
  if (update.message) return handleMessage(db, token, update.message, deps);
  if (update.callback_query) return handleCallback(db, token, update.callback_query, deps);
  return null;
}

async function handleMessage(db, token, msg, deps) {
  const chatId = msg.chat && msg.chat.id;
  if (!chatId) return null;
  if (msg.contact) return handleContact(db, token, msg, deps);

  const link = activeLink(db, chatId);
  if (!link) return sendMessage(token, chatId, T.greeting, { reply_markup: contactKeyboard }, deps);

  const cmd = String(msg.text || '').trim().toLowerCase().split('@')[0];
  if (cmd === '/start' || cmd === '/help') {
    return sendMessage(token, chatId, T.linked(sourceName(db, link.referral_source_id)), { reply_markup: removeKeyboard }, deps);
  }
  return sendMessage(token, chatId, T.gotMessage, {}, deps);
}

async function handleContact(db, token, msg, deps) {
  const chatId = msg.chat.id;
  const contact = msg.contact || {};
  const fromId = msg.from && msg.from.id;
  // Только свой контакт: чужую визитку из телефонной книги не принимаем.
  if (!contact.user_id || !fromId || String(contact.user_id) !== String(fromId)) {
    return sendMessage(token, chatId, T.notOwn, { reply_markup: contactKeyboard }, deps);
  }
  const digits = digitsOf(contact.phone_number);
  if (!digits) return sendMessage(token, chatId, T.needContact, { reply_markup: contactKeyboard }, deps);

  const src = findSourceByPhone(db, contact.phone_number);
  if (!src) return sendMessage(token, chatId, T.unknown, { reply_markup: contactKeyboard }, deps);

  const name = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ');
  db.transaction(() => {
    // Один врач — один чат, один чат — один врач: прежние связки отзываются,
    // строки остаются ради истории (кто и когда был подключён).
    db.prepare(`UPDATE doctor_bot_links SET revoked_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
                 WHERE revoked_at IS NULL AND (chat_id = ? OR referral_source_id = ?)`).run(String(chatId), src.id);
    db.prepare(`INSERT INTO doctor_bot_links (referral_source_id, chat_id, phone, tg_user_id, tg_username, tg_name, last_seen_at)
                VALUES (?,?,?,?,?,?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))`)
      .run(src.id, String(chatId), digits, String(fromId), msg.from.username || '', name);
  })();
  return sendMessage(token, chatId, T.linked(src.name), { reply_markup: removeKeyboard }, deps);
}

// Кнопка «Получил» под уведомлением: отмечает просмотр. Номер уведомления —
// из callback_data, но строка обновляется только вместе с chat_id этого
// же чата: callback_data приходит снаружи и подделывается.
async function handleCallback(db, token, cq, deps) {
  const data = String(cq.data || '');
  const chatId = cq.message && cq.message.chat && cq.message.chat.id;
  const m = /^seen:(\d+)$/.exec(data);
  if (m && chatId) {
    db.prepare(`UPDATE doctor_bot_notifications
                   SET viewed_at = COALESCE(viewed_at, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
                 WHERE id = ? AND chat_id = ?`).run(Number(m[1]), String(chatId));
  }
  return ackQuietly(token, cq.id, m ? T.seen : '', deps);
}

function sourceName(db, id) {
  const r = db.prepare('SELECT name FROM referral_sources WHERE id = ?').get(id);
  return r ? r.name : '';
}
