// REFERRAL_BILL_V1 (2026-09-29) — «ЖДУТ СЧЁТА» В КАССЕ (cashier_unbilled).
//
// Владелец: «While we are seeing the patient as a doctor and refer to another
// service or a doctor we cannot see them in the cashier's window.» «Приём
// оплат» строится из одних счетов, и визит со строками без счёта кассе не
// виден вовсе. Страховка к решению «врач выставляет счёт сам»: касса видит
// каждого пациента, у которого амбулаторные услуги всё ещё ждут счёта, — что
// бы ни оставило их без счёта (снятая галочка, отказ, строки плательщика,
// отмена счёта с «Оставить услуги»).
//
// Кто сюда НЕ попадает — каждый случай своим тестом: выставленные, отменённые,
// чужого здания, отпущенные с возвратом (они — в «Возвратах и отменах»),
// бесплатные, отменённый или несостоявшийся визит, визит старше 30 дней.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { RPC } from './index.js';
import { createInvoiceForVisit, recordPayment } from './billing.js';
import { openCashShift, voidInvoice } from './cashier.js';
import { isReadOnlyRpc } from '../control/gate.js';

const admin = { id: 1, role: 'admin', full_name: 'Админ' };
const registrar = { id: 7, role: 'registrar', full_name: 'Регистратура' };
const cashier = { id: 9, role: 'cashier', full_name: 'Кассир' };
const head = { id: 11, role: 'cashier', extra_roles: ['head_cashier'], full_name: 'Старший кассир' };
const DOC = 20;
const doctor = { id: DOC, role: 'doctor', full_name: 'Иванов Врач' };

function seed() {
  const db = openDb(':memory:'); migrate(db);
  const u = db.prepare('INSERT INTO users (id, username, password_hash, role, full_name, is_doctor, extra_roles) VALUES (?,?,?,?,?,?,?)');
  u.run(1, 'adm', 'x', 'admin', 'Админ', 0, '[]');
  u.run(7, 'reg', 'x', 'registrar', 'Регистратура', 0, '[]');
  u.run(9, 'cash', 'x', 'cashier', 'Кассир', 0, '[]');
  u.run(11, 'head', 'x', 'cashier', 'Старший кассир', 0, '["head_cashier"]');
  u.run(DOC, 'doc', 'x', 'doctor', 'Иванов Врач', 1, '[]');
  const svc = (name, price) => Number(db.prepare('INSERT INTO services (name, price) VALUES (?, ?)').run(name, price).lastInsertRowid);
  const CONS = svc('Приём терапевта', 100000);
  const LAB = svc('Анализ крови', 40000);
  const FREE = svc('Бесплатный скрининг', 0);
  db.prepare('UPDATE users SET service_rates = ? WHERE id = ?').run(JSON.stringify([{ service_id: CONS, price: 150000, pct: 10 }]), DOC);
  const BANDAGE = Number(db.prepare("INSERT INTO products (name, sale_price) VALUES ('Бинт', 5000)").run().lastInsertRowid);
  const pid = Number(db.prepare("INSERT INTO patients (full_name, mrn, phone, date_of_birth, gender) VALUES ('Рахимов Жасур', 'A-000015', '+998901112233', '1990-05-01', 'male')").run().lastInsertRowid);
  const pid2 = Number(db.prepare("INSERT INTO patients (full_name, mrn) VALUES ('Каримова Нигора', 'A-000016')").run().lastInsertRowid);
  openCashShift(db, { opening_float: 0 }, cashier);
  return { db, CONS, LAB, FREE, BANDAGE, pid, pid2 };
}

// Местный полдень дня «сегодня + offset» в UTC — день визита считает SQLite
// тем же 'localtime', что и сервер, при любом поясе процесса.
const dayAt = (db, offset) => db.prepare(
  "SELECT strftime('%Y-%m-%dT%H:%M:%SZ', date('now', 'localtime', ?) || ' 12:00:00', 'utc') AS t",
).get(`${offset >= 0 ? '+' : ''}${offset} days`).t;

function visit(db, pid, { offset = 0, status = 'scheduled', origin = null } = {}) {
  return Number(db.prepare('INSERT INTO visits (patient_id, visit_date, status, sync_origin, created_by) VALUES (?, ?, ?, ?, ?)')
    .run(pid, dayAt(db, offset), status, origin, DOC).lastInsertRowid);
}
function line(db, vid, { service_id = null, clinic_item_id = null, doctor_id = null, qty = 1, unit_price = 1, status = 'added', origin = null, by = DOC, created_at = null } = {}) {
  const info = db.prepare(`INSERT INTO visit_services (visit_id, service_id, clinic_item_id, doctor_id, quantity, unit_price, total, status, sync_origin, created_by, created_at)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, strftime('%Y-%m-%dT%H:%M:%SZ','now')))`)
    .run(vid, service_id, clinic_item_id, doctor_id, qty, unit_price, unit_price * qty, status, origin, by, created_at);
  return Number(info.lastInsertRowid);
}
const unbilled = (db, user = cashier) => RPC.cashier_unbilled(db, {}, user);
const rowOf = (db, vid) => unbilled(db).rows.find((r) => r.visit_id === vid);
const refused = (fn) => assert.throws(fn, (e) => e.status === 403);

test('визит направления без счёта: пациент, сумма по ценам счёта, услуги и товары, «добавил»', () => {
  const { db, CONS, LAB, BANDAGE, pid } = seed();
  const vid = visit(db, pid);
  line(db, vid, { service_id: CONS, doctor_id: DOC });                 // личная цена врача 150 000
  line(db, vid, { service_id: LAB, qty: 2 });                          // 2 × 40 000 по каталогу
  line(db, vid, { clinic_item_id: BANDAGE, unit_price: 5000, qty: 3 }); // товар — сохранённой ценой строки
  const r = rowOf(db, vid);
  assert.ok(r, 'визит направления кассе не виден');
  assert.equal(r.patient_id, pid);
  assert.equal(r.patient_name, 'Рахимов Жасур');
  assert.equal(r.mrn, 'A-000015');
  assert.equal(r.phone, '+998901112233');
  assert.equal(r.date_of_birth, '1990-05-01');
  assert.equal(r.gender, 'male');
  assert.equal(r.visit_date, dayAt(db, 0));
  assert.equal(r.lines_count, 3);
  assert.equal(r.total, 150000 + 80000 + 15000, 'сумма — как её выставит счёт, а не цены, присланные браузером');
  assert.deepEqual([...r.names].sort(), ['Анализ крови', 'Бинт', 'Приём терапевта']);
  assert.equal(r.added_by, 'Иванов Врач');
  const out = unbilled(db);
  assert.equal(out.totals.n, 1);
  assert.equal(out.totals.sum, 245000);
});

test('выставленные строки не попадают; у визита с частью счёта — только невыставленные', () => {
  const { db, LAB, CONS, pid } = seed();
  const full = visit(db, pid);
  const f1 = line(db, full, { service_id: LAB });
  createInvoiceForVisit(db, { visit_id: full, visit_service_ids: [f1] }, registrar);
  assert.equal(rowOf(db, full), undefined, 'выставленный визит «ждёт счёта»');

  const part = visit(db, pid);
  const p1 = line(db, part, { service_id: LAB });
  line(db, part, { service_id: CONS });
  createInvoiceForVisit(db, { visit_id: part, visit_service_ids: [p1] }, registrar);
  const r = rowOf(db, part);
  assert.ok(r);
  assert.equal(r.lines_count, 1);
  assert.equal(r.total, 100000);
  assert.deepEqual(r.names, ['Приём терапевта']);
});

test('отменённые строки не попадают', () => {
  const { db, LAB, CONS, pid } = seed();
  const vid = visit(db, pid);
  line(db, vid, { service_id: LAB, status: 'cancelled' });
  assert.equal(rowOf(db, vid), undefined);
  line(db, vid, { service_id: CONS });
  const r = rowOf(db, vid);
  assert.equal(r.lines_count, 1);
  assert.equal(r.total, 100000);
});

test('строки и визиты другого здания (sync_origin) не попадают', () => {
  const { db, LAB, CONS, pid } = seed();
  const own = visit(db, pid);
  line(db, own, { service_id: LAB, origin: 'B' });
  assert.equal(rowOf(db, own), undefined, 'строка соседа — его касса');
  line(db, own, { service_id: CONS });
  assert.equal(rowOf(db, own).total, 100000);
  const alien = visit(db, pid, { origin: 'B' });
  line(db, alien, { service_id: CONS });
  assert.equal(rowOf(db, alien), undefined, 'визит соседа — его касса');
});

test('строки, отпущенные с возвратом, не попадают — они в «Возвратах и отменах»', () => {
  const { db, LAB, CONS, pid } = seed();
  // Возврат строки: работа сделана — строка осталась в визите невыставленной, с отметкой.
  const a = visit(db, pid);
  const la = line(db, a, { service_id: LAB });
  const inv = createInvoiceForVisit(db, { visit_id: a, visit_service_ids: [la] }, registrar).invoice;
  recordPayment(db, { invoice_id: inv.id, amount: 40000, method: 'cash' }, cashier);
  db.prepare("UPDATE visit_services SET status = 'completed' WHERE id = ?").run(la);
  const item = db.prepare('SELECT id FROM invoice_items WHERE invoice_id = ?').get(inv.id).id;
  RPC.refund_invoice_line(db, { invoice_item_id: item, reason: 'передумал' }, cashier);
  assert.equal(db.prepare('SELECT invoice_item_id FROM visit_services WHERE id = ?').get(la).invoice_item_id, null, 'строка отпущена');
  assert.equal(rowOf(db, a), undefined, 'возвращённая строка «ждёт счёта»');
  const today = db.prepare("SELECT date('now', 'localtime') d").get().d;
  const rf = RPC.cashier_refunds(db, { from: today, to: today }, cashier).rows.find((r) => r.visit_id === a);
  assert.ok(rf && rf.rebill_lines.some((l) => l.id === la && l.refunded), 'её видно в «Возвратах и отменах»');
  // Обычная отмена с «Оставить услуги» (без возврата) — строка ждёт нового счёта.
  const b = visit(db, pid);
  const lb = line(db, b, { service_id: CONS });
  const invB = createInvoiceForVisit(db, { visit_id: b, visit_service_ids: [lb] }, registrar).invoice;
  voidInvoice(db, { invoice_id: invB.id, keep_services: true, reason: 'другой врач' }, cashier);
  assert.equal(rowOf(db, b).total, 100000, 'отпущенная без возврата строка ждёт счёта');
});

test('бесплатные строки: визит с нулевой суммой не попадает, платная рядом — считается', () => {
  const { db, FREE, LAB, pid } = seed();
  const zero = visit(db, pid);
  line(db, zero, { service_id: FREE });
  assert.equal(rowOf(db, zero), undefined, 'бесплатному визиту платить нечего');
  const mixed = visit(db, pid);
  line(db, mixed, { service_id: FREE });
  line(db, mixed, { service_id: LAB });
  const r = rowOf(db, mixed);
  assert.equal(r.total, 40000);
  assert.equal(r.lines_count, 2);
});

// REFBILL_REVIEW_V1 (ревью M1) — будущие визиты по умолчанию не показываются
// (записи колл-центра топили направления); они — в свой день или поиском.
test('визит старше 30 местных дней не попадает; ровно 30 дней — попадает; будущий — только поиском', () => {
  const { db, LAB, pid } = seed();
  const old = visit(db, pid, { offset: -31 });
  line(db, old, { service_id: LAB });
  const edge = visit(db, pid, { offset: -30 });
  line(db, edge, { service_id: LAB });
  const future = visit(db, pid, { offset: 10 });
  line(db, future, { service_id: LAB });
  assert.equal(rowOf(db, old), undefined, 'визит 31 день назад');
  assert.ok(rowOf(db, edge), 'визит ровно 30 дней назад');
  assert.equal(rowOf(db, future), undefined, 'будущий визит по умолчанию');
  const found = RPC.cashier_unbilled(db, { q: 'Рахимов' }, cashier).rows.map((r) => r.visit_id);
  assert.deepEqual(found, [future, edge], 'поиск: будущий и ровно 30 дней назад, но не 31');
});

test('отменённый и несостоявшийся («не пришёл») визит не попадает', () => {
  const { db, LAB, pid } = seed();
  const cancelled = visit(db, pid, { status: 'cancelled' });
  line(db, cancelled, { service_id: LAB });
  const noShow = visit(db, pid, { status: 'no_show' });
  line(db, noShow, { service_id: LAB });
  const arrived = visit(db, pid, { status: 'arrived' });
  line(db, arrived, { service_id: LAB });
  assert.equal(rowOf(db, cancelled), undefined);
  assert.equal(rowOf(db, noShow), undefined);
  assert.ok(rowOf(db, arrived));
});

test('порядок — по самой свежей строке; «добавил» — автор самой свежей строки; не больше 300 визитов', () => {
  const { db, LAB, CONS, pid, pid2 } = seed();
  const older = visit(db, pid);
  line(db, older, { service_id: LAB, by: 7, created_at: '2026-09-29T03:00:00Z' });
  const newer = visit(db, pid2);
  line(db, newer, { service_id: LAB, by: DOC, created_at: '2026-09-29T04:00:00Z' });
  // В старший визит строку добавили позже всех — он становится первым.
  line(db, older, { service_id: CONS, by: 1, created_at: '2026-09-29T05:00:00Z' });
  const rows = unbilled(db).rows;
  assert.deepEqual(rows.map((r) => r.visit_id), [older, newer]);
  assert.equal(rows[0].added_by, 'Админ', 'автор самой свежей строки');
  assert.equal(rows[1].added_by, 'Иванов Врач');

  for (let i = 0; i < 300; i++) line(db, visit(db, pid), { service_id: LAB });
  const out = unbilled(db);
  assert.equal(out.rows.length, 300, 'список ограничен 300 визитами');
  assert.equal(out.totals.n, 302, 'а счётчик плашки — все ждущие');
});

test('роли: касса, старший кассир и администратор — да; регистратура и врач — нет; только чтение', () => {
  const { db, LAB, pid } = seed();
  line(db, visit(db, pid), { service_id: LAB });
  for (const who of [cashier, head, admin]) assert.equal(unbilled(db, who).rows.length, 1, who.full_name);
  refused(() => unbilled(db, registrar));
  refused(() => unbilled(db, doctor));
  assert.equal(isReadOnlyRpc('cashier_unbilled'), true, 'чтение доступно и клинике с просроченной лицензией');
});

// ─── Решение владельца 2026-09-29: «Card's payer, can split» ────────────────
// Касса выставляет строки «Ждут счёта» плательщику ИЗ КАРТЫ пациента (только
// ему) или пациенту, и может разделить: часть строк плательщику, остальное
// пациенту. Счёт плательщику — create_invoice_for_visit с payer_id, как в
// мастере визита (COVERAGE_SPLIT_V1). Сервер уже умеет это для СУЩЕСТВУЮЩИХ
// строк — здесь это проверено: цены сервера, без скидки группы пациента
// (BILLING_AUDIT_FIX_V1, B5), строки сразу в очередь (V3120_FIX, FATAL-2), в
// «Приём оплат» счёт плательщика не попадает.
function insured(db, pid, { active = 1, vip = false } = {}) {
  const payer = Number(db.prepare("INSERT INTO payers (name, kind, active) VALUES ('Esado', 'insurance', ?)").run(active).lastInsertRowid);
  db.prepare("UPDATE patients SET payer_id = ?, insurance_policy_number = 'POL-77' WHERE id = ?").run(payer, pid);
  if (vip) {
    const cat = db.prepare("INSERT INTO patient_categories (name, discount_percent, active) VALUES ('VIP', 10, 1)").run().lastInsertRowid;
    db.prepare('UPDATE patients SET category_id = ? WHERE id = ?').run(cat, pid);
  }
  return payer;
}
const invoicesListed = (db) => RPC.cashier_invoices(db, {}, cashier).rows.map((r) => r.id);

test('«Ждут счёта» несёт плательщика из карты: действующий — имя, вид и полис; выключенный и отсутствующий — пусто', () => {
  const { db, LAB, pid, pid2 } = seed();
  const payer = insured(db, pid);
  line(db, visit(db, pid), { service_id: LAB });
  line(db, visit(db, pid2), { service_id: LAB });
  const rows = unbilled(db).rows;
  const a = rows.find((r) => r.patient_id === pid);
  assert.deepEqual([a.card_payer_id, a.card_payer_name, a.card_payer_kind, a.card_policy_no], [payer, 'Esado', 'insurance', 'POL-77']);
  const b = rows.find((r) => r.patient_id === pid2);
  assert.deepEqual([b.card_payer_id, b.card_payer_name, b.card_payer_kind], [null, null, null], 'без плательщика в карте — выбора нет');
  db.prepare('UPDATE payers SET active = 0 WHERE id = ?').run(payer);
  const off = unbilled(db).rows.find((r) => r.patient_id === pid);
  assert.deepEqual([off.card_payer_id, off.card_payer_name], [null, null], 'выключенный плательщик — не плательщик');
});

test('касса выставляет существующие строки плательщику из карты: цены сервера, без скидки группы, строки в очередь, в «Приём оплат» не попадает', () => {
  const { db, LAB, CONS, pid } = seed();
  const payer = insured(db, pid, { vip: true });
  const vid = visit(db, pid);
  const a = line(db, vid, { service_id: LAB });
  const b = line(db, vid, { service_id: CONS, doctor_id: DOC });
  const out = RPC.create_invoice_for_visit(db, { visit_id: vid, visit_service_ids: [a, b], payer_id: payer, discount_amount: 0 }, cashier);
  assert.equal(out.invoice.payer_id, payer);
  assert.equal(out.invoice.status, 'unpaid', 'долг плательщика, а не оплата');
  assert.equal(out.invoice.subtotal, 190000, 'анализ по каталогу 40 000 + приём по цене врача 150 000 — не присланные 1 + 1');
  assert.equal(out.invoice.discount_amount, 0, 'скидка группы пациента на счёт плательщика не идёт');
  assert.deepEqual(db.prepare('SELECT status FROM visit_services WHERE id IN (?, ?) ORDER BY id').all(a, b).map((r) => r.status), ['queued', 'queued'],
    'денег у кассы по нему не будет — строки сразу в очереди');
  assert.ok(!invoicesListed(db).includes(out.invoice.id), 'счёт плательщика в «Приёме оплат»');
  assert.equal(rowOf(db, vid), undefined, 'выставленный визит всё ещё «ждёт счёта»');
});

test('раздельно: часть строк плательщику, остальное пациенту — оба счёта верны, в кассе только счёт пациента', () => {
  const { db, LAB, CONS, pid } = seed();
  const payer = insured(db, pid, { vip: true });
  const vid = visit(db, pid);
  const a = line(db, vid, { service_id: LAB });
  const b = line(db, vid, { service_id: CONS });
  // Первый проход — анализ плательщику.
  const toPayer = RPC.create_invoice_for_visit(db, { visit_id: vid, visit_service_ids: [a], payer_id: payer, discount_amount: 0 }, cashier).invoice;
  const still = rowOf(db, vid);
  assert.ok(still, 'невыставленная строка ждёт второго прохода');
  assert.equal(still.lines_count, 1);
  assert.equal(still.total, 100000);
  // Второй проход — приём пациенту: скидка группы — его.
  const toPatient = RPC.create_invoice_for_visit(db, { visit_id: vid, visit_service_ids: [b] }, cashier).invoice;
  assert.deepEqual([toPayer.payer_id, toPayer.total_amount, toPayer.discount_amount], [payer, 40000, 0]);
  assert.deepEqual([toPatient.payer_id, toPatient.total_amount, toPatient.discount_amount], [null, 90000, 10000]);
  const listed = invoicesListed(db);
  assert.ok(listed.includes(toPatient.id), 'счёт пациента — в «Приёме оплат»');
  assert.ok(!listed.includes(toPayer.id), 'счёт плательщика — нет');
  assert.equal(rowOf(db, vid), undefined);
});
