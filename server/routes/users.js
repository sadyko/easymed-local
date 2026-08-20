import { Router } from 'express';
import { requireRole } from '../middleware/auth.js';
import { hashPassword } from '../services/auth.js';
import { VALID_ROLES } from '../services/roles.js';
import { lockedResponse } from '../services/control/gate.js';   // LICENCE_CORE_V1

export { VALID_ROLES };

const TEXT_FIELDS = ['first_name', 'last_name', 'middle_name', 'phone', 'email', 'specialty', 'position', 'license_number'];
const DOCTOR_CATEGORIES = ['', 'highest', 'first', 'second', 'none'];
const EMPLOYMENT_TYPES = ['', 'official', 'civil_law', 'unofficial'];
const SALARY_TYPES = ['', 'fixed', 'percentage', 'fix_plus_kpi'];
const DATE_FIELDS = ['hire_date', 'license_expiry_date'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}/;
const STAFF_TYPES = ['', 'doctor', 'admin_staff', 'mid_low'];
const SCHEDULING_MODES = ['schedulable', 'live_queue'];

// Parses/validates the "employee record" fields shared by POST and PATCH.
// Returns only the keys present in `body` (so PATCH can do a partial update),
// or { ok:false, message } on the first validation failure.
// `currentRole` is the row's existing primary role; it's only consulted for
// extra_roles filtering when `body.role` is absent (PATCH that doesn't touch
// the primary role) — POST always carries `body.role`.
export function parseEmployeeFields(body, db, currentRole) {
  const fields = {};
  body = body || {};

  for (const key of TEXT_FIELDS) {
    if (body[key] === undefined) continue;
    fields[key] = String(body[key] ?? '').slice(0, 120).trim();
  }

  if (body.is_doctor !== undefined) {
    if (typeof body.is_doctor !== 'boolean') return { ok: false, message: 'is_doctor must be true or false.' };
    fields.is_doctor = body.is_doctor ? 1 : 0;
  }

  if (body.department_id !== undefined) {
    if (body.department_id === null || body.department_id === '') {
      fields.department_id = null;
    } else {
      const id = Number(body.department_id);
      if (!Number.isInteger(id) || id <= 0) return { ok: false, message: 'Invalid department.' };
      if (!db.prepare('SELECT 1 FROM departments WHERE id = ?').get(id)) return { ok: false, message: 'Unknown department.' };
      fields.department_id = id;
    }
  }

  if (body.doctor_category !== undefined) {
    if (!DOCTOR_CATEGORIES.includes(body.doctor_category)) return { ok: false, message: 'Unknown doctor category.' };
    fields.doctor_category = body.doctor_category;
  }
  if (body.employment_type !== undefined) {
    if (!EMPLOYMENT_TYPES.includes(body.employment_type)) return { ok: false, message: 'Unknown employment type.' };
    fields.employment_type = body.employment_type;
  }
  if (body.salary_type !== undefined) {
    if (!SALARY_TYPES.includes(body.salary_type)) return { ok: false, message: 'Unknown salary type.' };
    fields.salary_type = body.salary_type;
  }

  for (const key of DATE_FIELDS) {
    if (body[key] === undefined) continue;
    if (body[key] === '' || body[key] === null) { fields[key] = null; continue; }
    if (typeof body[key] !== 'string' || !DATE_RE.test(body[key])) return { ok: false, message: 'Invalid date.' };
    fields[key] = body[key];
  }

  if (body.salary_fixed !== undefined) {
    const n = Number(body.salary_fixed);
    if (!Number.isFinite(n) || n < 0 || n > 1e12) return { ok: false, message: 'Invalid salary_fixed.' };
    fields.salary_fixed = n;
  }
  if (body.salary_percent !== undefined) {
    const n = Number(body.salary_percent);
    if (!Number.isFinite(n) || n < 0 || n > 100) return { ok: false, message: 'Invalid salary_percent.' };
    fields.salary_percent = n;
  }

  if (body.staff_type !== undefined) {
    if (!STAFF_TYPES.includes(body.staff_type)) return { ok: false, message: 'Unknown staff category.' };
    fields.staff_type = body.staff_type;
  }
  if (body.scheduling_mode !== undefined) {
    if (!SCHEDULING_MODES.includes(body.scheduling_mode)) return { ok: false, message: 'Unknown scheduling mode.' };
    fields.scheduling_mode = body.scheduling_mode;
  }

  if (body.branch_id !== undefined) {
    if (body.branch_id === null || body.branch_id === '') {
      fields.branch_id = null;
    } else {
      const id = Number(body.branch_id);
      if (!Number.isInteger(id) || id <= 0) return { ok: false, message: 'Invalid branch.' };
      if (!db.prepare('SELECT 1 FROM branches WHERE id = ?').get(id)) return { ok: false, message: 'Unknown branch.' };
      fields.branch_id = id;
    }
  }

  if (body.working_hours !== undefined) {
    if (typeof body.working_hours !== 'string') return { ok: false, message: 'Invalid working_hours.' };
    fields.working_hours = body.working_hours.slice(0, 4000);
  }

  if (body.service_rate_default !== undefined) {
    const n = Number(body.service_rate_default);
    if (!Number.isFinite(n) || n < 0 || n > 100) return { ok: false, message: 'Invalid service_rate_default.' };
    fields.service_rate_default = n;
  }
  if (body.referral_rate_default !== undefined) {
    const n = Number(body.referral_rate_default);
    if (!Number.isFinite(n) || n < 0 || n > 100) return { ok: false, message: 'Invalid referral_rate_default.' };
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

  if (body.extra_roles !== undefined) {
    if (!Array.isArray(body.extra_roles)) return { ok: false, message: 'extra_roles must be an array.' };
    for (const role of body.extra_roles) {
      if (typeof role !== 'string' || !VALID_ROLES.includes(role)) return { ok: false, message: 'Unknown role in extra_roles.' };
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
  if (!Array.isArray(val)) return { ok: false, message: `${key} must be an array.` };
  if (val.length > MAX_RATE_ENTRIES) return { ok: false, message: `${key} has too many entries.` };

  const byId = new Map();
  for (const entry of val) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { ok: false, message: 'Invalid rate entry.' };
    }
    const serviceId = Number(entry.service_id);
    if (!Number.isInteger(serviceId) || serviceId <= 0) {
      return { ok: false, message: 'Invalid rate entry.' };
    }

    // 'pct' is canonical (reports read $.pct). The editor has always sent
    // 'percentage'; accepting it as an alias stops the rate being silently
    // zeroed on every save.
    const rawPct = entry.pct !== undefined ? entry.pct : entry.percentage;
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
        return { ok: false, message: `Invalid ${moneyKey} in ${key}: must be between 0 and ${MAX_RATE_MONEY}.` };
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
        return { ok: false, message: `Invalid fix in ${key}: must be between 0 and ${MAX_RATE_MONEY}.` };
      }
    }

    let branches = [];
    if (entry.branches !== undefined) {
      if (!Array.isArray(entry.branches)) return { ok: false, message: 'Invalid rate entry.' };
      branches = entry.branches.map(Number);
      if (!branches.every(b => Number.isInteger(b) && b > 0)) {
        return { ok: false, message: 'Invalid rate entry.' };
      }
    }

    const clean = { service_id: serviceId, pct, branches };
    if (money !== null) clean[moneyKey] = money;
    if (fix !== null) clean.fix = fix;
    byId.set(serviceId, clean);
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
export function employeeView(u) {
  return {
    id: u.id, username: u.username, full_name: u.full_name, role: u.role, is_active: !!u.is_active,
    extra_roles: parseJsonArray(u.extra_roles),
    first_name: u.first_name, last_name: u.last_name, middle_name: u.middle_name,
    phone: u.phone, email: u.email, specialty: u.specialty, is_doctor: !!u.is_doctor,
    department_id: u.department_id, position: u.position, doctor_category: u.doctor_category,
    hire_date: u.hire_date, license_number: u.license_number, license_expiry_date: u.license_expiry_date,
    employment_type: u.employment_type, salary_type: u.salary_type,
    salary_fixed: u.salary_fixed, salary_percent: u.salary_percent,
    staff_type: u.staff_type, scheduling_mode: u.scheduling_mode, branch_id: u.branch_id,
    working_hours: u.working_hours, service_rate_default: u.service_rate_default,
    referral_rate_default: u.referral_rate_default,
    service_rates: parseJsonArray(u.service_rates), referral_rates: parseJsonArray(u.referral_rates),
    created_at: u.created_at, updated_at: u.updated_at,
  };
}

// Derives "Last First Middle" from whichever name parts were supplied.
function deriveFullName(fields) {
  return [fields.last_name, fields.first_name, fields.middle_name]
    .map(s => (s || '').trim()).filter(Boolean).join(' ');
}

export function userRoutes(db) {
  const r = Router();
  // Staff roster is sensitive and these pages run on shared clinic PCs.
  r.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  r.use(requireRole('admin'));

  r.get('/', (req, res) => {
    const rows = db.prepare('SELECT * FROM users ORDER BY username').all();
    res.json({ users: rows.map(employeeView) });
  });

  r.post('/', (req, res) => {
    // LICENCE_CORE_V1 — a THIRD write path (see licence-gate.test.js): staff
    // accounts bypass /api/db's registry entirely (it lists 'users' but with
    // every write role set empty, on purpose) and land straight here.
    if (req.control?.locked) return lockedResponse(res, req.control);
    const { username, password, full_name = '', role } = req.body || {};
    const name = String(username || '').trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,30}$/.test(name)) return bad(res, 'Username must be 3-30 characters: letters, digits, . _ -');
    if (!validPassword(password)) return bad(res, 'Password must be 8 characters or more (max 72 bytes).');
    if (typeof full_name !== 'string') return bad(res, 'Full name must be text.');
    if (!VALID_ROLES.includes(role)) return bad(res, 'Unknown role.');
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(name)) return bad(res, 'Username already exists.');

    const parsed = parseEmployeeFields(req.body, db);
    if (!parsed.ok) return bad(res, parsed.message);
    const ef = parsed.fields;

    const hasNameParts = req.body && (req.body.last_name !== undefined || req.body.first_name !== undefined || req.body.middle_name !== undefined);
    const finalFullName = hasNameParts ? deriveFullName(ef) : full_name.slice(0, 100).trim();

    const columns = ['username', 'password_hash', 'full_name', 'role', ...Object.keys(ef)];
    const placeholders = columns.map(() => '?').join(',');
    const values = [name, hashPassword(password), finalFullName, role, ...Object.values(ef)];
    const info = db.prepare(`INSERT INTO users (${columns.join(',')}) VALUES (${placeholders})`).run(...values);
    res.status(201).json({ user: employeeView(db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid)) });
  });

  r.patch('/:id', (req, res) => {
    // LICENCE_CORE_V1 — same write gate as POST above.
    if (req.control?.locked) return lockedResponse(res, req.control);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!user) return res.status(404).json({ error: { code: 'not_found', message: 'User not found.' } });
    const { full_name, role, is_active, password } = req.body || {};

    // is_active must be a real boolean: `0`/`null`/`""` would slip past the
    // self-protection check below, and `"false"` would truthy-coerce to 1.
    let active; // undefined = leave unchanged
    if (is_active !== undefined) {
      if (typeof is_active !== 'boolean') return bad(res, 'is_active must be true or false.');
      active = is_active;
    }
    if (role !== undefined && !VALID_ROLES.includes(role)) return bad(res, 'Unknown role.');
    if (password !== undefined && !validPassword(password)) {
      return bad(res, 'Password must be 8 characters or more (max 72 bytes).');
    }
    if (full_name !== undefined && typeof full_name !== 'string') return bad(res, 'Full name must be text.');
    if (user.id === req.user.id && (active === false || (role !== undefined && role !== 'admin'))) {
      return bad(res, 'You cannot deactivate or demote your own account.');
    }
    // Belt-and-braces: the clinic must never end up with zero active admins.
    const losesAdmin = active === false || (role !== undefined && role !== 'admin');
    if (losesAdmin && user.role === 'admin' && user.is_active &&
        db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND is_active=1").get().n <= 1) {
      return bad(res, 'At least one active admin must remain.');
    }

    const parsed = parseEmployeeFields(req.body, db, user.role);
    if (!parsed.ok) return bad(res, parsed.message);
    const ef = parsed.fields;

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
      'is_active     = COALESCE(?, is_active)',
      'password_hash = COALESCE(?, password_hash)',
      ...efKeys.map(k => `${k} = ?`),
      "updated_at    = strftime('%Y-%m-%dT%H:%M:%SZ','now')",
    ];
    const values = [
      finalFullName !== undefined ? finalFullName : null,
      role ?? null,
      active === undefined ? null : (active ? 1 : 0),
      password !== undefined ? hashPassword(password) : null,
      ...efKeys.map(k => ef[k]),
    ];
    db.prepare(`UPDATE users SET ${setClauses.join(', ')} WHERE id = ?`).run(...values, user.id);
    // Deactivation OR password reset must end the target's sessions (a reset
    // is the standard response to a suspected compromise). The acting admin's
    // own session survives a self password change.
    if (active === false || password !== undefined) {
      db.prepare('DELETE FROM sessions WHERE user_id = ? AND id <> ?').run(user.id, req.sessionId ?? '');
    }
    res.json({ user: employeeView(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id)) });
  });

  // STAFF_DELETE_V1 — what removing this employee would do, without doing it.
  // Lets the UI offer «удалить» or «отключить» honestly rather than proposing a
  // delete that was never possible.
  r.get('/:id/delete-check', (req, res) => {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!user) return res.status(404).json({ error: { code: 'not_found', message: 'User not found.' } });
    const guard = staffDeleteGuard(db, user, req.user);
    res.json({
      name: user.full_name || user.username,
      deletable: guard.ok,
      reason: guard.reason || null,
      blocking: guard.blocking || [],
    });
  });

  r.delete('/:id', (req, res) => {
    // LICENCE_CORE_V1 — same write gate as POST above. GET /:id/delete-check
    // stays open: it's a read-only dry run, never a write.
    if (req.control?.locked) return lockedResponse(res, req.control);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!user) return res.status(404).json({ error: { code: 'not_found', message: 'User not found.' } });

    const guard = staffDeleteGuard(db, user, req.user);
    if (!guard.ok) {
      // 409: the request is well-formed, the clinic's state forbids it.
      return res.status(guard.status || 409).json({ error: { code: 'conflict', message: guard.reason } });
    }

    const name = user.full_name || user.username;
    db.transaction(() => {
      for (const ref of STAFF_CONFIG_REFS) {
        for (const col of ref.columns) db.prepare(`DELETE FROM "${ref.table}" WHERE "${col}" = ?`).run(user.id);
      }
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
      db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
    })();

    res.json({ deleted: true, id: user.id, name });
  });

  return r;
}

// STAFF_DELETE_V1 — tables recording WHAT AN EMPLOYEE DID. A reference from any
// of these means the roster row is the only thing that still names the person on
// a visit, a bill, a shift or an audit line, so it has to survive. Labels are
// user-facing (Russian, like the rest of the admin UI).
const STAFF_HISTORY_REFS = [
  { table: 'visits',                  columns: ['doctor_id', 'created_by'],   label: 'визиты' },
  { table: 'visit_services',          columns: ['doctor_id', 'created_by', 'verified_by'], label: 'оказанные услуги' },
  { table: 'invoices',                columns: ['created_by'],                label: 'счета' },
  { table: 'payments',                columns: ['cashier_id'],                label: 'платежи' },
  { table: 'cash_shifts',             columns: ['cashier_id'],                label: 'кассовые смены' },
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
];

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
  if (user.role === 'admin' && user.is_active &&
      db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND is_active=1").get().n <= 1) {
    return { ok: false, status: 409, reason: 'В клинике должен остаться хотя бы один активный администратор.' };
  }

  const blocking = [];
  for (const ref of STAFF_HISTORY_REFS) {
    const where = ref.columns.map((c) => `"${c}" = ?`).join(' OR ');
    const { n } = db.prepare(`SELECT COUNT(*) AS n FROM "${ref.table}" WHERE ${where}`).get(...ref.columns.map(() => user.id));
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

// bcrypt only hashes the first 72 BYTES — a 72-char Cyrillic password is 126
// bytes, so counting characters would silently ignore the tail. Count bytes.
function validPassword(pw) {
  return typeof pw === 'string' && pw.length >= 8 && Buffer.byteLength(pw, 'utf8') <= 72;
}
