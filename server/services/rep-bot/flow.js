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
// АНКЕТА. ФИО → телефон → специальность → место работы → район → тип оплаты
// (→ номер карты) → «Сохранить». REP_BOT_CLAIMS_V1 (2026-11-20) — владелец:
// «here we need all data in terms of where doctor work, speciality and others».
// Раньше всё, кроме ФИО, можно было пропустить, и из бота приходили врачи без
// телефона, места работы и способа выплаты — их потом дописывали руками в
// «Настройках». Теперь обязательно всё; кнопки «Пропустить» нет, «Отмена» есть
// всегда. Специальность — только из списка клиники (specialty-list.js, тот же,
// что выпадающий список карточки источника): «терапевт», «Терапевт» и
// «терапевт-участковый» в ведомости по специальностям стали бы тремя
// строками. Анкета хранится в rep_bot_drafts, не в
// памяти: перезапуск сервера посреди анкеты её не теряет. Врач с тем же
// номером уже есть — второго не заводим: два врача с одним номером не смогут
// подключиться к боту врачей (там такой номер — «ничей»), а в ведомости
// появится двойник. REP_BOT_CLAIMS_V1 — вместо отказа заводится заявка на
// закрепление существующего врача (rep_bot_claims, мигр. 293); решает её
// администратор на вкладке «Бот представителей» (rpc/rep-bot.js).
//
// ЛИЦЕНЗИЯ. Просроченная клиника читает, но не пишет (gate.js); бот — тоже
// запись, поэтому перед сохранением спрашивается то же состояние лицензии.
import { sendMessage, ackQuietly } from '../telegram/api.js';
import { phoneKey, digitsOf, isWholeUzPhone, uzE164 } from '../../../public/js/admin/views/crm-phone-match.js';
import { representativeCodes } from '../rpc/referrals.js';
import { controlState } from '../control/state.js';
import { getDataDir } from '../control/config.js';
import { SPECIALTY_ROWS } from '../../../public/js/shared/specialty-list.js';

const NAME_MAX = 120;
const FIELD_MAX = 120;
const MY_DOCTORS_SHOWN = 30;
const SPECIALTY_BUTTONS = 8;   // REP_BOT_CLAIMS_V1 — больше кнопок под сообщением телефон не уместит

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
  askPhone: 'Телефон врача, например +998 90 123 45 67. По этому номеру врач потом подключится к боту для врачей.\nShifokor telefoni, masalan +998 90 123 45 67.',
  badPhone: 'Это не похоже на узбекский номер. Введите номер целиком, например +998 90 123 45 67.\nRaqamni to‘liq kiriting, masalan +998 90 123 45 67.',
  // REP_BOT_CLAIMS_V1 — совпадение номера: вместо «попросите администратора»
  // (о просьбе администратор не узнавал) — заявка, которую он видит на вкладке.
  claimSent: (name, code) => [
    `Врач с этим номером уже есть в клинике: ${esc(name)}${code ? ', № ' + esc(code) : ''}. Заявка на закрепление отправлена администратору.`,
    '',
    `Bu raqamli shifokor klinikada allaqachon bor: ${esc(name)}${code ? ', № ' + esc(code) : ''}. Biriktirish so‘rovi administratorga yuborildi.`,
  ].join('\n'),
  alreadyYours: (name, code) => [
    `Врач с этим номером уже есть в клинике: ${esc(name)}${code ? ', № ' + esc(code) : ''}. Он уже закреплён за вами.`,
    '',
    `Bu raqamli shifokor klinikada allaqachon bor: ${esc(name)}${code ? ', № ' + esc(code) : ''}. U allaqachon sizga biriktirilgan.`,
  ].join('\n'),
  claimLocked: 'Клиника сейчас не принимает изменения (лицензия). Заявка на закрепление не отправлена — попробуйте позже.\nKlinika hozir o‘zgarishlarni qabul qilmayapti. So‘rov yuborilmadi — keyinroq urinib ko‘ring.',
  // Сообщения о решении администратора (rpc/rep-bot.js repBotClaimDecide).
  claimApproved: (name, code) => [
    `Врач № ${esc(code)} (${esc(name)}) закреплён за вами.`,
    '',
    `№ ${esc(code)} shifokor (${esc(name)}) sizga biriktirildi.`,
  ].join('\n'),
  claimRejected: (name, code) => [
    `Заявка на врача № ${esc(code)} (${esc(name)}) отклонена.`,
    '',
    `№ ${esc(code)} shifokor (${esc(name)}) bo‘yicha so‘rov rad etildi.`,
  ].join('\n'),
  claimMoved: (name, code) => [
    `Врач № ${esc(code)} (${esc(name)}) передан другому представителю.`,
    '',
    `№ ${esc(code)} shifokor (${esc(name)}) boshqa vakilga o‘tkazildi.`,
  ].join('\n'),
  // Заявка закрыта, потому что администратор подтвердил чужую заявку на того же врача.
  claimTaken: (name, code) => [
    `Врач № ${esc(code)} (${esc(name)}) закреплён за другим представителем.`,
    '',
    `№ ${esc(code)} shifokor (${esc(name)}) boshqa vakilga biriktirildi.`,
  ].join('\n'),
  askSpecialty: 'Специальность врача — напишите часть названия (например: «тера» или «кард»), бот предложит варианты из списка клиники.\nShifokor mutaxassisligi — nomining bir qismini yozing (masalan: «tera» yoki «kard»), bot klinika ro‘yxatidan variantlarni taklif qiladi.',
  pickSpecialty: 'Выберите специальность кнопкой. Нет нужной — напишите название иначе.\nMutaxassislikni tugma orqali tanlang. Kerakligi yo‘q bo‘lsa — nomini boshqacha yozing.',
  pickSpecialtyMore: (n) => `Найдено ${n} — показаны первые ${SPECIALTY_BUTTONS}. Выберите кнопкой или напишите точнее.\n${n} ta topildi — birinchi ${SPECIALTY_BUTTONS} tasi ko‘rsatildi. Tugma orqali tanlang yoki aniqroq yozing.`,
  specialtyShort: 'Напишите хотя бы 2 буквы названия специальности.\nMutaxassislik nomidan kamida 2 ta harf yozing.',
  noSpecialty: 'В списке клиники такой специальности не нашлось. Напишите иначе — например, «хирург», «невро», «педиатр».\nKlinika ro‘yxatida bunday mutaxassislik topilmadi. Boshqacha yozing — masalan, «jarroh», «nevro», «pediatr».',
  askWorkplace: 'Место работы — поликлиника, больница.\nIsh joyi — poliklinika, kasalxona.',
  askDistrict: 'Район.\nTuman.',
  askPayment: 'Как выплачивать вознаграждение? Выберите кнопкой.\nMukofot qanday to‘lanadi? Tugma orqali tanlang.',
  askCard: 'Номер карты врача — 16 цифр (можно с пробелами).\nShifokor karta raqami — 16 ta raqam (bo‘sh joy bilan mumkin).',
  badCard: 'Номер карты — ровно 16 цифр, например 8600 1234 5678 9012.\nKarta raqami — aniq 16 ta raqam.',
  required: 'Этот вопрос обязательный — пропустить нельзя. Чтобы не добавлять врача — «Отмена».\nBu savol majburiy — o‘tkazib bo‘lmaydi. Qo‘shmaslik uchun — «Bekor qilish».',
  stale: 'Анкета устарела (бот обновился) — начните заново: «Добавить врача».\nAnketa eskirdi — qaytadan boshlang: «Shifokor qo‘shish».',
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
// REP_BOT_CLAIMS_V1 — у каждого вопроса анкеты одна кнопка: «Отмена». T.skipBtn
// остался в T только затем, чтобы нажатие на кнопку старой клавиатуры (она
// висит у представителя до следующего ответа бота) узналось и получило
// «пропустить нельзя», а не записалось местом работы «Пропустить».
const cancelKeyboard = { keyboard: [[{ text: T.cancelBtn }]], resize_keyboard: true };

// REP_BOT_CLAIMS_V1 — тип оплаты: те же значения и подписи, что у выпадающего
// списка «Тип оплаты» карточки источника в «Настройках» (settings-hub.js).
export const PAYMENT_TYPES = [
  ['cash', 'Наличные', 'Naqd pul'],
  ['card', 'На карту', 'Kartaga'],
  ['transfer', 'Перечислением', 'O‘tkazma orqali'],
];
const paymentMarkup = { inline_keyboard: PAYMENT_TYPES.map(([v, ru, uz]) => [{ text: `${ru} · ${uz}`, callback_data: 'pay:' + v }]) };

// Порядок вопросов анкеты после ФИО: шаг → [поле, вопрос, разметка].
// 'card' спрашивается только при оплате «На карту» (nextIndex ниже).
const STEPS = [
  ['phone', T.askPhone, cancelKeyboard],
  ['specialty', T.askSpecialty, cancelKeyboard],
  ['workplace', T.askWorkplace, cancelKeyboard],
  ['district', T.askDistrict, cancelKeyboard],
  ['payment', T.askPayment, paymentMarkup],
  ['card', T.askCard, cancelKeyboard],
];
const stepIndex = (step) => STEPS.findIndex(([s]) => s === step);
function nextIndex(idx, draft) {
  let i = idx + 1;
  if (i < STEPS.length && STEPS[i][0] === 'card' && draft.payment_type !== 'card') i += 1;
  return i;
}

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
  const rows = db.prepare(`SELECT id, name, code, phone, representative_id FROM referral_sources
                            WHERE doctor_id IS NULL AND COALESCE(phone, '') <> ''`).all();
  return rows.find((r) => phoneKey(r.phone) === key) || null;
}

/**
 * REP_BOT_CLAIMS_V1 — заявка на закрепление существующего врача. Врач уже за
 * этим представителем — заявки нет ({ mine: true }). Иначе — открытая заявка
 * пары врач+представитель: прежняя, если есть (повтор анкеты не плодит вторую;
 * частичный уникальный индекс мигр. 293 — страховка), или новая.
 * entered_name — ФИО из анкеты, только для сведения администратору.
 */
export function fileClaim(db, { chatId, link, rep, draft, source }) {
  if (source.representative_id === rep.id) return { mine: true };
  return db.transaction(() => {
    const open = () => db.prepare("SELECT * FROM rep_bot_claims WHERE referral_source_id = ? AND user_id = ? AND status = 'pending'")
      .get(source.id, rep.id);
    const had = open();
    if (had) return { claim: had, reused: true };
    db.prepare('INSERT INTO rep_bot_claims (referral_source_id, user_id, link_id, chat_id, entered_name) VALUES (?,?,?,?,?)')
      .run(source.id, rep.id, link.id, String(chatId), String((draft && draft.name) || '').slice(0, NAME_MAX));
    return { claim: open(), reused: false };
  })();
}

/** Ответ на совпадение номера — на шаге «Телефон» и при «Сохранить». Анкета закрывается в любом случае. */
async function answerDuplicate(db, token, { chatId, link, rep, draft, source }, deps) {
  dropDraft(db, chatId);
  if (source.representative_id === rep.id) {
    return sendMessage(token, chatId, T.alreadyYours(source.name, source.code), { reply_markup: menuKeyboard }, deps);
  }
  // Заявка — тоже запись: просроченная клиника её не принимает, как и врача.
  const isLocked = deps.isLocked || defaultIsLocked;
  if (isLocked(db)) return sendMessage(token, chatId, T.claimLocked, { reply_markup: menuKeyboard }, deps);
  fileClaim(db, { chatId, link, rep, draft, source });
  return sendMessage(token, chatId, T.claimSent(source.name, source.code), { reply_markup: menuKeyboard }, deps);
}

// REP_BOT_CLAIMS_V1 — поиск специальности. Представитель пишет часть названия
// на любом из трёх языков; сравнение без регистра, «ё» = «е», все виды
// узбекского апострофа (‘ ’ ʻ ʼ `) — один. Сначала — названия, которые
// начинаются с написанного («тера» → «Терапевт» раньше «Физиотерапевт»).
const normSp = (s) => String(s == null ? '' : s).toLowerCase().replace(/ё/g, 'е').replace(/[‘’ʻʼ`']/g, "'").replace(/\s+/g, ' ').trim();
const SPECIALTY_INDEX = SPECIALTY_ROWS.map((r, i) => ({ i, labels: [r.ru, r.uz, r.en].map(normSp) }));

/** Индексы SPECIALTY_ROWS, подходящие под написанное; [] — меньше двух букв или ничего. */
export function specialtyMatches(query) {
  const q = normSp(query);
  if (q.length < 2) return [];
  const starts = [];
  const inside = [];
  for (const row of SPECIALTY_INDEX) {
    if (row.labels.some((l) => l.startsWith(q))) starts.push(row.i);
    else if (row.labels.some((l) => l.includes(q))) inside.push(row.i);
  }
  return [...starts, ...inside];
}

/** Номер карты: цифры без пробелов и дефисов, ровно 16; иначе null. */
export function cardDigits(text) {
  const s = String(text == null ? '' : text).trim();
  if (!/^[\d\s-]+$/.test(s)) return null;
  const d = s.replace(/\D/g, '');
  return d.length === 16 ? d : null;
}
const cardShown = (d) => String(d || '').replace(/(\d{4})(?=\d)/g, '$1 ');
const paymentLabel = (v) => {
  const p = PAYMENT_TYPES.find(([x]) => x === v);
  return p ? `${p[1]} · ${p[2]}` : '';
};

/**
 * Анкета заполнена целиком. Анкета, начатая до REP_BOT_CLAIMS_V1, могла дойти
 * до сводки с пропущенным телефоном и без типа оплаты — её шаг «confirm» есть
 * и сейчас, поэтому «шаг устарел» её не ловит; ловит эта проверка перед
 * сохранением.
 */
export function draftComplete(d) {
  if (!d || !d.name || !d.first_name) return false;
  if (!d.phone || !isWholeUzPhone(digitsOf(d.phone))) return false;
  if (!SPECIALTY_ROWS.some((r) => r.ru === d.specialty)) return false;
  if (!d.workplace || !d.district) return false;
  if (!PAYMENT_TYPES.some(([v]) => v === d.payment_type)) return false;
  if (d.payment_type === 'card' && !cardDigits(d.card_number)) return false;
  return true;
}

export function summary(d) {
  const line = (label, v) => `${label}: ${v ? esc(v) : '—'}`;
  const out = [
    '<b>Проверьте данные врача · Ma’lumotlarni tekshiring</b>',
    '',
    line('ФИО', d.name),
    line('Телефон', d.phone),
    line('Специальность', d.specialty),
    line('Место работы', d.workplace),
    line('Район', d.district),
    line('Тип оплаты', paymentLabel(d.payment_type)),
  ];
  // Номер карты — целиком, группами по 4: сводка для того и показывается,
  // чтобы представитель увидел опечатку до «Сохранить».
  if (d.payment_type === 'card') out.push(line('Номер карты', cardShown(d.card_number)));
  return out.join('\n');
}
const confirmMarkup = { inline_keyboard: [[{ text: T.saveBtn, callback_data: 'save' }, { text: T.cancelBtn, callback_data: 'cancel' }]] };

function specialtyMarkup(indexes) {
  return { inline_keyboard: indexes.slice(0, SPECIALTY_BUTTONS).map((i) => [{ text: SPECIALTY_ROWS[i].ru, callback_data: 'sp:' + i }]) };
}

async function askNext(db, token, chatId, linkId, draft, fromIndex, deps) {
  if (fromIndex < STEPS.length) {
    const [step, question, markup] = STEPS[fromIndex];
    writeDraft(db, chatId, linkId, step, draft);
    return sendMessage(token, chatId, question, { reply_markup: markup }, deps);
  }
  writeDraft(db, chatId, linkId, 'confirm', draft);
  // Клавиатура шагов уходит, решение — кнопками под сводкой.
  await sendMessage(token, chatId, T.almost, { reply_markup: removeKeyboard }, deps);
  return sendMessage(token, chatId, summary(draft), { reply_markup: confirmMarkup }, deps);
}

async function handleDraftAnswer(db, token, msg, link, rep, cur, deps) {
  const chatId = msg.chat.id;
  const raw = typeof msg.text === 'string' ? msg.text : null;
  const step = cur.step;
  const draft = cur.draft;

  if (step === 'confirm') {
    return sendMessage(token, chatId, summary(draft), { reply_markup: confirmMarkup }, deps);
  }
  const idx = stepIndex(step);
  if (step !== 'name' && idx < 0) {
    // Шаг, которого в анкете больше нет (анкета начата прежней версией бота).
    dropDraft(db, chatId);
    return sendMessage(token, chatId, T.menu, { reply_markup: menuKeyboard }, deps);
  }
  const markup = step === 'name' ? cancelKeyboard : STEPS[idx][2];
  if (raw === null) return sendMessage(token, chatId, T.needText, { reply_markup: markup }, deps);
  const text = cleanText(raw);
  const skip = text === T.skipBtn || text.toLowerCase() === '/skip';

  if (step === 'name') {
    const fio = text.length <= NAME_MAX && !skip ? splitFio(text) : null;
    if (!fio) return sendMessage(token, chatId, T.badName, { reply_markup: cancelKeyboard }, deps);
    return askNext(db, token, chatId, link.id, { ...draft, ...fio }, 0, deps);
  }

  // REP_BOT_CLAIMS_V1 — всё обязательно: «Пропустить» (кнопка старой клавиатуры
  // или /skip) — не ответ, а повтор вопроса.
  if (skip) return sendMessage(token, chatId, T.required + '\n\n' + STEPS[idx][1], { reply_markup: markup }, deps);
  if (text.length > FIELD_MAX) return sendMessage(token, chatId, T.tooLong, { reply_markup: markup }, deps);

  if (step === 'phone') {
    if (!isWholeUzPhone(digitsOf(text))) return sendMessage(token, chatId, T.badPhone, { reply_markup: cancelKeyboard }, deps);
    const dup = findSourceWithPhone(db, text);
    if (dup) return answerDuplicate(db, token, { chatId, link, rep, draft, source: dup }, deps);
    return askNext(db, token, chatId, link.id, { ...draft, phone: uzE164(text) }, nextIndex(idx, draft), deps);
  }
  if (step === 'specialty') {
    // Текст — это поиск; сохраняется только выбор кнопкой (handleCallback, 'sp:').
    // Одна буква — не «не нашлось», а «напишите больше»: иначе представитель
    // решит, что такой специальности в клинике нет.
    if (normSp(text).length < 2) return sendMessage(token, chatId, T.specialtyShort, { reply_markup: cancelKeyboard }, deps);
    const found = specialtyMatches(text);
    if (!found.length) return sendMessage(token, chatId, T.noSpecialty, { reply_markup: cancelKeyboard }, deps);
    const head = found.length > SPECIALTY_BUTTONS ? T.pickSpecialtyMore(found.length) : T.pickSpecialty;
    return sendMessage(token, chatId, head, { reply_markup: specialtyMarkup(found) }, deps);
  }
  if (step === 'payment') {
    // Тип оплаты — только кнопкой: текст «карта» / «karta» гадать не будем.
    return sendMessage(token, chatId, T.askPayment, { reply_markup: paymentMarkup }, deps);
  }
  if (step === 'card') {
    const digits = cardDigits(text);
    if (!digits) return sendMessage(token, chatId, T.badCard, { reply_markup: cancelKeyboard }, deps);
    return askNext(db, token, chatId, link.id, { ...draft, card_number: digits }, nextIndex(idx, draft), deps);
  }
  return askNext(db, token, chatId, link.id, { ...draft, [step]: text }, nextIndex(idx, draft), deps);
}

/**
 * «Сохранить»: врач — в referral_sources, закреплённым за представителем;
 * номер «0001» выдаёт триггер мигр. 121, как при заведении из «Настроек».
 * Дубль номера проверяется ещё раз — между вопросом и кнопкой врача мог
 * завести кто-то другой.
 */
export function saveDraftedSource(db, { chatId, link, rep, draft }) {
  return db.transaction(() => {
    if (!draftComplete(draft)) { dropDraft(db, chatId); return { stale: true }; }
    if (draft.phone) {
      const dup = findSourceWithPhone(db, draft.phone);
      if (dup) return { duplicate: dup };
    }
    // REP_BOT_CLAIMS_V1 — тип оплаты и номер карты пишутся вместе с остальным;
    // номер карты — только при «На карту» (как beforeSave формы «Настроек»).
    const r = db.prepare(`INSERT INTO referral_sources
        (name, last_name, first_name, middle_name, phone, specialty, workplace, district, payment_type, card_number, representative_id, active)
        VALUES (?,?,?,?,?,?,?,?,?,?,?, 1)`).run(
      draft.name, draft.last_name || null, draft.first_name || null, draft.middle_name || null,
      draft.phone || null, draft.specialty || null, draft.workplace || null, draft.district || null,
      draft.payment_type, draft.payment_type === 'card' ? draft.card_number : null, rep.id);
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
    return sendMessage(token, chatId, T.askName, { reply_markup: cancelKeyboard }, deps);
  }
  if (text === T.myBtn || cmd === '/my') {
    return sendMessage(token, chatId, myDoctorsText(db, rep.id), { reply_markup: menuKeyboard }, deps);
  }
  if (cmd === '/start' || cmd === '/help') {
    dropDraft(db, chatId);
    return sendMessage(token, chatId, T.linked(rep.full_name), { reply_markup: menuKeyboard }, deps);
  }

  const cur = readDraft(db, chatId);
  if (cur && cur.link_id === link.id) return handleDraftAnswer(db, token, msg, link, rep, cur, deps);
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
//
// REP_BOT_CLAIMS_V1 — ещё две кнопки анкеты: 'sp:<i>' (специальность — индекс в
// SPECIALTY_ROWS, не текст: callback_data приходит снаружи, а текст кнопки
// Telegram в ответе и не присылает) и 'pay:<тип>'. Обе принимаются, только
// если анкета этого чата стоит на своём шаге; старая кнопка под давним
// сообщением тихо гасится.
const SP_RE = /^sp:(\d{1,4})$/;
const PAY_RE = /^pay:([a-z]+)$/;
async function handleCallback(db, token, cq, deps) {
  const data = String(cq.data || '');
  const chatId = cq.message && cq.message.chat && cq.message.chat.id;
  const known = data === 'save' || data === 'cancel' || SP_RE.test(data) || PAY_RE.test(data);
  if (!chatId || !known) return ackQuietly(token, cq.id, '', deps);

  const link = activeLink(db, chatId);
  const rep = link ? repOfLink(db, link) : null;
  if (!link || !rep || link.status !== 'confirmed') {
    await ackQuietly(token, cq.id, '', deps);
    return sendMessage(token, chatId, link && rep ? T.pending(rep.full_name) : T.revoked, { reply_markup: link && rep ? removeKeyboard : contactKeyboard }, deps);
  }
  if (data !== 'save' && data !== 'cancel') return handleStepButton(db, token, cq, chatId, link, data, deps);
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
  // Нажатие гасится ДО записи: упади saveDraftedSource (ошибка базы) —
  // у представителя не должно остаться вечное «часики» на кнопке.
  await ackQuietly(token, cq.id, '', deps);
  const res = saveDraftedSource(db, { chatId, link, rep, draft: cur.draft });
  if (res.stale) return sendMessage(token, chatId, T.stale, { reply_markup: menuKeyboard }, deps);
  // Номер успел занять другой врач, пока шла анкета, — то же правило, что на шаге «Телефон».
  if (res.duplicate) return answerDuplicate(db, token, { chatId, link, rep, draft: cur.draft, source: res.duplicate }, deps);
  return sendMessage(token, chatId, T.saved(res.source.name, res.source.code || ''), { reply_markup: menuKeyboard }, deps);
}

/**
 * Повторить вопрос, на котором стоит анкета. Нужен для старой кнопки под
 * давним сообщением: молчание в ответ на нажатие выглядит как «бот сломался»,
 * а повтор вопроса показывает, чего бот ждёт сейчас.
 */
function repeatQuestion(db, token, chatId, cur, deps) {
  if (cur.step === 'confirm') return sendMessage(token, chatId, summary(cur.draft), { reply_markup: confirmMarkup }, deps);
  if (cur.step === 'name') return sendMessage(token, chatId, T.askName, { reply_markup: cancelKeyboard }, deps);
  const idx = stepIndex(cur.step);
  if (idx < 0) return null;
  return sendMessage(token, chatId, STEPS[idx][1], { reply_markup: STEPS[idx][2] }, deps);
}

/** REP_BOT_CLAIMS_V1 — кнопки специальности ('sp:<i>') и типа оплаты ('pay:<тип>'). */
async function handleStepButton(db, token, cq, chatId, link, data, deps) {
  await ackQuietly(token, cq.id, '', deps);
  const cur = readDraft(db, chatId);
  if (!cur || cur.link_id !== link.id) return null;
  const sp = SP_RE.exec(data);
  if (sp) {
    const i = Number(sp[1]);
    if (cur.step !== 'specialty' || !Number.isInteger(i) || i < 0 || i >= SPECIALTY_ROWS.length) return repeatQuestion(db, token, chatId, cur, deps);
    // Хранится русское название — как у выпадающего списка «Настроек».
    const draft = { ...cur.draft, specialty: SPECIALTY_ROWS[i].ru };
    return askNext(db, token, chatId, link.id, draft, nextIndex(stepIndex('specialty'), draft), deps);
  }
  const pay = PAY_RE.exec(data);
  if (pay) {
    const v = pay[1];
    if (cur.step !== 'payment' || !PAYMENT_TYPES.some(([x]) => x === v)) return repeatQuestion(db, token, chatId, cur, deps);
    const draft = { ...cur.draft, payment_type: v };
    if (v !== 'card') delete draft.card_number;
    return askNext(db, token, chatId, link.id, draft, nextIndex(stepIndex('payment'), draft), deps);
  }
  return null;
}
