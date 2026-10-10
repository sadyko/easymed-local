import { Router } from 'express';
import { hashPassword, validPassword } from '../services/auth.js';
import { VALID_ROLES, PRIMARY_ROLES } from '../services/roles.js';
import { lockedResponse } from '../services/control/gate.js';   // LICENCE_CORE_V1
import { isAdminUser, grantAllowsAdminOr } from '../services/grants.js';   // ADMIN_ROWS_GRANTABLE_V1
import { roleExceedsActor, isAdminRoleCode } from '../services/role-guard.js';   // ADMIN_ROWS_GRANTABLE_V1
// DOCTOR_PUBLIC_PROFILE_V1 — публичный профиль врача: те же проверки, что у
// «Моего профиля» врача (rpc/doctor-profile.js), и тот же вид для экранов.
import { cleanProfileFields, publicProfileOf, specialtyCountOf } from '../services/rpc/doctor-profile.js';   // DOCTOR_PROFILE_V1 — specialtyCountOf
// CLINIC_API_FIX_V1 — канон специальностей (тот же, что у профиля врача и отчётов).
import { SPECIALTY_ROWS, specialtyGroupName } from '../../public/js/shared/specialty-list.js';
import { BOOKING_DAYS, DEFAULT_BOOKING_DAYS, DOCTOR_PUBLIC_MESSAGES, publicationProblem, withExperience } from '../../public/js/shared/doctor-public.js';   // DOCTOR_PROFILE_V1

export { VALID_ROLES, PRIMARY_ROLES };

const TEXT_FIELDS = ['first_name', 'last_name', 'middle_name', 'phone', 'email', 'specialty', 'position', 'license_number'];
const DOCTOR_CATEGORIES = ['', 'highest', 'first', 'second', 'none'];
const EMPLOYMENT_TYPES = ['', 'official', 'civil_law', 'unofficial'];
const SALARY_TYPES = ['', 'fixed', 'percentage', 'fix_plus_kpi'];
const DATE_FIELDS = ['hire_date', 'license_expiry_date'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}/;
const STAFF_TYPES = ['', 'doctor', 'admin_staff', 'mid_low'];
const SCHEDULING_MODES = ['schedulable', 'live_queue'];
// CALL_FROM_CRM_V1 — a PBX extension as the exchanges accept it: onlinePBX uses
// 100…4999, Binotel's own numbering differs, and leading zeros occur. Digits
// plus the two keypad symbols, twelve characters at most — long enough for any
// house numbering, short enough that a full outside number cannot hide here.
const EXTENSION_RE = /^[0-9*#]{1,12}$/;

// Parses/validates the "employee record" fields shared by POST and PATCH.
// Returns only the keys present in `body` (so PATCH can do a partial update),
// or { ok:false, message } on the first validation failure.
// `currentRole` is the row's existing primary role; it's only consulted for
// extra_roles filtering when `body.role` is absent (PATCH that doesn't touch
// the primary role) — POST always carries `body.role`.
// CLINIC_API_FIX_V1 — `ownerId`: whose card this is. With it, public_profile
// .photo_url is accepted only from that employee's own folder
// (doctor-photos/doctors/<ownerId>/…, rpc/doctor-profile.js cleanProfileFields).
// PATCH passes the row's id; POST passes 0 — a new employee has no folder yet,
// and doctors/0/ never exists (routes/storage.js photoTarget requires id > 0).
export function parseEmployeeFields(body, db, currentRole, ownerId) {
  const fields = {};
  body = body || {};

  for (const key of TEXT_FIELDS) {
    if (body[key] === undefined) continue;
    fields[key] = String(body[key] ?? '').slice(0, 120).trim();
  }

  if (body.is_doctor !== undefined) {
    if (typeof body.is_doctor !== 'boolean') return { ok: false, message: 'Признак «врач» должен быть «да» или «нет».' };
    fields.is_doctor = body.is_doctor ? 1 : 0;
  }

  if (body.department_id !== undefined) {
    if (body.department_id === null || body.department_id === '') {
      fields.department_id = null;
    } else {
      const id = Number(body.department_id);
      if (!Number.isInteger(id) || id <= 0) return { ok: false, message: 'Отделение указано неверно.' };
      if (!db.prepare('SELECT 1 FROM departments WHERE id = ?').get(id)) return { ok: false, message: 'Такого отделения нет.' };
      fields.department_id = id;
    }
  }

  if (body.doctor_category !== undefined) {
    if (!DOCTOR_CATEGORIES.includes(body.doctor_category)) return { ok: false, message: 'Неизвестная категория врача.' };
    fields.doctor_category = body.doctor_category;
  }
  if (body.employment_type !== undefined) {
    if (!EMPLOYMENT_TYPES.includes(body.employment_type)) return { ok: false, message: 'Неизвестный вид занятости.' };
    fields.employment_type = body.employment_type;
  }
  if (body.salary_type !== undefined) {
    if (!SALARY_TYPES.includes(body.salary_type)) return { ok: false, message: 'Неизвестный вид оплаты труда.' };
    fields.salary_type = body.salary_type;
  }

  for (const key of DATE_FIELDS) {
    if (body[key] === undefined) continue;
    if (body[key] === '' || body[key] === null) { fields[key] = null; continue; }
    if (typeof body[key] !== 'string' || !DATE_RE.test(body[key])) return { ok: false, message: 'Дата указана неверно.' };
    fields[key] = body[key];
  }

  if (body.salary_fixed !== undefined) {
    const n = Number(body.salary_fixed);
    if (!Number.isFinite(n) || n < 0 || n > 1e12) return { ok: false, message: 'Оклад указан неверно.' };
    fields.salary_fixed = n;
  }
  if (body.salary_percent !== undefined) {
    const n = Number(body.salary_percent);
    if (!Number.isFinite(n) || n < 0 || n > 100) return { ok: false, message: 'Процент зарплаты должен быть от 0 до 100.' };
    fields.salary_percent = n;
  }

  if (body.staff_type !== undefined) {
    if (!STAFF_TYPES.includes(body.staff_type)) return { ok: false, message: 'Неизвестная категория сотрудника.' };
    fields.staff_type = body.staff_type;
  }
  if (body.scheduling_mode !== undefined) {
    if (!SCHEDULING_MODES.includes(body.scheduling_mode)) return { ok: false, message: 'Неизвестный режим расписания.' };
    fields.scheduling_mode = body.scheduling_mode;
  }

  // CALL_FROM_CRM_V1 (migration 134) — the employee's PBX extension. Deliberately
  // NOT one of TEXT_FIELDS: those take any 120 characters, and this value gets
  // DIALLED. Whatever lands here is handed to the PBX as "which handset to
  // ring", so it is checked the way a dialled string must be — digits and the
  // two keypad symbols, nothing else, and short. Empty clears it: plenty of
  // staff are not on the phone system at all, and that is not an error.
  if (body.pbx_extension !== undefined) {
    const ext = String(body.pbx_extension ?? '').trim();
    if (ext === '') fields.pbx_extension = null;
    else if (!EXTENSION_RE.test(ext)) return { ok: false, message: 'Внутренний номер указан неверно.' };
    else fields.pbx_extension = ext;
  }

  // DOCTOR_PUBLIC_PROFILE_V1 (миграция 159) — карточка сотрудника правит
  // публичный профиль врача: { public_profile: { bio_ru, …, *_entries: [...] } }.
  // Ключи и значения — белый список профиля; присланные ключи и только они.
  if (body.public_profile !== undefined) {
    // DOCTOR_PROFILE_V1 — «работает с» и прежний стаж пишутся вместе (withExperience).
    try { Object.assign(fields, withExperience(cleanProfileFields(body.public_profile, ownerId))); }   // CLINIC_API_FIX_V1 — фото только из папки владельца
    catch (e) { return { ok: false, message: e.message }; }
  }

  // DOCTOR_PROFILE_V1 (мигр. 243) — показ врача на сайте и у партнёров, срок
  // записи для партнёров, счётчик живой очереди. Кто вправе менять показ,
  // решает маршрут (только администратор, publicationRefusal); здесь — формат.
  for (const key of ['is_public', 'show_queue_count']) {
    if (body[key] === undefined) continue;
    if (typeof body[key] !== 'boolean') return { ok: false, message: DOCTOR_PUBLIC_MESSAGES.flag };
    fields[key] = body[key] ? 1 : 0;
  }
  if (body.booking_days !== undefined) {
    const n = Number(body.booking_days);
    if (!BOOKING_DAYS.includes(n)) return { ok: false, message: DOCTOR_PUBLIC_MESSAGES.bookingDays };
    fields.booking_days = n;
  }

  if (body.branch_id !== undefined) {
    if (body.branch_id === null || body.branch_id === '') {
      fields.branch_id = null;
    } else {
      const id = Number(body.branch_id);
      if (!Number.isInteger(id) || id <= 0) return { ok: false, message: 'Филиал указан неверно.' };
      if (!db.prepare('SELECT 1 FROM branches WHERE id = ?').get(id)) return { ok: false, message: 'Такого филиала нет.' };
      fields.branch_id = id;
    }
  }

  if (body.working_hours !== undefined) {
    if (typeof body.working_hours !== 'string') return { ok: false, message: 'Часы работы указаны неверно.' };
    fields.working_hours = body.working_hours.slice(0, 4000);
  }

  if (body.service_rate_default !== undefined) {
    const n = Number(body.service_rate_default);
    if (!Number.isFinite(n) || n < 0 || n > 100) return { ok: false, message: 'Процент за услуги по умолчанию должен быть от 0 до 100.' };
    fields.service_rate_default = n;
  }
  if (body.referral_rate_default !== undefined) {
    const n = Number(body.referral_rate_default);
    if (!Number.isFinite(n) || n < 0 || n > 100) return { ok: false, message: 'Процент за направления по умолчанию должен быть от 0 до 100.' };
    fields.referral_rate_default = n;
  }

  // Each list carries a money field under its own name: a performed service has
  // the doctor's own `price`, a referral rule has a `fixed` reward per referral.
  for (const [key, moneyKey] of [['service_rates', 'price'], ['referral_rates', 'fixed']]) {
    if (body[key] === undefined) continue;
    const parsed = parseRates(body[key], key, moneyKey);
    if (!parsed.ok) return { ok: false, message: parsed.message };
    fields[key] = parsed.value;
  }

  // INPATIENT_BONUS_V1 — вкладка «Стационар»: ставки за услуги в стационаре и
  // вознаграждение за направление пациента в стационар (% от оплаченного
  // счёта госпитализации и/или фикс за госпитализацию; 0 — не платится).
  if (body.inpatient_rates !== undefined) {
    const parsed = parseInpatientRates(body.inpatient_rates);
    if (!parsed.ok) return { ok: false, message: parsed.message };
    fields.inpatient_rates = parsed.value;
  }
  if (body.inpatient_referral_pct !== undefined) {
    const n = inpatientNumber(body.inpatient_referral_pct) ?? 0;
    if (!Number.isFinite(n) || n < 0 || n > 100) return { ok: false, message: 'За направление в стационар — процент от 0 до 100.' };
    fields.inpatient_referral_pct = n;
  }
  if (body.inpatient_referral_fixed !== undefined) {
    const n = inpatientNumber(body.inpatient_referral_fixed) ?? 0;
    if (!Number.isFinite(n) || n < 0 || n > MAX_RATE_MONEY) return { ok: false, message: 'За направление в стационар — сумма от 0 до 1 000 000 000 000.' };
    fields.inpatient_referral_fixed = n;
  }

  if (body.extra_roles !== undefined) {
    if (!Array.isArray(body.extra_roles)) return { ok: false, message: 'Дополнительные роли должны быть списком.' };
    for (const role of body.extra_roles) {
      if (typeof role !== 'string' || !VALID_ROLES.includes(role)) return { ok: false, message: 'Неизвестная дополнительная роль.' };
    }
    // The primary role (incoming if this call carries one, else the row's
    // existing one) is never allowed to also appear in the extras list.
    const primary = body.role !== undefined ? body.role : currentRole;
    const clean = [...new Set(body.extra_roles.filter(role => role !== primary))];
    fields.extra_roles = JSON.stringify(clean);
  }

  // staff_type is the source of truth for is_doctor: whenever it's supplied,
  // derive is_doctor from it (overriding any client-sent is_doctor) so the
  // two can never disagree.
  if (body.staff_type !== undefined) {
    fields.is_doctor = fields.staff_type === 'doctor' ? 1 : 0;
  }

  return { ok: true, fields };
}

const MAX_RATE_ENTRIES = 5000;
// Same ceiling as salary_fixed: guards the money maths downstream from a
// finite-but-absurd value overflowing to Infinity.
const MAX_RATE_MONEY = 1e12;

// Validates/cleans a service_rates or referral_rates array from the request
// body into `{ ok:true, value: JSON string }` or `{ ok:false, message }`.
// Each entry becomes a fresh { service_id, pct, fix?, price?, branches } object
// (extra keys dropped); duplicate service_id entries collapse to the last one.
//
// `moneyKey` names the entry's money field — 'price' for a performed service
// (DOCTOR_OWN_PRICE_V1: what THIS doctor charges for it, overriding the catalog)
// and 'fixed' for a referral reward. It used to be dropped on the floor for both,
// so a per-doctor price could be typed in, saved, and silently discarded.
function parseRates(val, key, moneyKey = 'price') {
  if (!Array.isArray(val)) return { ok: false, message: 'Ставки переданы неверно: нужен список.' };
  if (val.length > MAX_RATE_ENTRIES) return { ok: false, message: 'Слишком много строк в ставках.' };

  const byId = new Map();
  for (const entry of val) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { ok: false, message: 'Строка ставки заполнена неверно.' };
    }
    const serviceId = Number(entry.service_id);
    if (!Number.isInteger(serviceId) || serviceId <= 0) {
      return { ok: false, message: 'Строка ставки заполнена неверно.' };
    }

    // 'pct' is canonical (reports read $.pct). The editor has always sent
    // 'percentage'; accepting it as an alias stops the rate being silently
    // zeroed on every save.
    const rawPct = entry.pct !== undefined ? entry.pct : entry.percentage;
    // Ревью I5 (мигр. 155) — у ОКАЗЫВАЕМОЙ услуги (service_rates) отсутствие
    // процента значимо: запись без pct — «оказывает, ставка по умолчанию»
    // (отчёт: dr.percent NULL → service_rate_default; так её пишут окно
    // услуги и перенос 155). Дописанный сюда pct: 0 перекрыл бы ставку по
    // умолчанию нулём при первом же сохранении карточки. Записанный 0 —
    // решение клиники — остаётся нулём.
    const noPct = key === 'service_rates' && (rawPct === undefined || rawPct === null || rawPct === '');
    let pct = Number(rawPct);
    if (!Number.isFinite(pct)) pct = 0;
    pct = Math.min(100, Math.max(0, pct));

    // Money is OPTIONAL and absence is meaningful: no value (or an explicitly
    // empty one) means "this doctor has no own price — bill the catalog price".
    // A stored 0 is a real price of zero, not "unset", so the two must not be
    // conflated.
    const rawMoney = entry[moneyKey];
    let money = null;
    if (rawMoney !== undefined && rawMoney !== null && rawMoney !== '') {
      money = Number(rawMoney);
      if (!Number.isFinite(money) || money < 0 || money > MAX_RATE_MONEY) {
        return { ok: false, message: moneyKey === 'price'
          ? 'Цена врача в ставке — от 0 до 1 000 000 000 000.'
          : 'Сумма в ставке — от 0 до 1 000 000 000 000.' };
      }
    }

    // DOCTOR_FIX_RATE_V1 — a doctor may be paid a FIXED sum per unit of a
    // service instead of a percentage of its price (routine procedures are
    // commonly paid this way, and a percentage of a discounted price is not
    // what was agreed). Presence is the mode: a `fix` key means fixed pay,
    // its absence means the `pct` above applies. One field, so the stored mode
    // can never disagree with the stored number.
    //
    // `pct` is deliberately still kept alongside it, so switching a service
    // back to percentage in the editor restores the rate that was there.
    let fix = null;
    if (entry.fix !== undefined && entry.fix !== null && entry.fix !== '') {
      fix = Number(entry.fix);
      if (!Number.isFinite(fix) || fix < 0 || fix > MAX_RATE_MONEY) {
        return { ok: false, message: 'Фиксированная сумма в ставке — от 0 до 1 000 000 000 000.' };
      }
    }

    // INPATIENT_BONUS_V1 (мигр. 155) — ключа inpatient_pct в записи ставки
    // больше нет: стационарные ставки живут отдельно, в inpatient_rates
    // (parseInpatientRates ниже), и задаются во вкладке «Стационар». Ключ,
    // присланный старым экраном, отбрасывается вместе с прочими лишними.

    let branches = [];
    if (entry.branches !== undefined) {
      if (!Array.isArray(entry.branches)) return { ok: false, message: 'Строка ставки заполнена неверно.' };
      branches = entry.branches.map(Number);
      if (!branches.every(b => Number.isInteger(b) && b > 0)) {
        return { ok: false, message: 'Строка ставки заполнена неверно.' };
      }
    }

    const clean = noPct ? { service_id: serviceId, branches } : { service_id: serviceId, pct, branches };
    if (money !== null) clean[moneyKey] = money;
    if (fix !== null) clean.fix = fix;
    byId.set(serviceId, clean);
  }

  return { ok: true, value: JSON.stringify([...byId.values()]) };
}

// INPATIENT_BONUS_V1 (мигр. 155) — ставки врача за услуги, оказанные в
// СТАЦИОНАРЕ (вкладка «Стационар»; считает reports.js, INPATIENT_RATE_SQL):
// [{service_id, pct} | {service_id, fix}]. Хранятся ОТДЕЛЬНО от service_rates,
// поэтому стационарная ставка больше не заводит амбулаторной записи {pct: 0},
// перекрывавшей ставку по умолчанию.
//
// У записи ровно ОДНА ставка: процент (0..100) ЛИБО фиксированная сумма за
// единицу. Обе сразу — отказ: какая из них платится, иначе решал бы порядок
// ключей. Ни одной — тоже отказ: услуга без ставки в этом списке не стоит
// (пустое поле на экране снимает запись целиком). Значение вне границ не
// прижимается молча, а отклоняется: вводится руками, и 150 % — опечатка,
// которую надо показать. Повтор услуги — выигрывает последняя запись.
const INPATIENT_PCT_MSG = 'Стационарная ставка врача — процент от 0 до 100.';
const INPATIENT_FIX_MSG = 'Стационарная ставка врача — сумма от 0 до 1 000 000 000 000.';
function inpatientNumber(v) {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v === 'boolean') return NaN;
  return Number(v);
}
export function parseInpatientRates(val) {
  if (!Array.isArray(val)) return { ok: false, message: 'Стационарные ставки должны быть списком.' };
  if (val.length > MAX_RATE_ENTRIES) return { ok: false, message: 'Слишком много стационарных ставок.' };
  const byId = new Map();
  for (const entry of val) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return { ok: false, message: 'Строка ставки заполнена неверно.' };
    const serviceId = Number(entry.service_id);
    if (!Number.isInteger(serviceId) || serviceId <= 0) return { ok: false, message: 'Строка ставки заполнена неверно.' };
    const pct = inpatientNumber(entry.pct);
    const fix = inpatientNumber(entry.fix);
    if (pct !== undefined && fix !== undefined) return { ok: false, message: 'Стационарная ставка — либо процент, либо сумма, не обе сразу.' };
    if (pct === undefined && fix === undefined) return { ok: false, message: 'У услуги во вкладке «Стационар» не задана ставка.' };
    if (pct !== undefined) {
      if (!Number.isFinite(pct) || pct < 0 || pct > 100) return { ok: false, message: INPATIENT_PCT_MSG };
      byId.set(serviceId, { service_id: serviceId, pct });
    } else {
      if (!Number.isFinite(fix) || fix < 0 || fix > MAX_RATE_MONEY) return { ok: false, message: INPATIENT_FIX_MSG };
      byId.set(serviceId, { service_id: serviceId, fix });
    }
  }
  return { ok: true, value: JSON.stringify([...byId.values()]) };
}

// Parses a JSON-array-or-'' column (extra_roles, service_rates,
// referral_rates) back into a plain array; tolerant of empty/invalid stored
// values.
function parseJsonArray(raw) {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

// Trimmed, minimal-but-complete view of a staff record for the employee
// editor (unlike auth.js's publicUser, which stays deliberately tiny for
// session/roster contexts elsewhere in the app).
// CUSTOM_ROLES_V1 (2026-09-16) — СВОЯ РОЛЬ КЛИНИКИ У СОТРУДНИКА.
//
// Своя роль — это НАЗВАНИЕ и набор разделов поверх штатной ОСНОВЫ. Права к
// данным сервер по-прежнему решает по штатной роли, поэтому основа записывается
// в users.role сама: выбрали «Старший регистратор» — в role ляжет 'registrar'.
// Разойтись этим двум полям нельзя, иначе человек видел бы разделы, которых
// сервер ему не отдаст.
//
// Возвращает: { ok, code, role } — code === null означает «снять свою роль»,
// undefined — «не трогать».
export function resolveCustomRole(db, body, sentRole) {
  const raw = body ? body.custom_role_code : undefined;
  if (raw === undefined) return { ok: true, code: undefined, role: sentRole };
  if (raw === null || String(raw).trim() === '') return { ok: true, code: null, role: sentRole };
  const code = String(raw).trim();
  let row = null;
  try { row = db.prepare('SELECT code, base_role, active FROM custom_roles WHERE code = ?').get(code); }
  catch { row = null; }   // таблицы ещё нет (база до миграции 133)
  if (!row) return { ok: false, message: 'Такой роли клиники нет.' };
  if (!row.active) return { ok: false, message: 'Эта роль отключена — выберите другую.' };
  if (!PRIMARY_ROLES.includes(row.base_role)) return { ok: false, message: 'У роли клиники неизвестная основа.' };
  return { ok: true, code: row.code, role: row.base_role };
}

export function employeeView(u) {
  return {
    id: u.id, username: u.username, full_name: u.full_name, role: u.role, is_active: !!u.is_active,
    extra_roles: parseJsonArray(u.extra_roles),
    custom_role_code: u.custom_role_code || null,   // CUSTOM_ROLES_V1
    first_name: u.first_name, last_name: u.last_name, middle_name: u.middle_name,
    phone: u.phone, email: u.email, specialty: u.specialty, is_doctor: !!u.is_doctor,
    department_id: u.department_id, position: u.position, doctor_category: u.doctor_category,
    hire_date: u.hire_date, license_number: u.license_number, license_expiry_date: u.license_expiry_date,
    employment_type: u.employment_type, salary_type: u.salary_type,
    salary_fixed: u.salary_fixed, salary_percent: u.salary_percent,
    staff_type: u.staff_type, scheduling_mode: u.scheduling_mode, branch_id: u.branch_id,
    pbx_extension: u.pbx_extension || '',   // CALL_FROM_CRM_V1 — внутренний номер на АТС
    public_profile: publicProfileOf(u),     // DOCTOR_PUBLIC_PROFILE_V1
    // DOCTOR_PROFILE_V1 (мигр. 243) — показ на сайте и у партнёров, срок записи, счётчик очереди.
    is_public: Number(u.is_public) === 1,
    booking_days: BOOKING_DAYS.includes(Number(u.booking_days)) ? Number(u.booking_days) : DEFAULT_BOOKING_DAYS,
    show_queue_count: Number(u.show_queue_count) === 1,
    working_hours: u.working_hours, service_rate_default: u.service_rate_default,
    referral_rate_default: u.referral_rate_default,
    service_rates: parseJsonArray(u.service_rates), referral_rates: parseJsonArray(u.referral_rates),
    // INPATIENT_BONUS_V1 — вкладка «Стационар».
    inpatient_rates: parseJsonArray(u.inpatient_rates),
    inpatient_referral_pct: Number(u.inpatient_referral_pct) || 0,
    inpatient_referral_fixed: Number(u.inpatient_referral_fixed) || 0,
    created_at: u.created_at, updated_at: u.updated_at,
    // STAFF_SYNC_V1 (migration 086) — did this building create the row, or did
    // it arrive from the main clinic? The employees screen needs it to decide
    // whether the card is editable at all, and `=== 0` rather than `!u.is_local`
    // on purpose: an install whose database predates the migration returns
    // undefined for the column, and «unknown» must mean «local», not «managed
    // elsewhere» — otherwise a single-building clinic would find its whole staff
    // roster read-only after an upgrade.
    is_local: u.is_local !== 0,
  };
}

// STAFF_SYNC_V1 — the row belongs to the main clinic; this building may read it
// but not change it. Returns null when the row is this branch's own.
//
// The screen already hides the Save button for such a row, and this is still
// here for the reason every server-side check is: the screen is one client. A
// PATCH that went through would be overwritten by the next hourly sync anyway —
// silently, hours later — so refusing it outright is not merely stricter, it is
// the only answer that tells the truth about what would happen.
function mainClinicRow(user) {
  if (user.is_local !== 0) return null;
  return 'Этим сотрудником управляет главная клиника. Меняйте его там — правка здесь будет перезаписана при следующей синхронизации.';
}

// Derives "Last First Middle" from whichever name parts were supplied.
function deriveFullName(fields) {
  return [fields.last_name, fields.first_name, fields.middle_name]
    .map(s => (s || '').trim()).filter(Boolean).join(' ');
}

// MULTI_SPECIALTY_V1 (2026-09-15) — up to four specialties per doctor (owner:
// «we should be able to add up to 4 specialties»). The FIRST one is the
// primary and is also written to users.specialty, so every screen that reads
// the one column (booking, service picker, profile, print) keeps working;
// the full list lives in user_specialties (mig 026) as delete-then-insert.
export const MAX_SPECIALTIES = 4;
export function parseSpecialties(raw) {
  if (raw === undefined) return { ok: true, list: undefined };
  if (!Array.isArray(raw)) return { ok: false, message: 'Специальности должны быть списком.' };
  const list = [];
  const seen = new Set();
  for (const it of raw) {
    const name = String((it && typeof it === 'object' ? it.name : it) || '').trim().slice(0, 100);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const slug = it && typeof it === 'object' && it.slug ? String(it.slug).trim().slice(0, 80) : null;
    list.push({ name, slug });
  }
  if (list.length > MAX_SPECIALTIES) return { ok: false, message: `Не больше ${MAX_SPECIALTIES} специальностей.` };
  return { ok: true, list };
}
// CLINIC_API_FIX_V1 (2026-10-06) — строка пишется со слагом, ru И uz. Прежде
// здесь были только присланный слаг и name_ru: name_uz становился NULL, а у
// старого написания («Врач УЗД») слага не было. Теперь, как в профиле врача
// (rpc/doctor-profile.js): название ищется в SPECIALTY_ROWS через
// specialtyGroupName — старые написания и метки списка в любом регистре и с
// лишними пробелами («кардиолог», «лор», « Врач  узи »), тем же правилом, что
// группирует отчёт; слаг, ru и uz берутся оттуда, а не от клиента. Не из
// списка — слаг NULL, name_ru как набрано, name_uz NULL; но если у ЭТОГО
// сотрудника уже есть строка с тем же названием и со СТАРЫМ (не из списка)
// слагом от прежнего редактора, её слаг и uz сохраняются. Канонический слаг
// при названии не из списка — это слаг, когда-то принятый от клиента
// (`{ slug: 'kardiolog', name: 'Трихолог' }`): он и его uz не переживают
// пересохранения. Два написания одной специальности — одна строка.
// users.specialty здесь не трогается (его пишут POST / PATCH ниже, в одной
// транзакции с этой записью, — primarySpecialtyName).
const SPEC_BY_RU = new Map(SPECIALTY_ROWS.map((r) => [r.ru, r]));
const CANON_SLUGS = new Set(SPECIALTY_ROWS.map((r) => r.slug));
const specNameKey = (v) => String(v == null ? '' : v).trim().replace(/\s+/g, ' ').toLowerCase();
// CLINIC_API_FIX_V1 (ревью итога) — users.specialty — то же название, что
// основная (первая) строка writeSpecialties: каноническое из списка («Врач
// УЗД» → «Врач УЗИ», «кардиолог» → «Кардиолог»); не из списка — как прислано.
// Прежде здесь было первое название как прислано, и один врач читался двумя
// написаниями (строка — «Врач УЗИ», users.specialty — «Врач УЗД»). Свой
// профиль врача (rpc/doctor-profile.js) пишет так же — name_ru основной строки.
export function primarySpecialtyName(list) {
  if (!list || !list.length) return '';
  const name = String(list[0].name || '').trim();
  const canon = SPEC_BY_RU.get(specialtyGroupName(name));
  return canon ? canon.ru : name;
}
export function writeSpecialties(db, userId, list) {
  const own = new Map(db.prepare('SELECT specialty_slug, name_ru, name_uz FROM user_specialties WHERE user_id = ?').all(userId)
    .map((r) => [specNameKey(r.name_ru), r]));
  db.prepare('DELETE FROM user_specialties WHERE user_id = ?').run(userId);
  const ins = db.prepare('INSERT INTO user_specialties (user_id, specialty_slug, name_ru, name_uz, is_primary) VALUES (?, ?, ?, ?, ?)');
  const seen = new Set();
  for (const sp of list) {
    const name = String(sp.name || '').trim();
    const canon = SPEC_BY_RU.get(specialtyGroupName(name));
    const prev = canon ? null : own.get(specNameKey(name));
    const legacy = prev && !(prev.specialty_slug && CANON_SLUGS.has(prev.specialty_slug)) ? prev : null;
    const row = canon ? { slug: canon.slug, ru: canon.ru, uz: canon.uz }
      : { slug: legacy ? legacy.specialty_slug : null, ru: name, uz: legacy ? legacy.name_uz : null };
    const key = specNameKey(row.ru);
    if (!key || seen.has(key)) continue;
    ins.run(userId, row.slug, row.ru, row.uz, seen.size === 0 ? 1 : 0);
    seen.add(key);
  }
}
export function readSpecialties(db, userId) {
  return db.prepare('SELECT specialty_slug AS slug, name_ru AS name, is_primary FROM user_specialties WHERE user_id = ? ORDER BY is_primary DESC, id').all(userId)
    .map((r) => ({ slug: r.slug, name: r.name }));
}
// The view plus its list; a doctor saved before this feature has the one
// column and no rows — the list is then that one name.
function withSpecialties(db, view) {
  const list = readSpecialties(db, view.id);
  view.specialties = list.length ? list : (view.specialty ? [{ slug: null, name: view.specialty }] : []);
  return view;
}

// ---------------------------------------------------------------------------
// ADMIN_ROWS_GRANTABLE_V1 (2026-09-26) — «СОТРУДНИКИ» ВЫДАЮТСЯ ИЗ «РОЛЕЙ».
//
// Владелец: «there are some roles and functions which are only available to the
// administrator. can you make read, change, delete options for them too?».
// Весь роутер стоял за requireRole('admin'). Теперь каждый маршрут спрашивает
// уровень плитки «Сотрудники» (`settings.employees`): «Просмотр» — список и
// проверка удаления, «Изменение» — завести и править, «Удаление» — удалить.
// Роль, которая плитку не настраивала, живёт по прежнему правилу — только
// администратор (теперь и администратор дополнительной ролью, isAdminUser).
//
// Деньги карточки (зарплата, ставки) — отдельное действие «Цены и проценты»
// (`settings.employees.money`): без него не-администратор их не видит и не
// пишет.
//
// И главное — ЗАЩИТЫ ОТ САМОПОВЫШЕНИЯ, у не-администратора всегда:
//   • роль администратора (основная, дополнительная, своя роль на её основе)
//     не назначается;
//   • назначается только роль, у которой нет ничего сверх прав назначающего
//     (services/role-guard.js roleExceedsActor — то же сравнение, что у «Ролей»);
//   • учётную запись администратора не правят и пароль ей не меняют;
//   • пароль не сбрасывают тому, чья роль выше собственной (иначе войти под
//     ним — и есть повышение);
//   • свою роль не меняют; администратора и себя не удаляют.
// ---------------------------------------------------------------------------
const EMP_KEY = 'settings.employees';
const MONEY_KEY = 'settings.employees.money';
export const MONEY_FIELDS = ['salary_type', 'salary_fixed', 'salary_percent', 'service_rate_default', 'referral_rate_default', 'service_rates', 'referral_rates',
  // INPATIENT_BONUS_V1 — вкладка «Стационар»: те же правила «Цен и процентов».
  'inpatient_rates', 'inpatient_referral_pct', 'inpatient_referral_fixed'];

function forbid(res, message) {
  return res.status(403).json({ error: { code: 'forbidden', message } });
}

function requireEmployees(db, level) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: { code: 'unauthorized', message: 'Нужно войти в систему.' } });
    if (grantAllowsAdminOr(db, req.user, EMP_KEY, level)) return next();
    return forbid(res, 'Раздел «Сотрудники» недоступен вашей роли. Права выдаёт администратор в «Настройки → Роли».');
  };
}

/** Видит и пишет ли человек деньги карточки сотрудника. */
export function employeeMoneyAllowed(db, user) {
  return isAdminUser(user) || (grantAllowsAdminOr(db, user, EMP_KEY, 'edit') && grantAllowsAdminOr(db, user, MONEY_KEY, 'edit'));
}

function stripMoney(view) {
  for (const k of MONEY_FIELDS) delete view[k];
  return view;
}

/** Учётная запись администратора: основной, дополнительной ролью или своей ролью на её основе. */
function isAdminAccount(db, u) {
  if (!u) return false;
  if (u.role === 'admin' || parseJsonArray(u.extra_roles).includes('admin')) return true;
  return !!(u.custom_role_code && isAdminRoleCode(db, u.custom_role_code));
}

/**
 * Администратор ПО СОХРАНЁННОЙ роли — так, как его видит сервер (isAdminUser):
 * основная `admin` или `admin` среди дополнительных. Ревью (финал, мелочь 1):
 * своя роль, которую перевели на основу admin, пока users.role у людей прежний,
 * сервер администратором не считает — и последним администратором она не
 * засчитывается.
 */
function isStoredAdmin(u) {
  return !!u && isAdminUser({ role: u.role, extra_roles: parseJsonArray(u.extra_roles) });
}

/** Сколько активных администраторов (ревью a — и по дополнительной роли). */
function activeAdminCount(db) {
  return db.prepare('SELECT * FROM users WHERE is_active = 1').all().filter(isStoredAdmin).length;
}

/** Коды ролей, которые носит учётная запись. */
function accountRoleCodes(u) {
  const out = [];
  if (u.custom_role_code) out.push(u.custom_role_code); else out.push(u.role);
  for (const r of parseJsonArray(u.extra_roles)) if (!out.includes(r)) out.push(r);
  return out;
}

/** Отказ назначить эти роли (коды) — текст или null. */
function assignRefusal(db, actor, codes) {
  for (const code of codes) {
    if (!code) continue;
    if (isAdminRoleCode(db, code)) return 'Роль администратора назначает только администратор.';
    const excess = roleExceedsActor(db, actor, code);
    if (excess) return `Нельзя назначить роль «${code}»: у неё больше прав, чем у вас (${excess}). Такую роль назначает администратор.`;
  }
  return null;
}

export function userRoutes(db) {
  const r = Router();
  // Staff roster is sensitive and these pages run on shared clinic PCs.
  r.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  r.get('/', requireEmployees(db, 'view'), (req, res) => {
    const rows = db.prepare('SELECT * FROM users ORDER BY username').all();
    const money = employeeMoneyAllowed(db, req.user);
    res.json({ users: rows.map((u) => { const v = withSpecialties(db, employeeView(u)); return money ? v : stripMoney(v); }) });
  });

  r.post('/', requireEmployees(db, 'edit'), (req, res) => {
    // LICENCE_CORE_V1 — a THIRD write path (see licence-gate.test.js): staff
    // accounts bypass /api/db's registry entirely (it lists 'users' but with
    // every write role set empty, on purpose) and land straight here.
    if (req.control?.locked) return lockedResponse(res, req.control);
    const { username, password, full_name = '', role } = req.body || {};
    const name = String(username || '').trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,30}$/.test(name)) return bad(res, 'Логин — от 3 до 30 символов: латинские буквы, цифры, точка, _ и -.');
    if (!validPassword(password)) return bad(res, 'Пароль не может быть пустым (не длиннее 72 байт).');
    if (typeof full_name !== 'string') return bad(res, 'ФИО должно быть текстом.');
    // INPATIENT_FLOW_V1 — ОСНОВНОЙ ролью может быть только профессия.
    // 'head_doctor'/'senior_nurse' — надстройки поверх неё и живут в
    // extra_roles (см. EXTRA_ONLY_ROLES в services/roles.js): человек с такой
    // основной ролью не имел бы прав ни на одну таблицу реестра.
    // CUSTOM_ROLES_V1 — своя роль подставляет свою основу вместо присланной.
    const cr = resolveCustomRole(db, req.body, role);
    if (!cr.ok) return bad(res, cr.message);
    const finalRole = cr.code ? cr.role : role;
    if (!PRIMARY_ROLES.includes(finalRole)) return bad(res, 'Неизвестная роль.');
    // ADMIN_ROWS_GRANTABLE_V1 — не-администратор: ни роли администратора, ни
    // роли выше своей, ни денег без «Цен и процентов».
    if (!isAdminUser(req.user)) {
      const extras = Array.isArray(req.body && req.body.extra_roles) ? req.body.extra_roles : [];
      const refusal = assignRefusal(db, req.user, [cr.code || finalRole, ...extras]);
      if (refusal) return forbid(res, refusal);
      if (!employeeMoneyAllowed(db, req.user) && MONEY_FIELDS.some((k) => req.body[k] !== undefined)) {
        return forbid(res, 'Зарплату и ставки сотрудника меняет роль с правом «Сотрудники → Цены и проценты».');
      }
    }
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(name)) return bad(res, 'Такой логин уже занят.');

    const parsed = parseEmployeeFields(req.body, db, undefined, 0);   // CLINIC_API_FIX_V1 — новому сотруднику фото не ставится
    if (!parsed.ok) return bad(res, parsed.message);
    const ef = parsed.fields;
    const specs = parseSpecialties(req.body && req.body.specialties);   // MULTI_SPECIALTY_V1
    if (!specs.ok) return bad(res, specs.message);
    if (specs.list) ef.specialty = primarySpecialtyName(specs.list);   // CLINIC_API_FIX_V1 — как основная строка
    const pubRefusal = publicationRefusal(db, req.user, null, ef, specs.list);   // DOCTOR_PROFILE_V1
    if (pubRefusal) return pubRefusal.status === 403 ? forbid(res, pubRefusal.message) : bad(res, pubRefusal.message);

    const hasNameParts = req.body && (req.body.last_name !== undefined || req.body.first_name !== undefined || req.body.middle_name !== undefined);
    const finalFullName = hasNameParts ? deriveFullName(ef) : full_name.slice(0, 100).trim();

    const columns = ['username', 'password_hash', 'full_name', 'role', ...(cr.code !== undefined ? ['custom_role_code'] : []), ...Object.keys(ef)];
    const placeholders = columns.map(() => '?').join(',');
    const values = [name, hashPassword(password), finalFullName, finalRole,
                    ...(cr.code !== undefined ? [cr.code] : []), ...Object.values(ef)];
    // CLINIC_API_FIX_V1 — сотрудник и его специальности — одна транзакция:
    // сбой вставки специальности не оставляет сотрудника без них.
    const info = db.transaction(() => {
      const ins = db.prepare(`INSERT INTO users (${columns.join(',')}) VALUES (${placeholders})`).run(...values);
      if (specs.list) writeSpecialties(db, Number(ins.lastInsertRowid), specs.list);
      return ins;
    })();
    const created = withSpecialties(db, employeeView(db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid)));
    res.status(201).json({ user: employeeMoneyAllowed(db, req.user) ? created : stripMoney(created) });
  });

  r.patch('/:id', requireEmployees(db, 'edit'), (req, res) => {
    // LICENCE_CORE_V1 — same write gate as POST above.
    if (req.control?.locked) return lockedResponse(res, req.control);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!user) return res.status(404).json({ error: { code: 'not_found', message: 'Сотрудник не найден.' } });
    // STAFF_SYNC_V1 — 409, not 403: the request is well-formed and the caller is
    // an admin; it is the clinic's own arrangement that forbids it. Same status
    // and shape as the delete guard below.
    const managed = mainClinicRow(user);
    if (managed) return res.status(409).json({ error: { code: 'conflict', message: managed } });
    const { full_name, role, is_active, password } = req.body || {};

    // is_active must be a real boolean: `0`/`null`/`""` would slip past the
    // self-protection check below, and `"false"` would truthy-coerce to 1.
    let active; // undefined = leave unchanged
    if (is_active !== undefined) {
      if (typeof is_active !== 'boolean') return bad(res, 'Признак «активен» должен быть «да» или «нет».');
      active = is_active;
    }
    if (role !== undefined && !PRIMARY_ROLES.includes(role)) return bad(res, 'Неизвестная роль.');   // INPATIENT_FLOW_V1 — см. POST выше
    // CUSTOM_ROLES_V1 — выбрали свою роль: её основа становится ролью строки.
    const cr = resolveCustomRole(db, req.body, role);
    if (!cr.ok) return bad(res, cr.message);
    const roleToWrite = cr.code ? cr.role : role;
    if (password !== undefined && !validPassword(password)) {
      return bad(res, 'Пароль не может быть пустым (не длиннее 72 байт).');
    }
    if (full_name !== undefined && typeof full_name !== 'string') return bad(res, 'ФИО должно быть текстом.');
    // ADMIN_ROWS_GRANTABLE_V1 — защиты не-администратора (см. шапку роутера).
    const extrasAfter = req.body && Array.isArray(req.body.extra_roles) ? req.body.extra_roles : parseJsonArray(user.extra_roles);
    const after = { ...user, role: roleToWrite !== undefined ? roleToWrite : user.role, extra_roles: JSON.stringify(extrasAfter),
      custom_role_code: cr.code !== undefined ? cr.code : user.custom_role_code };
    if (!isAdminUser(req.user)) {
      const self = user.id === req.user.id;
      if (isAdminAccount(db, user)) return forbid(res, 'Учётную запись администратора меняет только администратор.');
      if (self && active === false) return bad(res, 'Нельзя отключить свою учётную запись или понизить свою роль.');
      // Ревью (b) и C1 — учётную запись, чья роль (основа или права) сильнее
      // своей, не-администратор не трогает вовсе: ни пароля (войти под ней —
      // и есть повышение), ни отключения, ни полей.
      if (!self) {
        for (const code of accountRoleCodes(user)) {
          const excess = roleExceedsActor(db, req.user, code);
          if (excess) return forbid(res, `Этого сотрудника меняет администратор: у его роли больше прав, чем у вас (${excess}).`);
        }
      }
      // Ревью I4 — свою зарплату и ставки не правит никто, кроме
      // администратора, какое бы право ни было выдано.
      if (self && MONEY_FIELDS.some((k) => req.body[k] !== undefined)) {
        return forbid(res, 'Свою зарплату и ставки меняет администратор.');
      }
      const extrasIn = req.body && Array.isArray(req.body.extra_roles) ? req.body.extra_roles : null;
      const curExtras = parseJsonArray(user.extra_roles);
      const primaryNow = roleToWrite !== undefined ? roleToWrite : user.role;
      const primaryChanged = primaryNow !== user.role;
      const customChanged = cr.code !== undefined && (cr.code || null) !== (user.custom_role_code || null);
      const addedExtras = extrasIn ? extrasIn.filter((x) => x !== primaryNow && !curExtras.includes(x)) : [];
      const extrasChanged = !!extrasIn && (addedExtras.length > 0 || curExtras.some((x) => x !== primaryNow && !extrasIn.includes(x)));
      if (self && (primaryChanged || customChanged || extrasChanged)) return forbid(res, 'Свою роль менять нельзя — это делает администратор.');
      const assigned = [];
      if (customChanged && cr.code) assigned.push(cr.code);
      else if (primaryChanged || customChanged) assigned.push(primaryNow);
      assigned.push(...addedExtras);
      const refusal = assignRefusal(db, req.user, assigned);
      if (refusal) return forbid(res, refusal);
      if (!employeeMoneyAllowed(db, req.user) && MONEY_FIELDS.some((k) => req.body[k] !== undefined)) {
        return forbid(res, 'Зарплату и ставки сотрудника меняет роль с правом «Сотрудники → Цены и проценты».');
      }
    } else if (user.id === req.user.id && (active === false || (isAdminAccount(db, user) && !isAdminAccount(db, after)))) {
      // Ревью (a) — себя не разжаловать никаким путём: ни основной ролью, ни
      // снятой дополнительной «admin» (администратор-врач), ни своей ролью.
      return bad(res, 'Нельзя отключить свою учётную запись или понизить свою роль.');
    }
    // Belt-and-braces: the clinic must never end up with zero active admins.
    // Ревью (a) — администратор считается по isAdminAccount: основной ролью,
    // дополнительной и своей ролью на основе администратора.
    const losesAdmin = active === false || !isStoredAdmin(after);
    if (losesAdmin && isStoredAdmin(user) && user.is_active && activeAdminCount(db) <= 1) {
      return bad(res, 'В клинике должен остаться хотя бы один активный администратор.');
    }

    const parsed = parseEmployeeFields(req.body, db, user.role, user.id);   // CLINIC_API_FIX_V1 — фото только из папки этого сотрудника
    if (!parsed.ok) return bad(res, parsed.message);
    const ef = parsed.fields;
    const specs = parseSpecialties(req.body && req.body.specialties);   // MULTI_SPECIALTY_V1
    if (!specs.ok) return bad(res, specs.message);
    if (specs.list) ef.specialty = primarySpecialtyName(specs.list);   // CLINIC_API_FIX_V1 — как основная строка
    const pubRefusal = publicationRefusal(db, req.user, user, ef, specs.list);   // DOCTOR_PROFILE_V1
    if (pubRefusal) return pubRefusal.status === 403 ? forbid(res, pubRefusal.message) : bad(res, pubRefusal.message);

    // If any name part was supplied, recompute full_name from the merged
    // (existing + incoming) parts rather than from the incoming ones alone,
    // so patching just last_name doesn't blank out first_name in the display name.
    const hasNameParts = req.body && (req.body.last_name !== undefined || req.body.first_name !== undefined || req.body.middle_name !== undefined);
    let finalFullName = full_name !== undefined ? full_name.slice(0, 100).trim() : undefined;
    if (hasNameParts) {
      finalFullName = deriveFullName({
        last_name: ef.last_name !== undefined ? ef.last_name : user.last_name,
        first_name: ef.first_name !== undefined ? ef.first_name : user.first_name,
        middle_name: ef.middle_name !== undefined ? ef.middle_name : user.middle_name,
      });
    }

    const efKeys = Object.keys(ef);
    const setClauses = [
      'full_name     = COALESCE(?, full_name)',
      'role          = COALESCE(?, role)',
      ...(cr.code !== undefined ? ['custom_role_code = ?'] : []),
      'is_active     = COALESCE(?, is_active)',
      'password_hash = COALESCE(?, password_hash)',
      ...efKeys.map(k => `${k} = ?`),
      "updated_at    = strftime('%Y-%m-%dT%H:%M:%SZ','now')",
    ];
    const values = [
      finalFullName !== undefined ? finalFullName : null,
      roleToWrite ?? null,
      ...(cr.code !== undefined ? [cr.code] : []),
      active === undefined ? null : (active ? 1 : 0),
      password !== undefined ? hashPassword(password) : null,
      ...efKeys.map(k => ef[k]),
    ];
    // CLINIC_API_FIX_V1 — UPDATE users (с users.specialty) и DELETE + INSERT
    // специальностей — одна транзакция, как в профиле врача
    // (rpc/doctor-profile.js): сбой на середине не оставляет ни стёртого списка,
    // ни новой основной специальности при старом списке.
    db.transaction(() => {
      db.prepare(`UPDATE users SET ${setClauses.join(', ')} WHERE id = ?`).run(...values, user.id);
      if (specs.list) writeSpecialties(db, user.id, specs.list);
    })();
    // Deactivation OR password reset must end the target's sessions (a reset
    // is the standard response to a suspected compromise). The acting admin's
    // own session survives a self password change.
    if (active === false || password !== undefined) {
      db.prepare('DELETE FROM sessions WHERE user_id = ? AND id <> ?').run(user.id, req.sessionId ?? '');
    }
    const outView = withSpecialties(db, employeeView(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id)));
    res.json({ user: employeeMoneyAllowed(db, req.user) ? outView : stripMoney(outView) });
  });

  // STAFF_DELETE_V1 — what removing this employee would do, without doing it.
  // Lets the UI offer «удалить» or «отключить» honestly rather than proposing a
  // delete that was never possible.
  r.get('/:id/delete-check', requireEmployees(db, 'view'), (req, res) => {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!user) return res.status(404).json({ error: { code: 'not_found', message: 'Сотрудник не найден.' } });
    const managed = mainClinicRow(user);           // STAFF_SYNC_V1
    let guard = managed ? { ok: false, reason: managed } : staffDeleteGuard(db, user, req.user);
    // ADMIN_ROWS_GRANTABLE_V1 — проверка отвечает то же, что ответит удаление.
    if (guard.ok && !isAdminUser(req.user) && isAdminAccount(db, user)) guard = { ok: false, reason: ADMIN_DELETE_REFUSAL };
    res.json({
      name: user.full_name || user.username,
      deletable: guard.ok,
      reason: guard.reason || null,
      blocking: guard.blocking || [],
    });
  });

  r.delete('/:id', requireEmployees(db, 'delete'), (req, res) => {
    // LICENCE_CORE_V1 — same write gate as POST above. GET /:id/delete-check
    // stays open: it's a read-only dry run, never a write.
    if (req.control?.locked) return lockedResponse(res, req.control);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!user) return res.status(404).json({ error: { code: 'not_found', message: 'Сотрудник не найден.' } });
    // STAFF_SYNC_V1 — and deleting is worse than editing: the next
    // synchronisation would simply create the person again, under a NEW local
    // id, leaving this building's history pointing at a row nobody works under.
    const managedDelete = mainClinicRow(user);
    if (managedDelete) return res.status(409).json({ error: { code: 'conflict', message: managedDelete } });

    // ADMIN_ROWS_GRANTABLE_V1 — администратора удаляет только администратор;
    // сотрудника с ролью сильнее своей — тоже (ревью b).
    if (!isAdminUser(req.user) && isAdminAccount(db, user)) return forbid(res, ADMIN_DELETE_REFUSAL);
    if (!isAdminUser(req.user) && user.id !== req.user.id) {
      for (const code of accountRoleCodes(user)) {
        const excess = roleExceedsActor(db, req.user, code);
        if (excess) return forbid(res, `Этого сотрудника удаляет администратор: у его роли больше прав, чем у вас (${excess}).`);
      }
    }
    const guard = staffDeleteGuard(db, user, req.user);
    if (!guard.ok) {
      // 409: the request is well-formed, the clinic's state forbids it.
      return res.status(guard.status || 409).json({ error: { code: 'conflict', message: guard.reason } });
    }

    const name = user.full_name || user.username;
    // V3120_FIX — последняя стена: если запись о работе сотрудника всё же
    // нашлась там, куда проверка не заглянула, — внятный отказ, а не 500.
    try {
    db.transaction(() => {
      for (const ref of STAFF_CONFIG_REFS) {
        for (const col of ref.columns) db.prepare(`DELETE FROM "${ref.table}" WHERE "${col}" = ?`).run(user.id);
      }
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
      db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
    })();
    } catch (e) {
      if (e && String(e.code || '').startsWith('SQLITE_CONSTRAINT')) {
        return res.status(409).json({ error: { code: 'conflict', message:
          `За сотрудником «${name}» закреплены записи — удалить его нельзя, иначе история потеряет автора. `
          + 'Отключите учётную запись: сотрудник исчезнет из выбора и не сможет войти, а записи останутся целыми.' } });
      }
      throw e;
    }

    res.json({ deleted: true, id: user.id, name });
  });

  return r;
}

// DOCTOR_PROFILE_V1 — ПОКАЗ ВРАЧА НА САЙТЕ И У ПАРТНЁРОВ.
//   • меняет только администратор (спецификация, «Правила»): отказ — только
//     если значение МЕНЯЕТСЯ (карточка шлёт неизменённое — не беда);
//   • показываемый врач — с ФИО на русском и хотя бы одной специальностью
//     (макет «Публичный профиль»). Проверяется, когда запрос трогает показ, ФИО
//     на русском или специальности: правка оклада у давнего врача не держится.
// row — строка до правки (null у нового), ef — разобранные поля, specsList —
// присланный список специальностей (undefined — не присылали).
function publicationRefusal(db, actor, row, ef, specsList) {
  const was = !!row && Number(row.is_public) === 1;
  if (ef.is_public !== undefined && (ef.is_public === 1) !== was && !isAdminUser(actor)) {
    return { status: 403, message: DOCTOR_PUBLIC_MESSAGES.adminOnly };
  }
  // Ревью шага 5 (укрепление) — и прежнее поле specialty без списка: без строк
  // списка оно одно держит специальность врача (specialtyCountOf).
  if (ef.is_public === undefined && !('full_name_ru' in ef) && specsList === undefined && !('specialty' in ef)) return null;
  const isPublic = ef.is_public !== undefined ? ef.is_public : (was ? 1 : 0);
  const name = 'full_name_ru' in ef ? ef.full_name_ru : (row ? row.full_name_ru : '');
  const specs = specsList !== undefined ? specsList.length
    : specialtyCountOf(db, row ? row.id : null, 'specialty' in ef ? ef.specialty : undefined);
  const problem = publicationProblem({ is_public: isPublic, full_name_ru: name, specialties: specs });
  return problem ? { status: 400, message: problem } : null;
}

const ADMIN_DELETE_REFUSAL = 'Администратора удаляет только администратор.';

// STAFF_DELETE_V1 — tables recording WHAT AN EMPLOYEE DID. A reference from any
// of these means the roster row is the only thing that still names the person on
// a visit, a bill, a shift or an audit line, so it has to survive. Labels are
// user-facing (Russian, like the rest of the admin UI).
const STAFF_HISTORY_REFS = [
  { table: 'visits',                  columns: ['doctor_id', 'created_by'],   label: 'визиты' },
  { table: 'visit_services',          columns: ['doctor_id', 'created_by', 'verified_by'], label: 'оказанные услуги' },
  { table: 'invoices',                columns: ['created_by'],                label: 'счета' },
  { table: 'payments',                columns: ['cashier_id'],                label: 'платежи' },
  { table: 'cash_shifts',             columns: ['cashier_id', 'closed_by'],   label: 'кассовые смены' },   // closed_by: CASHIER_HEAD_V1 (мигр. 219)
  { table: 'cash_movements',          columns: ['created_by'],                label: 'кассовые операции' },
  { table: 'invoice_audit_log',       columns: ['actor_user_id'],             label: 'журнал счетов' },
  { table: 'patient_activity_log',    columns: ['actor_user_id'],             label: 'журнал действий' },
  { table: 'patients',                columns: ['primary_doctor_id', 'created_by'], label: 'карты пациентов' },
  { table: 'lab_results',             columns: ['entered_by', 'verified_by'], label: 'результаты лаборатории' },
  { table: 'admissions',              columns: ['doctor_id', 'created_by'],   label: 'госпитализации' },
  { table: 'admission_services',      columns: ['doctor_id'],                 label: 'услуги стационара' },
  { table: 'admission_transfers',     columns: ['transferred_by'],            label: 'переводы в стационаре' },
  { table: 'admission_prescriptions', columns: ['prescribed_by'],             label: 'назначения' },
  { table: 'med_administrations',     columns: ['administered_by'],           label: 'введения препаратов' },
  { table: 'visit_documents',         columns: ['created_by'],                label: 'документы визитов' },
  { table: 'patient_vitals',          columns: ['recorded_by'],               label: 'показатели пациентов' },
  { table: 'patient_deposits',        columns: ['created_by', 'received_by'], label: 'депозиты пациентов' },
  { table: 'stock_movements',         columns: ['created_by'],                label: 'движения склада' },
  { table: 'purchase_orders',         columns: ['created_by'],                label: 'заказы поставщикам' },
  { table: 'purchase_requisitions',   columns: ['requested_by'],              label: 'заявки на закупку' },
  { table: 'stock_counts',            columns: ['counted_by'],                label: 'инвентаризации' },
  { table: 'recommended_services',    columns: ['recommended_by'],            label: 'рекомендации услуг' },
  { table: 'consultation_templates',  columns: ['author_id'],                 label: 'шаблоны консультаций' },
  { table: 'crm_requests',            columns: ['assigned_to', 'created_by'], label: 'заявки CRM' },
  // CRM_DEDUP_SEARCH_TASKS_V1 (mig 148) — без этой строки удаление упиралось во внешний ключ и отвечало 500.
  { table: 'crm_tasks',               columns: ['assignee_id', 'done_by', 'created_by'], label: 'задачи CRM' },
  // V3120_FIX — стационар, листы назначений, закрытие месяца, Telegram: таблицы,
  // появившиеся после STAFF_DELETE_V1. Без них удаление отвечало 500 (внешний
  // ключ). Всё, что сюда не вписано, ловит staffHistoryFkRefs() ниже —
  // по самой схеме базы.
  { table: 'admission_reviews',       columns: ['author_id'],                 label: 'осмотры в стационаре' },
  { table: 'admission_vitals',        columns: ['measured_by'],               label: 'показатели в стационаре' },
  { table: 'treatment_orders',        columns: ['ordered_by', 'created_by'],  label: 'листы назначений' },
  { table: 'treatment_administrations', columns: ['performed_by', 'voided_by'], label: 'отметки выполнения назначений' },
  { table: 'pay_periods',             columns: ['closed_by'],                 label: 'закрытые месяцы оплаты врачей' },
  { table: 'pay_period_log',          columns: ['user_id'],                   label: 'журнал закрытия месяцев' },
  // OWN_SHELF_ONLY_V1 (ревью F5, мигр. 226) — кто переключал «Только со своих полок».
  { table: 'stock_settings',          columns: ['changed_by'],                label: 'настройка «Только со своих полок»' },
  { table: 'stock_settings_log',      columns: ['changed_by'],                label: 'журнал переключателя «Только со своих полок»' },
  // Ревью F6 (та же мигр. 226) — кто ввёл дозу «не списано со склада» и кто её списал.
  { table: 'stock_pending_writeoffs', columns: ['given_by', 'settled_by'],    label: '«не списано со склада»' },
];

// V3120_FIX — ЛЮБАЯ ССЫЛКА НА СОТРУДНИКА ИЗ СХЕМЫ. Список выше — с понятными
// подписями; но таблицы с колонкой «кто» появляются в каждом выпуске, и
// каждая забытая здесь превращала удаление в 500. Поэтому к списку добавляются
// все внешние ключи на users, которые база сама не обнуляет и не удаляет
// (ON DELETE SET NULL / CASCADE удалению не мешают), кроме настроек сотрудника
// (STAFF_CONFIG_REFS) и сессий. Колонки, которых в этой базе нет, в списке
// выше пропускаются (existingColumns).
function staffHistoryFkRefs(db) {
  const named = new Set(STAFF_HISTORY_REFS.flatMap((r) => r.columns.map((c) => r.table + '.' + c)));
  const skip = new Set(['sessions', ...STAFF_CONFIG_REFS.map((r) => r.table)]);
  const out = [];
  let tables = [];
  try { tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name); }
  catch { tables = []; }
  for (const t of tables) {
    if (skip.has(t) || t === 'users') continue;
    let fks = [];
    try { fks = db.prepare(`PRAGMA foreign_key_list("${t.replace(/"/g, '')}")`).all(); } catch { fks = []; }
    const cols = fks.filter((f) => f.table === 'users'
      && !['SET NULL', 'CASCADE', 'SET DEFAULT'].includes(String(f.on_delete || '').toUpperCase())
      && !named.has(t + '.' + f.from)).map((f) => f.from);
    if (cols.length) out.push({ table: t, columns: [...new Set(cols)], label: 'другие записи (' + t + ')' });
  }
  return out;
}

function existingColumns(db, ref) {
  let cols = [];
  try { cols = db.prepare(`PRAGMA table_info("${ref.table.replace(/"/g, '')}")`).all().map((c) => c.name); } catch { cols = []; }
  return ref.columns.filter((c) => cols.includes(c));
}

// Rows that only DESCRIBE the employee — their rates, branches, specialties.
// Meaningless once the person is gone, so they go in the same transaction.
const STAFF_CONFIG_REFS = [
  { table: 'doctor_rates',               columns: ['doctor_id'] },
  { table: 'doctor_consultation_prices', columns: ['doctor_id'] },
  { table: 'doctor_conditions',          columns: ['doctor_id'] },
  { table: 'user_branches',              columns: ['user_id'] },
  { table: 'user_specialties',           columns: ['user_id'] },
  { table: 'virtual_doctors',            columns: ['user_id'] },
];

// The one place that decides whether an employee may be removed. Both the
// check endpoint and the delete call it, so they can never disagree.
export function staffDeleteGuard(db, user, actor) {
  if (actor && user.id === actor.id) {
    return { ok: false, status: 409, reason: 'Нельзя удалить собственную учётную запись.' };
  }
  if (isStoredAdmin(user) && user.is_active && activeAdminCount(db) <= 1) {
    return { ok: false, status: 409, reason: 'В клинике должен остаться хотя бы один активный администратор.' };
  }

  const blocking = [];
  for (const ref of [...STAFF_HISTORY_REFS, ...staffHistoryFkRefs(db)]) {
    const columns = existingColumns(db, ref);   // V3120_FIX — колонки, которых в базе нет, не роняют проверку
    if (!columns.length) continue;
    const where = columns.map((c) => `"${c}" = ?`).join(' OR ');
    const { n } = db.prepare(`SELECT COUNT(*) AS n FROM "${ref.table}" WHERE ${where}`).get(...columns.map(() => user.id));
    if (n > 0) blocking.push({ table: ref.table, label: ref.label, count: n });
  }
  if (blocking.length) {
    const detail = blocking.map((b) => `${b.label}: ${b.count}`).join(', ');
    const who = user.full_name || user.username;
    return {
      ok: false,
      status: 409,
      blocking,
      reason: `За сотрудником «${who}» закреплены записи (${detail}) — удалить его нельзя, иначе история потеряет автора. ` +
              'Отключите учётную запись: сотрудник исчезнет из выбора и не сможет войти, а записи останутся целыми.',
    };
  }
  return { ok: true, blocking: [] };
}

function bad(res, message) {
  return res.status(400).json({ error: { code: 'bad_request', message } });
}

// validPassword moved to services/auth.js (imported above) — the self-service
// change-password path applies the identical byte-counting rule, and two
// copies of a password rule is how they drift apart.
