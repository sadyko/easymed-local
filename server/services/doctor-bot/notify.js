// REFERRALS_CRM_V1 (2026-10-26) — уведомление врачу-источнику о пришедшем пациенте.
//
// Снимок владельца: «когда направленный им пациент придёт (визит отмечен
// «пришёл»), бот пришлёт ФИО пациента и список услуг — без цен. Сообщение
// уходит через 2 минуты после последней добавленной услуги, о каждом визите
// один раз; о визитах до подключения врача бот не пишет».
//
// Поллер зовёт runNotifyScan раз в 30 секунд. Кандидаты — визиты со статусом
// arrived за последние LOOKBACK_DAYS дней, чей источник (COALESCE(визит,
// карточка пациента)) подключён к боту, по которым уведомления ещё не было,
// связка старше последнего изменения визита, а последняя услуга добавлена не
// меньше QUIET_MINUTES назад (нет услуг — считается от изменения визита).
// Повтор исключает UNIQUE(visit_id): строка вставляется ДО отправки, а при
// отказе Telegram удаляется — следующий проход попробует снова.
import { sendMessage, TelegramError } from '../telegram/api.js';

export const QUIET_MINUTES = 2;
export const LOOKBACK_DAYS = 3;
export const SEEN_BUTTON = 'Получил · Oldim';

const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

/** «26.10.2026» по местному времени сервера из ISO-строки визита. */
export function dmyLocal(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso || '');
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getDate()) + '.' + p(d.getMonth() + 1) + '.' + d.getFullYear();
}

export function composeMessage({ patient, visitDate, services = [] }) {
  const day = dmyLocal(visitDate);
  const lines = [`Пациент <b>${esc(patient)}</b> пришёл ${esc(day)}.`];
  if (services.length) {
    lines.push('Услуги:');
    for (const s of services) lines.push('• ' + esc(s));
  } else {
    lines.push('Услуги ещё не добавлены.');
  }
  lines.push('', `Bemor <b>${esc(patient)}</b> ${esc(day)} kuni keldi.`);
  return lines.join('\n');
}

export function pendingNotifications(db, { now = new Date().toISOString() } = {}) {
  return db.prepare(`
    SELECT v.id AS visit_id, v.visit_date, pt.full_name AS patient,
           rs.id AS source_id, rs.name AS source_name, l.id AS link_id, l.chat_id
      FROM visits v
      JOIN patients pt ON pt.id = v.patient_id
      JOIN referral_sources rs ON rs.id = COALESCE(v.referral_source_id, pt.referral_source_id)
      JOIN doctor_bot_links l ON l.referral_source_id = rs.id AND l.revoked_at IS NULL
      LEFT JOIN doctor_bot_notifications n ON n.visit_id = v.id
     WHERE n.id IS NULL
       AND v.status = 'arrived'
       AND rs.doctor_id IS NULL
       AND julianday(v.visit_date) >= julianday(@now) - @lookback
       AND julianday(v.visit_date) <= julianday(@now) + 1
       AND julianday(l.linked_at) <= julianday(v.updated_at)
       AND julianday(COALESCE((SELECT MAX(vs.created_at) FROM visit_services vs WHERE vs.visit_id = v.id), v.updated_at))
           <= julianday(@now) - @quiet
     ORDER BY v.visit_date`).all({ now, lookback: LOOKBACK_DAYS, quiet: QUIET_MINUTES / 1440 });
}

export function visitServices(db, visitId) {
  return db.prepare(`SELECT COALESCE(s.name, '') AS name
                       FROM visit_services vs LEFT JOIN services s ON s.id = vs.service_id
                      WHERE vs.visit_id = ? AND vs.status NOT IN ('cancelled', 'removed')
                      ORDER BY vs.id`).all(visitId).map((r) => r.name).filter(Boolean);
}

export async function runNotifyScan(db, token, deps = {}) {
  const list = pendingNotifications(db, { now: deps.now || new Date().toISOString() });
  let sent = 0;
  for (const p of list) {
    const text = composeMessage({ patient: p.patient, visitDate: p.visit_date, services: visitServices(db, p.visit_id) });
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
