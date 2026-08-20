import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { compile } from '../query-compiler.js';
import { reshape } from '../../routes/db.js';
import { RPC } from '../../services/rpc/index.js';

const ADMIN = { id: 1, role: 'admin' };
const DOCTOR = { id: 2, role: 'doctor' };

function freshDb() { const db = openDb(':memory:'); migrate(db); return db; }

// Seed the whole clinical context the My-services queue joins across.
function seedWorkspace(db) {
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_active, is_doctor, specialty) VALUES (1,'admin','x','Admin','admin',1,0,'')").run();
  db.prepare("INSERT INTO floors (id, name, level) VALUES (1,'2 этаж',2)").run();
  db.prepare("INSERT INTO rooms (id, name, floor_id) VALUES (1,'Каб. 204',1)").run();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_active, is_doctor, specialty, room_id) VALUES (2,'doc','x','Др. Азиза','doctor',1,1,'Терапевт',1)").run();
  db.prepare("INSERT INTO departments (id, name, kind) VALUES (101,'Терапия','clinical')").run();
  // SERVICE_GROUPS_V1 — id 901, not 1: migration 056 now seeds the six canonical
  // service_types on a fresh database (they were absent before, which is why a
  // whole catalogue could end up with type_id NULL). This fixture must not
  // assume the table starts empty. The name stays distinct from the seeded six
  // so the embed assertion below still proves it read THIS row.
  db.prepare("INSERT INTO service_types (id, name) VALUES (901,'Консультация')").run();
  db.prepare("INSERT INTO services (id, name, price, type, duration_minutes, type_id, department_id) VALUES (1,'Приём терапевта',50000,'consultation',30,901,101)").run();
  db.prepare("INSERT INTO consultation_types (id, name, name_ru, name_uz, price) VALUES (1,'Первичный','Первичный','Birlamchi',50000)").run();
  db.prepare("INSERT INTO patients (id, mrn, full_name, first_name, last_name, phone) VALUES (1,'P-26-00001','Иванов Иван','Иван','Иванов','+998901112233')").run();
  db.prepare("INSERT INTO visits (id, patient_id, doctor_id, visit_date, status) VALUES (1,1,2,'2026-08-07T09:00:00Z','confirmed')").run();
  db.prepare("INSERT INTO visit_services (id, visit_id, service_id, doctor_id, quantity, unit_price, total, status, consultation_type_id) VALUES (1,1,1,2,1,50000,50000,'queued',1)").run();
  db.prepare("INSERT INTO products (id, name, unit, sale_price, on_hand, active) VALUES (1,'Парацетамол','таб',1000,50,1)").run();
  return db;
}

test('032 schema: new columns + active mirror + admissions requested', () => {
  const db = freshDb();
  // table_xinfo, not table_info: the generated `active` mirror is a hidden
  // (h2) column and plain table_info omits it.
  const ucols = db.prepare('PRAGMA table_xinfo(users)').all().map((c) => c.name);
  for (const c of ['kpi_links', 'room_id', 'active']) assert.ok(ucols.includes(c), 'users.' + c);
  const scols = db.prepare('PRAGMA table_info(services)').all().map((c) => c.name);
  for (const c of ['type_id', 'category_id', 'department_id']) assert.ok(scols.includes(c), 'services.' + c);
  assert.ok(db.prepare('PRAGMA table_info(consultation_types)').all().some((c) => c.name === 'sort_order'));
  assert.ok(db.prepare('PRAGMA table_info(lab_results)').all().some((c) => c.name === 'parameter'));
  assert.ok(db.prepare('PRAGMA table_info(visit_services)').all().some((c) => c.name === 'consultation_type_id'));

  // active mirrors is_active both ways, read-only
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_active) VALUES (9,'u','x','U','doctor',1)").run();
  assert.equal(db.prepare('SELECT active FROM users WHERE id=9').get().active, 1);
  db.prepare('UPDATE users SET is_active=0 WHERE id=9').run();
  assert.equal(db.prepare('SELECT active FROM users WHERE id=9').get().active, 0);

  // admissions: 'requested' allowed, indexes recreated
  db.prepare("INSERT INTO patients (id, full_name) VALUES (1,'P')").run();
  db.prepare("INSERT INTO admissions (patient_id, status) VALUES (1,'requested')").run();
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='admissions'").all().map((r) => r.name);
  assert.ok(idx.includes('idx_admissions_status') && idx.includes('idx_admissions_bed'));
});

test('032 nested embeds: the REAL My-services queue query runs and reshapes 3 levels deep', () => {
  const db = seedWorkspace(freshDb());
  // consultation.js lines 87-97, verbatim column string.
  const c = compile({ table: 'visit_services', op: 'select', columns: `
            id, status, quantity, unit_price, total, created_at, invoice_item_id,
            visit_id, service_id, doctor_id, consultation_type_id,
            services(name, type, duration_minutes, service_types(name), departments(kind)),
            consultation_types(name_ru, name_uz),
            users:doctor_id(full_name, specialty, rooms(name, floors(name))),
            visits(visit_date, patient_id,
                   patients(full_name, last_name, first_name, mrn, phone))
        `, filters: [{ col: 'status', op: 'in', val: ['added', 'queued', 'in_progress', 'completed'] }] }, DOCTOR);
  const rows = reshape(db.prepare(c.sql).all(...c.params), c.meta);
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.services.name, 'Приём терапевта');
  assert.equal(r.services.service_types.name, 'Консультация');
  assert.equal(r.services.departments.kind, 'clinical');
  assert.equal(r.consultation_types.name_ru, 'Первичный');
  assert.equal(r.users.full_name, 'Др. Азиза');                    // aliased users:doctor_id
  assert.equal(r.users.rooms.name, 'Каб. 204');                    // level 2
  assert.equal(r.users.rooms.floors.name, '2 этаж');               // level 3
  assert.equal(r.visits.patients.mrn, 'P-26-00001');
});

test('032 nested embeds: LEFT JOIN miss collapses the whole subtree to null', () => {
  const db = seedWorkspace(freshDb());
  db.prepare('UPDATE users SET room_id=NULL WHERE id=2').run();    // doctor has no cabinet
  db.prepare('UPDATE visit_services SET consultation_type_id=NULL WHERE id=1').run();
  const c = compile({ table: 'visit_services', op: 'select',
    columns: 'id, consultation_types(name_ru), users:doctor_id(full_name, rooms(name, floors(name)))',
    filters: [{ col: 'id', op: 'eq', val: 1 }] }, DOCTOR);
  const r = reshape(db.prepare(c.sql).all(...c.params), c.meta)[0];
  assert.equal(r.consultation_types, null);                        // absent to-one -> null
  assert.equal(r.users.rooms, null);                               // nested miss -> null, parent survives
  assert.equal(r.users.full_name, 'Др. Азиза');
});

test('032 compile-check: every other literal query the two doctor views issue', () => {
  const queries = [
    // consultation.js dash (1189-1200)
    { table: 'visit_services', columns: `
            id, status, quantity, unit_price, total, created_at, invoice_item_id,
            visit_id, service_id,
            services(name, tax_rate, type_id, category_id, service_categories(name), service_types(name)),
            visits(visit_date, patient_id,
                   patients(full_name, last_name, first_name, mrn))
        `, filters: [{ col: 'doctor_id', op: 'eq', val: 2 }, { col: 'created_at', op: 'gte', val: '2026-08-01' }] },
    // consultation.js loadDoctorsForDash (1151-1154)
    { table: 'users', columns: 'id, full_name, is_doctor, specialty, role, salary_type, salary_fixed, salary_percent, doctor_category, kpi_links, service_rates, referral_rates, license_expiry_date',
      filters: [{ col: 'active', op: 'eq', val: true }] },
    // service-workspace: dispensed lines + doctor phone + type/dept + recommendations
    { table: 'visit_services', columns: 'id, quantity, unit_price, invoice_item_id, clinic_item_id, clinic_items(name, unit)', filters: [{ col: 'visit_id', op: 'eq', val: 1 }] },
    { table: 'visit_services', columns: 'services(service_types(name), departments(kind))', filters: [{ col: 'id', op: 'eq', val: 1 }] },
    { table: 'users', columns: 'phone', filters: [{ col: 'id', op: 'eq', val: 2 }] },
    { table: 'recommended_services', columns: '*, services(name, price), users:recommended_by(full_name, specialty)', filters: [{ col: 'patient_id', op: 'eq', val: 1 }] },
    { table: 'consultation_types', columns: 'id, name_ru, name_uz, sort_order, active', filters: [{ col: 'active', op: 'eq', val: true }] },
    { table: 'doctor_consultation_prices', columns: 'consultation_type_id, price, is_free, available, name_ru, name_uz', filters: [{ col: 'doctor_id', op: 'eq', val: 2 }] },
    { table: 'lab_results', columns: 'parameter, value, unit, reference_range, flag', filters: [{ col: 'visit_service_id', op: 'eq', val: 1 }] },
    { table: 'visit_documents', columns: 'id, title, doc_type, created_at, file_path', filters: [{ col: 'patient_id', op: 'eq', val: 1 }] },
    { table: 'patient_vitals', columns: 'bp_sys,bp_dia,pulse_bpm,temp_c,spo2,resp_rate,weight_kg,recorded_at', filters: [{ col: 'patient_id', op: 'eq', val: 1 }] },
    { table: 'patient_conditions', columns: '*', filters: [{ col: 'patient_id', op: 'eq', val: 1 }] },
    { table: 'visits', columns: 'visit_date, duration_minutes, status', filters: [{ col: 'patient_id', op: 'eq', val: 1 }] },
  ];
  const db = seedWorkspace(freshDb());
  for (const q of queries) {
    const c = compile({ op: 'select', ...q }, DOCTOR);
    assert.doesNotThrow(() => db.prepare(c.sql).all(...c.params), q.table + ' executes');
  }
});

test('032 RPC aliases: dispense_visit_item / void_dispensed_visit_item (easymed p_* args)', () => {
  const db = seedWorkspace(freshDb());
  const res = RPC.dispense_visit_item(db, { p_visit_id: 1, p_item_id: 1, p_qty: 3, p_doctor_id: 2 }, DOCTOR);
  assert.equal(res.item_name, 'Парацетамол');
  assert.equal(res.on_hand, 47);
  assert.ok(res.visit_service_id);
  // doctor may void the not-yet-invoiced line (VOID_ROLES includes doctor)
  const v = RPC.void_dispensed_visit_item(db, { p_line: res.visit_service_id }, DOCTOR);
  assert.equal(v.on_hand, 50);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM visit_services WHERE clinic_item_id IS NOT NULL').get().n, 0);
});

test('032 RPC alias: request_admission creates a bed-less requested admission, one per patient', () => {
  const db = seedWorkspace(freshDb());
  const { admission } = RPC.request_admission(db, { p_patient_id: 1, p_doctor_id: 2, p_pathway: 'therapy', p_chief_complaint: 'Боли', p_diagnosis: 'J06.9' }, DOCTOR);
  assert.equal(admission.status, 'requested');
  assert.equal(admission.bed_id, null);
  assert.match(admission.admission_no, /^ADM-\d{5}$/);
  assert.equal(admission.admission_diagnosis, 'J06.9');
  assert.throws(() => RPC.request_admission(db, { p_patient_id: 1, p_pathway: 'therapy' }, DOCTOR), /pending admission request/);
});
