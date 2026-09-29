// ROLES_SAVE_TRUTH_V1 (2026-09-29) — ЧТО У РОЛИ ЕСТЬ СЕЙЧАС, СЛОВАМИ СЕРВЕРА.
//
// Владелец: «Yes, fix it» — экран «Роли» показывает то, что у роли есть
// сейчас, а «Сохранить роль» меняет только то, что тронули
// (docs/specs/2026-09-29-roles-save-truth-design.md).
//
// ЧТО БЫЛО. Экран рисовал `{...grantsFromLegacy(perms), ...perms.grants}`: у
// ключа, который роль не настраивала, уровень ВЫВОДИЛСЯ из старой галочки
// раздела («раздел выдан — внутри всё»). А сервер для такого ключа пускает по
// списку ролей в коде (gate-fallbacks.js). Первое же «Сохранить роль» писало
// догадку экрана в базу настоящим правом: оператор колл-центра получал
// `crm.all` и читал чужие заявки, регистратура — измерения стационара.
//
// ЧТО ЗДЕСЬ. Для каждой строки справочника с серверными воротами
// (fallbackLevel(...) !== null) — наивысший уровень строки, который пускают те
// же ворота, что пустят человека с этой ролью:
//   • ключ записан у роли — записанный уровень, с правилом «закрытый раздел
//     закрывает всё» (grants.js);
//   • не записан — то, что дают ворота по списку ролей основы (fallbackLevel,
//     режим 'all': у уровня с несколькими воротами засчитан тот, что пускают ВСЕ);
//   • своя роль на основе администратора — администратор проходит, пока его
//     роль ключ не настроила.
// Разделы и окна-маршруты оболочки в ответ не входят: их экран выводит, как и
// прежде, тем же выводом, что оболочка. Единственный раздел с воротами —
// «Закупки» (FALLBACK_FN) — тоже: его уровень пишется в старый ключ
// `inventory`, и правда ворот вместо вывода переписала бы его при пустом
// сохранении.
import { grantAllowsAdminOr, effectiveLevel, grantLevel } from '../grants.js';
import { fallbackLevel } from '../gate-fallbacks.js';
import { VALID_ROLES } from '../roles.js';
import { catalogRows } from '../../../public/js/shared/permission-catalog.js';

export class RpcError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

const RANK = { none: 0, view: 1, edit: 2, delete: 3 };

function customRoleOf(db, code) {
  try { return db.prepare('SELECT code, base_role FROM custom_roles WHERE code = ?').get(code) || null; }
  catch { return null; }
}

/** Человек «с этой ролью»: штатная роль — она сама; своя роль клиники — основа и код. */
export function pseudoUserOfRole(db, role) {
  const custom = customRoleOf(db, role);
  return custom
    ? { id: 0, role: custom.base_role, extra_roles: [], custom_role_code: custom.code }
    : { id: 0, role, extra_roles: [], custom_role_code: null };
}

// Уровень, срезанный до тех, что у строки есть: «Удаление» у строки
// «Нет / Изменение» — это «Изменение».
function clampToRow(row, lvl) {
  let best = 'none';
  for (const l of row.levels || ['none', 'view']) {
    if ((RANK[l] || 0) <= (RANK[lvl] || 0) && (RANK[l] || 0) >= (RANK[best] || 0)) best = l;
  }
  return best;
}

// Строки, о которых отвечает сервер, — со своим стандартом (fallbackLevel).
function* answeredRows(db, pseudo) {
  for (const row of catalogRows()) {
    if (row.kind === 'section' || row.locked) continue;
    const standard = fallbackLevel(db, pseudo, row.key, 'all');
    if (standard === null) continue;   // маршрут оболочки — серверных ворот нет
    yield { row, standard };
  }
}

/** { ключ: уровень } — что у роли есть сейчас по каждой строке с серверными воротами. */
export function effectiveGrantsOf(db, role) {
  const pseudo = pseudoUserOfRole(db, role);
  const levels = {};
  for (const { row, standard } of answeredRows(db, pseudo)) {
    levels[row.key] = clampToRow(row, effectiveLevel(db, pseudo, row.key, standard));
  }
  return levels;
}

/**
 * ROLES_SAVE_TRUTH_V1 (ревью M1, оговорка) — СТРОКИ РАЗДЕЛА, ЗАПИСАННОГО «НЕТ»,
 * ТАКИМИ, КАКИМИ ОНИ СТАНУТ, ЕСЛИ РАЗДЕЛ ОТКРОЮТ.
 *
 * В `levels` такие строки — «Нет»: закрытый раздел закрывает всё, что в нём
 * (grants.js). Но нарисуй их «Нет» — и открытый обратно раздел покажет «Нет»,
 * а после сохранения строки получат своё: записанный уровень или то, что дают
 * ворота по основе (у медсестры девять строк «Стационара» становились
 * «Изменение»/«Просмотр»). Экран рисует строки закрытого раздела отсюда: раздел
 * при этом стоит «Нет», строки погашены, а открой его — они будут ровно такими.
 */
export function ifOpenGrantsOf(db, role) {
  const pseudo = pseudoUserOfRole(db, role);
  const out = {};
  for (const { row, standard } of answeredRows(db, pseudo)) {
    if (!row.parent || grantLevel(db, pseudo, row.parent) !== 'none') continue;
    const written = grantLevel(db, pseudo, row.key);
    out[row.key] = clampToRow(row, written !== null ? written : standard);
  }
  return out;
}

/**
 * args: { role } → { levels, if_open }. Спрашивает тот, кто открывает «Роли».
 * `if_open` — только строки разделов, записанных «Нет» (ifOpenGrantsOf).
 */
export function roleEffectiveGrants(db, args, user) {
  if (!user) throw new RpcError('Войдите в систему.', 401);
  if (!grantAllowsAdminOr(db, user, 'settings.roles', 'view')) {
    throw new RpcError('Права ролей видят администратор и роль с «Роли: Просмотр».', 403);
  }
  const role = String((args && args.role) || '').trim();
  if (!role) throw new RpcError('Не указана роль.', 400);
  if (!VALID_ROLES.includes(role) && !customRoleOf(db, role)) throw new RpcError('Такой роли нет.', 404);
  return { levels: effectiveGrantsOf(db, role), if_open: ifOpenGrantsOf(db, role) };
}
