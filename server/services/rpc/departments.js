// DEPARTMENTS_V1 (2026-09-18) — ОТДЕЛ КАК ЕДИНИЦА КЛИНИКИ: РУКОВОДИТЕЛЬ,
// КОМАНДА, ПОМЕЩЕНИЯ, СНАБЖЕНИЕ, ЖУРНАЛ.
//
// Владелец: «Create department → Assign head → Link rooms → Form department →
// Dispense supplies → Track department resources». И на вопросы: руководитель —
// врач или медсестра; вид отдела — просто имя для группировки, выдачи и
// статистики; палаты тоже; выдача обеими дверями; возвратов нет; медсестра
// видит своё.
//
// ЧТО ЗДЕСЬ СОБРАНО ИЗ УЖЕ СУЩЕСТВУЮЩЕГО. Отдел — строка departments; команда —
// users.department_id (сотрудник состоит в одном отделе); помещения —
// rooms.department_id и wards.department_id (миграция 108: одно помещение —
// один отдел); остатки — stock_holdings с holder_type='department' (миграция
// 128); выдачи и расход — stock_movements с держателем. Ничего из этого не
// дублируется: экран отдела показывает те же строки, что склад и лист
// медсестры, только собранные вокруг отдела.
//
// ОДНА ТРАНЗАКЦИЯ НА «СФОРМИРОВАТЬ». department_form создаёт или правит отдел,
// ставит руководителя, переводит команду и помещения и пишет журнал — либо всё,
// либо ничего: экран не скажет «сформирован», пока база не подтвердила.
//
// ПЕРЕВОД — ТОЛЬКО ОСОЗНАННЫЙ. Сотрудник из другого отдела или кабинет другого
// отдела переходят сюда только если экран прислал подтверждение (reassign):
// сервер отказывает словами, называя, где он сейчас, и экран показывает вопрос
// «Переназначить?». Молча ничего не переезжает.
import { hasAnyRole, effectiveRoles, canViewSection, canEditSection } from '../roles.js';
import { grantLevel, grantAllows } from '../grants.js';
import { levelAllows } from '../../../public/js/shared/permission-catalog.js';

export class RpcError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

export const KINDS = ['clinical', 'laboratory', 'diagnostics', 'procedure', 'inpatient', 'administrative'];
// Руководитель — врач или медсестра (ответ владельца). Врач узнаётся по
// is_doctor (ADMIN_DOCTOR_V1: администратор тоже может быть врачом) или по
// роли; медсестра — по роли, основной или дополнительной.
const HEAD_ROLES = ['doctor', 'head_doctor', 'nurse', 'senior_nurse'];
const SEE_ALL_ROLES = ['admin', 'inventory'];
// Кто выдаёт со склада (ворота issue_stock_lines) и кто подаёт заявку — те же
// списки, что в rpc/procurement.js; карточка спрашивает сервер, а не гадает.
const ISSUE_ROLES = ['admin', 'inventory'];
const REQUEST_ROLES = ['admin', 'inventory', 'doctor', 'head_doctor', 'nurse', 'senior_nurse'];
const PLACE_TYPES = ['room', 'ward'];
const NOW = "strftime('%Y-%m-%dT%H:%M:%SZ','now')";

const isPosInt = (v) => Number.isInteger(v) && v > 0;
const round2 = (n) => Math.round(Number(n) * 100) / 100;

// --- Права ------------------------------------------------------------------

/** Видит ли все отделы: настроенный уровень окна «Отделы», иначе — как было (админ, снабжение, доступ к настройкам). */
export function canSeeAll(db, user) {
  const lvl = grantLevel(db, user, 'settings.departments');
  if (lvl !== null) return levelAllows(lvl, 'view');
  return hasAnyRole(user, SEE_ALL_ROLES) || canViewSection(db, user, 'settings');
}

function canForm(db, user) {
  const lvl = grantLevel(db, user, 'settings.departments');
  if (lvl !== null) return levelAllows(lvl, 'edit');
  return hasAnyRole(user, ['admin']) || canEditSection(db, user, 'settings');
}

function requireForm(db, user, what) {
  if (canForm(db, user)) return;
  throw new RpcError(`${what} — недоступно вашей роли. Права выдаёт администратор в «Настройки → Роли».`, 403);
}

/** Своё: состоит в отделе или руководит им. */
function isOwn(db, user, departmentId) {
  if (!user || !isPosInt(Number(user.id))) return false;
  const row = db.prepare('SELECT department_id FROM users WHERE id = ?').get(user.id);
  if (row && Number(row.department_id) === departmentId) return true;
  const head = db.prepare('SELECT 1 FROM departments WHERE id = ? AND head_user_id = ?').get(departmentId, user.id);
  return !!head;
}

function requireCardAccess(db, user, departmentId) {
  if (canSeeAll(db, user) || isOwn(db, user, departmentId)) return;
  throw new RpcError('Карточка отдела — недоступно вашей роли: видны только свой отдел и то, что выдано вам.', 403);
}

// --- Мелкие помощники --------------------------------------------------------

function loadDepartment(db, id) {
  if (!isPosInt(id)) throw new RpcError('Отдел не выбран.', 400);
  const row = db.prepare('SELECT * FROM departments WHERE id = ?').get(id);
  if (!row) throw new RpcError('Отдел не найден.', 404);
  return row;
}

function userBrief(db, id) {
  if (!isPosInt(id)) return null;
  const u = db.prepare('SELECT id, full_name, role, extra_roles, position, is_doctor, specialty, department_id, is_active AS active FROM users WHERE id = ?').get(id);
  if (!u) return null;
  let extra = [];
  try { extra = Array.isArray(u.extra_roles) ? u.extra_roles : JSON.parse(u.extra_roles || '[]'); } catch { extra = []; }
  return {
    id: u.id, full_name: u.full_name || '', role: u.role || '', extra_roles: extra,
    position: u.position || '', is_doctor: !!u.is_doctor, specialty: u.specialty || '',
    department_id: u.department_id || null, active: u.active !== 0 && u.active !== false,
  };
}

/** Может ли этот сотрудник руководить: врач или медсестра. */
export function eligibleHead(u) {
  if (!u) return false;
  if (u.is_doctor) return true;
  const roles = [u.role, ...(u.extra_roles || [])];
  return roles.some((r) => HEAD_ROLES.includes(r));
}

function deptName(db, id) {
  if (!id) return '';
  const r = db.prepare('SELECT name FROM departments WHERE id = ?').get(id);
  return r ? r.name : '';
}

function logEvent(db, departmentId, kind, actorId, details) {
  db.prepare('INSERT INTO department_events (department_id, kind, actor_id, details) VALUES (?, ?, ?, ?)')
    .run(departmentId, kind, actorId || null, details ? JSON.stringify(details) : null);
}
export { logEvent as logDepartmentEvent };

function stripRecipient(note, name) {
  const n = String(note || '').trim();
  if (!n || !name) return n;
  if (n === name) return '';
  const prefix = name + ' — ';
  return n.startsWith(prefix) ? n.slice(prefix.length) : n;
}

function placeTable(type) {
  if (!PLACE_TYPES.includes(type)) throw new RpcError('Помещение: укажите кабинет или палату.', 400);
  return type === 'room' ? 'rooms' : 'wards';
}

function loadPlace(db, type, id) {
  const table = placeTable(type);
  if (!isPosInt(id)) throw new RpcError('Помещение не выбрано.', 400);
  const row = db.prepare(`SELECT id, name, code, floor_id, department_id, active FROM ${table} WHERE id = ?`).get(id);
  if (!row) throw new RpcError('Помещение не найдено.', 404);
  return { ...row, type };
}

// --- Команда и помещения: одно правило перевода на всех -----------------------

/**
 * Поставить сотрудника в отдел. Из другого отдела — только с подтверждением:
 * иначе отказ словами, где он сейчас.
 */
function putMember(db, dept, u, { reassign, actorId, log = true }) {
  if (!u) throw new RpcError('Сотрудник не найден.', 404);
  if (u.department_id === dept.id) return false;
  if (u.department_id && !reassign) {
    throw new RpcError(`${u.full_name} сейчас в отделе «${deptName(db, u.department_id)}» — подтвердите перевод.`, 409);
  }
  const from = u.department_id ? deptName(db, u.department_id) : '';
  db.prepare(`UPDATE users SET department_id = ?, updated_at = ${NOW} WHERE id = ?`).run(dept.id, u.id);
  if (log) logEvent(db, dept.id, 'member_added', actorId, { user_id: u.id, name: u.full_name, from_department: from || null });
  return true;
}

function dropMember(db, dept, u, { actorId }) {
  db.prepare(`UPDATE users SET department_id = NULL, updated_at = ${NOW} WHERE id = ? AND department_id = ?`).run(u.id, dept.id);
  logEvent(db, dept.id, 'member_removed', actorId, { user_id: u.id, name: u.full_name });
}

function putPlace(db, dept, place, { reassign, actorId }) {
  if (place.department_id === dept.id) return false;
  if (place.department_id && !reassign) {
    throw new RpcError(`${place.type === 'ward' ? 'Палата' : 'Кабинет'} «${place.name}» сейчас в отделе «${deptName(db, place.department_id)}» — подтвердите переназначение.`, 409);
  }
  const from = place.department_id ? deptName(db, place.department_id) : '';
  db.prepare(`UPDATE ${placeTable(place.type)} SET department_id = ? WHERE id = ?`).run(dept.id, place.id);
  logEvent(db, dept.id, 'room_assigned', actorId, { type: place.type, id: place.id, name: place.name, from_department: from || null });
  return true;
}

function dropPlace(db, dept, place, { actorId }) {
  db.prepare(`UPDATE ${placeTable(place.type)} SET department_id = NULL WHERE id = ? AND department_id = ?`).run(place.id, dept.id);
  logEvent(db, dept.id, 'room_removed', actorId, { type: place.type, id: place.id, name: place.name });
}

/** Ключ помещения в списках: 'room:12' / 'ward:3'. */
const placeKey = (p) => `${p.type}:${p.id}`;

function normalizePlaces(list, what) {
  if (list == null) return [];
  if (!Array.isArray(list)) throw new RpcError(`${what}: ожидается список.`, 400);
  return list.map((p) => {
    const type = p && typeof p.type === 'string' ? p.type : '';
    const id = p ? Number(p.id) : NaN;
    if (!PLACE_TYPES.includes(type) || !isPosInt(id)) throw new RpcError(`${what}: у помещения нужны вид и номер.`, 400);
    return { type, id };
  });
}

function normalizeIds(list, what) {
  if (list == null) return [];
  if (!Array.isArray(list)) throw new RpcError(`${what}: ожидается список.`, 400);
  return list.map((v) => {
    const n = Number(v);
    if (!isPosInt(n)) throw new RpcError(`${what}: неверный номер.`, 400);
    return n;
  });
}

// --- department_form ---------------------------------------------------------

/**
 * Сформировать (создать) или изменить отдел одной транзакцией.
 * args: { id?, name, code?, kind, active?, head_user_id?,
 *         member_ids?: [..], reassign_member_ids?: [..],
 *         places?: [{type:'room'|'ward', id}], reassign_places?: [{type,id}] }
 * Список команды и помещений — ПОЛНЫЙ: кого нет в списке, тот выходит из
 * отдела (при правке). Руководитель всегда в команде.
 */
export function departmentForm(db, args, user) {
  requireForm(db, user, 'Формировать отделы');
  const a = args || {};
  const id = a.id == null ? null : Number(a.id);
  const name = typeof a.name === 'string' ? a.name.trim() : '';
  if (!name) throw new RpcError('Назовите отдел.', 400);
  if (name.length > 120) throw new RpcError('Название отдела слишком длинное.', 400);
  const code = typeof a.code === 'string' ? a.code.trim().slice(0, 30) : '';
  const kind = typeof a.kind === 'string' && KINDS.includes(a.kind) ? a.kind : (id ? null : 'clinical');
  const active = a.active === undefined ? true : !!a.active;
  const headId = a.head_user_id == null || a.head_user_id === '' ? null : Number(a.head_user_id);
  if (headId !== null && !isPosInt(headId)) throw new RpcError('Руководитель: неверный сотрудник.', 400);
  const memberIds = normalizeIds(a.member_ids, 'Команда');
  const reassignMembers = new Set(normalizeIds(a.reassign_member_ids, 'Перевод сотрудников'));
  const places = normalizePlaces(a.places, 'Помещения');
  const reassignPlaces = new Set(normalizePlaces(a.reassign_places, 'Переназначение помещений').map(placeKey));

  const run = db.transaction(() => {
    // Имя единственное среди живых отделов: два «Кардиология» в списке выдачи —
    // это ошибка выдачи через неделю.
    // lower() в SQLite знает только латиницу — «Кардиология» и «кардиология»
    // для него разные; сравниваем в JS.
    const dup = db.prepare('SELECT id, name FROM departments WHERE id <> ?').all(id || 0)
      .find((d) => String(d.name || '').trim().toLowerCase() === name.toLowerCase());
    if (dup) throw new RpcError(`Отдел «${name}» уже есть.`, 409);

    let dept;
    let created = false;
    if (id) {
      dept = loadDepartment(db, id);
      const changes = {};
      if (dept.name !== name) changes.name = [dept.name, name];
      if ((dept.code || '') !== code) changes.code = [dept.code || '', code];
      if (kind && dept.kind !== kind) changes.kind = [dept.kind, kind];
      if ((dept.active !== 0) !== active) changes.active = [dept.active !== 0, active];
      db.prepare('UPDATE departments SET name = ?, code = ?, kind = ?, active = ? WHERE id = ?')
        .run(name, code || null, kind || dept.kind, active ? 1 : 0, id);
      if (Object.keys(changes).length) logEvent(db, id, 'updated', user.id, changes);
      dept = { ...dept, name, code, kind: kind || dept.kind, active: active ? 1 : 0 };
    } else {
      const r = db.prepare('INSERT INTO departments (name, code, kind, active) VALUES (?, ?, ?, ?)').run(name, code || null, kind, active ? 1 : 0);
      dept = { id: Number(r.lastInsertRowid), name, code, kind, active: active ? 1 : 0, head_user_id: null };
      created = true;
      logEvent(db, dept.id, 'created', user.id, { name, kind });
    }

    // Руководитель — врач или медсестра, и всегда в команде.
    let head = null;
    if (headId !== null) {
      head = userBrief(db, headId);
      if (!head) throw new RpcError('Руководитель: сотрудник не найден.', 404);
      if (!head.active) throw new RpcError(`${head.full_name} отключён — руководителем может быть только работающий сотрудник.`, 400);
      if (!eligibleHead(head)) throw new RpcError(`${head.full_name} — не врач и не медсестра; руководителем отдела может быть только врач или медсестра.`, 400);
    }
    if ((dept.head_user_id || null) !== headId) {
      const prev = dept.head_user_id ? userBrief(db, dept.head_user_id) : null;
      db.prepare('UPDATE departments SET head_user_id = ? WHERE id = ?').run(headId, dept.id);
      logEvent(db, dept.id, 'head_changed', user.id, { from: prev ? { id: prev.id, name: prev.full_name } : null, to: head ? { id: head.id, name: head.full_name } : null });
    }

    // Команда: полный список; руководитель добавляется сам.
    const wanted = new Set(memberIds);
    if (headId !== null) wanted.add(headId);
    for (const uid of wanted) {
      const u = userBrief(db, uid);
      if (!u) throw new RpcError('Сотрудник команды не найден.', 404);
      putMember(db, dept, u, { reassign: reassignMembers.has(uid), actorId: user.id });
    }
    if (a.member_ids !== undefined || created) {
      const current = db.prepare('SELECT id, full_name FROM users WHERE department_id = ?').all(dept.id);
      for (const u of current) if (!wanted.has(u.id)) dropMember(db, dept, u, { actorId: user.id });
    }

    // Помещения: полный список; чужие — только с подтверждением.
    const wantedPlaces = new Map(places.map((p) => [placeKey(p), p]));
    for (const p of wantedPlaces.values()) {
      const place = loadPlace(db, p.type, p.id);
      putPlace(db, dept, place, { reassign: reassignPlaces.has(placeKey(p)), actorId: user.id });
    }
    if (a.places !== undefined || created) {
      for (const type of PLACE_TYPES) {
        const rows = db.prepare(`SELECT id, name FROM ${placeTable(type)} WHERE department_id = ?`).all(dept.id);
        for (const r of rows) if (!wantedPlaces.has(placeKey({ type, id: r.id }))) dropPlace(db, dept, { ...r, type }, { actorId: user.id });
      }
    }
    return { department_id: dept.id, created };
  });
  const res = run();
  return { ...res, card: departmentCard(db, { department_id: res.department_id }, user) };
}

// --- Мелкие правки из карточки ---------------------------------------------

export function departmentHeadSet(db, args, user) {
  requireForm(db, user, 'Менять руководителя отдела');
  const a = args || {};
  const dept = loadDepartment(db, Number(a.department_id));
  const headId = a.user_id == null || a.user_id === '' ? null : Number(a.user_id);
  const run = db.transaction(() => {
    let head = null;
    if (headId !== null) {
      head = userBrief(db, headId);
      if (!head) throw new RpcError('Сотрудник не найден.', 404);
      if (!head.active) throw new RpcError(`${head.full_name} отключён — руководителем может быть только работающий сотрудник.`, 400);
      if (!eligibleHead(head)) throw new RpcError(`${head.full_name} — не врач и не медсестра; руководителем отдела может быть только врач или медсестра.`, 400);
      putMember(db, dept, head, { reassign: !!a.reassign, actorId: user.id });
    }
    if ((dept.head_user_id || null) === headId) return;
    const prev = dept.head_user_id ? userBrief(db, dept.head_user_id) : null;
    db.prepare('UPDATE departments SET head_user_id = ? WHERE id = ?').run(headId, dept.id);
    logEvent(db, dept.id, 'head_changed', user.id, { from: prev ? { id: prev.id, name: prev.full_name } : null, to: head ? { id: head.id, name: head.full_name } : null });
  });
  run();
  return departmentCard(db, { department_id: dept.id }, user);
}

export function departmentMemberSet(db, args, user) {
  requireForm(db, user, 'Менять команду отдела');
  const a = args || {};
  const dept = loadDepartment(db, Number(a.department_id));
  const u = userBrief(db, Number(a.user_id));
  if (!u) throw new RpcError('Сотрудник не найден.', 404);
  const run = db.transaction(() => {
    if (a.on) {
      putMember(db, dept, u, { reassign: !!a.reassign, actorId: user.id });
    } else {
      if (dept.head_user_id === u.id) throw new RpcError(`${u.full_name} руководит отделом — сначала смените руководителя.`, 400);
      if (u.department_id === dept.id) dropMember(db, dept, u, { actorId: user.id });
    }
  });
  run();
  return departmentCard(db, { department_id: dept.id }, user);
}

export function departmentPlaceSet(db, args, user) {
  requireForm(db, user, 'Менять помещения отдела');
  const a = args || {};
  const dept = loadDepartment(db, Number(a.department_id));
  const place = loadPlace(db, typeof a.type === 'string' ? a.type : '', Number(a.id));
  const run = db.transaction(() => {
    if (a.on) putPlace(db, dept, place, { reassign: !!a.reassign, actorId: user.id });
    else if (place.department_id === dept.id) dropPlace(db, dept, place, { actorId: user.id });
  });
  run();
  return departmentCard(db, { department_id: dept.id }, user);
}

// --- Чтение ------------------------------------------------------------------

/** Кандидаты в руководители и в команду: работающие сотрудники с отделом и должностью. */
export function departmentStaffOptions(db, args, user) {
  if (!canSeeAll(db, user)) throw new RpcError('Список сотрудников — недоступно вашей роли.', 403);
  const rows = db.prepare(`
    SELECT u.id, u.full_name, u.role, u.extra_roles, u.position, u.is_doctor, u.specialty, u.department_id,
           d.name AS department_name
      FROM users u LEFT JOIN departments d ON d.id = u.department_id
     WHERE u.is_active = 1
     ORDER BY u.full_name`).all();
  return {
    staff: rows.map((r) => {
      const b = userBrief(db, r.id);
      return { ...b, department_name: r.department_name || '', eligible_head: eligibleHead(b) };
    }),
  };
}

/** Все помещения по этажам с текущим отделом — для шага «Помещения». */
export function departmentPlaceOptions(db, args, user) {
  if (!canSeeAll(db, user)) throw new RpcError('Список помещений — недоступно вашей роли.', 403);
  const floors = db.prepare('SELECT id, name, level FROM floors WHERE active = 1 ORDER BY level, name').all();
  const rooms = db.prepare(`
    SELECT r.id, r.name, r.code, r.room_type AS subtype, r.floor_id, r.department_id, d.name AS department_name
      FROM rooms r LEFT JOIN departments d ON d.id = r.department_id
     WHERE r.active = 1 ORDER BY r.name`).all().map((r) => ({ ...r, type: 'room' }));
  const wards = db.prepare(`
    SELECT w.id, w.name, w.code, w.type AS subtype, w.floor_id, w.department_id, d.name AS department_name,
           (SELECT COUNT(*) FROM beds b WHERE b.ward_id = w.id AND b.active = 1) AS beds
      FROM wards w LEFT JOIN departments d ON d.id = w.department_id
     WHERE w.active = 1 ORDER BY w.name`).all().map((r) => ({ ...r, type: 'ward' }));
  return { floors, places: [...rooms, ...wards] };
}

export function departmentList(db, args, user) {
  const all = canSeeAll(db, user);
  const a = args || {};
  const where = [];
  const params = [];
  if (!a.include_inactive) where.push('d.active = 1');
  if (!all) {
    // Только своё: где состоит или чем руководит.
    const me = db.prepare('SELECT department_id FROM users WHERE id = ?').get(user.id);
    where.push('(d.id = ? OR d.head_user_id = ?)');
    params.push(me && me.department_id ? me.department_id : 0, user.id);
  }
  const rows = db.prepare(`
    SELECT d.id, d.name, d.code, d.kind, d.active, d.head_user_id, d.created_at,
           (SELECT COUNT(*) FROM users u WHERE u.department_id = d.id AND u.is_active = 1) AS members,
           (SELECT COUNT(*) FROM rooms r WHERE r.department_id = d.id AND r.active = 1) AS rooms,
           (SELECT COUNT(*) FROM wards w WHERE w.department_id = d.id AND w.active = 1) AS wards,
           (SELECT COUNT(*) FROM stock_holdings h WHERE h.holder_type = 'department' AND h.holder_id = d.id AND h.qty > 0) AS held_products
      FROM departments d
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY d.active DESC, d.name`).all(...params);
  return {
    can_form: canForm(db, user),
    sees_all: all,
    departments: rows.map((r) => ({
      id: r.id, name: r.name, code: r.code || '', kind: r.kind, active: r.active !== 0, created_at: r.created_at,
      head: r.head_user_id ? userBrief(db, r.head_user_id) : null,
      members: r.members, rooms: r.rooms, wards: r.wards, held_products: r.held_products,
    })),
  };
}

/** Одна карточка: обзор, команда, помещения, снабжение, журнал. */
export function departmentCard(db, args, user) {
  const a = args || {};
  const id = Number(a.department_id);
  const dept = loadDepartment(db, id);
  requireCardAccess(db, user, id);

  const members = db.prepare('SELECT id FROM users WHERE department_id = ? AND is_active = 1 ORDER BY full_name').all(id).map((r) => userBrief(db, r.id));
  const floors = db.prepare('SELECT id, name, level FROM floors ORDER BY level, name').all();
  const rooms = db.prepare('SELECT id, name, code, room_type AS subtype, floor_id FROM rooms WHERE department_id = ? AND active = 1 ORDER BY name').all(id).map((r) => ({ ...r, type: 'room' }));
  const wards = db.prepare(`SELECT w.id, w.name, w.code, w.type AS subtype, w.floor_id,
      (SELECT COUNT(*) FROM beds b WHERE b.ward_id = w.id AND b.active = 1) AS beds
      FROM wards w WHERE w.department_id = ? AND w.active = 1 ORDER BY w.name`).all(id).map((r) => ({ ...r, type: 'ward' }));

  const holdings = db.prepare(`
    SELECT h.product_id, h.qty, p.name AS product_name, p.base_unit, p.consumption_unit, p.consumption_factor
      FROM stock_holdings h JOIN products p ON p.id = h.product_id
     WHERE h.holder_type = 'department' AND h.holder_id = ? AND h.qty > 0
     ORDER BY p.name`).all(id).map((r) => {
    const cf = r.consumption_unit && Number(r.consumption_factor) > 0 ? Number(r.consumption_factor) : 1;
    return { product_id: r.product_id, product_name: r.product_name, unit: r.consumption_unit || r.base_unit || '', qty_units: round2(r.qty * cf), qty_base: round2(r.qty), base_unit: r.base_unit || '' };
  });

  // Выдачи со склада в отдел: движение склада «минус» = отделу «плюс».
  const issues = db.prepare(`
    SELECT m.id, m.product_id, m.qty, m.note, m.created_at, m.reference_type, m.reference_id,
           p.name AS product_name, p.base_unit, p.consumption_unit, p.consumption_factor,
           u.full_name AS issued_by
      FROM stock_movements m
      JOIN products p ON p.id = m.product_id
      LEFT JOIN users u ON u.id = m.created_by
     WHERE m.holder_type = 'department' AND m.holder_id = ? AND m.reference_type IN ('issue', 'requisition')
     ORDER BY m.created_at DESC, m.id DESC LIMIT 500`).all(id).map((r) => {
    const cf = r.consumption_unit && Number(r.consumption_factor) > 0 ? Number(r.consumption_factor) : 1;
    return {
      id: r.id, product_id: r.product_id, product_name: r.product_name, qty_units: round2(-r.qty * cf), unit: r.consumption_unit || r.base_unit || '',
      // Заметка движения начинается с имени получателя («Кардиология — на неделю»);
      // в карточке самого отдела это имя — шум, остаётся только основание.
      note: stripRecipient(r.note, dept.name), issued_by: r.issued_by || '', created_at: r.created_at,
      source: r.reference_type === 'requisition' ? 'requisition' : 'issue', reference_id: r.reference_id || null,
    };
  });

  // Расход на пациентов из остатка отдела: визит или госпитализация; отмена — kind 'void'.
  const usage = db.prepare(`
    SELECT m.id, m.kind, m.product_id, m.qty, m.reference_type, m.reference_id, m.created_at, m.note,
           p.name AS product_name, p.base_unit, p.consumption_unit, p.consumption_factor,
           u.full_name AS by_name,
           CASE m.reference_type
             WHEN 'visit' THEN (SELECT pt.full_name FROM visit_services vs JOIN visits v ON v.id = vs.visit_id JOIN patients pt ON pt.id = v.patient_id WHERE vs.id = m.reference_id)
             WHEN 'admission' THEN (SELECT pt.full_name FROM admission_services s JOIN admissions ad ON ad.id = s.admission_id JOIN patients pt ON pt.id = ad.patient_id WHERE s.id = m.reference_id)
             ELSE NULL END AS patient_name
      FROM stock_movements m
      JOIN products p ON p.id = m.product_id
      LEFT JOIN users u ON u.id = m.created_by
     WHERE m.holder_type = 'department' AND m.holder_id = ? AND m.reference_type IN ('visit', 'admission')
     ORDER BY m.created_at DESC, m.id DESC LIMIT 500`).all(id).map((r) => {
    const cf = r.consumption_unit && Number(r.consumption_factor) > 0 ? Number(r.consumption_factor) : 1;
    return {
      id: r.id, kind: r.kind === 'void' ? 'void' : 'dispense', product_id: r.product_id, product_name: r.product_name,
      qty_units: round2(Math.abs(r.qty) * cf), unit: r.consumption_unit || r.base_unit || '',
      where: r.reference_type, patient_name: r.patient_name || '', by_name: r.by_name || '', created_at: r.created_at, note: r.note || '',
    };
  });

  const events = db.prepare(`
    SELECT e.id, e.kind, e.details, e.created_at, u.full_name AS actor_name
      FROM department_events e LEFT JOIN users u ON u.id = e.actor_id
     WHERE e.department_id = ? ORDER BY e.created_at DESC, e.id DESC LIMIT 200`).all(id).map((e) => {
    let details = null;
    try { details = e.details ? JSON.parse(e.details) : null; } catch { details = null; }
    return { id: e.id, kind: e.kind, details, created_at: e.created_at, actor_name: e.actor_name || '' };
  });

  const requisitions = db.prepare(`
    SELECT r.id, r.req_number, r.status, r.created_at, r.notes, u.full_name AS requested_by_name,
           (SELECT COUNT(*) FROM purchase_requisition_items i WHERE i.req_id = r.id) AS lines
      FROM purchase_requisitions r LEFT JOIN users u ON u.id = r.requested_by
     WHERE r.department_id = ? ORDER BY r.created_at DESC LIMIT 50`).all(id);

  return {
    department: { id: dept.id, name: dept.name, code: dept.code || '', kind: dept.kind, active: dept.active !== 0, created_at: dept.created_at,
      head: dept.head_user_id ? userBrief(db, dept.head_user_id) : null },
    can_form: canForm(db, user),
    can_issue: grantAllows(db, user, 'procurement.issue', 'edit', ISSUE_ROLES),
    can_request: hasAnyRole(user, REQUEST_ROLES),
    members, floors, places: [...rooms, ...wards],
    holdings, issues, usage, events, requisitions,
  };
}
