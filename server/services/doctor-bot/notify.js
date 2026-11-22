// REFERRALS_CRM_V1 (2026-10-26) — уведомление врачу-источнику о пришедшем пациенте.
//
// Снимок владельца: «когда направленный им пациент придёт (визит отмечен
// «пришёл»), бот пришлёт ФИО пациента и список услуг — без цен. Сообщение
// уходит через 2 минуты после последней добавленной услуги, о каждом визите
// один раз; о визитах до подключения врача бот не пишет».
//
// Поллер зовёт runNotifyScan раз в 30 секунд. Кандидаты — визиты со статусом
// arrived за последние LOOKBACK_DAYS дней, чей источник подключён к боту, по
// которым уведомления ещё не было, связка старше последнего изменения визита,
// а последняя услуга добавлена не меньше QUIET_MINUTES назад (нет услуг —
// считается от изменения визита). Повтор исключает UNIQUE(visit_id): строка
// вставляется ДО отправки, а при отказе Telegram удаляется — следующий проход
// попробует снова.
//
// FIX_318_V1 (ревью 3.18.0) — КОМУ И О ЧЁМ ПИШЕТ БОТ:
//   H3 — врач-источник ВКЛЮЧЁН (active = 1), и номер связки — всё ещё номер
//        врача в справочнике (ключ номера CRM, phoneKey). Выключенному врачу и
//        врачу со сменённым номером бот имён пациентов не шлёт (повтор R2);
//        триггер мигр. 257 их связки и так отзывает — это вторая линия. Перед
//        КАЖДОЙ отправкой связка проверяется снова: врача могли выключить,
//        пока шёл проход;
//   M2 — источник указан В САМОМ ВИЗИТЕ (visits.referral_source_id). Источник
//        карточки пациента — не повод: однажды направленный пациент иначе
//        «докладывал» внешнему Telegram каждый свой визит в любое отделение,
//        с услугами. И связка ПОДТВЕРЖДЕНА администратором (status
//        'confirmed', мигр. 257); «о визитах до подключения» — до подтверждения.
import { sendMessage, TelegramError } from '../telegram/api.js';
import { phoneKey } from '../../../public/js/admin/views/crm-phone-match.js';
import { T as FLOW_T } from './flow.js';
// DOCTOR_BOT_TEMPLATE_V1 — текст уведомления: шаблон клиники, общий модуль с вкладкой.
import { renderDoctorMessage, DEFAULT_TEMPLATE, SEEN_BUTTON as SHARED_SEEN_BUTTON } from '../../../public/js/admin/doctor-bot-message.js';

/** FIX_318_V1 (H3) — номер связки — номер врача в справочнике (ключ номера CRM). */
export function linkMatchesSource(linkPhone, sourcePhone) {
  const k = phoneKey(linkPhone);
  return !!k && k === phoneKey(sourcePhone);
}

export const QUIET_MINUTES = 2;
export const LOOKBACK_DAYS = 3;
export const SEEN_BUTTON = SHARED_SEEN_BUTTON;

/** «26.10.2026» по местному времени сервера из ISO-строки визита. */
export function dmyLocal(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso || '');
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getDate()) + '.' + p(d.getMonth() + 1) + '.' + d.getFullYear();
}

// DOCTOR_BOT_THANKS_V1 (владелец, 2026-11-20: «Name of patient and bought
// services without price and than you message for trust inside the message») —
// благодарность за доверие — в самом уведомлении, на обоих языках.
export const THANKS_RU = 'Спасибо за доверие к нашей клинике!';
export const THANKS_UZ = 'Klinikamizga bildirgan ishonchingiz uchun rahmat!';

// DOCTOR_BOT_TEMPLATE_V1 — благодарность теперь — часть стандартного шаблона
// (DEFAULT_TEMPLATE); клиника может переписать весь текст на вкладке.
export function composeMessage({ patient, visitDate, services = [], template = '' }) {
  return renderDoctorMessage(template, { patient, day: dmyLocal(visitDate), services });
}

/** Шаблон клиники из настроек; '' — стандартный (и в сборке без миграции 293). */
export function messageTemplate(db) {
  try { return (db.prepare('SELECT message_template FROM doctor_bot_settings WHERE id = 1').get() || {}).message_template || ''; }
  catch { return ''; }
}
export { DEFAULT_TEMPLATE };

/**
 * DOCTOR_BOT_AUTO_LINK_V1 — связки, вставшие в «ожидание» до отмены
 * подтверждения, подключаются сами: не отозваны, врач включён, номер связки —
 * всё ещё номер ровно этого врача. Врачу — «Вы подключены» (он видел только
 * «заявка отправлена»); не дошло — не страшно, подключение уже действует.
 */
export async function confirmPendingLinks(db, token, deps = {}) {
  const rows = db.prepare(`SELECT l.id, l.chat_id, l.phone AS link_phone, rs.phone AS source_phone, rs.name
                             FROM doctor_bot_links l JOIN referral_sources rs ON rs.id = l.referral_source_id
                            WHERE l.status = 'pending' AND l.revoked_at IS NULL AND rs.active = 1 AND rs.doctor_id IS NULL`).all()
    .filter((r) => linkMatchesSource(r.link_phone, r.source_phone));
  let confirmed = 0;
  for (const r of rows) {
    const ch = db.prepare(`UPDATE doctor_bot_links SET status = 'confirmed', confirmed_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
                            WHERE id = ? AND status = 'pending' AND revoked_at IS NULL`).run(r.id);
    if (!ch.changes) continue;
    confirmed += 1;
    try { await sendMessage(token, r.chat_id, FLOW_T.linked(r.name), {}, deps); }
    catch (e) { console.warn('[doctor-bot] linked notice', r.id, 'failed:', (e && e.message) || e); }
  }
  return confirmed;
}

export function pendingNotifications(db, { now = new Date().toISOString() } = {}) {
  return db.prepare(`
    SELECT v.id AS visit_id, v.visit_date, pt.full_name AS patient,
           rs.id AS source_id, rs.name AS source_name, l.id AS link_id, l.chat_id,
           rs.phone AS source_phone, l.phone AS link_phone
      FROM visits v
      JOIN patients pt ON pt.id = v.patient_id
      JOIN referral_sources rs ON rs.id = v.referral_source_id
      JOIN doctor_bot_links l ON l.referral_source_id = rs.id AND l.revoked_at IS NULL AND l.status = 'confirmed'
      LEFT JOIN doctor_bot_notifications n ON n.visit_id = v.id
     WHERE n.id IS NULL
       AND v.status = 'arrived'
       AND rs.doctor_id IS NULL
       AND rs.active = 1
       AND julianday(v.visit_date) >= julianday(@now) - @lookback
       AND julianday(v.visit_date) <= julianday(@now) + 1
       AND julianday(COALESCE(l.confirmed_at, l.linked_at)) <= julianday(v.updated_at)
       AND julianday(COALESCE((SELECT MAX(vs.created_at) FROM visit_services vs WHERE vs.visit_id = v.id), v.updated_at))
           <= julianday(@now) - @quiet
     ORDER BY v.visit_date`).all({ now, lookback: LOOKBACK_DAYS, quiet: QUIET_MINUTES / 1440 })
    .filter((r) => linkMatchesSource(r.link_phone, r.source_phone))
    .map(({ source_phone: _s, link_phone: _l, ...r }) => r);
}

// FIX_318_V1 (H3) — связка всё ещё вправе получать: не отозвана, подтверждена,
// врач включён, номер связки — его номер.
function linkDeliverable(db, linkId) {
  const r = db.prepare(`SELECT l.phone AS link_phone, rs.phone AS source_phone
                          FROM doctor_bot_links l JOIN referral_sources rs ON rs.id = l.referral_source_id
                         WHERE l.id = ? AND l.revoked_at IS NULL AND l.status = 'confirmed' AND rs.active = 1`).get(linkId);
  return !!r && linkMatchesSource(r.link_phone, r.source_phone);
}

export function visitServices(db, visitId) {
  return db.prepare(`SELECT COALESCE(s.name, '') AS name
                       FROM visit_services vs LEFT JOIN services s ON s.id = vs.service_id
                      WHERE vs.visit_id = ? AND vs.status NOT IN ('cancelled', 'removed')
                      ORDER BY vs.id`).all(visitId).map((r) => r.name).filter(Boolean);
}

export async function runNotifyScan(db, token, deps = {}) {
  await confirmPendingLinks(db, token, deps);   // DOCTOR_BOT_AUTO_LINK_V1
  const list = pendingNotifications(db, { now: deps.now || new Date().toISOString() });
  const template = list.length ? messageTemplate(db) : '';   // DOCTOR_BOT_TEMPLATE_V1
  let sent = 0;
  for (const p of list) {
    if (!linkDeliverable(db, p.link_id)) continue;   // FIX_318_V1 (H3) — отозвали, пока шёл проход
    const text = composeMessage({ patient: p.patient, visitDate: p.visit_date, services: visitServices(db, p.visit_id), template });
    const ins = db.prepare(`INSERT INTO doctor_bot_notifications (visit_id, referral_source_id, link_id, chat_id, text)
                            VALUES (?,?,?,?,?)`).run(p.visit_id, p.source_id, p.link_id, p.chat_id, text);
    const id = Number(ins.lastInsertRowid);
    try {
      const res = await sendMessage(token, p.chat_id, text,
        { reply_markup: { inline_keyboard: [[{ text: SEEN_BUTTON, callback_data: 'seen:' + id }]] } }, deps);
      db.prepare('UPDATE doctor_bot_notifications SET message_id = ? WHERE id = ?').run(String((res && res.message_id) || ''), id);
      sent += 1;
    } catch (e) {
      db.prepare('DELETE FROM doctor_bot_notifications WHERE id = ?').run(id);   // не дошло — следующий проход попробует снова
      if (e instanceof TelegramError && e.status === 403) {
        // Врач заблокировал бота: связку отзываем, иначе каждые 30 секунд — отказ.
        db.prepare("UPDATE doctor_bot_links SET revoked_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?").run(p.link_id);
      }
      console.warn('[doctor-bot] notify visit', p.visit_id, 'failed:', (e && e.message) || e);
    }
  }
  return { candidates: list.length, sent };
}
