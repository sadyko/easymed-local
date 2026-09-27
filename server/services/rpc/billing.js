// Server-side billing RPCs. All money math (subtotals, balances, statuses)
// is computed here from DB rows — client-supplied amounts are never trusted.
// Both handlers run their DB work inside db.transaction(...)() for atomicity.

import { rpcT } from '../server-message.js';   // V3120_I18N — собранные фразы переводятся на экране
import { ensureOpenShift } from './cashier.js';   // SHIFT_AUTO_V2
// CRM_REAL_BOOKING_V1 — платёж на кассе это доказательство, что пациент
// здесь: заочно деньги у окна не появляются. См. шапку crm/visit-status.js.
import { crmInvoiceEvidence, crmVisitEvidence } from '../crm/visit-status.js';
// CRM_CALENDAR_MIRROR_V1 (разбор ревью M6, M1) — строки записи из заявки CRM.
import { pruneAutoLinesOnInvoice, syncLineFromVisit } from '../crm/booking-mirror.js';
import { invoiceStatusFor, idemReplay, idemRemember } from '../domain/money.js';   // V3120_FIX — ключ повтора
// PAY_BASIS_PERFORMED_V1 — «what will the invoice charge for this line» is one
// function, shared with the doctor's pay (rpc/reports.js): own price over the
// catalog, and VISIT_TIER_PRICING_V1 — a line quoted as a second/repeat visit
// keeps that price at the till (the catalog price is the FIRST visit's price).
import { lineUnitPrice, consultationFor } from '../domain/pricing.js';
import { hasAnyRole } from '../roles.js';
import { localDate } from '../domain/day.js';
// BILLING_AUDIT_FIX_V1 (B3) — тариф заменённой услуги спрашивается заново.
import { servicePriceQuote } from './service-price-quote.js';
// HOLDINGS_FIRST_V1 — «вернуть КАЖДУЮ часть туда, откуда она пришла» живёт в
// одном месте на весь сервер (rpc/inventory.js): подотчёт сотрудника, кабинет,
// отдел, склад. Кольцо импортов здесь такое же, как у billing ↔ cashier строкой
// выше, и по той же причине: обе стороны — объявленные функции, ни одна не
// зовётся при загрузке модуля.
import { restoreSources } from './inventory.js';
import { voidReleasedDoseLines } from './treatment-orders.js';   // V3120_FINAL (S1)
// DEPOSIT_WALLET_V1 — баланс пациента: списание при оплате «с баланса» и
// зачисление при возврате «на баланс» — в той же транзакции, что платёж.
import { spendWallet, creditWallet, moneyDocRefusal, walletBalance, realMoney, WalletError } from '../domain/wallet.js';
// Ревью I4 — возврат откатывает кэшбэк этого счёта.
// CASHBACK_SERVER_V2 — кэшбэк начисляет оплата, возврат его подстраивает.
import { creditCashbackOnPaid, adjustCashbackAfterRefund } from './cashback.js';
import { voidInvoice } from './cashier.js';   // ре-ревью п.9 — отмена после полного возврата на баланс
import { IN_BED_STATUSES } from '../../../public/js/shared/admission-status.js';
// CARD_BALANCE_V1 — подарочная карта / сертификат платит своим остатком.
import { spendCard, returnToCard, CardError, cardClosedByRefund } from '../domain/cards.js';
import { markRefundRelease, refundedLineIds, clearRefundRelease } from '../domain/pay-releases.js';   // PAY_REFUND_V1, FINAL_MONEY_FIX_V1
// INPATIENT_MONEY_FIX_V1 — строку проживания счёт узнаёт по той же метке, что
// акт и проживание (одна копия на сервер и браузер).
import { ACCOMMODATION_NOTE_PREFIX, ACCOMMODATION_LABEL } from '../../../public/js/shared/accommodation-line.js';

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
// CARD_BALANCE_V1 — 'gift_card' — оплата остатком подарочной карты или
// сертификата (card_id обязателен); тоже не приход (shared/payment-methods.js).
const PAYMENT_METHODS = ['cash', 'card', 'transfer', 'acquiring', 'wallet', 'gift_card'];   // CASHIER_DESIGN_V2 — эквайринг (Payme/Click terminal)

function requireRole(user, allowed) {
  // MULTI_ROLE_SERVER_V1 — extras count too, not the primary role alone.
  if (!hasAnyRole(user, allowed)) {
    throw new RpcError('Вашей роли это действие недоступно.', 403);
  }
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function isPositiveInt(v) {
  return Number.isInteger(v) && v > 0;
}

// DEPOSIT_WALLET_V1 — отказ журнала баланса звучит как отказ этого модуля
// (тот же статус, тот же текст), чтобы экраны читали его одинаково.
function walletGuard(fn) {
  try { return fn(); } catch (e) {
    if (e instanceof WalletError || e instanceof CardError) {
      const r = new RpcError(e.message, e.status);
      if (e.template) { r.template = e.template; r.params = e.params; }   // V3120_I18N
      throw r;
    }
    throw e;
  }
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
  throw rpcT(RpcError, '{what} из филиала {branch} — изменить его можно только там.', { what, branch: branchName(db, row.sync_origin) }, 403);
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
    throw new RpcError('Визит указан неверно.', 400);
  }
  const visit = db.prepare('SELECT * FROM visits WHERE id = ?').get(visitId);
  if (!visit) {
    throw new RpcError('Визит не найден.', 400);
  }
  // BRANCH_MONEY_GUARD_V1 — счёт по визиту выставляют там, где визит сделан.
  // Здесь это тем важнее, что счёт СОСЕДА по этому визиту сюда уже приехал (087)
  // и второй счёт был бы вторым требованием денег за одну и ту же работу.
  assertOwnBuilding(db, visit, 'Визит');

  const ids = args && args.visit_service_ids;
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every(isPositiveInt)) {
    throw new RpcError('Не выбрано ни одной услуги.', 400);
  }
  if (new Set(ids).size !== ids.length) {
    throw new RpcError('Одна и та же услуга выбрана дважды.', 400);
  }

  const run = db.transaction(() => {
    // CRM_CALENDAR_MIRROR_V1 (M6) — первый счёт записи: строка зеркала, у
    // которой есть двойник регистратуры, уходит (booking-mirror.js).
    pruneAutoLinesOnInvoice(db, visitId, ids);
    const rows = [];
    for (const id of ids) {
      const row = db.prepare('SELECT * FROM visit_services WHERE id = ?').get(id);
      if (!row) {
        throw rpcT(RpcError, 'Строка услуги №{id} не найдена.', { id }, 400);
      }
      if (row.visit_id !== visitId) {
        throw rpcT(RpcError, 'Строка услуги №{id} относится к другому визиту.', { id }, 400);
      }
      if (row.invoice_item_id !== null) {
        throw rpcT(RpcError, 'Услуга №{id} уже в счёте.', { id }, 400);
      }
      rows.push(row);
    }

    // FINAL_MONEY_FIX_V1 (I1) — УСЛУГУ, ЗА КОТОРУЮ ПАЦИЕНТУ ВЕРНУЛИ ДЕНЬГИ, СНОВА
    // НЕ ВЫСТАВЛЯЮТ МОЛЧА. Возврат строки (refund_invoice_line) и отмена счёта
    // после возврата оставляют сделанную работу в визите невыставленной — а
    // окно визита отмечает все невыставленные строки, и регистратор брал за
    // возвращённое второй раз (150 000 вместо 50 000, и доля врача вернулась).
    // Такую строку выставляют только явным выбором: rebill_refunded: true
    // (окно визита — галочкой у строки с пометкой «возвращено»).
    const refundedIds = refundedLineIds(db, 'out', ids);
    if (refundedIds.length && !(args.rebill_refunded === true || args.rebill_refunded === 1)) {
      throw new RpcError(refundedIds.length === 1
        ? 'За эту услугу пациенту уже вернули деньги — снова её выставляют только явным выбором («выставить заново»).'
        : 'За ' + refundedIds.length + ' из выбранных услуг пациенту уже вернули деньги — снова их выставляют только явным выбором («выставить заново»).', 409);
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
          throw rpcT(RpcError, 'Услуга №{id} не найдена.', { id: row.service_id }, 400);
        }
        svcName = svc.name;
      } else if (row.clinic_item_id != null) {
        prod = getProduct.get(row.clinic_item_id);
        if (!prod) {
          throw rpcT(RpcError, 'Товар №{id} не найден.', { id: row.clinic_item_id }, 400);
        }
        svcName = prod.name;
      } else if (row.consultation_type_id != null) {
        // BILLING_AUDIT_FIX_V1 (B7) — консультация: имя с сервера, не пустое.
        const c = consultationFor(db, row.consultation_type_id, row.doctor_id);
        if (c) svcName = c.name;
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
        throw rpcT(RpcError, 'Неверное количество в строке услуги №{id}.', { id: row.id }, 400);
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
      throw new RpcError('Скидка должна быть неотрицательным числом.', 400);
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
    //
    // BILLING_AUDIT_FIX_V1 (B5) — СЧЁТ ПЛАТЕЛЬЩИКУ СКИДКИ ГРУППЫ ПАЦИЕНТА НЕ
    // ПОЛУЧАЕТ. Группа — договорённость клиники с ПАЦИЕНТОМ (VIP, льготник);
    // страховая или организация платит по своему договору, и скидка пациента
    // на её счёт молча уменьшала сумму, которую клиника выставляет
    // контрагенту. Ручная скидка кассира и скидка пакета остаются.
    const payerSet = args && args.payer_id !== undefined && args.payer_id !== null;
    const categoryPercent = payerSet ? 0 : patientCategoryDiscount(db, visit.patient_id);
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
        throw new RpcError('Плательщик указан неверно.', 400);
      }
      const payer = db.prepare('SELECT id, active FROM payers WHERE id = ?').get(payerRaw);
      if (!payer) {
        throw rpcT(RpcError, 'Плательщик №{id} не найден.', { id: payerRaw }, 400);
      }
      if (!payer.active) {
        throw rpcT(RpcError, 'Плательщик №{id} выключен.', { id: payerRaw }, 400);
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
      clearRefundRelease(db, 'out', [row.id]);   // FINAL_MONEY_FIX_V1 (M1) — отметка была про прежний счёт
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
    //
    // V3120_FIX (FATAL-2) — СЧЁТ ПЛАТЕЛЬЩИКУ (страховая / организация) ТОЖЕ
    // ОТПУСКАЕТ СТРОКИ В ОЧЕРЕДЬ. Денег на кассе по нему не будет никогда: он
    // исключён из «Приёма оплат» (COVERAGE_SPLIT_V1), а в 'queued' строки
    // переводила только оплата. Анализ по страховке висел «Не оплачен»:
    // save_lab_results отказывал «результат вносят после кассы», процедура —
    // так же, а выплата врачу не видела работы. Расчёт с плательщиком идёт по
    // акту и договору — для очереди это то же, что оплата или «в долг»
    // (mark_invoice_debt). Сам счёт остаётся 'unpaid': это долг плательщика.
    if (total === 0 || payerRaw !== null) {
      db.prepare(`
        UPDATE visit_services
        SET status = 'queued'
        WHERE invoice_item_id IN (SELECT id FROM invoice_items WHERE invoice_id = ?)
          AND status NOT IN ('in_progress', 'completed', 'collected', 'resulted')
      `).run(invoiceId);
    }

    const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
    const items = db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY id').all(invoiceId);   // BILLING_AUDIT_FIX_V1 (A2) — порядок присланных строк
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
  // кассе не будет НИКОГДА: такие счета из списка кассы исключены (строки их
  // услуг с V3120_FIX уходят в очередь сразу при выставлении, см. выше).
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
  { const seen = idemReplay(db, 'record_payment', args); if (seen) return seen; }   // V3120_FIX — повтор той же формы

  const amount = args && args.amount;
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    throw new RpcError('Сумма должна быть положительным числом.', 400);
  }
  // Round exactly once and use this single value everywhere (the balance
  // check, the credited paid_amount, and the stored payments row) so the
  // ledger invariant sum(payments) === invoices.paid_amount always holds,
  // even for sub-cent input amounts.
  const amt = round2(amount);
  if (!(Number.isFinite(amt) && amt > 0)) {
    throw new RpcError('Сумма должна быть положительным числом.', 400);
  }
  const method = args && args.method !== undefined ? args.method : 'cash';
  if (!PAYMENT_METHODS.includes(method)) {
    throw rpcT(RpcError, 'Неизвестный способ оплаты: {method}.', { method }, 400);
  }

  const invoiceId = args && args.invoice_id;
  if (!isPositiveInt(invoiceId)) {
    throw new RpcError('Счёт указан неверно.', 400);
  }

  const run = db.transaction(() => {
    const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
    if (!invoice) {
      throw new RpcError('Счёт не найден.', 400);
    }
    assertOwnBuilding(db, invoice, 'Счёт');   // BRANCH_MONEY_GUARD_V1
    { const refusal = moneyDocRefusal(db, invoice); if (refusal) throw new RpcError(refusal, 400); }   // ревью C1 + CARD_SALE_V1
    if (invoice.status === 'void' || invoice.status === 'refunded') {
      throw rpcT(RpcError, 'Счёт {status} — операция по нему недоступна.', { status: statusRu(invoice.status) }, 400);
    }

    const balance = round2(invoice.total_amount - invoice.paid_amount);
    if (balance <= 0) {
      throw new RpcError('Счёт уже оплачен — к оплате 0.', 400);
    }
    if (amt > balance) {
      throw rpcT(RpcError, 'Сумма больше остатка к оплате ({balance}).', { balance }, 400);
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
    const payInfo = db.prepare(`
      INSERT INTO payments (invoice_id, amount, method, cashier_id, shift_id, notes)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(invoiceId, amt, method, user.id, shiftId, payNotes);
    // DEPOSIT_WALLET_V1 — «с баланса» СПИСЫВАЕТ баланс. Раньше способ 'wallet'
    // принимался, а баланс не трогался: счёт закрывался деньгами из воздуха.
    if (method === 'wallet') {
      walletGuard(() => spendWallet(db, { patientId: invoice.patient_id, invoice, paymentId: payInfo.lastInsertRowid, amount: amt, user }));
    }
    // CARD_BALANCE_V1 — картой: остаток карты уменьшается в той же транзакции.
    if (method === 'gift_card') {
      walletGuard(() => spendCard(db, { cardId: args.card_id, invoice, paymentId: payInfo.lastInsertRowid, amount: amt, user }));
    }

    if (status === 'paid') {
      db.prepare(`
        UPDATE invoices
        SET paid_amount = ?, status = ?, paid_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
        WHERE id = ?
      `).run(newPaid, status, invoiceId);
      // CASHBACK_SERVER_V2 — счёт стал оплаченным: кэшбэк, один раз за жизнь счёта.
      if (invoice.status !== 'paid') creditCashbackOnPaid(db, db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId), user);
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

    return idemRemember(db, 'record_payment', args, user, { invoice: db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId) });
  });

  // DEPOSIT_WALLET_V1 — IMMEDIATE: баланс читается и списывается под одной
  // блокировкой записи, второй кассир ждёт и видит строку первого.
  const out = run.immediate();
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
  { const seen = idemReplay(db, 'record_payment_split', args); if (seen) return seen; }   // V3120_FIX — повтор той же формы

  const invoiceId = args && args.invoice_id;
  if (!isPositiveInt(invoiceId)) {
    throw new RpcError('Счёт указан неверно.', 400);
  }
  const raw = args && args.tenders;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 5) {
    throw new RpcError('Укажите от одной до пяти частей оплаты.', 400);
  }
  const tenders = raw.map((t, i) => {
    const amount = t && t.amount;
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
      throw rpcT(RpcError, 'Часть {n}: сумма должна быть положительным числом.', { n: i + 1 }, 400);
    }
    const amt = round2(amount);
    const method = t && t.method !== undefined ? t.method : 'cash';
    if (!PAYMENT_METHODS.includes(method)) {
      throw rpcT(RpcError, 'Часть {n}: неизвестный способ оплаты {method}.', { n: i + 1, method }, 400);
    }
    const notes = typeof (t && t.notes) === 'string' ? t.notes.slice(0, 200) : '';
    return { amt, method, notes, cardId: t && t.card_id };   // CARD_BALANCE_V1
  });
  const totalTendered = round2(tenders.reduce((s2, t) => s2 + t.amt, 0));

  const run = db.transaction(() => {
    const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
    if (!invoice) throw new RpcError('Счёт не найден.', 400);
    assertOwnBuilding(db, invoice, 'Счёт');   // BRANCH_MONEY_GUARD_V1
    { const refusal = moneyDocRefusal(db, invoice); if (refusal) throw new RpcError(refusal, 400); }   // ревью C1 + CARD_SALE_V1
    if (invoice.status === 'void' || invoice.status === 'refunded') {
      throw rpcT(RpcError, 'Счёт {status} — операция по нему недоступна.', { status: statusRu(invoice.status) }, 400);
    }
    const balance = round2(invoice.total_amount - invoice.paid_amount);
    if (balance <= 0) throw new RpcError('Счёт уже оплачен — к оплате 0.', 400);
    if (totalTendered > balance) {
      throw rpcT(RpcError, 'Сумма больше остатка к оплате ({balance}).', { balance }, 400);
    }
    // Ревью M2 — все части «с баланса» вместе против НАСТОЯЩЕГО баланса, до
    // первой записи: отказ называет баланс пациента, а не остаток после
    // первой части.
    const walletTotal = round2(tenders.filter((t) => t.method === 'wallet').reduce((s2, t) => s2 + t.amt, 0));
    if (walletTotal > 0) {
      if (!invoice.patient_id) throw new RpcError('У счёта нет пациента — оплатить с баланса нельзя.', 400);
      const have = walletBalance(db, invoice.patient_id);
      if (walletTotal > have) throw rpcT(RpcError, 'На балансе пациента только {have} — списать {amount} нельзя.', { have, amount: walletTotal }, 400);
    }

    const shiftId = ensureOpenShift(db, user).id;
    const insertPay = db.prepare(`
      INSERT INTO payments (invoice_id, amount, method, cashier_id, shift_id, notes)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const t of tenders) {
      const info = insertPay.run(invoiceId, t.amt, t.method, user.id, shiftId, t.notes);
      // DEPOSIT_WALLET_V1 — часть «с баланса» списывает баланс, как record_payment.
      if (t.method === 'wallet') {
        walletGuard(() => spendWallet(db, { patientId: invoice.patient_id, invoice, paymentId: info.lastInsertRowid, amount: t.amt, user }));
      }
      if (t.method === 'gift_card') {   // CARD_BALANCE_V1
        walletGuard(() => spendCard(db, { cardId: t.cardId, invoice, paymentId: info.lastInsertRowid, amount: t.amt, user }));
      }
    }

    const newPaid = round2(invoice.paid_amount + totalTendered);
    const status = invoiceStatusFor(invoice.total_amount, newPaid, invoice.status);
    if (status === 'paid') {
      db.prepare(`UPDATE invoices SET paid_amount = ?, status = ?, paid_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`)
        .run(newPaid, status, invoiceId);
      // CASHBACK_SERVER_V2 — см. record_payment.
      if (invoice.status !== 'paid') creditCashbackOnPaid(db, db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId), user);
    } else {
      db.prepare('UPDATE invoices SET paid_amount = ?, status = ? WHERE id = ?').run(newPaid, status, invoiceId);
    }

    db.prepare(`
      UPDATE visit_services
      SET status = 'queued'
      WHERE invoice_item_id IN (SELECT id FROM invoice_items WHERE invoice_id = ?)
        AND status NOT IN ('in_progress', 'completed')
    `).run(invoiceId);

    return idemRemember(db, 'record_payment_split', args, user, { invoice: db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId) });
  });

  const out = run.immediate();   // DEPOSIT_WALLET_V1 — см. record_payment
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
    throw new RpcError('Счёт указан неверно.', 400);
  }

  const run = db.transaction(() => {
    const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
    if (!invoice) throw new RpcError('Счёт не найден.', 400);
    assertOwnBuilding(db, invoice, 'Счёт');   // BRANCH_MONEY_GUARD_V1
    if (invoice.status === 'void' || invoice.status === 'refunded') {
      throw rpcT(RpcError, 'Счёт {status} — операция по нему недоступна.', { status: statusRu(invoice.status) }, 400);
    }
    const balance = round2(invoice.total_amount - invoice.paid_amount);
    if (balance <= 0) throw new RpcError('Счёт уже оплачен — к оплате 0.', 400);

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

// V3120_FIX (FATAL-1) — БАЗА ОСТАТКА СКИДКИ: сумма строк счёта без своей
// скидки. Читается ДО правки строки, как invoiceOwnDiscount, и уходит в
// repriceUnpaidInvoice как oldBase — остаток скидки (ручная / группа пациента)
// пересчитывается пропорционально новой базе. Без неё убранная строка VIP
// оставляла на счёте всю прежнюю скидку группы (38 250 вместо 33 000).
function invoiceRestBase(db, invoiceId) {
  return round2(db.prepare(`SELECT COALESCE(SUM(CASE WHEN COALESCE(discount_amount, 0) > 0 THEN 0 ELSE total END), 0) b
                              FROM invoice_items WHERE invoice_id = ?`).get(invoiceId).b);
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
//
// BILLING_AUDIT_FIX_V1 (B4) — ПОСЛЕ ПЕРЕСЧЁТА ДЕЙСТВУЕТ ТО ЖЕ ПРАВИЛО НУЛЯ, ЧТО
// ПРИ ВЫСТАВЛЕНИИ (settleZeroTotal ниже).
// (B5) — пол скидки группы пациента не ложится на счёт плательщика.
// (B1) — `oldBase`: возврат строки. Остаток скидки (ручная / категорийная на
// строки без своей) уменьшается пропорционально ушедшей базе, а не держится
// прежней суммой — иначе вся ручная скидка счёта легла бы на оставшиеся
// строки, и возврат одной услуги удешевлял бы другие.
// V3120_FIX (FATAL-1) — `oldBase` передают ВСЕ три двери (удалить, заменить,
// вернуть строку). Без него удаление ЭКГ у VIP 15 % держало прежние 38 250
// скидки на 220 000 (17,4 %) вместо 33 000: max(прежний остаток, пол группы)
// брал прежний остаток.
function repriceUnpaidInvoice(db, inv, oldOwn, { oldBase = null } = {}) {
  const left = db.prepare(`SELECT COALESCE(SUM(total), 0) s,
                                  COALESCE(SUM(discount_amount), 0) own,
                                  COALESCE(SUM(CASE WHEN COALESCE(discount_amount, 0) > 0 THEN 0 ELSE total END), 0) base
                             FROM invoice_items WHERE invoice_id = ?`).get(inv.id);
  const subtotal = round2(left.s);
  const own = round2(left.own);
  const base = round2(left.base);
  let oldRest = Math.max(round2((Number(inv.discount_amount) || 0) - oldOwn), 0);
  if (oldBase !== null) oldRest = oldBase > 0 ? round2(oldRest * Math.min(base, oldBase) / oldBase) : 0;
  const catPct = inv.payer_id ? 0 : patientCategoryDiscount(db, inv.patient_id);
  const floor = round2(base * catPct / 100);
  const rest = round2(Math.min(Math.max(oldRest, floor), base));
  const discount = Math.min(round2(own + rest), subtotal);
  const total = round2(subtotal - discount);
  db.prepare('UPDATE invoices SET subtotal = ?, discount_amount = ?, total_amount = ? WHERE id = ?')
    .run(subtotal, discount, total, inv.id);
  settleZeroTotal(db, inv.id);
  return db.prepare('SELECT * FROM invoices WHERE id = ?').get(inv.id);
}

// BILLING_AUDIT_FIX_V1 (B4) — СТАТУС СЧЁТА БЕЗ ДЕНЕГ ПОСЛЕ ПЕРЕСЧЁТА СУММЫ.
//
// Счёт, ставший нулевым (убрали платную услугу, заменили на бесплатную),
// оставался «Не оплачен» навсегда: record_payment отказывает при остатке 0, а
// строки висели «ожидает оплату». Теперь — как в createInvoiceForVisit
// (FREE_SERVICE_V1): ноль — это 'paid' с отметкой времени и строки в
// очередь. И обратно: бесплатный счёт, получивший платную строку, снова
// 'unpaid'. Касается только счёта, по которому денег нет (paid_amount 0).
function settleZeroTotal(db, invoiceId) {
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
  if (!inv || (Number(inv.paid_amount) || 0) !== 0) return;
  if (inv.status === 'void' || inv.status === 'refunded') return;
  const total = round2(Number(inv.total_amount) || 0);
  if (total <= 0 && inv.status !== 'paid') {
    db.prepare("UPDATE invoices SET status = 'paid', paid_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?").run(invoiceId);
    db.prepare(`
      UPDATE visit_services SET status = 'queued'
       WHERE invoice_item_id IN (SELECT id FROM invoice_items WHERE invoice_id = ?)
         AND status NOT IN ('in_progress', 'completed', 'collected', 'resulted')
    `).run(invoiceId);
  } else if (total > 0 && inv.status === 'paid') {
    db.prepare("UPDATE invoices SET status = 'unpaid', paid_at = NULL WHERE id = ?").run(invoiceId);
  }
}

// BILLING_AUDIT_FIX_V1 (B-minor) — статус счёта словами кассы, а не кодом
// («счёт уже paid»).
const STATUS_RU = { paid: 'оплачен', partial: 'оплачен частично', debt: 'переведён в долг', void: 'отменён', refunded: 'возвращён', unpaid: 'не оплачен' };
function statusRu(st) { return STATUS_RU[st] || st; }

// Счёт, который ещё можно править строками: денег по нему нет, и он либо
// «Не оплачен», либо бесплатный (итог 0), закрытый при выставлении. Бесплатный
// раньше отказывал «счёт уже paid», и убрать из него строку было нечем.
function editableInvoiceRefusal(inv) {
  if (!inv) return null;
  const free = inv.status === 'paid' && !(Number(inv.paid_amount) > 0) && !(Number(inv.total_amount) > 0);
  if (!(inv.paid_amount > 0) && (inv.status === 'unpaid' || free)) return null;
  return 'счёт уже ' + (inv.paid_amount > 0 ? 'оплачен (частично)' : statusRu(inv.status))
    + ' — сначала оформите возврат или отмените его в кассе.';
}

// INPATIENT_MONEY_FIX_V1 — ВЫПОЛНЕННАЯ РАБОТА НЕ СНИМАЕТСЯ И НЕ ПОДМЕНЯЕТСЯ.
//
// Один список «работа начата или сделана» на сервер — его же спрашивает отмена
// счёта (cashier.js voidInvoice). Прежде здесь стояли только in_progress и
// completed: взятый анализ ('collected') снимался вместе с пробой, а на
// готовом ('resulted') удаление падало 500 на внешнем ключе lab_results.
// Замена услуги перенесла бы результаты анализа на другую услугу. След работы
// (результат, документ, сообщение прибора) держит строку так же, как статус.
export const PERFORMED_LINE_STATUSES = ['collected', 'in_progress', 'resulted', 'completed'];
function assertNotPerformed(db, vs, verb) {
  const trace = db.prepare(`
    SELECT (EXISTS(SELECT 1 FROM lab_results WHERE visit_service_id = ?)
         OR EXISTS(SELECT 1 FROM visit_documents WHERE visit_service_id = ?)
         OR EXISTS(SELECT 1 FROM lab_device_messages WHERE visit_service_id = ?)) AS t`).get(vs.id, vs.id, vs.id);
  if (PERFORMED_LINE_STATUSES.includes(vs.status) || (trace && trace.t)) {
    throw new RpcError('услуга уже оказывается/оказана (взята проба, есть результат или документ) — ' + verb + ' нельзя.', 400);
  }
}

export function removeUnpaidService(db, args, user) {
  requireRole(user, REMOVE_SERVICE_ROLES);

  const vsId = args && args.visit_service_id;
  if (!isPositiveInt(vsId)) {
    throw new RpcError('Строка услуги указана неверно.', 400);
  }

  const run = db.transaction(() => {
    const vs = db.prepare('SELECT * FROM visit_services WHERE id = ?').get(vsId);
    if (!vs) throw new RpcError('Строка услуги не найдена.', 400);
    // BRANCH_MONEY_GUARD_V1 — удаление здесь означает надгробие в журнале (084),
    // то есть строка исчезнет и в том здании, где её сделали.
    assertOwnBuilding(db, vs, 'Услуга');
    assertNotPerformed(db, vs, 'удалить');   // INPATIENT_MONEY_FIX_V1

    // FK order: visit_services.invoice_item_id references invoice_items, so
    // the service LINE is deleted first, then its invoice item, then (if
    // emptied) the invoice itself. Guards run before anything is touched.
    const item = vs.invoice_item_id != null
      ? db.prepare('SELECT * FROM invoice_items WHERE id = ?').get(vs.invoice_item_id)
      : null;
    const inv = item ? db.prepare('SELECT * FROM invoices WHERE id = ?').get(item.invoice_id) : null;
    if (item && !inv) throw new RpcError('Счёт не найден.', 500);
    if (inv) assertOwnBuilding(db, inv, 'Счёт');   // BRANCH_MONEY_GUARD_V1
    { const refusal = editableInvoiceRefusal(inv); if (refusal) throw new RpcError(refusal, 400); }   // BILLING_AUDIT_FIX_V1 (B-minor)

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
      const oldBase = invoiceRestBase(db, inv.id);      // V3120_FIX (FATAL-1) — тоже ДО
      db.prepare('DELETE FROM invoice_items WHERE id = ?').run(item.id);
      const left = db.prepare('SELECT COUNT(*) n FROM invoice_items WHERE invoice_id = ?').get(inv.id);
      if (left.n === 0) {
        db.prepare('DELETE FROM invoices WHERE id = ?').run(inv.id);
        invoiceDeleted = true;
      } else {
        invoice = repriceUnpaidInvoice(db, inv, oldOwn, { oldBase });   // V3120_FIX (FATAL-1)
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
  if (!isPositiveInt(vsId)) throw new RpcError('Строка услуги указана неверно.', 400);
  if (!isPositiveInt(newServiceId)) throw new RpcError('Новая услуга указана неверно.', 400);

  const run = db.transaction(() => {
    const vs = db.prepare('SELECT * FROM visit_services WHERE id = ?').get(vsId);
    if (!vs) throw new RpcError('Строка услуги не найдена.', 400);
    assertOwnBuilding(db, vs, 'Услуга');   // BRANCH_MONEY_GUARD_V1
    assertNotPerformed(db, vs, 'заменить');   // INPATIENT_MONEY_FIX_V1
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
    if (item && !inv) throw new RpcError('Счёт не найден.', 500);
    if (inv) assertOwnBuilding(db, inv, 'Счёт');   // BRANCH_MONEY_GUARD_V1
    { const refusal = editableInvoiceRefusal(inv); if (refusal) throw new RpcError(refusal, 400); }   // BILLING_AUDIT_FIX_V1 (B-minor)

    const qty = vs.quantity || 1;
    // BILLING_AUDIT_FIX_V1 (B3) — НОВАЯ УСЛУГА ОЦЕНИВАЕТСЯ ТАК ЖЕ, КАК ПРИ
    // ВЫСТАВЛЕНИИ. Здесь стояла цена каталога и прежнее слово тарифа строки:
    // врач с личной ценой терял её, а тариф старой услуги («второй визит»)
    // оставался на строке новой. Теперь тариф спрашивается заново
    // (service_price_quote по дню ЭТОГО визита, сам визит исключён), а цена —
    // lineUnitPrice: личная цена врача строки, поверх — тариф. Одно правило с
    // кассой и выплатой врачу.
    const visitRow = db.prepare('SELECT patient_id, visit_date FROM visits WHERE id = ?').get(vs.visit_id);
    let tier = 'primary';
    if (visitRow && visitRow.patient_id) {
      const visitDay = db.prepare(`SELECT ${localDate('?')} AS d`).get(visitRow.visit_date).d;
      const q = servicePriceQuote(db, { patient_id: visitRow.patient_id, service_ids: [newServiceId], visit_id: vs.visit_id, date: visitDay }, user).quotes[newServiceId];
      if (q && (q.tier === 'secondary' || q.tier === 'repeat')) tier = q.tier;
    }
    const unit = round2(lineUnitPrice(db, { ...vs, service_id: newServiceId, clinic_item_id: null, consultation_type_id: null, price_tier: tier }, { service: svc }));
    const lineTotal = round2(unit * qty);
    // PACKAGES_V1 — другая услуга уже не услуга пакета: строка теряет пакет и
    // его скидку (скидка счёта уменьшается на неё же ниже).
    // FINAL_MONEY_FIX_V1 (M5) — строка стала УСЛУГОЙ: вид приёма консультации с
    // неё снимается, иначе остаётся химера «услуга + вид приёма».
    db.prepare('UPDATE visit_services SET service_id = ?, unit_price = ?, total = ?, package_id = NULL, price_tier = ?, consultation_type_id = NULL WHERE id = ?')
      .run(newServiceId, unit, lineTotal, tier, vsId);

    let invoice = null;
    if (item) {
      const oldOwn = invoiceOwnDiscount(db, inv.id);   // PACKAGES_V1 — ДО правки строки
      const oldBase = invoiceRestBase(db, inv.id);      // V3120_FIX (FATAL-1) — тоже ДО
      db.prepare('UPDATE invoice_items SET service_id = ?, description = ?, unit_price = ?, total = ?, discount_amount = 0 WHERE id = ?')
        .run(newServiceId, svc.name || '', unit, lineTotal, item.id);
      invoice = repriceUnpaidInvoice(db, inv, oldOwn, { oldBase });   // V3120_FIX (FATAL-1)
    }

    return { changed: true, line: db.prepare('SELECT * FROM visit_services WHERE id = ?').get(vsId), invoice };
  });

  const out = run();
  // CRM_CALENDAR_MIRROR_V1 (разбор ревью M1) — заявка CRM узнаёт о замене услуги
  // в записи; иначе зеркало приняло бы её за правку заявки и вернуло прежнюю.
  if (out && out.changed) syncLineFromVisit(db, vsId);
  return out;
}

// CASHIER_REFUND_V1 — возврат оплаты. Inserts a NEGATIVE payments row (so the
// sum(payments) === invoices.paid_amount invariant — and every shift-drawer and
// report SUM built on payments — stays honest automatically) and rolls the
// invoice's paid_amount/status back. Partial refunds allowed; the refundable
// amount is capped by BOTH the original payment (minus refunds already made
// against it, tagged REFUND#<id> in notes) and the invoice's current
// paid_amount, so repeated refunds can never drive anything below zero.

// The tag must match on a BOUNDARY, not a bare prefix: `LIKE 'REFUND#1%'`
// also matches REFUND#10 / REFUND#123, so refunds of other payments were
// counted against this one and legitimate refunds got refused. A refund
// note is either exactly the tag or the tag followed by ' <something>'
// (' — <reason>', BILLING_AUDIT_FIX_V1: ' LINE#<item> — <reason>'), so those
// are the only two shapes to match.
function refundedOfPayment(db, paymentId) {
  const tag = 'REFUND#' + paymentId;
  return round2(db.prepare(
    "SELECT COALESCE(SUM(-amount),0) s FROM payments WHERE amount < 0 AND (notes = ? OR notes LIKE ?)"
  ).get(tag, tag + ' %').s);
}

// BILLING_AUDIT_FIX_V1 (B1) — ОДИН ВОЗВРАТ ПО ОДНОМУ ПЛАТЕЖУ, внутри
// транзакции вызывающего. Общая часть refund_payment и refund_invoice_line:
// куда (деньгами тем же способом / на баланс / на ту же карту), потолок
// наличных по оплате с баланса (кэшбэк наличными не выдаётся), отрицательная
// строка платежа в ОТКРЫТОЙ смене возвращающего кассира и запись журнала
// баланса или карты. `refundable` — сколько ещё можно вернуть по этому платежу
// (для потолка «настоящих денег»). Итоги счёта двигает вызывающий.
function issueRefund(db, { invoice, p, amt, refundable, toBalanceRaw, cardFallbackRaw, reason, noteTag }, user) {
  const shiftId = ensureOpenShift(db, user).id;

  // DEPOSIT_WALLET_V1 — КУДА ВОЗВРАЩАЕМ: деньгами или на баланс пациента.
  //
  // Владелец: «cashier cancels the payment and can actually refund or push
  // to the deposit so on the next service it can be paid». Невролог после
  // оплаты говорит «не мой пациент» — деньги пациенту не нужны на руки, они
  // нужны на следующую услугу.
  //
  //   to_balance = true  — отрицательный платёж способом 'wallet' (он не
  //     приход: выручка и ящик не меняются, наличные из кассы НЕ выходят) и
  //     строка зачисления в журнал баланса. Выручка остаётся — деньги в
  //     клинике, это теперь аванс пациента, как принятый депозит.
  //   to_balance = false — как прежде: тем же способом, каким взяли.
  //
  // Платёж «с баланса» по умолчанию возвращается НА БАЛАНС: наличными этих
  // денег в кассе за этот счёт не брали. Вернуть его деньгами кассир может
  // только явным выбором (to_balance: false) — и тогда это наличные из ящика.
  // CARD_BALANCE_V1 — платёж картой возвращается НА ТУ ЖЕ КАРТУ, всегда:
  // это её остаток, наличными его не выдают и на баланс пациента не переносят.
  //
  // FINAL_MONEY_FIX_V1 (I2) — КРОМЕ КАРТЫ, ЗАКРЫТОЙ ВОЗВРАТОМ ПРОДАЖИ. Её
  // остаток уже выдан покупателю, карта выключена: сумма на ней пропала бы —
  // погасить ею нельзя, второй раз вернуть остаток касса не даёт. Такой возврат
  // идёт деньгами из кассы или на баланс пациента, и только по явному выбору
  // кассира (card_fallback: 'cash' | 'balance'); без выбора — отказ словами.
  let toCard = p.method === 'gift_card';
  let fallback = null;
  if (toCard) {
    const dead = cardClosedByRefund(db, p.id);
    if (dead) {
      if (cardFallbackRaw !== 'cash' && cardFallbackRaw !== 'balance') {
        throw new RpcError('Остаток карты «' + (dead.name || 'карта') + '» уже возвращён покупателю, карта закрыта — вернуть на неё нельзя. Выберите, как вернуть: деньгами или на баланс пациента.', 409);
      }
      fallback = cardFallbackRaw;
      toCard = false;
    }
  }
  const toBalance = toCard ? false : fallback ? fallback === 'balance' : (toBalanceRaw === undefined || toBalanceRaw === null
    ? p.method === 'wallet'
    : (toBalanceRaw === true || toBalanceRaw === 1));
  if (toBalance && !invoice.patient_id) throw new RpcError('У счёта нет пациента — зачислить на баланс некому.', 400);
  const refundMethod = toCard ? 'gift_card' : toBalance ? 'wallet' : (p.method === 'wallet' || p.method === 'gift_card' ? 'cash' : p.method);

  // Третья проверка, I2 — КЭШБЭК НАЛИЧНЫМИ НЕ ВЫДАЁТСЯ. Оплату с баланса
  // вернуть деньгами можно только в пределах настоящих денег пациента на
  // балансе (баланс вместе со всей ещё возвращаемой частью этого платежа
  // минус не откаченный кэшбэк); остальное возвращается только на баланс.
  // Считается от всей возвращаемой части, а не от запрошенной суммы: иначе
  // потолок зависел бы от того, как кассир разбил возврат.
  if (p.method === 'wallet' && !toBalance) {
    const cap = realMoney(db, invoice.patient_id, refundable);   // одно правило с refund_deposit
    if (amt > cap) {
      throw rpcT(RpcError, 'Деньгами можно вернуть не больше {cap}: остальное на балансе — кэшбэк, его возвращают только на баланс.', { cap }, 400);
    }
  }

  const refundInfo = db.prepare(`
    INSERT INTO payments (invoice_id, amount, method, cashier_id, shift_id, notes)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(invoice.id, -amt, refundMethod, user.id, shiftId,
    noteTag + (reason ? ' — ' + reason : ''));
  let card = null;
  if (toCard) {
    card = walletGuard(() => returnToCard(db, { paymentId: p.id, refundPaymentId: refundInfo.lastInsertRowid, invoice, amount: amt, user }));
  }
  if (toBalance) {
    walletGuard(() => creditWallet(db, { patientId: invoice.patient_id, invoice, paymentId: p.id, amount: amt, reason, user }));
  }
  return { toBalance, card, method: refundMethod };
}

// BILLING_AUDIT_FIX_V1 (B2) — ПОЛНЫЙ ВОЗВРАТ ЗАКРЫВАЕТ СЧЁТ.
//
// invoiceStatusFor никогда не отдаёт 'refunded': после возврата всех денег
// счёт возвращался в «Не оплачен» — пациент, которому вернули деньги за
// услугу, от которой он отказался, выглядел должником на всю сумму, в кассе,
// в долгах и в отчётах. Отмену при нуле касса предлагала только возврату «на
// баланс».
//
// Правило теперь одно на все способы возврата — денег на счёте не осталось:
//   • по умолчанию (void_when_zero не передан или true) счёт ОТМЕНЯЕТСЯ той
//     же дверью, что «Отменить счёт» (cashier.js voidInvoice): неначатые
//     услуги уходят с визита, если не отмечено keep_services; начатая и
//     сделанная работа остаётся в визите невыставленной, и раз по счёту был
//     возврат — врачу она не платится, пока её не выставят и не оплатят снова
//     (PAY_REFUND_V1, pay_refund_releases). Статус 'void', день отмены —
//     voided_at: отчёты (reports.js LIVE_INVOICE_SQL / REVENUE_INVOICE_SQL) и
//     касса (чипы «Отменён») считают его так же, как 'refunded';
//   • void_when_zero: false — ЯВНЫЙ выбор кассира «оставить счёт открытым»
//     (пациент переоформит оплату другим способом, счёт оплатят снова): счёт
//     остаётся «Не оплачен». Это единственный путь к открытому счёту после
//     полного возврата, и он назван словами, а не получается сам;
//   • пациент ещё на койке — счёт не отменяется (отмена его не выписывает):
//     он остаётся «Не оплачен», кассиру это сказано в void_note.
function closeFullyRefunded(db, invoiceId, args, reason, user) {
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
  if (!inv || inv.paid_amount > 0 || inv.status === 'void' || inv.status === 'refunded') return { voided: false };
  const adm = inv.admission_id ? db.prepare('SELECT status FROM admissions WHERE id = ?').get(inv.admission_id) : null;
  if (adm && IN_BED_STATUSES.includes(adm.status)) {
    return { voided: false, void_note: 'Пациент ещё в стационаре — счёт не отменён. Возврат проведён; счёт закроется при выписке или его отменяют в окне отмены с подтверждением.' };
  }
  const raw = args && args.void_when_zero;
  const voidWhenZero = raw === undefined || raw === null ? true : (raw === true || raw === 1);
  if (!voidWhenZero) return { voided: false };
  voidInvoice(db, { invoice_id: invoiceId, keep_services: args && (args.keep_services === true || args.keep_services === 1), reason: reason || null }, user);
  return { voided: true };
}

export function refundPayment(db, args, user) {
  requireRole(user, PAYMENT_ROLES);
  { const seen = idemReplay(db, 'refund_payment', args); if (seen) return seen; }   // V3120_FIX — повтор той же формы

  const paymentId = args && args.payment_id;
  if (!isPositiveInt(paymentId)) {
    throw new RpcError('Платёж указан неверно.', 400);
  }
  const reason = String((args && args.reason) || '').slice(0, 300);

  const run = db.transaction(() => {
    const p = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
    if (!p) {
      throw new RpcError('Платёж не найден.', 400);
    }
    if (p.amount <= 0) {
      throw new RpcError('Это возврат — вернуть возврат нельзя.', 400);
    }
    const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(p.invoice_id);
    if (!invoice) {
      throw new RpcError('Счёт не найден.', 400);
    }
    // BRANCH_MONEY_GUARD_V1 — возврат делают там, где взяли деньги: из ЭТОГО
    // ящика они не выходили, и отрицательный платёж отсюда исказил бы и смену
    // соседа, и его выручку.
    assertOwnBuilding(db, p, 'Платёж');
    assertOwnBuilding(db, invoice, 'Счёт');
    // Ревью C1 — платёж счёта депозита возвращает только refund_deposit.
    { const refusal = moneyDocRefusal(db, invoice); if (refusal) throw new RpcError(refusal, 400); }   // ревью C1 + CARD_SALE_V1

    const refunded = refundedOfPayment(db, p.id);
    const refundable = round2(Math.min(p.amount - refunded, invoice.paid_amount));
    if (refundable <= 0) {
      throw new RpcError('По этому платежу уже всё возвращено.', 400);
    }

    const rawAmt = args && args.amount !== undefined && args.amount !== null ? args.amount : refundable;
    if (typeof rawAmt !== 'number' || !Number.isFinite(rawAmt) || rawAmt <= 0) {
      throw new RpcError('Сумма должна быть положительным числом.', 400);
    }
    const amt = round2(rawAmt);
    if (amt > refundable) {
      throw rpcT(RpcError, 'Максимум к возврату по этому платежу: {amount}.', { amount: refundable }, 400);
    }

    // The refund lands in the REFUNDER's own open shift (a cash refund must
    // come out of the drawer that is open now, not the historical one).
    // SHIFT_AUTO_V2, same rule as record_payment: a refund as the first action
    // of the day OPENS the day's shift rather than falling back to shift_id
    // NULL — a NULL-shift refund is invisible to the X-report and to the
    // expected-drawer maths, so the till reconciles short with no explanation.
    const { toBalance, card } = issueRefund(db, {
      invoice, p, amt, refundable, toBalanceRaw: args && args.to_balance, cardFallbackRaw: args && args.card_fallback, reason, noteTag: 'REFUND#' + p.id,
    }, user);

    const newPaid = round2(invoice.paid_amount - amt);
    // V3120_FIX (MAJOR) — ЧАСТИЧНЫЙ ВОЗВРАТ ПО ОПЛАЧЕННОМУ СЧЁТУ — СКИДКА ПОСЛЕ
    // ПРОДАЖИ, А НЕ ДОЛГ.
    //
    // Счёт на 140 000 оплачен, пациенту вернули 40 000 (уступка, «не всё
    // сделали») — счёт становился «оплачен частично» с долгом 40 000: касса
    // требовала с человека ровно то, что ему только что отдала, дашборд
    // считал это долгом, а «Отчёт по долгам» — должником. Теперь такой возврат
    // уменьшает сумму счёта: discount_amount += возвращённое, total = оплачено,
    // статус и дата оплаты прежние. Платежи (+140 000, −40 000) не трогаются —
    // выручка и смена по-прежнему считаются по ним; доля врача: скидка счёта
    // ложится на строки (ITEM_DISCOUNT_SQL), а коэффициент возврата
    // (PAY_REFUND_V1: чистые деньги / MIN(получено, сумма счёта)) равен 1 —
    // вместе ровно та же доля, что прежде (100/140). Кэшбэк откатывается по
    // новым деньгам, как при любом возврате.
    //
    // «Вернуть и взять снова другим способом» — ЯВНЫЙ выбор кассира:
    // reopen_balance: true оставляет сумму счёта, и он ждёт доплаты (прежнее
    // поведение). Какую именно услугу возвращают, если это не уступка, — дверь
    // refund_invoice_line (строкой): она пересчитывает счёт по правилам строк.
    // Полный возврат (денег не осталось) — как прежде, closeFullyRefunded.
    // Счёт пациента, который ещё лежит на койке, пересобирается при выписке —
    // у него прежнее правило (ждёт доплаты), скидку ставят при выписке.
    const admRow = invoice.admission_id ? db.prepare('SELECT status FROM admissions WHERE id = ?').get(invoice.admission_id) : null;
    const reopen = (args && (args.reopen_balance === true || args.reopen_balance === 1)) || !!(admRow && IN_BED_STATUSES.includes(admRow.status));
    let postSaleDiscount = 0;
    if (invoice.status === 'paid' && newPaid > 0 && newPaid < invoice.total_amount && !reopen) {
      postSaleDiscount = round2(invoice.total_amount - newPaid);
      // V3120_FINAL (C1, мигр. 212) — эта часть скидки записывается ОТДЕЛЬНО
      // (post_sale_discount): отчёты делят её на все строки пропорционально
      // (пакета тоже) и умножают фикс врача и вознаграждения на оставшуюся
      // долю — те же деньги, что при возврате «с доплатой».
      const oldDiscount = Number(invoice.discount_amount) || 0;
      const newDiscount = round2(Math.min(oldDiscount + postSaleDiscount, Number(invoice.subtotal) || 0));
      db.prepare('UPDATE invoices SET paid_amount = ?, total_amount = ?, discount_amount = ?, post_sale_discount = ? WHERE id = ?')
        .run(newPaid, newPaid, newDiscount,
          round2((Number(invoice.post_sale_discount) || 0) + Math.max(0, newDiscount - oldDiscount)), invoice.id);
    } else {
      const status = invoiceStatusFor(invoice.total_amount, newPaid, invoice.status);
      if (status === 'paid') {
        db.prepare('UPDATE invoices SET paid_amount = ?, status = ? WHERE id = ?').run(newPaid, status, invoice.id);
      } else {
        // No longer fully paid — clear paid_at so reports don't count it as settled.
        db.prepare('UPDATE invoices SET paid_amount = ?, status = ?, paid_at = NULL WHERE id = ?').run(newPaid, status, invoice.id);
      }
    }
    // CASHBACK_SERVER_V2 — кэшбэк счёта следует за его новыми деньгами:
    // откат пропорционален возвращённому (сколько есть на балансе).
    adjustCashbackAfterRefund(db, invoice);

    // BILLING_AUDIT_FIX_V1 (B2) — денег на счёте не осталось: счёт закрыт
    // (отменён по умолчанию, см. closeFullyRefunded). Ре-ревью п.9 — в той же
    // транзакции, что возврат.
    const closed = newPaid <= 0 ? closeFullyRefunded(db, invoice.id, args, reason, user) : { voided: false };

    return idemRemember(db, 'refund_payment', args, user, { invoice: db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoice.id), to_balance: toBalance, voided: !!closed.voided,
      ...(postSaleDiscount > 0 ? { post_sale_discount: postSaleDiscount } : {}),
      ...(closed.void_note ? { void_note: closed.void_note } : {}), ...(card ? { to_card: card } : {}) });
  });

  return run.immediate();
}

// ═══════════════════════════════════════════════════════════════════════════
// BILLING_AUDIT_FIX_V1 (B1) — refund_invoice_line: ВЕРНУТЬ ОДНУ УСЛУГУ СЧЁТА
// ═══════════════════════════════════════════════════════════════════════════
//
// Возврат был только «по платежу»: счёт на 900 000, оплачено 500 000, вернули
// 90 000 за услугу, от которой пациент отказался, — счёт оставался на
// 900 000 с оплатой 410 000, и пациент выглядел должником на 490 000 за
// услугу, которую ему не оказали и деньги за которую вернули.
//
// Теперь услугу возвращают строкой, одной транзакцией:
//   1. строка уходит со счёта (позиция удаляется), счёт пересчитывается по
//      тем же правилам, что при правке строк (repriceUnpaidInvoice: скидки
//      пакета оставшихся строк, остаток ручной скидки — пропорционально
//      оставшейся базе, пол группы пациента);
//   2. ВОЗВРАЩАЕТСЯ ПЕРЕПЛАТА: сколько пациент заплатил сверх НОВОЙ суммы
//      счёта — MAX(0, оплачено − новая сумма), не больше стоимости строки.
//      Оплата счёта не делится по строкам (её принимают на счёт целиком),
//      поэтому деньги ложатся сперва на оставшиеся услуги. Оплачен целиком —
//      возвращается вся стоимость строки; оплачен частично — ровно та часть,
//      которой больше нечего покрывать (в примере выше: счёт 810 000,
//      оплачено 500 000, возвращать нечего, долг 310 000 — а не 490 000).
//      Возвращается по платежам, начиная с последнего, каждый — своим
//      способом (или на баланс при to_balance, карта — на ту же карту), с
//      пометкой REFUND#<платёж> LINE#<позиция>: потолки возврата по платежу,
//      кэшбэк и смена считают его как любой возврат;
//   3. строка визита: неначатая уходит с визита (товар — обратно по
//      источникам, талон очереди снимается); начатая или сделанная работа
//      остаётся в визите НЕВЫСТАВЛЕННОЙ со своим статусом, и врачу она не
//      платится (pay_refund_releases, PAY_REFUND_V1), пока её не выставят и
//      не оплатят снова;
//   4. кэшбэк следует за новыми деньгами счёта (adjustCashbackAfterRefund,
//      откат пропорциональный); счёт, ставший этим оплаченным, получает
//      кэшбэк по обычному правилу (один раз за жизнь счёта);
//   5. последняя строка счёта и денег не осталось — счёт закрывается, как при
//      полном возврате (B2, closeFullyRefunded).
// Строка стационара так не возвращается: её счёт собирается при выписке —
// отказ называет путь.
export function refundInvoiceLine(db, args, user) {
  requireRole(user, PAYMENT_ROLES);
  const itemId = args && args.invoice_item_id;
  if (!isPositiveInt(itemId)) throw new RpcError('Строка счёта указана неверно.', 400);
  const reason = String((args && args.reason) || '').slice(0, 300);

  const run = db.transaction(() => {
    const item = db.prepare('SELECT * FROM invoice_items WHERE id = ?').get(itemId);
    if (!item) throw new RpcError('Строка счёта не найдена.', 400);
    const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(item.invoice_id);
    if (!inv) throw new RpcError('Счёт не найден.', 500);
    assertOwnBuilding(db, inv, 'Счёт');
    assertOwnBuilding(db, item, 'Строка счёта');
    { const refusal = moneyDocRefusal(db, inv); if (refusal) throw new RpcError(refusal, 400); }
    if (inv.status === 'void' || inv.status === 'refunded') throw new RpcError('Счёт уже отменён — возвращать по нему нечего.', 400);
    // Денег по счёту нет — это не возврат, а правка счёта: строку убирают из
    // визита (корзина в карте пациента, remove_unpaid_service).
    if (!(Number(inv.paid_amount) > 0)) throw new RpcError('По счёту ещё не принято денег — уберите услугу из визита, возвращать нечего.', 400);
    if (db.prepare('SELECT 1 FROM admission_services WHERE invoice_item_id = ? LIMIT 1').get(itemId)) {
      throw new RpcError('Это строка стационара — её убирают из счёта госпитализации (до оплаты) или возвращают оплатой по платежу.', 400);
    }
    const vs = db.prepare('SELECT * FROM visit_services WHERE invoice_item_id = ?').get(itemId) || null;
    if (vs) assertOwnBuilding(db, vs, 'Услуга');

    const oldTotal = round2(Number(inv.total_amount) || 0);
    const oldPaid = round2(Number(inv.paid_amount) || 0);
    const oldOwn = invoiceOwnDiscount(db, inv.id);
    const oldBase = invoiceRestBase(db, inv.id);

    // 3. Строка визита — до удаления позиции (внешний ключ).
    let performed = false;
    let lineName = item.description || '';
    let sources = [];
    if (vs) {
      const trace = db.prepare(`
        SELECT (EXISTS(SELECT 1 FROM lab_results WHERE visit_service_id = ?)
             OR EXISTS(SELECT 1 FROM visit_documents WHERE visit_service_id = ?)
             OR EXISTS(SELECT 1 FROM lab_device_messages WHERE visit_service_id = ?)) AS t`).get(vs.id, vs.id, vs.id);
      performed = PERFORMED_LINE_STATUSES.includes(vs.status) || !!(trace && trace.t);
      if (performed) {
        db.prepare('UPDATE visit_services SET invoice_item_id = NULL WHERE id = ?').run(vs.id);
      } else {
        sources = vs.clinic_item_id != null ? restoreSources(db, 'visit', vs.id, vs.clinic_item_id, vs.quantity, user) : [];
        db.prepare('DELETE FROM service_queue_tickets WHERE visit_service_id = ?').run(vs.id);
        db.prepare('DELETE FROM visit_services WHERE id = ?').run(vs.id);
      }
    }
    db.prepare('DELETE FROM invoice_items WHERE id = ?').run(itemId);

    // 1. Пересчёт суммы счёта.
    const leftN = db.prepare('SELECT COUNT(*) n FROM invoice_items WHERE invoice_id = ?').get(inv.id).n;
    // V3120_FINAL (C1) — скидка после продажи (частичный возврат по счёту,
    // мигр. 212) лежит на ВСЕХ строках пропорционально. Счёт пересчитывается
    // без неё, а потом она ложится снова — в той доле, что осталась от счёта:
    // строка стоит столько, сколько за неё осталось заплачено, а не прежнюю
    // цену (иначе возврат строки после уступки отдавал бы меньше или больше).
    const oldPostSale = round2(Number(inv.post_sale_discount) || 0);
    if (leftN === 0) {
      db.prepare('UPDATE invoices SET subtotal = 0, discount_amount = 0, total_amount = 0, post_sale_discount = 0 WHERE id = ?').run(inv.id);
    } else {
      // paid_amount пока прежний — settleZeroTotal внутри не тронет счёт с деньгами.
      repriceUnpaidInvoice(db, { ...inv, discount_amount: round2((Number(inv.discount_amount) || 0) - oldPostSale), paid_amount: oldPaid }, oldOwn, { oldBase });
      if (oldPostSale > 0) {
        const r = db.prepare('SELECT discount_amount, total_amount FROM invoices WHERE id = ?').get(inv.id);
        const preTotal = round2(oldTotal + oldPostSale);
        const ps = preTotal > 0 ? round2(Math.min(oldPostSale * r.total_amount / preTotal, r.total_amount)) : 0;
        db.prepare('UPDATE invoices SET discount_amount = ?, total_amount = ?, post_sale_discount = ? WHERE id = ?')
          .run(round2(r.discount_amount + ps), round2(r.total_amount - ps), ps, inv.id);
      }
    }
    const newTotal = round2(db.prepare('SELECT total_amount t FROM invoices WHERE id = ?').get(inv.id).t);
    const lineValue = round2(oldTotal - newTotal);

    // 2. Переплата — по платежам с последнего.
    const refundAmt = round2(Math.min(Math.max(0, oldPaid - newTotal), oldPaid));
    let left = refundAmt;
    let paidNow = oldPaid;
    let toBalanceAny = false;
    const cards = [];
    if (left > 0) {
      const pays = db.prepare('SELECT * FROM payments WHERE invoice_id = ? AND amount > 0 ORDER BY id DESC').all(inv.id);
      for (const p of pays) {
        if (left <= 0) break;
        assertOwnBuilding(db, p, 'Платёж');
        const refundable = round2(Math.min(p.amount - refundedOfPayment(db, p.id), paidNow));
        if (refundable <= 0) continue;
        const take = round2(Math.min(left, refundable));
        const r = issueRefund(db, {
          invoice: inv, p, amt: take, refundable, toBalanceRaw: args && args.to_balance, cardFallbackRaw: args && args.card_fallback, reason,
          noteTag: 'REFUND#' + p.id + ' LINE#' + itemId,
        }, user);
        if (r.toBalance) toBalanceAny = true;
        if (r.card) cards.push(r.card);
        left = round2(left - take);
        paidNow = round2(paidNow - take);
      }
      if (left > 0.005) throw new RpcError('Платежей счёта не хватает на возврат строки — проверьте платежи счёта.', 400);
    }
    const newPaid = round2(oldPaid - refundAmt);

    // PAY_REFUND_V1 — сделанная работа, возвращённая пациенту, врачу не
    // платится, пока её не выставят и не оплатят снова. Отметка ставится ВСЕГДА
    // (не только когда пациенту вернули деньги): строка ушла со счёта как
    // возвращённая, а не как «убрать до оплаты».
    if (vs && performed) markRefundRelease(db, { invoiceId: inv.id, kind: 'out', lineIds: [vs.id], always: true });

    // Статус по новым деньгам.
    let closed = { voided: false };
    const after = db.prepare('SELECT * FROM invoices WHERE id = ?').get(inv.id);
    if (newTotal <= 0 && newPaid <= 0 && refundAmt > 0 && leftN > 0) {
      // FINAL_MONEY_FIX_V1 (M2) — В СЧЁТЕ ОСТАЛИСЬ ТОЛЬКО БЕСПЛАТНЫЕ УСЛУГИ.
      // Сумма ноль, денег ноль — но строки есть, и отменять счёт нельзя: отмена
      // снимала бы с визита неначатую бесплатную услугу и отпускала сделанную.
      // Такой счёт — как бесплатный при выставлении: 'paid' на ноль, строки в
      // очередь (settleZeroTotal). Отменяется счёт, только когда строк не
      // осталось вовсе.
      db.prepare("UPDATE invoices SET paid_amount = 0, paid_at = NULL, status = 'unpaid' WHERE id = ?").run(inv.id);
      adjustCashbackAfterRefund(db, inv);
      settleZeroTotal(db, inv.id);
    } else if (newTotal <= 0 && newPaid <= 0 && refundAmt > 0) {
      // Денег и строк не осталось: 'unpaid' — ступень, с которой счёт
      // закрывается отменой (жизненный цикл), как у полного возврата платежа.
      db.prepare("UPDATE invoices SET paid_amount = ?, paid_at = NULL, status = 'unpaid' WHERE id = ?").run(newPaid, inv.id);
      adjustCashbackAfterRefund(db, inv);
      closed = closeFullyRefunded(db, inv.id, args, reason, user);
    } else {
      const status = invoiceStatusFor(newTotal, newPaid, inv.status);
      if (status === 'paid') {
        db.prepare("UPDATE invoices SET paid_amount = ?, status = 'paid', paid_at = COALESCE(paid_at, strftime('%Y-%m-%dT%H:%M:%SZ','now')) WHERE id = ?").run(newPaid, inv.id);
        db.prepare(`
          UPDATE visit_services SET status = 'queued'
           WHERE invoice_item_id IN (SELECT id FROM invoice_items WHERE invoice_id = ?)
             AND status NOT IN ('in_progress', 'completed', 'collected', 'resulted')
        `).run(inv.id);
      } else {
        db.prepare('UPDATE invoices SET paid_amount = ?, status = ?, paid_at = NULL WHERE id = ?').run(newPaid, status, inv.id);
      }
      if (refundAmt > 0) adjustCashbackAfterRefund(db, inv);
      if (status === 'paid' && after.status !== 'paid' && newPaid > 0) {
        creditCashbackOnPaid(db, db.prepare('SELECT * FROM invoices WHERE id = ?').get(inv.id), user);
      }
    }

    // Журнал счёта: что вернули и сколько денег вышло.
    const actor = db.prepare('SELECT full_name, role FROM users WHERE id = ?').get(user.id) || {};
    const final = db.prepare('SELECT * FROM invoices WHERE id = ?').get(inv.id);
    db.prepare(`
      INSERT INTO invoice_audit_log (invoice_id, invoice_number, visit_id, action, from_status, to_status, amount, refund_amount, actor_user_id, actor_name, actor_role, reason, notes)
      VALUES (?, ?, ?, 'refund_line', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(inv.id, inv.invoice_number || null, inv.visit_id || null, inv.status, final.status, lineValue, refundAmt,
        user.id, actor.full_name || null, actor.role || null, reason || null,
        'Возвращена услуга: ' + (lineName || '—') + (vs ? (performed ? ' (работа сделана — осталась в визите невыставленной)' : ' (снята с визита)') : ''));

    return {
      invoice: final,
      refunded: refundAmt,
      line_value: lineValue,
      to_balance: toBalanceAny,
      line_kept: !!(vs && performed),
      voided: !!closed.voided,
      sources,
      ...(closed.void_note ? { void_note: closed.void_note } : {}),
      ...(cards.length ? { to_card: cards[cards.length - 1] } : {}),
    };
  });

  const out = run.immediate();
  return out;
}

// BED_CONSOLE_V1 — счёт по госпитализации: выбранные небиллованные строки
// admission_services (услуги и товары) собираются в один invoice
// (admission_id, mig 040); строки получают invoice_item_id + status
// 'completed'. Цены авторитетны из каталога (services.price /
// products.sale_price), как в визитном биллинге.
export function createInvoiceForAdmission(db, args, user) {
  requireRole(user, CREATE_INVOICE_ROLES);

  const admissionId = args && args.admission_id;
  if (!isPositiveInt(admissionId)) throw new RpcError('Госпитализация указана неверно.', 400);
  const ids = args && args.admission_service_ids;
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every(isPositiveInt)) {
    throw new RpcError('Не выбрано ни одной строки стационара.', 400);
  }
  if (new Set(ids).size !== ids.length) throw new RpcError('Одна и та же строка стационара выбрана дважды.', 400);

  return buildAdmissionInvoice(db, admissionId, ids, user);
}

// CASE_OVERVIEW_V1 — та же сборка счёта БЕЗ проверки роли кассы: её зовёт и
// касса (createInvoiceForAdmission выше, с ролью), и выписка врача
// (admission-bill.js — право там уже проверено заявкой на выписку).
// Строки проверены вызывающим: свои, не выставлены, «В счёт».
export function buildAdmissionInvoice(db, admissionId, ids, user) {
  const run = db.transaction(() => {
    const adm = db.prepare('SELECT * FROM admissions WHERE id = ?').get(admissionId);
    if (!adm) throw new RpcError('Госпитализация не найдена.', 400);

    const getService = db.prepare('SELECT price, name FROM services WHERE id = ?');
    const getProduct = db.prepare('SELECT sale_price, name FROM products WHERE id = ?');
    const priced = ids.map((id) => {
      const row = db.prepare('SELECT * FROM admission_services WHERE id = ?').get(id);
      if (!row) throw rpcT(RpcError, 'Строка стационара №{id} не найдена.', { id }, 400);
      if (row.admission_id !== admissionId) throw rpcT(RpcError, 'Строка стационара №{id} относится к другой госпитализации.', { id }, 400);
      if (row.invoice_item_id !== null) throw rpcT(RpcError, 'Строка стационара №{id} уже в счёте.', { id }, 400);
      if (!row.billable) throw new RpcError('строка в учёте расходов — отметьте «В счёт», чтобы включить её в счёт пациента.', 400);
      let name = '', svc = null, prod = null;
      if (row.service_id != null) {
        svc = getService.get(row.service_id);
        if (!svc) throw rpcT(RpcError, 'Услуга №{id} не найдена.', { id: row.service_id }, 400);
        name = svc.name;
      } else if (row.clinic_item_id != null) {
        prod = getProduct.get(row.clinic_item_id);
        if (!prod) throw rpcT(RpcError, 'Товар №{id} не найден.', { id: row.clinic_item_id }, 400);
        name = prod.name;
      }
      // Same precedence as visit billing (the doctor's own price wins), with no
      // visit tier — PAY_BASIS_PERFORMED_V1: one rule, domain/pricing.js.
      const qty = row.quantity;
      if (!(Number.isFinite(qty) && qty > 0)) throw rpcT(RpcError, 'Неверное количество в строке стационара №{id}.', { id: row.id }, 400);
      // INPATIENT_MONEY_FIX_V1 — ПРОЖИВАНИЕ идёт в счёт своей СОХРАНЁННОЙ суммой:
      // в ней уже скидка на койку и ставки всех коек, на которых лежал пациент
      // (accommodation.js). «Ставка × сутки» здесь теряла скидку (акт 270 000,
      // счёт 300 000), а пустое имя оставляло в счёте строку без описания —
      // теперь это «Проживание в палате» (ACCOMMODATION_LABEL): то же имя, что
      // у строки на экране и в отчётах, и одно на все счета — отчёты
      // группируют по описанию.
      if (row.service_id == null && row.clinic_item_id == null
          && String(row.notes || '').startsWith(ACCOMMODATION_NOTE_PREFIX)) {
        const line = round2(row.total);
        return { row, unit: round2(line / qty), qty, line, name: ACCOMMODATION_LABEL };
      }
      // Товар — сохранённой ценой строки (productLineUnitPrice), услуга — по
      // тому же правилу, по которому её оценили при заведении (личная цена
      // врача, иначе каталог).
      const unit = lineUnitPrice(db, row, { service: svc, product: prod, tiered: false });
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
      clearRefundRelease(db, 'in', [row.id]);   // FINAL_MONEY_FIX_V1 (M1)
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
  if (!isPositiveInt(lineId)) throw new RpcError('Строка указана неверно.', 400);

  const run = db.transaction(() => {
    const line = db.prepare('SELECT * FROM admission_services WHERE id = ?').get(lineId);
    if (!line) throw new RpcError('Строка не найдена.', 400);
    if (line.invoice_item_id == null) throw new RpcError('строка и так не в счёте.', 400);
    const item = db.prepare('SELECT * FROM invoice_items WHERE id = ?').get(line.invoice_item_id);
    if (!item) throw new RpcError('Строка счёта не найдена.', 500);
    const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(item.invoice_id);
    if (!inv) throw new RpcError('Счёт не найден.', 500);
    assertOwnBuilding(db, inv, 'Счёт');   // BRANCH_MONEY_GUARD_V1
    if (inv.paid_amount > 0 || inv.status !== 'unpaid') {
      throw new RpcError('счёт уже ' + (inv.paid_amount > 0 ? 'оплачен (частично)' : inv.status) + ' — сначала отмените его в кассе.', 400);
    }

    // PAY_REFUND_V1 — строка уходит со счёта, по которому были возвраты: без
    // нового оплаченного счёта врачу она не платится (domain/pay-releases.js).
    markRefundRelease(db, { invoiceId: inv.id, kind: 'in', lineIds: [lineId] });
    db.prepare("UPDATE admission_services SET invoice_item_id = NULL, status = 'added' WHERE id = ?").run(lineId);
    db.prepare('DELETE FROM invoice_items WHERE id = ?').run(item.id);
    voidReleasedDoseLines(db, [lineId], user);   // V3120_FINAL (S1) — снятая доза не остаётся к оплате
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

// FINAL_MONEY_FIX_V1 (I1) — visit_refunded_lines: невыставленные строки визита,
// за которые пациенту вернули деньги (строкой или отменой после возврата).
// Окно визита не отмечает их для счёта по умолчанию и подписывает
// «возвращено»; выставить заново можно только явным выбором (rebill_refunded).
// Чтение: только номера строк этого визита.
export function visitRefundedLines(db, args, user) {
  if (!user) throw new RpcError('Нужно войти в систему.', 401);
  const visitId = args && args.visit_id;
  if (!isPositiveInt(visitId)) throw new RpcError('Визит указан неверно.', 400);
  const ids = db.prepare('SELECT id FROM visit_services WHERE visit_id = ? AND invoice_item_id IS NULL').all(visitId).map((r) => r.id);
  return { line_ids: refundedLineIds(db, 'out', ids) };
}
