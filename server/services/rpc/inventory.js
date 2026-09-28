// Server-side inventory RPCs. on_hand is writable ONLY through these
// handlers, and every change is paired with a stock_movements ledger row.
// All work runs inside db.transaction(...)() so a rejected dispense (e.g.
// insufficient stock) leaves on_hand, visit_services, and stock_movements
// completely untouched.

import { rpcT } from '../server-message.js';   // V3120_I18N — собранные фразы переводятся на экране
import { hasAnyRole } from '../roles.js';
// BRANCH_MONEY_GUARD_V1 — одна проверка «своё ли это здание» на весь сервер
// (billing.js), а не копия в каждом файле: отказ обязан звучать одинаково.
import { assertOwnBuilding } from './billing.js';
// INPATIENT_FLOW_V1 — «нет лечащего врача — нет лечения» (решение владельца
// 2026-09-04). Проверка живёт в одном месте на весь стационар, а не копией
// здесь: см. rpc/inpatient-flow.js.
import { assertAdmissionAtLeast } from './inpatient-flow.js';
// HOLDINGS_V1 — what the ward already holds is used before the warehouse.
// HOLDINGS_FIRST_V1 — и это теперь правило ВСЕХ дверей, а не флаг двух из них.
import { moveHolding, moveWarehouse, WAREHOUSE } from './holdings.js';
// STOCK_QTY_V1 (V3120_FIX) — шесть знаков вместо round2 на количествах: см.
// domain/stock-qty.js. Деньги (цена, сумма) округляются до сотых, как прежде.
import { roundQty, factorOf, toBase, coversQty, qtyTolerance, unitsOf } from '../domain/stock-qty.js';
// EXPIRY_BALANCE_V1 — «выдача и списание просроченного предупреждают» (владелец
// 23.09). Предупреждение НЕ отказ: оно едет в ответе рядом с результатом, и
// считает его сервер — иначе каждая из восьми дверей сказала бы своими словами.
import { expiryWarnings } from './expiry.js';
// OWN_SHELF_ONLY_V1 — остаток склада в ответе двери видит тот, кто видит склад
// (то же правило, что у журнала «вся клиника» и у products.on_hand в реестре).
import { canSeeAllMovements } from './stock-log.js';

export class RpcError extends Error {
  constructor(msg, status = 400) {
    super(msg);
    this.status = status;
  }
}

const RECEIVE_ROLES = ['admin', 'inventory'];
const DISPENSE_ROLES = ['admin', 'doctor', 'nurse', 'inventory'];
// DOCTOR_WORKSPACE_V1 — a doctor can void their own not-yet-invoiced dispense
// from the workspace (easymed's void_dispensed_visit_item allows it; the
// invoiced-line guard in voidDispense still blocks anything billed).
// INPATIENT_MONEY_FIX_V1 (C4) — и медсестра: она выдаёт (DISPENSE_ROLES), а
// отменить свою ошибочную выдачу не могла — оставалось звать врача или
// оставлять лишнее в счёте. Выставленную строку отмена по-прежнему не трогает.
const VOID_ROLES = ['admin', 'inventory', 'doctor', 'nurse'];

function requireRole(user, allowed) {
  // MULTI_ROLE_SERVER_V1 — extras count too, not the primary role alone.
  if (!hasAnyRole(user, allowed)) {
    throw new RpcError('Ваша роль не может выполнить это действие.', 403);
  }
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function isPositiveInt(v) {
  return Number.isInteger(v) && v > 0;
}

// No clinic single operation legitimately exceeds this. A finite-but-absurd
// quantity (e.g. 1e308) would otherwise pass a bare `> 0 && isFinite` check
// and overflow on_hand to Infinity, permanently defeating the
// insufficient-stock guard (Infinity < anything is always false).
const MAX_QTY = 1_000_000;

function requireQuantity(quantity) {
  if (!(typeof quantity === 'number' && Number.isFinite(quantity) && quantity > 0 && quantity <= MAX_QTY)) {
    throw rpcT(RpcError, 'Количество — положительное число, не больше {max}.', { max: MAX_QTY }, 400);
  }
}

// V3120_FINAL (M3) — количество, которое хранение (шесть знаков) превращает в
// ноль, не списывает ничего, но строку заводило: «выдано 0,0000001 шт.» без
// движения склада. Отказ — тем же словом, что у dispense_from_holding.
function requireStoredQty(baseQty) {
  if (!(roundQty(baseQty) > 0)) throw new RpcError('Количество слишком мало.', 400);
}

function optPosInt(v, name) {
  if (v === undefined || v === null) {
    return null;
  }
  if (!(Number.isInteger(v) && v > 0)) {
    throw rpcT(RpcError, '{name}: нужно положительное целое число.', { name }, 400);
  }
  return v;
}

// =============================================================================
// HOLDINGS_FIRST_V1 (2026-09-23) — ОДНА ЦЕПОЧКА СПИСАНИЯ НА ВСЕ ДВЕРИ.
//
// Владелец (23.09), решение по второму вопросу: «Сначала свой подотчёт, потом
// отдел, потом склад. Везде.»
//
// ЧТО БЫЛО. О подотчёте знали ДВЕ двери из восьми: амбулаторная вкладка
// медсестры (holdings.js dispense_from_holding, где источник называют руками) и
// отметка о введении дозы (она одна передавала prefer_holdings). Остальные
// шесть — койка, история болезни, кабинет врача, окно визита, процедуры, счёт
// визита — всегда брали СО СКЛАДА. Выданное медсестре, в кабинет или в
// отделение становилось призраком: склад платил за него второй раз, а когда
// склад пуст, консоль койки отказывала выдать лекарство, которое физически
// лежит в палате. Это и был баг владельца.
//
// ЧТО СТАЛО. Цепочка — не флаг, а ПОВЕДЕНИЕ ПО УМОЛЧАНИЮ, и она одна на визит
// и на госпитализацию:
//
//     свой подотчёт → кабинет, где шёл приём → отдел этого кабинета или
//     палаты → склад.
//
// УРОВЕНЬ, КОТОРОГО ЗДЕСЬ НЕТ, ПРОПУСКАЕТСЯ, А НЕ УГАДЫВАЕТСЯ. Палата не лежит
// в кабинете: у wards есть floor_id и department_id (миграции 082, 108), но
// room_id у неё нет и никогда не было. Поэтому у койки уровень «кабинет» —
// это только СОБСТВЕННЫЙ кабинет сотрудника (users.room_id, миграция 032), а
// «отдел» — отдел палаты (wards.department_id) и свой отдел
// (users.department_id, миграция 018). У визита кабинет приёма известен
// точно — visits.room_id (миграция 099).
//
// ПОКРЫТИЕ БЫВАЕТ ЧАСТИЧНЫМ, и это нормально: 3 из подотчёта медсестры и 7 со
// склада — в одной выдаче. На КАЖДЫЙ источник пишется своё движение с общим
// reference_id, и отмена возвращает каждую часть туда, откуда она пришла.
// Прежний поиск «кто покрывает всё целиком» отправлял на склад и ту дозу,
// которую подотчёт покрывал наполовину.
//
// ОТКАЗ НАЗЫВАЕТ ВСЁ, ДО ЧЕГО ДОТЯНУЛАСЬ ЦЕПОЧКА. «insufficient stock» говорил
// про склад и молчал про то, что половина лежит у сотрудника на руках.
// =============================================================================

/**
 * Кабинет и отдел самого сотрудника. В сессии их нет — services/auth.js
 * sessionUser этих колонок не носит, поэтому читаем из users.
 */
function actorPlaces(db, user) {
  const id = user && Number(user.id);
  if (!isPositiveInt(id)) return { room_id: null, department_id: null };
  const row = db.prepare('SELECT room_id, department_id FROM users WHERE id = ?').get(id);
  if (!row) return { room_id: null, department_id: null };
  return {
    room_id: isPositiveInt(row.room_id) ? row.room_id : null,
    department_id: isPositiveInt(row.department_id) ? row.department_id : null,
  };
}

function deptOfRoom(db, roomId) {
  const r = db.prepare('SELECT department_id FROM rooms WHERE id = ?').get(roomId);
  return r && isPositiveInt(r.department_id) ? r.department_id : null;
}

function deptOfWard(db, wardId) {
  const w = db.prepare('SELECT department_id FROM wards WHERE id = ?').get(wardId);
  return w && isPositiveInt(w.department_id) ? w.department_id : null;
}

/**
 * Держатели этого списания ПО ПОРЯДКУ. `place` — { visit } или { admission };
 * чего в ней нет, того нет и в цепочке.
 */
export function holdingChain(db, user, place) {
  const chain = [];
  const seen = new Set();
  const push = (type, id) => {
    if (!isPositiveInt(id)) return;
    const key = `${type}:${id}`;
    if (seen.has(key)) return;
    seen.add(key);
    chain.push({ type, id });
  };
  const me = actorPlaces(db, user);
  const visit = place && place.visit;
  const adm = place && place.admission;

  push('staff', user && user.id);                                       // 1. свой подотчёт
  if (visit) push('room', visit.room_id);                               // 2. кабинет приёма
  push('room', me.room_id);                                             //    свой кабинет
  if (visit) push('department', deptOfRoom(db, visit.room_id));         // 3. отдел кабинета
  if (adm) push('department', deptOfWard(db, adm.ward_id));             //    отдел палаты
  push('department', me.department_id);                                 //    свой отдел
  return chain;
}

// =============================================================================
// OWN_SHELF_ONLY_V1 (2026-09-28) — СКЛАД КАК ИСТОЧНИК — ТОЛЬКО АДМИНИСТРАТОРУ И
// СКЛАДУ.
//
// Владелец: «in the doctor's cabinet or in the procedures, items should be
// dispensed from their shelf not from the procurement overall. Also in the
// stationary too.» Спросили, кому склад всё-таки оставить, — ответ: «Admin and
// warehouse only».
//
// ЧТО БЫЛО. Цепочка HOLDINGS_FIRST_V1 кончалась складом для ВСЕХ: врач и
// медсестра, у которых на полках пусто, молча выдавали пациенту со склада —
// мимо заявки, мимо кладовщика, и склад не знал, куда ушёл товар, пока не
// придёт инвентаризация. Экраны при этом показывали им общий остаток («Склад
// (общий остаток)», «Остаток: 90»), который им и не нужен.
//
// ЧТО СТАЛО. Склад остаётся последним звеном цепочки только у ролей «Склад» и
// «Администратор» (основной или дополнительной — hasAnyRole; своя роль клиники
// считается по основе, users.role). Все остальные — врач, главный врач,
// медсестра, старшая, лаборант, своя роль на их основе — выдают ТОЛЬКО со
// своих полок, и нехватка — отказ со словами «запросите у склада» ДО первой
// записи. Правило стоит ЗДЕСЬ, в planSources, а не у каждой двери: двери
// (кабинет, окно визита, процедуры, счёт визита, койка, история болезни,
// вкладка медсестры, лист назначений) передают только, КТО выдаёт, — и ни одна
// не может о правиле забыть. Не передала человека — склада нет (отказ закрыт,
// а не открыт).
//
// Ревью F5 (владелец 28.09) — ВСЁ ЭТО ТОЛЬКО ПРИ ВКЛЮЧЁННОМ ПЕРЕКЛЮЧАТЕЛЕ
// КЛИНИКИ «Только со своих полок» (мигр. 226, stock-policy.js), а он выключен,
// пока администратор его не включит: «Clinics keep working as today. The admin
// turns it on in settings once the warehouse has issued stock to rooms and
// nurses.» Выключен — цепочка кончается складом у всех, как в 3.12.1. Остаток
// склада врачу и медсестре не показывается при ЛЮБОМ положении (warehouseAccess
// .see — ответы дверей, holdings_list, отказ «Недостаточно»).
//
// Отмена выдачи правило не трогает: часть, пришедшая со склада (её выдал
// администратор или кладовщик), возвращается на склад, как и прежде.
// =============================================================================
export const WAREHOUSE_DISPENSE_ROLES = Object.freeze(['admin', 'inventory']);
export const OWN_SHELF_SHORT = 'own_shelf_short';

/** Кому склад — источник при ВКЛЮЧЁННОМ «только со своих полок» (роль). */
export function mayDispenseFromWarehouse(user) {
  return !!user && hasAnyRole(user, WAREHOUSE_DISPENSE_ROLES);
}

/**
 * Ревью F5 — ПЕРЕКЛЮЧАТЕЛЬ КЛИНИКИ «ТОЛЬКО СО СВОИХ ПОЛОК» (мигр. 226), и он
 * ВЫКЛЮЧЕН, пока администратор его не включит. Владелец: «Clinics keep working
 * as today. The admin turns it on in settings once the warehouse has issued
 * stock to rooms and nurses.» Выключенный — всё как в 3.12.1: своих полок не
 * хватило — добирает склад, у любого, кого дверь выдачи пускает. Таблицы нет
 * (база до 226, которую читает старый код) — выключен.
 */
export function ownShelfOnly(db) {
  try {
    const r = db.prepare('SELECT own_shelf_only FROM stock_settings WHERE id = 1').get();
    return !!(r && Number(r.own_shelf_only) === 1);
  } catch { return false; }
}

/**
 * Берёт ли этот человек со склада, выдавая пациенту: выключено — да (как в
 * 3.12.1), включено — только администратор и склад.
 */
export function mayTakeFromWarehouse(db, user) {
  return !ownShelfOnly(db) || mayDispenseFromWarehouse(user);
}

/**
 * Ревью M2 — СКЛАД И ЭТОТ ЧЕЛОВЕК: ОДИН ОТВЕТ НА ОБА ВОПРОСА.
 *   take — берёт ли он со склада, выдавая пациенту (planSources выше);
 *   see  — видит ли ЧИСЛО остатка склада (products.on_hand в реестре, ответы
 *          дверей выдачи; stock-log.js canSeeAllMovements — то же правило, что
 *          у журнала «вся клиника»).
 * Два вопроса решали два правила в двух местах, и своя роль на основе
 * администратора или склада с «Закупки: Нет» брала со склада, а число
 * получала пустым: экраны печатали «(остаток: null)», «склад 0» или прятали
 * склад, который сервер всё равно добирал. Теперь экран получает оба ответа
 * от сервера (holdings_list reachable) и обязан уметь «берёт, но числа не
 * видит»: такому — «есть на складе» / «нет на складе», без количества.
 */
export function warehouseAccess(db, user) {
  let see = false;
  try { see = !!user && canSeeAllMovements(db, user); } catch { see = false; }
  // Ревью F5 — «брать» зависит от переключателя клиники, «видеть число» — нет:
  // врачу и медсестре остаток склада не показывается при любом положении.
  return { take: mayTakeFromWarehouse(db, user), see, own_shelf_only: ownShelfOnly(db) };
}

/**
 * «Нет на ваших полках: Бинт — нужно 5 шт, есть 2 шт. Запросите у склада.»
 * `found` — всё, что цепочка нашла на своих полках (подотчёт, кабинет, отдел).
 * Шаблон — ключ словаря (server-message.js): узбекский экран слышит своё.
 * Код ответа `own_shelf_short` — по нему экран предлагает «Запросить у склада».
 */
function ownShelfRefusal(product, need, found, inUnits = false) {
  const cf = inUnits ? factorOf(product) : 1;
  const unit = (inUnits && cf !== 1 ? product.consumption_unit : '') || product.base_unit || product.unit || '';
  const num = (v) => String(cf !== 1 ? unitsOf(v, cf) : round2(v));
  const have = roundQty((found.staff || 0) + (found.room || 0) + (found.department || 0));
  const err = rpcT(RpcError, 'Нет на ваших полках: {name} — нужно {need}, есть {have}. Запросите у склада.', {
    name: product.name,
    need: `${num(need)} ${unit}`.trim(),
    have: `${num(have)} ${unit}`.trim(),
    // Ревью F4 — что и сколько запросить у склада: товар и нехватка в единице
    // заявки (единица расхода — та же, что в диалоге «Запросить у склада»).
    // В фразу они не подставляются: экран открывает заявку уже заполненной.
    product_id: product.id,
    request_qty: unitsOf(roundQty(Math.max(0, Number(need) - have)), factorOf(product)),
  }, 400);
  err.code = OWN_SHELF_SHORT;
  // Ревью M1 — товар ОТКЛЮЧЁН в каталоге. Двери выдачи отвечают так же
  // («запросите у склада»: остаток отключённого товара склад выдаёт на полку,
  // issue_stock_lines), а лист назначений по плану (§5) держит отключённый
  // товар предупреждением, а не отказом отметки — у всех, как у
  // администратора (treatment-orders.js chargeAdministration).
  if (!product.active) err.inactive = true;
  return err;
}

/**
 * Остаток склада в ответе двери выдачи — ЧИСЛОМ только тому, кто видит склад
 * (администратор, кладовщик, «Закупки»: stock-log.js canSeeAllMovements, то же
 * правило, что прячет products.on_hand в реестре). Врачу и медсестре — null:
 * ответ сервера виден во вкладке «Сеть» браузера, и спрятать число только на
 * экране значило бы его не спрятать.
 */
function warehouseOnHand(db, user, onHand) {
  return warehouseAccess(db, user).see ? onHand : null;   // ревью M2 — то же решение, что у экранов
}

/** Отказ, который называет и нехватку, и всё, что цепочка нашла по дороге. */
// V3120_FIX — `inUnits`: дверь, где человек считает в единице расхода
// (медсестра — таблетками), слышит отказ в таблетках, а не в долях пачки.
// Ревью F5 — `seesWarehouse`: число склада в отказе — только тому, кто видит
// склад (warehouseAccess.see). Переключатель выключен — врач и медсестра снова
// доходят до этого отказа (склад им добирает, как в 3.12.1), а остаток склада
// им не показывается при любом положении переключателя (просьба владельца):
// отказ звучит в тех же случаях, что в 3.12.1, только без числа склада.
function shortfallMessage(product, need, onHand, found, inUnits = false, seesWarehouse = true) {
  const cf = inUnits ? factorOf(product) : 1;
  const unit = (inUnits && cf !== 1 ? product.consumption_unit : '') || product.base_unit || product.unit || '';
  const num = (v) => String(cf !== 1 ? unitsOf(v, cf) : round2(v));
  const tail = [];
  if (found.staff > 0) tail.push(`у вас на руках ${num(found.staff)}`);
  if (found.room > 0) tail.push(`в кабинете ${num(found.room)}`);
  if (found.department > 0) tail.push(`в отделе ${num(found.department)}`);
  const head = seesWarehouse
    ? `Недостаточно: ${product.name} — на складе ${num(onHand)} из ${num(need)}${unit ? ` ${unit}` : ''}`
    : `Недостаточно: ${product.name} — нужно ${num(need)}${unit ? ` ${unit}` : ''}, на складе столько нет`;
  return `${head}; ${tail.length ? tail.join(', ') : 'на руках, в кабинете и в отделе — ничего'}.`;
}

/**
 * Сколько и откуда возьмётся — БЕЗ ЕДИНОЙ ЗАПИСИ. Не хватило нигде — 400 со
 * словами, и вызывающая транзакция не тронула ни остатка, ни строки счёта.
 * Количества — базовые единицы товара, как products.on_hand и stock_holdings.qty.
 *
 * opts: { inUnits?, user } — `user` это тот, КТО выдаёт: склад добирает
 * недостачу только администратору и складу (OWN_SHELF_ONLY_V1 выше).
 */
export function planSources(db, chain, product, quantity, opts = {}) {
  const q = db.prepare('SELECT qty FROM stock_holdings WHERE holder_type = ? AND holder_id = ? AND product_id = ?');
  const picks = [];
  const found = { staff: 0, room: 0, department: 0 };
  // STOCK_QTY_V1 (V3120_FIX) — было round2: таблетка из пачки по 30 (1/30 =
  // 0.0333…) списывалась как 0.03, и из тридцати выходила тридцать третья.
  const cf = factorOf(product);
  const tol = qtyTolerance(cf);
  let need = roundQty(quantity);
  for (const c of chain) {
    const row = q.get(c.type, c.id, product.id);
    const have = row && row.qty > 0 ? roundQty(row.qty) : 0;
    if (!have) continue;
    found[c.type] = roundQty(found[c.type] + have);
    if (need <= 0) continue;                    // дальше идём только чтобы отказ знал правду
    // «Последняя таблетка» в пределах допуска забирает ровно остаток.
    const take = need <= have + tol ? Math.min(have, need) : have;
    if (take <= 0) continue;
    picks.push({ type: c.type, id: c.id, qty: take });
    need = need <= have + tol ? 0 : roundQty(need - take);
  }
  if (need > 0) {
    // OWN_SHELF_ONLY_V1 — своих полок не хватило, а склад этому человеку не
    // источник: отказ «запросите у склада». Отключённый товар и пустой склад
    // его уже не касаются — склада в его цепочке нет вовсе.
    // Ревью F5 — только при ВКЛЮЧЁННОМ переключателе клиники; выключенный —
    // склад добирает, как в 3.12.1.
    if (!mayTakeFromWarehouse(db, opts.user)) throw ownShelfRefusal(product, quantity, found, !!opts.inUnits);
    const onHand = roundQty(product.on_hand);
    // V3120_FIX — ОТКЛЮЧЁННЫЙ ТОВАР, одно правило на все двери: уже выданное
    // (подотчёт, кабинет, отдел) довыдать можно — выше цепочка его и взяла;
    // СО СКЛАДА отключённый товар не выдаётся. Раньше dispense_item отказывал
    // целиком (даже когда доза лежала у медсестры на руках), а
    // dispense_from_holding разрешал — две двери отвечали по-разному.
    if (!product.active) {
      throw new RpcError(`Товар «${product.name}» отключён в каталоге: со склада не выдаётся`
        + `${picks.length ? ', а на руках, в кабинете и в отделе его не хватает' : ''}.`, 400);
    }
    if (!coversQty(onHand, need, cf)) {
      // Ревью F5 — число склада только тому, кто его видит; вызов без человека
      // (внутренний) — как прежде, с числом.
      const sees = opts.user === undefined ? true : warehouseAccess(db, opts.user).see;
      throw new RpcError(shortfallMessage(product, quantity, onHand, found, !!opts.inUnits, sees), 400);
    }
    picks.push({ type: WAREHOUSE, id: null, qty: Math.min(need, onHand) });
  }
  return picks;
}

/**
 * Списать запланированное и записать ПО ДВИЖЕНИЮ НА ИСТОЧНИК.
 * V3120_FIX — экспорт: амбулаторная дверь медсестры (holdings.js
 * dispense_from_holding) списывает ЭТОЙ ЖЕ функцией, а не своей копией.
 * `note` — подпись движения (дверь медсестры её пишет, остальные нет).
 */
export function applySources(db, picks, productId, user, refType, refId, note = null) {
  // V3120_FIX — себестоимость на движении расхода: без неё отчёт «Расход»
  // оценивал выданное с койки и из кабинета врача в ноль (у двери медсестры
  // она писалась всегда).
  const cost = db.prepare('SELECT avg_cost FROM products WHERE id = ?').get(productId);
  const unitCost = cost ? cost.avg_cost : null;
  for (const p of picks) {
    // V3120_FINAL (M1) — С ПОЛКИ УШЛО СТОЛЬКО, СКОЛЬКО УШЛО. Правило пыли
    // (settleQty) обнуляет остаток меньше допуска: на полке 1.0005, взяли 1 —
    // полка 0, а движение писало −1. Отмена (restoreSources) читает движения и
    // возвращала 1: 0.0005 пропадали при каждой такой выдаче. Теперь движение
    // (и сама часть — её видит ответ) несёт разницу «было − стало».
    const before = p.type === WAREHOUSE
      ? Number((db.prepare('SELECT on_hand FROM products WHERE id = ?').get(productId) || {}).on_hand) || 0
      : Number((db.prepare('SELECT qty FROM stock_holdings WHERE holder_type = ? AND holder_id = ? AND product_id = ?').get(p.type, p.id, productId) || {}).qty) || 0;
    const after = p.type === WAREHOUSE
      ? moveWarehouse(db, productId, -p.qty)
      : moveHolding(db, { type: p.type, id: p.id }, productId, -p.qty, user.id);   // STOCK_REQUEST_V1 — кто списал
    const taken = roundQty(before - after);
    if (taken > 0) p.qty = taken;
    db.prepare(`
      INSERT INTO stock_movements (product_id, kind, qty, unit_cost, reference_type, reference_id, note, created_by, holder_type, holder_id)
      VALUES (?, 'dispense', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(productId, -p.qty, unitCost, refType, refId, note || '', user.id, p.type === WAREHOUSE ? null : p.type, p.type === WAREHOUSE ? null : p.id);
  }
  return picks;
}

/**
 * Вернуть КАЖДУЮ часть туда, откуда она пришла: источники читаются из движений
 * этой строки, а не угадываются. Движений нет вовсе (строка старше журнала) —
 * возвращаем на склад, как делали раньше.
 */
// V3120_FINAL (M4) — держатель выключен: уволенный сотрудник, выключенный
// кабинет или отдел. Нет строки — тоже «выключен» (удалён).
function holderDisabled(db, type, id) {
  try {
    if (type === 'staff') {
      const u = db.prepare('SELECT is_active FROM users WHERE id = ?').get(id);
      return !u || Number(u.is_active) === 0;
    }
    const table = type === 'room' ? 'rooms' : type === 'department' ? 'departments' : null;
    if (!table) return false;
    const r = db.prepare(`SELECT active FROM ${table} WHERE id = ?`).get(id);
    return !r || Number(r.active) === 0;
  } catch { return false; }
}

export function restoreSources(db, refType, refId, productId, fallbackQty, user) {
  const rows = db.prepare(`
    SELECT holder_type, holder_id, qty, unit_cost FROM stock_movements
     WHERE reference_type = ? AND reference_id = ? AND kind = 'dispense'
     ORDER BY id
  `).all(refType, refId);
  // STOCK_QTY_V1 (V3120_FIX) — возвращается ровно записанное (шесть знаков),
  // а не round2 от него: иначе отмена таблетки из пачки по 30 возвращала 0.03.
  const parts = rows.length
    ? rows.map((r) => ({ type: r.holder_type || WAREHOUSE, id: r.holder_type ? r.holder_id : null, qty: roundQty(-r.qty), unit_cost: r.unit_cost }))
    : (roundQty(fallbackQty) > 0 ? [{ type: WAREHOUSE, id: null, qty: roundQty(fallbackQty), unit_cost: null }] : []);
  for (const p of parts) {
    // V3120_FINAL (M4) — ПОЛКА ОТКЛЮЧЁННОГО НЕ ПРИНИМАЕТ ВОЗВРАТ. Сотрудник
    // уволен (или кабинет / отдел выключен) — его подотчёт сдан или передан, и
    // возврат на его полку повесил бы товар на того, кого в клинике нет: ни
    // выдать его, ни увидеть «Мои запасы». Такая часть идёт на склад, и
    // журнал это называет.
    let note = '';
    if (p.type !== WAREHOUSE && holderDisabled(db, p.type, p.id)) {
      note = `возврат на склад: ${p.type === 'staff' ? 'сотрудник' : p.type === 'room' ? 'кабинет' : 'отдел'} отключён`;
      p.type = WAREHOUSE; p.id = null;
    }
    if (p.type === WAREHOUSE) {
      moveWarehouse(db, productId, p.qty);
    } else {
      moveHolding(db, { type: p.type, id: p.id }, productId, p.qty);
    }
    db.prepare(`
      INSERT INTO stock_movements (product_id, kind, qty, unit_cost, reference_type, reference_id, note, created_by, holder_type, holder_id)
      VALUES (?, 'void', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(productId, p.qty, p.unit_cost == null ? null : p.unit_cost, refType, refId, note, user.id, p.type === WAREHOUSE ? null : p.type, p.type === WAREHOUSE ? null : p.id);
    delete p.unit_cost;
  }
  return parts;
}

export function receiveStock(db, args, user) {
  requireRole(user, RECEIVE_ROLES);

  const productId = args && args.product_id;
  if (!isPositiveInt(productId)) {
    throw new RpcError('Товар не выбран.', 400);
  }
  const quantity = args && args.quantity;
  requireQuantity(quantity);
  const unitCost = args && args.unit_cost;
  const unitCostValue = typeof unitCost === 'number' && Number.isFinite(unitCost) ? unitCost : null;
  // SUPPLIERS_VAT_V1 (ревью M7) — тот же потолок цены, что у «Принять товар».
  if (unitCostValue !== null && unitCostValue > 1e12) {
    throw new RpcError('Цена за единицу — неотрицательное число.', 400);
  }
  const note = (args && args.note) || '';

  const run = db.transaction(() => {
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
    if (!product) {
      throw new RpcError('Товар не найден.', 400);
    }

    // With the MAX_QTY cap this can't overflow, but assert anyway — belt and braces.
    const next = roundQty(product.on_hand + quantity);
    if (!Number.isFinite(next)) {
      throw new RpcError('Остаток вне допустимого диапазона.', 400);
    }

    db.prepare(`
      UPDATE products
      SET on_hand = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
      WHERE id = ?
    `).run(next, productId);

    db.prepare(`
      INSERT INTO stock_movements (product_id, kind, qty, unit_cost, reference_type, note, created_by)
      VALUES (?, 'receive', ?, ?, 'manual', ?, ?)
    `).run(productId, roundQty(quantity), unitCostValue, note, user.id);

    const fresh = db.prepare('SELECT on_hand FROM products WHERE id = ?').get(productId);
    return { product_id: productId, on_hand: fresh.on_hand };
  });

  return run();
}

export function dispenseItem(db, args, user) {
  requireRole(user, DISPENSE_ROLES);

  const productId = args && args.product_id;
  if (!isPositiveInt(productId)) {
    throw new RpcError('Товар не выбран.', 400);
  }
  const quantity = args && args.quantity;
  requireQuantity(quantity);
  requireStoredQty(quantity);   // V3120_FINAL (M3)
  const visitId = optPosInt(args && args.visit_id, 'visit_id');
  const doctorId = optPosInt(args && args.doctor_id, 'doctor_id');

  const run = db.transaction(() => {
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
    if (!product) {
      throw new RpcError('Товар не найден.', 400);
    }
    // V3120_FIX — отключённый товар больше не отказывается здесь целиком: из
    // подотчёта его довыдать можно, со склада — нет (planSources).
    let visit = null;
    if (visitId != null) {
      visit = db.prepare('SELECT * FROM visits WHERE id = ?').get(visitId);
      if (!visit) {
        throw new RpcError('Визит не найден.', 400);
      }
    }

    // HOLDINGS_FIRST_V1 — свой подотчёт → кабинет приёма → отдел → склад.
    // Отказ (нигде не хватило) звучит ДО первой записи: транзакция уходит
    // назад нетронутой, как и при прежней проверке остатка.
    // OWN_SHELF_ONLY_V1 — склад в конце цепочки только у администратора и склада.
    const picks = planSources(db, holdingChain(db, user, { visit }), product, quantity, { user });
    // EXPIRY_BALANCE_V1 — партия смотрится ДО списания: тревожит та, которую
    // возьмут сейчас. Предупреждение проверяет ТОВАР, а не источник: партии у
    // подотчёта не записаны, но просроченная коробка стоит в клинике одна и та
    // же, из чьих бы рук её ни взяли.
    const warnings = expiryWarnings(db, [productId]);

    let visitServiceId = null;
    if (visit) {
      // Цена и строка визита — БЕЗ ИЗМЕНЕНИЙ: откуда взят товар, на счёт не влияет.
      const unitPrice = product.sale_price;
      const total = round2(unitPrice * quantity);
      const info = db.prepare(`
        INSERT INTO visit_services (visit_id, clinic_item_id, service_id, doctor_id, quantity, unit_price, total, status, created_by)
        VALUES (?, ?, NULL, ?, ?, ?, ?, 'added', ?)
      `).run(visitId, productId, doctorId, quantity, unitPrice, total, user.id);
      visitServiceId = info.lastInsertRowid;
    }

    applySources(db, picks, productId, user, visitId != null ? 'visit' : 'manual', visitServiceId);

    const fresh = db.prepare('SELECT on_hand FROM products WHERE id = ?').get(productId);
    return { product_id: productId, item_name: product.name, on_hand: warehouseOnHand(db, user, fresh.on_hand), visit_service_id: visitServiceId, sources: picks, warnings };
  });

  return run();
}

export function voidDispense(db, args, user) {
  requireRole(user, VOID_ROLES);

  const visitServiceId = args && args.visit_service_id;
  if (!isPositiveInt(visitServiceId)) {
    throw new RpcError('Строка визита не выбрана.', 400);
  }

  const run = db.transaction(() => {
    const line = db.prepare('SELECT * FROM visit_services WHERE id = ?').get(visitServiceId);
    if (!line) {
      throw new RpcError('Строка не найдена.', 400);
    }
    // BRANCH_MONEY_GUARD_V1 — чужую строку отсюда не отменяют. Сегодня сюда не
    // доедет ни одна ВЫДАННАЯ строка (clinic_item_id — местная ссылка, она не
    // ездит, и проверка ниже отвергла бы такую строку как «не выдача»), но
    // запрет стоит там, где стоит DELETE, а не там, где сегодня о нём известно:
    // удаление строки визита чеканит надгробие (миграция 084), и оно стёрло бы
    // строку у соседа. Ту же цену уже заплатили один раз в billing.js
    // (remove_unpaid_service) — второй раз платить незачем.
    assertOwnBuilding(db, line, 'Услуга');
    if (line.clinic_item_id == null) {
      throw new RpcError('Это не выдача товара.', 400);
    }
    if (line.invoice_item_id != null) {
      throw new RpcError('Строка уже в счёте — сначала уберите её из счёта.', 400);
    }

    // HOLDINGS_FIRST_V1 — возврат ИДЁТ ПО ИСТОЧНИКАМ, а не на склад скопом.
    // Раньше отсюда всё возвращалось на склад, и отмена выдачи из подотчёта
    // дарила складу чужой товар: у медсестры на руках его не прибавлялось, а
    // на складе прибавлялось. Разбитая на два источника выдача возвращается
    // двумя частями — каждая своему держателю.
    const parts = restoreSources(db, 'visit', visitServiceId, line.clinic_item_id, line.quantity, user);

    db.prepare('DELETE FROM visit_services WHERE id = ?').run(visitServiceId);

    const fresh = db.prepare('SELECT on_hand FROM products WHERE id = ?').get(line.clinic_item_id);
    if (!fresh) {
      throw new RpcError('Товар не найден.', 400);
    }
    return { product_id: line.clinic_item_id, on_hand: warehouseOnHand(db, user, fresh.on_hand), sources: parts };   // OWN_SHELF_ONLY_V1
  });

  return run();
}

// =============================================================================
// BED_CONSOLE_V1 — стационарная выдача препаратов (easymed's
// dispense_admission_item / void_dispensed_admission_item). Атомарно:
// остаток товара + строка admission_services (+ журнал движений).
// =============================================================================
export function dispenseAdmissionItem(db, args, user) {
  requireRole(user, DISPENSE_ROLES);
  return dispenseAdmissionItemCore(db, args, user);
}

// MED_ADMIN_CHARGE_V1 — ТО ЖЕ САМОЕ, но без вопроса о роли.
//
// Существует ради одного вызывающего: отметки медсестры о введении дозы
// (rpc/treatment-orders.js, Задача 6). Списание там уже разрешено — но ДРУГИМ
// списком ролей: дозу отмечает медсестра или старшая, снимает отметку только
// старшая, и оба списка живут в листе назначений, где они и решаются. Спроси
// мы здесь ещё и DISPENSE_ROLES/VOID_ROLES — на один вопрос было бы два
// ответа, и старшая медсестра, которой лист назначений снять отметку разрешил,
// получила бы 403 от склада на полпути, оставив дозу снятой, а деньги на месте.
//
// Второй экземпляр движения товара при этом НЕ заводится, и в этом весь смысл
// такой разделки: остаток, строка admission_services и запись в
// stock_movements пишутся ровно тем же кодом, что и у койки. Своя копия
// разъехалась бы с этой в мелочах (знак qty, reference_type, цена из
// каталога), и нашлось бы это при сверке склада, через месяц.
//
// HOLDINGS_FIRST_V1 — откуда берётся доза у койки, решает ОДНА цепочка
// (holdingChain выше), общая с амбулаторией, и решает её ВСЕГДА: флага
// prefer_holdings больше нет. Он был опцией, и шесть дверей из восьми её не
// знали — именно поэтому выданное в палату списывалось со склада второй раз.
// Прежнее «только держатель, который покрывает дозу целиком» тоже ушло:
// покрытие бывает частичным.
//
// V3120_FIX — `unit: 'consumption'`: количество прислано в ЕДИНИЦАХ РАСХОДА
// (ампулах, таблетках), как у двери медсестры (holdings.js
// dispenseFromHolding). Склад списывает базовые (1 амп из коробки по 10 =
// 0.1 коробки), а строка счёта пишется в ампулах по цене ампулы: «1 × 5 000»,
// а не «0.1 × 50 000». Так зовёт лист назначений; без флага — базовые, как
// всегда (консоль койки).
export function dispenseAdmissionItemCore(db, args, user) {
  const admissionId = args && args.admission_id;
  if (!isPositiveInt(admissionId)) throw new RpcError('Госпитализация не выбрана.', 400);
  const productId = args && args.product_id;
  if (!isPositiveInt(productId)) throw new RpcError('Товар не выбран.', 400);
  const quantity = args && args.quantity;
  requireQuantity(quantity);
  const inUnits = !!(args && args.unit === 'consumption');
  const doctorId = optPosInt(args && args.doctor_id, 'doctor_id');
  // BED_CONSOLE_V2 — «Выставить в счёт пациенту»: по умолчанию true (совместимо
  // со старым admission-modal); консоль передаёт явный выбор из чекбокса.
  const billable = (args && args.billable !== undefined) ? !!args.billable : true;
  const note = (args && typeof args.note === 'string' ? args.note.trim().slice(0, 300) : '') || null;

  const run = db.transaction(() => {
    // INPATIENT_FLOW_V1 — было `adm.status !== 'active'`, и это ПРАВИЛО
    // СОХРАНЕНО ДОСЛОВНО: выдать препарат можно, только когда лечение
    // действительно началось, а закрытой (выписанной или отменённой)
    // госпитализации — нельзя вовсе. Изменилось одно: отказ теперь называет
    // недостающий шаг («Пациент ещё не осмотрен главным врачом») вместо
    // «admission is not active», и то же самое правило спрашивают все
    // остальные задачи маршрута — одной функцией, а не своей копией.
    //
    // Здесь именно assertAdmissionAtLeast, а НЕ assertCanPrescribe: препарат у
    // койки выдаёт медсестра, и она не лечащий врач. Кому можно выдавать,
    // решает вызывающий (DISPENSE_ROLES у консоли койки, MARK_ROLES у листа
    // назначений); эта строка отвечает только на вопрос «дошёл ли пациент до
    // лечения».
    const adm = assertAdmissionAtLeast(db, admissionId, 'active');
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
    if (!product) throw new RpcError('Товар не найден.', 400);
    // V3120_FIX — отключённый товар: из подотчёта можно, со склада нет (planSources).

    const cf = inUnits ? factorOf(product) : 1;
    const baseQty = inUnits ? toBase(quantity, cf) : quantity;
    requireStoredQty(baseQty);   // V3120_FINAL (M3) — было `> 0`: 1e-7 проходило, списания не было

    // HOLDINGS_FIRST_V1 — свой подотчёт → свой кабинет → отдел палаты → свой
    // отдел → склад. Не хватило нигде — отказ со словами, до первой записи.
    // OWN_SHELF_ONLY_V1 — склад только администратору и складу; медсестре,
    // отмечающей дозу в листе назначений, — тоже только свои полки.
    const picks = planSources(db, holdingChain(db, user, { admission: adm }), product, baseQty, { inUnits, user });
    // EXPIRY_BALANCE_V1 — та же тревога у койки, что и в амбулатории.
    const warnings = expiryWarnings(db, [productId]);

    // Строка счёта: цена из каталога (за единицу расхода — если количество в
    // ней), billable как прислали.
    const unitPrice = inUnits ? round2(Number(product.sale_price) / cf) : product.sale_price;
    const total = round2(unitPrice * quantity);
    const info = db.prepare(`
      INSERT INTO admission_services (admission_id, clinic_item_id, service_id, doctor_id, bed_id, ward_id, quantity, unit_price, total, status, billable, notes, performed_at)
      VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, 'added', ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    `).run(admissionId, productId, doctorId, adm.bed_id, adm.ward_id, quantity, unitPrice, total, billable ? 1 : 0, note);

    applySources(db, picks, productId, user, 'admission', info.lastInsertRowid);

    const fresh = db.prepare('SELECT on_hand FROM products WHERE id = ?').get(productId);
    return { line_id: info.lastInsertRowid, item_name: product.name, on_hand: warehouseOnHand(db, user, fresh.on_hand), sources: picks, warnings };
  });
  return run();
}

export function voidDispensedAdmissionItem(db, args, user) {
  requireRole(user, VOID_ROLES);
  return voidDispensedAdmissionItemCore(db, args, user);
}

// MED_ADMIN_CHARGE_V1 — возврат без вопроса о роли; парная к
// dispenseAdmissionItemCore и заведена по той же причине (см. её комментарий).
// Снятие отметки о введении делает СТАРШАЯ МЕДСЕСТРА, а её нет в VOID_ROLES —
// и не должно быть: чужую выдачу у койки она не отменяет.
export function voidDispensedAdmissionItemCore(db, args, user) {
  const lineId = args && args.line_id;
  if (!isPositiveInt(lineId)) throw new RpcError('Строка не выбрана.', 400);

  const run = db.transaction(() => {
    const line = db.prepare('SELECT * FROM admission_services WHERE id = ?').get(lineId);
    if (!line) throw new RpcError('Строка не найдена.', 400);
    if (line.clinic_item_id == null) throw new RpcError('Это не выдача товара.', 400);
    if (line.invoice_item_id != null) throw new RpcError('Строка уже в счёте — сначала уберите её из счёта.', 400);


    // HOLDINGS_FIRST_V1 — каждая часть возвращается СВОЕМУ источнику: движения
    // этой строки называют их все, а не только последний.
    const parts = restoreSources(db, 'admission', lineId, line.clinic_item_id, line.quantity, user);
    db.prepare('DELETE FROM admission_services WHERE id = ?').run(lineId);

    const fresh = db.prepare('SELECT on_hand FROM products WHERE id = ?').get(line.clinic_item_id);
    return { product_id: line.clinic_item_id, on_hand: fresh ? warehouseOnHand(db, user, fresh.on_hand) : null, sources: parts };   // OWN_SHELF_ONLY_V1
  });
  return run();
}
