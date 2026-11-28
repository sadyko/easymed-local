// STAFF_ATTENDANCE_V1 — диалог бота сотрудников (EasyMed Staff), этап 1.
//
// Что умеет:
//   /start lnk_<код>   — подключить свой Telegram к учётной записи (код выдаёт HR);
//   /start a_<…>       — открыт по QR у входа: «Отметить приход / уход?» и
//                        кнопка «Подтвердить» (правила — attendance/core.js);
//   «Моя посещаемость», «Профиль», «Язык» — постоянная клавиатура.
// Кнопки «Отметиться» нет НАРОЧНО (ТЗ, 3.3): отметка — только через QR.
//
// Логики здесь нет — только разбор сообщения и текст ответа. Всё, что решает
// (кто, можно ли, приход или уход), — в attendance/core.js и linking.js.
// Язык ответа — staff_telegram_links.lang (русский по умолчанию), до
// подключения — оба языка сразу.
import { callApi } from '../telegram/api.js';
import { registerScan, confirmScan, myAttendance, staffByTelegram } from '../attendance/core.js';
import { parseLinkStart, redeemLinkCode } from './linking.js';

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const MENU = {
  ru: { attendance: 'Моя посещаемость', profile: 'Профиль', lang: 'Til: Oʻzbekcha' },
  uz: { attendance: 'Mening davomatim', profile: 'Profil', lang: 'Язык: Русский' },
};

const T = {
  ru: {
    welcome: (name) => `Здравствуйте, <b>${esc(name)}</b>!\n\nЭто EasyMed Staff — помощник сотрудника клиники.\n\nПриход и уход отмечаются только по QR-коду на экране у входа: наведите на него камеру телефона.`,
    linked: (name) => `Готово: этот Telegram подключён к сотруднику <b>${esc(name)}</b>.\n\nПриход и уход отмечайте по QR-коду на экране у входа.`,
    badCode: 'Код подключения не подошёл: он истёк или уже использован. Попросите в отделе кадров новый код.',
    inactiveUser: 'Учётная запись сотрудника отключена. Обратитесь в отдел кадров.',
    taken: 'Этот Telegram уже подключён к другому сотруднику. Попросите отдел кадров отключить прежнее подключение.',
    confirmIn: (loc, time) => `Отметить <b>приход</b>?\n\n${esc(loc)} · ${esc(time)}`,
    confirmOut: (loc, time) => `Отметить <b>уход</b>?\n\n${esc(loc)} · ${esc(time)}`,
    btnIn: 'Подтвердить приход', btnOut: 'Подтвердить уход', btnCancel: 'Отмена',
    doneIn: (time, loc) => `Приход отмечен: <b>${esc(time)}</b>, ${esc(loc)}.\nХорошего рабочего дня!`,
    doneOut: (time, loc, dur) => `Уход отмечен: <b>${esc(time)}</b>, ${esc(loc)}.\nНа работе: ${esc(dur)}.`,
    cancelled: 'Отметка отменена.',
    reasons: {
      unknown_telegram: 'Этот Telegram не подключён к сотруднику клиники. Попросите в отделе кадров код подключения.',
      bad_token: 'QR-код не распознан. Отсканируйте код на экране у входа ещё раз.',
      expired_token: 'QR-код уже сменился. Отсканируйте код на экране ещё раз — он обновляется каждые несколько секунд.',
      replay: 'Этот QR-код вы уже сканировали. Дождитесь нового кода на экране.',
      inactive_location: 'Эта точка входа отключена. Обратитесь в отдел кадров.',
      branch_not_allowed: 'Вы не можете отмечаться в этом здании. Если вас перевели — сообщите в отдел кадров.',
      inactive_employee: 'Учётная запись сотрудника отключена. Обратитесь в отдел кадров.',
      rate_limited: 'Слишком много попыток. Подождите 10 минут.',
      confirm_expired: 'Время подтверждения вышло. Отсканируйте QR-код ещё раз.',
      too_soon: 'Отметка уже сделана меньше минуты назад — повтор не записан.',
      not_private: 'Отмечаться можно только в личном чате с ботом.',
    },
    notLinked: 'Этот Telegram не подключён к сотруднику клиники. Попросите в отделе кадров код подключения и откройте присланную ссылку.',
    useMenu: 'Выберите пункт меню ниже. Приход и уход — по QR-коду у входа.',
    attTitle: 'Моя посещаемость — 7 дней',
    attNone: 'Отметок за эти дни нет.',
    attOpen: (time) => `Сейчас на работе с ${esc(time)}.`,
    attMonth: (dur, n) => `Этот месяц: ${esc(dur)} за ${n} смен(ы).`,
    noOut: 'ухода нет',
    profile: (p) => `<b>${esc(p.full_name)}</b>\n${[p.position, p.department].filter(Boolean).map(esc).join(' · ') || '—'}\nTelegram подключён: ${esc(p.linked)}`,
    langSet: 'Язык: русский.',
    dur: (m) => `${Math.floor(m / 60)} ч ${m % 60} мин`,
  },
  uz: {
    welcome: (name) => `Assalomu alaykum, <b>${esc(name)}</b>!\n\nBu — EasyMed Staff, klinika xodimining yordamchisi.\n\nKelish va ketish faqat kirishdagi ekrandagi QR-kod orqali belgilanadi: telefon kamerasini unga qarating.`,
    linked: (name) => `Tayyor: bu Telegram <b>${esc(name)}</b> xodimiga ulandi.\n\nKelish va ketishni kirishdagi ekrandagi QR-kod orqali belgilang.`,
    badCode: 'Ulanish kodi mos kelmadi: muddati tugagan yoki ishlatilgan. Kadrlar boʻlimidan yangi kod soʻrang.',
    inactiveUser: 'Xodimning hisobi oʻchirilgan. Kadrlar boʻlimiga murojaat qiling.',
    taken: 'Bu Telegram boshqa xodimga ulangan. Kadrlar boʻlimidan oldingi ulanishni oʻchirishni soʻrang.',
    confirmIn: (loc, time) => `<b>Kelish</b> belgilansinmi?\n\n${esc(loc)} · ${esc(time)}`,
    confirmOut: (loc, time) => `<b>Ketish</b> belgilansinmi?\n\n${esc(loc)} · ${esc(time)}`,
    btnIn: 'Kelishni tasdiqlash', btnOut: 'Ketishni tasdiqlash', btnCancel: 'Bekor qilish',
    doneIn: (time, loc) => `Kelish belgilandi: <b>${esc(time)}</b>, ${esc(loc)}.\nIsh kuningiz xayrli oʻtsin!`,
    doneOut: (time, loc, dur) => `Ketish belgilandi: <b>${esc(time)}</b>, ${esc(loc)}.\nIshda: ${esc(dur)}.`,
    cancelled: 'Belgilash bekor qilindi.',
    reasons: {
      unknown_telegram: 'Bu Telegram klinika xodimiga ulanmagan. Kadrlar boʻlimidan ulanish kodini soʻrang.',
      bad_token: 'QR-kod tanilmadi. Kirishdagi ekrandagi kodni qayta skanerlang.',
      expired_token: 'QR-kod allaqachon almashdi. Ekrandagi kodni qayta skanerlang — u har bir necha soniyada yangilanadi.',
      replay: 'Bu QR-kodni allaqachon skanerlagansiz. Ekranda yangi kodni kuting.',
      inactive_location: 'Bu kirish nuqtasi oʻchirilgan. Kadrlar boʻlimiga murojaat qiling.',
      branch_not_allowed: 'Bu binoda belgilana olmaysiz. Agar sizni oʻtkazishgan boʻlsa — kadrlar boʻlimiga xabar bering.',
      inactive_employee: 'Xodimning hisobi oʻchirilgan. Kadrlar boʻlimiga murojaat qiling.',
      rate_limited: 'Urinishlar juda koʻp. 10 daqiqa kuting.',
      confirm_expired: 'Tasdiqlash vaqti tugadi. QR-kodni qayta skanerlang.',
      too_soon: 'Belgi bir daqiqadan kamroq vaqt oldin qoʻyilgan — takror yozilmadi.',
      not_private: 'Faqat bot bilan shaxsiy chatda belgilanish mumkin.',
    },
    notLinked: 'Bu Telegram klinika xodimiga ulanmagan. Kadrlar boʻlimidan ulanish kodini soʻrang va yuborilgan havolani oching.',
    useMenu: 'Quyidagi menyudan tanlang. Kelish va ketish — kirishdagi QR-kod orqali.',
    attTitle: 'Mening davomatim — 7 kun',
    attNone: 'Bu kunlarda belgilar yoʻq.',
    attOpen: (time) => `Hozir ishdasiz, ${esc(time)} dan beri.`,
    attMonth: (dur, n) => `Shu oy: ${esc(dur)}, ${n} smena.`,
    noOut: 'ketish yoʻq',
    profile: (p) => `<b>${esc(p.full_name)}</b>\n${[p.position, p.department].filter(Boolean).map(esc).join(' · ') || '—'}\nTelegram ulangan: ${esc(p.linked)}`,
    langSet: 'Til: oʻzbekcha.',
    dur: (m) => `${Math.floor(m / 60)} soat ${m % 60} daq`,
  },
};

const both = (key) => `${T.ru[key]}\n\n${T.uz[key]}`;
const bothReason = (r) => `${T.ru.reasons[r] || T.ru.reasons.bad_token}\n\n${T.uz.reasons[r] || T.uz.reasons.bad_token}`;

function keyboard(lang) {
  const m = MENU[lang] || MENU.ru;
  return { reply_markup: { keyboard: [[{ text: m.attendance }, { text: m.profile }], [{ text: m.lang }]], resize_keyboard: true, is_persistent: true } };
}

function localTime(db, stamp) {
  return db.prepare("SELECT strftime('%H:%M', ?, 'localtime') AS t").get(stamp).t;
}
function localDateTime(db, stamp) {
  return db.prepare("SELECT strftime('%d.%m.%Y %H:%M', ?, 'localtime') AS t").get(stamp).t;
}

/**
 * Обработать одно обновление Telegram. deps.call(method, params) — вызов Bot
 * API (тесты подменяют его записью), deps.nowMs — часы (тесты).
 */
export async function handleUpdate(db, token, update, deps = {}) {
  const call = deps.call || ((method, params) => callApi(token, method, params));
  const nowMs = deps.nowMs;
  if (update.message) return handleMessage(db, update.message, call, nowMs);
  if (update.callback_query) return handleCallback(db, update.callback_query, call, nowMs);
  return null;
}

async function send(call, chatId, text, extra = {}) {
  return call('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
}

async function handleMessage(db, msg, call, nowMs) {
  const chatId = msg.chat && msg.chat.id;
  const from = msg.from || {};
  const text = String(msg.text || '').trim();
  const isPrivate = msg.chat && msg.chat.type === 'private';
  const staff = staffByTelegram(db, from.id);
  const lang = staff ? staff.link.lang : 'ru';
  const t = T[lang] || T.ru;

  if (text.startsWith('/start')) {
    const param = text.slice('/start'.length).trim();
    const linkCode = parseLinkStart(param);
    if (linkCode) {
      if (!isPrivate) return null;
      const r = redeemLinkCode(db, { code: linkCode, tgUserId: from.id, chatId, tgUsername: from.username || '', nowMs: nowMs ?? Date.now() });
      if (!r.ok) {
        const key = r.reason === 'inactive' ? 'inactiveUser' : r.reason === 'taken' ? 'taken' : 'badCode';
        return send(call, chatId, staff ? t[key] : both(key));
      }
      const fresh = staffByTelegram(db, from.id);
      return send(call, chatId, (T[fresh.link.lang] || T.ru).linked(r.user.full_name), keyboard(fresh.link.lang));
    }
    if (param.startsWith('a_')) {
      const r = registerScan(db, { tgUserId: from.id, chatType: isPrivate ? 'private' : (msg.chat && msg.chat.type) || '', param, nowMs: nowMs ?? Date.now() });
      if (!isPrivate) return null;   // в группе молчим; попытка записана флагом
      if (!r.ok) return send(call, chatId, staff ? (t.reasons[r.reason] || t.reasons.bad_token) : bothReason(r.reason));
      const time = localTime(db, new Date(nowMs ?? Date.now()).toISOString());
      const prompt = r.kind === 'in' ? t.confirmIn(r.location.name, time) : t.confirmOut(r.location.name, time);
      return send(call, chatId, prompt, { reply_markup: { inline_keyboard: [[
        { text: r.kind === 'in' ? t.btnIn : t.btnOut, callback_data: `att:${r.scanId}` },
        { text: t.btnCancel, callback_data: `attx:${r.scanId}` },
      ]] } });
    }
    if (!isPrivate) return null;
    if (!staff) return send(call, chatId, both('notLinked'));
    return send(call, chatId, t.welcome(staff.user.full_name), keyboard(lang));
  }

  if (!isPrivate) return null;
  if (!staff) return send(call, chatId, both('notLinked'));

  const m = MENU[lang] || MENU.ru;
  if (text === m.attendance) return send(call, chatId, attendanceText(db, staff.user.id, t), keyboard(lang));
  if (text === m.profile) return send(call, chatId, profileText(db, staff, t), keyboard(lang));
  if (text === m.lang) {
    const next = lang === 'ru' ? 'uz' : 'ru';
    db.prepare('UPDATE staff_telegram_links SET lang = ? WHERE id = ?').run(next, staff.link.id);
    return send(call, chatId, T[next].langSet, keyboard(next));
  }
  return send(call, chatId, t.useMenu, keyboard(lang));
}

function attendanceText(db, userId, t) {
  const a = myAttendance(db, userId);
  const lines = [`<b>${t.attTitle}</b>`, ''];
  if (a.open) lines.push(t.attOpen(localTime(db, a.open_since)), '');
  if (!a.sessions.length) lines.push(t.attNone);
  for (const s of a.sessions) {
    const out = s.out_time || (s.missing_out ? t.noOut : '…');
    lines.push(`${esc(s.day.split('-').reverse().join('.'))}  ${esc(s.in_time)} – ${esc(out)}`);
  }
  lines.push('', t.attMonth(t.dur(a.month_minutes), a.month_shifts));
  return lines.join('\n');
}

function profileText(db, staff, t) {
  const p = db.prepare(`SELECT u.full_name, u.position, d.name AS department FROM users u
                        LEFT JOIN departments d ON d.id = u.department_id WHERE u.id = ?`).get(staff.user.id);
  return t.profile({ ...p, linked: localDateTime(db, staff.link.linked_at) });
}

async function handleCallback(db, cq, call, nowMs) {
  const data = String(cq.data || '');
  const from = cq.from || {};
  const chatId = cq.message && cq.message.chat && cq.message.chat.id;
  const messageId = cq.message && cq.message.message_id;
  const staff = staffByTelegram(db, from.id);
  const t = T[staff ? staff.link.lang : 'ru'] || T.ru;
  const ack = () => call('answerCallbackQuery', { callback_query_id: cq.id }).catch(() => {});
  const edit = (text) => call('editMessageText', { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML' }).catch(() => send(call, chatId, text));

  let m = /^att:(\d+)$/.exec(data);
  if (m) {
    const r = confirmScan(db, { tgUserId: from.id, scanId: Number(m[1]), nowMs: nowMs ?? Date.now() });
    await ack();
    if (!r.ok) return edit(staff ? (t.reasons[r.reason] || t.reasons.confirm_expired) : bothReason(r.reason));
    const loc = db.prepare(`SELECT l.name FROM attendance_scans s JOIN attendance_locations l ON l.id = s.location_id WHERE s.id = ?`).get(Number(m[1]));
    const time = localTime(db, r.at);
    return edit(r.kind === 'in' ? t.doneIn(time, loc ? loc.name : '') : t.doneOut(time, loc ? loc.name : '', t.dur(r.minutes || 0)));
  }
  m = /^attx:(\d+)$/.exec(data);
  if (m) {
    db.prepare(`UPDATE attendance_scans SET consumed_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'), result = 'cancelled'
                 WHERE id = ? AND tg_user_id = ? AND consumed_at IS NULL`).run(Number(m[1]), String(from.id));
    await ack();
    return edit(t.cancelled);
  }
  await ack();
  return null;
}
