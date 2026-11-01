// REP_BOT_V1 (2026-10-30) — диалог бота для медпредставителей.
//
// Владелец: «make it possible that med representative adds doctor from telegram
// bot, make seperate bot for only med reps». Представитель договорился с врачом
// поликлиники — и тут же, с телефона, заводит его в справочник «Врачи-источники»,
// закреплённым за собой. Больше бот ничего не умеет: «Добавить врача» и «Мои
// врачи».
//
// ПОДКЛЮЧЕНИЕ. Представитель отправляет СВОЙ номер кнопкой (чужую визитку не
// принимаем — Telegram подтверждает номер только у владельца аккаунта). Номер
// ищется среди действующих сотрудников с ролью «Медпредставитель»
// (representativeCodes — та же роль, что у вкладки «Представители»), ключом
// phoneKey (9 цифр, как в CRM). Номер у двух сотрудников — никто (урок
// FIX_318_V1 M2 бота врачей). Связка ждёт подтверждения администратора:
// бот ПИШЕТ в справочник, и только подтверждение даёт чату на это право.
//
// ПЕРЕД КАЖДЫМ ДЕЙСТВИЕМ сотрудник проверяется снова (repOfLink): уволен, снята
// роль, сменился номер — связка отзывается здесь же, даже если триггер
// мигр. 260 по какой-то причине не сработал.
//
// АНКЕТА. ФИО → телефон → специальность → место работы → район → «Сохранить».
// Всё, кроме ФИО, можно пропустить. Анкета хранится в rep_bot_drafts, не в
// памяти: перезапуск сервера посреди анкеты её не теряет. Врач с тем же
// номером уже есть — второго не заводим: два врача с одним номером не смогут
// подключиться к боту врачей (там такой номер — «ничей»), а в ведомости
// появится двойник.
//
// ЛИЦЕНЗИЯ. Просроченная клиника читает, но не пишет (gate.js); бот — тоже
// запись, поэтому перед сохранением спрашивается то же состояние лицензии.
import { sendMessage, ackQuietly } from '../telegram/api.js';
import { phoneKey, digitsOf, isWholeUzPhone, uzE164 } from '../../../public/js/admin/views/crm-phone-match.js';
import { representativeCodes } from '../rpc/referrals.js';
import { controlState } from '../control/state.js';
import { getDataDir } from '../control/config.js';

const NAME_MAX = 120;
const FIELD_MAX = 120;
const MY_DOCTORS_SHOWN = 30;

export const T = {
  shareBtn: 'Отправить номер · Raqamni yuborish',
  addBtn: 'Добавить врача · Shifokor qo‘shish',
  myBtn: 'Мои врачи · Mening shifokorlarim',
  skipBtn: 'Пропустить · O‘tkazib yuborish',
  cancelBtn: 'Отмена · Bekor qilish',
  saveBtn: 'Сохранить · Saqlash',
  greeting: [
    'Это бот клиники для медпредставителей. Отправьте свой номер телефона кнопкой ниже — он должен совпадать с номером, который указан у вас в клинике (карточка сотрудника).',
    '',
    'Bu — klinikaning tibbiy vakillar uchun boti. Quyidagi tugma orqali telefon raqamingizni yuboring — u klinikada siz uchun ko‘rsatilgan raqam bilan mos kelishi kerak.',
  ].join('\n'),
  notOwn: 'Пожалуйста, отправьте СВОЙ номер — кнопкой «Отправить номер».\nIltimos, O‘Z raqamingizni «Raqamni yuborish» tugmasi orqali yuboring.',
  needContact: 'Чтобы подключиться, отправьте номер телефона кнопкой ниже.\nUlanish uchun quyidagi tugma orqali telefon raqamingizni yuboring.',
  unknown: [
    'Этот номер не найден среди медпредставителей клиники. Попросите администратора проверить номер в вашей карточке сотрудника и роль «Медпредставитель», и отправьте номер ещё раз.',
    '',
    'Bu raqam klinikaning tibbiy vakillari orasida topilmadi. Administratordan xodim kartangizdagi raqamni va «Медпредставитель» rolini tekshirishni so‘rang va raqamni qayta yuboring.',
  ].join('\n'),
  ambiguous: [
    'Этот номер указан у нескольких сотрудников клиники, поэтому бот не может понять, кто вы. Попросите администратора оставить номер только у вас и отправьте его ещё раз.',
    '',
    'Bu raqam klinikaning bir nechta xodimida ko‘rsatilgan. Administratordan raqamni faqat sizda qoldirishni so‘rang va uni qayta yuboring.',
  ].join('\n'),
  pending: (name) => [
    `Заявка на подключение как ${esc(name)} отправлена в клинику. Когда администратор её подтвердит, вы сможете добавлять врачей прямо отсюда.`,
    '',
    `Siz ${esc(name)} sifatida ulanish so‘rovi klinikaga yuborildi. Administrator tasdiqlagach, shifokorlarni shu yerdan qo‘shishingiz mumkin bo‘ladi.`,
  ].join('\n'),
  linked: (name) => [
    `Вы подключены как ${esc(name)}. Нажмите «Добавить врача», чтобы завести нового врача — он будет закреплён за вами. «Мои врачи» — список ваших врачей.`,
    '',
    `Siz ${esc(name)} sifatida ulandingiz. Yangi shifokorni qo‘shish uchun «Shifokor qo‘shish» tugmasini bosing — u sizga biriktiriladi.`,
  ].join('\n'),
  revoked: [
    'Подключение к боту больше не действует: в клинике изменились ваши данные (номер, роль или вы отключены). Если это ошибка — обратитесь к администратору и отправьте номер снова.',
    '',
    'Botga ulanish endi amal qilmaydi. Agar bu xato bo‘lsa — administratorga murojaat qiling va raqamni qayta yuboring.',
  ].join('\n'),
  menu: 'Выберите действие кнопкой ниже.\nQuyidagi tugma orqali amalni tanlang.',
  askName: 'ФИО врача — фамилия, имя и отчество через пробел (например: Каримов Азиз Бахтиёрович).\nShifokorning F.I.Sh. — familiya, ism va otasining ismi.',
  badName: 'Нужны хотя бы фамилия и имя — два слова, до 120 символов.\nKamida familiya va ism kerak — ikki so‘z.',
  askPhone: 'Телефон врача, например +998 90 123 45 67. По этому номеру врач потом подключится к боту для врачей. Нет номера — «Пропустить».\nShifokor telefoni. Raqam bo‘lmasa — «O‘tkazib yuborish».',
  badPhone: 'Это не похоже на узбекский номер. Введите номер целиком, например +998 90 123 45 67, или нажмите «Пропустить».\nRaqamni to‘liq kiriting yoki «O‘tkazib yuborish».',
  duplicate: (name, code) => [
    `Врач с этим номером уже есть в клинике: ${esc(name)}${code ? ' (№ ' + esc(code) + ')' : ''}. Второго не заводим. Если его нужно закрепить за вами — попросите администратора.`,
    '',
    `Bu raqamli shifokor klinikada allaqachon bor: ${esc(name)}. Ikkinchisini qo‘shmaymiz.`,
  ].join('\n'),
  askSpecialty: 'Специальность врача (например: терапевт). Или «Пропустить».\nShifokor mutaxassisligi. Yoki «O‘tkazib yuborish».',
  askWorkplace: 'Место работы — поликлиника, больница. Или «Пропустить».\nIsh joyi. Yoki «O‘tkazib yuborish».',
  askDistrict: 'Район. Или «Пропустить».\nTuman. Yoki «O‘tkazib yuborish».',
  needText: 'Ответьте текстом или кнопкой ниже.\nMatn yoki quyidagi tugma bilan javob bering.',
  tooLong: 'Слишком длинно — до 120 символов.\nJuda uzun — 120 belgigacha.',
  cancelled: 'Добавление отменено.\nQo‘shish bekor qilindi.',
  nothingToSave: 'Нечего сохранять — анкета уже сохранена или отменена.\nSaqlash uchun hech narsa yo‘q.',
  locked: 'Клиника сейчас не принимает изменения (лицензия). Врач не добавлен — попробуйте позже или обратитесь к администратору.\nKlinika hozir o‘zgarishlarni qabul qilmayapti. Keyinroq urinib ko‘ring.',
  saved: (name, code) => [
    `Врач добавлен: <b>${esc(name)}</b>, № ${esc(code)}. Он закреплён за вами.`,
    '',
    `Shifokor qo‘shildi: <b>${esc(name)}</b>, № ${esc(code)}. U sizga biriktirildi.`,
  ].join('\n'),
  almost: 'Почти готово · Deyarli tayyor',
  noDoctors: 'За вами пока не закреплено ни одного врача.\nSizga hali birorta shifokor biriktirilmagan.',
};

const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

const contactKeyboard = {
  keyboard: [[{ text: T.shareBtn, request_contact: true }]],
  resize_keyboard: true, one_time_keyboard: true,
};
const removeKeyboard = { remove_keyboard: true };
const menuKeyboard = { keyboard: [[{ text: T.addBtn }], [{ text: T.myBtn }]], resize_keyboard: true };
const stepKeyboard = { keyboard: [[{ text: T.skipBtn }], [{ text: T.cancelBtn }]], resize_keyboard: true };
const nameKeyboard = { keyboard: [[{ text: T.cancelBtn }]], resize_keyboard: true };

// Порядок вопросов анкеты после ФИО: шаг → [поле, вопрос].
const OPTIONAL_STEPS = [
  ['phone', T.askPhone],
  ['specialty', T.askSpecialty],
  ['workplace', T.askWorkplace],
  ['district', T.askDistrict],
];

// ---------------------------------------------------------------------------
// Кто это
// ---------------------------------------------------------------------------
const holes = (list) => list.map(() => '?').join(',');

/** Все действующие представители с тем же номером (ключ phoneKey). */
export function findRepsByPhone(db, rawPhone) {
  const digits = digitsOf(rawPhone);
  if (!isWholeUzPhone(digits)) return [];
  const key = phoneKey(rawPhone);
  const codes = representativeCodes(db);
  return db.prepare(`SELECT id, full_name, phone FROM users
                      WHERE is_active = 1 AND custom_role_code IN (${holes(codes)}) AND COALESCE(phone, '') <> ''`)
    .all(...codes).filter((u) => phoneKey(u.phone) === key);
}

export function activeLink(db, chatId) {
  return db.prepare('SELECT * FROM rep_bot_links WHERE chat_id = ? AND revoked_at IS NULL').get(String(chatId)) || null;
}

/**
 * Сотрудник связки — если он всё ещё представитель: действующий, с ролью, и
 * номер связки — его номер. Иначе связка отзывается и возвращается null.
 */
export function repOfLink(db, link) {
  const codes = representativeCodes(db);
  const u = db.prepare(`SELECT id, full_name, phone FROM users
                         WHERE id = ? AND is_active = 1 AND custom_role_code IN (${holes(codes)})`).get(link.user_id, ...codes);
  const ok = u && phoneKey(u.phone) && phoneKey(u.phone) === phoneKey(link.phone);
  if (ok) return u;
  db.prepare("UPDATE rep_bot_links SET revoked_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ? AND revoked_at IS NULL").run(link.id);
  db.prepare('DELETE FROM rep_bot_drafts WHERE link_id = ?').run(link.id);
  return null;
}

function defaultIsLocked(db) {
  // Как attachControl в gate.js: сбой самой проверки лицензии клинику не запирает.
  try { return !!controlState(db, getDataDir()).locked; } catch { return false; }
}

// ---------------------------------------------------------------------------
// Анкета
// ---------------------------------------------------------------------------
function readDraft(db, chatId) {
  const r = db.prepare('SELECT * FROM rep_bot_drafts WHERE chat_id = ?').get(String(chatId));
  if (!r) return null;
  let draft = {};
  try { draft = JSON.parse(r.draft) || {}; } catch { draft = {}; }
  return { step: r.step, draft, link_id: r.link_id };
}
function writeDraft(db, chatId, linkId, step, draft) {
  db.prepare(`INSERT INTO rep_bot_drafts (chat_id, link_id, step, draft, updated_at)
              VALUES (?,?,?,?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
              ON CONFLICT(chat_id) DO UPDATE SET link_id = excluded.link_id, step = excluded.step,
                draft = excluded.draft, updated_at = excluded.updated_at`)
    .run(String(chatId), linkId, step, JSON.stringify(draft));
}
function dropDraft(db, chatId) {
  db.prepare('DELETE FROM rep_bot_drafts WHERE chat_id = ?').run(String(chatId));
}

/** Убрать управляющие символы и лишние пробелы; '' — пусто. */
export function cleanText(s) {
  return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** «Каримов Азиз Бахтиёрович» → части имени, как их собирает форма «Настроек». null — меньше двух слов. */
export function splitFio(text) {
  const parts = cleanText(text).split(' ').filter(Boolean);
  if (parts.length < 2) return null;
  const [last_name, first_name, ...rest] = parts;
  const middle_name = rest.join(' ');
  return { last_name, first_name, middle_name, name: [last_name, first_name, middle_name].filter(Boolean).join(' ') };
}

/** Внешний врач с тем же номером (любой — и выключенный), или null. */
export function findSourceWithPhone(db, rawPhone) {
  const key = phoneKey(rawPhone);
  if (!key) return null;
  const rows = db.prepare(`SELECT id, name, code, phone FROM referral_sources
                            WHERE doctor_id IS NULL AND COALESCE(phone, '') <> ''`).all();
  return rows.find((r) => phoneKey(r.phone) === key) || null;
}

export function summary(d) {
  const line = (label, v) => `${label}: ${v ? esc(v) : '—'}`;
  return [
    '<b>Проверьте данные врача · Ma’lumotlarni tekshiring</b>',
    '',
    line('ФИО', d.name),
    line('Телефон', d.phone),
    line('Специальность', d.specialty),
    line('Место работы', d.workplace),
    line('Район', d.district),
  ].join('\n');
}
const confirmMarkup = { inline_keyboard: [[{ text: T.saveBtn, callback_data: 'save' }, { text: T.cancelBtn, callback_data: 'cancel' }]] };

async function askNext(db, token, chatId, linkId, draft, fromIndex, deps) {
  if (fromIndex < OPTIONAL_STEPS.length) {
    const [step, question] = OPTIONAL_STEPS[fromIndex];
    writeDraft(db, chatId, linkId, step, draft);
    return sendMessage(token, chatId, question, { reply_markup: stepKeyboard }, deps);
  }
  writeDraft(db, chatId, linkId, 'confirm', draft);
  // Клавиатура шагов уходит, решение — кнопками под сводкой.
  await sendMessage(token, chatId, T.almost, { reply_markup: removeKeyboard }, deps);
  return sendMessage(token, chatId, summary(draft), { reply_markup: confirmMarkup }, deps);
}

async function handleDraftAnswer(db, token, msg, link, cur, deps) {
  const chatId = msg.chat.id;
  const raw = typeof msg.text === 'string' ? msg.text : null;
  const step = cur.step;
  const draft = cur.draft;

  if (step === 'confirm') {
    return sendMessage(token, chatId, summary(draft), { reply_markup: confirmMarkup }, deps);
  }
  if (raw === null) {
    return sendMessage(token, chatId, T.needText, { reply_markup: step === 'name' ? nameKeyboard : stepKeyboard }, deps);
  }
  const text = cleanText(raw);
  const skip = text === T.skipBtn || text.toLowerCase() === '/skip';

  if (step === 'name') {
    const fio = text.length <= NAME_MAX && !skip ? splitFio(text) : null;
    if (!fio) return sendMessage(token, chatId, T.badName, { reply_markup: nameKeyboard }, deps);
    return askNext(db, token, chatId, link.id, { ...draft, ...fio }, 0, deps);
  }

  const idx = OPTIONAL_STEPS.findIndex(([s]) => s === step);
  if (idx < 0) { dropDraft(db, chatId); return sendMessage(token, chatId, T.menu, { reply_markup: menuKeyboard }, deps); }
  if (skip) return askNext(db, token, chatId, link.id, { ...draft, [step]: '' }, idx + 1, deps);
  if (text.length > FIELD_MAX) return sendMessage(token, chatId, T.tooLong, { reply_markup: stepKeyboard }, deps);

  if (step === 'phone') {
    if (!isWholeUzPhone(digitsOf(text))) return sendMessage(token, chatId, T.badPhone, { reply_markup: stepKeyboard }, deps);
    const dup = findSourceWithPhone(db, text);
    if (dup) {
      dropDraft(db, chatId);
      return sendMessage(token, chatId, T.duplicate(dup.name, dup.code), { reply_markup: menuKeyboard }, deps);
    }
    return askNext(db, token, chatId, link.id, { ...draft, phone: uzE164(text) }, idx + 1, deps);
  }
  return askNext(db, token, chatId, link.id, { ...draft, [step]: text }, idx + 1, deps);
}

/**
 * «Сохранить»: врач — в referral_sources, закреплённым за представителем;
 * номер «0001» выдаёт триггер мигр. 121, как при заведении из «Настроек».
 * Дубль номера проверяется ещё раз — между вопросом и кнопкой врача мог
 * завести кто-то другой.
 */
export function saveDraftedSource(db, { chatId, link, rep, draft }) {
  return db.transaction(() => {
    if (draft.phone) {
      const dup = findSourceWithPhone(db, draft.phone);
      if (dup) return { duplicate: dup };
    }
    const r = db.prepare(`INSERT INTO referral_sources
        (name, last_name, first_name, middle_name, phone, specialty, workplace, district, representative_id, active)
        VALUES (?,?,?,?,?,?,?,?,?, 1)`).run(
      draft.name, draft.last_name || null, draft.first_name || null, draft.middle_name || null,
      draft.phone || null, draft.specialty || null, draft.workplace || null, draft.district || null, rep.id);
    const id = Number(r.lastInsertRowid);
    db.prepare('INSERT INTO rep_bot_additions (referral_source_id, user_id, link_id, chat_id) VALUES (?,?,?,?)')
      .run(id, rep.id, link.id, String(chatId));
    dropDraft(db, chatId);
    return { source: db.prepare('SELECT id, name, code FROM referral_sources WHERE id = ?').get(id) };
  })();
}

function myDoctorsText(db, repId) {
  const rows = db.prepare(`SELECT code, name, phone FROM referral_sources
                            WHERE doctor_id IS NULL AND active = 1 AND representative_id = ?
                            ORDER BY name`).all(repId);
  if (!rows.length) return T.noDoctors;
  const lines = [`<b>Ваши врачи · Shifokorlaringiz: ${rows.length}</b>`, ''];
  for (const r of rows.slice(0, MY_DOCTORS_SHOWN)) {
    lines.push(`№ ${esc(r.code || '—')} · ${esc(r.name)}${r.phone ? ' · ' + esc(r.phone) : ''}`);
  }
  if (rows.length > MY_DOCTORS_SHOWN) lines.push('', `… и ещё ${rows.length - MY_DOCTORS_SHOWN}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Вход
// ---------------------------------------------------------------------------
export async function handleUpdate(db, token, update, deps = {}) {
  if (update.message) return handleMessage(db, token, update.message, deps);
  if (update.callback_query) return handleCallback(db, token, update.callback_query, deps);
  return null;
}

async function handleMessage(db, token, msg, deps) {
  const chatId = msg.chat && msg.chat.id;
  if (!chatId) return null;
  // Бот — для личной переписки представителя; в группе номер «кнопкой»
  // и анкета теряют смысл, а сводка врача ушла бы всем участникам.
  if (msg.chat.type && msg.chat.type !== 'private') return null;
  if (msg.contact) return handleContact(db, token, msg, deps);

  const link = activeLink(db, chatId);
  if (!link) return sendMessage(token, chatId, T.greeting, { reply_markup: contactKeyboard }, deps);
  const rep = repOfLink(db, link);
  if (!rep) return sendMessage(token, chatId, T.revoked, { reply_markup: contactKeyboard }, deps);
  db.prepare("UPDATE rep_bot_links SET last_seen_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?").run(link.id);
  if (link.status !== 'confirmed') {
    return sendMessage(token, chatId, T.pending(rep.full_name), { reply_markup: removeKeyboard }, deps);
  }

  const text = cleanText(msg.text);
  const cmd = text.toLowerCase().split('@')[0];
  if (text === T.cancelBtn || cmd === '/cancel') {
    const had = readDraft(db, chatId);
    dropDraft(db, chatId);
    return sendMessage(token, chatId, had ? T.cancelled : T.menu, { reply_markup: menuKeyboard }, deps);
  }
  if (text === T.addBtn || cmd === '/add') {
    writeDraft(db, chatId, link.id, 'name', {});
    return sendMessage(token, chatId, T.askName, { reply_markup: nameKeyboard }, deps);
  }
  if (text === T.myBtn || cmd === '/my') {
    return sendMessage(token, chatId, myDoctorsText(db, rep.id), { reply_markup: menuKeyboard }, deps);
  }
  if (cmd === '/start' || cmd === '/help') {
    dropDraft(db, chatId);
    return sendMessage(token, chatId, T.linked(rep.full_name), { reply_markup: menuKeyboard }, deps);
  }

  const cur = readDraft(db, chatId);
  if (cur && cur.link_id === link.id) return handleDraftAnswer(db, token, msg, link, cur, deps);
  if (cur) dropDraft(db, chatId);   // анкета прежней связки этого чата
  return sendMessage(token, chatId, T.menu, { reply_markup: menuKeyboard }, deps);
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

  const matches = findRepsByPhone(db, contact.phone_number);
  if (!matches.length) return sendMessage(token, chatId, T.unknown, { reply_markup: contactKeyboard }, deps);
  if (matches.length > 1) return sendMessage(token, chatId, T.ambiguous, { reply_markup: removeKeyboard }, deps);
  const rep = matches[0];

  // Тот же сотрудник с того же чата и номера ещё раз — связка как есть:
  // повторная кнопка не сбрасывает подтверждение клиники.
  const cur = activeLink(db, chatId);
  if (cur && cur.user_id === rep.id && phoneKey(cur.phone) === phoneKey(digits)) {
    db.prepare("UPDATE rep_bot_links SET last_seen_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?").run(cur.id);
    return cur.status === 'confirmed'
      ? sendMessage(token, chatId, T.linked(rep.full_name), { reply_markup: menuKeyboard }, deps)
      : sendMessage(token, chatId, T.pending(rep.full_name), { reply_markup: removeKeyboard }, deps);
  }

  const name = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ');
  db.transaction(() => {
    // Один представитель — один чат, один чат — один представитель.
    db.prepare(`UPDATE rep_bot_links SET revoked_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
                 WHERE revoked_at IS NULL AND (chat_id = ? OR user_id = ?)`).run(String(chatId), rep.id);
    dropDraft(db, chatId);
    db.prepare(`INSERT INTO rep_bot_links (user_id, chat_id, phone, tg_user_id, tg_username, tg_name, last_seen_at, status)
                VALUES (?,?,?,?,?,?, strftime('%Y-%m-%dT%H:%M:%SZ','now'), 'pending')`)
      .run(rep.id, String(chatId), digits, String(fromId), msg.from.username || '', name);
  })();
  return sendMessage(token, chatId, T.pending(rep.full_name), { reply_markup: removeKeyboard }, deps);
}

// Кнопки под сводкой. callback_data — только 'save' / 'cancel': анкета берётся
// по chat_id этого же чата, а не по номеру из кнопки (callback_data приходит
// снаружи). Повторное нажатие «Сохранить» анкеты уже не находит.
async function handleCallback(db, token, cq, deps) {
  const data = String(cq.data || '');
  const chatId = cq.message && cq.message.chat && cq.message.chat.id;
  if (!chatId || (data !== 'save' && data !== 'cancel')) return ackQuietly(token, cq.id, '', deps);

  const link = activeLink(db, chatId);
  const rep = link ? repOfLink(db, link) : null;
  if (!link || !rep || link.status !== 'confirmed') {
    await ackQuietly(token, cq.id, '', deps);
    return sendMessage(token, chatId, link && rep ? T.pending(rep.full_name) : T.revoked, { reply_markup: link && rep ? removeKeyboard : contactKeyboard }, deps);
  }
  const cur = readDraft(db, chatId);
  if (!cur || cur.step !== 'confirm' || cur.link_id !== link.id) {
    await ackQuietly(token, cq.id, '', deps);
    return sendMessage(token, chatId, T.nothingToSave, { reply_markup: menuKeyboard }, deps);
  }
  if (data === 'cancel') {
    dropDraft(db, chatId);
    await ackQuietly(token, cq.id, '', deps);
    return sendMessage(token, chatId, T.cancelled, { reply_markup: menuKeyboard }, deps);
  }

  const isLocked = deps.isLocked || defaultIsLocked;
  if (isLocked(db)) {
    await ackQuietly(token, cq.id, '', deps);
    return sendMessage(token, chatId, T.locked, { reply_markup: menuKeyboard }, deps);
  }
  const res = saveDraftedSource(db, { chatId, link, rep, draft: cur.draft });
  await ackQuietly(token, cq.id, '', deps);
  if (res.duplicate) {
    dropDraft(db, chatId);
    return sendMessage(token, chatId, T.duplicate(res.duplicate.name, res.duplicate.code), { reply_markup: menuKeyboard }, deps);
  }
  return sendMessage(token, chatId, T.saved(res.source.name, res.source.code || ''), { reply_markup: menuKeyboard }, deps);
}
