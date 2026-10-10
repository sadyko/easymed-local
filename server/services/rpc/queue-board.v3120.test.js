// V3120_FIX — доска очереди: кабинеты в порядке групп, один человек — один
// номер (после объединения карт), и отбор кандидатов по дню визита вместо
// перебора всей истории — с ТЕМ ЖЕ ответом, что давал прежний LIKE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { queueBoard, boardGroups, doctorQueueWaiting } from './queue.js';   // DOCTOR_PROFILE_V1 — boardGroups, doctorQueueWaiting

const REG = { id: 1, role: 'registrar' };
const DAY = '2026-08-07';

function freshDb() {
  const db = openDb(':memory:'); migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_active) VALUES (1,'r','x','Reg','registrar',1)").run();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_active, is_doctor) VALUES (2,'d1','x','Др. Азиза','doctor',1,1)").run();
  db.prepare("INSERT INTO services (id, name, price, type) VALUES (1,'Приём терапевта',50000,'consultation')").run();
  db.prepare("INSERT INTO services (id, name, price, type, is_lab) VALUES (3,'ОАК',30000,'lab',1)").run();
  db.prepare("INSERT INTO services (id, name, price, type) VALUES (5,'Капельница',20000,'procedure')").run();
  db.prepare("INSERT INTO rooms (id, name, code) VALUES (7,'Процедурная','101')").run();
  for (let i = 1; i <= 6; i++) db.prepare('INSERT INTO patients (id, full_name) VALUES (?, ?)').run(i, 'Пациент ' + i);
  return db;
}
let vid = 100;
function visit(db, patient, date, status = 'scheduled') {
  vid++;
  db.prepare('INSERT INTO visits (id, patient_id, visit_date, status) VALUES (?,?,?,?)').run(vid, patient, date, status);
  return vid;
}
function line(db, v, { svc = 1, doctor = 2, key, no, status = 'queued', sched = null }) {
  return db.prepare(`INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status, queue_key, queue_no, scheduled_at)
                     VALUES (?,?,?,1,100,100,?,?,?,?)`).run(v, svc, doctor, status, key, no, sched).lastInsertRowid;
}

/** Прежний отбор доски — дословно (до V3120_FIX), для сравнения. */
function oldRows(db, day) {
  return db.prepare(`
    SELECT vs.id FROM visit_services vs JOIN visits v ON v.id = vs.visit_id
     WHERE vs.queue_no IS NOT NULL AND vs.queue_key IS NOT NULL AND vs.queue_key LIKE ?
       AND v.status NOT IN ('cancelled', 'no_show')
     ORDER BY vs.queue_no, vs.id`).all('%:' + day).map((r) => r.id);
}

test('кабинет стоит в порядке групп (сразу за врачами), а не где придётся', () => {
  const db = freshDb();
  const v = visit(db, 1, `${DAY}T09:00:00Z`);
  line(db, v, { svc: 3, doctor: null, key: `lab:${DAY}`, no: 1 });
  line(db, v, { svc: 5, doctor: null, key: `room:7:${DAY}`, no: 1 });
  line(db, v, { svc: 1, doctor: 2, key: `doc:2:${DAY}`, no: 1 });
  const kinds = queueBoard(db, { day: DAY }, REG).groups.map((g) => g.kind);
  assert.deepEqual(kinds, ['doctor', 'room', 'lab']);
  db.close();
});

test('после объединения карт у человека два талона в одной очереди — на доске один, меньший', () => {
  const db = freshDb();
  // Пациент 1 (оставленная карта) и его дубль уже слиты: оба визита — пациента 1.
  const v1 = visit(db, 1, `${DAY}T09:00:00Z`);
  const v2 = visit(db, 1, `${DAY}T09:30:00Z`);
  const v3 = visit(db, 2, `${DAY}T09:10:00Z`);
  line(db, v1, { key: `doc:2:${DAY}`, no: 1 });
  line(db, v3, { key: `doc:2:${DAY}`, no: 2, status: 'added' });
  line(db, v2, { key: `doc:2:${DAY}`, no: 3, status: 'in_progress' });
  const g = queueBoard(db, { day: DAY }, REG).groups.find((x) => x.kind === 'doctor');
  assert.deepEqual(g.tickets.map((t) => [t.number, t.patient_name]), [[1, 'Пациент 1'], [2, 'Пациент 2']]);
  assert.equal(g.tickets[0].state, 'serving', 'талон дубля в работе — значит, в работе человек');
  assert.equal(g.total, 2);
  db.close();
});

test('отбор по дню визита отдаёт те же строки, что прежний перебор по ключу', () => {
  const db = freshDb();
  const prev = '2026-08-06', next = '2026-08-08';
  // Визиты вокруг дня, в разных записях даты (UTC, голая дата, пробел) и
  // строки со своим временем — в том числе давний визит (стационарный или
  // многодневный) со строкой, назначенной на этот день.
  const shapes = [`${DAY}T09:00:00Z`, `${DAY}`, `${DAY} 23:30:00`, `${prev}T20:00:00Z`, `${next}T01:00:00Z`, '2026-07-01T09:00:00Z'];
  let n = 0;
  for (const [i, d] of shapes.entries()) {
    const v = visit(db, (i % 6) + 1, d);
    // Ключ дня строки без своего времени — день её визита (issueQueueNumbers);
    // у давнего визита строка на этот день бывает только со своим временем.
    const far = d.startsWith('2026-07');
    line(db, v, { key: `doc:2:${DAY}`, no: ++n, sched: far ? `${DAY}T10:00:00Z` : null });
    line(db, v, { svc: 3, doctor: null, key: `lab:${prev}`, no: ++n });
    line(db, v, { svc: 3, doctor: null, key: `lab:${DAY}`, no: ++n, sched: `${DAY}T08:00:00Z` });
  }
  const old = visit(db, 3, '2026-06-01T09:00:00Z');
  line(db, old, { svc: 5, doctor: null, key: `proc:room:${DAY}`, no: ++n, sched: `${DAY}T11:00:00Z` });
  const dead = visit(db, 4, `${DAY}T12:00:00Z`, 'cancelled');
  line(db, dead, { key: `doc:2:${DAY}`, no: ++n });

  // Одна строка на пациента в очереди — иначе доска их законно сводит.
  const expected = oldRows(db, DAY);
  const b = queueBoard(db, { day: DAY }, REG);
  const got = [];
  for (const g of b.groups) for (const t of g.tickets) got.push(t.number);
  const expNumbers = db.prepare(`SELECT queue_no FROM visit_services WHERE id IN (${expected.join(',')})`).all().map((r) => r.queue_no);
  // Сравниваем по номерам, сведённым на пациента так же, как доска.
  const byKeyPatient = new Map();
  for (const id of expected) {
    const r = db.prepare('SELECT vs.queue_key k, vs.queue_no n, v.patient_id p FROM visit_services vs JOIN visits v ON v.id = vs.visit_id WHERE vs.id = ?').get(id);
    const k = r.k + '|' + r.p;
    if (!byKeyPatient.has(k) || byKeyPatient.get(k) > r.n) byKeyPatient.set(k, r.n);
  }
  assert.ok(expNumbers.length >= 8, 'фикстура слишком бедна');
  assert.deepEqual(got.sort((a, c) => a - c), [...byKeyPatient.values()].sort((a, c) => a - c));
  db.close();
});

test('план запроса: кандидаты берутся по индексу дня визита, а не перебором строк', () => {
  const db = freshDb();
  const plan = db.prepare(`EXPLAIN QUERY PLAN
    SELECT vs.id FROM visits v JOIN visit_services vs ON vs.visit_id = v.id
     WHERE v.visit_date >= ? AND v.visit_date < ? AND vs.queue_no IS NOT NULL
    UNION
    SELECT vs.id FROM visit_services vs
     WHERE vs.scheduled_at >= ? AND vs.scheduled_at < ? AND vs.queue_no IS NOT NULL`).all('a', 'b', 'a', 'b')
    .map((r) => r.detail).join('\n');
  assert.match(plan, /idx_visits_date/, plan);
  assert.match(plan, /idx_visit_services_sched_queue/, plan);
  assert.doesNotMatch(plan, /SCAN vs\b|SCAN visit_services\b/, plan);
  db.close();
});

// DOCTOR_PROFILE_V1 — «сейчас ждут приёма» у врача — та же доска: ждут и ждут
// оплаты (талон есть, не приняты; Р20 плана). Принимаемый, другой
// врач и лаборатория не считаются. Доска экрана не изменилась.
test('DOCTOR_PROFILE_V1: сколько ждут приёма у врача — с той же доски', () => {
  const db = freshDb();
  const a = visit(db, 1, `${DAY}T09:00:00Z`);
  const b = visit(db, 2, `${DAY}T09:05:00Z`);
  const c = visit(db, 3, `${DAY}T09:10:00Z`);
  const d = visit(db, 4, `${DAY}T09:15:00Z`);
  line(db, a, { key: `doc:2:${DAY}`, no: 1, status: 'in_progress' });
  line(db, b, { key: `doc:2:${DAY}`, no: 2, status: 'queued' });
  line(db, c, { key: `doc:2:${DAY}`, no: 3, status: 'added' });
  line(db, d, { svc: 3, doctor: null, key: `lab:${DAY}`, no: 1 });
  assert.equal(doctorQueueWaiting(db, 2, DAY), 2);
  assert.equal(doctorQueueWaiting(db, 99, DAY), 0);
  assert.deepEqual(boardGroups(db, DAY), queueBoard(db, { day: DAY }, REG).groups);
  db.close();
});
