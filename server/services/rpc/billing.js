// Server-side billing RPCs. All money math (subtotals, balances, statuses)
// is computed here from DB rows — client-supplied amounts are never trusted.
// Both handlers run their DB work inside db.transaction(...)() for atomicity.

import { ensureOpenShift } from './cashier.js';   // SHIFT_AUTO_V2
import { invoiceStatusFor } from '../domain/money.js';
import { unitPriceFor } from '../domain/pricing.js';
import { hasAnyRole } from '../roles.js';

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

// INV-<2-digit year>-<5-digit seq>, seq scoped to the current year via a
// dedicated per-year counter table (invoice_counters). This is monotonic
// even if invoices are later deleted or a number is otherwise skipped —
// unlike COUNT(*)+1, which would reuse a number after a deletion.
export function nextInvoiceNumber(db) {
  const year4 = db.prepare("SELECT strftime('%Y','now') AS y").get().y; // e.g. '2026'
  const yy = year4.slice(-2);
  db.prepare('INSERT INTO invoice_counters (year, next_seq) VALUES (?, 1) ON CONFLICT(year) DO NOTHING').run(year4);
  const seq = db.prepare('SELECT next_seq FROM invoice_counters WHERE year = ?').get(year4).next_seq;
  db.prepare('UPDATE invoice_counters SET next_seq = next_seq + 1 WHERE year = ?').run(year4);
  return `INV-${yy}-${String(seq).padStart(5, '0')}`;
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
    const getService = db.prepare('SELECT price, name FROM services WHERE id = ?');
    const getProduct = db.prepare('SELECT sale_price, name FROM products WHERE id = ?');
    const priced = rows.map((row) => {
      let unit = row.unit_price;
      let svcName = null;
      if (row.service_id != null) {
        const svc = getService.get(row.service_id);
        if (!svc) {
          throw new RpcError(`service ${row.service_id} not found`, 400);
        }
        unit = unitPriceFor(db, {
          doctorId: row.doctor_id,
          serviceId: row.service_id,
          catalogPrice: svc.price,
        });
        svcName = svc.name;
      } else if (row.clinic_item_id != null) {
        const prod = getProduct.get(row.clinic_item_id);
        if (!prod) {
          throw new RpcError(`product ${row.clinic_item_id} not found`, 400);
        }
        unit = prod.sale_price;
        svcName = prod.name;
      }
      const qty = row.quantity;
      if (!(Number.isFinite(qty) && qty > 0)) {
        throw new RpcError(`invalid quantity on visit_service ${row.id}`, 400);
      }
      const line = round2(unit * qty);
      return { row, unit, qty, line, svcName };
    });

    const subtotal = round2(priced.reduce((sum, p) => sum + p.line, 0));
    // WIZARD_DISCOUNT_V1 — optional booking-time discount (loyalty % / promo
    // code, computed by the visit wizard). Clamped to [0, subtotal] so a
    // client can never produce a negative invoice.
    const discountRaw = (args && args.discount_amount !== undefined) ? args.discount_amount : 0;
    if (!(typeof discountRaw === 'number' && Number.isFinite(discountRaw) && discountRaw >= 0)) {
      throw new RpcError('discount_amount must be a non-negative number.', 400);
    }
    const discount = round2(Math.min(discountRaw, subtotal));
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
      INSERT INTO invoice_items (invoice_id, service_id, description, quantity, unit_price, total)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const linkVisitService = db.prepare('UPDATE visit_services SET invoice_item_id = ? WHERE id = ?');
    const syncVisitService = db.prepare('UPDATE visit_services SET unit_price = ?, total = ? WHERE id = ?');

    for (const { row, unit, qty, line, svcName } of priced) {
      const description = svcName || '';
      const itemInfo = insertItem.run(invoiceId, row.service_id, description, qty, unit, line);
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
    return { invoice, items };
  });

  return run();
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

  return run();
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

  return run();
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

  return run();
}

// SVC_UNPAID_REMOVE_V1 — remove a service line AND repair its invoice in one
// atomic action (patient card «Услуги» trash button). Allowed only while no
// money has moved: an unpaid invoice shrinks by the line (discount re-clamped),
// an emptied invoice is deleted outright; paid/partial/debt bills refuse.
// An un-invoiced line simply deletes.
const REMOVE_SERVICE_ROLES = ['admin', 'registrar'];

export function removeUnpaidService(db, args, user) {
  requireRole(user, REMOVE_SERVICE_ROLES);

  const vsId = args && args.visit_service_id;
  if (!isPositiveInt(vsId)) {
    throw new RpcError('visit_service_id must be a positive integer.', 400);
  }

  const run = db.transaction(() => {
    const vs = db.prepare('SELECT * FROM visit_services WHERE id = ?').get(vsId);
    if (!vs) throw new RpcError('service line not found.', 400);
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
    if (inv && (inv.paid_amount > 0 || inv.status !== 'unpaid')) {
      throw new RpcError('счёт уже ' + (inv.paid_amount > 0 ? 'оплачен (частично)' : inv.status) + ' — сначала отмените его в кассе.', 400);
    }

    db.prepare('DELETE FROM visit_services WHERE id = ?').run(vsId);

    let invoiceDeleted = false;
    let invoice = null;
    if (item) {
      db.prepare('DELETE FROM invoice_items WHERE id = ?').run(item.id);
      const left = db.prepare('SELECT COALESCE(SUM(total), 0) s, COUNT(*) n FROM invoice_items WHERE invoice_id = ?').get(inv.id);
      if (left.n === 0) {
        db.prepare('DELETE FROM invoices WHERE id = ?').run(inv.id);
        invoiceDeleted = true;
      } else {
        const subtotal = round2(left.s);
        const discount = Math.min(round2(inv.discount_amount), subtotal);
        db.prepare('UPDATE invoices SET subtotal = ?, discount_amount = ?, total_amount = ? WHERE id = ?')
          .run(subtotal, discount, round2(subtotal - discount), inv.id);
        invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(inv.id);
      }
    }
    return { removed: true, invoice_deleted: invoiceDeleted, invoice };
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
    if (vs.status === 'in_progress' || vs.status === 'completed') {
      throw new RpcError('услуга уже оказывается/оказана — заменить нельзя.', 400);
    }
    const svc = db.prepare('SELECT * FROM services WHERE id = ? AND active = 1').get(newServiceId);
    if (!svc) throw new RpcError('новая услуга не найдена или неактивна.', 400);

    const item = vs.invoice_item_id != null
      ? db.prepare('SELECT * FROM invoice_items WHERE id = ?').get(vs.invoice_item_id)
      : null;
    const inv = item ? db.prepare('SELECT * FROM invoices WHERE id = ?').get(item.invoice_id) : null;
    if (item && !inv) throw new RpcError('invoice not found.', 500);
    if (inv && (inv.paid_amount > 0 || inv.status !== 'unpaid')) {
      throw new RpcError('счёт уже ' + (inv.paid_amount > 0 ? 'оплачен (частично)' : inv.status) + ' — сначала отмените его в кассе.', 400);
    }

    const qty = vs.quantity || 1;
    const lineTotal = round2(svc.price * qty);
    db.prepare('UPDATE visit_services SET service_id = ?, unit_price = ?, total = ? WHERE id = ?')
      .run(newServiceId, svc.price, lineTotal, vsId);

    let invoice = null;
    if (item) {
      db.prepare('UPDATE invoice_items SET service_id = ?, description = ?, unit_price = ?, total = ? WHERE id = ?')
        .run(newServiceId, svc.name || '', svc.price, lineTotal, item.id);
      const sub = db.prepare('SELECT COALESCE(SUM(total), 0) s FROM invoice_items WHERE invoice_id = ?').get(inv.id).s;
      const subtotal = round2(sub);
      const discount = Math.min(round2(inv.discount_amount), subtotal);
      db.prepare('UPDATE invoices SET subtotal = ?, discount_amount = ?, total_amount = ? WHERE id = ?')
        .run(subtotal, discount, round2(subtotal - discount), inv.id);
      invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(inv.id);
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
      let unit = row.unit_price, name = '';
      if (row.service_id != null) {
        const svc = getService.get(row.service_id);
        if (!svc) throw new RpcError(`service ${row.service_id} not found`, 400);
        // Same precedence as visit billing: the performing doctor's own price wins.
        unit = unitPriceFor(db, {
          doctorId: row.doctor_id,
          serviceId: row.service_id,
          catalogPrice: svc.price,
        });
        name = svc.name;
      } else if (row.clinic_item_id != null) {
        const prod = getProduct.get(row.clinic_item_id);
        if (!prod) throw new RpcError(`product ${row.clinic_item_id} not found`, 400);
        unit = prod.sale_price; name = prod.name;
      }
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
