// TWO_STEP_DISCHARGE_V1 — выписка в два шага (Задача 8 плана «Стационар»).
//
// Проверяется то, ради чего два шага и заведены, а не «функция вернула объект»:
//   • ВРАЧ НЕ ОСВОБОЖДАЕТ КОЙКУ, МЕДСЕСТРА НЕ ОБЪЯВЛЯЕТ ИСХОД — каждый шаг
//     проходит у своих и отказывает остальным;
//   • заявку не принимают без ОПУБЛИКОВАННОГО выписного эпикриза (черновик —
//     не документ);
//   • ДОЛГ ПРЕДУПРЕЖДАЕТ, А НЕ ЗАПРЕЩАЕТ: без подписи отказ, с подписью —
//     выписка проходит С ДОЛГОМ, и подпись сохраняется вместе с суммой;
//   • КОЙКА НЕ СТАНОВИТСЯ СВОБОДНОЙ: 'cleaning', и открывает её отдельное
//     действие;
//   • НИКТО НЕ ЗАПЕРТ: старая одношаговая выписка работает из КАЖДОГО
//     состояния «в койке» — иначе пациенты, положенные до обновления, остались
//     бы в клинике из-за отсутствия эпикриза, которого никто не собирался
//     писать;
//   • заявку можно ОТОЗВАТЬ, и пациент возвращается в лечение вместе с койкой.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import {
  admissionDischargeRequest, admissionDischargeCancelRequest,
  admissionDischargeFinalize, admissionDischargeQueue, admissionBalance,
  dischargePatient, setBedStatus, DISCHARGE_OUTCOMES,
} from './inpatient.js';
import { IN_BED_STATUSES } from './inpatient-flow.js';

// Носитель роли: надстроечные роли живут ТОЛЬКО в extra_roles — врач остаётся
// врачом, медсестра медсестрой (INPATIENT_FLOW_V1).
const DOCTOR = { id: 2, role: 'doctor' };                                   // лечащий
const OTHER_DOCTOR = { id: 3, role: 'doctor' };                             // чужой
const HEAD = { id: 2, role: 'doctor', extra_roles: ['head_doctor'] };
const NURSE = { id: 5, role: 'nurse' };
const SENIOR = { id: 5, role: 'nurse', extra_roles: ['senior_nurse'] };
const ADMIN = { id: 1, role: 'admin' };
const CASHIER = { id: 6, role: 'cashier' };

function seed() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (1,'adm','x','Админ','admin')").run();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (2,'doc','x','Лечащий врач','doctor')").run();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (3,'doc2','x','Чужой врач','doctor')").run();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (5,'nur','x','Медсестра','nurse')").run();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (6,'cash','x','Кассир','cashier')").run();
  db.prepare("INSERT INTO patients (id, full_name) VALUES (1,'Иванов Иван')").run();
  db.prepare("INSERT INTO wards (id, name, billing_mode, price_per_day) VALUES (1,'Терапия','daily',150000)").run();
  db.prepare("INSERT INTO beds (id, code, ward_id, status, active) VALUES (1,'K-1',1,'occupied',1)").run();
  db.prepare("INSERT INTO beds (id, code, ward_id, status, active) VALUES (2,'K-2',1,'free',1)").run();
  return db;
}

/** Госпитализация в нужном состоянии (фикстура — мимо машины маршрута). */
function admission(db, status = 'active', extra = {}) {
  const cols = {
    patient_id: 1, ward_id: 1, bed_id: 1, doctor_id: 2, attending_doctor_id: 2,
    status, admitted_at: '2026-09-01T08:00:00Z', ...extra,
  };
  const keys = Object.keys(cols);
  return db.prepare(`INSERT INTO admissions (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
    .run(...keys.map((k) => cols[k])).lastInsertRowid;
}

/** Опубликованный выписной эпикриз — то, без чего заявку не принимают. */
function epicrisis(db, admissionId, { published = true } = {}) {
  return db.prepare(`
    INSERT INTO admission_reviews (admission_id, kind, diagnosis, body, author_id, author_role, published_at)
    VALUES (?, 'discharge', 'Пневмония, разрешение', 'Выписной эпикриз', 2, 'doctor', ?)`)
    .run(admissionId, published ? '2026-09-04T09:00:00Z' : null).lastInsertRowid;
}

/** Идущее назначение. */
function order(db, admissionId, name = 'Цефтриаксон') {
  return db.prepare(`
    INSERT INTO treatment_orders (admission_id, name, dose, route, freq_code, slots, starts_on, days, prescribed_by)
    VALUES (?, ?, '1 г', 'в/м', '3x', '[6,14,22]', '2026-09-01', 5, 2)`)
    .run(admissionId, name).lastInsertRowid;
}

/** Неоплаченная строка: начислено, в счёт ещё не собрано. */
function chargeLine(db, admissionId, total, { billable = 1 } = {}) {
  return db.prepare(`
    INSERT INTO admission_services (admission_id, quantity, unit_price, total, billable, notes)
    VALUES (?, 1, ?, ?, ?, 'услуга')`).run(admissionId, total, total, billable).lastInsertRowid;
}

/** Госпитализация, доведённая до 'discharging' штатным первым шагом. */
function requested(db, extra = {}) {
  const id = admission(db, 'active', extra);
  epicrisis(db, id);
  admissionDischargeRequest(db, { admission_id: id, outcome: 'home', recommendations: 'Наблюдение у терапевта' }, DOCTOR);
  return id;
}

// ─── 1. ШАГ 1: заявку подаёт лечащий врач ───────────────────────────────────

test('заявка лечащего врача переводит active → discharging и подписывается', () => {
  const db = seed();
  const id = admission(db);
  epicrisis(db, id);

  const res = admissionDischargeRequest(db, {
    admission_id: id, outcome: 'home',
    recommendations: 'Наблюдение у терапевта, контроль ОАК через 10 дней',
    planned_discharge_at: '2026-09-05',
    at: '2026-09-04T10:00:00Z',
  }, DOCTOR);

  assert.equal(res.admission.status, 'discharging');
  assert.equal(res.admission.discharge_outcome, 'home');
  assert.equal(res.admission.discharge_requested_by, 2, 'подписана врачом');
  assert.equal(res.admission.discharge_requested_at, '2026-09-04T10:00:00Z');
  assert.match(res.admission.discharge_recommendations, /контроль ОАК/);
  assert.equal(res.admission.planned_discharge_at, '2026-09-05');
  // КОЙКА НЕ ТРОНУТА: врач не освобождает койку — пациент всё ещё лежит.
  assert.equal(db.prepare('SELECT status FROM beds WHERE id=1').get().status, 'occupied');
  assert.equal(res.admission.discharged_at, null, 'выписки ещё не было');
  db.close();
});

test('вторую заявку подать нельзя: кнопка читается «Заявка подана»', () => {
  const db = seed();
  const id = requested(db);
  assert.throws(() => admissionDischargeRequest(db, { admission_id: id, outcome: 'home' }, DOCTOR),
    (e) => e.status === 400 && /Заявка на выписку уже подана/.test(e.message));
  db.close();
});

test('исход обязателен, и он — один из четырёх', () => {
  const db = seed();
  const id = admission(db);
  epicrisis(db, id);
  for (const bad of [undefined, '', 'улучшение', 'HOME']) {
    assert.throws(() => admissionDischargeRequest(db, { admission_id: id, outcome: bad }, DOCTOR),
      /Укажите исход/, String(bad));
  }
  assert.deepEqual(DISCHARGE_OUTCOMES, ['home', 'transfer', 'refuse', 'death']);
  db.close();
});

test('перевод в другое учреждение без адреса назначения не принимается', () => {
  const db = seed();
  const id = admission(db);
  epicrisis(db, id);
  assert.throws(() => admissionDischargeRequest(db, { admission_id: id, outcome: 'transfer' }, DOCTOR),
    /в какое учреждение переведён/);
  const ok = admissionDischargeRequest(db,
    { admission_id: id, outcome: 'transfer', destination: 'Городская больница №2' }, DOCTOR);
  assert.equal(ok.admission.discharge_destination, 'Городская больница №2');
  db.close();
});

test('без ОПУБЛИКОВАННОГО выписного эпикриза заявку не принимают — и черновик это не эпикриз', () => {
  const db = seed();

  // Ни одной записи.
  const bare = admission(db);
  assert.throws(() => admissionDischargeRequest(db, { admission_id: bare, outcome: 'home' }, DOCTOR),
    (e) => e.status === 400 && /Выписной эпикриз не написан/.test(e.message));
  assert.equal(db.prepare('SELECT status FROM admissions WHERE id=?').get(bare).status, 'active',
    'отказ ничего не сдвинул');

  // Черновик — и отказ говорит ДРУГОЕ: человеку осталось нажать «Опубликовать».
  const draft = admission(db);
  epicrisis(db, draft, { published: false });
  assert.throws(() => admissionDischargeRequest(db, { admission_id: draft, outcome: 'home' }, DOCTOR),
    /сохранён черновиком — опубликуйте/);

  // Первичный осмотр выписным эпикризом не считается.
  const primary = admission(db);
  db.prepare(`INSERT INTO admission_reviews (admission_id, kind, author_id, published_at)
              VALUES (?, 'primary', 2, '2026-09-01T09:00:00Z')`).run(primary);
  assert.throws(() => admissionDischargeRequest(db, { admission_id: primary, outcome: 'home' }, DOCTOR),
    /Выписной эпикриз не написан/);

  // Заменённый исправлением эпикриз — история, а не действующий документ.
  const superseded = admission(db);
  const oldId = epicrisis(db, superseded);
  const newId = epicrisis(db, superseded, { published: false });
  db.prepare('UPDATE admission_reviews SET superseded_by = ? WHERE id = ?').run(newId, oldId);
  assert.throws(() => admissionDischargeRequest(db, { admission_id: superseded, outcome: 'home' }, DOCTOR),
    /черновиком — опубликуйте/);
  db.close();
});

test('медсестра заявку на выписку не подаёт — и отказ называет, кого звать', () => {
  const db = seed();
  const id = admission(db);
  epicrisis(db, id);
  for (const who of [NURSE, SENIOR, CASHIER]) {
    assert.throws(() => admissionDischargeRequest(db, { admission_id: id, outcome: 'home' }, who),
      (e) => e.status === 403 && /недоступно вашей роли/.test(e.message) && /Это делает: /.test(e.message),
      who.role + (who.extra_roles || []).join(''));
  }
  assert.equal(db.prepare('SELECT status FROM admissions WHERE id=?').get(id).status, 'active');
  db.close();
});

test('чужой пациент — не свой: заявку подаёт лечащий врач или главный', () => {
  const db = seed();
  const id = admission(db);
  epicrisis(db, id);
  assert.throws(() => admissionDischargeRequest(db, { admission_id: id, outcome: 'home' }, OTHER_DOCTOR),
    (e) => e.status === 403 && /лечащий врач этого пациента или главный врач/.test(e.message));
  // Главный врач — по всему отделению.
  const res = admissionDischargeRequest(db, { admission_id: id, outcome: 'home' }, HEAD);
  assert.equal(res.admission.status, 'discharging');
  db.close();
});

test('заявка до лечения отвергается маршрутом, а не ролью: сначала осмотр', () => {
  const db = seed();
  for (const status of ['admitted', 'examined']) {
    const id = admission(db, status);
    epicrisis(db, id);
    assert.throws(() => admissionDischargeRequest(db, { admission_id: id, outcome: 'home' }, ADMIN),
      (e) => e.status === 400 && /Нельзя пропустить шаг/.test(e.message), status);
  }
  db.close();
});

// ─── 2. ШАГ 1': отзыв заявки ────────────────────────────────────────────────

test('отозванная заявка возвращает пациента в лечение — вместе с койкой', () => {
  const db = seed();
  const id = requested(db);

  const res = admissionDischargeCancelRequest(db,
    { admission_id: id, reason: 'Поднялась температура' }, DOCTOR);

  assert.equal(res.admission.status, 'active');
  assert.equal(res.admission.bed_id, 1, 'койка осталась за пациентом');
  assert.equal(db.prepare('SELECT status FROM beds WHERE id=1').get().status, 'occupied');
  assert.equal(res.admission.discharged_at, null, 'выписки не было');
  // Подпись заявки стёрта: исход у лежащего пациента — ложь на карточке.
  assert.equal(res.admission.discharge_outcome, null);
  assert.equal(res.admission.discharge_requested_by, null);
  assert.equal(res.admission.discharge_requested_at, null);
  // Рекомендации ОСТАЛИСЬ: это набранный врачом клинический текст.
  assert.match(res.admission.discharge_recommendations, /Наблюдение у терапевта/);
  // След в журнале движений — единственная память о том, что передумали.
  const jr = db.prepare("SELECT * FROM admission_transfers WHERE admission_id=? AND kind='discharge_cancel'").get(id);
  assert.ok(jr, 'отзыв записан в журнал');
  assert.equal(jr.reason, 'Поднялась температура');
  assert.equal(jr.transferred_by, 2);

  // И после отзыва заявку можно подать заново.
  const again = admissionDischargeRequest(db, { admission_id: id, outcome: 'home' }, DOCTOR);
  assert.equal(again.admission.status, 'discharging');
  db.close();
});

test('отзыв требует причины, и делает его не старшая медсестра', () => {
  const db = seed();
  const id = requested(db);
  assert.throws(() => admissionDischargeCancelRequest(db, { admission_id: id }, DOCTOR),
    /Укажите причину отзыва/);
  assert.throws(() => admissionDischargeCancelRequest(db, { admission_id: id, reason: 'передумали' }, SENIOR),
    (e) => e.status === 403 && /недоступно вашей роли/.test(e.message));
  assert.throws(() => admissionDischargeCancelRequest(db, { admission_id: id, reason: 'передумали' }, OTHER_DOCTOR),
    (e) => e.status === 403 && /лечащий врач этого пациента/.test(e.message));
  assert.equal(db.prepare('SELECT status FROM admissions WHERE id=?').get(id).status, 'discharging');
  db.close();
});

test('отзывать нечего, пока заявки нет', () => {
  const db = seed();
  assert.throws(() => admissionDischargeCancelRequest(db, { admission_id: admission(db, 'active'), reason: 'x' }, DOCTOR),
    /Заявка на выписку не подана/);
  assert.throws(() => admissionDischargeCancelRequest(db, { admission_id: admission(db, 'discharged'), reason: 'x' }, DOCTOR),
    /уже выписан/);
  db.close();
});

// ─── 3. ШАГ 2: оформляет старшая медсестра ──────────────────────────────────

test('оформление старшей медсестрой закрывает госпитализацию и ставит ФАКТИЧЕСКОЕ время', () => {
  const db = seed();
  const id = requested(db);

  const res = admissionDischargeFinalize(db, {
    admission_id: id, at: '2026-09-05T15:40:00Z',
    bill_settled: true, docs_given: true, note: 'Перевозка забрала в 15:40',
  }, SENIOR);

  assert.equal(res.admission.status, 'discharged');
  assert.equal(res.admission.discharged_at, '2026-09-05T15:40:00Z', 'время настоящее, а не «когда нажали»');
  assert.equal(res.admission.discharged_by, 5, 'подписано оформившей');
  assert.equal(res.admission.discharge_requested_by, 2, 'подпись врача на месте — подписей две');
  assert.equal(res.admission.discharge_bill_settled, 1);
  assert.equal(res.admission.discharge_docs_given, 1);
  assert.equal(res.admission.discharge_note, 'Перевозка забрала в 15:40');
  // Журнал движений: выписка — событие с пациентом.
  const jr = db.prepare("SELECT * FROM admission_transfers WHERE admission_id=? AND kind='discharge'").get(id);
  assert.ok(jr && jr.from_bed_id === 1 && jr.transferred_at === '2026-09-05T15:40:00Z');
  db.close();
});

test('КОЙКА НЕ СТАНОВИТСЯ СВОБОДНОЙ: после выписки уборка, и открывает её отдельное действие', () => {
  const db = seed();
  const id = requested(db);
  const res = admissionDischargeFinalize(db, { admission_id: id }, SENIOR);

  assert.equal(res.bed.status, 'cleaning', 'НЕ free — правило референса');
  assert.equal(db.prepare('SELECT status FROM beds WHERE id=1').get().status, 'cleaning');

  // Второе, отдельное действие — и старшая медсестра вправе его сделать.
  const opened = setBedStatus(db, { bed_id: 1, status: 'free' }, SENIOR);
  assert.equal(opened.bed.status, 'free');
  db.close();
});

test('врач выписку НЕ ОФОРМЛЯЕТ: он подал заявку, и на этом его часть кончилась', () => {
  const db = seed();
  const id = requested(db);
  for (const who of [DOCTOR, OTHER_DOCTOR, NURSE, CASHIER]) {
    assert.throws(() => admissionDischargeFinalize(db, { admission_id: id }, who),
      (e) => e.status === 403 && /недоступно вашей роли/.test(e.message),
      who.role + who.id);
  }
  assert.equal(db.prepare('SELECT status FROM admissions WHERE id=?').get(id).status, 'discharging');
  // Главный врач и администратор — вправе (отделение не встаёт из-за одного
  // отсутствующего человека).
  assert.equal(admissionDischargeFinalize(db, { admission_id: id }, HEAD).admission.status, 'discharged');
  db.close();
});

test('оформить выписку без заявки врача нельзя — в этом и есть два шага', () => {
  const db = seed();
  const cases = [
    ['active', /Заявка на выписку не подана/],
    ['admitted', /Заявка на выписку не подана/],
    ['ordered', /ещё не размещён на койке/],
    ['discharged', /уже выписан/],
    ['cancelled', /отменена/],
  ];
  for (const [status, re] of cases) {
    const id = admission(db, status, status === 'ordered' ? { bed_id: null } : {});
    assert.throws(() => admissionDischargeFinalize(db, { admission_id: id }, SENIOR), re, status);
  }
  db.close();
});

// ─── 4. Деньги предупреждают, а не запрещают ────────────────────────────────

test('долг НЕ БЛОКИРУЕТ выписку, но требует подписи — и подпись сохраняется с суммой', () => {
  const db = seed();
  const id = requested(db);
  chargeLine(db, id, 450000);

  // Без подписи — отказ, и он называет СУММУ и говорит, что выписке это не мешает.
  let refusal = null;
  try { admissionDischargeFinalize(db, { admission_id: id }, SENIOR); } catch (e) { refusal = e; }
  assert.ok(refusal, 'без подтверждения долга выписка не проходит молча');
  assert.equal(refusal.status, 400);
  assert.match(refusal.message, /450000/, 'сумма названа');
  assert.match(refusal.message, /Выписке это не мешает/, 'это предупреждение, а не запрет на выписку');
  assert.match(refusal.message, /Долг согласован/);
  assert.equal(db.prepare('SELECT status FROM admissions WHERE id=?').get(id).status, 'discharging');

  // С подписью — выписка проходит С ДОЛГОМ. Денег никто не потребовал.
  const res = admissionDischargeFinalize(db, { admission_id: id, debt_ack: true }, SENIOR);
  assert.equal(res.admission.status, 'discharged');
  assert.equal(res.debt_acknowledged, true);
  assert.equal(res.admission.discharge_debt_ack, 1);
  assert.equal(res.admission.discharge_debt_ack_by, 5, 'КТО согласовал долг — записано');
  assert.ok(res.admission.discharge_debt_ack_at, 'и КОГДА');
  assert.equal(res.admission.discharge_debt_amount, 450000, 'сумма, под которой расписались, застыла в строке');
  assert.equal(db.prepare('SELECT status FROM beds WHERE id=1').get().status, 'cleaning');
  db.close();
});

test('нет долга — нет и лишнего вопроса: подпись не спрашивают и не ставят', () => {
  const db = seed();
  const id = requested(db);
  const res = admissionDischargeFinalize(db, { admission_id: id }, SENIOR);
  assert.equal(res.admission.status, 'discharged');
  assert.equal(res.debt_acknowledged, false);
  assert.equal(res.admission.discharge_debt_ack, 0);
  assert.equal(res.admission.discharge_debt_ack_by, null);
  assert.equal(res.admission.discharge_debt_amount, 0, 'ноль — это 0, а не «не знаем»');
  db.close();
});

test('долг считается из невыставленного и неоплаченного — и НЕ считает исключённое', () => {
  const db = seed();
  const id = admission(db);

  assert.equal(admissionBalance(db, id).balance, 0, 'пустая госпитализация ничего не должна');

  // Начислено, но ещё не в счёте.
  chargeLine(db, id, 200000);
  assert.equal(admissionBalance(db, id).balance, 200000);

  // Строка «в учёте расходов» — внутренний расход клиники, пациенту не
  // выставляется никогда.
  chargeLine(db, id, 999000, { billable: 0 });
  let bal = admissionBalance(db, id);
  assert.equal(bal.balance, 200000, 'billable=0 в долг не входит');
  assert.equal(bal.excludes.internal_lines, 1);
  assert.equal(bal.excludes.internal_amount, 999000);

  // Счёт на 300000, оплачено 120000.
  db.prepare(`INSERT INTO invoices (id, invoice_number, admission_id, patient_id, subtotal, total_amount, paid_amount, status)
              VALUES (10,'INV-10',?,1,300000,300000,120000,'partial')`).run(id);
  bal = admissionBalance(db, id);
  assert.equal(bal.invoiced, 300000);
  assert.equal(bal.paid, 120000);
  assert.equal(bal.balance, 200000 + 300000 - 120000);

  // Аннулированный счёт из долга выпадает и объявляется.
  db.prepare(`INSERT INTO invoices (id, invoice_number, admission_id, patient_id, subtotal, total_amount, paid_amount, status)
              VALUES (11,'INV-11',?,1,700000,700000,0,'void')`).run(id);
  bal = admissionBalance(db, id);
  assert.equal(bal.balance, 380000, 'void в долг не входит');
  assert.equal(bal.excludes.void_invoices, 1);

  // Счёт ВИЗИТА того же пациента к стационару не относится: admission_id пуст.
  db.prepare(`INSERT INTO invoices (id, invoice_number, patient_id, subtotal, total_amount, paid_amount, status)
              VALUES (12,'INV-12',1,500000,500000,0,'unpaid')`).run();
  assert.equal(admissionBalance(db, id).balance, 380000, 'приём в поликлинике — не долг стационара');
  db.close();
});

// ─── 5. Лист назначений ─────────────────────────────────────────────────────

test('оставшиеся назначения закрываются причиной «Выписка» — и не удаляются', () => {
  const db = seed();
  const id = requested(db);
  const a = order(db, id, 'Цефтриаксон');
  const b = order(db, id, 'Омепразол');
  // Одно уже отменено врачом ранее — его причину трогать нельзя.
  db.prepare("UPDATE treatment_orders SET status='cancelled', cancel_reason='аллергия' WHERE id=?").run(b);

  const res = admissionDischargeFinalize(db, { admission_id: id, close_orders: true }, SENIOR);

  assert.equal(res.orders_closed, 1);
  assert.equal(res.orders_left, 0);
  assert.equal(res.admission.discharge_orders_closed, 1, 'чек-лист: лист назначений закрыт');

  const closed = db.prepare('SELECT * FROM treatment_orders WHERE id=?').get(a);
  assert.equal(closed.status, 'cancelled');
  assert.equal(closed.cancel_reason, 'Выписка');
  assert.equal(closed.cancel_by, 5, 'кто закрыл');
  assert.ok(closed.cancel_at);
  // Отменённое не удаляется — правило 093, и чужая причина не переписана.
  assert.equal(db.prepare('SELECT cancel_reason r FROM treatment_orders WHERE id=?').get(b).r, 'аллергия');
  db.close();
});

test('незакрытый лист назначений выписку НЕ ЗАПРЕЩАЕТ — он её помечает', () => {
  const db = seed();
  const id = requested(db);
  order(db, id);

  const res = admissionDischargeFinalize(db, { admission_id: id }, SENIOR);   // close_orders не просили
  assert.equal(res.admission.status, 'discharged', 'предупреждение, а не запрет');
  assert.equal(res.orders_left, 1);
  assert.equal(res.admission.discharge_orders_closed, 0, 'и в строке видно, что лист остался открытым');
  db.close();
});

// ─── 6. Очередь старшей медсестры ───────────────────────────────────────────

test('очередь «Выписки к оформлению» показывает, кого отпускают, и с каким долгом', () => {
  const db = seed();
  const idle = admission(db, 'active', { patient_id: 1 });   // лечится — в очередь не попадает
  db.prepare("INSERT INTO patients (id, full_name) VALUES (2,'Петров Пётр')").run();
  const id = requested(db, { patient_id: 2, bed_id: 2 });
  chargeLine(db, id, 75000);
  order(db, id);

  const q = admissionDischargeQueue(db, {}, SENIOR);
  assert.equal(q.rows.length, 1, 'только те, по кому подана заявка');
  const row = q.rows[0];
  assert.equal(row.admission_id, id);
  assert.equal(row.patient_name, 'Петров Пётр');
  assert.equal(row.ward_name, 'Терапия');
  assert.equal(row.bed_code, 'K-2');
  assert.equal(row.attending_name, 'Лечащий врач');
  assert.equal(row.requested_by_name, 'Лечащий врач');
  assert.equal(row.discharge_outcome, 'home');
  assert.ok(row.discharge_requested_at);
  assert.equal(row.balance.balance, 75000, 'долг считает сервер, а не браузер');
  assert.equal(row.active_orders, 1);
  assert.deepEqual(q.outcomes, DISCHARGE_OUTCOMES);
  assert.ok(!q.rows.some((r) => r.admission_id === idle));

  // Оформили — из очереди ушёл.
  admissionDischargeFinalize(db, { admission_id: id, debt_ack: true }, SENIOR);
  assert.equal(admissionDischargeQueue(db, {}, SENIOR).rows.length, 0);
  db.close();
});

test('очередь фильтруется отделением и закрыта для кассы', () => {
  const db = seed();
  requested(db);
  assert.equal(admissionDischargeQueue(db, { ward_id: 1 }, NURSE).rows.length, 1);
  db.prepare("INSERT INTO wards (id, name) VALUES (2,'Хирургия')").run();
  assert.equal(admissionDischargeQueue(db, { ward_id: 2 }, NURSE).rows.length, 0);
  assert.throws(() => admissionDischargeQueue(db, {}, CASHIER), (e) => e.status === 403);
  db.close();
});

// ─── 7. Никто не заперт: старый путь жив ────────────────────────────────────

test('прямая выписка v0.8.0 РАБОТАЕТ из каждого состояния «в койке» — и без эпикриза', () => {
  const db = seed();
  // Ни у одной из этих госпитализаций выписного эпикриза нет и не будет: их
  // клали до обновления. Если бы Задача 8 убрала прямой путь, каждый такой
  // пациент остался бы в клинике насовсем.
  for (const status of IN_BED_STATUSES) {
    const id = admission(db, status, { bed_id: null });
    const res = dischargePatient(db, { admission_id: id }, NURSE);
    assert.equal(res.admission.status, 'discharged', status);
    assert.ok(res.admission.discharged_at, status + ': время выписки проставлено');
  }
  db.close();
});

test('ИЗ КАЖДОГО состояния «в койке» наружу ведёт путь — инвариант, а не пример', () => {
  const db = seed();
  for (const status of IN_BED_STATUSES) {
    const id = admission(db, status, { bed_id: null });
    // Двухшаговый путь открыт из 'active' (через заявку) и из 'discharging'
    // (оформление); из остальных выводит прямая выписка. Пустого списка быть
    // не должно ни у одного состояния.
    const ways = [];
    if (status === 'active') {
      epicrisis(db, id);
      try { admissionDischargeRequest(db, { admission_id: id, outcome: 'home' }, DOCTOR); ways.push('request'); } catch { /* нет */ }
      admissionDischargeCancelRequest(db, { admission_id: id, reason: 'проверка' }, DOCTOR);
    }
    if (status === 'discharging') {
      try { admissionDischargeFinalize(db, { admission_id: id }, SENIOR); ways.push('finalize'); } catch { /* нет */ }
    }
    if (db.prepare('SELECT status s FROM admissions WHERE id=?').get(id).s !== 'discharged') {
      dischargePatient(db, { admission_id: id }, NURSE);
      ways.push('legacy');
    }
    assert.ok(ways.length > 0, status + ': из этого состояния нет выхода — пациент заперт');
    assert.equal(db.prepare('SELECT status s FROM admissions WHERE id=?').get(id).s, 'discharged', status);
  }
  db.close();
});

test('прямая выписка тоже отпускает койку в уборку, а не в свободные', () => {
  const db = seed();
  const id = admission(db, 'active');
  dischargePatient(db, { admission_id: id }, NURSE);
  assert.equal(db.prepare('SELECT status FROM beds WHERE id=1').get().status, 'cleaning');
  db.close();
});
