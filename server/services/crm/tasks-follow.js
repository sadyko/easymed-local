// CRM_UNIFY_V1 (2026-10-09) — ЗАДАЧИ ИДУТ ЗА КАРТОЧКОЙ.
//
// Владелец: «операторы не видят свои задачи». Задача оставалась у прежнего
// оператора, когда карточку брали, передавали или сливали: он видел её в
// красном счётчике (crm_tasks.scope.orOwn), но открыть карточку не мог.
//
// ПРАВИЛО (Р16): при смене хозяина карточки ОТКРЫТЫЕ задачи прежнего хозяина
// и задачи без исполнителя переходят новому. Задачу, поручённую конкретному
// человеку, это не трогает. Карточку отпустили в стопку (никому) — задачи не
// двигаются: ничья карточка видна всем, прежний оператор свою задачу откроет.
// Зовут: дверь /api/db (crm/booking-mirror-db.js, правка assigned_to) и
// слияние дублей (rpc/crm-merge.js).
//
// ИСПОЛНИТЕЛЬ ОБЯЗАН ВИДЕТЬ КАРТОЧКУ (Р17) — то же правило, что у доски
// (crm/visibility.js leadVisible): её оператор, администратор, «crm.all»; у
// ничьей — все, кто ведёт доску. «Ведёт доску» — читает задачи CRM по реестру
// (crm_tasks.read: администратор, регистратура, колл-центр). Сервер отказывает
// вставке и правке crm_tasks.assignee_id (routes/db.js), а поле «Ответственный»
// спрашивает список у RPC crm_task_assignees.
import { compile } from '../../db/query-compiler.js';
import { canRead } from '../../db/schema-registry.js';
import { leadVisible } from './visibility.js';
import { publicUser } from '../auth.js';
import { effectiveRoles } from '../roles.js';

export class RpcError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

const idOrNull = (v) => (v == null || v === '' ? null : Number(v));

/**
 * Хозяин карточки сменился с `from` на `to`: открытые задачи прежнего хозяина
 * и задачи без исполнителя — новому. `to` пусто (стопка) или тот же — ничего.
 * @returns {number} сколько задач переехало
 */
export function moveTasksWithLead(db, requestId, { from = null, to = null } = {}) {
  const t = idOrNull(to);
  const f = idOrNull(from);
  if (t == null || t === f) return 0;
  return db.prepare(`UPDATE crm_tasks SET assignee_id = ?
                      WHERE request_id = ? AND done_at IS NULL AND (assignee_id IS NULL OR assignee_id = ?)`)
    .run(t, requestId, f == null ? -1 : f).changes;
}

const USER_COLS = 'id, username, full_name, role, extra_roles, custom_role_code, department_id, is_active, must_change_password';
function userById(db, id) {
  const r = db.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`).get(id);
  return r ? publicUser(r) : null;
}
const boardUser = (u) => !!u && u.is_active && canRead('crm_tasks', effectiveRoles(u));

/** Видит ли сотрудник (по номеру) карточку с этим хозяином и ведёт ли он доску. */
export function userSeesLead(db, userId, assignedTo) {
  const u = userById(db, userId);
  return boardUser(u) && leadVisible(db, u, assignedTo);
}

function assigneeRefusal() {
  return 'Ответственным можно назначить только того, кто видит эту карточку: её оператора или руководителя.';
}

/**
 * Отказ двери /api/db (вставка и правка crm_tasks с assignee_id) или null.
 *
 * Правка отказывает, только если ДЕЙСТВИТЕЛЬНО меняет исполнителя: сохранение
 * задачи, присылающее того же исполнителя, проходит и у старой задачи, чей
 * исполнитель карточку уже не видит. Вставка на карточку, которую не видит сам
 * пишущий, здесь не проверяется: её отвергнет ограничение через родителя тем
 * же безликим отказом, что и раньше, — иначе ответ выдавал бы, что чужая
 * карточка с таким номером существует.
 */
export function taskAssigneeRefusal(db, meta, body, user) {
  if (!meta || meta.table !== 'crm_tasks' || (meta.op !== 'insert' && meta.op !== 'update')) return null;
  const rows = Array.isArray(body && body.values) ? body.values : [body && body.values];
  const named = rows.filter((r) => r && Object.prototype.hasOwnProperty.call(r, 'assignee_id') && idOrNull(r.assignee_id) != null);
  if (!named.length) return null;
  const leadOf = db.prepare('SELECT assigned_to FROM crm_requests WHERE id = ?');
  if (meta.op === 'insert') {
    for (const r of named) {
      const lead = leadOf.get(Number(r.request_id));
      if (!lead || !leadVisible(db, user, lead.assigned_to)) continue;   // откажет ограничение через родителя
      if (!userSeesLead(db, idOrNull(r.assignee_id), lead.assigned_to)) return assigneeRefusal();
    }
    return null;
  }
  const next = idOrNull(named[0].assignee_id);
  const sel = compile({ table: 'crm_tasks', op: 'select', columns: 'id, request_id, assignee_id', filters: body.filters }, user, { db });
  for (const x of db.prepare(sel.sql).all(...sel.params)) {
    if (idOrNull(x.assignee_id) === next) continue;   // исполнитель тот же — правка его не меняет
    const lead = leadOf.get(x.request_id);
    if (!lead) continue;
    if (!userSeesLead(db, next, lead.assigned_to)) return assigneeRefusal();
  }
  return null;
}

/** RPC crm_task_assignees { request_id } → [{ id, full_name }]: кого можно назначить. */
export function crmTaskAssignees(db, args, user) {
  if (!canRead('crm_tasks', effectiveRoles(user))) throw new RpcError('Задачи CRM вам недоступны.', 403);
  const rid = Number(args && args.request_id);
  const lead = Number.isInteger(rid) && rid > 0 ? db.prepare('SELECT assigned_to FROM crm_requests WHERE id = ?').get(rid) : null;
  // Чужая карточка отвечает пустым списком — как несуществующая.
  if (!lead || !leadVisible(db, user, lead.assigned_to)) return [];
  return db.prepare(`SELECT ${USER_COLS} FROM users WHERE is_active = 1 ORDER BY full_name, id`).all()
    .map(publicUser).filter((u) => boardUser(u) && leadVisible(db, u, lead.assigned_to))
    .map((u) => ({ id: u.id, full_name: u.full_name }));
}
