// REFUND_ANY_V1 (ревью B4, п. 9b) — ВОЗВРАЩЁННАЯ СТРОКА БЕЗ СЛЕДА РАБОТЫ В РАБОТУ НЕ ИДЁТ.
//
// Касса вернула деньги за строку, по которой работы не было, и оставила её в
// визите («Оставить услугу в визите»: строка 'added' без счёта, отметка
// pay_refund_releases 'out'). Перевод такой строки в работу («В очереди»,
// «Идёт приём», «Выполнено» — /api/db, отметка процедуры) — отказ словами
// возврата, у любой услуги, не только у анализа (у анализа — свои слова,
// REFUNDED_LAB_REFUSAL). Отменить — можно. Строка со следом работы (статус
// работы, документ, результат, сообщение прибора) — как прежде: её дописывают.
// Правило «есть работа» одно (domain/line-work.js lineHasWork, прежде — в
// billing.js; billing.js отдаёт его дальше).
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { hashPassword } from '../auth.js';
import { createApp } from '../../app.js';
import { licensedDataDir } from '../control/licensed-fixture.js';
import { listen } from '../../../control-plane/server/test-helpers/listen.js';
import { createInvoiceForVisit, recordPayment, refundInvoiceLine, lineHasWork, PERFORMED_LINE_STATUSES } from './billing.js';
import * as LINE_WORK from '../domain/line-work.js';
import { openCashShift } from './cashier.js';
import { procedureComplete } from './procedures.js';
import { unpaidWorkRefusal } from '../visit-status-guard.js';
import { REFUNDED_WORK_REFUSAL, REFUNDED_LAB_REFUSAL } from '../../../public/js/shared/refunded-line.js';

const registrar = { id: 7, role: 'registrar' };
const cashier = { id: 9, role: 'cashier', full_name: 'Кассир' };
const nurse = { id: 2, role: 'nurse' };
const DOC = 20;

function seed() {
  const db = openDb(':memory:'); migrate(db);
  const u = db.prepare(`INSERT INTO users (id, username, password_hash, role, full_name, is_doctor, is_active, must_change_password)
                        VALUES (?,?,?,?,?,?,1,0)`);
  u.run(2, 'nur', 'x', 'nurse', 'Сестра', 0);
  u.run(7, 'reg', 'x', 'registrar', 'Регистратор', 0);
  u.run(9, 'cash', 'x', 'cashier', 'Кассир', 0);
  u.run(DOC, 'doc', hashPassword('password1'), 'doctor', 'Врач', 1);
  const pid = db.prepare("INSERT INTO patients (full_name) VALUES ('Пациент')").run().lastInsertRowid;
  const vid = db.prepare("INSERT INTO visits (patient_id, visit_date) VALUES (?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))").run(pid).lastInsertRowid;
  const svc = db.prepare('INSERT INTO services (name, price, type, is_lab) VALUES (?, ?, ?, ?)');
  const consult = svc.run('Приём', 100000, 'consultation', 0).lastInsertRowid;
  const proc = svc.run('Перевязка', 50000, 'procedure', 0).lastInsertRowid;
  const cbc = svc.run('ОАК', 40000, 'lab', 1).lastInsertRowid;
  const line = db.prepare('INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total) VALUES (?, ?, ?, 1, 0, 0)');
  const a = line.run(vid, consult, DOC).lastInsertRowid;   // приём — оставлен в визите после возврата
  const b = line.run(vid, proc, null).lastInsertRowid;     // процедура — оставлена в визите после возврата
  const c = line.run(vid, cbc, null).lastInsertRowid;      // анализ — оставлен в визите после возврата
  const d = line.run(vid, consult, DOC).lastInsertRowid;   // приём шёл — возвращён со следом работы
  openCashShift(db, { opening_float: 0 }, cashier);
  const inv = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [a, b, c, d] }, registrar).invoice;
  recordPayment(db, { invoice_id: inv.id, amount: inv.total_amount, method: 'cash' }, cashier);
  db.prepare("UPDATE visit_services SET status = 'in_progress' WHERE id = ?").run(d);
  const itemOf = (id) => db.prepare('SELECT invoice_item_id i FROM visit_services WHERE id = ?').get(id).i;
  for (const id of [a, b, c]) refundInvoiceLine(db, { invoice_item_id: itemOf(id), keep_services: true }, cashier);
  refundInvoiceLine(db, { invoice_item_id: itemOf(d) }, cashier);
  // Обычная неоплаченная строка того же визита — для прежних слов «ещё не оплачена».
  const e = db.prepare("INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status) VALUES (?, ?, ?, 1, 100000, 100000, 'added')")
    .run(vid, consult, DOC).lastInsertRowid;
  return { db, vid, a, b, c, d, e };
}
const statusOf = (db, id) => db.prepare('SELECT status FROM visit_services WHERE id = ?').get(id).status;

test('правило «есть работа» одно: billing.js отдаёт то же, что domain/line-work.js', () => {
  assert.equal(lineHasWork, LINE_WORK.lineHasWork, 'вторая копия lineHasWork');
  assert.equal(PERFORMED_LINE_STATUSES, LINE_WORK.PERFORMED_LINE_STATUSES);
});

test('возвращённая строка без следа работы: любой перевод в работу — отказ словами возврата; отменить — можно', () => {
  const f = seed();
  assert.deepEqual([statusOf(f.db, f.a), statusOf(f.db, f.b), statusOf(f.db, f.c)], ['added', 'added', 'added']);
  for (const next of ['queued', 'in_progress', 'completed']) {
    assert.equal(unpaidWorkRefusal(f.db, [f.a], next), REFUNDED_WORK_REFUSAL, 'приём → ' + next);
    assert.equal(unpaidWorkRefusal(f.db, [f.b], next), REFUNDED_WORK_REFUSAL, 'процедура → ' + next);
  }
  assert.equal(unpaidWorkRefusal(f.db, [f.c], 'collected'), REFUNDED_LAB_REFUSAL, 'анализ — своими словами');
  assert.equal(unpaidWorkRefusal(f.db, [f.a], 'cancelled'), null, 'отменить — можно');
  assert.equal(unpaidWorkRefusal(f.db, [f.a], 'added'), null);
  // Со следом работы — дописывают, как прежде.
  assert.equal(statusOf(f.db, f.d), 'in_progress');
  assert.equal(unpaidWorkRefusal(f.db, [f.d], 'completed'), null, 'начатый возвращённый приём завершают');
  // Обычная неоплаченная строка — прежние слова.
  assert.match(unpaidWorkRefusal(f.db, [f.e], 'in_progress'), /ещё не оплачена/);
});

test('процедура: отметка «Выполнено» на возвращённой строке без следа работы — 409 словами возврата, строка не тронута', () => {
  const f = seed();
  assert.throws(() => procedureComplete(f.db, { kind: 'outpatient', id: f.b, notes: '' }, nurse),
    (e) => e.status === 409 && e.message === REFUNDED_WORK_REFUSAL);
  assert.equal(statusOf(f.db, f.b), 'added');
  assert.equal(f.db.prepare('SELECT verified_by FROM visit_services WHERE id = ?').get(f.b).verified_by, null);
});

test('/api/db: перевод возвращённой строки в работу — 409 словами возврата; отмена — проходит', async () => {
  const f = seed();
  const server = await listen(createApp(f.db, { dataDir: licensedDataDir() }));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'doc', password: 'password1' }) });
    assert.equal(res.status, 200);
    const cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    const setStatus = async (id, status) => {
      const r = await fetch(base + '/api/db', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ table: 'visit_services', op: 'update', values: { status }, filters: [{ col: 'id', op: 'eq', val: id }] }) });
      return { status: r.status, json: await r.json().catch(() => ({})) };
    };
    let r = await setStatus(f.a, 'in_progress');
    assert.equal(r.status, 409, JSON.stringify(r.json));
    assert.equal(r.json.error.message, REFUNDED_WORK_REFUSAL);
    assert.equal(statusOf(f.db, f.a), 'added');
    r = await setStatus(f.a, 'cancelled');
    assert.equal(r.status, 200, 'отмена возвращённой строки — можно. ' + JSON.stringify(r.json));
  } finally { server.close(); }
});
