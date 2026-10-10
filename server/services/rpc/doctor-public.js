// DOCTOR_PROFILE_V1 — «ЧТО УВИДЯТ ПАРТНЁРЫ» для карточки сотрудника (макет
// screen-doctor.js slotPreview, «Цены консультаций»): свободные окна врача на
// семь дней с завтрашнего, часы приёма по дням недели, сколько ждут сейчас,
// консультации с ценами и минутами, услуги-консультации врача из прайса
// (решение владельца 12).
//
// Всё считает то, что будет отдавать API (шаг 8): движок записи
// (calendar.js doctorDayWindows), правило цены консультации
// (shared/consultation-price.js), доска очереди (queue.js), правило цены
// строки услуги (domain/pricing.js doctorPriceFor).
//
// Только чтение (READ_ONLY_RPCS). Ворота — «Сотрудники: Просмотр» или
// администратор, как у списка сотрудников (routes/users.js).
import { grantAllowsAdminOr } from '../grants.js';
import { doctorDayWindows } from './calendar.js';
import { doctorQueueWaiting } from './queue.js';
import { today } from '../domain/day.js';
import { doctorPriceFor } from '../domain/pricing.js';
import { PREVIEW_DAYS, PUBLIC_SLOT_MIN, BOOKING_DAYS, DEFAULT_BOOKING_DAYS } from '../../../public/js/shared/doctor-public.js';
import { doctorConsultations } from '../../../public/js/shared/consultation-price.js';
import { categoryOf } from '../../../public/js/shared/service-categories.js';
import { isOn } from '../../../public/js/shared/flags.js';

export class RpcError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
export const PREVIEW_DENIED = 'Раздел «Сотрудники» вашей роли не выдан.';

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (dayIso, n) => { const [y, m, d] = dayIso.split('-').map(Number); return iso(new Date(y, m - 1, d + n)); };
function jsonArray(v) {
  if (Array.isArray(v)) return v;
  if (typeof v !== 'string' || !v.trim()) return [];
  try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; }
}

/** Консультации, которые врач ведёт: по общему правилу (решение владельца 8). */
export function doctorConsultOffer(db, doctorId) {
  const doctor = db.prepare('SELECT id, is_doctor FROM users WHERE id = ?').get(doctorId) || { id: doctorId, is_doctor: 0 };
  const types = db.prepare('SELECT * FROM consultation_types').all();
  const rows = db.prepare('SELECT * FROM doctor_consultation_prices WHERE doctor_id = ? ORDER BY id').all(doctorId);
  return doctorConsultations(types, rows, doctor);
}

/**
 * Решение владельца 12: услуги прайса группы «Консультации», которые врач
 * оказывает (users.service_rates — та же связь, что у кассы, окна записи, CRM и
 * оплаты врача). Цена — своя у врача, иначе каталог; online — показ услуги
 * (services.online_booking).
 */
export function doctorConsultServices(db, doctorId) {
  const u = db.prepare('SELECT service_rates FROM users WHERE id = ?').get(doctorId);
  const ids = [...new Set(jsonArray(u && u.service_rates).map((r) => Number(r && r.service_id)).filter((n) => Number.isInteger(n) && n > 0))];
  if (!ids.length) return [];
  const rows = db.prepare(`SELECT id, name, name_uz, name_en, price, type, is_lab, online_booking FROM services
                            WHERE active = 1 AND id IN (${ids.map(() => '?').join(',')}) ORDER BY name`).all(...ids);
  return rows.filter((s) => categoryOf(s) === 'Консультации').map((s) => {
    const own = doctorPriceFor(db, Number(doctorId), s.id);
    return {
      service_id: s.id, name: { ru: s.name || '', uz: s.name_uz || '', en: s.name_en || '' },
      price: own != null ? own : Math.max(0, Number(s.price) || 0), own: own != null, online: isOn(s.online_booking),
    };
  });
}

export function doctorPublicPreview(db, args, user) {
  if (!user) throw new RpcError('Нужно войти в систему.', 401);
  if (!grantAllowsAdminOr(db, user, 'settings.employees', 'view')) throw new RpcError(PREVIEW_DENIED, 403);
  const id = Number(args && args.doctor_id);
  if (!Number.isInteger(id) || id <= 0) throw new RpcError('Врач не найден.', 400);
  const doc = db.prepare('SELECT id, scheduling_mode, booking_days, show_queue_count FROM users WHERE id = ?').get(id);
  if (!doc) throw new RpcError('Врач не найден.', 400);
  const first = addDays(today(db), 1);
  const days = [];
  const hours = {};
  for (let i = 0; i < PREVIEW_DAYS; i += 1) {
    const day = doctorDayWindows(db, { doctorId: id, dayIso: addDays(first, i) });
    days.push({ date: day.date, weekday: day.weekday, windows: day.windows });
    hours[day.weekday] = day.window ? [day.window.from, day.window.to] : null;
  }
  const consultations = doctorConsultOffer(db, id);
  const initial = consultations.find((c) => c.api_kind === 'initial');
  return {
    doctor_id: id,
    scheduling_mode: doc.scheduling_mode === 'live_queue' ? 'live_queue' : 'schedulable',
    booking_days: BOOKING_DAYS.includes(Number(doc.booking_days)) ? Number(doc.booking_days) : DEFAULT_BOOKING_DAYS,
    show_queue_count: Number(doc.show_queue_count) === 1,
    slot_minutes: PUBLIC_SLOT_MIN,
    days, hours,
    queue_now: doctorQueueWaiting(db, id, today(db)),
    consultations,
    services: doctorConsultServices(db, id),
    initial_minutes: initial ? initial.minutes : null,
  };
}
