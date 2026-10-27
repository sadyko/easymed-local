// TG_DEEPLINK_V1 (2026-10-26, владелец: «and here generation of Deeplink, sample
// is provided in the photo — go on now») — ССЫЛКИ ДЛЯ РЕКЛАМЫ В TELEGRAM.
//
// Ссылка вида https://t.me/<бот>?start=<ключ> ставится в рекламу (Instagram,
// Meta, листовка — своя на каждый канал или пакет). Человек открывает бота по
// ней — ещё НЕ пациент, без номера в базе — и сразу получает то, ради чего
// кликнул: ответ на своём языке, файл (прайс, фото палаты) и кнопки. Кнопка
// «Оставить заявку» заводит карточку в CRM: сразу, если номер чата уже
// привязан, иначе после «Поделиться номером». По каждой ссылке считаются
// переходы и заявки — это и есть измеримая реклама.
//
// Здесь — всё, что знает о ссылках: разбор ключа и языка, проверка и
// сохранение (экран), ответ бота и заявка (flow.js зовёт три точки входа:
// onStart, onCallback, onContactForLead). flow.js передаёт сюда свои reply и
// клавиатуры параметром `bot`, а не наоборот: deeplinks.js не импортирует
// flow.js, цикла модулей нет.
//
// Состояние диалога, как и во всём боте, в кнопках: callback_data `dl:a:<ключ>`
// (показать другой ответ) и `dl:l:<ключ>` (заявка). Единственное, что
// запоминается, — ожидание номера для заявки (`dl:lead:<chat>` в
// telegram_state): между нажатием «Оставить заявку» и присланным контактом
// проходит время, и сервер за это время могли перезапустить.

import fs from 'node:fs';
import path from 'node:path';
import { sendMessage, sendPhoto, sendDocument } from './api.js';
import { resolveMedia, readMedia } from './media.js';
import { uzE164 } from '../../../public/js/admin/views/crm-phone-match.js';
import { contactDecision, firstStageKey, reopenLead } from '../crm/contact-window.js';
import { leadsForPhone } from '../crm/lead-from-call.js';

export class DeeplinkError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

// Тип заявки — словарь из трёх слов. Пишется в комментарий карточки; колонка
// CRM — всегда первая открытая (как у Meta): тип — подсказка оператору, а не
// маршрут по воронке.
export const LEAD_KINDS = Object.freeze({
  callback: 'Обратный звонок',
  appointment: 'Запись на приём',
  question: 'Вопрос',
});

// Ключ попадает в адрес ссылки. Telegram пропускает в start= латиницу, цифры,
// «-» и «_» до 64 знаков; мы короче (32) и только строчные: параметр приходит
// как набрали, а «Price» и «price» — одна ссылка (UNIQUE COLLATE NOCASE в 251).
export const KEY_RE = /^[a-z0-9_-]{1,32}$/;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;   // как в образце владельца: «PDF или фото до 10 МБ»
export const MAX_BUTTONS = 10;
const MAX_ANSWER = 4096;   // предел текста сообщения Telegram

const PHOTO_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);
const DOC_EXT = new Set(['.pdf']);
const SOURCE_KEY = 'telegram';
const SOURCE_LABEL = 'Telegram-бот';
const PENDING_PREFIX = 'dl:lead:';
const NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%SZ','now')";

export function normalizeKey(raw) {
  const k = String(raw == null ? '' : raw).trim().toLowerCase();
  return KEY_RE.test(k) ? k : '';
}

// «/start <параметр>» — и «/start@имя_бота <параметр>» (так приходит из групп
// и из некоторых клиентов). Параметр — первое слово; регистр не трогаем, его
// приводит normalizeKey.
export function parseStart(text) {
  const t = String(text || '').trim();
  const m = /^\/start(?:@\S+)?(?:\s+([\s\S]*))?$/i.exec(t);
  if (!m) return { isStart: false, param: '' };
  const param = String(m[1] || '').trim().split(/\s+/)[0] || '';
  return { isStart: true, param };
}

// Язык ответа — по языку клиента Telegram (from.language_code: «uz», «en-US»…).
// Всё, что не узбекский и не английский, — русский: он у ссылки обязателен.
export function langOf(code) {
  const c = String(code || '').toLowerCase();
  if (c === 'uz' || c.startsWith('uz-')) return 'uz';
  if (c === 'en' || c.startsWith('en-')) return 'en';
  return 'ru';
}

const LANG_LABEL = { ru: 'русский', uz: 'узбекский', en: 'английский' };

// Тексты бота на трёх языках — здесь язык известен, поэтому не двуязычные
// строки, как в flow.js, а одна на языке человека.
const TX = {
  leadBtn:  { ru: '📝 Оставить заявку', uz: '📝 So‘rov qoldirish', en: '📝 Leave a request' },
  askPhone: {
    ru: '👇 Чтобы мы с вами связались, подтвердите номер телефона кнопкой ниже.',
    uz: '👇 Siz bilan bog‘lanishimiz uchun telefon raqamingizni quyidagi tugma orqali tasdiqlang.',
    en: '👇 Please confirm your phone number with the button below so we can contact you.',
  },
  thanks: {
    ru: '✅ Спасибо! Заявка принята — мы свяжемся с вами в ближайшее время.',
    uz: '✅ Rahmat! So‘rovingiz qabul qilindi — tez orada siz bilan bog‘lanamiz.',
    en: '✅ Thank you! Your request has been received — we will contact you shortly.',
  },
  gone: {
    ru: 'Эта ссылка больше не действует.',
    uz: 'Bu havola endi amal qilmaydi.',
    en: 'This link is no longer active.',
  },
};

// ---------------------------------------------------------------------------
// Хранение
// ---------------------------------------------------------------------------
function parseButtons(json) {
  try { const a = JSON.parse(json || '[]'); return Array.isArray(a) ? a : []; } catch { return []; }
}

function toPublic(r) {
  return {
    id: r.id, key: r.key, name: r.name,
    lead_kind: r.lead_kind, lead_kind_label: LEAD_KINDS[r.lead_kind] || r.lead_kind,
    answer_ru: r.answer_ru, answer_uz: r.answer_uz, answer_en: r.answer_en,
    buttons: parseButtons(r.buttons_json),
    file_path: r.file_path, file_kind: r.file_kind, file_name: r.file_name,
    active: !!r.active,
    created_at: r.created_at, updated_at: r.updated_at,
    hits: Number(r.hits || 0), unique_hits: Number(r.unique_hits || 0), leads: Number(r.leads || 0),
  };
}

const LIST_SQL = `
  SELECT d.*,
         (SELECT COUNT(*) FROM telegram_deeplink_hits h WHERE h.deeplink_id = d.id) AS hits,
         (SELECT COUNT(DISTINCT h.chat_id) FROM telegram_deeplink_hits h WHERE h.deeplink_id = d.id) AS unique_hits,
         (SELECT COUNT(*) FROM telegram_deeplink_leads l WHERE l.deeplink_id = d.id) AS leads
    FROM telegram_deeplinks d`;

export function listDeeplinks(db) {
  return db.prepare(LIST_SQL + ' ORDER BY d.id').all().map(toPublic);
}

export function getDeeplink(db, id) {
  const r = db.prepare(LIST_SQL + ' WHERE d.id = ?').get(Number(id));
  return r ? toPublic(r) : null;
}

export function findActiveByKey(db, rawKey) {
  const key = normalizeKey(rawKey);
  if (!key) return null;
  const r = db.prepare(LIST_SQL + ' WHERE d.key = ? COLLATE NOCASE AND d.active = 1').get(key);
  return r ? toPublic(r) : null;
}

function fileKindOf(relPath) {
  const ext = path.extname(String(relPath || '')).toLowerCase();
  if (PHOTO_EXT.has(ext)) return 'photo';
  if (DOC_EXT.has(ext)) return 'document';
  return '';
}

// Кнопки — проверка каждой. Цель «показать другой ответ» должна существовать
// (иначе кнопка в Telegram нажмётся в пустоту); адрес — только http(s);
// «заявка» цели не имеет.
function normalizeButtons(db, raw, ownKey) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new DeeplinkError('Кнопки под ответом — это список.');
  if (raw.length > MAX_BUTTONS) throw new DeeplinkError('Кнопок под ответом может быть не больше десяти.');
  return raw.map((b) => {
    const label = String((b && b.label) || '').trim().slice(0, 64);
    const action = String((b && b.action) || '').trim();
    let target = String((b && b.target) || '').trim();
    if (!label) throw new DeeplinkError('У каждой кнопки должна быть подпись.');
    if (action === 'answer') {
      target = normalizeKey(target);
      if (!target) throw new DeeplinkError('Кнопка «показать другой ответ» ссылается на ключ другой ссылки — латиница, цифры, «-» и «_».');
      if (target !== ownKey && !db.prepare('SELECT 1 FROM telegram_deeplinks WHERE key = ? COLLATE NOCASE').get(target)) {
        throw new DeeplinkError('Кнопка «показать другой ответ» ссылается на ключ, которого нет: сначала создайте ту ссылку.');
      }
    } else if (action === 'url') {
      if (!/^https?:\/\/\S+$/i.test(target) || target.length > 1024) throw new DeeplinkError('Адрес кнопки должен начинаться с http:// или https://.');
    } else if (action === 'lead') {
      target = '';
    } else {
      throw new DeeplinkError('Действие кнопки — показать другой ответ, открыть страницу или начать заявку.');
    }
    return { label, action, target };
  });
}

function normalizeFile(input) {
  const relPath = String(input.file_path || '').trim();
  if (!relPath) return { file_path: '', file_kind: '', file_name: '' };
  const abs = resolveMedia(relPath);
  if (!abs) throw new DeeplinkError('Файл к ответу должен лежать в хранилище Telegram-бота.');
  const kind = fileKindOf(relPath);
  if (!kind) throw new DeeplinkError('Файл к ответу — PDF или картинка (JPG, PNG, GIF, WEBP).');
  try {
    const st = fs.statSync(abs);
    if (st.size > MAX_FILE_BYTES) throw new DeeplinkError('Файл к ответу — не больше 10 МБ: больше Telegram не примет.');
  } catch (e) {
    if (e instanceof DeeplinkError) throw e;
    // Файла (ещё) нет на диске — сохраняем ссылку; бот без файла ответит текстом.
  }
  const name = String(input.file_name || '').trim() || path.basename(relPath);
  return { file_path: relPath, file_kind: kind, file_name: name.slice(0, 180) };
}

export function saveDeeplink(db, input, userId = null) {
  const src = input && typeof input === 'object' ? input : {};
  const id = src.id ? Number(src.id) : 0;
  const existing = id ? db.prepare('SELECT * FROM telegram_deeplinks WHERE id = ?').get(id) : null;
  if (id && !existing) throw new DeeplinkError('Такой ссылки уже нет.', 404);

  const key = normalizeKey(src.key);
  if (!key) throw new DeeplinkError('Ключ ссылки — от 1 до 32 знаков: латиница, цифры, «-» и «_». Он попадает в адрес ссылки.');
  const taken = db.prepare('SELECT id FROM telegram_deeplinks WHERE key = ? COLLATE NOCASE AND id != ?').get(key, id);
  if (taken) throw new DeeplinkError('Ссылка с таким ключом уже есть — выберите другой.', 409);

  const name = String(src.name || '').trim().slice(0, 120);
  if (!name) throw new DeeplinkError('Дайте ссылке название — оно видно только сотрудникам.');

  const leadKind = src.lead_kind === undefined || src.lead_kind === null || src.lead_kind === ''
    ? (existing ? existing.lead_kind : 'callback') : String(src.lead_kind);
  if (!LEAD_KINDS[leadKind]) throw new DeeplinkError('Тип заявки — обратный звонок, запись на приём или вопрос.');

  const answer = (k) => String(src[k] == null ? (existing ? existing[k] : '') : src[k]).trim().slice(0, MAX_ANSWER);
  const answerRu = answer('answer_ru');
  if (!answerRu) throw new DeeplinkError('Ответ бота на русском обязателен: на него откатываются остальные языки.');

  const buttons = src.buttons === undefined && existing ? normalizeButtons(db, parseButtons(existing.buttons_json), key) : normalizeButtons(db, src.buttons, key);
  const file = src.file_path === undefined && existing
    ? { file_path: existing.file_path, file_kind: existing.file_kind, file_name: existing.file_name }
    : normalizeFile(src);
  const active = src.active === undefined ? (existing ? existing.active : 1) : (src.active ? 1 : 0);

  const row = {
    id, key, name, lead_kind: leadKind,
    answer_ru: answerRu, answer_uz: answer('answer_uz'), answer_en: answer('answer_en'),
    buttons_json: JSON.stringify(buttons), ...file, active,
    created_by: userId == null ? null : Number(userId),
  };
  if (existing) {
    db.prepare(`UPDATE telegram_deeplinks
                   SET key = @key, name = @name, lead_kind = @lead_kind,
                       answer_ru = @answer_ru, answer_uz = @answer_uz, answer_en = @answer_en,
                       buttons_json = @buttons_json, file_path = @file_path, file_kind = @file_kind, file_name = @file_name,
                       active = @active, updated_at = ${NOW_SQL}
                 WHERE id = @id`).run(row);
    // Файл сменили — прежний больше никому не нужен.
    if (existing.file_path && existing.file_path !== row.file_path) removeFileIfOrphan(db, existing.file_path);
    return getDeeplink(db, id);
  }
  const newId = Number(db.prepare(`INSERT INTO telegram_deeplinks
      (key, name, lead_kind, answer_ru, answer_uz, answer_en, buttons_json, file_path, file_kind, file_name, active, created_by)
      VALUES (@key, @name, @lead_kind, @answer_ru, @answer_uz, @answer_en, @buttons_json, @file_path, @file_kind, @file_name, @active, @created_by)`)
    .run(row).lastInsertRowid);
  return getDeeplink(db, newId);
}

export function deleteDeeplink(db, id) {
  const existing = db.prepare('SELECT * FROM telegram_deeplinks WHERE id = ?').get(Number(id));
  if (!existing) throw new DeeplinkError('Такой ссылки уже нет.', 404);
  // Журналы уходят вместе со ссылкой (ON DELETE CASCADE, мигр. 251).
  db.prepare('DELETE FROM telegram_deeplinks WHERE id = ?').run(existing.id);
  if (existing.file_path) removeFileIfOrphan(db, existing.file_path);
  return { ok: true };
}

// Файл с диска — только если на него не ссылается другая ссылка, и только из
// папки deeplinks/: что положили не мы, не наше.
function removeFileIfOrphan(db, relPath) {
  try {
    if (!String(relPath).startsWith('deeplinks/')) return;
    if (db.prepare('SELECT 1 FROM telegram_deeplinks WHERE file_path = ?').get(relPath)) return;
    const abs = resolveMedia(relPath);
    if (abs && fs.existsSync(abs)) fs.unlinkSync(abs);
  } catch { /* файл — приложение к ссылке, не сама работа */ }
}

// ---------------------------------------------------------------------------
// Ответ бота
// ---------------------------------------------------------------------------
export function answerFor(link, lang) {
  const l = langOf(lang);
  return (l !== 'ru' && link['answer_' + l]) || link.answer_ru || '';
}

// Без кнопок — одна, «Оставить заявку»: ради неё ссылка и существует.
export function inlineKeyboardFor(link, lang = 'ru') {
  const l = langOf(lang);
  const buttons = Array.isArray(link.buttons) && link.buttons.length ? link.buttons
    : [{ label: TX.leadBtn[l], action: 'lead', target: '' }];
  return buttons.map((b) => {
    if (b.action === 'url') return [{ text: b.label, url: b.target }];
    if (b.action === 'answer') return [{ text: b.label, callback_data: 'dl:a:' + b.target }];
    return [{ text: b.label, callback_data: 'dl:l:' + link.key }];
  });
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

// Файл — первым, текст с кнопками — вторым: кнопки должны быть под последним
// сообщением, иначе человек их не видит за картинкой. Пропавший с диска файл
// ответ не ломает: администратор мог удалить его из хранилища.
async function sendAnswer(db, token, chatId, link, lang, deps, bot) {
  if (link.file_path) {
    const media = readMedia(link.file_path);
    if (media) {
      try {
        if (link.file_kind === 'photo') await sendPhoto(token, chatId, media.buffer, { filename: media.filename, ...deps });
        else await sendDocument(token, chatId, media.buffer, link.file_name || media.filename, deps);
        bot.log(db, chatId, 'out', '📎 ' + (link.file_name || media.filename), { kind: 'document' });
      } catch (e) {
        console.warn('[telegram] deeplink file', link.key, 'not sent:', (e && e.message) || e);
      }
    }
  }
  // Текст набирает администратор: «<» и «&» в нём — буквы, а не разметка,
  // иначе Telegram отвергнет сообщение целиком.
  const text = escapeHtml(answerFor(link, lang));
  return bot.reply(db, token, chatId, text, { reply_markup: { inline_keyboard: inlineKeyboardFor(link, lang) } }, deps);
}

export function recordHit(db, link, { chatId, tgUserId, lang }) {
  db.prepare('INSERT INTO telegram_deeplink_hits (deeplink_id, chat_id, tg_user_id, lang) VALUES (?,?,?,?)')
    .run(link.id, String(chatId), String(tgUserId || ''), langOf(lang));
}

// /start <ключ>. true — ответили по ссылке; false — ключ чужой или ссылка
// выключена, и flow.js отвечает обычным приветствием.
export async function onStart(db, token, chatId, from, param, deps, bot) {
  const link = findActiveByKey(db, param);
  if (!link) return false;
  const lang = langOf(from && from.language_code);
  recordHit(db, link, { chatId, tgUserId: from && from.id, lang });
  await sendAnswer(db, token, chatId, link, lang, deps, bot);
  return true;
}

// Кнопки dl:a:<ключ> и dl:l:<ключ>. Навигация по кнопкам переходом не
// считается: переход — это клик по рекламе, а не по меню внутри воронки.
export async function onCallback(db, token, chatId, from, data, deps, bot, activeLinkRow) {
  const lang = langOf(from && from.language_code);
  const [, action, ...rest] = String(data).split(':');
  const link = findActiveByKey(db, rest.join(':'));
  if (!link) return bot.reply(db, token, chatId, TX.gone[lang], {}, deps);
  if (action === 'a') return sendAnswer(db, token, chatId, link, lang, deps, bot);
  if (action !== 'l') return undefined;
  if (activeLinkRow && activeLinkRow.phone) {
    const name = String(activeLinkRow.tg_name || '').trim() || nameOf(from);
    createDeeplinkLead(db, link, { chatId, phone: activeLinkRow.phone, name, lang });
    return bot.reply(db, token, chatId, TX.thanks[lang], { reply_markup: bot.menuKeyboard }, deps);
  }
  setPendingLead(db, chatId, link.id);
  return bot.reply(db, token, chatId, TX.askPhone[lang], { reply_markup: bot.contactKeyboard }, deps);
}

// Контакт пришёл, пока ждали номер для заявки: карточка + благодарность.
// Привязку номера как пациента flow.js уже сделал. true — ответ дан, список
// пациентов не нужен: человек пришёл с рекламы оставить заявку, а не за
// документами, и «никого не нашли» здесь — неправда.
export async function onContactForLead(db, token, chatId, from, pendingId, phone, deps, bot) {
  const link = getDeeplink(db, pendingId);
  if (!link) return false;
  const lang = langOf(from && from.language_code);
  createDeeplinkLead(db, link, { chatId, phone, name: nameOf(from), lang });
  await bot.reply(db, token, chatId, TX.thanks[lang], { reply_markup: bot.menuKeyboard }, deps);
  return true;
}

function nameOf(from) {
  return [from && from.first_name, from && from.last_name].filter(Boolean).join(' ').trim();
}

// ---------------------------------------------------------------------------
// Ожидание номера для заявки — в telegram_state, переживает перезапуск
// ---------------------------------------------------------------------------
export function setPendingLead(db, chatId, deeplinkId) {
  db.prepare(`INSERT INTO telegram_state (key, value, updated_at) VALUES (?, ?, ${NOW_SQL})
              ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run(PENDING_PREFIX + String(chatId), String(deeplinkId));
}
export function takePendingLead(db, chatId) {
  const key = PENDING_PREFIX + String(chatId);
  const r = db.prepare('SELECT value FROM telegram_state WHERE key = ?').get(key);
  if (!r) return 0;
  db.prepare('DELETE FROM telegram_state WHERE key = ?').run(key);
  return Number(r.value) || 0;
}

// ---------------------------------------------------------------------------
// Заявка → карточка CRM
// ---------------------------------------------------------------------------
function ensureSource(db) {
  const cur = db.prepare('SELECT is_active FROM crm_sources WHERE key = ?').get(SOURCE_KEY);
  if (!cur) {
    db.prepare(`INSERT INTO crm_sources (key, label, position, is_active)
                VALUES (?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM crm_sources), 1)`).run(SOURCE_KEY, SOURCE_LABEL);
  } else if (!cur.is_active) {
    db.prepare('UPDATE crm_sources SET is_active = 1 WHERE key = ?').run(SOURCE_KEY);
  }
}

function noteFor(link, lang) {
  return `Заявка из Telegram по ссылке «${link.name}» (${link.key}) · Тип: ${LEAD_KINDS[link.lead_kind] || link.lead_kind} · Язык: ${LANG_LABEL[lang] || lang}`;
}

function appendToCard(db, id, note) {
  const row = db.prepare('SELECT note, sources, source FROM crm_requests WHERE id = ?').get(id);
  if (!row) return;
  let sources = [];
  try { const arr = JSON.parse(row.sources || '[]'); sources = Array.isArray(arr) ? arr.map(String) : []; } catch { sources = []; }
  if (!sources.length && row.source) sources = [String(row.source)];
  if (!sources.includes(SOURCE_KEY)) sources.push(SOURCE_KEY);
  const merged = row.note ? row.note + '\n\n' + note : note;
  db.prepare(`UPDATE crm_requests SET note = @note, sources = @sources, updated_at = ${NOW_SQL} WHERE id = @id`)
    .run({ id, note: merged, sources: JSON.stringify(sources) });
}

// Правило CRM то же, что у звонков и у Meta: повторное обращение того же
// телефона в окне контакта — в открытую карточку, не вторая. Заявка при этом
// считается по ссылке в любом случае: реклама сработала дважды.
export function createDeeplinkLead(db, link, { chatId, phone, name, lang }) {
  return db.transaction(() => {
    ensureSource(db);
    const phoneNorm = phone ? (uzE164(phone) || String(phone)) : '';
    const note = noteFor(link, lang);
    let decision = { action: 'new', lead: null };
    if (phoneNorm) decision = contactDecision(db, leadsForPhone(db, phoneNorm));
    let crmId;
    let merged = false;
    if ((decision.action === 'same' || decision.action === 'reopen') && decision.lead) {
      if (decision.action === 'reopen') reopenLead(db, decision.lead.id);
      appendToCard(db, decision.lead.id, note);
      crmId = decision.lead.id;
      merged = true;
    } else {
      crmId = Number(db.prepare(`INSERT INTO crm_requests (full_name, phone, source, sources, status, note)
                                 VALUES (?, ?, ?, ?, ?, ?)`)
        .run((name || '').slice(0, 200) || 'Заявка из Telegram', phoneNorm.slice(0, 40), SOURCE_KEY, JSON.stringify([SOURCE_KEY]),
          firstStageKey(db) || 'in_process', note).lastInsertRowid);
    }
    db.prepare('INSERT INTO telegram_deeplink_leads (deeplink_id, crm_request_id, chat_id) VALUES (?,?,?)')
      .run(link.id, crmId, String(chatId));
    return { crm_request_id: crmId, merged };
  })();
}
