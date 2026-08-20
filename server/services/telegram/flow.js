// TELEGRAM_BOT_V1 — разговор с пациентом.
//
// Весь сценарий: /start → кнопка «Поделиться номером» → список пациентов на
// этом номере → список документов → PDF. Состояние разговора нигде не
// хранится: каждый шаг несёт всё нужное в callback_data кнопки, поэтому
// перезапуск сервера не ломает диалог на середине.
//
// Тексты двуязычные (русский · узбекский), как в прежнем боте клиники: в
// регистратуре часть пациентов читает по-узбекски.

import { sendMessage, sendDocument, ackQuietly, TelegramError } from './api.js';
import { findPatientsByPhone, listDocuments, buildDocument, digitsOf } from './documents.js';
import { renderPdf } from './render.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Корень проекта считаем от расположения модуля, а не от process.cwd():
// сервер могут запустить ярлыком из любой папки, и тогда cwd указывает мимо.
const ROOT = path.dirname(path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url)))));

const KIND_LABEL = {
  lab: '🧪 Анализы', conclusion: '📋 Заключение', diag: '🩻 Диагностика',
  invoice: '🧾 Счёт', file: '📎 Файл',
};

// Каждая фраза — на двух языках, УЗБЕКСКИЙ ПЕРВЫМ.
//
// Порядок не косметика: у клиники основная масса пациентов читает по-узбекски,
// и то, что стоит первым, читают, а второе пробегают глазами. Интерфейс
// сотрудников и печатные бланки остаются русскими — там читатель другой.
const T = {
  shareBtn: '📱 Raqamni yuborish · Отправить номер',

  needContact: ['👇 Hujjatlarni olish uchun telefon raqamingizni tasdiqlang.',
                '👇 Чтобы получить документы, подтвердите номер телефона.'].join('\n'),

  notOwn: ['⚠️ Iltimos, O‘Z raqamingizni yuboring — «Raqamni yuborish» tugmasi orqali,',
           'boshqa odamning kontakt kartasini emas.',
           '⚠️ Пришлите, пожалуйста, СВОЙ номер — кнопкой «Отправить номер»,',
           'а не карточку другого контакта.'].join('\n'),

  noPatients: ['🔍 Bu raqam bo‘yicha klinikada bemor topilmadi.',
               'На этом номере в клинике никого не нашли.',
               '',
               'Agar ro‘yxatdan o‘tgan bo‘lsangiz, qabulxonaga murojaat qiling — kartangizda boshqa raqam bo‘lishi mumkin.',
               'Если вы уверены, что записаны, обратитесь в регистратуру — возможно, в карте другой номер.'].join('\n'),

  noDocs: ['📭 Hozircha tayyor hujjatlar yo‘q.',
           'Готовых документов пока нет.',
           '',
           'Natija tayyor bo‘lishi bilan bot uni shu yerga o‘zi yuboradi.',
           'Как только результат будет готов, бот пришлёт его сюда сам.'].join('\n'),

  pickPatient: ['👨‍👩‍👧 Bu raqamga bir nechta bemor biriktirilgan. Kimning hujjatlarini ko‘rsatay?',
                'На этом номере записаны несколько человек. Чьи документы показать?'].join('\n'),

  yourDocs: 'Hujjatlaringiz · Ваши документы',
  building: 'Hujjat tayyorlanmoqda… · Готовлю документ…',

  failed: ['❌ Hujjatni tayyorlab bo‘lmadi. Keyinroq urinib ko‘ring yoki qabulxonaga murojaat qiling.',
           'Не удалось подготовить документ. Попробуйте позже или обратитесь в регистратуру.'].join('\n'),

  tooFast: ['⏳ So‘rovlar juda ko‘p. Iltimos, biroz kuting.',
            'Слишком много запросов. Подождите, пожалуйста, немного.'].join('\n'),

  // Свободный текст — это вопрос живому человеку, а не команда боту. Раньше
  // на любое слово бот вываливал список пациентов; теперь он отвечает так, как
  // отвечают в переписке, а само сообщение уходит в «Чат с пациентами».
  gotMessage: ['✅ Xabaringiz qabul qilindi — operator tez orada javob beradi.',
               'Сообщение принято — оператор скоро ответит.',
               '',
               'Hujjatlar uchun quyidagi tugmani bosing.',
               'Для документов нажмите кнопку ниже.'].join('\n'),

  askMessage: ['✍️ Savolingizni shu yerga yozing — operator javob beradi.',
               'Напишите ваш вопрос сюда — оператор ответит.'].join('\n'),

  off: ['Bot vaqtincha o‘chirilgan. Qabulxonaga murojaat qiling.',
        'Бот временно отключён. Обратитесь в регистратуру.'].join('\n'),
};

// Постоянная клавиатура под полем ввода. Она заменила правило «любой текст =
// список пациентов»: пациент должен ВИДЕТЬ, что боту можно сказать, а не
// угадывать. Список пациентов теперь появляется только по кнопке «Мои
// документы», а написанное словами уходит оператору.
const BTN_DOCS = '📄 Hujjatlarim · Мои документы';
const BTN_ASK  = '💬 Klinikaga yozish · Написать в клинику';

const menuKeyboard = {
  keyboard: [[{ text: BTN_DOCS }], [{ text: BTN_ASK }]],
  resize_keyboard: true, is_persistent: true,
};

// Виды документов перечисляем в приветствии — и ровно те, что администратор
// РАЗРЕШИЛ выдавать. Обещать «результаты анализов» боту, которому их выдавать
// запретили, значит с первого экрана соврать пациенту.
const KIND_LINE = {
  lab:        '🧪 Tahlil natijalari · Результаты анализов',
  conclusion: '📋 Shifokor xulosalari · Заключения врачей',
  diag:       '🩻 Diagnostika xulosalari · Диагностические заключения',
  invoice:    '🧾 Hisob-fakturalar · Счета и чеки',
  file:       '📎 Biriktirilgan fayllar · Прикреплённые файлы',
};

function clinicName(db) {
  try {
    const row = db.prepare('SELECT clinic_name FROM doc_settings WHERE id = 1').get();
    return (row && row.clinic_name) || '';
  } catch { return ''; }
}

// Приветствие собирается на лету: название клиники и перечень видов документов
// берутся из настроек, поэтому текст не может разойтись с тем, что бот реально
// умеет выдавать.
export function greeting(db) {
  const name = clinicName(db);
  const lines = allowedKinds(db).map((k) => KIND_LINE[k]).filter(Boolean);
  return [
    name ? '🏥 Assalomu alaykum! Bu — «' + name + '» klinikasining rasmiy boti.'
         : '🏥 Assalomu alaykum! Bu — klinikaning rasmiy boti.',
    name ? 'Здравствуйте! Это официальный бот клиники «' + name + '».'
         : 'Здравствуйте! Это официальный бот клиники.',
    '',
    'Bu yerda quyidagilarni olishingiz mumkin:',
    'Здесь вы можете получить:',
    ...(lines.length ? lines : ['📄 Klinika hujjatlari · Документы клиники']),
    '',
    '👇 Boshlash uchun telefon raqamingizni yuboring.',
    '👇 Чтобы начать, отправьте свой номер телефона.',
  ].join('\n');
}

// Клавиатура запроса контакта. request_contact — единственный способ получить
// номер, ПОДТВЕРЖДЁННЫЙ Telegram, а не набранный пациентом руками.
const contactKeyboard = {
  keyboard: [[{ text: T.shareBtn, request_contact: true }]],
  resize_keyboard: true, one_time_keyboard: true,
};

// ---------------------------------------------------------------------------
// Ограничение частоты — на чат
// ---------------------------------------------------------------------------
// Считаем по журналу выдач, а не в памяти: перезапуск сервера не должен
// обнулять лимит, иначе его обходит любой, кто умеет ждать перезапуска.
const RATE_LIMIT = 30;   // документов в час на чат
function rateExceeded(db, chatId) {
  const row = db.prepare(
    `SELECT COUNT(*) c FROM telegram_deliveries
      WHERE chat_id = ? AND created_at > strftime('%Y-%m-%dT%H:%M:%SZ','now','-1 hour')`).get(String(chatId));
  return row.c >= RATE_LIMIT;
}

// ---------------------------------------------------------------------------
// Переписка
// ---------------------------------------------------------------------------
// Сохраняем ОБЕ стороны разговора. Пациенты пишут боту словами («когда будут
// анализы?»), и до появления раздела «Чат с пациентами» эти сообщения никто в
// клинике не видел — бот их молча проглатывал.
export function logMessage(db, chatId, direction, text,
                           { kind = 'text', sentBy = null, tgMessageId = '', filePath = '' } = {}) {
  if (!text) return;
  try {
    db.prepare(
      `INSERT INTO telegram_messages (chat_id, direction, text, kind, sent_by, tg_message_id, file_path)
       VALUES (?,?,?,?,?,?,?)`)
      .run(String(chatId), direction, String(text).slice(0, 4000), kind, sentBy,
           String(tgMessageId || ''), String(filePath || ''));
  } catch (e) {
    // Переписка — журнал, а не сама работа: если запись не удалась, бот обязан
    // продолжить отвечать пациенту.
    console.warn('[telegram] message log:', e.message);
  }
}

// Обёртка над sendMessage: всё, что клиника отправила, попадает в ленту.
// Служебные ответы бота помечены kind='system', поэтому в интерфейсе видно,
// где живой разговор, а где автоматика.
async function reply(db, token, chatId, text, extra = {}, deps = {}, kind = 'system', sentBy = null) {
  const res = await sendMessage(token, chatId, text, extra, deps);
  logMessage(db, chatId, 'out', text, { kind, sentBy, tgMessageId: res && res.message_id });
  return res;
}

export function activeLink(db, chatId) {
  return db.prepare(
    'SELECT * FROM telegram_links WHERE chat_id = ? AND revoked_at IS NULL').get(String(chatId));
}

// Пациенты, доступные этому чату. ВСЕГДА через телефон связки — никогда через
// id, пришедший из кнопки: callback_data приходит снаружи и подделывается.
function patientsFor(db, link) {
  return findPatientsByPhone(db, link.phone);
}

function assertOwned(db, link, patientId) {
  return patientsFor(db, link).find((p) => p.id === Number(patientId)) || null;
}

// ---------------------------------------------------------------------------
// Точка входа: одно обновление Telegram
// ---------------------------------------------------------------------------
export async function handleUpdate(db, token, update, deps = {}) {
  if (update.message) return handleMessage(db, token, update.message, deps);
  if (update.callback_query) return handleCallback(db, token, update.callback_query, deps);
}

async function handleMessage(db, token, msg, deps) {
  const chatId = msg.chat && msg.chat.id;
  if (!chatId) return;

  // Сообщение пациента сохраняем ДО обработки: даже если ниже что-то упадёт,
  // в клинике должно остаться видно, что человек написал.
  if (msg.text) logMessage(db, chatId, 'in', msg.text, { kind: 'text', tgMessageId: msg.message_id });

  if (msg.contact) return handleContact(db, token, msg, deps);

  const link = activeLink(db, chatId);
  if (!link) {
    return reply(db, token, chatId, greeting(db), { reply_markup: contactKeyboard }, deps);
  }

  const text = String(msg.text || '').trim();
  const cmd = text.toLowerCase().split('@')[0];

  // Кнопка и команда «Мои документы» — единственный способ получить список
  // пациентов. Раньше его печатало ЛЮБОЕ слово, поэтому вопрос «когда будут
  // анализы?» получал в ответ не ответ, а меню.
  if (text === BTN_DOCS || cmd === '/documents' || cmd === '/hujjatlar') {
    return showPatients(db, token, chatId, link, deps);
  }
  if (text === BTN_ASK) {
    return reply(db, token, chatId, T.askMessage, { reply_markup: menuKeyboard }, deps);
  }
  if (cmd === '/start' || cmd === '/help' || cmd === '/menu') {
    return reply(db, token, chatId, greeting(db), { reply_markup: menuKeyboard }, deps);
  }

  // Всё остальное — вопрос живому человеку. Сообщение уже в «Чате с
  // пациентами»; пациенту подтверждаем, что его прочитают, и оставляем
  // кнопки под рукой.
  return reply(db, token, chatId, T.gotMessage, { reply_markup: menuKeyboard }, deps);
}

// Приём контакта — САМАЯ ВАЖНАЯ проверка во всей функции.
//
// Telegram спокойно доставляет карточку ЧУЖОГО контакта: пациент может
// переслать сохранённый контакт соседа. У пересланного контакта user_id либо
// отсутствует, либо не равен отправителю. Без этой проверки любой человек
// получал бы чужую медицинскую карту, зная только номер телефона. Прежний бот
// с этим не сталкивался: он спрашивал пароль, а не номер.
async function handleContact(db, token, msg, deps) {
  const chatId = msg.chat.id;
  const contact = msg.contact || {};
  const fromId = msg.from && msg.from.id;

  if (!contact.user_id || !fromId || String(contact.user_id) !== String(fromId)) {
    return reply(db, token, chatId, T.notOwn, { reply_markup: contactKeyboard }, deps);
  }

  const phone = digitsOf(contact.phone_number);
  if (!phone) return reply(db, token, chatId, T.needContact, { reply_markup: contactKeyboard }, deps);

  const name = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ');

  // TELEGRAM_RELINK_V1 — «поделиться номером» можно нажать сколько угодно раз.
  //
  // Здесь стоял безусловный INSERT, а миграция 060 держит частичный уникальный
  // индекс idx_telegram_links_chat_active (chat_id WHERE revoked_at IS NULL):
  // активная связка у чата ровно одна. Поэтому ПЕРВЫЙ контакт проходил, а
  // каждый следующий падал с UNIQUE constraint failed — до единой отправки.
  // Пациент видел полную тишину: ответа нет, а в «Чате с пациентами» нет даже
  // входящей строки (у контакта нет поля text, логировать нечего), и обновление
  // исчезало — offset опросник сдвигает до обработки.
  //
  // Тот же номер — обновляем связку. Другой номер — прежнюю ОТЗЫВАЕМ (не
  // удаляем: она история выдачи доступа) и заводим новую.
  const existing = db.prepare(
    'SELECT * FROM telegram_links WHERE chat_id = ? AND revoked_at IS NULL').get(String(chatId));

  if (existing && existing.phone === phone) {
    db.prepare(
      `UPDATE telegram_links
          SET tg_user_id = ?, tg_username = ?, tg_name = ?,
              last_seen_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
        WHERE id = ?`)
      .run(String(fromId), (msg.from.username || ''), name, existing.id);
  } else {
    if (existing) {
      db.prepare(
        "UPDATE telegram_links SET revoked_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?")
        .run(existing.id);
    }
    db.prepare(
      `INSERT INTO telegram_links (chat_id, phone, tg_user_id, tg_username, tg_name, last_seen_at)
       VALUES (?,?,?,?,?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))`)
      .run(String(chatId), phone, String(fromId), (msg.from.username || ''), name);
  }

  const link = activeLink(db, chatId);
  await reply(db, token, chatId, T.linked, { reply_markup: menuKeyboard }, deps);
  return showPatients(db, token, chatId, link, deps);
}

// Список людей на номере. Если человек один — сразу его документы.
async function showPatients(db, token, chatId, link, deps) {
  const patients = patientsFor(db, link);
  touch(db, chatId);

  if (!patients.length) {
    return reply(db, token, chatId, T.noPatients,
      {}, deps);
  }
  if (patients.length === 1) {
    return showDocuments(db, token, chatId, link, patients[0].id, deps);
  }
  const rows = patients.map((p) => [{ text: p.full_name || ('Карта ' + p.mrn), callback_data: 'p:' + p.id }]);
  return reply(db, token, chatId, T.pickPatient, {
    reply_markup: { inline_keyboard: rows },

  }, deps);
}

async function showDocuments(db, token, chatId, link, patientId, deps) {
  const patient = assertOwned(db, link, patientId);
  if (!patient) return reply(db, token, chatId, T.noPatients, {}, deps);

  const kinds = allowedKinds(db);
  const docs = listDocuments(db, patient.id, kinds).slice(0, 20);
  if (!docs.length) {
    return reply(db, token, chatId, T.noDocs,
      {}, deps);
  }

  const rows = docs.map((d) => [{
    text: `${KIND_LABEL[d.kind] || '📄'} · ${shortDate(d.date)} · ${trim(d.title, 28)}`,
    callback_data: `g:${patient.id}:${d.ref}`,
  }]);
  return reply(db, token, chatId,
    `<b>${escapeHtml(patient.full_name || '')}</b>\n${T.yourDocs}`,
    { reply_markup: { inline_keyboard: rows } }, deps);
}

async function handleCallback(db, token, cq, deps) {
  const chatId = cq.message && cq.message.chat && cq.message.chat.id;
  const data = String(cq.data || '');
  if (!chatId) return;

  const link = activeLink(db, chatId);
  if (!link) {
    await ackQuietly(token, cq.id, '', deps);
    return reply(db, token, chatId, greeting(db), { reply_markup: contactKeyboard }, deps);
  }
  touch(db, chatId);

  if (data.startsWith('p:')) {
    await ackQuietly(token, cq.id, '', deps);
    return showDocuments(db, token, chatId, link, data.slice(2), deps);
  }
  if (data.startsWith('g:')) {
    const rest = data.slice(2);
    const i = rest.indexOf(':');
    const patientId = rest.slice(0, i);
    const ref = rest.slice(i + 1);
    await ackQuietly(token, cq.id, T.building, deps);
    return deliver(db, token, chatId, link, patientId, ref, deps);
  }
  return ackQuietly(token, cq.id, '', deps);
}

// ---------------------------------------------------------------------------
// Выдача документа
// ---------------------------------------------------------------------------
export async function deliver(db, token, chatId, link, patientId, ref, deps = {}, trigger = 'pull') {
  if (trigger === 'pull' && rateExceeded(db, chatId)) {
    return reply(db, token, chatId, T.tooFast, {}, deps);
  }
  const patient = assertOwned(db, link, patientId);
  if (!patient) return reply(db, token, chatId, T.noPatients, {}, deps);

  const built = buildDocument(db, ref, patient.id);
  if (!built) return reply(db, token, chatId, T.failed, {}, deps);

  // Вид определяем ПО СОБРАННОМУ документу, а не по префиксу ref: ref пришёл
  // из кнопки, то есть снаружи, а 'doc:' раскрывается в conclusion или diag
  // только после чтения строки. Проверка «разрешено ли администратором»
  // должна стоять на настоящем виде, иначе её обходит подделанный callback.
  const docKind = built.mode === 'file' ? 'file'
    : built.type === 'diag' ? 'diag'
    : built.type === 'lab' ? 'lab'
    : built.type === 'invoice' ? 'invoice' : 'conclusion';
  if (!allowedKinds(db).includes(docKind)) {
    return reply(db, token, chatId, T.failed, {}, deps);
  }

  // Автоотправка защищена уникальным индексом «один документ в чат — один раз»,
  // поэтому повторная попытка не вставляет новую строку, а увеличивает счётчик
  // попыток в существующей. Без этого оборванная сеть означала бы, что документ
  // потерян навсегда: строка осталась бы со статусом failed и навсегда считалась
  // «уже отправленной». Запросы пациента (pull) не дедуплицируются вовсе — он
  // вправе перезапросить документ сколько угодно раз.
  const deliveryId = trigger === 'push'
    ? db.prepare(
        `INSERT INTO telegram_deliveries (chat_id, patient_id, doc_kind, doc_ref, trigger, status, attempts)
         VALUES (?,?,?,?, 'push', 'pending', 1)
         ON CONFLICT(chat_id, doc_kind, doc_ref) WHERE trigger = 'push'
         DO UPDATE SET attempts = attempts + 1, status = 'pending', error = ''
         RETURNING id`).get(String(chatId), patient.id, docKind, ref).id
    : db.prepare(
        `INSERT INTO telegram_deliveries (chat_id, patient_id, doc_kind, doc_ref, trigger, status, attempts)
         VALUES (?,?,?,?, 'pull', 'pending', 1)`).run(String(chatId), patient.id, docKind, ref).lastInsertRowid;

  try {
    if (built.mode === 'file') {
      const abs = path.join(storageRoot(), 'patient-docs', built.path);
      if (!fs.existsSync(abs)) throw new Error('файл не найден на диске');
      await sendDocument(token, chatId, fs.readFileSync(abs), built.name,
        { caption: escapeHtml(built.title || ''), ...deps });
    } else {
      const pdf = await renderPdf(db, {
        type: built.type, data: built.data, title: built.title, idLine: built.idLine,
        chromePath: chromePath(db),
      });
      await sendDocument(token, chatId, pdf, fileNameFor(built),
        { caption: `<b>${escapeHtml(built.title || '')}</b>`, ...deps });
    }
    db.prepare(
      `UPDATE telegram_deliveries SET status='sent', sent_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')
        WHERE id = ?`).run(deliveryId);
    // В ленте переписки выданный документ виден строкой — иначе сотрудник
    // читает вопрос пациента «где мой анализ?» и не видит, что анализ ушёл.
    logMessage(db, chatId, 'out', '📄 ' + (built.title || 'Документ'), { kind: 'document' });
  } catch (e) {
    db.prepare('UPDATE telegram_deliveries SET status=?, error=? WHERE id = ?')
      .run('failed', String((e && e.message) || e).slice(0, 500), deliveryId);
    if (trigger === 'pull') await reply(db, token, chatId, T.failed, {}, deps).catch(() => {});
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Мелочи
// ---------------------------------------------------------------------------
function allowedKinds(db) {
  const row = db.prepare('SELECT doc_kinds FROM telegram_settings WHERE id = 1').get();
  return String((row && row.doc_kinds) || '').split(',').filter(Boolean);
}
function chromePath(db) {
  const row = db.prepare('SELECT chrome_path FROM telegram_settings WHERE id = 1').get();
  return (row && row.chrome_path) || '';
}
function storageRoot() {
  return path.join(ROOT, 'data', 'storage');
}
function touch(db, chatId) {
  db.prepare(`UPDATE telegram_links SET last_seen_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
               WHERE chat_id = ? AND revoked_at IS NULL`).run(String(chatId));
}
function fileNameFor(built) {
  const safe = String(built.title || 'document').replace(/[^\wА-Яа-яЁё\- ]+/g, '').trim().slice(0, 40) || 'document';
  return `${safe} ${built.idLine || ''}`.trim() + '.pdf';
}
function shortDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d) ? String(iso).slice(0, 10) : d.toLocaleDateString('ru-RU');
}
function trim(s, n) {
  const t = String(s || '');
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

export { T as TEXTS, contactKeyboard, allowedKinds, RATE_LIMIT };
