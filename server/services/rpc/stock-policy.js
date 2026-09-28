// OWN_SHELF_ONLY_V1 (ревью F5, 2026-09-28) — ПЕРЕКЛЮЧАТЕЛЬ КЛИНИКИ «ТОЛЬКО СО
// СВОИХ ПОЛОК» И ЕГО ГОТОВНОСТЬ.
//
// Владелец: «Clinics keep working as today. The admin turns it on in settings
// once the warehouse has issued stock to rooms and nurses. The settings screen
// shows what is still missing.»
//
//   own_shelf_settings — положение переключателя, кто и когда его менял и
//                        ГОТОВНОСТЬ: чего не хватает цепочке «свои полки»
//                        (inventory.js holdingChain) — сотрудники без кабинета
//                        и отдела, палаты без отдела, кабинеты без отдела,
//                        отделы без запаса и кто из врачей и медсестёр пуст на
//                        всех своих полках. Считает сервер, словами и числами.
//   own_shelf_set      — включить или выключить. ТОЛЬКО АДМИНИСТРАТОР — проверка
//                        здесь, а не спрятанная кнопка. Включить можно и при
//                        недостающем (экран перечисляет его в подтверждении);
//                        журнал запоминает, что готовность в эту минуту
//                        называла недостающим.
import { hasAnyRole } from '../roles.js';
import { isAdminUser } from '../grants.js';
import { canSeeAllMovements } from './stock-log.js';
import { ownShelfOnly } from './inventory.js';

export class RpcError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

const NOW = "strftime('%Y-%m-%dT%H:%M:%SZ','now')";
// Кто выдаёт пациенту со своих полок (двери выдачи: doctor, nurse; старшая и
// главный врач — основой). Администратор и склад берут со склада и в
// готовность не входят.
const CLINICAL_ROLES = ['doctor', 'nurse', 'senior_nurse', 'head_doctor'];
const WAREHOUSE_ROLES = ['admin', 'inventory'];

function parseRoles(v) {
  if (Array.isArray(v)) return v;
  try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a : []; } catch { return []; }
}
const displayName = (u) => (u.full_name || '').trim() || u.username || ('#' + u.id);

/** Готовность цепочки «свои полки» — что ещё не заведено. Только чтение. */
export function ownShelfReadiness(db) {
  const staff = db.prepare(`SELECT id, username, full_name, role, extra_roles, room_id, department_id
                              FROM users WHERE is_active = 1 ORDER BY full_name, id`).all()
    .filter((u) => {
      const who = { role: u.role, extra_roles: parseRoles(u.extra_roles) };
      return hasAnyRole(who, CLINICAL_ROLES) && !hasAnyRole(who, WAREHOUSE_ROLES);
    });
  const held = db.prepare('SELECT 1 FROM stock_holdings WHERE holder_type = ? AND holder_id = ? AND qty > 0 LIMIT 1');
  const has = (type, id) => id != null && !!held.get(type, id);

  const staffWithoutPlace = staff.filter((u) => u.room_id == null && u.department_id == null).map(displayName);
  const empty = staff.filter((u) => !has('staff', u.id) && !has('room', u.room_id) && !has('department', u.department_id)).map(displayName);
  const wardsWithoutDept = db.prepare('SELECT name FROM wards WHERE active = 1 AND department_id IS NULL ORDER BY name').all().map((r) => r.name);
  const roomsWithoutDept = db.prepare('SELECT name FROM rooms WHERE active = 1 AND department_id IS NULL ORDER BY name').all().map((r) => r.name);
  // Отдел без запаса — только тот, что стоит в чьей-то цепочке: отдел врача
  // или медсестры, отдел палаты, отдел кабинета. Отделы из справочника, к
  // которым никто и ничто не привязано, выдачу не задевают — это не «недостающее».
  const used = new Set(staff.map((u) => u.department_id).filter((id) => id != null));
  for (const r of db.prepare('SELECT department_id FROM wards WHERE active = 1 AND department_id IS NOT NULL UNION SELECT department_id FROM rooms WHERE active = 1 AND department_id IS NOT NULL').all()) used.add(r.department_id);
  const deptsEmpty = db.prepare(`SELECT d.id, d.name FROM departments d
                                  WHERE d.active = 1
                                    AND NOT EXISTS (SELECT 1 FROM stock_holdings h WHERE h.holder_type = 'department' AND h.holder_id = d.id AND h.qty > 0)
                                  ORDER BY d.name`).all().filter((r) => used.has(r.id)).map((r) => r.name);
  const items = [
    { key: 'staff_without_place', names: staffWithoutPlace },
    { key: 'wards_without_department', names: wardsWithoutDept },
    { key: 'rooms_without_department', names: roomsWithoutDept },
    { key: 'departments_empty', names: deptsEmpty },
    { key: 'staff_with_nothing', names: empty },
  ];
  return {
    clinical_staff: staff.length,
    staff_with_stock: staff.length - empty.length,
    items: items.map((i) => ({ ...i, count: i.names.length })),
    missing: items.reduce((s, i) => s + i.names.length, 0),
  };
}

function canSeeSettings(db, user) {
  if (!user) return false;
  if (isAdminUser(user) || hasAnyRole(user, WAREHOUSE_ROLES)) return true;
  try { return canSeeAllMovements(db, user); } catch { return false; }
}

/** own_shelf_settings — положение, журнал и готовность. */
export function ownShelfSettings(db, _args, user) {
  if (!canSeeSettings(db, user)) throw new RpcError('Настройки склада недоступны вашей роли.', 403);
  const row = db.prepare(`SELECT s.own_shelf_only, s.changed_at, u.full_name AS changed_by_name
                            FROM stock_settings s LEFT JOIN users u ON u.id = s.changed_by WHERE s.id = 1`).get() || {};
  const log = db.prepare(`SELECT l.own_shelf_only, l.changed_at, l.missing, u.full_name AS changed_by_name
                            FROM stock_settings_log l LEFT JOIN users u ON u.id = l.changed_by
                           ORDER BY l.id DESC LIMIT 10`).all().map((r) => {
    let missing = 0;
    try { missing = (JSON.parse(r.missing || '[]') || []).reduce((s, i) => s + (Number(i.count) || 0), 0); } catch { missing = 0; }
    return { own_shelf_only: Number(r.own_shelf_only) === 1, changed_at: r.changed_at, changed_by_name: r.changed_by_name || null, missing };
  });
  return {
    own_shelf_only: Number(row.own_shelf_only) === 1,
    changed_at: row.changed_at || null,
    changed_by_name: row.changed_by_name || null,
    can_change: isAdminUser(user),
    readiness: ownShelfReadiness(db),
    log,
  };
}

/** own_shelf_set — включить или выключить (только администратор). */
export function ownShelfSet(db, args, user) {
  if (!isAdminUser(user)) {
    throw new RpcError('Переключатель «Только со своих полок» меняет только администратор.', 403);
  }
  const a = args || {};
  if (typeof a.own_shelf_only !== 'boolean') throw new RpcError('Укажите: включить или выключить.', 400);
  const next = a.own_shelf_only ? 1 : 0;
  const run = db.transaction(() => {
    const before = ownShelfOnly(db);
    if (before === !!next) return { own_shelf_only: before, changed: false };
    const readiness = ownShelfReadiness(db);
    db.prepare(`UPDATE stock_settings SET own_shelf_only = ?, changed_by = ?, changed_at = ${NOW} WHERE id = 1`).run(next, user.id);
    db.prepare('INSERT INTO stock_settings_log (own_shelf_only, changed_by, missing) VALUES (?, ?, ?)')
      .run(next, user.id, JSON.stringify(readiness.items.filter((i) => i.count > 0).map((i) => ({ key: i.key, count: i.count, names: i.names.slice(0, 50) }))));
    return { own_shelf_only: !!next, changed: true, missing: readiness.missing };
  });
  return run();
}
