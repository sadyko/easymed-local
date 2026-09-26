// ADMIN_ROWS_GRANTABLE_V1 (2026-09-26) — ЗАЩИТА ОТ САМОПОВЫШЕНИЯ: «Роли» и
// «Сотрудники» в руках не-администратора.
//
// Владелец: «there are some roles and functions which are only available to the
// administrator. can you make read, change, delete options for them too?».
//
// «Роли» и «Сотрудники» — ключи от всей программы. Пока их держал один
// администратор, спрашивать «а не даёт ли он больше, чем имеет» было незачем:
// у него есть всё. Теперь их можно выдать заведующей, и без этого файла право
// «Роли: Изменение» было бы правом на всё сразу — поставь своей же роли
// «Удаление» везде, и готово. Поэтому у каждого, кто правит права, НЕ будучи
// администратором, сервер проверяет четыре вещи:
//
//   1. роль администратора, своя роль клиники на её основе и роль на основе
//      администратора — неприкосновенны (их нельзя ни править, ни завести);
//   2. свои собственные роли (основная, дополнительные, своя роль клиники)
//      править нельзя — ни поднять себе права, ни запереть себя вне «Ролей»;
//   3. поднять раздел, вкладку карты или ключ справочника можно не выше того,
//      что держит сам правящий (снять ключ — значит вернуть прежнее правило
//      кода, а оно может быть шире, поэтому снятие считается подъёмом до
//      максимума);
//   4. основой своей роли клиники может быть только роль, которую правящий
//      носит сам: основа решает, какие ДАННЫЕ отдаёт сервер, и сравнить её по
//      ключам нельзя.
//
// «Держит сам» — то, что показывает ЕГО роль на экране «Роли»: записанные
// ключи, а для незаписанных — вывод из старых полей (grantsFromLegacy, тот же,
// что рисует экран). Администратор (и администратор дополнительной ролью)
// сюда не попадает вовсе.
//
// Тот же ответ «не выше своего» читает и routes/users.js: назначить сотруднику
// роль можно, только если у этой роли нет ничего сверх прав назначающего.
import { isAdminUser, effectiveLevel, rolesForGrants } from './grants.js';
import { effectiveRoles, sectionLevel, patientTabLevel, VALID_ROLES, PATIENT_CARD_TABS, tabRankOfPerms } from './roles.js';
import { grantsFromLegacy, catalogRows } from '../../public/js/shared/permission-catalog.js';
import { fallbackLevel } from './gate-fallbacks.js';   // ревью I3/C1 — что дают настоящие ворота
import { compile } from '../db/query-compiler.js';

const RANK = { none: 0, view: 1, edit: 2, delete: 3 };
const SECTION_RANK = { viewer: 1, editor: 2, admin: 3 };
const TOP = 3;

function parsePerms(raw) {
  if (raw == null) return null;
  if (typeof raw === 'object') return raw;
  try { const p = JSON.parse(String(raw)); return p && typeof p === 'object' ? p : null; } catch { return null; }
}

/** Права роли из role_permissions — или null, если строки нет. */
export function permsOfRole(db, role) {
  let row = null;
  try { row = db.prepare('SELECT permissions FROM role_permissions WHERE role = ?').get(role); } catch { row = null; }
  return row ? (parsePerms(row.permissions) || {}) : null;
}

function customRole(db, code) {
  try { return db.prepare('SELECT code, base_role, active FROM custom_roles WHERE code = ?').get(code) || null; }
  catch { return null; }
}

/** Все коды ролей, которые носит человек: основная, дополнительные, своя роль клиники. */
export function ownRoleCodes(user) {
  const set = new Set(effectiveRoles(user));
  const c = user && typeof user.custom_role_code === 'string' ? user.custom_role_code.trim() : '';
  if (c) set.add(c);
  return set;
}

/** Роль администратора или своя роль клиники на её основе. */
export function isAdminRoleCode(db, code) {
  if (code === 'admin') return true;
  const c = customRole(db, code);
  return !!(c && c.base_role === 'admin');
}

// Уровень ключа, выведенный из старых полей ролей человека (как его рисует экран).
function derivedLevel(db, user, key) {
  let best = 'none';
  for (const role of rolesForGrants(db, user)) {
    const p = permsOfRole(db, role);
    if (!p) continue;
    const g = grantsFromLegacy(p)[key];
    if (g && (RANK[g] || 0) > (RANK[best] || 0)) best = g;
  }
  return best;
}

const minLevel = (a, b) => ((RANK[a] || 0) <= (RANK[b] || 0) ? a : b);

// Ревью I3 — свой уровень по НЕНАСТРОЕННОМУ ключу: то, что рисует экран, но не
// выше того, что дают настоящие ворота ключа (все его ворота этого уровня).
function actorLegacy(db, actor, key) {
  const derived = derivedLevel(db, actor, key);
  const real = fallbackLevel(db, actor, key, 'all');
  return real === null ? derived : minLevel(derived, real);
}
function actorGrantRank(db, actor, key) {
  return RANK[effectiveLevel(db, actor, key, actorLegacy(db, actor, key))] || 0;
}
// Ревью C1 — уровень того, КОМУ выдают (роль как «человек» с этой ролью),
// считается ТЕМ ЖЕ правилом, что и у правящего: одна и та же роль по обе
// стороны обязана дать один и тот же ответ. Ворота по основе при этом не
// недосчитаны: основу правящий носит сам (проверено в roleExceedsActor), и
// всякие ворота, пускающие роль, пускают и его.
function targetGrantRank(db, pseudo, key) {
  return actorGrantRank(db, pseudo, key);
}
function actorSectionRank(db, actor, key) {
  const l = sectionLevel(db, actor, key);
  return l ? (SECTION_RANK[l] || TOP) : 0;
}
function actorTabRank(db, actor, tab) {
  return RANK[patientTabLevel(db, actor, tab)] || 0;
}

/**
 * Первое, что `next` даёт СВЕРХ `prev` и сверх прав `actor`, — словами, — или
 * null. `prev` = null: роль новая (или назначается сотруднику) — тогда
 * сравнивается всё, что в ней есть.
 */
export function permissionExcess(db, actor, prev, next) {
  const p = prev || {};
  const n = next || {};

  // Разделы (старые ключи меню) и их уровни; уровень без записи — 'admin'.
  const pSec = new Set(Array.isArray(p.sections) ? p.sections : []);
  const pLv = (p.levels && typeof p.levels === 'object') ? p.levels : {};
  const nLv = (n.levels && typeof n.levels === 'object') ? n.levels : {};
  for (const s of (Array.isArray(n.sections) ? n.sections : [])) {
    const nr = SECTION_RANK[nLv[s]] || TOP;
    const pr = pSec.has(s) ? (SECTION_RANK[pLv[s]] || TOP) : 0;
    if (nr > pr && nr > actorSectionRank(db, actor, s)) return `раздел «${s}»`;
  }

  // Вкладки карты пациента — ВСЕ и тем же разбором, что у сервера
  // (roles.js tabRankOfPerms: псевдонимы, «Услуги» наследуют «Нет» у «Визитов»,
  // пустое — полный доступ, потолок вкладки). Ревью I1: сравнение по одним
  // записанным ключам пропускало «визиты: Нет → Просмотр», которое молча
  // открывало «Услуги» целиком.
  for (const t of PATIENT_CARD_TABS) {
    const nr = tabRankOfPerms(n, t);
    const pr = prev ? tabRankOfPerms(p, t) : 0;
    if (nr > pr && nr > actorTabRank(db, actor, t)) return `вкладка карты «${t}»`;
  }

  // Ключи справочника. Снятый ключ — возврат к правилу кода, считаем максимумом;
  // незаписанный прежде — как нуль: подъём с него выдаёт право заново.
  const pG = (p.grants && typeof p.grants === 'object') ? p.grants : {};
  const nG = (n.grants && typeof n.grants === 'object') ? n.grants : {};
  for (const k of new Set([...Object.keys(pG), ...Object.keys(nG)])) {
    const nr = k in nG ? (RANK[nG[k]] ?? TOP) : TOP;
    const pr = k in pG ? (RANK[pG[k]] ?? TOP) : 0;
    if (nr > pr && nr > actorGrantRank(db, actor, k)) return `право «${k}»`;
  }

  // Всё прочее в записи роли правящий не-администратор менять не может.
  const known = new Set(['sections', 'levels', 'patient_tabs', 'grants']);
  for (const k of new Set([...Object.keys(p), ...Object.keys(n)])) {
    if (known.has(k)) continue;
    if (JSON.stringify(p[k]) !== JSON.stringify(n[k])) return `настройка роли «${k}»`;
  }
  return null;
}

/**
 * Есть ли у роли `code` что-то сверх прав `actor` (для назначения сотруднику).
 * Роль без записи прав — своя роль клиники живёт по основе, штатная без
 * записи непроверяема и считается «больше».
 */
export function roleExceedsActor(db, actor, code) {
  if (!code) return null;
  if (isAdminRoleCode(db, code)) return 'роль администратора';
  // Ревью C1 — ОСНОВА. Данные (реестр таблиц) и прежние списки ворот сервер
  // выдаёт по основе, и по матрице её не сравнить: лаборант с «пустой»
  // матрицей всё равно пишет результаты анализов. Поэтому назначить можно
  // только основу, которую носишь сам.
  const custom = customRole(db, code);
  const baseRole = custom ? custom.base_role : code;
  if (!effectiveRoles(actor).includes(baseRole)) return `основа «${baseRole}», которой у вас нет`;
  const perms = permsOfRole(db, code) || (custom ? permsOfRole(db, baseRole) : null) || {};
  const shape = { sections: perms.sections, levels: perms.levels, patient_tabs: perms.patient_tabs };
  const excess = permissionExcess(db, actor, null, shape);
  if (excess) return excess;
  // И КАЖДЫЙ ключ справочника — действующий уровень, не только записанный:
  // у незаписанного ключа роль получает то, что ей дают ворота по основе.
  const pseudo = custom
    ? { id: 0, role: baseRole, extra_roles: [], custom_role_code: code }
    : { id: 0, role: code, extra_roles: [] };
  for (const r of catalogRows()) {
    if (targetGrantRank(db, pseudo, r.key) > actorGrantRank(db, actor, r.key)) return `право «${r.key}»`;
  }
  return null;
}

// Строки, которых коснётся правка: тем же компилятором и с теми же правами.
function targetsOf(db, user, table, columns, filters) {
  try {
    const sel = compile({ table, op: 'select', columns, filters }, user, { db });
    return db.prepare(sel.sql).all(...sel.params);
  } catch { return null; }
}

const asRows = (values) => (Array.isArray(values) ? values : [values || {}]);

/**
 * Отказ для записи в role_permissions / custom_roles — текст или null.
 * Зовётся из routes/db.js ДО выполнения; администратор сюда не попадает.
 */
const CODE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function roleWriteRefusal(db, user, meta, body) {
  if (!meta || (meta.table !== 'role_permissions' && meta.table !== 'custom_roles')) return null;
  if (meta.op === 'select') return null;
  // Ревью (c) — код роли только строчными латиницей: «Admin» рядом с «admin»
  // выглядел бы одной ролью, а сервер читал бы их как две. Для всех, и для
  // администратора тоже.
  if (meta.op === 'insert' || meta.op === 'upsert') {
    const col = meta.table === 'custom_roles' ? 'code' : 'role';
    for (const v of asRows(body && body.values)) {
      const code = v && v[col];
      if (typeof code !== 'string' || !CODE_RE.test(code)) return 'Роли: код роли — строчные латинские буквы, цифры, «-» и «_».';
    }
  }
  if (isAdminUser(user)) return null;
  const own = ownRoleCodes(user);
  const values = body && body.values;
  const filters = body && body.filters;
  const refuse = (why) => `Роли: ${why}. Права выдаёт администратор или роль с «Роли: Изменение» — не выше своих собственных.`;

  if (meta.table === 'custom_roles') {
    if (meta.op === 'delete') return refuse('удалять роли нельзя');
    const checkBase = (base) => {
      if (base === undefined) return null;
      if (base === 'admin') return refuse('роль на основе администратора заводит только администратор');
      if (!effectiveRoles(user).includes(base)) return refuse(`основой может быть только роль, которую вы носите сами (не «${base}»)`);
      return null;
    };
    if (meta.op === 'insert' || meta.op === 'upsert') {
      for (const v of asRows(values)) {
        const code = String((v && v.code) || '').trim();
        if (VALID_ROLES.includes(code)) return refuse(`код «${code}» занят штатной ролью`);
        if (own.has(code)) return refuse('свою роль править нельзя');
        const b = checkBase(v && v.base_role);
        if (b) return b;
      }
      if (meta.op === 'insert') return null;
    }
    const rows = targetsOf(db, user, 'custom_roles', 'code,base_role', filters);
    if (!rows) return refuse('не удалось определить, какие роли меняются');
    for (const r of rows) {
      if (r.base_role === 'admin') return refuse('роль на основе администратора меняет только администратор');
      if (own.has(r.code)) return refuse('свою роль править нельзя');
    }
    for (const v of asRows(values)) { const b = checkBase(v && v.base_role); if (b) return b; }
    return null;
  }

  // role_permissions
  if (meta.op === 'delete') return refuse('удалять права ролей нельзя');
  const checkTarget = (role) => {
    if (!role) return refuse('не указана роль');
    if (isAdminRoleCode(db, role)) return refuse('права администратора меняет только администратор');
    if (own.has(role)) return refuse('свою роль править нельзя');
    if (!VALID_ROLES.includes(role) && !customRole(db, role)) return refuse(`роли «${role}» нет`);
    return null;
  };
  let targets;
  if (meta.op === 'insert' || meta.op === 'upsert') {
    targets = asRows(values).map((v) => ({ role: v && v.role, next: v && v.permissions }));
  } else {
    const rows = targetsOf(db, user, 'role_permissions', 'role', filters);
    if (!rows) return refuse('не удалось определить, какие роли меняются');
    const v = asRows(values)[0] || {};
    targets = rows.map((r) => ({ role: r.role, next: v.permissions }));
  }
  for (const t of targets) {
    const bad = checkTarget(t.role);
    if (bad) return bad;
    if (t.next === undefined) continue;
    const next = parsePerms(t.next);
    if (!next) return refuse('права роли не читаются');
    const excess = permissionExcess(db, user, permsOfRole(db, t.role), next);
    if (excess) return refuse(`нельзя выдать больше, чем есть у вас самих (${excess})`);
  }
  return null;
}
