// CRM_LINE_DOCTOR_V1 — the doctor belongs on the booking.
//
// A service with requires_doctor = 1 is filtered OUT of the wizard's смета until
// a doctor is chosen (visibleCart() in visit-wizard.js). So a call-centre
// booking that names only the service and the date arrives at the registrar as
// an invisible line — the prefill "worked" and nothing appeared. Storing the
// doctor alongside the service is what closes that gap.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

function seeded() {
  const db = openDb(':memory:');
  migrate(db);
  const pat = db.prepare("INSERT INTO patients (full_name) VALUES ('Test Test')").run().lastInsertRowid;
  const doc = db.prepare("INSERT INTO users (username, password_hash, full_name, role, is_doctor, specialty) VALUES ('doc','x','Юсупов А.','doctor',1,'Кардиология')").run().lastInsertRowid;
  const needsDoc = db.prepare("INSERT INTO services (name, price, requires_doctor) VALUES ('Консультация кардиолога', 120000, 1)").run().lastInsertRowid;
  const noDoc    = db.prepare("INSERT INTO services (name, price, requires_doctor) VALUES ('ОАК', 80000, 0)").run().lastInsertRowid;
  const req = db.prepare("INSERT INTO crm_requests (full_name, phone, source, patient_id, status) VALUES ('Test Test','+998900000000','call',?, 'scheduled')").run(pat).lastInsertRowid;
  return { db, pat, doc, needsDoc, noDoc, req };
}

test('the doctor is stored on the booked line', () => {
  const { db, doc, needsDoc, req } = seeded();
  db.prepare('INSERT INTO crm_request_services (request_id, service_id, scheduled_date, doctor_id, status) VALUES (?,?,?,?,?)')
    .run(req, needsDoc, '2026-08-20', doc, 'pending');
  const row = db.prepare('SELECT doctor_id FROM crm_request_services WHERE request_id=?').get(req);
  assert.equal(row.doctor_id, doc);
  db.close();
});

test('a service that needs no doctor stores NULL, and that is valid', () => {
  const { db, noDoc, req } = seeded();
  db.prepare('INSERT INTO crm_request_services (request_id, service_id, scheduled_date, doctor_id, status) VALUES (?,?,?,?,?)')
    .run(req, noDoc, '2026-08-20', null, 'pending');
  const row = db.prepare('SELECT doctor_id FROM crm_request_services WHERE request_id=?').get(req);
  assert.equal(row.doctor_id, null);
  db.close();
});

// The prefill reads the doctor back with the line — this is the join the wizard
// needs to set line.doctorId, without which the service never reaches the смета.
test('the registrar prefill carries the doctor with the service', () => {
  const { db, pat, doc, needsDoc, req } = seeded();
  db.prepare('INSERT INTO crm_request_services (request_id, service_id, scheduled_date, doctor_id, status) VALUES (?,?,?,?,?)')
    .run(req, needsDoc, '2026-08-20', doc, 'pending');

  const line = db.prepare(`
    SELECT l.service_id, l.doctor_id, s.requires_doctor, u.full_name AS doctor_name
      FROM crm_request_services l
      JOIN crm_requests r ON r.id = l.request_id
      JOIN services s ON s.id = l.service_id
      LEFT JOIN users u ON u.id = l.doctor_id
     WHERE r.patient_id = ? AND l.scheduled_date = ? AND l.status='pending'`).get(pat, '2026-08-20');

  assert.equal(line.requires_doctor, 1);
  assert.equal(line.doctor_id, doc);
  assert.equal(line.doctor_name, 'Юсупов А.', 'the registrar sees who the patient was promised');
  db.close();
});

test('a doctor-requiring line booked WITHOUT a doctor is detectable', () => {
  // The UI refuses to save this, but a legacy line (booked before 058) can look
  // like it — the registrar must be able to tell, not silently lose the service.
  const { db, pat, needsDoc, req } = seeded();
  db.prepare('INSERT INTO crm_request_services (request_id, service_id, scheduled_date, doctor_id, status) VALUES (?,?,?,?,?)')
    .run(req, needsDoc, '2026-08-20', null, 'pending');
  const orphan = db.prepare(`
    SELECT COUNT(*) n FROM crm_request_services l
      JOIN crm_requests r ON r.id = l.request_id
      JOIN services s ON s.id = l.service_id
     WHERE r.patient_id = ? AND s.requires_doctor = 1 AND l.doctor_id IS NULL AND l.status='pending'`).get(pat).n;
  assert.equal(orphan, 1);
  db.close();
});

test('deleting the doctor does not delete the booking', () => {
  const { db, doc, needsDoc, req } = seeded();
  db.prepare('INSERT INTO crm_request_services (request_id, service_id, scheduled_date, doctor_id, status) VALUES (?,?,?,?,?)')
    .run(req, needsDoc, '2026-08-20', doc, 'pending');
  // users has no ON DELETE CASCADE here — the FK simply refuses, which is the
  // safe outcome: a booking must not vanish because staff changed.
  assert.throws(() => db.prepare('DELETE FROM users WHERE id=?').run(doc), /FOREIGN KEY/i);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM crm_request_services').get().n, 1);
  db.close();
});
