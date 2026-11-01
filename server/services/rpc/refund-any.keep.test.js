// REFUND_ANY_V1 (2026-10-29) — «ОСТАВИТЬ УСЛУГУ В ВИЗИТЕ» И СДЕЛАННАЯ РАБОТА.
//
// Окно «Вернуть услугу» слало keep_services: false всегда, а сервер его не
// читал: неначатая строка уходила с визита, и выставить её заново (другой
// ценой, другим счётом) было нечего. Теперь:
//   • keep_services: true — неначатая строка остаётся в визите невыставленной
//     ('added', номер очереди и талон сняты) и помечена «возвращено»
//     (pay_refund_releases 'out'): «Ждут счёта» её не показывает, выставляют её
//     только явным выбором (rebill_refunded); товар остаётся у пациента;
//   • invoice_line_work — что уже сделано по строкам счёта (проба, результат,
//     документ, работа идёт или окончена): окно предупреждает и просит галочку.
// Правило денег после каждой операции: сумма платежей = «оплачено» по счёту.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { createInvoiceForVisit, recordPayment, refundInvoiceLine, invoiceLineWork, visitRefundedLines, lineHasWork, PERFORMED_LINE_STATUSES } from './billing.js';
import { openCashShift, cashierUnbilled } from './cashier.js';
import { RPC } from './index.js';
import { isReadOnlyRpc } from '../control/gate.js';

const registrar = { id: 7, role: 'registrar' };
const cashier = { id: 9, role: 'cashier', full_name: 'Кассир' };
const DOC = 20;

// n = 1 — в счёте одна строка (УЗИ, c); иначе три (приём a, ОАК b, УЗИ c).
function seed(n = 3) {
  const db = openDb(':memory:'); migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, role, full_name) VALUES (7,'reg','x','registrar','Регистратор')").run();
  db.prepare("INSERT INTO users (id, username, password_hash, role, full_name) VALUES (9,'cash','x','cashier','Кассир')").run();
  db.prepare("INSERT INTO users (id, username, password_hash, role, full_name, is_doctor) VALUES (?,'doc','x','doctor','Врач',1)").run(DOC);
  const pid = db.prepare("INSERT INTO patients (full_name, branch_id) VALUES ('Пациент', 1)").run().lastInsertRowid;
  const vid = db.prepare("INSERT INTO visits (patient_id, visit_date) VALUES (?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))").run(pid).lastInsertRowid;
  const consult = db.prepare("INSERT INTO services (name, price, type) VALUES ('Приём', 100000, 'consultation')").run().lastInsertRowid;
  const cbc = db.prepare("INSERT INTO services (name, price, type, is_lab) VALUES ('ОАК', 40000, 'lab', 1)").run().lastInsertRowid;
  const echo = db.prepare("INSERT INTO services (name, price, type) VALUES ('УЗИ', 60000, 'imaging')").run().lastInsertRowid;
  const line = db.prepare('INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total) VALUES (?, ?, ?, 1, 0, 0)');
  const a = n === 1 ? null : line.run(vid, consult, DOC).lastInsertRowid;
  const b = n === 1 ? null : line.run(vid, cbc, null).lastInsertRowid;
  const c = line.run(vid, echo, DOC).lastInsertRowid;
  openCashShift(db, { opening_float: 0 }, cashier);
  const inv = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [a, b, c].filter(Boolean) }, registrar).invoice;
  recordPayment(db, { invoice_id: inv.id, amount: inv.total_amount, method: 'cash' }, cashier);
  return { db, pid, vid, a, b, c, inv };
}
const vsRow = (db, id) => db.prepare('SELECT * FROM visit_services WHERE id = ?').get(id);
const itemOf = (db, id) => vsRow(db, id).invoice_item_id;
const invRow = (db, id) => db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
const ledgerOk = (db, id) => {
  const s = db.prepare('SELECT COALESCE(SUM(amount), 0) s FROM payments WHERE invoice_id = ?').get(id).s;
  assert.equal(Math.round(s * 100) / 100, invRow(db, id).paid_amount, 'сумма платежей = оплачено по счёту');
};

test('«Оставить услугу в визите»: неначатая строка остаётся невыставленной, «возвращено», талон снят; деньги — как обычно', () => {
  const f = seed();
  f.db.prepare("INSERT INTO service_queue_tickets (visit_service_id, visit_id, service_id, number, label, queue_key, status) VALUES (?, ?, ?, 7, 'У-7', 'echo', 'waiting')")
    .run(f.c, f.vid, vsRow(f.db, f.c).service_id);
  f.db.prepare("UPDATE visit_services SET queue_key = 'echo', queue_no = 7 WHERE id = ?").run(f.c);
  const r = refundInvoiceLine(f.db, { invoice_item_id: itemOf(f.db, f.c), keep_services: true }, cashier);
  assert.equal(r.refunded, 60000);
  assert.equal(r.line_kept, true);
  const c = vsRow(f.db, f.c);
  assert.deepEqual([c.invoice_item_id, c.status, c.queue_key, c.queue_no], [null, 'added', null, null], 'строка в визите, без счёта и без номера');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM service_queue_tickets WHERE visit_service_id = ?').get(f.c).n, 0, 'талон очереди снят');
  assert.deepEqual(visitRefundedLines(f.db, { visit_id: f.vid }, registrar).line_ids, [f.c], 'строка — «возвращено»');
  const waiting = cashierUnbilled(f.db, {}, cashier).rows.find((g) => g.visit_id === f.vid);
  assert.ok(!waiting || !waiting.line_ids.includes(f.c), '«Ждут счёта» её не предлагает');
  const after = invRow(f.db, f.inv.id);
  assert.deepEqual([after.total_amount, after.paid_amount, after.status], [140000, 140000, 'paid']);
  ledgerOk(f.db, f.inv.id);
  const log = f.db.prepare("SELECT notes FROM invoice_audit_log WHERE invoice_id = ? AND action = 'refund_line'").get(f.inv.id);
  assert.match(log.notes, /оставлена в визите невыставленной/);
});

test('без галочки — как прежде: неначатая строка уходит с визита; сделанная — остаётся при любой галочке', () => {
  const f = seed();
  const r = refundInvoiceLine(f.db, { invoice_item_id: itemOf(f.db, f.c), keep_services: false }, cashier);
  assert.equal(r.line_kept, false);
  assert.equal(vsRow(f.db, f.c), undefined, 'строки больше нет');
  ledgerOk(f.db, f.inv.id);
  f.db.prepare("UPDATE visit_services SET status = 'collected', sample_collected_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?").run(f.b);
  const r2 = refundInvoiceLine(f.db, { invoice_item_id: itemOf(f.db, f.b) }, cashier);
  assert.equal(r2.line_kept, true);
  assert.deepEqual([vsRow(f.db, f.b).status, vsRow(f.db, f.b).invoice_item_id], ['collected', null], 'проба взята — строка со своей работой');
  ledgerOk(f.db, f.inv.id);
});

test('invoice_line_work: проба, результат, документ, работа идёт — по каждой строке счёта', () => {
  const f = seed();
  f.db.prepare("UPDATE visit_services SET status = 'in_progress' WHERE id = ?").run(f.a);
  f.db.prepare("INSERT INTO visit_documents (title, doc_type, visit_id, visit_service_id, patient_id, body) VALUES ('Протокол', 'protocol', ?, ?, ?, '{}')").run(f.vid, f.a, f.pid);
  f.db.prepare("UPDATE visit_services SET status = 'resulted', sample_collected_at = '2026-10-29T08:00:00Z' WHERE id = ?").run(f.b);
  f.db.prepare("INSERT INTO lab_results (visit_service_id, parameter, value) VALUES (?, 'HGB', '130')").run(f.b);
  const out = invoiceLineWork(f.db, { invoice_id: f.inv.id }, cashier);
  const by = new Map(out.lines.map((l) => [l.invoice_item_id, l]));
  const a = by.get(itemOf(f.db, f.a));
  const b = by.get(itemOf(f.db, f.b));
  const c = by.get(itemOf(f.db, f.c));
  assert.deepEqual({ kind: a.kind, performed: a.performed, document: a.document, result: a.result, sample: a.sample }, { kind: 'visit', performed: true, document: true, result: false, sample: false });
  assert.deepEqual({ performed: b.performed, result: b.result, sample: b.sample, document: b.document }, { performed: true, result: true, sample: true, document: false });
  assert.deepEqual({ performed: c.performed, result: c.result, sample: c.sample, document: c.document }, { performed: false, result: false, sample: false, document: false });
  // Отозванный документ — не «подписан».
  f.db.prepare("UPDATE visit_documents SET voided_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE visit_service_id = ?").run(f.a);
  assert.equal(invoiceLineWork(f.db, { invoice_id: f.inv.id }, cashier).lines.find((l) => l.invoice_item_id === a.invoice_item_id).document, false);
  assert.throws(() => invoiceLineWork(f.db, { invoice_id: 'x' }, cashier), (e) => e.status === 400);
  assert.throws(() => invoiceLineWork(f.db, { invoice_id: 999 }, cashier), (e) => e.status === 400);
  assert.throws(() => invoiceLineWork(f.db, { invoice_id: f.inv.id }, registrar), (e) => e.status === 403);
  assert.equal(typeof RPC.invoice_line_work, 'function');
  assert.equal(isReadOnlyRpc('invoice_line_work'), true);
});

test('invoice_line_work: строка стационара — kind admission, выполнена по отметке', () => {
  const f = seed();
  const adm = f.db.prepare("INSERT INTO admissions (patient_id, status) VALUES (?, 'active')").run(f.pid).lastInsertRowid;
  const inv = f.db.prepare("INSERT INTO invoices (invoice_number, admission_id, patient_id, subtotal, total_amount, paid_amount, status) VALUES ('INV-A-26-07001', ?, ?, 50000, 50000, 0, 'unpaid')").run(adm, f.pid).lastInsertRowid;
  const it = f.db.prepare("INSERT INTO invoice_items (invoice_id, description, quantity, unit_price, total) VALUES (?, 'Перевязка', 1, 50000, 50000)").run(inv).lastInsertRowid;
  f.db.prepare("INSERT INTO admission_services (admission_id, quantity, unit_price, total, billable, status, performed_at, invoice_item_id) VALUES (?, 1, 50000, 50000, 1, 'completed', '2026-10-29T08:00:00Z', ?)").run(adm, it);
  const l = invoiceLineWork(f.db, { invoice_id: inv }, cashier).lines[0];
  assert.deepEqual({ kind: l.kind, performed: l.performed, sample: l.sample, result: l.result, document: l.document }, { kind: 'admission', performed: true, sample: false, result: false, document: false });
});

// ─── Ревью B3 ─────────────────────────────────────────────────────────────────
// Одно правило «по строке есть работа» (lineHasWork) у окна и у сервера:
// статус работы ИЛИ след — результат, документ (и отозванный), сообщение
// анализатора. Эти ссылки — простые внешние ключи без каскада: такую строку
// удалить нельзя, она остаётся в визите при любой галочке.

test('ревью B3: след без статуса (сообщение анализатора, отозванный документ) — работа и для окна, и для возврата', () => {
  const f = seed();
  f.db.prepare("INSERT INTO lab_device_messages (raw, status, visit_service_id) VALUES ('x', 'unmapped', ?)").run(f.c);
  f.db.prepare("INSERT INTO visit_documents (title, doc_type, visit_id, visit_service_id, patient_id, body, voided_at) VALUES ('Протокол', 'protocol', ?, ?, ?, '{}', strftime('%Y-%m-%dT%H:%M:%SZ','now'))").run(f.vid, f.a, f.pid);
  const by = new Map(invoiceLineWork(f.db, { invoice_id: f.inv.id }, cashier).lines.map((l) => [l.invoice_item_id, l]));
  const c = by.get(itemOf(f.db, f.c));
  const a = by.get(itemOf(f.db, f.a));
  assert.deepEqual({ performed: c.performed, sample: c.sample, result: c.result, document: c.document }, { performed: true, sample: false, result: false, document: false }, 'сообщение анализатора — работа');
  assert.deepEqual({ performed: a.performed, document: a.document }, { performed: true, document: false }, 'отозванный документ — работа, но не «подписан»');
  assert.equal(lineHasWork(f.db, vsRow(f.db, f.c)), true);
  assert.equal(lineHasWork(f.db, vsRow(f.db, f.a)), true);
  const statusC = vsRow(f.db, f.c).status;
  const r = refundInvoiceLine(f.db, { invoice_item_id: itemOf(f.db, f.c), keep_services: true }, cashier);
  assert.equal(r.line_kept, true);
  assert.deepEqual([vsRow(f.db, f.c).status, vsRow(f.db, f.c).invoice_item_id], [statusC, null], 'статус строки со следом не тронут');
  ledgerOk(f.db, f.inv.id);
  const statusA = vsRow(f.db, f.a).status;
  const r2 = refundInvoiceLine(f.db, { invoice_item_id: itemOf(f.db, f.a), keep_services: false }, cashier);
  assert.equal(r2.line_kept, true, 'отозванный документ держит строку и без галочки');
  assert.deepEqual([vsRow(f.db, f.a).status, vsRow(f.db, f.a).invoice_item_id], [statusA, null]);
  assert.deepEqual(visitRefundedLines(f.db, { visit_id: f.vid }, registrar).line_ids, [f.a, f.c]);
  ledgerOk(f.db, f.inv.id);
});

test('ревью B3: время пробы есть, а статус не «работа» и следов нет — работы нет: окно молчит, возврат снимает строку', () => {
  const f = seed();
  f.db.prepare("UPDATE visit_services SET sample_collected_at = '2026-10-29T08:00:00Z' WHERE id = ?").run(f.b);
  const vs = vsRow(f.db, f.b);
  assert.ok(!PERFORMED_LINE_STATUSES.includes(vs.status), vs.status);
  assert.equal(lineHasWork(f.db, vs), false, 'общее правило: время пробы без статуса и следов — не работа');
  const l = invoiceLineWork(f.db, { invoice_id: f.inv.id }, cashier).lines.find((x) => x.invoice_item_id === vs.invoice_item_id);
  assert.deepEqual({ performed: l.performed, sample: l.sample }, { performed: false, sample: true }, 'флаг пробы — только для слов; работу решает performed');
  const r = refundInvoiceLine(f.db, { invoice_item_id: vs.invoice_item_id }, cashier);
  assert.equal(r.line_kept, false);
  assert.equal(vsRow(f.db, f.b), undefined, 'сервер снял строку — окно и не предупреждало');
  ledgerOk(f.db, f.inv.id);
});

test('ревью B3: «оставить в визите» у последней строки — счёт отменён 0/0, строка «добавлена» с отметкой, деньги сходятся', () => {
  const f = seed(1);
  const r = refundInvoiceLine(f.db, { invoice_item_id: itemOf(f.db, f.c), keep_services: true }, cashier);
  assert.deepEqual([r.refunded, r.voided, r.line_kept], [60000, true, true]);
  const inv = invRow(f.db, f.inv.id);
  assert.deepEqual([inv.status, inv.total_amount, inv.paid_amount], ['void', 0, 0]);
  assert.deepEqual([vsRow(f.db, f.c).invoice_item_id, vsRow(f.db, f.c).status], [null, 'added']);
  assert.deepEqual(visitRefundedLines(f.db, { visit_id: f.vid }, registrar).line_ids, [f.c], 'отметка «возвращено» на месте');
  ledgerOk(f.db, f.inv.id);
});

test('ревью B3: галочка у сделанной работы ничего не меняет — статус свой, строка в визите', () => {
  const f = seed();
  f.db.prepare("UPDATE visit_services SET status = 'collected', sample_collected_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?").run(f.b);
  const r = refundInvoiceLine(f.db, { invoice_item_id: itemOf(f.db, f.b), keep_services: true }, cashier);
  assert.equal(r.line_kept, true);
  assert.deepEqual([vsRow(f.db, f.b).status, vsRow(f.db, f.b).invoice_item_id], ['collected', null]);
  assert.deepEqual(visitRefundedLines(f.db, { visit_id: f.vid }, registrar).line_ids, [f.b]);
  const log = f.db.prepare("SELECT notes FROM invoice_audit_log WHERE invoice_id = ? AND action = 'refund_line'").get(f.inv.id);
  assert.match(log.notes, /работа сделана — осталась в визите невыставленной/);
  ledgerOk(f.db, f.inv.id);
});

test('ревью B3: оставленную строку выставляют заново только явным выбором — отметка снимается, после оплаты строка в очереди', () => {
  const f = seed();
  refundInvoiceLine(f.db, { invoice_item_id: itemOf(f.db, f.c), keep_services: true }, cashier);
  assert.throws(() => createInvoiceForVisit(f.db, { visit_id: f.vid, visit_service_ids: [f.c] }, registrar), (e) => e.status === 409);
  const inv2 = createInvoiceForVisit(f.db, { visit_id: f.vid, visit_service_ids: [f.c], rebill_refunded: true }, cashier).invoice;
  assert.equal(inv2.total_amount, 60000);
  assert.deepEqual(visitRefundedLines(f.db, { visit_id: f.vid }, registrar).line_ids, [], 'новый счёт снял отметку');
  recordPayment(f.db, { invoice_id: inv2.id, amount: inv2.total_amount, method: 'cash' }, cashier);
  assert.equal(vsRow(f.db, f.c).status, 'queued');
  ledgerOk(f.db, inv2.id);
  ledgerOk(f.db, f.inv.id);
});

test('ревью B3: invoice_line_work — счёт другого здания не читается; на позицию счёта — одна строка ответа', () => {
  const f = seed();
  // Лишние ссылки на ту же позицию счёта (индексы не уникальные): ответ — по
  // одной строке на позицию.
  const itemA = itemOf(f.db, f.a);
  f.db.prepare('INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total, invoice_item_id) SELECT visit_id, service_id, 1, 0, 0, invoice_item_id FROM visit_services WHERE id = ?').run(f.a);
  const adm = f.db.prepare("INSERT INTO admissions (patient_id, status) VALUES (?, 'active')").run(f.pid).lastInsertRowid;
  const admInv = f.db.prepare("INSERT INTO invoices (invoice_number, admission_id, patient_id, subtotal, total_amount, paid_amount, status) VALUES ('INV-A-26-07002', ?, ?, 50000, 50000, 0, 'unpaid')").run(adm, f.pid).lastInsertRowid;
  const it = f.db.prepare("INSERT INTO invoice_items (invoice_id, description, quantity, unit_price, total) VALUES (?, 'Перевязка', 1, 50000, 50000)").run(admInv).lastInsertRowid;
  const admLine = f.db.prepare("INSERT INTO admission_services (admission_id, quantity, unit_price, total, billable, status, performed_at, invoice_item_id) VALUES (?, 1, 50000, 50000, 1, 'completed', ?, ?)");
  admLine.run(adm, '2026-10-29T08:00:00Z', it);
  admLine.run(adm, null, it);
  const visitLines = invoiceLineWork(f.db, { invoice_id: f.inv.id }, cashier).lines;
  assert.equal(visitLines.length, 3);
  assert.equal(visitLines.filter((l) => l.invoice_item_id === itemA).length, 1);
  const admLines = invoiceLineWork(f.db, { invoice_id: admInv }, cashier).lines;
  assert.equal(admLines.length, 1);
  assert.equal(admLines[0].performed, true, 'первая строка стационара на позиции — выполнена');
  f.db.prepare("UPDATE invoices SET sync_origin = 'B' WHERE id = ?").run(f.inv.id);
  assert.throws(() => invoiceLineWork(f.db, { invoice_id: f.inv.id }, cashier), (e) => e.status === 403);
});

test('ревью B3: товарная строка визита — product: true (окно не предлагает «оставить в визите»)', () => {
  const f = seed();
  const prod = f.db.prepare("INSERT INTO products (name, sale_price) VALUES ('Бинт', 5000)").run().lastInsertRowid;
  f.db.prepare('UPDATE visit_services SET clinic_item_id = ? WHERE id = ?').run(prod, f.c);
  const by = new Map(invoiceLineWork(f.db, { invoice_id: f.inv.id }, cashier).lines.map((l) => [l.invoice_item_id, l]));
  assert.equal(by.get(itemOf(f.db, f.c)).product, true);
  assert.equal(by.get(itemOf(f.db, f.a)).product, false);
});
