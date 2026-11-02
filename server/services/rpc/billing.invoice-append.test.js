// INVOICE_APPEND_V1 (решение владельца 2026-11-02) — НОВЫЕ УСЛУГИ — В
// НЕОПЛАЧЕННЫЙ СЧЁТ ВИЗИТА.
//
// Каждый шаг регистрации выставлял НОВЫЙ счёт (create_invoice_for_visit всегда
// делал INSERT): мастер, быстрая регистрация, калькулятор, направление врача,
// окно визита. На dev 17 счетов созданы, пока предыдущий счёт того же визита
// ещё не был оплачен. Теперь строки дописываются в «редактируемый счёт
// пациента» визита — тот же номер, новая сумма; счёт плательщику, оплаченный,
// частично оплаченный, долг, отменённый, с платежами в прошлом, чужого здания и
// госпитализации не трогается никогда.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { createInvoiceForVisit, recordPayment } from './billing.js';
import { cashierInvoices } from './cashier.js';
import { RPC } from './index.js';

const DOC = 20;
const admin = { id: 1, role: 'admin', full_name: 'Админ' };
const registrar = { id: 7, role: 'registrar', full_name: 'Регистратура' };
const cashier = { id: 9, role: 'cashier', full_name: 'Кассир' };
const doctor = { id: DOC, role: 'doctor', full_name: 'Врач' };

function seed() {
  const db = openDb(':memory:'); migrate(db);
  const u = db.prepare('INSERT INTO users (id, username, password_hash, role, full_name, is_doctor, extra_roles) VALUES (?,?,?,?,?,?,?)');
  u.run(1, 'adm', 'x', 'admin', 'Админ', 0, '[]');
  u.run(7, 'reg', 'x', 'registrar', 'Регистратура', 0, '[]');
  u.run(9, 'cash', 'x', 'cashier', 'Кассир', 0, '[]');
  u.run(DOC, 'doc', 'x', 'doctor', 'Врач', 1, '[]');
  const CONS = Number(db.prepare("INSERT INTO services (name, price) VALUES ('Приём терапевта', 100000)").run().lastInsertRowid);
  const LAB = Number(db.prepare("INSERT INTO services (name, price, is_lab) VALUES ('Анализ крови', 40000, 1)").run().lastInsertRowid);
  const ECG = Number(db.prepare("INSERT INTO services (name, price) VALUES ('ЭКГ', 50000)").run().lastInsertRowid);
  const FREE = Number(db.prepare("INSERT INTO services (name, price) VALUES ('Повторный осмотр', 0)").run().lastInsertRowid);
  const pid = Number(db.prepare("INSERT INTO patients (full_name) VALUES ('Пациент')").run().lastInsertRowid);
  const payer = Number(db.prepare("INSERT INTO payers (name, kind, active) VALUES ('Страховая', 'insurance', 1)").run().lastInsertRowid);
  const vid = Number(db.prepare("INSERT INTO visits (patient_id, visit_date, created_by) VALUES (?, strftime('%Y-%m-%dT%H:%M:%SZ','now'), 7)").run(pid).lastInsertRowid);
  return { db, CONS, LAB, ECG, FREE, pid, payer, vid };
}

/** Строка визита «в смете» — цена от браузера (1 сум), счёт оценит сам. */
function line(db, vid, serviceId, by = 7, doctorId = null) {
  return Number(db.prepare(
    "INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status, created_by) VALUES (?, ?, ?, 1, 1, 1, 'added', ?)",
  ).run(vid, serviceId, doctorId, by).lastInsertRowid);
}
const bill = (db, vid, ids, user = registrar, extra = {}) =>
  createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: ids, discount_amount: 0, payer_id: null, ...extra }, user);
const invoicesOf = (db, vid) => db.prepare('SELECT * FROM invoices WHERE visit_id = ? ORDER BY id').all(vid);
const seqNow = (db) => JSON.stringify(db.prepare('SELECT year, next_seq FROM invoice_counters ORDER BY year').all());

test('второй вызов, пока первый счёт не оплачен, — ТОТ ЖЕ счёт: номер прежний, сумма новая, номер не израсходован', () => {
  const { db, CONS, LAB, ECG, vid } = seed();
  const a = line(db, vid, CONS);
  const first = bill(db, vid, [a]);
  assert.equal(first.appended, undefined, 'первый счёт — новый');
  const seq = seqNow(db);
  const b = line(db, vid, LAB);
  const second = bill(db, vid, [b]);
  assert.equal(second.appended, true);
  assert.equal(second.invoice.id, first.invoice.id, 'строки легли в прежний счёт');
  assert.equal(second.invoice.invoice_number, first.invoice.invoice_number);
  assert.deepEqual([second.invoice.subtotal, second.invoice.discount_amount, second.invoice.total_amount, second.invoice.status],
    [140000, 0, 140000, 'unpaid']);
  assert.deepEqual(second.items.map((i) => [i.description, i.total]), [['Анализ крови', 40000]], 'items — позиции НОВОЙ части');
  assert.equal(second.rest_discount, 0);
  assert.equal(invoicesOf(db, vid).length, 1, 'второго счёта нет');
  assert.equal(seqNow(db), seq, 'номер счёта не израсходован');
  const vs = db.prepare('SELECT invoice_item_id, unit_price FROM visit_services WHERE id = ?').get(b);
  assert.equal(db.prepare('SELECT invoice_id FROM invoice_items WHERE id = ?').get(vs.invoice_item_id).invoice_id, first.invoice.id);
  assert.equal(vs.unit_price, 40000, 'строка визита — по цене счёта');
  const audit = db.prepare("SELECT action, notes, amount FROM invoice_audit_log WHERE invoice_id = ? AND action = 'line_add'").all(first.invoice.id);
  assert.equal(audit.length, 1, 'дописывание записано в журнал счёта');
  assert.match(audit[0].notes, /Анализ крови/);
  assert.equal(audit[0].amount, 140000);
  // Через карту RPC — та же дверь.
  const c = line(db, vid, ECG);
  assert.equal(RPC.create_invoice_for_visit(db, { visit_id: vid, visit_service_ids: [c] }, registrar).appended, true);
});

test('повтор того же вызова (те же строки) — отказ «уже в счёте», счёт не меняется', () => {
  const { db, CONS, LAB, vid } = seed();
  bill(db, vid, [line(db, vid, CONS)]);
  const b = line(db, vid, LAB);
  const once = bill(db, vid, [b]);
  assert.throws(() => bill(db, vid, [b]), (e) => e.status === 400 && /уже в счёте/.test(e.message));
  const now = db.prepare('SELECT subtotal, total_amount FROM invoices WHERE id = ?').get(once.invoice.id);
  assert.deepEqual({ ...now }, { subtotal: 140000, total_amount: 140000 });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM invoice_items WHERE invoice_id = ?').get(once.invoice.id).n, 2);
});

// Каждое из состояний первого счёта — второй вызов выставляет НОВЫЙ счёт.
const NOT_EDITABLE = [
  ['оплачен частично', (db, inv) => recordPayment(db, { invoice_id: inv.id, amount: 30000, method: 'cash' }, cashier)],
  ['оплачен полностью', (db, inv) => recordPayment(db, { invoice_id: inv.id, amount: inv.total_amount, method: 'cash' }, cashier)],
  ['переведён в долг', (db, inv) => RPC.mark_invoice_debt(db, { invoice_id: inv.id }, cashier)],
  ['отменён', (db, inv) => db.prepare("UPDATE invoices SET status = 'void' WHERE id = ?").run(inv.id)],
  ['по нему были платежи (оплата и возврат)', (db, inv) => {
    db.prepare("INSERT INTO payments (invoice_id, amount, method, cashier_id) VALUES (?, ?, 'cash', 9)").run(inv.id, 30000);
    db.prepare("INSERT INTO payments (invoice_id, amount, method, cashier_id) VALUES (?, ?, 'cash', 9)").run(inv.id, -30000);
  }],
  ['приехал из другого здания', (db, inv) => db.prepare("UPDATE invoices SET sync_origin = 'B' WHERE id = ?").run(inv.id)],
  ['счёт госпитализации', (db, inv) => {
    const adm = db.prepare('INSERT INTO admissions (patient_id) VALUES (?)').run(inv.patient_id).lastInsertRowid;
    db.prepare('UPDATE invoices SET admission_id = ? WHERE id = ?').run(adm, inv.id);
  }],
];
for (const [what, make] of NOT_EDITABLE) {
  test(`первый счёт ${what} — второй вызов выставляет НОВЫЙ счёт`, () => {
    const { db, CONS, LAB, vid } = seed();
    const first = bill(db, vid, [line(db, vid, CONS)]);
    make(db, first.invoice);
    const before = db.prepare('SELECT subtotal, total_amount, status FROM invoices WHERE id = ?').get(first.invoice.id);
    const second = bill(db, vid, [line(db, vid, LAB)]);
    assert.notEqual(second.invoice.id, first.invoice.id, 'дописано в счёт, который ' + what);
    assert.equal(second.appended, undefined);
    assert.equal(second.invoice.total_amount, 40000);
    assert.deepEqual(db.prepare('SELECT subtotal, total_amount, status FROM invoices WHERE id = ?').get(first.invoice.id), before,
      'первый счёт изменился');
  });
}

test('счёт плательщику не сливается никогда: ни пациентский в него, ни он в пациентский', () => {
  const { db, CONS, LAB, ECG, vid, payer } = seed();
  const pay = bill(db, vid, [line(db, vid, CONS)], registrar, { payer_id: payer });
  const own = bill(db, vid, [line(db, vid, LAB)]);
  assert.notEqual(own.invoice.id, pay.invoice.id, 'строки пациента легли в счёт страховой');
  assert.equal(own.appended, undefined);
  const pay2 = bill(db, vid, [line(db, vid, ECG)], registrar, { payer_id: payer });
  assert.notEqual(pay2.invoice.id, own.invoice.id, 'строки страховой легли в счёт пациента');
  assert.equal(pay2.appended, undefined);
  assert.equal(invoicesOf(db, vid).length, 3);
});

test('бесплатная новая часть — своим счётом (закрыт сразу, строка в очереди), а бесплатный первый счёт не дописывается', () => {
  const { db, CONS, FREE, vid } = seed();
  const first = bill(db, vid, [line(db, vid, CONS)]);
  const f = line(db, vid, FREE);
  const free = bill(db, vid, [f]);
  assert.notEqual(free.invoice.id, first.invoice.id);
  assert.equal(free.invoice.status, 'paid');
  assert.equal(db.prepare('SELECT status FROM visit_services WHERE id = ?').get(f).status, 'queued', 'бесплатная строка ждала бы оплаты чужого счёта');
  const s = seed();
  const zero = bill(s.db, s.vid, [line(s.db, s.vid, s.FREE)]);
  const paid = bill(s.db, s.vid, [line(s.db, s.vid, s.CONS)]);
  assert.notEqual(paid.invoice.id, zero.invoice.id, 'платная строка легла в закрытый бесплатный счёт');
});

test('визит другой: счёт соседнего визита пациента не трогается', () => {
  const { db, CONS, LAB, pid, vid } = seed();
  const first = bill(db, vid, [line(db, vid, CONS)]);
  const vid2 = Number(db.prepare("INSERT INTO visits (patient_id, visit_date) VALUES (?, strftime('%Y-%m-%dT%H:%M:%SZ','now','+1 day'))").run(pid).lastInsertRowid);
  const second = bill(db, vid2, [line(db, vid2, LAB)]);
  assert.notEqual(second.invoice.id, first.invoice.id);
  assert.equal(second.invoice.visit_id, vid2);
});

test('оплата дописанного счёта ставит в очередь ВСЕ его строки', () => {
  const { db, CONS, LAB, vid } = seed();
  const a = line(db, vid, CONS);
  bill(db, vid, [a]);
  const b = line(db, vid, LAB);
  const inv = bill(db, vid, [b]).invoice;
  recordPayment(db, { invoice_id: inv.id, amount: inv.total_amount, method: 'cash' }, cashier);
  assert.deepEqual(db.prepare('SELECT status FROM visit_services WHERE id IN (?, ?) ORDER BY id').all(a, b).map((r) => r.status), ['queued', 'queued']);
  assert.equal(db.prepare('SELECT status FROM invoices WHERE id = ?').get(inv.id).status, 'paid');
});

// Ревью C1 (billing.invoice-append-review.test.js) — дописывается, только когда
// у обеих частей лишь пол группы пациента: тогда скидки складываются.
test('скидка: пол группы обеих частей складывается (прежняя часть — свои 10 000, новые — свои 4 000 и 5 000)', () => {
  const { db, CONS, LAB, ECG, pid, vid } = seed();
  const cat = db.prepare("INSERT INTO patient_categories (name, discount_percent, active) VALUES ('VIP', 10, 1)").run().lastInsertRowid;
  db.prepare('UPDATE patients SET category_id = ? WHERE id = ?').run(cat, pid);
  // Первая часть — без ручной скидки: действует пол группы 10 % = 10 000.
  const first = bill(db, vid, [line(db, vid, CONS)]);
  assert.equal(first.invoice.discount_amount, 10000);
  // Вторая — мастер присылает ровно пол группы (скидка «лояльности» = процент группы): 4 000.
  const second = bill(db, vid, [line(db, vid, LAB)], registrar, { discount_amount: 4000 });
  assert.equal(second.appended, true);
  assert.equal(second.rest_discount, 4000, 'rest_discount — скидка НОВОЙ части (перенос скидки мастера)');
  assert.deepEqual([second.invoice.subtotal, second.invoice.discount_amount, second.invoice.total_amount], [140000, 14000, 126000]);
  // Третья — без ручной: пол группы новой части, 5 000.
  const third = bill(db, vid, [line(db, vid, ECG)]);
  assert.equal(third.appended, true);
  assert.equal(third.rest_discount, 5000);
  assert.deepEqual([third.invoice.subtotal, third.invoice.discount_amount, third.invoice.total_amount], [190000, 19000, 171000]);
});

test('скидка: ручная скидка у новой или у прежней части — новые услуги НОВЫМ счётом, как в 3.20.0', () => {
  const s = seed();
  const cat = s.db.prepare("INSERT INTO patient_categories (name, discount_percent, active) VALUES ('VIP', 10, 1)").run().lastInsertRowid;
  s.db.prepare('UPDATE patients SET category_id = ? WHERE id = ?').run(cat, s.pid);
  const first = bill(s.db, s.vid, [line(s.db, s.vid, s.CONS)]);
  const manualNew = bill(s.db, s.vid, [line(s.db, s.vid, s.LAB)], registrar, { discount_amount: 20000 });
  assert.equal(manualNew.appended, undefined);
  assert.notEqual(manualNew.invoice.id, first.invoice.id);
  assert.equal(manualNew.rest_discount, 20000);
  assert.deepEqual([manualNew.invoice.discount_amount, manualNew.invoice.total_amount], [20000, 20000]);
  assert.deepEqual([first.invoice.discount_amount, s.db.prepare('SELECT total_amount t FROM invoices WHERE id = ?').get(first.invoice.id).t], [10000, 90000]);

  const { db, CONS, LAB, pid, vid } = seed();
  const cat2 = db.prepare("INSERT INTO patient_categories (name, discount_percent, active) VALUES ('VIP', 10, 1)").run().lastInsertRowid;
  db.prepare('UPDATE patients SET category_id = ? WHERE id = ?').run(cat2, pid);
  const manualOld = bill(db, vid, [line(db, vid, CONS)], registrar, { discount_amount: 30000 });
  assert.equal(manualOld.invoice.discount_amount, 30000);
  const second = bill(db, vid, [line(db, vid, LAB)]);
  assert.equal(second.appended, undefined);
  assert.notEqual(second.invoice.id, manualOld.invoice.id);
  assert.equal(second.rest_discount, 4000);
  assert.deepEqual([second.invoice.discount_amount, second.invoice.total_amount], [4000, 36000]);
});

test('врач без денежной роли дописывает СВОИ строки в счёт регистратуры; проверки врача — только по новым строкам', () => {
  const { db, CONS, LAB, ECG, vid } = seed();
  const regLine = line(db, vid, CONS, 7);
  const first = bill(db, vid, [regLine], registrar);
  const own = line(db, vid, LAB, DOC);
  const out = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [own] }, doctor);
  assert.equal(out.appended, true, 'строка регистратуры в счёте не мешает врачу дописать свою');
  assert.equal(out.invoice.id, first.invoice.id);
  assert.equal(out.invoice.discount_amount, 0);
  assert.equal(out.invoice.total_amount, 140000);
  // Чужую строку врач по-прежнему не выставляет — ни новым счётом, ни дописыванием.
  const foreign = line(db, vid, ECG, 7);
  assert.throws(() => createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [foreign] }, doctor),
    (e) => e.status === 403 && /только за услуги, которые добавил сам/.test(e.message));
  assert.throws(() => createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [line(db, vid, ECG, DOC)], discount_amount: 1000 }, doctor),
    (e) => e.status === 403 && /Скидку в счёт ставят/.test(e.message));
  assert.equal(db.prepare('SELECT total_amount FROM invoices WHERE id = ?').get(first.invoice.id).total_amount, 140000, 'отказ не тронул счёт');
});

test('список кассы — одна строка на счёт: две регистрации одного визита — один счёт с двумя позициями', () => {
  const { db, CONS, LAB, vid } = seed();
  bill(db, vid, [line(db, vid, CONS)]);
  bill(db, vid, [line(db, vid, LAB)]);
  const rows = cashierInvoices(db, {}, admin).rows.filter((r) => r.visit_id === vid);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].items_count, 2);
  assert.equal(rows[0].total_amount, 140000);
});

// К2 / К6 (владелец, 2026-11-02) — окно кассы «Платежи»: после «Вернуть услугу»
// новые услуги идут новым счётом; «Заменить услугу» в оплаченном счёте — тоже;
// замена в неоплаченном (без денег) счёте дописывание не ломает. Сами двери
// замены и возврата не меняются.
test('К2: после «Вернуть услугу» (refund_invoice_line) новые услуги идут новым счётом, возвращённый счёт не меняется', () => {
  const { db, CONS, LAB, ECG, vid } = seed();
  const a = line(db, vid, CONS);
  const b = line(db, vid, LAB);
  const inv = bill(db, vid, [a, b]).invoice;
  recordPayment(db, { invoice_id: inv.id, amount: inv.total_amount, method: 'cash' }, cashier);
  const itemB = db.prepare('SELECT invoice_item_id FROM visit_services WHERE id = ?').get(b).invoice_item_id;
  RPC.refund_invoice_line(db, { invoice_item_id: itemB, reason: 'передумал' }, cashier);
  const before = db.prepare('SELECT subtotal, total_amount, paid_amount, status FROM invoices WHERE id = ?').get(inv.id);
  const next = bill(db, vid, [line(db, vid, ECG)]);
  assert.notEqual(next.invoice.id, inv.id, 'дописано в счёт с возвратом');
  assert.equal(next.appended, undefined);
  assert.equal(next.invoice.total_amount, 50000);
  assert.deepEqual(db.prepare('SELECT subtotal, total_amount, paid_amount, status FROM invoices WHERE id = ?').get(inv.id), before);
});

test('К2: «Заменить услугу» в оплаченном счёте — новые услуги новым счётом; замена в неоплаченном — дописывание по-прежнему', () => {
  const { db, CONS, LAB, ECG, vid } = seed();
  const a = line(db, vid, CONS);
  const inv = bill(db, vid, [a]).invoice;
  RPC.cashier_line_change_service(db, { visit_service_id: a, new_service_id: LAB }, admin);   // замена без денег
  const app = bill(db, vid, [line(db, vid, ECG)]);
  assert.equal(app.appended, true, 'замена в неоплаченном счёте сломала дописывание');
  assert.equal(app.invoice.id, inv.id);
  assert.equal(app.invoice.total_amount, 90000, 'анализ 40 000 (после замены) + ЭКГ 50 000');
  const s = seed();
  const a2 = line(s.db, s.vid, s.CONS);
  const inv2 = bill(s.db, s.vid, [a2]).invoice;
  recordPayment(s.db, { invoice_id: inv2.id, amount: inv2.total_amount, method: 'cash' }, cashier);
  RPC.cashier_line_swap_paid(s.db, { visit_service_id: a2, new_service_id: s.LAB, to_balance: true }, admin);
  const next = bill(s.db, s.vid, [line(s.db, s.vid, s.ECG)]);
  assert.notEqual(next.invoice.id, inv2.id, 'дописано в оплаченный счёт после замены');
  assert.equal(next.appended, undefined);
});

// INVOICE_APPEND_V1 — у кассы «Добавить услугу» (cashier_line_add) своё правило
// выбора счёта: самый новый неоплаченный счёт визита. Не годится он (по нему
// были платежи) — касса выставляет НОВЫЙ счёт, как прежде; дописывание
// create_invoice_for_visit не подсовывает ей более старый счёт (иначе журнал
// сказал бы «новым счётом» о дописанном, и строка легла бы не туда, куда смотрит касса).
test('cashier_line_add: самый новый счёт визита с платежами в прошлом — новый счёт, как прежде; старый неоплаченный не трогается', () => {
  const { db, CONS, ECG, pid, vid } = seed();
  const a = bill(db, vid, [line(db, vid, CONS)]).invoice;
  const b = Number(db.prepare("INSERT INTO invoices (invoice_number, visit_id, patient_id, subtotal, discount_amount, total_amount, paid_amount, status) VALUES ('INV-LEGACY-2', ?, ?, 30000, 0, 30000, 0, 'unpaid')").run(vid, pid).lastInsertRowid);
  db.prepare("INSERT INTO payments (invoice_id, amount, method, cashier_id) VALUES (?, ?, 'cash', 9)").run(b, 30000);
  db.prepare("INSERT INTO payments (invoice_id, amount, method, cashier_id) VALUES (?, ?, 'cash', 9)").run(b, -30000);
  const beforeA = db.prepare('SELECT subtotal, total_amount, status FROM invoices WHERE id = ?').get(a.id);
  const out = RPC.cashier_line_add(db, { visit_id: vid, service_id: ECG }, admin);
  assert.equal(out.invoice_created, true);
  assert.notEqual(out.invoice.id, a.id, 'касса дописала в старый счёт, о котором не знала');
  assert.notEqual(out.invoice.id, b);
  assert.equal(out.invoice.total_amount, 50000);
  assert.deepEqual(db.prepare('SELECT subtotal, total_amount, status FROM invoices WHERE id = ?').get(a.id), beforeA);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM invoice_audit_log WHERE action = 'line_add'").get().n, 1, 'одна запись «добавлена услуга»');
});

test('филиалы: дописанный счёт уезжает соседям — журнал видит новую сумму и новую позицию', () => {
  const { db, CONS, LAB, vid } = seed();
  const first = bill(db, vid, [line(db, vid, CONS)]);
  const mark = db.prepare('SELECT COALESCE(MAX(seq), 0) m FROM sync_journal').get().m;
  const second = bill(db, vid, [line(db, vid, LAB)]);
  const inv = db.prepare('SELECT uid FROM invoices WHERE id = ?').get(first.invoice.id);
  const item = db.prepare('SELECT uid FROM invoice_items WHERE id = ?').get(second.items[0].id);
  const j = db.prepare('SELECT tbl, uid, cols FROM sync_journal WHERE seq > ?').all(mark);
  assert.ok(j.some((r) => r.tbl === 'invoices' && r.uid === inv.uid && /total_amount/.test(r.cols)), 'новая сумма счёта не попала в журнал: ' + JSON.stringify(j));
  assert.ok(j.some((r) => r.tbl === 'invoice_items' && r.uid === item.uid), 'новая позиция не попала в журнал');
});
