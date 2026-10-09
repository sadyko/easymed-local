// CRM_UNIFY_V1 (2026-10-09) — ЗАДАЧИ ИДУТ ЗА КАРТОЧКОЙ.
//
// Владелец: «операторы не видят свои задачи». Задача оставалась у прежнего
// оператора, когда карточку брали, передавали или сливали: он видел её в
// красном счётчике (crm_tasks.scope.orOwn), но открыть карточку не мог.
//
// ОДНО ПРАВИЛО — «МОЖЕТ ВЕСТИ КАРТОЧКУ» (canWorkLead; решение контролёра по
// ревью задачи 10). Сотрудник:
//   • активен;
//   • пишет задачи CRM по реестру (crm_tasks.write: администратор,
//     регистратура, колл-центр);
//   • ведёт заявки, а не только смотрит их (canEditCrm, crm/visibility.js);
//   • видит карточку (leadVisible — то же правило, что у доски: её оператор,
//     администратор, «crm.all»; у ничьей — все).
// По нему одному решаются:
//   • список «Ответственный» (RPC crm_task_assignees);
//   • отказ двери /api/db вставке и правке crm_tasks.assignee_id (Р17);
//   • новый хозяин карточки (routes/db.js crmAssignRefusal, слияние);
//   • кто остаётся исполнителем, когда карточка сменила хозяина (Р16).
//
// ЗАДАЧИ ЗА КАРТОЧКОЙ (Р16): хозяин сменился на НЕ пустого — к нему уходят
// ОТКРЫТЫЕ задачи без исполнителя, прежнего хозяина и тех, кто эту карточку
// вести больше не может (ревью R1–R3: А → стопка → Б; задача оператора В на
// ничьей карточке, которую взял А; то же слиянием). Задачи тех, кто её
// по-прежнему ведёт (руководитель, администратор, «crm.all»), остаются.
// Карточку отпустили в стопку (никому) — задачи не двигаются: ничья карточка
// видна всем, прежний оператор свою задачу откроет.
// Зовут: дверь /api/db (crm/booking-mirror-db.js, правка assigned_to) и
// слияние дублей (rpc/crm-merge.js).
import { compile } from '../../db/query-compiler.js';
import { canRead, canWrite } from '../../db/schema-registry.js';
import { leadVisible, canEditCrm } from './visibility.js';
import { publicUser } from '../auth.js';
import { effectiveRoles } from '../roles.js';

export class RpcError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

const idOrNull = (v) => (v == null || v === '' ? null : Number(v));
const has = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);

const USER_COLS = 'id, username, full_name, role, extra_roles, custom_role_code, department_id, is_active, must_change_password';
/** Сотрудник по номеру (как сессия: роли, своя роль клиники, активность) или null. */
export function staffById(db, id) {
  const n = idOrNull(id);
  if (!Number.isInteger(n) || n <= 0) return null;
  const r = db.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`).get(n);
  return r ? publicUser(r) : null;
}

/** «Может вести карточку» с этим хозяином: активен, пишет задачи CRM, ведёт заявки, видит карточку. */
export function canWorkLead(db, user, assignedTo) {
  return !!user && !!user.is_active
    && canWrite('crm_tasks', 'update', effectiveRoles(user))
    && canEditCrm(db, user)
    && leadVisible(db, user, assignedTo);
}
/** То же по номеру сотрудника. */
export const staffCanWorkLead = (db, userId, assignedTo) => canWorkLead(db, staffById(db, userId), assignedTo);
/** Может ли сотрудник стать хозяином карточки — вести СВОЮ карточку. */
export const canOwnLead = (db, userId) => staffCanWorkLead(db, userId, userId);

/**
 * Хозяин карточки сменился с `from` на `to`: открытые задачи без исполнителя,
 * прежнего хозяина и тех, кто карточку с хозяином `to` вести не может, — к
 * `to`. `to` пусто (стопка), тот же или сам вести её не может — ничего.
 *
 * Для разового исправления (задача 14): `moveTasksWithLead(db, id, { to:
 * assigned_to })` у карточки с хозяином — то же правило без «прежнего».
 * @returns {number} сколько задач переехало
 */
export function moveTasksWithLead(db, requestId, { from = null, to = null, cache = null } = {}) {
  const t = idOrNull(to);
  const f = idOrNull(from);
  // CRM_UNIFY_V1 (финальное ревью) — cache: общий для прохода по многим
  // карточкам (rehomeOrphanTasks) ответ «может вести» по паре (сотрудник,
  // хозяин) — права читаются несколькими запросами, а пар немного.
  const known = cache || new Map();
  const ownKey = 'own>' + t;
  if (t != null && !known.has(ownKey)) known.set(ownKey, canOwnLead(db, t));
  if (t == null || t === f || !known.get(ownKey)) return 0;
  const stays = (a) => {
    const k = a + '>' + t;
    if (!known.has(k)) known.set(k, staffCanWorkLead(db, a, t));
    return known.get(k);
  };
  const ids = db.prepare('SELECT id, assignee_id FROM crm_tasks WHERE request_id = ? AND done_at IS NULL').all(requestId)
    .filter((x) => {
      const a = idOrNull(x.assignee_id);
      return a !== t && (a == null || a === f || !stays(a));
    })
    .map((x) => x.id);
  if (!ids.length) return 0;
  return db.prepare(`UPDATE crm_tasks SET assignee_id = ? WHERE id IN (${ids.map(() => '?').join(',')})`).run(t, ...ids).changes;
}

/**
 * CRM_UNIFY_V1 (финальное ревью) — ЗАДАЧИ ТОГО, КТО ПОТЕРЯЛ ПРАВО ВЕСТИ
 * КАРТОЧКУ. Держатель задачи мог перестать вести карточку и без смены её
 * хозяина: сняли «crm.all», роль сменили на «просмотр» или без раздела CRM,
 * сотрудника уволили. Задача оставалась у него: красный счётчик её считал, а
 * открыть (или отметить) её он не мог. Здесь у каждой карточки С ХОЗЯИНОМ,
 * где есть открытая задача без исполнителя или у того, кто её вести не может,
 * — moveTasksWithLead(db, id, { to: хозяин }): то же правило, что при смене
 * хозяина и в разовом исправлении (crm/unify-repair.js). Хозяин сам вести
 * карточку не может (уволен) — ничего: задачи пойдут за карточкой, когда
 * руководитель её передаст. Ничья карточка — ничего (её видят все).
 *
 * Меняется только crm_tasks.assignee_id — карточки (updated_at) не трогаются.
 * Повтор ничего не находит. Один проход — один запрос по открытым задачам и
 * ответ «может вести» по паре (сотрудник, хозяин) один раз. Не бросает.
 * @returns {number} сколько задач переехало
 */
export function rehomeOrphanTasks(db) {
  try {
    const rows = db.prepare(`SELECT t.request_id AS rid, r.assigned_to AS owner, t.assignee_id AS a
                               FROM crm_tasks t JOIN crm_requests r ON r.id = t.request_id
                              WHERE t.done_at IS NULL AND r.assigned_to IS NOT NULL
                                AND (t.assignee_id IS NULL OR t.assignee_id <> r.assigned_to)`).all();
    if (!rows.length) return 0;
    const cache = new Map();
    const can = (a, owner) => {
      const k = a + '>' + owner;
      if (!cache.has(k)) cache.set(k, staffCanWorkLead(db, a, owner));
      return cache.get(k);
    };
    const cards = new Map();
    for (const x of rows) if (x.a == null || !can(x.a, x.owner)) cards.set(x.rid, x.owner);
    if (!cards.size) return 0;
    let moved = 0;
    db.transaction(() => {
      for (const [rid, owner] of cards) moved += moveTasksWithLead(db, rid, { to: owner, cache });
    })();
    return moved;
  } catch (e) {
    console.error('[crm-tasks] задачи хозяину карточки не переданы:', e && e.message);
    return 0;
  }
}

/** При запуске и раз в час (server/index.js). Таймер unref: остановке сервера не мешает. */
export function scheduleCrmTaskRehome(db, { everyMs = 3600 * 1000 } = {}) {
  const run = () => {
    const n = rehomeOrphanTasks(db);
    if (n) console.log(`  CRM: задач передано оператору карточки (держатель больше не может её вести): ${n}`);
  };
  run();
  const h = setInterval(run, everyMs);
  if (h && typeof h.unref === 'function') h.unref();
  return h;
}

function assigneeRefusal() {
  return 'Ответственным можно назначить только того, кто может вести эту карточку: её оператора или руководителя.';
}
/** Безликий отказ — тот же, что у вставки на чужую карточку (ограничение через родителя). */
function facelessRefusal() {
  return 'not allowed';
}
/** Отказ новому хозяину карточки (routes/db.js crmAssignRefusal). */
export function ownerRefusal() {
  return 'Передать заявку можно только сотруднику, который может вести заявки CRM: активному и с правом их изменять.';
}

/**
 * Отказ двери /api/db (вставка и правка crm_tasks с assignee_id) или null.
 *
 * Исполнитель обязан мочь вести карточку (canWorkLead).
 *
 * Вставка на карточку, которую не видит сам пишущий, здесь не проверяется: её
 * отвергнет ограничение через родителя тем же безликим отказом, что и раньше,
 * — иначе ответ выдавал бы, что чужая карточка с таким номером существует.
 *
 * Правка отказывает, только если ДЕЙСТВИТЕЛЬНО меняет исполнителя: сохранение
 * задачи с тем же исполнителем проходит и у старой задачи на чужой карточке.
 * Менять исполнителя может только тот, кто карточку ВИДИТ (ревью R6): держатель
 * старой задачи на чужой карточке (orOwn) получает безликий отказ при любом
 * значении — иначе перебором номеров он узнавал бы, чья это карточка.
 */
export function taskAssigneeRefusal(db, meta, body, user) {
  // CRM_UNIFY_V1 (финальное ревью) — upsert задачи обходил бы и правило
  // исполнителя (ниже — только вставка и правка), и метки created_by. Экран
  // upsert задач не делает никогда — дверь его не принимает: безликий отказ.
  if (meta && meta.table === 'crm_tasks' && meta.op === 'upsert') return facelessRefusal();
  if (!meta || meta.table !== 'crm_tasks' || (meta.op !== 'insert' && meta.op !== 'update')) return null;
  const rows = (Array.isArray(body && body.values) ? body.values : [body && body.values]).filter((r) => has(r, 'assignee_id'));
  if (!rows.length) return null;
  const leadOf = db.prepare('SELECT assigned_to FROM crm_requests WHERE id = ?');
  if (meta.op === 'insert') {
    for (const r of rows) {
      if (idOrNull(r.assignee_id) == null) continue;   // без исполнителя — можно
      const lead = leadOf.get(Number(r.request_id));
      if (!lead || !leadVisible(db, user, lead.assigned_to)) continue;   // откажет ограничение через родителя
      if (!staffCanWorkLead(db, r.assignee_id, lead.assigned_to)) return assigneeRefusal();
    }
    return null;
  }
  const next = idOrNull(rows[0].assignee_id);
  const sel = compile({ table: 'crm_tasks', op: 'select', columns: 'id, request_id, assignee_id', filters: body.filters }, user, { db });
  const changing = db.prepare(sel.sql).all(...sel.params)
    .filter((x) => idOrNull(x.assignee_id) !== next)   // исполнитель тот же — правка его не меняет
    .map((x) => leadOf.get(x.request_id))
    .filter(Boolean);
  // Сначала — видит ли пишущий карточку: ответ не должен зависеть от значения.
  if (changing.some((lead) => !leadVisible(db, user, lead.assigned_to))) return facelessRefusal();
  if (next == null) return null;
  for (const lead of changing) {
    if (!staffCanWorkLead(db, next, lead.assigned_to)) return assigneeRefusal();
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
    .map(publicUser).filter((u) => canWorkLead(db, u, lead.assigned_to))
    .map((u) => ({ id: u.id, full_name: u.full_name }));
}
