import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { ensureVisit } from './visits.js';

const REG = { id: 1, role: 'registrar' };

function freshDb() {
  const db = openDb(':memory:'); migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_active, specialty) VALUES (1,'r','x','Reg','registrar',1,'')").run();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_active, specialty) VALUES (2,'d','x','Doc','doctor',1,'')").run();
  db.prepare("INSERT INTO patients (id, full_name) VALUES (1,'P')").run();
  return db;
}

test('ensure_visit: one visit per patient per day — same day reuses, next day creates', async () => {
  const db = freshDb();
  const a = await ensureVisit(db, { patient_id: 1, date: '2026-08-07T09:00:00Z', doctor_id: 2 }, REG);
  assert.equal(a.created, true);
  assert.equal(a.visit.visit_date, '2026-08-07T09:00:00Z');

  // afternoon service, SAME day -> same visit, no new row
  const b = await ensureVisit(db, { patient_id: 1, date: '2026-08-07T16:30:00Z' }, REG);
  assert.equal(b.created, false);
  assert.equal(b.visit.id, a.visit.id);

  // next day -> its own visit
  const c = await ensureVisit(db, { patient_id: 1, date: '2026-08-08T10:00:00Z' }, REG);
  assert.equal(c.created, true);
  assert.notEqual(c.visit.id, a.visit.id);

  // statistics: two day-visits exist
  assert.equal(db.prepare('SELECT COUNT(*) n FROM visits WHERE patient_id=1').get().n, 2);
});

test('ensure_visit: bare date works; doctor backfills onto a doctor-less day', async () => {
  const db = freshDb();
  const a = await ensureVisit(db, { patient_id: 1, date: '2026-08-09' }, REG);
  assert.equal(a.created, true);
  assert.equal(a.visit.doctor_id, null);
  const b = await ensureVisit(db, { patient_id: 1, date: '2026-08-09T12:00:00Z', doctor_id: 2 }, REG);
  assert.equal(b.created, false);
  assert.equal(b.visit.doctor_id, 2);   // first assigned doctor lands on the day visit
});

test('ensure_visit: cancelled day does not swallow a new booking', async () => {
  const db = freshDb();
  const a = await ensureVisit(db, { patient_id: 1, date: '2026-08-10T09:00:00Z' }, REG);
  db.prepare("UPDATE visits SET status='cancelled' WHERE id=?").run(a.visit.id);
  const b = await ensureVisit(db, { patient_id: 1, date: '2026-08-10T11:00:00Z' }, REG);
  assert.equal(b.created, true);
  assert.notEqual(b.visit.id, a.visit.id);
});

test('ensure_visit: validation + roles', async () => {
  const db = freshDb();
  await assert.rejects(() => ensureVisit(db, { patient_id: 999, date: '2026-08-07' }, REG), /patient not found/);
  await assert.rejects(() => ensureVisit(db, { patient_id: 1, date: 'nope' }, REG), /date must be ISO/);
  await assert.rejects(() => ensureVisit(db, { patient_id: 1, date: '2026-08-07' }, { id: 9, role: 'cashier' }), /not allowed/);
});

test('CRM_AUTO_CAME_V1: ensure_visit flips linked active CRM leads to came, leaves others alone', async () => {
  const db = freshDb();
  db.prepare("INSERT INTO patients (id, full_name) VALUES (2,'Other')").run();
  const ins = db.prepare("INSERT INTO crm_requests (full_name, phone, status, patient_id) VALUES (?,?,?,?)");
  ins.run('L1', '1', 'scheduled', 1);        // linked, active -> came
  ins.run('L2', '2', 'no_show', 1);          // linked, missed earlier -> came
  ins.run('L3', '3', 'stopped', 1);          // linked, dead -> untouched
  ins.run('L4', '4', 'scheduled', 2);        // other patient -> untouched
  ins.run('L5', '5', 'scheduled', null);     // unlinked -> untouched

  await ensureVisit(db, { patient_id: 1, date: '2026-08-09' }, REG);

  const st = (id) => db.prepare('SELECT status FROM crm_requests WHERE id=?').get(id).status;
  assert.equal(st(1), 'came');
  assert.equal(st(2), 'came');
  assert.equal(st(3), 'stopped');
  assert.equal(st(4), 'scheduled');
  assert.equal(st(5), 'scheduled');

  // reusing the same day's visit flips too (idempotent for already-came)
  await ensureVisit(db, { patient_id: 2, date: '2026-08-09' }, REG);
  assert.equal(st(4), 'came');
});

// CRM_FUTURE_LEAD_V2 — REGRESSION: turning up for one service closed EVERY open
// lead the patient had. A consultation booked for next month was marked «Пришёл»
// on the spot: it dropped off the scheduled list and the funnel counted a
// conversion that had not happened.
test('CRM_FUTURE_LEAD_V2: a visit closes today\'s and overdue leads, never a future booking', async () => {
  const db = freshDb();
  const ins = db.prepare("INSERT INTO crm_requests (full_name, phone, status, patient_id, scheduled_date) VALUES (?,?,?,?,?)");
  ins.run('today',    '1', 'scheduled', 1, '2026-08-09');   // booked for this very day -> came
  ins.run('overdue',  '2', 'scheduled', 1, '2026-08-01');   // missed earlier, now here -> came
  ins.run('undated',  '3', 'in_process', 1, null);          // walk-in lead, no date -> came
  ins.run('blank',    '4', 'recall', 1, '');                // empty string, treated as undated -> came
  ins.run('future',   '5', 'scheduled', 1, '2026-09-15');   // next month -> MUST stay scheduled
  ins.run('tomorrow', '6', 'approved', 1, '2026-08-10');    // tomorrow -> MUST stay approved

  await ensureVisit(db, { patient_id: 1, date: '2026-08-09' }, REG);

  const st = (id) => db.prepare('SELECT status FROM crm_requests WHERE id=?').get(id).status;
  assert.equal(st(1), 'came');
  assert.equal(st(2), 'came');
  assert.equal(st(3), 'came');
  assert.equal(st(4), 'came');
  assert.equal(st(5), 'scheduled', 'a lead booked for next month must survive today\'s visit');
  assert.equal(st(6), 'approved', 'tomorrow\'s appointment must survive today\'s visit');

  // …and when the patient turns up for it, it closes then.
  await ensureVisit(db, { patient_id: 1, date: '2026-09-15' }, REG);
  assert.equal(st(5), 'came');
  assert.equal(st(6), 'came');   // by then it is overdue, so it closes too
});
