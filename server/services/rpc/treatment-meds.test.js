// MED_ADMIN_CHARGE_V1 (Задача 6) — отметка о введении списывает препарат со
// склада и попадает в счёт.
//
// Проверяется ровно то, что в клинике стоит денег и здоровья:
//   • одна отметка = ОДНО движение товара и ОДНА строка счёта;
//   • второе нажатие на общем планшете не списывает и не начисляет второй раз;
//   • снятие отметки возвращает и склад, и деньги, а второе снятие не
//     возвращает их ещё раз;
//   • препарат ПАЦИЕНТА записывается, но не списывается и не начисляется;
//   • количество, не выводимое из дозы, НЕ УГАДЫВАЕТСЯ: доза записана, списание
//     пропущено, и это видно и считается;
//   • расход сверх дозы виден ОТДЕЛЬНОЙ строкой, а не спрятан в дозе;
//   • пустой склад не отменяет медицинскую запись, но ведёт себя ровно как в
//     амбулатории — в минус не уходит;
//   • начисление попадает на нужную госпитализацию и доходит до счёта.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { dueAtMs } from '../domain/mar-schedule.js';
import {
  treatmentOrderCreate, treatmentOrdersList,
  treatmentAdminMark, treatmentAdminUnmark, treatmentTasksDue,
} from './treatment-orders.js';
// RpcError склада — СВОЙ класс, не тот, что у листа назначений (inventory.js
// объявляет собственный). Отсюда и псевдоним: перепутав их, тест проверял бы
// не то, чем склад отказывает.
import { dispenseItem, RpcError as StockError } from './inventory.js';
import { createInvoiceForAdmission } from './billing.js';
import { isMedAdminLine, isExtraConsumptionLine, medAdminIdOf } from '../../../public/js/shared/med-admin-line.js';

const ACTOR = {
  admin:        { id: 9, role: 'admin' },
  doctor:       { id: 1, role: 'doctor' },
  nurse:        { id: 2, role: 'nurse' },
  senior_nurse: { id: 5, role: 'nurse', extra_roles: ['senior_nurse'] },
  registrar:    { id: 6, role: 'registrar' },
};

const START = '2026-09-04';
const localTs = (date, hour, min = 0) => new Date(dueAtMs(date, hour) + min * 60000).toISOString();

// Склад клиники. Единицы разные НАМЕРЕННО: на них и держится половина этих
// тестов — «1 г» при складе в штуках количества не даёт.
function seed() {
  const db = openDb(':memory:');
  migrate(db);
  const u = db.prepare('INSERT INTO users (id, username, password_hash, full_name, role) VALUES (?,?,?,?,?)');
  u.run(1, 'doc', 'x', 'Лечащий', 'doctor');
  u.run(2, 'nur', 'x', 'Медсестра', 'nurse');
  u.run(5, 'snur', 'x', 'Старшая', 'nurse');
  u.run(6, 'reg', 'x', 'Регистратура', 'registrar');
  u.run(9, 'boss', 'x', 'Админ', 'admin');
  db.prepare("INSERT INTO patients (id, full_name) VALUES (1,'Иванов Иван'),(2,'Петров Пётр')").run();
  db.prepare("INSERT INTO wards (id, name, billing_mode, price_per_day) VALUES (1,'Терапия','daily',150000),(2,'Хирургия','daily',250000)").run();
  db.prepare("INSERT INTO beds (id, code, ward_id, status) VALUES (1,'K-1',1,'occupied'),(2,'K-2',2,'occupied')").run();
  db.prepare("INSERT INTO services (id, name, price) VALUES (1,'Инъекция в/м',20000)").run();
  const p = db.prepare('INSERT INTO products (id, name, unit, category, sale_price, on_hand, active) VALUES (?,?,?,?,?,?,1)');
  p.run(1, 'Цефтриаксон 1 г', 'шт', 'drug', 12000, 20);       // штучный флакон
  p.run(2, 'Натрия хлорид 0,9%', 'мл', 'drug', 200, 500);     // объёмный
  p.run(3, 'Шприц 5 мл', 'шт', 'consumable', 1500, 100);      // расход сверх дозы
  p.run(4, 'Кеторол', 'шт', 'drug', 8000, 0);                 // пустой остаток
  return db;
}

function admission(db, over = {}) {
  const cols = { patient_id: 1, ward_id: 1, bed_id: 1, doctor_id: 1, attending_doctor_id: 1, status: 'active', ...over };
  const keys = Object.keys(cols);
  return db.prepare(`INSERT INTO admissions (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
    .run(...keys.map((k) => cols[k])).lastInsertRowid;
}

function order(db, admissionId, over = {}) {
  return treatmentOrderCreate(db, {
    admission_id: admissionId, kind: 'med', name: 'Цефтриаксон', dose: '1 шт', route: 'в/м',
    freq_code: '3x', starts_on: START, days: 5, service_id: 1, stock_item_id: 1, ...over,
  }, ACTOR.doctor).order;
}

const mark = (db, o, over = {}, who = ACTOR.nurse) =>
  treatmentAdminMark(db, { order_id: o.id, date: START, slot: 6, status: 'given', ...over }, who);

// UNMARK_WINDOW_V1 — состарить отметку, не поспав пятнадцати минут: given_at
// переписывается ТЕМИ ЖЕ часами, по которым правило её и читает.
const ageMark = (db, id, minutes) => db.prepare(
  "UPDATE treatment_administrations SET given_at = strftime('%Y-%m-%dT%H:%M:%SZ','now',?) WHERE id = ?")
  .run(`-${minutes} minutes`, id);

const onHand = (db, id) => db.prepare('SELECT on_hand FROM products WHERE id = ?').get(id).on_hand;
const movements = (db, productId) => db.prepare(
  'SELECT * FROM stock_movements WHERE product_id = ? ORDER BY id').all(productId);
const lines = (db, admissionId) => db.prepare(
  'SELECT * FROM admission_services WHERE admission_id = ? ORDER BY id').all(admissionId);

// ─── 1. Одна отметка = одно списание и одно начисление ──────────────────────

test('отметка «дала» списывает препарат и создаёт строку счёта — по одной штуке', () => {
  const db = seed();
  const adm = admission(db);
  const o = order(db, adm);

  const r = mark(db, o);
  assert.equal(r.already, false);
  assert.equal(r.administration.status, 'given');
  assert.equal(r.stock.status, 'ok');
  assert.deepEqual(r.warnings, []);

  // Склад: ровно одно движение, ровно на одну единицу, в минус.
  assert.equal(onHand(db, 1), 19);
  const mv = movements(db, 1);
  assert.equal(mv.length, 1);
  assert.equal(mv[0].kind, 'dispense');
  assert.equal(mv[0].qty, -1);
  assert.equal(mv[0].reference_type, 'admission');
  assert.equal(mv[0].created_by, ACTOR.nurse.id);

  // Деньги: ровно одна строка госпитализации, ценой из каталога.
  const ls = lines(db, adm);
  assert.equal(ls.length, 1);
  assert.equal(ls[0].clinic_item_id, 1);
  assert.equal(ls[0].quantity, 1);
  assert.equal(ls[0].unit_price, 12000);
  assert.equal(ls[0].total, 12000);
  assert.equal(ls[0].billable, 1);
  // Движение указывает на ту же строку — склад и счёт связаны, а не рядом.
  assert.equal(mv[0].reference_id, ls[0].id);
  // Строка узнаётся как «введено по листу назначений» и несёт id ОТМЕТКИ.
  assert.ok(isMedAdminLine(ls[0]));
  assert.equal(medAdminIdOf(ls[0]), r.administration.id);
  assert.equal(isExtraConsumptionLine(ls[0]), false);
  db.close();
});

test('второе нажатие ничего не создаёт: одно списание и одно начисление', () => {
  const db = seed();
  const adm = admission(db);
  const o = order(db, adm);

  const first = mark(db, o);
  const second = mark(db, o);

  assert.equal(second.already, true);
  assert.equal(second.administration.id, first.administration.id);
  assert.equal(onHand(db, 1), 19, 'остаток не уехал на две штуки');
  assert.equal(movements(db, 1).length, 1);
  assert.equal(lines(db, adm).length, 1);
  // Ответ на повтор — тот же, что на первое нажатие: экран не должен решить,
  // что списание не прошло, и предложить провести его руками.
  assert.equal(second.stock.status, 'ok');
  assert.equal(second.charges.length, 1);
  // Форма ответа ОДНА: повтор отдаёт те же поля, что и первое нажатие.
  assert.equal(second.charges[0].line_id, first.charges[0].line_id);
  assert.deepEqual(Object.keys(second.charges[0]).sort(), Object.keys(first.charges[0]).sort());
  assert.equal(db.prepare('SELECT COUNT(*) n FROM treatment_administrations').get().n, 1);
  db.close();
});

test('явное количество из назначения списывается им, а не разбором дозы', () => {
  const db = seed();
  const adm = admission(db);
  // Врач сказал прямо: «на одну дозу уходит 4 мл», и текст дозы больше ни на
  // что не влияет.
  const o = order(db, adm, { name: 'Физраствор', dose: 'по схеме', stock_item_id: 2, stock_qty: 4 });

  const r = mark(db, o);
  assert.equal(r.stock.status, 'ok');
  assert.equal(r.stock.basis, 'order', 'списано по явному количеству, а не по разбору дозы');
  assert.equal(onHand(db, 2), 496);
  assert.equal(lines(db, adm)[0].total, 800);          // 4 мл × 200
  db.close();
});

// ─── 2. Возврат ─────────────────────────────────────────────────────────────

test('снятие отметки возвращает препарат на склад и убирает строку счёта', () => {
  const db = seed();
  const adm = admission(db);
  const o = order(db, adm);
  const m = mark(db, o);

  const back = treatmentAdminUnmark(db,
    { administration_id: m.administration.id, reason: 'не та койка' }, ACTOR.senior_nurse);

  assert.equal(back.already, false);
  assert.equal(back.reversal.reversed, 1);
  assert.equal(back.reversal.kept, 0);
  assert.equal(onHand(db, 1), 20, 'остаток вернулся полностью');
  assert.equal(lines(db, adm).length, 0, 'начисление снято');

  // След остался: отметка не удалена, движение возврата записано.
  assert.ok(back.administration.voided_at);
  assert.equal(back.administration.stock_status, 'reversed');
  const mv = movements(db, 1);
  assert.equal(mv.length, 2);
  assert.equal(mv[1].kind, 'void');
  assert.equal(mv[1].qty, 1);
  db.close();
});

// UNMARK_WINDOW_V1 — быстрое исправление медсестры идёт ТЕМ ЖЕ путём. Отдельная
// дорога для «своей» отметки означала бы вторую реализацию возврата денег, и
// разошлась бы она молча: склад вернулся бы, а строка счёта осталась.
test('своё снятие в первые 15 минут возвращает склад и деньги так же, как снятие старшей', () => {
  const db = seed();
  const adm = admission(db);
  const o = order(db, adm);
  const m = mark(db, o);                                  // отметила медсестра (id 2)
  assert.equal(onHand(db, 1), 19);
  assert.equal(lines(db, adm).length, 1);
  ageMark(db, m.administration.id, 3);

  const back = treatmentAdminUnmark(db,
    { administration_id: m.administration.id, reason: 'нажала не ту строку' }, ACTOR.nurse);

  assert.equal(back.already, false);
  assert.equal(back.reversal.reversed, 1);
  assert.equal(back.reversal.kept, 0);
  assert.equal(onHand(db, 1), 20, 'остаток вернулся полностью');
  assert.equal(lines(db, adm).length, 0, 'начисление снято');
  // След — такой же, как у старшей: скорость, а не тишина.
  assert.ok(back.administration.voided_at);
  assert.equal(back.administration.voided_by, 2);
  assert.equal(back.administration.void_reason, 'нажала не ту строку');
  assert.equal(back.administration.stock_status, 'reversed');
  const mv = movements(db, 1);
  assert.equal(mv.length, 2);
  assert.equal(mv[1].kind, 'void');
  db.close();
});

test('выставленная в счёт строка не отменяется и медсестрой — правило то же', () => {
  const db = seed();
  const adm = admission(db);
  const o = order(db, adm);
  const m = mark(db, o);
  const lineId = lines(db, adm)[0].id;
  createInvoiceForAdmission(db, { admission_id: adm, admission_service_ids: [lineId] }, ACTOR.registrar);
  ageMark(db, m.administration.id, 3);

  const back = treatmentAdminUnmark(db,
    { administration_id: m.administration.id, reason: 'ошиблась' }, ACTOR.nurse);

  // Ровно то же поведение, что у старшей (см. тест выше): клиническая запись
  // снимается, деньги — нет, и об этом говорят вслух.
  assert.equal(back.reversal.reversed, 0);
  assert.equal(back.reversal.kept, 1);
  assert.equal(back.warnings[0].code, 'invoiced');
  assert.match(back.warnings[0].message, /через кассу/);
  assert.equal(lines(db, adm).length, 1);
  assert.equal(onHand(db, 1), 19);
  assert.ok(back.administration.voided_at, 'сама отметка при этом снята');
  db.close();
});

test('второе снятие не возвращает второй раз', () => {
  const db = seed();
  const adm = admission(db);
  const o = order(db, adm);
  const m = mark(db, o);

  treatmentAdminUnmark(db, { administration_id: m.administration.id, reason: 'ошиблась' }, ACTOR.senior_nurse);
  const twice = treatmentAdminUnmark(db,
    { administration_id: m.administration.id, reason: 'ещё раз' }, ACTOR.senior_nurse);

  assert.equal(twice.already, true);
  assert.equal(twice.reversal.reversed, 0);
  assert.equal(onHand(db, 1), 20, 'остаток не вырос выше исходного');
  assert.equal(movements(db, 1).length, 2, 'второго возврата в журнале нет');
  assert.equal(lines(db, adm).length, 0);
  db.close();
});

test('после снятия слот свободен, и новая отметка списывает заново — один раз', () => {
  const db = seed();
  const adm = admission(db);
  const o = order(db, adm);
  const first = mark(db, o);
  treatmentAdminUnmark(db, { administration_id: first.administration.id, reason: 'ошиблась' }, ACTOR.senior_nurse);

  const again = mark(db, o);
  assert.equal(again.already, false);
  assert.notEqual(again.administration.id, first.administration.id);
  assert.equal(onHand(db, 1), 19);
  assert.equal(lines(db, adm).length, 1);
  // Новая строка помечена НОВОЙ отметкой — снятую она с собой не тянет.
  assert.equal(medAdminIdOf(lines(db, adm)[0]), again.administration.id);
  db.close();
});

test('выставленную в счёт строку снятие НЕ трогает, но говорит об этом', () => {
  const db = seed();
  const adm = admission(db);
  const o = order(db, adm);
  const m = mark(db, o);
  const lineId = lines(db, adm)[0].id;
  createInvoiceForAdmission(db, { admission_id: adm, admission_service_ids: [lineId] }, ACTOR.registrar);

  const back = treatmentAdminUnmark(db,
    { administration_id: m.administration.id, reason: 'ошиблась' }, ACTOR.senior_nurse);

  assert.equal(back.reversal.reversed, 0);
  assert.equal(back.reversal.kept, 1);
  assert.equal(back.warnings[0].code, 'invoiced');
  assert.match(back.warnings[0].message, /через кассу/);
  // За строкой уже стоят деньги пациента: ни счёт, ни остаток тайком не меняются.
  assert.equal(lines(db, adm).length, 1);
  assert.equal(onHand(db, 1), 19);
  assert.ok(back.administration.voided_at, 'сама отметка при этом снята');
  db.close();
});

// ─── 3. Препарат пациента ───────────────────────────────────────────────────

test('препарат пациента записывается, но не списывается и не начисляется', () => {
  const db = seed();
  const adm = admission(db);
  const o = order(db, adm, { source: 'patient' });

  const r = mark(db, o);
  assert.equal(r.administration.status, 'given', 'введение записано');
  assert.equal(r.stock.status, 'none');
  assert.equal(onHand(db, 1), 20);
  assert.equal(movements(db, 1).length, 0);
  assert.equal(lines(db, adm).length, 0);
  db.close();
});

test('назначение без ссылки на склад (уход) ничего не списывает', () => {
  const db = seed();
  const adm = admission(db);
  const o = order(db, adm, { kind: 'care', name: 'Перевязка', route: null, dose: '', stock_item_id: null });
  const r = mark(db, o);
  assert.equal(r.stock.status, 'none');
  assert.equal(lines(db, adm).length, 0);
  db.close();
});

test('отказ, пропуск и задержка дозы не списывают и не начисляют', () => {
  const db = seed();
  const adm = admission(db);
  const o = order(db, adm);
  const r = mark(db, o, { status: 'refused', reason: 'пациент отказался' });
  assert.equal(r.stock.status, '');
  assert.equal(onHand(db, 1), 20);
  assert.equal(lines(db, adm).length, 0);
  db.close();
});

// ─── 4. Количество не выводится из дозы ─────────────────────────────────────

test('нечитаемая доза: введение записано, списание пропущено и НАЗВАНО', () => {
  const db = seed();
  const adm = admission(db);
  // «1 г» при складе в штуках: один это флакон или два — не знает никто.
  const o = order(db, adm, { dose: '1 г' });

  const r = mark(db, o);
  assert.equal(r.administration.status, 'given', 'доза введена — факт записан');
  assert.equal(r.stock.status, 'skipped');
  assert.match(r.stock.note, /не списано: не удалось определить количество/);
  assert.equal(r.warnings[0].code, 'quantity');
  assert.match(r.warnings[0].message, /не списано: не удалось определить количество/);
  // Ничего не угадано: склад и счёт нетронуты.
  assert.equal(onHand(db, 1), 20);
  assert.equal(movements(db, 1).length, 0);
  assert.equal(lines(db, adm).length, 0);

  // И это СЧИТАЕТСЯ — иначе несписанное нашлось бы при инвентаризации.
  const list = treatmentOrdersList(db, { admission_id: adm, from: START, to: START }, ACTOR.nurse);
  assert.equal(list.stock_issues.count, 1);
  assert.equal(list.stock_issues.items[0].id, r.administration.id);
  const due = treatmentTasksDue(db, { date: START, now: localTs(START, 15) }, ACTOR.nurse);
  assert.equal(due.counts.stock_issues, 1);
  db.close();
});

test('снятая отметка перестаёт числиться несписанной', () => {
  const db = seed();
  const adm = admission(db);
  const o = order(db, adm, { dose: '1 г' });
  const m = mark(db, o);
  treatmentAdminUnmark(db, { administration_id: m.administration.id, reason: 'ошибка' }, ACTOR.senior_nurse);
  const list = treatmentOrdersList(db, { admission_id: adm, from: START, to: START }, ACTOR.nurse);
  assert.equal(list.stock_issues.count, 0);
  db.close();
});

// ─── 5. Расход сверх дозы ───────────────────────────────────────────────────

test('расход сверх дозы — ОТДЕЛЬНАЯ видимая строка, а не прибавка к дозе', () => {
  const db = seed();
  const adm = admission(db);
  const o = order(db, adm);

  const r = mark(db, o, { extra: [{ product_id: 3, qty: 2, name: 'Шприц (разбит)' }] });

  assert.equal(r.stock.status, 'ok');
  assert.equal(onHand(db, 1), 19, 'доза списана');
  assert.equal(onHand(db, 3), 98, 'сверхрасход списан');

  const ls = lines(db, adm);
  assert.equal(ls.length, 2, 'две строки, а не одна на всё');
  const dose = ls.find((l) => !isExtraConsumptionLine(l));
  const extra = ls.find((l) => isExtraConsumptionLine(l));
  assert.equal(dose.clinic_item_id, 1);
  assert.equal(dose.quantity, 1, 'доза осталась дозой — сверхрасход в неё не подмешан');
  assert.equal(extra.clinic_item_id, 3);
  assert.equal(extra.quantity, 2);
  assert.equal(extra.total, 3000);
  assert.equal(medAdminIdOf(extra), r.administration.id);
  db.close();
});

test('сверхрасход одного товара двумя записями — один расход, одна строка', () => {
  const db = seed();
  const adm = admission(db);
  const o = order(db, adm);
  const r = mark(db, o, { extra: [{ product_id: 3, qty: 1 }, { product_id: 3, qty: 2 }] });
  const extras = lines(db, adm).filter(isExtraConsumptionLine);
  assert.equal(extras.length, 1);
  assert.equal(extras[0].quantity, 3);
  assert.equal(r.stock.status, 'ok');
  db.close();
});

test('снятие возвращает и дозу, и сверхрасход', () => {
  const db = seed();
  const adm = admission(db);
  const o = order(db, adm);
  const m = mark(db, o, { extra: [{ product_id: 3, qty: 2 }] });

  const back = treatmentAdminUnmark(db,
    { administration_id: m.administration.id, reason: 'не тот пациент' }, ACTOR.senior_nurse);

  assert.equal(back.reversal.reversed, 2);
  assert.equal(onHand(db, 1), 20);
  assert.equal(onHand(db, 3), 100);
  assert.equal(lines(db, adm).length, 0);
  db.close();
});

test('сверхрасход «не в счёт пациенту» становится строкой учёта расходов', () => {
  const db = seed();
  const adm = admission(db);
  const o = order(db, adm);
  mark(db, o, { extra: [{ product_id: 3, qty: 1, billable: false }] });
  const extra = lines(db, adm).find(isExtraConsumptionLine);
  assert.equal(extra.billable, 0, 'разбитую ампулу клиника вправе не выставлять больному');
  assert.equal(onHand(db, 3), 99, 'но со склада она всё равно ушла');
  db.close();
});

test('сверхрасход, записанный текстом, не списывается — и об этом говорят', () => {
  const db = seed();
  const adm = admission(db);
  const o = order(db, adm);
  const r = mark(db, o, { extra: 'разбила ампулу' });
  assert.equal(r.warnings.some((w) => w.code === 'extra_unreadable'), true);
  assert.equal(lines(db, adm).length, 1, 'доза списана, текст — нет');
  db.close();
});

// ─── 6. Пустой склад ────────────────────────────────────────────────────────

test('пустой склад не отменяет отметку, но ведёт себя как в амбулатории', () => {
  const db = seed();
  const adm = admission(db);
  const o = order(db, adm, { name: 'Кеторол', stock_item_id: 4 });

  const r = mark(db, o);

  // Медицинский факт записан — это главное.
  assert.equal(r.administration.status, 'given');
  assert.equal(r.stock.status, 'short');
  assert.match(r.stock.note, /insufficient stock/);
  assert.equal(r.warnings[0].code, 'stock');

  // Остаток В МИНУС НЕ УХОДИТ и строки счёта нет — ровно то же самое склад
  // делает при амбулаторной выдаче, и это здесь же и проверяется, чтобы два
  // пути не разъехались.
  assert.equal(onHand(db, 4), 0);
  assert.equal(movements(db, 4).length, 0);
  assert.equal(lines(db, adm).length, 0);
  assert.throws(() => dispenseItem(db, { product_id: 4, quantity: 1 }, ACTOR.nurse),
    (e) => e instanceof StockError && /insufficient stock/.test(e.message));

  // И это тоже считается: несписанное видно человеку.
  const list = treatmentOrdersList(db, { admission_id: adm, from: START, to: START }, ACTOR.nurse);
  assert.equal(list.stock_issues.count, 1);
  db.close();
});

test('погашенная позиция склада не отменяет отметку', () => {
  const db = seed();
  db.prepare('UPDATE products SET active = 0 WHERE id = 1').run();
  const adm = admission(db);
  const o = order(db, adm);
  const r = mark(db, o);
  assert.equal(r.administration.status, 'given');
  assert.equal(r.stock.status, 'short');
  assert.equal(lines(db, adm).length, 0);
  db.close();
});

// ─── 7. Деньги доходят до счёта ─────────────────────────────────────────────

test('начисление садится на СВОЮ госпитализацию и доходит до счёта стационара', () => {
  const db = seed();
  const mine = admission(db);
  const other = admission(db, { patient_id: 2, ward_id: 2, bed_id: 2 });
  const o = order(db, mine);

  const r = mark(db, o, { extra: [{ product_id: 3, qty: 1 }] });
  assert.equal(lines(db, other).length, 0, 'соседняя койка не задета');

  const ls = lines(db, mine);
  assert.equal(ls.length, 2);
  assert.equal(ls[0].ward_id, 1);
  assert.equal(ls[0].bed_id, 1);

  const { invoice, items } = createInvoiceForAdmission(db,
    { admission_id: mine, admission_service_ids: ls.map((l) => l.id) }, ACTOR.registrar);

  assert.equal(invoice.admission_id, mine);
  assert.equal(invoice.subtotal, 13500);              // 12000 (флакон) + 1500 (шприц)
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((i) => i.description).sort(), ['Цефтриаксон 1 г', 'Шприц 5 мл']);
  for (const l of lines(db, mine)) {
    assert.ok(l.invoice_item_id, 'строка привязана к позиции счёта');
    assert.equal(l.status, 'completed');
  }
  assert.equal(r.charges.length, 2);
  assert.deepEqual(r.charges.map((c) => c.kind), ['dose', 'extra']);
  db.close();
});

// ─── 8. «По требованию» ─────────────────────────────────────────────────────

test('две дозы «по требованию» за день — два списания, а не один дубль', () => {
  const db = seed();
  const adm = admission(db);
  const o = order(db, adm, { freq_code: 'prn', days: null });

  const a = treatmentAdminMark(db, { order_id: o.id, date: START, status: 'given' }, ACTOR.nurse);
  const b = treatmentAdminMark(db, { order_id: o.id, date: START, status: 'given' }, ACTOR.nurse);

  assert.notEqual(a.administration.id, b.administration.id);
  assert.equal(onHand(db, 1), 18);
  assert.equal(lines(db, adm).length, 2);
  // Снятие одной не забирает деньги за вторую: метка несёт id ОТМЕТКИ.
  treatmentAdminUnmark(db, { administration_id: a.administration.id, reason: 'ошибка' }, ACTOR.senior_nurse);
  assert.equal(onHand(db, 1), 19);
  const left = lines(db, adm);
  assert.equal(left.length, 1);
  assert.equal(medAdminIdOf(left[0]), b.administration.id);
  db.close();
});
