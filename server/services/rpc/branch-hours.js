// BRANCH_PROFILE_V1 — «КАКИМ ВРАЧАМ КАКОЕ ВРЕМЯ ЗАКРОЕТСЯ» до сохранения часов
// здания (спецификация, «Часы работы филиала»).
//
// Считает ТОТ ЖЕ движок, что слоты записи (slot-engine.js): окно врача на день
// (dayWindow — график из «Сотрудников», обед, умолчание 09:00–18:00), суженное
// часами здания (clinicWindow → clampWindow), минус обед (windowSegments).
// Было окно с прежними часами, стало с новыми — разница и есть потерянное время.
//
// Чьё время: врачи, у которых в «Сотрудниках» выбрано это здание
// (users.branch_id) — ровно те, чьё окно сужает rpc/calendar.js resourceWindow;
// «врач» — как колонка календаря (views/room-calendar.js:283: is_doctor, роль
// doctor или специальность). Уволенные (is_active = 0) — нет. Врачи без
// выбранного здания часами здания не ограничиваются (решение владельца
// 2026-10-10, вариант A) — их здесь и нет.
//
// Ничего не пишет. Ворота — право записи в branches (реестр + плитка «Филиалы»,
// db/write-grant.js tableWriteAllowed): кто не может сохранить часы, тому и
// считать незачем. В филиале — 409: часы правит главное здание.
import { WEEKDAY_KEYS, dayWindow, clinicWindow, clampWindow, windowSegments, formatHhmm } from './slot-engine.js';
import { tableWriteAllowed } from '../../db/write-grant.js';
import { readIdentity } from '../branch-sync/identity.js';
import { WEEK, storedHoursProblem } from '../../../public/js/shared/branch-hours.js';
import { BRANCH_MESSAGES } from '../../../public/js/shared/branch-profile.js';

export class RpcError extends Error {
  constructor(message, status = 400, code = null) { super(message); this.status = status; if (code) this.code = code; }
}

export const IMPACT_DENIED = 'Часы работы зданий меняет администратор или тот, кому выдано изменение «Филиалов».';

/** Отрезки a минус отрезки b (минуты от полуночи). */
function minus(a, b) {
  const out = [];
  for (const s of a) {
    let pieces = [{ from: s.from, to: s.to }];
    for (const t of b) {
      const next = [];
      for (const p of pieces) {
        if (t.to <= p.from || t.from >= p.to) { next.push(p); continue; }
        if (t.from > p.from) next.push({ from: p.from, to: t.from });
        if (t.to < p.to) next.push({ from: t.to, to: p.to });
      }
      pieces = next;
    }
    out.push(...pieces.filter((p) => p.to > p.from));
  }
  return out;
}

/** Потерянное время врача по дням недели (пн → вс): [{ day, from, to }]. */
export function lostHours(doctorHours, before, after) {
  const lost = [];
  for (const day of WEEK) {
    const wd = WEEKDAY_KEYS.indexOf(day);
    const own = dayWindow(doctorHours, wd);
    const was = windowSegments(clampWindow(own, clinicWindow(before, wd)));
    const now = windowSegments(clampWindow(own, clinicWindow(after, wd)));
    for (const p of minus(was, now)) lost.push({ day, from: formatHhmm(p.from), to: formatHhmm(p.to) });
  }
  return lost;
}

export function branchHoursImpact(db, args, user) {
  const a = args || {};
  if (!tableWriteAllowed('branches', 'update', user, db)) throw new RpcError(IMPACT_DENIED, 403, 'forbidden');
  let secondary = false;
  try { secondary = readIdentity(db).role === 'secondary'; } catch { secondary = false; }
  if (secondary) throw new RpcError(BRANCH_MESSAGES.mainOnly, 409, 'conflict');
  const wh = a.working_hours == null ? '{}' : a.working_hours;
  const bad = storedHoursProblem(wh);
  if (bad) throw new RpcError(bad, 400, 'bad_request');
  const id = Number(a.branch_id);
  if (!Number.isInteger(id) || id <= 0) return { doctors: [] };   // новое здание — врачей у него ещё нет
  const before = db.prepare('SELECT working_hours, is_24_7 FROM branches WHERE id = ?').get(id);
  if (!before) return { doctors: [] };
  // Как пишет экран и /api/db: 0/1 или true/false; строка '0' — не «круглосуточно».
  const after = { working_hours: wh, is_24_7: a.is_24_7 === true || Number(a.is_24_7) === 1 ? 1 : 0 };
  const rows = db.prepare(`SELECT id, full_name, working_hours FROM users
     WHERE branch_id = ? AND is_active = 1
       AND (is_doctor = 1 OR lower(role) = 'doctor' OR trim(coalesce(specialty, '')) <> '')
     ORDER BY full_name, id`).all(id);
  const doctors = [];
  for (const u of rows) {
    const lost = lostHours(u.working_hours, before, after);
    if (lost.length) doctors.push({ id: u.id, name: u.full_name || '', lost });
  }
  return { doctors };
}
