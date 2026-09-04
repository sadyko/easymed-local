// TREATMENT_ORDERS_V1 — лист назначений: сервер.
//
// Проверяется ровно то, что в клинике стоит денег и здоровья:
//   • назначить нельзя, пока пациент не дошёл до лечения, и отказ говорит,
//     КОГО ждут (охранник маршрута, а не своя проверка);
//   • отметка идемпотентна — двойное нажатие на общем планшете безобидно;
//   • отказ от дозы без причины не записывается;
//   • снять отметку может только старшая медсестра, и снятая отметка остаётся
//     следом, а не исчезает (главное отличие от референса);
//   • «по требованию» отмечается без часа и не сталкивается сама с собой.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { dueAtMs } from '../domain/mar-schedule.js';
import {
  treatmentOrderCreate, treatmentOrderCancel, treatmentOrdersList,
  treatmentAdminMark, treatmentAdminUnmark, treatmentTasksDue, RpcError,
  unmarkVerdict, UNMARK_WINDOW_MIN,
} from './treatment-orders.js';

// UNMARK_WINDOW_V1 — состарить отметку, не поспав пятнадцати минут: given_at
// переписывается ТЕМИ ЖЕ часами, по которым правило её и читает (nowUtc →
// strftime('now')), поэтому «три минуты назад» здесь значит ровно то же, что
// значило бы три минуты ожидания.
const ageMark = (db, id, minutes) => db.prepare(
  "UPDATE treatment_administrations SET given_at = strftime('%Y-%m-%dT%H:%M:%SZ','now',?) WHERE id = ?")
  .run(`-${minutes} minutes`, id);

// Носитель роли: надстроечные роли живут ТОЛЬКО в extra_roles — врач остаётся
// врачом, медсестра медсестрой (см. roles.js EXTRA_ONLY_ROLES).
const ACTOR = {
  admin:        { id: 9, role: 'admin' },
  doctor:       { id: 1, role: 'doctor' },              // лечащий врач пациента
  other_doctor: { id: 3, role: 'doctor' },              // чужой врач
  head_doctor:  { id: 4, role: 'doctor', extra_roles: ['head_doctor'] },
  nurse:        { id: 2, role: 'nurse' },
  other_nurse:  { id: 8, role: 'nurse' },              // та же роль, ДРУГОЙ человек
  senior_nurse: { id: 5, role: 'nurse', extra_roles: ['senior_nurse'] },
  registrar:    { id: 6, role: 'registrar' },
  cashier:      { id: 7, role: 'cashier' },
};

const START = '2026-09-04';
// Момент времени по МЕСТНЫМ часам отделения — тем же способом, каким его
// считает расписание, чтобы тест не зависел от пояса машины.
const localTs = (date, hour, min = 0) => new Date(dueAtMs(date, hour) + min * 60000).toISOString();

function seed() {
  const db = openDb(':memory:');
  migrate(db);
  const u = db.prepare('INSERT INTO users (id, username, password_hash, full_name, role) VALUES (?,?,?,?,?)');
  u.run(1, 'doc', 'x', 'Лечащий', 'doctor');
  u.run(2, 'nur', 'x', 'Медсестра', 'nurse');
  u.run(3, 'doc2', 'x', 'Чужой', 'doctor');
  u.run(4, 'head', 'x', 'Главный', 'doctor');
  u.run(5, 'snur', 'x', 'Старшая', 'nurse');
  u.run(6, 'reg', 'x', 'Регистратура', 'registrar');
  u.run(7, 'cash', 'x', 'Касса', 'cashier');
  u.run(8, 'nur2', 'x', 'Вторая медсестра', 'nurse');
  u.run(9, 'boss', 'x', 'Админ', 'admin');
  db.prepare("INSERT INTO patients (id, full_name) VALUES (1,'Иванов Иван')").run();
  db.prepare("INSERT INTO patients (id, full_name) VALUES (2,'Петров Пётр')").run();
  db.prepare("INSERT INTO wards (id, name, billing_mode, price_per_day) VALUES (1,'Терапия','daily',150000)").run();
  db.prepare("INSERT INTO wards (id, name, billing_mode, price_per_day) VALUES (2,'Хирургия','daily',250000)").run();
  db.prepare("INSERT INTO beds (id, code, ward_id, status) VALUES (1,'K-1',1,'occupied')").run();
  db.prepare("INSERT INTO beds (id, code, ward_id, status) VALUES (2,'K-2',2,'occupied')").run();
  db.prepare("INSERT INTO services (id, name, price) VALUES (1,'Инъекция в/м',20000)").run();
  db.prepare("INSERT INTO products (id, name, unit, category) VALUES (1,'Цефтриаксон 1 г','pcs','drug')").run();
  return db;
}

/** Госпитализация в нужном состоянии (фикстура — мимо машины маршрута). */
function admission(db, status = 'active', extra = {}) {
  const cols = { patient_id: 1, ward_id: 1, bed_id: 1, doctor_id: 1, attending_doctor_id: 1, status, ...extra };
  const keys = Object.keys(cols);
  return db.prepare(`INSERT INTO admissions (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
    .run(...keys.map((k) => cols[k])).lastInsertRowid;
}

function order(db, admissionId, over = {}, who = ACTOR.doctor) {
  return treatmentOrderCreate(db, {
    admission_id: admissionId, kind: 'med', name: 'Цефтриаксон', dose: '1 г', route: 'в/м',
    freq_code: '3x', starts_on: START, days: 5, service_id: 1, stock_item_id: 1, ...over,
  }, who).order;
}

// ─── 1. Назначение: маршрут и роли ──────────────────────────────────────────

test('назначение до «active» отвергается охранником, и отказ называет недостающий шаг', () => {
  const db = seed();
  // Охранник называет ДВА разных недостающих шага: пока пациента не осмотрел
  // главный врач — ждут его; после осмотра — ждут назначения лечащего врача.
  const cases = [
    ['ordered',  /не осмотрен главным врачом/],
    ['admitted', /не осмотрен главным врачом/],
    ['examined', /Лечащий врач ещё не назначен/],
  ];
  for (const [status, re] of cases) {
    const id = admission(db, status, { attending_doctor_id: null });
    assert.throws(() => order(db, id, {}, ACTOR.admin),
      (e) => e instanceof RpcError && e.status === 400 && re.test(e.message), status);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM treatment_orders').get().n, 0);
  }
  // Выписанному тоже нельзя — счёт закрыт, история закрыта.
  const done = admission(db, 'discharged');
  assert.throws(() => order(db, done, {}, ACTOR.admin), /выписан/);
  db.close();
});

test('назначает лечащий врач своего пациента, главный врач и админ — больше никто', () => {
  const db = seed();
  for (const who of ['doctor', 'head_doctor', 'admin']) {
    const id = admission(db);
    assert.ok(order(db, id, {}, ACTOR[who]).id, who);
  }
  for (const who of ['other_doctor', 'nurse', 'senior_nurse', 'registrar', 'cashier']) {
    const id = admission(db);
    assert.throws(() => order(db, id, {}, ACTOR[who]),
      (e) => e instanceof RpcError && e.status === 403, who);
  }
  db.close();
});

test('назначение сохраняет СНИМОК часов, конец курса и подпись', () => {
  const db = seed();
  const id = admission(db);
  const o = order(db, id);
  assert.equal(o.slots, '[6,14,22]');
  assert.equal(o.ends_on, '2026-09-08', 'пять дней с 4-го — по 8-е включительно');
  assert.equal(o.prn, 0);
  assert.equal(o.status, 'active');
  assert.equal(o.prescribed_by, 1);
  assert.equal(o.source, 'clinic');
  db.close();
});

test('«по требованию» заводится без часов и без срока', () => {
  const db = seed();
  const id = admission(db);
  const o = order(db, id, { freq_code: 'prn', days: 5 });
  assert.equal(o.prn, 1);
  assert.equal(o.slots, '[]');
  assert.equal(o.days, null, 'у PRN курса нет — срок не выдумывается');
  assert.equal(o.ends_on, null);
  db.close();
});

test('форма назначения проверяется на сервере, а не только в браузере', () => {
  const db = seed();
  const id = admission(db);
  const bad = [
    [{ name: '' }, /без названия/],
    [{ freq_code: '5x' }, /Неизвестная частота/],
    [{ kind: 'витамины' }, /Неизвестный род/],
    [{ route: 'в вену' }, /Неизвестный путь/],
    [{ route: null }, /Укажите путь введения/],
    [{ source: 'аптека' }, /Неизвестный источник/],
    [{ starts_on: '4 сентября' }, /ГГГГ-ММ-ДД/],
    [{ service_id: 999 }, /Услуга не найдена/],
    [{ stock_item_id: 999 }, /Позиция склада не найдена/],
  ];
  for (const [over, re] of bad) {
    assert.throws(() => order(db, id, over), (e) => e instanceof RpcError && re.test(e.message), JSON.stringify(over));
  }
  // А уходу путь введения не нужен.
  assert.ok(order(db, id, { kind: 'care', name: 'Перевязка', route: null }).id);
  db.close();
});

// ─── 2. Отмена ──────────────────────────────────────────────────────────────

test('отмена требует причины, не удаляет ни назначения, ни отметок и терпит повтор', () => {
  const db = seed();
  const id = admission(db);
  const o = order(db, id);
  treatmentAdminMark(db, { order_id: o.id, date: START, slot: 6, status: 'given' }, ACTOR.nurse);

  assert.throws(() => treatmentOrderCancel(db, { order_id: o.id }, ACTOR.doctor), /без причины/);
  assert.equal(db.prepare('SELECT status FROM treatment_orders WHERE id=?').get(o.id).status, 'active');

  const res = treatmentOrderCancel(db, { order_id: o.id, reason: 'аллергия' }, ACTOR.doctor);
  assert.equal(res.order.status, 'cancelled');
  assert.equal(res.order.cancel_reason, 'аллергия');
  assert.equal(res.order.cancel_by, 1);
  assert.ok(res.order.cancel_at);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM treatment_administrations').get().n, 1,
    'отметки отменённого назначения сохраняются');

  const again = treatmentOrderCancel(db, { order_id: o.id, reason: 'аллергия' }, ACTOR.doctor);
  assert.equal(again.already, true, 'двойной клик — не ошибка');
  db.close();
});

test('отменённый курс перестаёт рождать плановые точки, но уже сделанные отметки при нём', () => {
  const db = seed();
  const id = admission(db);
  const o = order(db, id);
  treatmentAdminMark(db, { order_id: o.id, date: START, slot: 6, status: 'given' }, ACTOR.nurse);
  // Отмена «сейчас»: всё, что позже этой минуты, больше не планируется.
  treatmentOrderCancel(db, { order_id: o.id, reason: 'смена схемы' }, ACTOR.doctor);

  const lst = treatmentOrdersList(db, {
    admission_id: id, from: START, to: '2026-09-08', include_cancelled: true,
  }, ACTOR.doctor);
  const shown = lst.orders.find((x) => x.id === o.id);
  assert.equal(shown.marks.length, 1, 'отметка на месте');
  assert.ok(shown.due.length < 15, 'будущие точки после отмены не планируются');
  db.close();
});

test('отменяет назначение врач, а не медсестра', () => {
  const db = seed();
  const id = admission(db);
  const o = order(db, id);
  assert.throws(() => treatmentOrderCancel(db, { order_id: o.id, reason: 'нет' }, ACTOR.nurse),
    (e) => e.status === 403);
  db.close();
});

// ─── 3. Лист назначений ─────────────────────────────────────────────────────

test('лист отдаёт назначения, развёрнутые часы и отметки за период', () => {
  const db = seed();
  const id = admission(db);
  const o = order(db, id);
  treatmentAdminMark(db, { order_id: o.id, date: START, slot: 6, status: 'given' }, ACTOR.nurse);

  const lst = treatmentOrdersList(db, { admission_id: id, from: START, to: START }, ACTOR.doctor);
  assert.equal(lst.orders.length, 1);
  assert.deepEqual(lst.orders[0].slot_hours, [6, 14, 22]);
  assert.deepEqual(lst.orders[0].due.map((d) => d.slot), [6, 14, 22]);
  assert.equal(lst.orders[0].marks.length, 1);
  db.close();
});

test('отменённые назначения показываются только по требованию', () => {
  const db = seed();
  const id = admission(db);
  const o = order(db, id);
  treatmentOrderCancel(db, { order_id: o.id, reason: 'аллергия' }, ACTOR.doctor);

  assert.equal(treatmentOrdersList(db, { admission_id: id, from: START, to: START }, ACTOR.doctor).orders.length, 0);
  assert.equal(treatmentOrdersList(db, {
    admission_id: id, from: START, to: START, include_cancelled: true,
  }, ACTOR.doctor).orders.length, 1);
  db.close();
});

test('лист выписанного пациента читается — история болезни живёт дольше койки', () => {
  const db = seed();
  const id = admission(db);
  order(db, id);
  db.prepare("UPDATE admissions SET status='discharged' WHERE id=?").run(id);
  const lst = treatmentOrdersList(db, { admission_id: id, from: START, to: '2026-09-08' }, ACTOR.doctor);
  assert.equal(lst.orders.length, 1);
  db.close();
});

test('лист назначений закрыт от кассы и склада', () => {
  const db = seed();
  const id = admission(db);
  order(db, id);
  for (const who of ['cashier', 'registrar']) {
    assert.throws(() => treatmentOrdersList(db, { admission_id: id }, ACTOR[who]),
      (e) => e.status === 403, who);
  }
  for (const who of ['doctor', 'head_doctor', 'nurse', 'senior_nurse', 'admin']) {
    assert.ok(treatmentOrdersList(db, { admission_id: id }, ACTOR[who]), who);
  }
  db.close();
});

// ─── 4. Отметка медсестры ───────────────────────────────────────────────────

test('отмечает медсестра, старшая и админ — врач нет', () => {
  const db = seed();
  const id = admission(db);
  const o = order(db, id);
  const slots = { nurse: 6, senior_nurse: 14, admin: 22 };
  for (const [who, slot] of Object.entries(slots)) {
    const res = treatmentAdminMark(db, { order_id: o.id, date: START, slot, status: 'given' }, ACTOR[who]);
    assert.equal(res.administration.status, 'given', who);
    assert.equal(res.administration.given_by, ACTOR[who].id);
  }
  assert.throws(() => treatmentAdminMark(db, { order_id: o.id, date: '2026-09-05', slot: 6 }, ACTOR.doctor),
    (e) => e.status === 403);
  db.close();
});

test('повторная отметка тем же статусом ничего не дублирует', () => {
  const db = seed();
  const id = admission(db);
  const o = order(db, id);
  const first = treatmentAdminMark(db, { order_id: o.id, date: START, slot: 6, status: 'given' }, ACTOR.nurse);
  const second = treatmentAdminMark(db, { order_id: o.id, date: START, slot: 6, status: 'given' }, ACTOR.nurse);
  assert.equal(second.already, true);
  assert.equal(second.administration.id, first.administration.id);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM treatment_administrations').get().n, 1);
  db.close();
});

test('переписать чужую отметку другим статусом нельзя — это работа старшей медсестры', () => {
  const db = seed();
  const id = admission(db);
  const o = order(db, id);
  treatmentAdminMark(db, { order_id: o.id, date: START, slot: 6, status: 'given' }, ACTOR.nurse);
  assert.throws(() => treatmentAdminMark(db, {
    order_id: o.id, date: START, slot: 6, status: 'refused', reason: 'отказался',
  }, ACTOR.nurse), /Снять её может старшая медсестра/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM treatment_administrations').get().n, 1);
  db.close();
});

test('отказ, пропуск и задержка — только с причиной', () => {
  const db = seed();
  const id = admission(db);
  const o = order(db, id);
  for (const status of ['refused', 'missed', 'held']) {
    assert.throws(() => treatmentAdminMark(db, { order_id: o.id, date: START, slot: 6, status }, ACTOR.nurse),
      /только с причиной/, status);
    assert.throws(() => treatmentAdminMark(db, { order_id: o.id, date: START, slot: 6, status, reason: '  ' }, ACTOR.nurse),
      /только с причиной/, status + ' (пробелы)');
  }
  const res = treatmentAdminMark(db, {
    order_id: o.id, date: START, slot: 6, status: 'refused', reason: 'пациент отказался',
  }, ACTOR.nurse);
  assert.equal(res.administration.reason, 'пациент отказался');
  db.close();
});

test('отметить можно только НАСТОЯЩУЮ дозу этого курса', () => {
  const db = seed();
  const id = admission(db);
  const o = order(db, id);
  const bad = [
    [{ slot: 7 }, /нет в расписании/],                       // часа нет в частоте
    [{ date: '2026-09-03', slot: 6 }, /нет в расписании/],   // день до начала курса
    [{ date: '2026-09-09', slot: 6 }, /нет в расписании/],   // день после конца
    [{ slot: 99 }, /час дозы/],
    [{ slot: null }, /час дозы/],
  ];
  for (const [over, re] of bad) {
    assert.throws(() => treatmentAdminMark(db, {
      order_id: o.id, date: START, status: 'given', ...over,
    }, ACTOR.nurse), (e) => e instanceof RpcError && re.test(e.message), JSON.stringify(over));
  }
  db.close();
});

test('PRN отмечается БЕЗ часа, дважды за день и без столкновений', () => {
  const db = seed();
  const id = admission(db);
  const o = order(db, id, { freq_code: 'prn', name: 'Кеторол', days: null });

  const a1 = treatmentAdminMark(db, { order_id: o.id, date: START, status: 'given' }, ACTOR.nurse);
  const a2 = treatmentAdminMark(db, { order_id: o.id, date: START, status: 'given' }, ACTOR.nurse);
  assert.equal(a1.administration.due_slot, null);
  assert.notEqual(a1.administration.id, a2.administration.id, 'по требованию — два введения, а не дубль');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM treatment_administrations').get().n, 2);

  assert.throws(() => treatmentAdminMark(db, { order_id: o.id, date: START, slot: 6, status: 'given' }, ACTOR.nurse),
    /не имеет часов/, 'слот у PRN — ошибка, а не молчаливое сохранение');
  db.close();
});

test('отметка по выписанному пациенту не принимается', () => {
  const db = seed();
  const id = admission(db);
  const o = order(db, id);
  db.prepare("UPDATE admissions SET status='discharged' WHERE id=?").run(id);
  assert.throws(() => treatmentAdminMark(db, { order_id: o.id, date: START, slot: 6, status: 'given' }, ACTOR.nurse),
    /выписан/);
  db.close();
});

// ─── 5. Снятие отметки ──────────────────────────────────────────────────────

test('снятие отметки — сестринское дело: врачу и регистратуре его не дают', () => {
  const db = seed();
  const id = admission(db);
  const o = order(db, id);
  const m = treatmentAdminMark(db, { order_id: o.id, date: START, slot: 6, status: 'given' }, ACTOR.nurse).administration;

  // Доза либо введена, либо нет, и это сестринская запись: врача в снятии нет
  // намеренно — ни лечащего, ни главного.
  for (const who of ['doctor', 'head_doctor', 'registrar', 'cashier']) {
    assert.throws(() => treatmentAdminUnmark(db, { administration_id: m.id, reason: 'ошибка' }, ACTOR[who]),
      (e) => e.status === 403 && /недоступно вашей роли/.test(e.message), who);
  }
  db.close();
});

test('старшая медсестра (и админ) снимает любую отметку и в любой час — со следом', () => {
  const db = seed();
  const id = admission(db);
  const o = order(db, id);
  const m = treatmentAdminMark(db, { order_id: o.id, date: START, slot: 6, status: 'given' }, ACTOR.nurse).administration;

  // Чужая и давно остывшая — старшей это не мешает: её право безусловно.
  ageMark(db, m.id, 600);
  assert.throws(() => treatmentAdminUnmark(db, { administration_id: m.id }, ACTOR.senior_nurse), /без причины/);

  const res = treatmentAdminUnmark(db, { administration_id: m.id, reason: 'не тот пациент' }, ACTOR.senior_nurse);
  assert.equal(res.administration.voided_by, 5);
  assert.equal(res.administration.void_reason, 'не тот пациент');
  assert.ok(res.administration.voided_at);

  // След, а не исчезновение: строка на месте, и её видно отдельным списком.
  assert.equal(db.prepare('SELECT COUNT(*) n FROM treatment_administrations').get().n, 1);
  const lst = treatmentOrdersList(db, { admission_id: id, from: START, to: START }, ACTOR.doctor);
  assert.equal(lst.orders[0].marks.length, 0, 'снятая отметка не считается выполнением');
  assert.equal(lst.orders[0].voided_marks.length, 1, 'но она видна как след');

  // И слот снова можно закрыть верной отметкой.
  const fixed = treatmentAdminMark(db, {
    order_id: o.id, date: START, slot: 6, status: 'refused', reason: 'пациент отказался',
  }, ACTOR.nurse);
  assert.notEqual(fixed.administration.id, m.id);
  assert.equal(treatmentAdminUnmark(db, { administration_id: m.id, reason: 'ещё раз' }, ACTOR.admin).already, true);
  db.close();
});

// ─── 5б. Окно самоисправления (UNMARK_WINDOW_V1) ────────────────────────────
//
// Решение владельца: медсестра снимает СВОЮ отметку в течение пятнадцати минут,
// дальше — старшая. Проверяются все четыре угла правила (свой/чужой × внутри
// окна/за окном) и то, что след и причина остаются даже у самого быстрого
// исправления: смысл окна — скорость, а не тишина.

test('автор снимает свою отметку в первые 15 минут — со следом и причиной', () => {
  const db = seed();
  const id = admission(db);
  const o = order(db, id);
  const m = treatmentAdminMark(db, { order_id: o.id, date: START, slot: 6, status: 'given' }, ACTOR.nurse).administration;
  ageMark(db, m.id, 3);

  // Причина обязательна и здесь: скорость — не повод писать «снято» без ответа
  // на вопрос «почему».
  assert.throws(() => treatmentAdminUnmark(db, { administration_id: m.id }, ACTOR.nurse), /без причины/);

  const res = treatmentAdminUnmark(db, { administration_id: m.id, reason: 'нажала не ту строку' }, ACTOR.nurse);
  assert.equal(res.already, false);
  assert.equal(res.administration.voided_by, 2, 'сняла она сама');
  assert.equal(res.administration.void_reason, 'нажала не ту строку');
  assert.ok(res.administration.voided_at, 'след пишется и у быстрого исправления');

  // Строка не удалена, и слот снова свободен под верную отметку.
  assert.equal(db.prepare('SELECT COUNT(*) n FROM treatment_administrations').get().n, 1);
  const lst = treatmentOrdersList(db, { admission_id: id, from: START, to: START }, ACTOR.doctor);
  assert.equal(lst.orders[0].marks.length, 0);
  assert.equal(lst.orders[0].voided_marks.length, 1);
  db.close();
});

test('через 20 минут своя отметка уже не снимается, и отказ называет старшую', () => {
  const db = seed();
  const id = admission(db);
  const o = order(db, id);
  const m = treatmentAdminMark(db, { order_id: o.id, date: START, slot: 6, status: 'given' }, ACTOR.nurse).administration;
  ageMark(db, m.id, 20);

  assert.throws(() => treatmentAdminUnmark(db, { administration_id: m.id, reason: 'ошиблась' }, ACTOR.nurse),
    (e) => e instanceof RpcError && e.status === 403
        && /старшая медсестра/.test(e.message)       // КТО может
        && /позовите/i.test(e.message));             // и что делать дальше
  // Отметка цела: отказ не оставляет полуснятого состояния.
  assert.equal(db.prepare('SELECT voided_at FROM treatment_administrations WHERE id = ?').get(m.id).voided_at, null);

  // А старшей те же двадцать минут не мешают.
  assert.ok(treatmentAdminUnmark(db, { administration_id: m.id, reason: 'разобрались' }, ACTOR.senior_nurse)
    .administration.voided_at);
  db.close();
});

test('чужую отметку медсестра не снимает даже через три минуты', () => {
  const db = seed();
  const id = admission(db);
  const o = order(db, id);
  const m = treatmentAdminMark(db, { order_id: o.id, date: START, slot: 6, status: 'given' }, ACTOR.nurse).administration;
  ageMark(db, m.id, 3);

  assert.throws(() => treatmentAdminUnmark(db, { administration_id: m.id, reason: 'по-моему, не дали' }, ACTOR.other_nurse),
    (e) => e instanceof RpcError && e.status === 403
        && /только свою отметку/.test(e.message)
        && /старшая медсестра/.test(e.message));
  assert.equal(db.prepare('SELECT voided_at FROM treatment_administrations WHERE id = ?').get(m.id).voided_at, null);
  db.close();
});

test('граница окна: правило читает часы ПАРАМЕТРОМ, а не ждёт пятнадцати минут', () => {
  assert.equal(UNMARK_WINDOW_MIN, 15);
  const at = Date.parse('2026-09-04T10:00:00Z');
  const own = { given_by: 2, given_at: '2026-09-04T10:00:00Z' };
  const min = (n) => at + n * 60000;

  assert.equal(unmarkVerdict(own, ACTOR.nurse, min(0)).allowed, true);
  assert.equal(unmarkVerdict(own, ACTOR.nurse, min(14.9)).allowed, true);
  assert.equal(unmarkVerdict(own, ACTOR.nurse, min(15)).allowed, false, 'ровно пятнадцать — уже поздно');
  assert.equal(unmarkVerdict(own, ACTOR.nurse, min(3)).scope, 'own');
  assert.equal(unmarkVerdict(own, ACTOR.nurse, min(3)).left_min, 12);

  // Окно — параметр той же функции: подставь другое, и граница поедет с ним.
  assert.equal(unmarkVerdict(own, ACTOR.nurse, min(30), 60).allowed, true);
  assert.equal(unmarkVerdict(own, ACTOR.nurse, min(30), 5).allowed, false);

  // Старшая — вне часов; чужой человек — вне окна вовсе.
  assert.equal(unmarkVerdict(own, ACTOR.senior_nurse, min(99999)).allowed, true);
  assert.equal(unmarkVerdict(own, ACTOR.senior_nurse, min(99999)).scope, 'any');
  assert.equal(unmarkVerdict(own, ACTOR.other_nurse, min(1)).scope, 'other');
  assert.equal(unmarkVerdict(own, ACTOR.doctor, min(1)).scope, 'none');
  // Отметка без автора (строка, пришедшая до этой правки) ничьей своей не становится.
  assert.equal(unmarkVerdict({ given_by: null, given_at: '2026-09-04T10:00:00Z' }, ACTOR.nurse, min(1)).scope, 'other');
});

test('«Сделано» несёт право снятия — и считает его сервер, а не экран', () => {
  const db = seed();
  const id = admission(db);
  const o = order(db, id);
  const fresh = treatmentAdminMark(db, { order_id: o.id, date: START, slot: 6, status: 'given' }, ACTOR.nurse).administration;
  const stale = treatmentAdminMark(db, { order_id: o.id, date: START, slot: 14, status: 'given' }, ACTOR.nurse).administration;
  ageMark(db, fresh.id, 3);
  ageMark(db, stale.id, 40);

  const mine = treatmentTasksDue(db, { date: START, now: localTs(START, 14, 30) }, ACTOR.nurse);
  assert.equal(mine.counts.done, 2);
  const byId = new Map(mine.groups.done.map((d) => [d.administration_id, d]));
  assert.equal(byId.get(fresh.id).undo.allowed, true);
  assert.equal(byId.get(fresh.id).undo.scope, 'own');
  assert.equal(byId.get(stale.id).undo.allowed, false);
  assert.match(byId.get(stale.id).undo.message, /старшая медсестра/);
  // Пациент и препарат едут вместе с правом: «Сделано» — рабочий список, а не журнал.
  assert.equal(byId.get(fresh.id).patient_name, 'Иванов Иван');
  assert.equal(byId.get(fresh.id).name, 'Цефтриаксон');
  assert.equal(byId.get(fresh.id).given_by_name, 'Медсестра');

  // Та же строка глазами другой медсестры и старшей.
  const other = treatmentTasksDue(db, { date: START, now: localTs(START, 14, 30) }, ACTOR.other_nurse);
  assert.equal(other.groups.done.find((d) => d.administration_id === fresh.id).undo.allowed, false);
  const senior = treatmentTasksDue(db, { date: START, now: localTs(START, 14, 30) }, ACTOR.senior_nurse);
  for (const d of senior.groups.done) assert.equal(d.undo.allowed, true);

  // Час запроса окно не двигает: `now` — это часы РАСПИСАНИЯ, а право считается
  // серверными. Иначе окно открывалось бы подстановкой времени в запрос.
  const faked = treatmentTasksDue(db, { date: START, now: localTs(START, 6, 1) }, ACTOR.nurse);
  assert.equal(faked.groups.done.find((d) => d.administration_id === stale.id).undo.allowed, false);

  // Снятая отметка из «Сделано» уходит: это список того, что стоит.
  treatmentAdminUnmark(db, { administration_id: fresh.id, reason: 'не та строка' }, ACTOR.nurse);
  assert.equal(treatmentTasksDue(db, { date: START, now: localTs(START, 14, 30) }, ACTOR.nurse).counts.done, 1);
  db.close();
});

// ─── 6. Задачи медсестры ────────────────────────────────────────────────────

test('задачи смены разложены по группам «Просрочено / Сейчас / Позже / По требованию»', () => {
  const db = seed();
  const id = admission(db);
  const o = order(db, id);                                         // 6, 14, 22
  order(db, id, { freq_code: 'prn', name: 'Кеторол', days: null });

  // 14:30 по местным часам: 06:00 просрочено, 14:00 задержано → «Сейчас»,
  // 22:00 ещё далеко → «Позже».
  const res = treatmentTasksDue(db, { date: START, now: localTs(START, 14, 30) }, ACTOR.nurse);
  assert.deepEqual(res.groups.overdue.map((t) => t.slot), [6]);
  assert.deepEqual(res.groups.now.map((t) => t.slot), [14]);
  assert.deepEqual(res.groups.later.map((t) => t.slot), [22]);
  assert.equal(res.groups.prn.length, 1);
  assert.equal(res.groups.prn[0].given_today, 0);
  // stock_issues — счётчик несписанного (MED_ADMIN_CHARGE_V1, Задача 6): в
  // этой смене ни одной отметки ещё не поставлено, значит и хвоста нет.
  assert.deepEqual(res.counts, { overdue: 1, now: 1, later: 1, prn: 1, done: 0, stock_issues: 0 });

  // Пациент — якорь: у каждой задачи есть палата, койка и имя.
  const task = res.groups.overdue[0];
  assert.equal(task.patient_name, 'Иванов Иван');
  assert.equal(task.ward_name, 'Терапия');
  assert.equal(task.bed_code, 'K-1');
  assert.equal(task.state, 'missed');
  assert.equal(task.late_min, 510);

  // Закрытая доза из списка уходит.
  treatmentAdminMark(db, { order_id: o.id, date: START, slot: 6, status: 'given' }, ACTOR.nurse);
  const after = treatmentTasksDue(db, { date: START, now: localTs(START, 14, 30) }, ACTOR.nurse);
  assert.equal(after.groups.overdue.length, 0);
  db.close();
});

test('«ожидает» за час до дозы — это «Сейчас», а раньше — «Позже»', () => {
  const db = seed();
  const id = admission(db);
  order(db, id, { freq_code: '1x' });   // 10:00
  const soon = treatmentTasksDue(db, { date: START, now: localTs(START, 9, 30) }, ACTOR.nurse);
  assert.deepEqual(soon.groups.now.map((t) => t.slot), [10]);
  const early = treatmentTasksDue(db, { date: START, now: localTs(START, 6) }, ACTOR.nurse);
  assert.deepEqual(early.groups.later.map((t) => t.slot), [10]);
  db.close();
});

test('список задач ограничивается отделением и только теми, кто лечится', () => {
  const db = seed();
  const a1 = admission(db);
  const a2 = admission(db, 'active', { patient_id: 2, ward_id: 2, bed_id: 2 });
  const a3 = admission(db, 'examined', { patient_id: 2, ward_id: 1, bed_id: null });
  order(db, a1, { freq_code: '1x' });
  order(db, a2, { freq_code: '1x' }, ACTOR.admin);
  // Назначение на 'examined' завести нельзя — вставляем его мимо RPC, чтобы
  // проверить, что список задач всё равно его не покажет.
  db.prepare(`INSERT INTO treatment_orders (admission_id, name, freq_code, slots, starts_on)
              VALUES (?,?,'1x','[10]',?)`).run(a3, 'Мимо маршрута', START);

  const all = treatmentTasksDue(db, { date: START, now: localTs(START, 9, 30) }, ACTOR.senior_nurse);
  assert.equal(all.groups.now.length, 2, 'оба лечащихся пациента, но не тот, кто ещё не дошёл до лечения');

  const therapy = treatmentTasksDue(db, { date: START, now: localTs(START, 9, 30), ward_id: 1 }, ACTOR.nurse);
  assert.deepEqual(therapy.groups.now.map((t) => t.patient_name), ['Иванов Иван']);
  db.close();
});

test('список задач закрыт от кассы', () => {
  const db = seed();
  assert.throws(() => treatmentTasksDue(db, { date: START }, ACTOR.cashier), (e) => e.status === 403);
  db.close();
});
