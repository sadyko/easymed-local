// CRM_MULTI_SERVICE_V1 — one request, several services, a date each.
//
// The call centre used to be limited to one service per lead, so a patient
// booking three things produced three unrelated requests. The services moved to
// crm_request_services, each line owning its own date — which is what lets the
// registrar's prefill show «УЗИ» on the 20th and «анализы» on the 21st from a
// single call.
//
// The rule that matters most: a request stays OPEN until every line is done. Get
// that wrong and the second and third appointments disappear from the
// registrar's screen after the first visit.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

function seeded() {
  const db = openDb(':memory:');
  migrate(db);
  const pat = db.prepare("INSERT INTO patients (full_name) VALUES ('Test Test')").run().lastInsertRowid;
  const s1 = db.prepare("INSERT INTO services (name, price) VALUES ('УЗИ почек', 120000)").run().lastInsertRowid;
  const s2 = db.prepare("INSERT INTO services (name, price) VALUES ('ОАК', 80000)").run().lastInsertRowid;
  const s3 = db.prepare("INSERT INTO services (name, price) VALUES ('Консультация', 50000)").run().lastInsertRowid;
  const req = db.prepare("INSERT INTO crm_requests (full_name, phone, source, patient_id, status) VALUES ('Test Test','+998900000000','call',?, 'scheduled')").run(pat).lastInsertRowid;
  return { db, pat, s1, s2, s3, req };
}

const addLine = (db, req, svc, date, status = 'pending') =>
  db.prepare('INSERT INTO crm_request_services (request_id, service_id, scheduled_date, status) VALUES (?,?,?,?)')
    .run(req, svc, date, status).lastInsertRowid;

// The registrar's prefill: this patient's open lines for THIS day.
function prefill(db, patientId, dayIso) {
  return db.prepare(`
    SELECT l.id, l.service_id, l.request_id
      FROM crm_request_services l
      JOIN crm_requests r ON r.id = l.request_id
     WHERE r.patient_id = ?
       AND l.scheduled_date = ?
       AND l.status = 'pending'
       AND r.status IN ('scheduled','approved','in_process','recall')`).all(patientId, dayIso);
}

test('one request can carry several services, each on its own date', () => {
  const { db, pat, s1, s2, s3, req } = seeded();
  addLine(db, req, s1, '2026-08-20');
  addLine(db, req, s2, '2026-08-21');
  addLine(db, req, s3, '2026-08-20');

  const day20 = prefill(db, pat, '2026-08-20');
  assert.deepEqual(day20.map(l => l.service_id).sort(), [s1, s3].sort(), 'both of the 20th, and only those');
  const day21 = prefill(db, pat, '2026-08-21');
  assert.deepEqual(day21.map(l => l.service_id), [s2]);
  assert.equal(prefill(db, pat, '2026-08-22').length, 0, 'a day with nothing booked stays empty');
  db.close();
});

test('the same date for all services — the bulk control writes one date to every line', () => {
  const { db, pat, s1, s2, s3, req } = seeded();
  for (const s of [s1, s2, s3]) addLine(db, req, s, '2026-08-20');
  assert.equal(prefill(db, pat, '2026-08-20').length, 3);
  db.close();
});

test('a request with lines on three days stays open until the last one is done', () => {
  const { db, pat, s1, s2, s3, req } = seeded();
  const l1 = addLine(db, req, s1, '2026-08-20');
  const l2 = addLine(db, req, s2, '2026-08-21');
  const l3 = addLine(db, req, s3, '2026-08-22');

  // Day 1: the registrar attaches the first service. closeCrmRequests() marks
  // the LINE done and only closes the parent when nothing is pending.
  db.prepare("UPDATE crm_request_services SET status='done' WHERE id=?").run(l1);
  let pending = db.prepare("SELECT COUNT(*) n FROM crm_request_services WHERE request_id=? AND status='pending'").get(req).n;
  assert.equal(pending, 2);
  assert.equal(prefill(db, pat, '2026-08-21').length, 1, 'day 2 must still be waiting');
  assert.equal(prefill(db, pat, '2026-08-22').length, 1, 'and day 3');
  assert.equal(prefill(db, pat, '2026-08-20').length, 0, 'but day 1 is spent');

  db.prepare("UPDATE crm_request_services SET status='done' WHERE id IN (?,?)").run(l2, l3);
  pending = db.prepare("SELECT COUNT(*) n FROM crm_request_services WHERE request_id=? AND status='pending'").get(req).n;
  assert.equal(pending, 0, 'now the parent may close');
  db.close();
});

test('a closed request hides its lines even if one is still pending', () => {
  const { db, pat, s1, req } = seeded();
  addLine(db, req, s1, '2026-08-20');
  db.prepare("UPDATE crm_requests SET status='not_qualified' WHERE id=?").run(req);
  assert.equal(prefill(db, pat, '2026-08-20').length, 0);
  db.close();
});

test('another patient never sees these lines', () => {
  const { db, s1, req } = seeded();
  const other = db.prepare("INSERT INTO patients (full_name) VALUES ('Другой')").run().lastInsertRowid;
  addLine(db, req, s1, '2026-08-20');
  assert.equal(prefill(db, other, '2026-08-20').length, 0);
  db.close();
});

test('cancelling a line removes it from the day without touching the others', () => {
  const { db, pat, s1, s2, req } = seeded();
  const l1 = addLine(db, req, s1, '2026-08-20');
  addLine(db, req, s2, '2026-08-20');
  db.prepare("UPDATE crm_request_services SET status='cancelled' WHERE id=?").run(l1);
  const day = prefill(db, pat, '2026-08-20');
  assert.deepEqual(day.map(l => l.service_id), [s2]);
  db.close();
});

test('057 carries pre-existing single-service requests across', () => {
  // A request written before the migration: service on the PARENT.
  const db = openDb(':memory:');
  migrate(db);
  const pat = db.prepare("INSERT INTO patients (full_name) VALUES ('Old Patient')").run().lastInsertRowid;
  const svc = db.prepare("INSERT INTO services (name, price) VALUES ('Старая услуга', 1000)").run().lastInsertRowid;
  const req = db.prepare("INSERT INTO crm_requests (full_name, phone, source, patient_id, service_id, scheduled_date, status) VALUES ('Old','+998900000000','call',?,?, '2026-08-20','scheduled')").run(pat, svc).lastInsertRowid;

  // Re-run the migration body over the row inserted after migrate().
  db.exec(`INSERT INTO crm_request_services (request_id, service_id, scheduled_date, status)
           SELECT r.id, r.service_id, r.scheduled_date,
                  CASE WHEN r.status='came' THEN 'done'
                       WHEN r.status IN ('no_show','stopped','not_qualified') THEN 'cancelled'
                       ELSE 'pending' END
             FROM crm_requests r
            WHERE r.service_id IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM crm_request_services l WHERE l.request_id = r.id)`);

  const day = prefill(db, pat, '2026-08-20');
  assert.equal(day.length, 1, 'a lead booked before the change must not be lost');
  assert.equal(day[0].service_id, svc);
  assert.ok(req);
  db.close();
});

test('deleting a request takes its lines with it', () => {
  const { db, s1, req } = seeded();
  addLine(db, req, s1, '2026-08-20');
  db.prepare('DELETE FROM crm_requests WHERE id=?').run(req);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM crm_request_services WHERE request_id=?').get(req).n, 0);
  db.close();
});

test('the status column rejects a value the UI never writes', () => {
  const { db, s1, req } = seeded();
  assert.throws(() => addLine(db, req, s1, '2026-08-20', 'bogus'), /CHECK/i);
  db.close();
});
