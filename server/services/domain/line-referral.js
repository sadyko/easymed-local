// REFERRAL_LINE_V1 (2026-11-02, выпуск 3.21.0; решение владельца — «бонус обоим»)
// НАПРАВИВШИЙ НА СТРОКЕ ВИЗИТА: visit_services.referred_by_source_id (мигр. 270).
//
// Прежде направивший был признаком ВИЗИТА (visits.referral_source_id, иначе карточки
// пациента), и ensure_visit ставил его только при СОЗДАНИИ визита: направление врача в
// день, когда у пациента уже был визит (его собственная консультация), теряло
// направившего — dev: врач №18, 4 выставленные строки, бонус 0.
//
// КТО СТАВИТ — lineReferralStamp, одно место: компилятор /api/db (штамп реестра
// `resolve: 'line_referral'`, db/query-compiler.js stampValues) и серверные двери,
// которые сами вставляют строку от имени сотрудника (rpc/calendar.js calendar_book):
//   • стойка (администратор, регистратура — и дополнительной ролью) — ТОЛЬКО ЯВНО:
//     «Кто направил» мастера визита, «Код отправителя» быстрой регистрации. Источник
//     обязан существовать и быть включён, иначе отказ словами; не прислала — пусто.
//     Администратор-врач у стойки — стойка: свой источник сам не ставится;
//   • врач (is_doctor или роль врача / главного врача) без роли стойки — САМ СЕРВЕР:
//     его включённый внутренний источник (referral_sources.doctor_id, мигр. 122).
//     Присланное браузером врача значение не читается вовсе — иначе врач засчитывал бы
//     себе или коллеге чужую работу;
//   • своя строка — пусто: исполнитель строки — сам врач источника.
// Остальные роли строк визита через /api/db не вставляют (реестр).
//
// КОМУ ВОЗНАГРАЖДЕНИЕ — lineBeneficiaries, одно правило на отчёты (rpc/reports.js
// referralLines) и окно регистрации (rpc/referral-orders.js «кому бонус»): источник
// визита/пациента — как прежде; источник строки — ЕЩЁ И ЕМУ, если он другой (не тот же
// источник и не тот же сотрудник) и строка не своя для врача источника строки.
import { hasAnyRole } from '../roles.js';

export class LineReferralError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export const DESK_ROLES = Object.freeze(['admin', 'registrar']);
export const DOCTOR_ROLES = Object.freeze(['doctor', 'head_doctor']);
const posInt = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };

/** Стойка: администратор или регистратура (основной или дополнительной ролью). */
export function isDeskActor(user) { return hasAnyRole(user, DESK_ROLES); }

/** Врач: признак is_doctor (ADMIN_DOCTOR_V1) или роль врача / главного врача. */
export function isDoctorActor(user) {
  return !!user && (user.is_doctor === true || Number(user.is_doctor) === 1 || hasAnyRole(user, DOCTOR_ROLES));
}

/** Включённый внутренний источник сотрудника (один на врача — мигр. 122) или null. */
export function ownReferralSource(db, userId) {
  const id = posInt(userId);
  if (!db || !id) return null;
  return db.prepare('SELECT id, doctor_id FROM referral_sources WHERE doctor_id = ? AND active = 1 ORDER BY id LIMIT 1').get(id) || null;
}

/**
 * Направивший новой строки визита — id источника или null. Бросает LineReferralError
 * (status 400) на явный неверный или выключенный источник стойки.
 * @param {object|null} db
 * @param {object|null} user — сессия (role, extra_roles, is_doctor)
 * @param {object} row — то, что прислал экран (doctor_id — исполнитель строки)
 */
export function lineReferralStamp(db, user, row) {
  if (!db || !user) return null;
  const performer = posInt(row && row.doctor_id);
  let src = null;
  if (isDeskActor(user)) {
    const raw = row ? row.referred_by_source_id : undefined;
    if (raw === undefined || raw === null || raw === '') return null;
    const id = posInt(raw);
    if (!id) throw new LineReferralError('Источник направления указан неверно.');
    src = db.prepare('SELECT id, doctor_id, active FROM referral_sources WHERE id = ?').get(id) || null;
    if (!src || Number(src.active) !== 1) {
      throw new LineReferralError('Источник направления не найден или выключен — выберите другой.');
    }
  } else if (isDoctorActor(user)) {
    src = ownReferralSource(db, user.id);
    if (!src) return null;
  } else {
    return null;
  }
  if (src.doctor_id != null && performer != null && Number(src.doctor_id) === performer) return null;   // своя строка
  return Number(src.id);
}

/**
 * Получатели вознаграждения за строку: [{ source, via: 'visit' | 'line' }].
 * @param {{id:number|null, doctor_id:number|null}|null} base — источник визита/пациента
 * @param {{id:number, doctor_id:number|null}|null} line — источник самой строки
 * @param {number|null} performer — исполнитель строки (visit_services.doctor_id)
 */
export function lineBeneficiaries(base, line, performer) {
  const out = [];
  if (base) out.push({ source: base, via: 'visit' });
  if (!line) return out;
  const sameSource = base && base.id != null && Number(base.id) === Number(line.id);
  const sameEmployee = base && base.doctor_id != null && line.doctor_id != null && Number(base.doctor_id) === Number(line.doctor_id);
  const ownLine = line.doctor_id != null && performer != null && Number(line.doctor_id) === Number(performer);
  if (!sameSource && !sameEmployee && !ownLine) out.push({ source: line, via: 'line' });
  return out;
}
