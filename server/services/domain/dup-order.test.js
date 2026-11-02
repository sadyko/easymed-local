// DUP_STOP_V1 (2026-11-02) — что считается уже назначенным в визите, слова отказа,
// обход с причиной и журнал. Правило ключа — public/js/shared/dup-order.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import {
  liveOrders, duplicateHits, checkOrders, assertOrders, assertChangedOrder, logRepeatOrders,
  takeRepeatReason, repeatReasonArg, canRepeatOrder, DUP_CODE,
} from './dup-order.js';
import { bookedTwinFor } from '../crm/booked-twin.js';
import { autoTwinFor } from '../crm/one-way.js';

const REG = { id: 2, role: 'registrar', extra_roles: [] };
const ADMIN = { id: 1, role: 'admin', extra_roles: [] };
const CHIEF = { id: 12, role: 'doctor', extra_roles: ['head_doctor'] };
const DOC = { id: 10, role: 'doctor', extra_roles: [] };

function clinic() {
  const db = openDb(':memory:');
  migrate(db);
  const u = db.prepare('INSERT INTO users (id, username, password_hash, full_name, role, is_doctor, extra_roles) VALUES (?,?,?,?,?,?,?)');
  u.run(1, 'boss', 'x', 'Админ', 'admin', 0, '[]');
  u.run(2, 'reg', 'x', 'Регистратура', 'registrar', 0, '[]');
  u.run(10, 'doc', 'x', 'Иванов', 'doctor', 1, '[]');
  u.run(11, 'doc2', 'x', 'Петров', 'doctor', 1, '[]');
  u.run(12, 'chief', 'x', 'Главный', 'doctor', 1, '["head_doctor"]');
  const s = db.prepare('INSERT INTO services (id, name, price, type, requires_doctor) VALUES (?,?,?,?,?)');
  s.run(30, 'Консультация терапевта', 100000, 'consultation', 1);
  s.run(40, 'Анализ крови', 40000, 'lab', 0);
  s.run(50, 'УЗИ брюшной полости', 80000, 'imaging', 0);
  s.run(60, 'Капельница', 30000, 'procedure', 0);
  db.prepare("INSERT INTO services (id, name, price) VALUES (70, 'Без типа', 50000)").run();   // DUP_STOP_V1 (ревью m4) — тип по умолчанию, врач не нужен
  db.prepare("INSERT INTO consultation_types (id, name, name_ru, price, active) VALUES (5, 'Первичный', 'Первичный приём', 90000, 1)").run();
  db.prepare("INSERT INTO patients (id, full_name) VALUES (77, 'Пациент Тест')").run();
  const v1 = Number(db.prepare("INSERT INTO visits (patient_id, visit_date, status) VALUES (77, '2026-11-02T05:00:00Z', 'arrived')").run().lastInsertRowid);
  const v2 = Number(db.prepare("INSERT INTO visits (patient_id, visit_date, status) VALUES (77, '2026-11-03T05:00:00Z', 'scheduled')").run().lastInsertRowid);
  return { db, v1, v2 };
}
function line(db, r) {
  const row = { quantity: 1, unit_price: 0, total: 0, status: 'added', created_by: 10, ...r };
  const cols = Object.keys(row);
  return Number(db.prepare(`INSERT INTO visit_services (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...Object.values(row)).lastInsertRowid);
}
/** Строку — в счёт № A-000001 (без оплаты). */
function bill(db, vid, vsId) {
  const inv = Number(db.prepare("INSERT INTO invoices (invoice_number, visit_id, patient_id, subtotal, total_amount, status) VALUES ('A-000001', ?, 77, 40000, 40000, 'unpaid')").run(vid).lastInsertRowid);
  const item = Number(db.prepare("INSERT INTO invoice_items (invoice_id, service_id, description, quantity, unit_price, total) VALUES (?, 40, 'Анализ крови', 1, 40000, 40000)").run(inv).lastInsertRowid);
  db.prepare('UPDATE visit_services SET invoice_item_id = ? WHERE id = ?').run(item, vsId);
  return inv;
}

test('DUP_STOP_V1: та же услуга в том же визите — повтор; в другом визите — нет', () => {
  const { db, v1, v2 } = clinic();
  const x = line(db, { visit_id: v1, service_id: 40 });
  const hits = duplicateHits(db, [{ visit_id: v1, service_id: 40 }]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].existing.id, x);
  assert.equal(duplicateHits(db, [{ visit_id: v2, service_id: 40 }]).length, 0, 'другой визит того же пациента');
  assert.equal(duplicateHits(db, [{ visit_id: v1, service_id: 50 }]).length, 0, 'другая услуга');
});

test('DUP_STOP_V1: отменённая и отпущенная с возвратом строка — не назначение; выставленная заново — снова назначение', () => {
  const { db, v1 } = clinic();
  line(db, { visit_id: v1, service_id: 40, status: 'cancelled' });
  const back = line(db, { visit_id: v1, service_id: 50, status: 'collected' });
  db.prepare("INSERT INTO pay_refund_releases (kind, line_id, invoice_id) VALUES ('out', ?, 999)").run(back);
  assert.deepEqual(liveOrders(db, v1).map((r) => r.id), []);
  assert.equal(duplicateHits(db, [{ visit_id: v1, service_id: 40 }, { visit_id: v1, service_id: 50 }]).length, 0);
  // Выставили заново (ссылка на счёт есть) — снова живая строка.
  const inv = Number(db.prepare("INSERT INTO invoices (invoice_number, visit_id, patient_id, status) VALUES ('A-000009', ?, 77, 'unpaid')").run(v1).lastInsertRowid);
  const item = Number(db.prepare("INSERT INTO invoice_items (invoice_id, service_id, description, quantity, unit_price, total) VALUES (?, 50, 'УЗИ', 1, 0, 0)").run(inv).lastInsertRowid);
  db.prepare('UPDATE visit_services SET invoice_item_id = ? WHERE id = ?').run(item, back);
  assert.equal(duplicateHits(db, [{ visit_id: v1, service_id: 50 }]).length, 1);
});

test('DUP_STOP_V1: процедура и товар не запрещаются', () => {
  const { db, v1 } = clinic();
  line(db, { visit_id: v1, service_id: 60 });
  assert.equal(duplicateHits(db, [{ visit_id: v1, service_id: 60 }]).length, 0, 'процедура');
  assert.equal(duplicateHits(db, [{ visit_id: v1, service_id: 60 }, { visit_id: v1, service_id: 60 }]).length, 0, 'процедура дважды в запросе');
  assert.equal(duplicateHits(db, [{ visit_id: v1, clinic_item_id: 3 }, { visit_id: v1, clinic_item_id: 3 }]).length, 0, 'товар');
});

test('DUP_STOP_V1: консультация — тот же вид и тот же врач — повтор; у другого врача — можно', () => {
  const { db, v1 } = clinic();
  line(db, { visit_id: v1, service_id: null, consultation_type_id: 5, doctor_id: 10 });
  line(db, { visit_id: v1, service_id: 30, doctor_id: 10 });
  assert.equal(duplicateHits(db, [{ visit_id: v1, consultation_type_id: 5, doctor_id: 10 }]).length, 1, 'вид приёма у того же врача');
  assert.equal(duplicateHits(db, [{ visit_id: v1, consultation_type_id: 5, doctor_id: 11 }]).length, 0, 'вид приёма у другого врача');
  assert.equal(duplicateHits(db, [{ visit_id: v1, service_id: 30, doctor_id: 10 }]).length, 1, 'услуга-консультация у того же врача');
  assert.equal(duplicateHits(db, [{ visit_id: v1, service_id: 30, doctor_id: 11 }]).length, 0, 'услуга-консультация у другого врача');
});

test('DUP_STOP_V1 (ревью m4): услуга без типа и без «нужен врач» — та же услуга при любом враче; смена врача её ключ не меняет', () => {
  const { db, v1 } = clinic();
  const x = line(db, { visit_id: v1, service_id: 70, doctor_id: null });
  for (const doctor_id of [null, 10, 11]) {
    assert.equal(duplicateHits(db, [{ visit_id: v1, service_id: 70, doctor_id }]).length, 1, 'врач ' + doctor_id);
  }
  assert.equal(duplicateHits(db, [{ visit_id: v1, service_id: 70, doctor_id: 10 }, { visit_id: v1, service_id: 70, doctor_id: 11 }], { excludeIds: [x] })[0].twice, true, 'дважды в запросе у разных врачей');
  assert.equal(liveOrders(db, v1)[0].service_requires_doctor, 0);
  const rowOf = (id) => db.prepare('SELECT * FROM visit_services WHERE id = ?').get(id);
  assert.deepEqual(assertChangedOrder(db, rowOf(x), { ...rowOf(x), doctor_id: 11 }, { user: REG }), {}, 'другой исполнитель — тот же ключ');
});

test('DUP_STOP_V1: внутри одного запроса одна услуга дважды — повтор; разные визиты — нет', () => {
  const { db, v1, v2 } = clinic();
  const hits = duplicateHits(db, [{ visit_id: v1, service_id: 50 }, { visit_id: v1, service_id: 50 }]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].twice, true);
  assert.equal(hits[0].index, 1);
  assert.equal(duplicateHits(db, [{ visit_id: v1, service_id: 50 }, { visit_id: v2, service_id: 50 }]).length, 0);
});

test('DUP_STOP_V1: отказ 409 duplicate_order называет услугу, кем, когда и счёт; без счёта — «счёта ещё нет»', () => {
  const { db, v1 } = clinic();
  const x = line(db, { visit_id: v1, service_id: 40, created_by: 10 });
  let out = checkOrders(db, [{ visit_id: v1, service_id: 40 }], { user: REG });
  assert.equal(out.error.status, 409);
  assert.equal(out.error.code, DUP_CODE);
  assert.match(out.error.message, /^Эта услуга уже назначена в этом визите: «Анализ крови» — Иванов, \d\d\.\d\d\.\d{4} \d\d:\d\d, счёта ещё нет\.$/);
  assert.equal(out.error.params.service, 'Анализ крови');
  bill(db, v1, x);
  out = checkOrders(db, [{ visit_id: v1, service_id: 40 }], { user: REG });
  assert.match(out.error.message, /, счёт № A-000001\.$/);
  assert.equal(out.error.params.invoice, 'A-000001');
  assert.ok(out.error.template.includes('{invoice}'));
  const twice = checkOrders(db, [{ visit_id: v1, service_id: 50 }, { visit_id: v1, service_id: 50 }], { user: REG });
  assert.equal(twice.error.message, 'Услуга «УЗИ брюшной полости» выбрана дважды — в визит её назначают один раз.');
  assert.throws(() => assertOrders(db, [{ visit_id: v1, service_id: 40 }], { user: DOC }), (e) => e.status === 409 && e.code === DUP_CODE);
});

test('DUP_STOP_V1: обход — администратор и главный врач с причиной; регистратор и врач — нет; без причины — нет', () => {
  const { db, v1 } = clinic();
  line(db, { visit_id: v1, service_id: 40 });
  const ln = [{ visit_id: v1, service_id: 40 }];
  assert.equal(canRepeatOrder(ADMIN), true);
  assert.equal(canRepeatOrder(CHIEF), true);
  assert.equal(canRepeatOrder(REG), false);
  assert.equal(canRepeatOrder(DOC), false);
  assert.ok(checkOrders(db, ln, { user: ADMIN, reason: 'контрольный анализ' }).repeats);
  assert.ok(checkOrders(db, ln, { user: CHIEF, reason: 'повтор по показаниям' }).repeats);
  assert.ok(checkOrders(db, ln, { user: REG, reason: 'контрольный анализ' }).error, 'регистратор');
  assert.ok(checkOrders(db, ln, { user: ADMIN, reason: '  ок ' }).error, 'причина короче трёх знаков');
  assert.ok(checkOrders(db, ln, { user: ADMIN }).error, 'без причины');
});

test('DUP_STOP_V1: обход пишется в журнал счёта (line_repeat_order) с причиной, визитом и прежней строкой', () => {
  const { db, v1 } = clinic();
  const x = line(db, { visit_id: v1, service_id: 40, created_by: 10 });
  const inv = bill(db, v1, x);
  const out = checkOrders(db, [{ visit_id: v1, service_id: 40 }], { user: ADMIN, reason: '  контрольный анализ  ' });
  assert.equal(logRepeatOrders(db, out, ADMIN), 1);
  const rows = db.prepare("SELECT * FROM invoice_audit_log WHERE action = 'line_repeat_order'").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].visit_id, v1);
  assert.equal(rows[0].invoice_id, inv);
  assert.equal(rows[0].invoice_number, 'A-000001');
  assert.equal(rows[0].reason, 'контрольный анализ');
  assert.equal(rows[0].actor_user_id, 1);
  assert.match(rows[0].notes, /Повторное назначение «Анализ крови» \(уже было: Иванов, .+, счёт № A-000001\)/);
  assert.equal(logRepeatOrders(db, {}, ADMIN), 0, 'нет обхода — нет строки журнала');
});

test('DUP_STOP_V1: spare и excludeIds — строка, которую дверь уберёт, или сама изменяемая строка не мешают', () => {
  const { db, v1 } = clinic();
  const x = line(db, { visit_id: v1, service_id: 40 });
  assert.equal(duplicateHits(db, [{ visit_id: v1, service_id: 40 }], { spare: () => [x] }).length, 0);
  assert.equal(duplicateHits(db, [{ visit_id: v1, service_id: 40 }], { excludeIds: [x] }).length, 0);
});

/** Счётчик запросов к базе: get/all/run/iterate подготовленных выражений. */
function counting(db) {
  let n = 0;
  const proxy = new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare') {
        return (sql) => {
          const st = target.prepare(sql);
          return new Proxy(st, {
            get(s, p) {
              const v = s[p];
              if (['get', 'all', 'run', 'iterate'].includes(p)) return (...a) => { n++; return v.apply(s, a); };
              return typeof v === 'function' ? v.bind(s) : v;
            },
          });
        };
      }
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  return { proxy, count: () => n, reset: () => { n = 0; } };
}

test('DUP_STOP_V1 (ревью m8): поблажки дверей (R7b, строка CRM) считаются, только когда в визите есть строка того же ключа', () => {
  const { db, v1 } = clinic();
  for (let i = 100; i < 160; i++) db.prepare("INSERT INTO services (id, name, price, type) VALUES (?, ?, 1000, 'lab')").run(i, 'S' + i);
  for (let i = 100; i < 120; i++) line(db, { visit_id: v1, service_id: i });
  const c = counting(db);
  let spared = 0;
  const spare = (ln) => { spared++; return [autoTwinFor(c.proxy, ln), bookedTwinFor(c.proxy, ln)].filter(Boolean).map((x) => x.id); };
  c.reset();
  assert.equal(duplicateHits(c.proxy, [{ visit_id: v1, service_id: 130 }], { spare }).length, 0);
  assert.equal(spared, 0, 'поблажки считались для новой услуги');
  assert.ok(c.count() <= 2, 'одиночная вставка без повтора — запросов: ' + c.count());
  c.reset();
  assert.equal(duplicateHits(c.proxy, Array.from({ length: 30 }, (_, k) => ({ visit_id: v1, service_id: 125 + k })), { spare }).length, 0);
  assert.equal(spared, 0);
  assert.ok(c.count() <= 31, 'пачка из 30 строк без повтора — запросов: ' + c.count());
  // повтор есть — поблажки спрашиваются (и строка, которую дверь уберёт, не мешает)
  c.reset();
  assert.equal(duplicateHits(c.proxy, [{ visit_id: v1, service_id: 105 }], { spare }).length, 1);
  assert.equal(spared, 1);
  const x = db.prepare('SELECT id FROM visit_services WHERE visit_id = ? AND service_id = 105').get(v1).id;
  assert.equal(duplicateHits(db, [{ visit_id: v1, service_id: 105 }], { spare: () => [x] }).length, 0);
});

test('DUP_STOP_V1: замена — проверка только если ключ меняется; задвоенные до 3.21.0 строки правке врача не мешают', () => {
  const { db, v1 } = clinic();
  const a = line(db, { visit_id: v1, service_id: 40 });
  line(db, { visit_id: v1, service_id: 40 });   // задвоено до 3.21.0
  const u = line(db, { visit_id: v1, service_id: 50 });
  const rowOf = (id) => db.prepare('SELECT * FROM visit_services WHERE id = ?').get(id);
  assert.deepEqual(assertChangedOrder(db, rowOf(a), { ...rowOf(a), doctor_id: 11 }, { user: REG }), {}, 'анализ: другой исполнитель — тот же ключ');
  assert.throws(() => assertChangedOrder(db, rowOf(u), { ...rowOf(u), service_id: 40 }, { user: REG }), (e) => e.code === DUP_CODE, 'УЗИ → анализ, который уже есть');
  const c = line(db, { visit_id: v1, service_id: null, consultation_type_id: 5, doctor_id: 10 });
  const c2 = line(db, { visit_id: v1, service_id: null, consultation_type_id: 5, doctor_id: 11 });
  assert.throws(() => assertChangedOrder(db, rowOf(c2), { ...rowOf(c2), doctor_id: 10 }, { user: REG }), (e) => e.code === DUP_CODE, 'консультация к врачу, у которого этот вид уже есть');
  assert.deepEqual(assertChangedOrder(db, rowOf(c), { ...rowOf(c), doctor_id: 12 }, { user: REG }), {});
});

test('DUP_STOP_V1: __repeat_reason снимается со строк visit_services до compile(); у других таблиц не трогается', () => {
  const one = { table: 'visit_services', op: 'insert', values: { visit_id: 1, service_id: 40, __repeat_reason: 'контроль' } };
  assert.equal(takeRepeatReason(one), 'контроль');
  assert.equal('__repeat_reason' in one.values, false);
  const many = { table: 'visit_services', op: 'insert', values: [{ visit_id: 1, __repeat_reason: '' }, { visit_id: 1, __repeat_reason: 'повтор' }] };
  assert.equal(takeRepeatReason(many), 'повтор');
  assert.ok(many.values.every((r) => !('__repeat_reason' in r)));
  const other = { table: 'patients', op: 'insert', values: { full_name: 'X', __repeat_reason: 'x' } };
  assert.equal(takeRepeatReason(other), null);
  assert.equal(other.values.__repeat_reason, 'x', 'чужая таблица: поле остаётся, compile() откажет ему как неизвестной колонке');
  assert.equal(repeatReasonArg({ __repeat_reason: '  контроль ' }), '  контроль ');
  assert.equal(repeatReasonArg({ __repeat_reason: '   ' }), null);
  assert.equal(repeatReasonArg(null), null);
});
