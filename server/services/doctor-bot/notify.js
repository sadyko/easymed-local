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

/** FIX_318_V1 (H3) — номер связки — номер врача в справочнике (ключ номера CRM). */
export function linkMatchesSource(linkPhone, sourcePhone) {
  const k = phoneKey(linkPhone);
  return !!k && k === phoneKey(sourcePhone);
}

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
  const list = pendingNotifications(db, { now: deps.now || new Date().toISOString() });
  let sent = 0;
  for (const p of list) {
    if (!linkDeliverable(db, p.link_id)) continue;   // FIX_318_V1 (H3) — отозвали, пока шёл проход
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
