// STOCK_LOG_V1 (2026-09-23) — ЖУРНАЛ ДВИЖЕНИЙ СКЛАДА: КТО, КОМУ, ЧТО, КОГДА.
//
// Владелец (23.09), решение по третьему вопросу: «каждый видит своё,
// заведующая — свой отдел, администратор и кладовщик — всю клинику»; и сам
// журнал чинится — кто, кому, партия, срок, фильтр по датам.
//
// ЧТО БЫЛО СЛОМАНО, И ПОЧЕМУ ЭТО ОТДЕЛЬНЫЙ ОБРАБОТЧИК, А НЕ ЗАПРОС ИЗ ЭКРАНА.
//
//   1. «КТО» БЫЛ ВСЕГДА «—». Экран просил встраивание `users(full_name,…)`, а
//      реестр (server/db/schema-registry.js) регистрирует связь с сотрудником
//      под именем `created_by`. Компилятор отвечал 403 «unknown embed», экран
//      молча откатывался на запрос без соединения — и колонка рисовала прочерк
//      у КАЖДОЙ строки. Тот же класс, что DB_QUERY_SCHEMA_V1: отказ сервера
//      выглядел как «данных нет».
//   2. «КОМУ» НЕ БЫЛО ВОВСЕ. Получателя знает пара holder_type/holder_id
//      (миграция 128), но в журнал он попадал только тем, что issue_stock_lines
//      приклеивает имя получателя к началу основания — а карточка отдела потом
//      отклеивает его обратно (rpc/departments.js stripRecipient). Теперь
//      получатель — колонка, и имя из основания убирается здесь же.
//   3. ПАРТИЯ И СРОК ГОДНОСТИ (миграция 037) писались приходом и не читались
//      никем.
//
// ОБЛАСТЬ ВИДИМОСТИ СЧИТАЕТ СЕРВЕР, А НЕ ЭКРАН. Отбор «своё / свой отдел / вся
// клиника» дописывается к WHERE здесь: экран не получает чужих строк и потому
// не может их показать — ни по ошибке, ни по прямой ссылке. Это же причина,
// по которой журнал не строится запросом из браузера через /api/db: там
// область видимости пришлось бы выражать фильтрами, которые запрос волен не
// прислать.
//
// РОЛЬ, КОТОРОЙ НЕЧЕГО ПОКАЗАТЬ, ПОЛУЧАЕТ ПУСТОЙ СПИСОК, А НЕ 403. Отказ на
// журнале читается как поломка и кончается звонком администратору; пустой
// список говорит правду — «за вами движений не числится».
//
// ЗАКУПОЧНАЯ ЦЕНА — ОТДЕЛЬНОЕ ПРАВО, И СНИМАЕТ ЕЁ СЕРВЕР. Право видеть строку
// и право видеть, почём клиника закупает, — разные права: область видимости
// открыла журнал медсестре и заведующей, видимость денег этим не расширилась.
// Экран колонку «Цена за ед.» и так рисует только области 'all' (views/
// stock-log.js), но разметка — не защита: ответ сервера виден во вкладке
// «Сеть» браузера одним движением. Поэтому unit_cost уходит ЧИСЛОМ только
// области 'all', а всем прочим — null.
import { hasAnyRole, canViewSection } from '../roles.js';
import { grantAllowsOr } from '../grants.js';
import { inLocalRange, localDate } from '../domain/day.js';

export class RpcError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

// Кто видит весь склад — тот же список, что у «Выдать со склада»
// (rpc/procurement.js) и у карточки отдела (rpc/departments.js SEE_ALL_ROLES).
const SEE_ALL_ROLES = ['admin', 'inventory'];
// Виды, которыми журнал разговаривает с человеком. 'issue' и 'dispense' — это
// ОДИН kind базы ('dispense'), разведённый основанием: выдача со склада
// получателю против расхода на пациента. Экран показывает их разными чипами и
// обязан уметь отобрать каждый.
export const VIEW_KINDS = ['receive', 'issue', 'dispense', 'adjust', 'void'];
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const isPosInt = (v) => Number.isInteger(v) && v > 0;
const round2 = (n) => Math.round(Number(n) * 100) / 100;

/**
 * Видит ли этот человек ВЕСЬ склад. Настроенный уровень раздела «Закупки»
 * решает первым (GRANTS_V1), а пока клиника ничего не настраивала — прежнее
 * правило: администратор, кладовщик или роль с разделом «Закупки и склад».
 */
export function canSeeAllMovements(db, user) {
  if (!user) return false;
  return grantAllowsOr(db, user, 'procurement', 'view',
    () => hasAnyRole(user, SEE_ALL_ROLES) || canViewSection(db, user, 'inventory'));
}

/**
 * Область видимости журнала для этого человека — ОДНО правило на список и на
 * любой будущий экран поверх того же реестра (S4 «Мои запасы», S5 «Сроки
 * годности»).
 *
 *   all        — вся клиника: администратор, кладовщик, настроенный «Закупки».
 *   department — свой отдел плюс своё: заведующая (departments.head_user_id —
 *                то же понятие «руководитель», которым живёт карточка отдела,
 *                rpc/departments.js isOwn()).
 *   own        — только своё: где человек провёл движение сам или где он же
 *                получатель.
 *   none       — вошедшего нет вовсе; список пуст, исключения нет.
 */
export function journalScope(db, user) {
  const id = user && Number(user.id);
  if (!isPosInt(id)) return { kind: 'none', user_id: null, departments: [] };
  if (canSeeAllMovements(db, user)) return { kind: 'all', user_id: id, departments: [] };
  const depts = db.prepare('SELECT id FROM departments WHERE head_user_id = ? ORDER BY id').all(id).map((r) => r.id);
  if (depts.length) return { kind: 'department', user_id: id, departments: depts };
  return { kind: 'own', user_id: id, departments: [] };
}

/** Кусок WHERE и его параметры для области видимости (пусто — «видно всё»). */
function scopeClause(scope) {
  if (scope.kind === 'all') return null;
  if (scope.kind === 'none') return { sql: '1 = 0', params: [] };
  const own = "(m.created_by = ? OR (m.holder_type = 'staff' AND m.holder_id = ?))";
  if (scope.kind === 'own') return { sql: own, params: [scope.user_id, scope.user_id] };
  const marks = scope.departments.map(() => '?').join(', ');
  return {
    sql: `((m.holder_type = 'department' AND m.holder_id IN (${marks})) OR ${own})`,
    params: [...scope.departments, scope.user_id, scope.user_id],
  };
}

/**
 * MY_STOCK_V1 — СУЖЕНИЕ «ТОЛЬКО МОЁ», о котором просит экран «Мои запасы».
 *
 * Оно НИКОГДА не расширяет видимость: условие приписывается к WHERE рядом с
 * отбором области (scopeClause), то есть действует ВМЕСТЕ с ним, а не вместо.
 * Администратор, попросивший 'to_me', получит только то, что выдали лично ему;
 * медсестра — то же самое, потому что большего ей и так не видно.
 *
 * Два значения, и они РАЗНЫЕ — их путает даже «своё» из journalScope, где они
 * склеены через ИЛИ:
 *   to_me — что выдали МНЕ (я держатель). Кладовщик, раздающий товар отделам,
 *           в свой «выдали мне» их не увидит.
 *   by_me — что провёл Я САМ (я автор движения): расход на пациента, списанный
 *           мной, — даже если товар брали из отдела, а не с моих рук.
 */
const ONLY_KINDS = ['to_me', 'by_me'];

function onlyClause(only, userId) {
  if (only === undefined || only === null || only === '') return null;
  if (!ONLY_KINDS.includes(only)) throw new RpcError(`Неизвестное сужение: ${only}.`, 400);
  if (!isPosInt(userId)) return { sql: '1 = 0', params: [] };
  if (only === 'to_me') return { sql: "(m.holder_type = 'staff' AND m.holder_id = ?)", params: [userId] };
  return { sql: 'm.created_by = ?', params: [userId] };
}

function checkDate(value, what) {
  if (value === undefined || value === null || value === '') return null;
  const s = String(value).trim();
  if (!DATE_RE.test(s)) throw new RpcError(`${what}: дата в формате ГГГГ-ММ-ДД.`, 400);
  return s;
}

/** Условие «этот вид движения», словами экрана, а не колонками базы. */
function kindClause(view) {
  if (view === 'receive') return { sql: "m.kind = 'receive'", params: [] };
  if (view === 'adjust')  return { sql: "m.kind = 'adjust'", params: [] };
  if (view === 'void')    return { sql: "m.kind = 'void'", params: [] };
  if (view === 'issue')   return { sql: "(m.kind = 'dispense' AND m.reference_type = 'issue')", params: [] };
  return { sql: "(m.kind = 'dispense' AND (m.reference_type IS NULL OR m.reference_type <> 'issue'))", params: [] };
}

const viewKindOf = (row) => (row.kind === 'dispense' && row.reference_type === 'issue' ? 'issue' : row.kind);

/**
 * Имя получателя убирается из начала основания: issue_stock_lines пишет
 * «Кардиология — на неделю», и пока «кому» не было колонкой, имя приходилось
 * читать оттуда. Теперь оно колонка, а в основании остаётся причина.
 * Та же операция, что stripRecipient в rpc/departments.js.
 */
function stripHolder(note, name) {
  const n = String(note || '').trim();
  if (!n || !name) return n;
  if (n === name) return '';
  const prefix = name + ' — ';
  return n.startsWith(prefix) ? n.slice(prefix.length) : n;
}

/**
 * stock_movements_list — журнал движений склада.
 *
 * args: { from?, to? ('ГГГГ-ММ-ДД', по местному дню клиники),
 *         kind? ('receive'|'issue'|'dispense'|'adjust'|'void'),
 *         q? (поиск по названию или коду товара),
 *         only? ('to_me' — что выдали мне, 'by_me' — что провёл я; MY_STOCK_V1),
 *         limit? (по умолчанию 200, потолок 1000), offset? }
 *
 * → { scope, departments, limit, offset, truncated, count, movements: [{
 *       id, created_at, kind, view_kind, reference_type, reference_id,
 *       product_id, product_name, unit, qty, unit_cost, note,
 *       actor_id, actor_name, holder_type, holder_id, holder_name,
 *       batch_no, expiry_date, patient_name }] }
 *
 * qty и unit — БАЗОВЫЕ, те же, что products.on_hand: журнал говорит на языке
 * склада, а не потребления (минус 5 упаковок, а не минус 500 штук).
 * unit_cost — число только области 'all'; всем прочим null (см. шапку файла).
 */
export function stockMovementsList(db, args, user) {
  const a = args || {};
  const scope = journalScope(db, user);

  const where = ['1 = 1'];
  const params = [];

  const from = checkDate(a.from, 'С');
  const to = checkDate(a.to, 'По');
  if (from && to) { where.push(inLocalRange('m.created_at')); params.push(from, to); }
  else if (from) { where.push(`${localDate('m.created_at')} >= date(?)`); params.push(from); }
  else if (to) { where.push(`${localDate('m.created_at')} <= date(?)`); params.push(to); }

  if (a.kind !== undefined && a.kind !== null && a.kind !== '' && a.kind !== 'all') {
    if (!VIEW_KINDS.includes(a.kind)) throw new RpcError(`Неизвестный вид движения: ${a.kind}.`, 400);
    const k = kindClause(a.kind);
    where.push(k.sql); params.push(...k.params);
  }

  const q = typeof a.q === 'string' ? a.q.trim() : '';
  if (q) { where.push('(p.name LIKE ? OR IFNULL(p.code, \'\') LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }

  const sc = scopeClause(scope);
  if (sc) { where.push(sc.sql); params.push(...sc.params); }

  // MY_STOCK_V1 — сужение экрана «Мои запасы», ПОСЛЕ области видимости и
  // вместе с ней: расширить этим аргументом ничего нельзя.
  const oc = onlyClause(a.only, scope.user_id);
  if (oc) { where.push(oc.sql); params.push(...oc.params); }

  const limit = isPosInt(Number(a.limit)) ? Math.min(Number(a.limit), MAX_LIMIT) : DEFAULT_LIMIT;
  const offset = isPosInt(Number(a.offset)) ? Number(a.offset) : 0;

  // +1 строка сверх лимита — чтобы сказать «показаны не все», а не делать вид,
  // что журнал кончился ровно на круглом числе.
  const rows = db.prepare(`
    SELECT m.id, m.created_at, m.kind, m.product_id, m.qty, m.unit_cost, m.reference_type, m.reference_id, m.note,
           m.created_by, m.holder_type, m.holder_id, m.batch_no, m.expiry_date, m.supplier_id,
           p.name AS product_name, p.unit, p.base_unit,
           u.full_name AS actor_full_name, u.username AS actor_username,
           CASE m.holder_type
             WHEN 'staff'      THEN (SELECT full_name FROM users WHERE id = m.holder_id)
             WHEN 'room'       THEN (SELECT name FROM rooms WHERE id = m.holder_id)
             WHEN 'department' THEN (SELECT name FROM departments WHERE id = m.holder_id)
             ELSE NULL END AS holder_name,
           CASE m.reference_type
             WHEN 'visit'     THEN (SELECT pt.full_name FROM visit_services vs JOIN visits v ON v.id = vs.visit_id JOIN patients pt ON pt.id = v.patient_id WHERE vs.id = m.reference_id)
             WHEN 'admission' THEN (SELECT pt.full_name FROM admission_services s JOIN admissions ad ON ad.id = s.admission_id JOIN patients pt ON pt.id = ad.patient_id WHERE s.id = m.reference_id)
             ELSE NULL END AS patient_name
      FROM stock_movements m
      JOIN products p ON p.id = m.product_id
      LEFT JOIN users u ON u.id = m.created_by
     WHERE ${where.join(' AND ')}
     ORDER BY m.created_at DESC, m.id DESC
     LIMIT ? OFFSET ?`).all(...params, limit + 1, offset);

  const truncated = rows.length > limit;
  const page = truncated ? rows.slice(0, limit) : rows;
  // Закупочная цена — только области «вся клиника» (см. шапку файла).
  const withCost = scope.kind === 'all';

  return {
    scope: scope.kind,
    departments: scope.departments,
    limit, offset, truncated,
    count: page.length,
    movements: page.map((r) => {
      const holderName = r.holder_name || '';
      return {
        id: r.id,
        created_at: r.created_at,
        kind: r.kind,
        view_kind: viewKindOf(r),
        reference_type: r.reference_type || '',
        reference_id: r.reference_id || null,
        product_id: r.product_id,
        product_name: r.product_name || '',
        unit: r.base_unit || r.unit || '',
        qty: round2(r.qty),
        unit_cost: withCost && r.unit_cost != null ? round2(r.unit_cost) : null,
        note: stripHolder(r.note, holderName),
        actor_id: r.created_by || null,
        actor_name: r.actor_full_name || r.actor_username || '',
        holder_type: r.holder_type || '',
        holder_id: r.holder_id || null,
        holder_name: holderName,
        batch_no: r.batch_no || '',
        expiry_date: r.expiry_date || '',
        patient_name: r.patient_name || '',
      };
    }),
  };
}
