// BOOKING_CANCEL_GUARD_V1 — ОТМЕНА ЗАПИСИ НЕ ОТМЕНЯЕТ ПРИЁМ, ЗА КОТОРЫЙ ЗАПЛАТИЛИ.
//
// Отмена визита — calendar_book со status 'cancelled' — пропускала любой визит:
// «Бронирование» (строка, нарисованная до прихода пациента), календарь «Записи»,
// окно визита. Ревью (проба P3): пришедший пациент, счёт оплачен 100 000 —
// визит стал «Отменён», счёт остался «Оплачен». Что утверждается здесь:
//   1. отказывает САМ сервер (409, код cancel_refused, слова для экрана), визит
//      и счёт не меняются, если: строка ушла дальше сметы (очередь, работа,
//      результат); по счёту есть оплата; счёт в долг; выставлен неоплаченный
//      счёт (сначала его отменяет касса);
//   2. отменяется по-прежнему запись без денег и работы — со строкой в смете, с
//      отменённым или возвращённым счётом; повторная отмена отменённой записи —
//      не ошибка;
//   3. RELEASE_SELECT_V1 (ревью, решение владельца) — «пациент пришёл» отказом
//      больше не служит: пришёл и ушёл (все строки в смете или отменены, денег и
//      долга нет) — визит отменяется; пришёл, а работа, деньги, долг или счёт есть —
//      отказ по ним, как у записи до прихода.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { calendarBook } from './calendar.js';

const REG = { id: 2, role: 'registrar' };

function fresh() {
  const db = openDb(':memory:'); migrate(db);
  const run = (sql, ...a) => db.prepare(sql).run(...a).lastInsertRowid;
  run("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (2,'reg','x','Рег','registrar')");
  run("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (3,'doc','x','Врач','doctor',1)");
  run("INSERT INTO services (id, name, price) VALUES (21,'Консультация',100000)");
  return { db, run };
}

/** Визит пациента через час (или полчаса назад для пришедшего) со строкой в смете. */
function visit(env, { status = 'scheduled', line = 'added' } = {}) {
  const { run } = env;
  const p = run("INSERT INTO patients (full_name, branch_id) VALUES ('П',1)");
  const when = new Date(Date.now() + (status === 'arrived' ? -30 : 60) * 60000).toISOString();
  const v = run('INSERT INTO visits (patient_id, doctor_id, visit_date, status) VALUES (?,?,?,?)', p, 3, when, status);
  if (line) run('INSERT INTO visit_services (visit_id, service_id, doctor_id, unit_price, total, status) VALUES (?,21,3,100000,100000,?)', v, line);
  return { p, v, when };
}
function invoice(env, x, { total = 100000, paid = 0, status = 'unpaid', pay = null } = {}) {
  const inv = env.run('INSERT INTO invoices (patient_id, visit_id, total_amount, paid_amount, status) VALUES (?,?,?,?,?)', x.p, x.v, total, paid, status);
  if (pay) env.run("INSERT INTO payments (invoice_id, amount, method) VALUES (?,?,'cash')", inv, pay);
  return inv;
}
const cancel = (db, x) => calendarBook(db, { visit_id: x.v, start: x.when, status: 'cancelled' }, REG);
const statusOf = (db, id) => db.prepare('SELECT status FROM visits WHERE id = ?').get(id).status;

async function refused(env, x, re) {
  await assert.rejects(cancel(env.db, x), (e) => {
    assert.equal(e.status, 409, 'не 409: ' + e.message);
    assert.equal(e.code, 'cancel_refused');
    assert.match(e.message, re);
    return true;
  });
  assert.notEqual(statusOf(env.db, x.v), 'cancelled', 'визит всё-таки отменён');
}

test('BOOKING_CANCEL_GUARD_V1: проба P3 — пришёл и оплатил 100 000 — отмена отказана, визит и счёт не тронуты', async () => {
  const env = fresh();
  const x = visit(env, { status: 'arrived' });
  const inv = invoice(env, x, { paid: 100000, status: 'paid', pay: 100000 });
  await refused(env, x, /есть оплата/);   // RELEASE_SELECT_V1 (ревью) — отказ по деньгам, а не по приходу
  assert.equal(statusOf(env.db, x.v), 'arrived');
  assert.deepEqual(env.db.prepare('SELECT status, paid_amount FROM invoices WHERE id = ?').get(inv), { status: 'paid', paid_amount: 100000 });
});

test('BOOKING_CANCEL_GUARD_V1: оплата, частичная оплата и долг — отказ, даже если «Пришёл» не нажимали', async () => {
  const env = fresh();
  const paid = visit(env);
  invoice(env, paid, { paid: 100000, status: 'paid', pay: 100000 });
  await refused(env, paid, /есть оплата/);
  const part = visit(env);
  invoice(env, part, { paid: 40000, status: 'partial', pay: 40000 });
  await refused(env, part, /есть оплата/);
  const debt = visit(env);
  invoice(env, debt, { paid: 0, status: 'debt' });
  await refused(env, debt, /в долг/);
});

test('BOOKING_CANCEL_GUARD_V1: выставлен неоплаченный счёт — отказ: сначала касса отменяет счёт', async () => {
  const env = fresh();
  const x = visit(env);
  invoice(env, x, { status: 'unpaid' });
  await refused(env, x, /отмените счёт в кассе/);
});

test('BOOKING_CANCEL_GUARD_V1: строка в очереди, в работе или выполнена — отказ', async () => {
  const env = fresh();
  for (const st of ['queued', 'collected', 'in_progress', 'resulted', 'completed']) {
    await refused(env, visit(env, { line: st }), /идёт работа/);
  }
});

// RELEASE_SELECT_V1 (ревью, решение владельца) — пациент пришёл и ушёл, ничего не сделано,
// денег и долга нет: визит отменяется. Остальные отказы — те же и у пришедшего.
test('BOOKING_CANCEL_GUARD_V1 (ревью): пришёл и ушёл без работы, денег и долга — отменяется; с работой, деньгами, долгом, счётом — отказ', async () => {
  const env = fresh();
  const left = visit(env, { status: 'arrived' });
  assert.equal((await cancel(env.db, left)).visit.status, 'cancelled', 'строка в смете — не работа');
  const bare = visit(env, { status: 'arrived', line: null });
  assert.equal((await cancel(env.db, bare)).visit.status, 'cancelled', 'пришёл, строк нет');
  const dropped = visit(env, { status: 'arrived', line: 'cancelled' });
  assert.equal((await cancel(env.db, dropped)).visit.status, 'cancelled', 'отменённая строка — не работа');
  const voided = visit(env, { status: 'arrived' });
  invoice(env, voided, { status: 'void' });
  assert.equal((await cancel(env.db, voided)).visit.status, 'cancelled', 'отменённый кассой счёт отмену не держит');
  for (const st of ['queued', 'collected', 'in_progress', 'completed']) {
    await refused(env, visit(env, { status: 'arrived', line: st }), /идёт работа/);
  }
  const paid = visit(env, { status: 'arrived' });
  invoice(env, paid, { paid: 40000, status: 'partial', pay: 40000 });
  await refused(env, paid, /есть оплата/);
  const debt = visit(env, { status: 'arrived' });
  invoice(env, debt, { status: 'debt' });
  await refused(env, debt, /в долг/);
  const billed = visit(env, { status: 'arrived' });
  invoice(env, billed, { status: 'unpaid' });
  await refused(env, billed, /отмените счёт в кассе/);
});

test('BOOKING_CANCEL_GUARD_V1: запись до прихода без денег и работы отменяется, как раньше', async () => {
  const env = fresh();
  const plain = visit(env);
  assert.equal((await cancel(env.db, plain)).visit.status, 'cancelled', 'строка в смете — не работа');
  const bare = visit(env, { line: null });
  assert.equal((await cancel(env.db, bare)).visit.status, 'cancelled');
  const confirmed = visit(env, { status: 'confirmed', line: 'cancelled' });
  assert.equal((await cancel(env.db, confirmed)).visit.status, 'cancelled', 'отменённая строка — не работа');
  const voided = visit(env);
  invoice(env, voided, { status: 'void' });
  assert.equal((await cancel(env.db, voided)).visit.status, 'cancelled', 'отменённый кассой счёт отмену не держит');
  const back = visit(env);
  invoice(env, back, { status: 'refunded', paid: 0 });
  assert.equal((await cancel(env.db, back)).visit.status, 'cancelled', 'деньги возвращены полностью — отменить можно');
  // Повторная отмена (строка «Бронирования» нарисована до первой) — не ошибка.
  assert.equal((await cancel(env.db, plain)).visit.status, 'cancelled');
});
