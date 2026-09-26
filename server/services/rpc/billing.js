// Server-side billing RPCs. All money math (subtotals, balances, statuses)
// is computed here from DB rows — client-supplied amounts are never trusted.
// Both handlers run their DB work inside db.transaction(...)() for atomicity.

import { ensureOpenShift } from './cashier.js';   // SHIFT_AUTO_V2
// CRM_REAL_BOOKING_V1 — платёж на кассе это доказательство, что пациент
// здесь: заочно деньги у окна не появляются. См. шапку crm/visit-status.js.
import { crmInvoiceEvidence, crmVisitEvidence } from '../crm/visit-status.js';
import { invoiceStatusFor } from '../domain/money.js';
// PAY_BASIS_PERFORMED_V1 — «what will the invoice charge for this line» is one
// function, shared with the doctor's pay (rpc/reports.js): own price over the
// catalog, and VISIT_TIER_PRICING_V1 — a line quoted as a second/repeat visit
// keeps that price at the till (the catalog price is the FIRST visit's price).
import { lineUnitPrice } from '../domain/pricing.js';
import { hasAnyRole } from '../roles.js';
import { localDate } from '../domain/day.js';
// HOLDINGS_FIRST_V1 — «вернуть КАЖДУЮ часть туда, откуда она пришла» живёт в
// одном месте на весь сервер (rpc/inventory.js): подотчёт сотрудника, кабинет,
// отдел, склад. Кольцо импортов здесь такое же, как у billing ↔ cashier строкой
// выше, и по той же причине: обе стороны — объявленные функции, ни одна не
// зовётся при загрузке модуля.
import { restoreSources } from './inventory.js';

export class RpcError extends Error {
  constructor(msg, status = 400) {
    super(msg);
    this.status = status;
  }
}

const CREATE_INVOICE_ROLES = ['admin', 'registrar', 'cashier'];
const PAYMENT_ROLES = ['admin', 'cashier'];
// DEPOSIT_REVENUE_V1 — 'wallet' — оплата с депозитного баланса пациента. Это
// НЕ приход денег: они пришли раньше, когда касса приняла депозит. Способ
// исключён из выручки и из итога смены (см. shared/payment-methods.js).
const PAYMENT_METHODS = ['cash', 'card', 'transfer', 'acquiring', 'wallet'];   // CASHIER_DESIGN_V2 — эквайринг (Payme/Click terminal)

function requireRole(user, allowed) {
  // MULTI_ROLE_SERVER_V1 — extras count too, not the primary role alone.
  if (!hasAnyRole(user, allowed)) {
    throw new RpcError('Your role is not allowed to perform this action.', 403);
  }
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function isPositiveInt(v) {
  return Number.isInteger(v) && v > 0;
}

// BRANCH_MONEY_NUMBER_V1 — буква ЭТОГО здания, та же, что стоит в номере карты
// пациента (миграция 080). Читается из branch_identity — одной строки, которая
// отвечает на вопрос «какое здание эта установка».
//
// ОТКАЗ, А НЕ МОЛЧАЛИВЫЙ ЗАПАСНОЙ ВАРИАНТ. Выписать номер без буквы значило бы
// вернуться к 'INV-26-00001' — тому самому номеру, который в этот же день
// чеканит соседнее здание; приехав туда, счёт был бы отвергнут UNIQUE-индексом
// и потерян молча, а обнаружилось бы это не здесь, а в чужом отчёте. То же
// решение и по той же причине принял триггер MRN в 080: он РАЗБИРАЕТ
// регистрацию пациента ('branch identity missing'), а не выдаёт карту без
// номера. Строка branch_identity создаётся миграцией 080 и есть у любой
// клиники; её отсутствие — не «старая база», а поломка, и говорить о ней надо
// вслух.
export function branchLetter(db) {
  const row = db.prepare('SELECT letter FROM branch_identity WHERE id = 1').get();
  const letter = row && row.letter ? String(row.letter).toUpperCase() : '';
  if (!/^[A-Z]{1,8}$/.test(letter)) {
    throw new RpcError(
      'Здание не определено: у этой установки нет буквы филиала. Без неё номер счёта'
      + ' совпал бы с номером соседнего здания. Обратитесь в поддержку.', 500);
  }
  return letter;
}

// INV-<буква здания>-<2-digit year>-<5-digit seq>, seq scoped to the current
// year via a dedicated per-year counter table (invoice_counters). This is
// monotonic even if invoices are later deleted or a number is otherwise
// skipped — unlike COUNT(*)+1, which would reuse a number after a deletion.
//
// БУКВА (миграция 088): счета теперь ездят между зданиями, а invoice_number
// объявлен UNIQUE. Два здания со своими счётчиками чеканят один и тот же
// 'INV-26-00001', и приехавший счёт соседа база отвергла бы навсегда. Старые
// номера не переписываются — они на чеках и в бумагах; буква появляется только
// у выданных с этого дня, а нумерация продолжается с того же места.
export function nextInvoiceNumber(db) {
  const year4 = db.prepare("SELECT strftime('%Y','now') AS y").get().y; // e.g. '2026'
  const yy = year4.slice(-2);
  const letter = branchLetter(db);
  db.prepare('INSERT INTO invoice_counters (year, next_seq) VALUES (?, 1) ON CONFLICT(year) DO NOTHING').run(year4);
  const seq = db.prepare('SELECT next_seq FROM invoice_counters WHERE year = ?').get(year4).next_seq;
  db.prepare('UPDATE invoice_counters SET next_seq = next_seq + 1 WHERE year = ?').run(year4);
  return `INV-${letter}-${yy}-${String(seq).padStart(5, '0')}`;
}

// BRANCH_MONEY_GUARD_V1 — ЧУЖИЕ ДЕНЬГИ ТОЛЬКО ДЛЯ ЧТЕНИЯ, и решается это на
// сервере, а не на экране.
//
// С миграции 087 счета, позиции и платежи ездят между зданиями, и в главной
// клинике теперь лежат строки филиала. Их видно — за этим они и едут, — но
// править их отсюда нельзя ни одним способом: сумма, статус и платежи чужого
// счёта живут в том здании, где стоит касса, которая эти деньги взяла. Приняв
// оплату по чужому счёту здесь, клиника получила бы две несовместимые правды об
// одной сумме, а удалив его — стёрла бы работу соседнего здания (тот же исход,
// что описан в f9615ab для строки визита).
//
// Экран кассы это уже запрещает (visit-bill.js, f9615ab), но экран — не
// граница: RPC вызывается по invoice_id, и запрет обязан стоять там, где
// пишется строка.
//
// Филиал НАЗЫВАЕТСЯ теми же словами, что и метки в списках: имя из справочника
// филиалов, если оно приехало, иначе одна буква.
function branchName(db, letter) {
  const tag = String(letter || '').toUpperCase();
  try {
    const row = db.prepare('SELECT name FROM branches WHERE letter = ? COLLATE NOCASE').get(tag);
    if (row && row.name) return `${row.name} (${tag})`;
  } catch { /* справочник филиалов ещё не приехал — хватит буквы */ }
  return tag || 'другого здания';
}

// row — любая строка с колонкой sync_origin (invoices, payments, invoice_items,
// visits, visit_services). what — о чём речь, в родительном падеже.
export function assertOwnBuilding(db, row, what) {
  if (!row || row.sync_origin == null) return;
  throw new RpcError(
    `${what} из филиала ${branchName(db, row.sync_origin)} — изменить его можно только там.`, 403);
}

/**
 * CATEGORY_DISCOUNT_V1 — процент скидки, закреплённый за категорией пациента.
 *
 * Связь по КЛЮЧУ (`patients.category_id`, миграция 107): переименование
 * категории не рассыпает связь, и сравнивать строки не приходится.
 *
 * Только ДЕЙСТВУЮЩИЕ категории: снятая с учёта категория перестаёт давать
 * скидку — иначе «выключить» её было бы нечем, кроме удаления.
 *
 * Возвращает 0 при любой неопределённости: нет пациента, категория не выбрана,
 * строка справочника удалена, испорченное число. Скидка, взятая из ничего, —
 * это молча потерянные деньги клиники.
 */
export function patientCategoryDiscount(db, patientId) {
  if (!isPositiveInt(patientId)) return 0;
  const cat = db.prepare(
    'SELECT c.discount_percent FROM patients p'
    + ' JOIN patient_categories c ON c.id = p.category_id AND c.active = 1'
    + ' WHERE p.id = ?'
  ).get(patientId);
  const pct = cat ? Number(cat.discount_percent) : 0;
  if (!Number.isFinite(pct) || pct <= 0) return 0;
  // Скидка больше ста процентов — это не подарок, а испорченная строка
  // справочника; счёт от неё не должен уходить в минус.
  return Math.min(pct, 100);
}

// ДД.ММ.ГГГГ для текста отказа — владелец читает даты так.
function ruDay(ymd) {
  const s = String(ymd || '');
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(8, 10) + '.' + s.slice(5, 7) + '.' + s.slice(0, 4) : s;
}

/**
 * PACKAGES_V1 — пакет строки визита, проверенный на ЭТОМ визите.
 *
 * Срок пакета — окно ПРЕДЛОЖЕНИЯ (решение владельца 26.09): пакет, выбранный
 * при регистрации, выставляется со своей скидкой только если местный день
 * визита лежит в [valid_from, valid_until] (границы включительно, пустая —
 * без ограничения). Окно выбора на экране показывает только действующие
 * пакеты, но экран — не граница: проверка стоит здесь, где пишутся деньги.
 *
 * Услуга строки обязана входить в пакет — иначе пометка пакета дала бы его
 * скидку любой услуге. Снятый с учёта (active = 0) пакет не отказывает:
 * строка могла быть заведена, пока он был в списке, и снятие — это «больше не
 * предлагать», а не «отменить обещанное пациенту».
 *
 * Возвращает {id, name, pct} или null (у строки пакета нет / пакет удалён).
 */
function linePackage(db, row, visitDay, cache) {
  if (row.package_id == null) return null;
  let pkg = cache.get(row.package_id);
  if (pkg === undefined) {
    pkg = db.prepare('SELECT id, name, service_ids, discount_percent, valid_from, valid_until FROM service_templates WHERE id = ?')
      .get(row.package_id) || null;
    cache.set(row.package_id, pkg);
  }
  if (!pkg) return null;
  if ((pkg.valid_from && visitDay < pkg.valid_from) || (pkg.valid_until && visitDay > pkg.valid_until)) {
    const window = pkg.valid_from && pkg.valid_until ? `с ${ruDay(pkg.valid_from)} по ${ruDay(pkg.valid_until)}`
      : pkg.valid_from ? `с ${ruDay(pkg.valid_from)}` : `по ${ruDay(pkg.valid_until)}`;
    throw new RpcError(`Пакет «${pkg.name}» действует ${window}, а визит — ${ruDay(visitDay)}. `
      + 'Уберите услуги пакета из визита или выберите действующий пакет.', 400);
  }
  let ids = [];
  try { ids = JSON.parse(pkg.service_ids || '[]'); } catch { ids = []; }
  if (!Array.isArray(ids) || !ids.some((id) => Number(id) === Number(row.service_id))) {
    throw new RpcError(`Услуга строки ${row.id} не входит в пакет «${pkg.name}» — скидку пакета на неё дать нельзя.`, 400);
  }
  const pct = Number(pkg.discount_percent);
  return { id: pkg.id, name: pkg.name, pct: Number.isFinite(pct) ? Math.min(Math.max(pct, 0), 100) : 0 };
}

/**
 * PACKAGES_V1 (ревью I-3) — ОТКАЗ В МИГ, КОГДА НА СТРОКУ СТАВЯТ ПАКЕТ.
 *
 * Счёт по визиту отказывает целиком, если пакет строки не действует в местный
 * день визита (linePackage). Узнавать об этом у кассы — поздно: строка уже
 * записана, пациент ушёл от стойки. Поэтому то же правило проверяется при
 * заведении строки (routes/db.js, единственная дверь visit_services): визит
 * известен, день известен. Возвращает текст отказа или null.
 *
 * Правило одно — linePackage; здесь только собран его вход.
 */
export function packageStampRefusal(db, rows) {
  const list = (Array.isArray(rows) ? rows : [rows]).filter((r) => r && r.package_id != null && r.package_id !== '');
  if (!list.length) return null;
  const cache = new Map();
  const days = new Map();
  for (const r of list) {
    const visitId = Number(r.visit_id);
    if (!Number.isFinite(visitId)) continue;
    if (!days.has(visitId)) {
      const v = db.prepare('SELECT visit_date FROM visits WHERE id = ?').get(visitId);
      days.set(visitId, v ? db.prepare(`SELECT ${localDate('?')} AS d`).get(v.visit_date).d : null);
    }
    const day = days.get(visitId);
    if (!day) continue;   // визита нет — ответит внешний ключ
    try {
      linePackage(db, { id: '—', service_id: r.service_id, package_id: Number(r.package_id) }, day, cache);
    } catch (e) {
      if (e instanceof RpcError) return e.message.replace('Услуга строки — не входит', 'Услуга не входит');
      throw e;
    }
  }
  return null;
}

export function createInvoiceForVisit(db, args, user) {
  requireRole(user, CREATE_INVOICE_ROLES);

  const visitId = args && args.visit_id;
  if (!isPositiveInt(visitId)) {
    throw new RpcError('visit_id must be a positive integer.', 400);
  }
  const visit = db.prepare('SELECT * FROM visits WHERE id = ?').get(visitId);
  if (!visit) {
    throw new RpcError('visit not found.', 400);
  }
  // BRANCH_MONEY_GUARD_V1 — счёт по визиту выставляют там, где визит сделан.
  // Здесь это тем важнее, что счёт СОСЕДА по этому визиту сюда уже приехал (087)
  // и второй счёт был бы вторым требованием денег за одну и ту же работу.
  assertOwnBuilding(db, visit, 'Визит');

  const ids = args && args.visit_service_ids;
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every(isPositiveInt)) {
    throw new RpcError('No services selected: visit_service_ids must be a non-empty array of integers.', 400);
  }
  if (new Set(ids).size !== ids.length) {
    throw new RpcError('visit_service_ids contains duplicates.', 400);
  }

  const run = db.transaction(() => {
    const rows = [];
    for (const id of ids) {
      const row = db.prepare('SELECT * FROM visit_services WHERE id = ?').get(id);
      if (!row) {
        throw new RpcError(`visit_service ${id} not found.`, 400);
      }
      if (row.visit_id !== visitId) {
        throw new RpcError(`visit_service ${id} belongs to another visit (visit mismatch).`, 400);
      }
      if (row.invoice_item_id !== null) {
        throw new RpcError(`visit_service ${id} is already invoiced.`, 400);
      }
      rows.push(row);
    }

    // The CATALOG is authoritative for a real service or a dispensed product —
    // never the client-supplied unit_price — except that a performing doctor
    // with their own price for that service overrides the catalog
    // (DOCTOR_OWN_PRICE_V1, see domain/pricing.js). A line with neither a
    // service nor a product (ad-hoc) keeps its stored price.
    const getService = db.prepare('SELECT price, name, price_secondary, secondary_days_from, secondary_days_to, price_repeat, repeat_days_from, repeat_days_to FROM services WHERE id = ?');
    const getProduct = db.prepare('SELECT sale_price, name FROM products WHERE id = ?');
    // PACKAGES_V1 — местный день визита: по нему проверяется срок пакета.
    const visitDay = db.prepare(`SELECT ${localDate('?')} AS d`).get(visit.visit_date).d;
    const packages = new Map();
    const priced = rows.map((row) => {
      let svcName = null;
      let svc = null, prod = null;
      if (row.service_id != null) {
        svc = getService.get(row.service_id);
        if (!svc) {
          throw new RpcError(`service ${row.service_id} not found`, 400);
        }
        svcName = svc.name;
      } else if (row.clinic_item_id != null) {
        prod = getProduct.get(row.clinic_item_id);
        if (!prod) {
          throw new RpcError(`product ${row.clinic_item_id} not found`, 400);
        }
        svcName = prod.name;
      }
      // PAY_BASIS_PERFORMED_V1 — the price rule lives in ONE place
      // (domain/pricing.js lineUnitPrice): the doctor's own price over the
      // catalog, then VISIT_TIER_PRICING_V1 — the tier recorded on the line
      // wins over both (those are first-visit prices, and this visit was quoted
      // as the second or a repeat). The doctor's pay for a performed line that
      // is not invoiced yet reads the same function, so issuing the invoice
      // never moves the doctor's share.
      const unit = lineUnitPrice(db, row, { service: svc, product: prod });
      const qty = row.quantity;
      if (!(Number.isFinite(qty) && qty > 0)) {
        throw new RpcError(`invalid quantity on visit_service ${row.id}`, 400);
      }
      const line = round2(unit * qty);
      const pkg = linePackage(db, row, visitDay, packages);
      return { row, unit, qty, line, svcName, pkg };
    });

    const subtotal = round2(priced.reduce((sum, p) => sum + p.line, 0));
    // WIZARD_DISCOUNT_V1 — optional booking-time discount (loyalty % / promo
    // code, computed by the visit wizard). Clamped to [0, subtotal] so a
    // client can never produce a negative invoice.
    const discountRaw = (args && args.discount_amount !== undefined) ? args.discount_amount : 0;
    if (!(typeof discountRaw === 'number' && Number.isFinite(discountRaw) && discountRaw >= 0)) {
      throw new RpcError('discount_amount must be a non-negative number.', 400);
    }
    // CATEGORY_DISCOUNT_V1 (2026-09-06) — СКИДКА ГРУППЫ СЧИТАЕТСЯ ЗДЕСЬ, НА
    // СЕРВЕРЕ, А НЕ ПРИСЫЛАЕТСЯ БРАУЗЕРОМ.
    //
    // Владелец: «when patient selected with the category discount should be
    // applied». «Применяется сама» и «её присылает экран» — разные вещи: во
    // втором случае скидка зависит от того, какая страница открыта у кассира и
    // не устарела ли она, а деньги от этого зависеть не должны. Присланная
    // скидка остаётся (ручная скидка и промокод — работа кассира), но пол
    // задаёт категория.
    //
    // ПОЛ, А НЕ ЗАМЕНА. Пациент своей группы не лишается никогда: если кассир
    // дал больше — действует большая скидка, если не дал ничего — действует
    // скидка группы. Взять меньшую значило бы молча отнять у VIP его условия,
    // а сложить — дать скидку дважды за одно и то же.
    const categoryPercent = patientCategoryDiscount(db, visit.patient_id);
    // PACKAGES_V1 (2026-09-26) — СКИДКА ПАКЕТА ПОСТРОЧНО. Строка пакета со
    // скидкой получает СВОЮ скидку (invoice_items.discount_amount): бо́льшую из
    // скидки пакета и скидки категории пациента — не обе (решение владельца).
    // Ручная скидка кассира и пол категории действуют, как прежде, но только на
    // строки без своей скидки и зажаты их суммой. Скидка счёта — сумма обеих
    // частей, поэтому итог счёта и сумма строк после скидки сходятся. Пакет без
    // скидки (прежний шаблон) — обычная строка, всё как было.
    for (const p of priced) {
      p.ownDiscount = p.pkg && p.pkg.pct > 0
        ? round2(p.line * Math.max(p.pkg.pct, categoryPercent) / 100)
        : 0;
    }
    const lineDiscounts = round2(priced.reduce((sum, p) => sum + p.ownDiscount, 0));
    const restSubtotal = round2(priced.reduce((sum, p) => sum + (p.ownDiscount > 0 ? 0 : p.line), 0));
    const categoryDiscount = round2(restSubtotal * categoryPercent / 100);
    const restDiscount = round2(Math.min(Math.max(discountRaw, categoryDiscount), restSubtotal));
    const discount = round2(lineDiscounts + restDiscount);
    const total = round2(subtotal - discount);
    const invoiceNumber = nextInvoiceNumber(db);
    // A zero-balance invoice (all-free services or 100% discount) has nothing
    // to collect: mark it paid at creation so it doesn't get stuck 'unpaid'
    // forever (record_payment refuses payments against a balance <= 0).
    // Nothing paid yet, so this is the same ladder as everywhere else.
    const status = invoiceStatusFor(total, 0);

    // COVERAGE_SPLIT_V1 — кому выставлен счёт. null / отсутствует — пациенту
    // (обычный случай, касса принимает деньги). Иначе — id организации или
    // страховой из payers: визит делится на два счёта, и по этому полю касса
    // отличает «взять с пациента» от «выставлено контрагенту».
    const payerRaw = (args && args.payer_id !== undefined && args.payer_id !== null) ? args.payer_id : null;
    if (payerRaw !== null) {
      if (!isPositiveInt(payerRaw)) {
        throw new RpcError('payer_id must be a positive integer.', 400);
      }
      const payer = db.prepare('SELECT id, active FROM payers WHERE id = ?').get(payerRaw);
      if (!payer) {
        throw new RpcError(`payer ${payerRaw} not found.`, 400);
      }
      if (!payer.active) {
        throw new RpcError(`payer ${payerRaw} is inactive.`, 400);
      }
    }

    const insertInvoice = db.prepare(`
      INSERT INTO invoices
        (invoice_number, visit_id, patient_id, branch_id, subtotal, discount_amount, total_amount, paid_amount, status, created_by, paid_at, payer_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
    `);
    const info = insertInvoice.run(
      invoiceNumber,
      visitId,
      visit.patient_id,
      visit.branch_id,
      subtotal,
      discount,
      total,
      status,
      user.id,
      status === 'paid' ? db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%SZ','now') n").get().n : null,
      payerRaw
    );
    const invoiceId = info.lastInsertRowid;

    const insertItem = db.prepare(`
      INSERT INTO invoice_items (invoice_id, service_id, description, quantity, unit_price, total, discount_amount)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const linkVisitService = db.prepare('UPDATE visit_services SET invoice_item_id = ? WHERE id = ?');
    const syncVisitService = db.prepare('UPDATE visit_services SET unit_price = ?, total = ? WHERE id = ?');

    for (const { row, unit, qty, line, svcName, ownDiscount } of priced) {
      const description = svcName || '';
      const itemInfo = insertItem.run(invoiceId, row.service_id, description, qty, unit, line, ownDiscount);
      linkVisitService.run(itemInfo.lastInsertRowid, row.id);
      // Keep the visit line consistent with what was actually billed.
      syncVisitService.run(unit, line, row.id);
    }

    // FREE_SERVICE_V1 — счёт на ноль (бесплатная услуга или скидка 100%) выше
    // уже помечен 'paid': платить нечего. Но строки визита оставались в 'added'
    // — «номер выдан, счёт не оплачен», — потому что в 'queued' их переводит
    // ТОЛЬКО оплата (record_payment / split / debt), а оплаты здесь никогда не
    // будет: record_payment отказывает при остатке <= 0. В итоге бесплатная
    // консультация висела в очереди как «ожидает оплату» вечно, и снять её
    // оттуда было нечем. Ноль в счёте = расчёт закрыт, значит и очередь обычная.
    if (total === 0) {
      db.prepare(`
        UPDATE visit_services
        SET status = 'queued'
        WHERE invoice_item_id IN (SELECT id FROM invoice_items WHERE invoice_id = ?)
          AND status NOT IN ('in_progress', 'completed')
      `).run(invoiceId);
    }

    const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
    const items = db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ?').all(invoiceId);
    // PACKAGES_V1 (ревью I-1) — rest_discount: сколько из присланной скидки
    // (ручная/лояльность/промокод, с полом категории) счёт реально применил —
    // без скидок пакета. Мастер переносит остаток своей скидки на счёт
    // следующего дня и вычитает именно это, а не invoice.discount_amount, в
    // котором теперь лежат и скидки пакета.
    return { invoice, items, rest_discount: restDiscount };
  });

  const out = run();
  // CRM_REAL_BOOKING_V1 — СЧЁТ ПО АКТУ ЭТО САМО ПО СЕБЕ ДОКАЗАТЕЛЬСТВО.
  //
  // У консультации, выставленной контрагенту (COVERAGE_SPLIT_V1), денег на
  // кассе не будет НИКОГДА: такие счета из списка кассы исключены, а строки
  // их услуг остаются в 'added', потому что в очередь их переводит только
  // оплата — и врачебное «Начать приём» оказывается заперто тем же счётом.
  // Ни одно из трёх доказательств прихода не наступало, и заявка по такому
  // пациенту висела вечно.
  //
  // Но акт подписывают С ЧЕЛОВЕКОМ: в тот миг, когда счёт по визиту
  // выставляется контрагенту, пациент стоит у стойки. Обычный счёт пациенту
  // доказательством не является и здесь не считается — его заводят заранее,
  // а приходом является оплата (crmInvoiceEvidence).
  if (out.invoice && out.invoice.payer_id) crmVisitEvidence(db, visitId);
  return out;
}

export function recordPayment(db, args, user) {
  requireRole(user, PAYMENT_ROLES);

  const amount = args && args.amount;
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    throw new RpcError('amount must be a positive number.', 400);
  }
  // Round exactly once and use this single value everywhere (the balance
  // check, the credited paid_amount, and the stored payments row) so the
  // ledger invariant sum(payments) === invoices.paid_amount always holds,
  // even for sub-cent input amounts.
  const amt = round2(amount);
  if (!(Number.isFinite(amt) && amt > 0)) {
    throw new RpcError('amount must be a positive number.', 400);
  }
  const method = args && args.method !== undefined ? args.method : 'cash';
  if (!PAYMENT_METHODS.includes(method)) {
    throw new RpcError(`unknown method: ${method}`, 400);
  }

  const invoiceId = args && args.invoice_id;
  if (!isPositiveInt(invoiceId)) {
    throw new RpcError('invoice_id must be a positive integer.', 400);
  }

  const run = db.transaction(() => {
    const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
    if (!invoice) {
      throw new RpcError('invoice not found.', 400);
    }
    assertOwnBuilding(db, invoice, 'Счёт');   // BRANCH_MONEY_GUARD_V1
    if (invoice.status === 'void' || invoice.status === 'refunded') {
      throw new RpcError(`invoice is ${invoice.status}.`, 400);
    }

    const balance = round2(invoice.total_amount - invoice.paid_amount);
    if (balance <= 0) {
      throw new RpcError('invoice already paid (balance due is 0).', 400);
    }
    if (amt > balance) {
      throw new RpcError(`amount exceeds balance due (${balance})`, 400);
    }

    const newPaid = round2(invoice.paid_amount + amt);
    const status = invoiceStatusFor(invoice.total_amount, newPaid, invoice.status);

    // Stamp shift_id from the paying cashier's own OPEN shift only — never
    // from any client-supplied field (args.shift_id is ignored entirely).
    // SHIFT_AUTO_V2 — первый платёж дня сам открывает смену (нулевой остаток).
    const shiftId = ensureOpenShift(db, user).id;

    // ACQ_PROVIDER_V1 — необязательная пометка (провайдер эквайринга и т.п.);
    // произвольная строка, обрезается до 200 символов, деньги не трогает.
    const payNotes = typeof (args && args.notes) === 'string' ? args.notes.slice(0, 200) : '';
    db.prepare(`
      INSERT INTO payments (invoice_id, amount, method, cashier_id, shift_id, notes)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(invoiceId, amt, method, user.id, shiftId, payNotes);

    if (status === 'paid') {
      db.prepare(`
        UPDATE invoices
        SET paid_amount = ?, status = ?, paid_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
        WHERE id = ?
      `).run(newPaid, status, invoiceId);
    } else {
      db.prepare(`
        UPDATE invoices
        SET paid_amount = ?, status = ?
        WHERE id = ?
      `).run(newPaid, status, invoiceId);
    }

    db.prepare(`
      UPDATE visit_services
      SET status = 'queued'
      WHERE invoice_item_id IN (SELECT id FROM invoice_items WHERE invoice_id = ?)
        AND status NOT IN ('in_progress', 'completed')
    `).run(invoiceId);

    return { invoice: db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId) };
  });

  const out = run();
  // CRM_REAL_BOOKING_V1 — заявка колл-центра закрывается приходом, а кнопку
  // «Пришёл» в клинике не нажимает никто (разбор — в crm/visit-status.js).
  // Деньги у окна кассы заочно не появляются, поэтому платёж по счёту визита
  // — доказательство не хуже. За транзакцией: воронка не вправе отменить
  // платёж, и молчит она сама.
  crmInvoiceEvidence(db, invoiceId);
  return out;
}

// SPLIT_PAY_V1 — оплата одного счёта несколькими способами за один приём
// (например: часть наличными, часть картой/эквайрингом). Все части проводятся
// в ОДНОЙ транзакции по тем же правилам, что record_payment: сумма частей не
// может превысить остаток счёта, каждая часть становится отдельной строкой
// payments (итоги смены по способам считаются как обычно).
export function recordPaymentSplit(db, args, user) {
  requireRole(user, PAYMENT_ROLES);

  const invoiceId = args && args.invoice_id;
  if (!isPositiveInt(invoiceId)) {
    throw new RpcError('invoice_id must be a positive integer.', 400);
  }
  const raw = args && args.tenders;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 5) {
    throw new RpcError('tenders must be a non-empty array (max 5).', 400);
  }
  const tenders = raw.map((t, i) => {
    const amount = t && t.amount;
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
      throw new RpcError(`tender ${i + 1}: amount must be a positive number.`, 400);
    }
    const amt = round2(amount);
    const method = t && t.method !== undefined ? t.method : 'cash';
    if (!PAYMENT_METHODS.includes(method)) {
      throw new RpcError(`tender ${i + 1}: unknown method: ${method}`, 400);
    }
    const notes = typeof (t && t.notes) === 'string' ? t.notes.slice(0, 200) : '';
    return { amt, method, notes };
  });
  const totalTendered = round2(tenders.reduce((s2, t) => s2 + t.amt, 0));

  const run = db.transaction(() => {
    const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
    if (!invoice) throw new RpcError('invoice not found.', 400);
    assertOwnBuilding(db, invoice, 'Счёт');   // BRANCH_MONEY_GUARD_V1
    if (invoice.status === 'void' || invoice.status === 'refunded') {
      throw new RpcError(`invoice is ${invoice.status}.`, 400);
    }
    const balance = round2(invoice.total_amount - invoice.paid_amount);
    if (balance <= 0) throw new RpcError('invoice already paid (balance due is 0).', 400);
    if (totalTendered > balance) {
      throw new RpcError(`amount exceeds balance due (${balance})`, 400);
    }

    const shiftId = ensureOpenShift(db, user).id;
    const insertPay = db.prepare(`
      INSERT INTO payments (invoice_id, amount, method, cashier_id, shift_id, notes)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const t of tenders) insertPay.run(invoiceId, t.amt, t.method, user.id, shiftId, t.notes);

    const newPaid = round2(invoice.paid_amount + totalTendered);
    const status = invoiceStatusFor(invoice.total_amount, newPaid, invoice.status);
    if (status === 'paid') {
      db.prepare(`UPDATE invoices SET paid_amount = ?, status = ?, paid_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`)
        .run(newPaid, status, invoiceId);
    } else {
      db.prepare('UPDATE invoices SET paid_amount = ?, status = ? WHERE id = ?').run(newPaid, status, invoiceId);
    }

    db.prepare(`
      UPDATE visit_services
      SET status = 'queued'
      WHERE invoice_item_id IN (SELECT id FROM invoice_items WHERE invoice_id = ?)
        AND status NOT IN ('in_progress', 'completed')
    `).run(invoiceId);

    return { invoice: db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId) };
  });

  const out = run();
  crmInvoiceEvidence(db, invoiceId);   // CRM_REAL_BOOKING_V1 — см. record_payment
  return out;
}

// DEBT_BTN_V1 — «Оставить как долг»: кассир фиксирует, что пациент заплатит
// позже. Счёт переводится в статус debt (частичная оплата, если была, уже
// записана обычными платежами), а услуги счёта освобождаются в очередь —
// врач/лаборатория/процедуры видят их и работают, не дожидаясь полной оплаты.
export function markInvoiceDebt(db, args, user) {
  requireRole(user, PAYMENT_ROLES);

  const invoiceId = args && args.invoice_id;
  if (!isPositiveInt(invoiceId)) {
    throw new RpcError('invoice_id must be a positive integer.', 400);
  }

  const run = db.transaction(() => {
    const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
    if (!invoice) throw new RpcError('invoice not found.', 400);
    assertOwnBuilding(db, invoice, 'Счёт');   // BRANCH_MONEY_GUARD_V1
    if (invoice.status === 'void' || invoice.status === 'refunded') {
      throw new RpcError(`invoice is ${invoice.status}.`, 400);
    }
    const balance = round2(invoice.total_amount - invoice.paid_amount);
    if (balance <= 0) throw new RpcError('invoice already paid (balance due is 0).', 400);

    db.prepare("UPDATE invoices SET status = 'debt' WHERE id = ?").run(invoiceId);
    db.prepare(`
      UPDATE visit_services
      SET status = 'queued'
      WHERE invoice_item_id IN (SELECT id FROM invoice_items WHERE invoice_id = ?)
        AND status NOT IN ('in_progress', 'completed')
    `).run(invoiceId);

    return { invoice: db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId) };
  });

  const out = run();
  // CRM_REAL_BOOKING_V1 — «Оставить как долг» нажимают ПЕРЕД ПАЦИЕНТОМ:
  // кассир договаривается с человеком, что тот заплатит позже. Денег при
  // этом не появилось, поэтому crmInvoiceEvidence (он требует оплаты) тут не
  // подходит — доказательством является сам факт разговора у окна.
  if (out.invoice && out.invoice.visit_id) crmVisitEvidence(db, out.invoice.visit_id);
  return out;
}

// SVC_UNPAID_REMOVE_V1 — remove a service line AND repair its invoice in one
// atomic action (patient card «Услуги» trash button). Allowed only while no
// money has moved: an unpaid invoice shrinks by the line (discount re-clamped),
// an emptied invoice is deleted outright; paid/partial/debt bills refuse.
// An un-invoiced line simply deletes.
//
// HOLDINGS_FIRST_V1 (23.09) — И ВОЗВРАЩАЕТ ТОВАР, ЕСЛИ СТРОКА ТОВАРНАЯ.
//
// Вкладка «Услуги» карточки пациента показывает ВСЕ строки визита, товарные в
// том числе (списанный бинт — такая же строка visit_services, только с
// clinic_item_id вместо услуги), и корзина стоит на каждой. Значит эта дверь
// удаляет и выдачи — а удаляла она их так, будто товара в них не было: строка
// исчезала, товар не возвращался НИКОМУ, и подотчёт медсестры, из которого его
// взяли, оставался пустым. В журнале при этом навсегда повисало движение
// расхода, у которого больше нет ни строки визита, ни пациента: карточка
// отдела считала его «расходом на пациентов», а на какого — сказать было уже
// нечем.
//
// ОТКАЗАТЬ БЫЛО НЕЛЬЗЯ: тогда регистратура видит в карточке строку с корзиной,
// которую корзина не убирает, и уходит искать «Отменить выдачу» на другом
// экране — где её ждёт своя защита, отказывающая по счёту (rpc/inventory.js
// voidDispense не трогает строку, попавшую в счёт, даже неоплаченный). Здесь же
// счёт чинится в той же транзакции, поэтому дверь остаётся одна.
//
// ЗАЩИТЫ ОСТАЛИСЬ ТЕ, ЧТО БЫЛИ. Оказанную строку не удалить, чужое здание не
// тронуть, счёт с деньгами — отказ. Возврат идёт ПО ИСТОЧНИКАМ движений
// (restoreSources), поэтому выдача, покрытая наполовину подотчётом и наполовину
// складом, возвращается двумя частями, каждая своему держателю.
const REMOVE_SERVICE_ROLES = ['admin', 'registrar'];

// PACKAGES_V1 (ревью I-2 / M-3) — сумма СОБСТВЕННЫХ скидок строк счёта
// (скидки пакета). Читается до правки строки: разница между скидкой счёта и
// этой суммой — ОСТАТОК (ручная / категорийная скидка на строки без своей).
function invoiceOwnDiscount(db, invoiceId) {
  return round2(db.prepare('SELECT COALESCE(SUM(discount_amount), 0) s FROM invoice_items WHERE invoice_id = ?').get(invoiceId).s);
}

// PACKAGES_V1 (ревью I-2 / M-3) — ИТОГИ НЕОПЛАЧЕННОГО СЧЁТА ПОСЛЕ ПРАВКИ СТРОКИ.
//
// Скидка счёта состоит из двух частей (createInvoiceForVisit): своих скидок
// строк пакета и остатка, который лежит только на строках без своей скидки и
// зажат их суммой. Прежде правка вычитала из скидки счёта лишь скидку самой
// строки, и остаток оставался прежним: убрали единственный анализ — ручные
// 30 000 висели на счёте без строки; убрали большой анализ — остаток ложился на
// маленький и уводил его в минус. Здесь обе части собираются заново:
//   своя   = SUM(discount_amount) оставшихся строк;
//   остаток = прежний остаток (не больше), но не меньше пола категории пациента
//            (тот же пол, что при выставлении) и не больше суммы строк без своей
//            скидки.
// Строка пакета, заменённая другой услугой, теряет скидку пакета и становится
// строкой «без своей» — пол категории ложится и на неё (ревью M-3).
function repriceUnpaidInvoice(db, inv, oldOwn) {
  const left = db.prepare(`SELECT COALESCE(SUM(total), 0) s,
                                  COALESCE(SUM(discount_amount), 0) own,
                                  COALESCE(SUM(CASE WHEN COALESCE(discount_amount, 0) > 0 THEN 0 ELSE total END), 0) base
                             FROM invoice_items WHERE invoice_id = ?`).get(inv.id);
  const subtotal = round2(left.s);
  const own = round2(left.own);
  const base = round2(left.base);
  const oldRest = Math.max(round2((Number(inv.discount_amount) || 0) - oldOwn), 0);
  const floor = round2(base * patientCategoryDiscount(db, inv.patient_id) / 100);
  const rest = round2(Math.min(Math.max(oldRest, floor), base));
  const discount = Math.min(round2(own + rest), subtotal);
  db.prepare('UPDATE invoices SET subtotal = ?, discount_amount = ?, total_amount = ? WHERE id = ?')
    .run(subtotal, discount, round2(subtotal - discount), inv.id);
  return db.prepare('SELECT * FROM invoices WHERE id = ?').get(inv.id);
}

export function removeUnpaidService(db, args, user) {
  requireRole(user, REMOVE_SERVICE_ROLES);

  const vsId = args && args.visit_service_id;
  if (!isPositiveInt(vsId)) {
    throw new RpcError('visit_service_id must be a positive integer.', 400);
  }

  const run = db.transaction(() => {
    const vs = db.prepare('SELECT * FROM visit_services WHERE id = ?').get(vsId);
    if (!vs) throw new RpcError('service line not found.', 400);
    // BRANCH_MONEY_GUARD_V1 — удаление здесь означает надгробие в журнале (084),
    // то есть строка исчезнет и в том здании, где её сделали.
    assertOwnBuilding(db, vs, 'Услуга');
    if (vs.status === 'in_progress' || vs.status === 'completed') {
      throw new RpcError('услуга уже оказывается/оказана — удалить нельзя.', 400);
    }

    // FK order: visit_services.invoice_item_id references invoice_items, so
    // the service LINE is deleted first, then its invoice item, then (if
    // emptied) the invoice itself. Guards run before anything is touched.
    const item = vs.invoice_item_id != null
      ? db.prepare('SELECT * FROM invoice_items WHERE id = ?').get(vs.invoice_item_id)
      : null;
    const inv = item ? db.prepare('SELECT * FROM invoices WHERE id = ?').get(item.invoice_id) : null;
    if (item && !inv) throw new RpcError('invoice not found.', 500);
    if (inv) assertOwnBuilding(db, inv, 'Счёт');   // BRANCH_MONEY_GUARD_V1
    if (inv && (inv.paid_amount > 0 || inv.status !== 'unpaid')) {
      throw new RpcError('счёт уже ' + (inv.paid_amount > 0 ? 'оплачен (частично)' : inv.status) + ' — сначала отмените его в кассе.', 400);
    }

    // HOLDINGS_FIRST_V1 — товар возвращается ДО удаления строки: источники
    // читаются из движений ЭТОЙ строки (reference_id = vsId), а после DELETE
    // их не с чем было бы связать. Возврат пишет свои движения 'void', и
    // журнал сходится в ноль по этой строке — сироты не остаётся.
    const sources = vs.clinic_item_id != null
      ? restoreSources(db, 'visit', vsId, vs.clinic_item_id, vs.quantity, user)
      : [];

    db.prepare('DELETE FROM visit_services WHERE id = ?').run(vsId);

    let invoiceDeleted = false;
    let invoice = null;
    if (item) {
      const oldOwn = invoiceOwnDiscount(db, inv.id);   // PACKAGES_V1 — ДО удаления строки
      db.prepare('DELETE FROM invoice_items WHERE id = ?').run(item.id);
      const left = db.prepare('SELECT COUNT(*) n FROM invoice_items WHERE invoice_id = ?').get(inv.id);
      if (left.n === 0) {
        db.prepare('DELETE FROM invoices WHERE id = ?').run(inv.id);
        invoiceDeleted = true;
      } else {
        invoice = repriceUnpaidInvoice(db, inv, oldOwn);
      }
    }
    return { removed: true, invoice_deleted: invoiceDeleted, invoice, sources };
  });

  return run();
}

// SVC_CHANGE_V1 — замена услуги в строке визита, пока по счёту не было денег.
// Строка получает новую услугу и цену из каталога; если строка уже в
// НЕОПЛАЧЕННОМ счёте — позиция счёта и итоги (subtotal/discount/total)
// пересчитываются в той же транзакции. Оплаченный/частично оплаченный счёт
// не трогаем — сначала возврат/отмена в кассе.
export function changeUnpaidService(db, args, user) {
  requireRole(user, REMOVE_SERVICE_ROLES);

  const vsId = args && args.visit_service_id;
  const newServiceId = args && args.new_service_id;
  if (!isPositiveInt(vsId)) throw new RpcError('visit_service_id must be a positive integer.', 400);
  if (!isPositiveInt(newServiceId)) throw new RpcError('new_service_id must be a positive integer.', 400);

  const run = db.transaction(() => {
    const vs = db.prepare('SELECT * FROM visit_services WHERE id = ?').get(vsId);
    if (!vs) throw new RpcError('service line not found.', 400);
    assertOwnBuilding(db, vs, 'Услуга');   // BRANCH_MONEY_GUARD_V1
    if (vs.status === 'in_progress' || vs.status === 'completed') {
      throw new RpcError('услуга уже оказывается/оказана — заменить нельзя.', 400);
    }
    // HOLDINGS_FIRST_V1 — ТОВАРНУЮ СТРОКУ ЗАМЕНИТЬ НЕЛЬЗЯ.
    //
    // Вкладка «Услуги» карточки пациента показывает ВСЕ строки визита, товарные
    // в том числе (списанный бинт — та же visit_services, только с
    // clinic_item_id вместо услуги), и «Заменить услугу» стояла на них рядом с
    // корзиной. Промах мимо корзины давал химеру: строка начинала считаться
    // консультацией, три бинта оставались списанными, clinic_item_id — на
    // месте, и карточка отдела считала этот расход против строки с названием
    // услуги. Разобрать такую строку потом нечем: цена уже от услуги, товар уже
    // у пациента.
    //
    // Выхода два, и оба есть: убрать строку (removeUnpaidService вернёт товар
    // по источникам) или списать нужный товар заново. Кнопки на товарной строке
    // больше и нет (views/patient-card.js), но запрет стоит здесь — там, где
    // происходит подмена, а не там, где сегодня о ней известно.
    if (vs.clinic_item_id != null) {
      throw new RpcError('это списанный товар, а не услуга — уберите строку и спишите товар заново.', 400);
    }
    const svc = db.prepare('SELECT * FROM services WHERE id = ? AND active = 1').get(newServiceId);
    if (!svc) throw new RpcError('новая услуга не найдена или неактивна.', 400);

    const item = vs.invoice_item_id != null
      ? db.prepare('SELECT * FROM invoice_items WHERE id = ?').get(vs.invoice_item_id)
      : null;
    const inv = item ? db.prepare('SELECT * FROM invoices WHERE id = ?').get(item.invoice_id) : null;
    if (item && !inv) throw new RpcError('invoice not found.', 500);
    if (inv) assertOwnBuilding(db, inv, 'Счёт');   // BRANCH_MONEY_GUARD_V1
    if (inv && (inv.paid_amount > 0 || inv.status !== 'unpaid')) {
      throw new RpcError('счёт уже ' + (inv.paid_amount > 0 ? 'оплачен (частично)' : inv.status) + ' — сначала отмените его в кассе.', 400);
    }

    const qty = vs.quantity || 1;
    const lineTotal = round2(svc.price * qty);
    // PACKAGES_V1 — другая услуга уже не услуга пакета: строка теряет пакет и
    // его скидку (скидка счёта уменьшается на неё же ниже).
    db.prepare('UPDATE visit_services SET service_id = ?, unit_price = ?, total = ?, package_id = NULL WHERE id = ?')
      .run(newServiceId, svc.price, lineTotal, vsId);

    let invoice = null;
    if (item) {
      const oldOwn = invoiceOwnDiscount(db, inv.id);   // PACKAGES_V1 — ДО правки строки
      db.prepare('UPDATE invoice_items SET service_id = ?, description = ?, unit_price = ?, total = ?, discount_amount = 0 WHERE id = ?')
        .run(newServiceId, svc.name || '', svc.price, lineTotal, item.id);
      invoice = repriceUnpaidInvoice(db, inv, oldOwn);
    }

    return { changed: true, line: db.prepare('SELECT * FROM visit_services WHERE id = ?').get(vsId), invoice };
  });

  return run();
}

// CASHIER_REFUND_V1 — возврат оплаты. Inserts a NEGATIVE payments row (so the
// sum(payments) === invoices.paid_amount invariant — and every shift-drawer and
// report SUM built on payments — stays honest automatically) and rolls the
// invoice's paid_amount/status back. Partial refunds allowed; the refundable
// amount is capped by BOTH the original payment (minus refunds already made
// against it, tagged REFUND#<id> in notes) and the invoice's current
// paid_amount, so repeated refunds can never drive anything below zero.
export function refundPayment(db, args, user) {
  requireRole(user, PAYMENT_ROLES);

  const paymentId = args && args.payment_id;
  if (!isPositiveInt(paymentId)) {
    throw new RpcError('payment_id must be a positive integer.', 400);
  }
  const reason = String((args && args.reason) || '').slice(0, 300);

  const run = db.transaction(() => {
    const p = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
    if (!p) {
      throw new RpcError('payment not found.', 400);
    }
    if (p.amount <= 0) {
      throw new RpcError('Это возврат — вернуть возврат нельзя.', 400);
    }
    const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(p.invoice_id);
    if (!invoice) {
      throw new RpcError('invoice not found.', 400);
    }
    // BRANCH_MONEY_GUARD_V1 — возврат делают там, где взяли деньги: из ЭТОГО
    // ящика они не выходили, и отрицательный платёж отсюда исказил бы и смену
    // соседа, и его выручку.
    assertOwnBuilding(db, p, 'Платёж');
    assertOwnBuilding(db, invoice, 'Счёт');

    // The tag must match on a BOUNDARY, not a bare prefix: `LIKE 'REFUND#1%'`
    // also matches REFUND#10 / REFUND#123, so refunds of other payments were
    // counted against this one and legitimate refunds got refused. A refund
    // note is either exactly the tag or the tag followed by ' — <reason>', so
    // those are the only two shapes to match.
    const tag = 'REFUND#' + p.id;
    const refunded = db.prepare(
      "SELECT COALESCE(SUM(-amount),0) s FROM payments WHERE amount < 0 AND (notes = ? OR notes LIKE ?)"
    ).get(tag, tag + ' %').s;
    const refundable = round2(Math.min(p.amount - refunded, invoice.paid_amount));
    if (refundable <= 0) {
      throw new RpcError('По этому платежу уже всё возвращено.', 400);
    }

    const rawAmt = args && args.amount !== undefined && args.amount !== null ? args.amount : refundable;
    if (typeof rawAmt !== 'number' || !Number.isFinite(rawAmt) || rawAmt <= 0) {
      throw new RpcError('amount must be a positive number.', 400);
    }
    const amt = round2(rawAmt);
    if (amt > refundable) {
      throw new RpcError(`Максимум к возврату по этому платежу: ${refundable}.`, 400);
    }

    // The refund lands in the REFUNDER's own open shift (a cash refund must
    // come out of the drawer that is open now, not the historical one).
    // SHIFT_AUTO_V2, same rule as record_payment: a refund as the first action
    // of the day OPENS the day's shift rather than falling back to shift_id
    // NULL — a NULL-shift refund is invisible to the X-report and to the
    // expected-drawer maths, so the till reconciles short with no explanation.
    const shiftId = ensureOpenShift(db, user).id;

    db.prepare(`
      INSERT INTO payments (invoice_id, amount, method, cashier_id, shift_id, notes)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(invoice.id, -amt, p.method, user.id, shiftId,
      tag + (reason ? ' — ' + reason : ''));

    const newPaid = round2(invoice.paid_amount - amt);
    const status = invoiceStatusFor(invoice.total_amount, newPaid, invoice.status);
    if (status === 'paid') {
      db.prepare('UPDATE invoices SET paid_amount = ?, status = ? WHERE id = ?').run(newPaid, status, invoice.id);
    } else {
      // No longer fully paid — clear paid_at so reports don't count it as settled.
      db.prepare('UPDATE invoices SET paid_amount = ?, status = ?, paid_at = NULL WHERE id = ?').run(newPaid, status, invoice.id);
      // CANCEL_MEANS_CANCEL_V1 — полный возврат это отмена: плитка «ОТМЕНЁН» считает его по этому дню.
      if (status === 'refunded') db.prepare("UPDATE invoices SET voided_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?").run(invoice.id);
    }

    return { invoice: db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoice.id) };
  });

  return run();
}

// BED_CONSOLE_V1 — счёт по госпитализации: выбранные небиллованные строки
// admission_services (услуги и товары) собираются в один invoice
// (admission_id, mig 040); строки получают invoice_item_id + status
// 'completed'. Цены авторитетны из каталога (services.price /
// products.sale_price), как в визитном биллинге.
export function createInvoiceForAdmission(db, args, user) {
  requireRole(user, CREATE_INVOICE_ROLES);

  const admissionId = args && args.admission_id;
  if (!isPositiveInt(admissionId)) throw new RpcError('admission_id must be a positive integer.', 400);
  const ids = args && args.admission_service_ids;
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every(isPositiveInt)) {
    throw new RpcError('admission_service_ids must be a non-empty array of integers.', 400);
  }
  if (new Set(ids).size !== ids.length) throw new RpcError('admission_service_ids contains duplicates.', 400);

  return buildAdmissionInvoice(db, admissionId, ids, user);
}

// CASE_OVERVIEW_V1 — та же сборка счёта БЕЗ проверки роли кассы: её зовёт и
// касса (createInvoiceForAdmission выше, с ролью), и выписка врача
// (admission-bill.js — право там уже проверено заявкой на выписку).
// Строки проверены вызывающим: свои, не выставлены, «В счёт».
export function buildAdmissionInvoice(db, admissionId, ids, user) {
  const run = db.transaction(() => {
    const adm = db.prepare('SELECT * FROM admissions WHERE id = ?').get(admissionId);
    if (!adm) throw new RpcError('admission not found.', 400);

    const getService = db.prepare('SELECT price, name FROM services WHERE id = ?');
    const getProduct = db.prepare('SELECT sale_price, name FROM products WHERE id = ?');
    const priced = ids.map((id) => {
      const row = db.prepare('SELECT * FROM admission_services WHERE id = ?').get(id);
      if (!row) throw new RpcError(`admission_service ${id} not found.`, 400);
      if (row.admission_id !== admissionId) throw new RpcError(`admission_service ${id} belongs to another admission.`, 400);
      if (row.invoice_item_id !== null) throw new RpcError(`admission_service ${id} is already invoiced.`, 400);
      if (!row.billable) throw new RpcError('строка в учёте расходов — отметьте «В счёт», чтобы включить её в счёт пациента.', 400);
      let name = '', svc = null, prod = null;
      if (row.service_id != null) {
        svc = getService.get(row.service_id);
        if (!svc) throw new RpcError(`service ${row.service_id} not found`, 400);
        name = svc.name;
      } else if (row.clinic_item_id != null) {
        prod = getProduct.get(row.clinic_item_id);
        if (!prod) throw new RpcError(`product ${row.clinic_item_id} not found`, 400);
        name = prod.name;
      }
      // Same precedence as visit billing (the doctor's own price wins), with no
      // visit tier — PAY_BASIS_PERFORMED_V1: one rule, domain/pricing.js.
      const unit = lineUnitPrice(db, row, { service: svc, product: prod, tiered: false });
      const qty = row.quantity;
      if (!(Number.isFinite(qty) && qty > 0)) throw new RpcError(`invalid quantity on admission_service ${row.id}`, 400);
      return { row, unit, qty, line: round2(unit * qty), name };
    });

    const subtotal = round2(priced.reduce((s, p) => s + p.line, 0));
    const invoiceNumber = nextInvoiceNumber(db);
    const status = invoiceStatusFor(subtotal, 0);
    const info = db.prepare(`
      INSERT INTO invoices (invoice_number, admission_id, patient_id, branch_id, subtotal, discount_amount, total_amount, paid_amount, status, created_by, paid_at)
      VALUES (?, ?, ?, ?, ?, 0, ?, 0, ?, ?, ?)
    `).run(invoiceNumber, admissionId, adm.patient_id, null, subtotal, subtotal, status, user.id,
      status === 'paid' ? db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%SZ','now') n").get().n : null);
    const invoiceId = info.lastInsertRowid;

    const insertItem = db.prepare(`
      INSERT INTO invoice_items (invoice_id, service_id, description, quantity, unit_price, total)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const { row, unit, qty, line, name } of priced) {
      const it = insertItem.run(invoiceId, row.service_id, name || '', qty, unit, line);
      db.prepare("UPDATE admission_services SET invoice_item_id = ?, status = 'completed' WHERE id = ?")
        .run(it.lastInsertRowid, row.id);
    }

    const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
    return { invoice, items: db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ?').all(invoiceId) };
  });
  return run();
}

// BED_CONSOLE_V3 — убрать строку госпитализации ИЗ СЧЁТА (обратное действие
// «Сформировать счёт»): позиция счёта удаляется, счёт пересчитывается (пустой
// счёт удаляется целиком), строка возвращается в Unbilled. Только пока по
// счёту не приняты деньги.
export function removeAdmissionLineFromInvoice(db, args, user) {
  requireRole(user, CREATE_INVOICE_ROLES);
  const lineId = args && args.line_id;
  if (!isPositiveInt(lineId)) throw new RpcError('line_id must be a positive integer.', 400);

  const run = db.transaction(() => {
    const line = db.prepare('SELECT * FROM admission_services WHERE id = ?').get(lineId);
    if (!line) throw new RpcError('line not found.', 400);
    if (line.invoice_item_id == null) throw new RpcError('строка и так не в счёте.', 400);
    const item = db.prepare('SELECT * FROM invoice_items WHERE id = ?').get(line.invoice_item_id);
    if (!item) throw new RpcError('invoice item not found.', 500);
    const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(item.invoice_id);
    if (!inv) throw new RpcError('invoice not found.', 500);
    assertOwnBuilding(db, inv, 'Счёт');   // BRANCH_MONEY_GUARD_V1
    if (inv.paid_amount > 0 || inv.status !== 'unpaid') {
      throw new RpcError('счёт уже ' + (inv.paid_amount > 0 ? 'оплачен (частично)' : inv.status) + ' — сначала отмените его в кассе.', 400);
    }

    db.prepare("UPDATE admission_services SET invoice_item_id = NULL, status = 'added' WHERE id = ?").run(lineId);
    db.prepare('DELETE FROM invoice_items WHERE id = ?').run(item.id);
    const left = db.prepare('SELECT COALESCE(SUM(total), 0) s, COUNT(*) n FROM invoice_items WHERE invoice_id = ?').get(inv.id);
    let invoiceDeleted = false;
    if (left.n === 0) {
      db.prepare('DELETE FROM invoices WHERE id = ?').run(inv.id);
      invoiceDeleted = true;
    } else {
      const subtotal = round2(left.s);
      const discount = Math.min(round2(inv.discount_amount), subtotal);
      db.prepare('UPDATE invoices SET subtotal = ?, discount_amount = ?, total_amount = ? WHERE id = ?')
        .run(subtotal, discount, round2(subtotal - discount), inv.id);
    }
    return { removed: true, invoice_deleted: invoiceDeleted };
  });
  return run();
}
