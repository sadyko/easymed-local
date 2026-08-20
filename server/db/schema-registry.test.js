import test from 'node:test';
import assert from 'node:assert/strict';
import { REGISTRY, tableEntry, canRead, canWrite, readableColumns, writableColumns, filterAllowed, embedEntry } from './schema-registry.js';

test('users registry read columns include extra_roles', () => {
  assert.ok(readableColumns('users').includes('extra_roles'));
});

test('registry denies unknown tables and enforces per-role ops', () => {
  assert.equal(tableEntry('secret_table'), null);
  assert.equal(tableEntry('patients').table, 'patients');
  assert.ok(canRead('patients', 'registrar'));
  assert.ok(canRead('patients', 'doctor'));
  assert.ok(canWrite('patients', 'insert', 'registrar'));
  assert.ok(!canWrite('patients', 'insert', 'doctor'));
  assert.ok(canWrite('patients', 'delete', 'admin'));      // PATIENTS_SECTION_V1 — settings register row delete
  assert.ok(!canWrite('patients', 'delete', 'registrar'));
});

test('readableColumns is an explicit allow-list; filters and embeds are gated', () => {
  const cols = readableColumns('patients');
  assert.ok(cols.includes('full_name'));
  assert.ok(!cols.includes('password_hash'));
  assert.ok(filterAllowed('patients', 'phone'));
  assert.ok(filterAllowed('patients', 'date_of_birth'));   // CRM_V9 — поиск пациента по дате рождения
  assert.ok(!filterAllowed('patients', 'notes'));
  assert.equal(embedEntry('patients', 'branches').fk, 'branch_id');
  assert.equal(embedEntry('patients', 'nonsense'), null);
});

test('visits registry: staff read, registrar can insert, embeds patients + doctor', () => {
  assert.equal(tableEntry('visits').table, 'visits');
  assert.ok(canRead('visits', 'registrar'));
  assert.ok(canWrite('visits', 'insert', 'registrar'));
  assert.ok(canWrite('visits', 'insert', 'doctor'));     // doctors start walk-in consultations (Doctor's room)
  assert.ok(!canWrite('visits', 'insert', 'lab'));       // lab can't book
  assert.ok(!canWrite('visits', 'delete', 'registrar')); // only admin deletes
  assert.equal(embedEntry('visits', 'patients').fk, 'patient_id');
  assert.equal(embedEntry('visits', 'doctor').fk, 'doctor_id');
  assert.equal(embedEntry('visits', 'doctor').table, 'users');
});

test('services registry: routing type column readable and admin-writable', () => {
  assert.ok(readableColumns('services').includes('type'));
  assert.ok(writableColumns('services','insert').includes('type'));
  assert.ok(writableColumns('services','update').includes('type'));
});

test('billing registry: services admin-writable, money tables read-only via /api/db', () => {
  assert.ok(canWrite('services','insert','admin'));
  assert.ok(!canWrite('services','insert','registrar'));
  for (const t of ['invoices','invoice_items','payments']) {
    assert.ok(canRead(t,'cashier'), t+' readable');
    assert.ok(!canWrite(t,'insert','admin'), t+' not insertable via /api/db');
    assert.ok(!canWrite(t,'update','admin'), t+' not updatable via /api/db');
  }
  assert.equal(embedEntry('visit_services','services').fk, 'service_id');
  assert.equal(embedEntry('invoices','patients').fk, 'patient_id');
});

test('labs registry: services lab fields writable by admin; lab_results by lab role', () => {
  assert.ok(readableColumns('services').includes('is_lab'));
  assert.ok(canWrite('services','update','admin'));   // admin edits catalog incl lab fields
  assert.ok(canRead('lab_results','doctor'));
  assert.ok(canWrite('lab_results','insert','lab'));
  assert.ok(!canWrite('lab_results','insert','registrar'));
  assert.ok(canWrite('visit_services','update','lab'));   // lab can flip status
  assert.ok(embedEntry('visit_services','services').columns.includes('is_lab'));
});

test('inventory registry: products catalog-writable but on_hand is not; stock_movements read-only', () => {
  assert.ok(readableColumns('products').includes('on_hand'));
  assert.ok(canWrite('products','insert','inventory'));
  assert.ok(!writableColumns('products','insert').includes('on_hand'));  // stock never client-writable
  assert.ok(!writableColumns('products','update').includes('on_hand'));
  assert.ok(canRead('stock_movements','doctor'));
  assert.ok(!canWrite('stock_movements','insert','admin'));  // RPC-only
  assert.equal(embedEntry('visit_services','products').fk, 'clinic_item_id');
});

test('visit_services line amounts are not client-updatable via /api/db', () => {
  assert.ok(!writableColumns('visit_services','update').includes('quantity'));
  assert.ok(!writableColumns('visit_services','update').includes('unit_price'));
  assert.ok(canWrite('visit_services','update','doctor'));  // status/doctor_id still updatable
});

test('visits conclusion is doctor/admin-writable and readable', () => {
  assert.ok(readableColumns('visits').includes('conclusion'));
  assert.ok(writableColumns('visits','update').includes('conclusion'));
  assert.ok(canWrite('visits','update','doctor'));
  assert.ok(canWrite('visits','update','admin'));
});

test('products unit-engine columns are writable; avg_cost is not', () => {
  assert.ok(writableColumns('products','update').includes('pack_factor'));
  assert.ok(writableColumns('products','update').includes('procurement_category'));
  assert.ok(!writableColumns('products','update').includes('avg_cost'));
  assert.ok(!writableColumns('products','update').includes('on_hand'));
  assert.ok(readableColumns('products').includes('avg_cost'));
});

test('doc_settings: staff read, admin-only update, no insert/delete', () => {
  assert.ok(canRead('doc_settings','registrar'));
  assert.ok(canWrite('doc_settings','update','admin'));
  assert.ok(!canWrite('doc_settings','update','registrar'));
  assert.ok(!canWrite('doc_settings','insert','admin'));
  assert.ok(readableColumns('doc_settings').includes('logo_data_url'));
});

test('settings-section tables: admin-writable config, staff read, room/bed FK embeds', () => {
  for (const t of ['departments','service_types','consultation_types','patient_categories','floors','rooms','wards','beds']) {
    assert.ok(canRead(t,'registrar'), t+' readable');
    assert.ok(canWrite(t,'insert','admin'), t+' admin-writable');
    assert.ok(!canWrite(t,'insert','registrar'), t+' not registrar-writable');
    assert.ok(!canWrite(t,'delete','admin'), t+' no delete');
  }
  assert.equal(embedEntry('rooms','floors').fk, 'floor_id');
  assert.equal(embedEntry('beds','wards').fk, 'ward_id');
});

test('settings-match tables: admin config, FK embeds, api_tokens admin-read-only', () => {
  for (const t of ['payer_policies','payment_providers','cashback_rules','referral_source_categories','referral_rewards','patient_discounts','doctor_rates']) {
    assert.ok(canRead(t,'registrar'), t+' staff-readable');
    assert.ok(canWrite(t,'insert','admin'), t+' admin-writable');
    assert.ok(!canWrite(t,'insert','registrar'), t+' not registrar-writable');
  }
  assert.ok(!canRead('api_tokens','registrar'));   // tokens admin-only
  assert.ok(canRead('api_tokens','admin'));
  assert.equal(embedEntry('payer_policies','payers').fk, 'payer_id');
  assert.equal(embedEntry('doctor_rates','users').fk, 'doctor_id');
  assert.equal(embedEntry('doctor_rates','services').fk, 'service_id');
});

test('clinical-spine tables: all doctor-readable + key write roles wired', () => {
  const CLINICAL = [
    'recommended_services', 'visit_documents', 'patient_vitals', 'patient_conditions',
    'patient_guardians', 'patient_deposits', 'consultation_templates',
    'doctor_consultation_prices', 'invoice_audit_log', 'service_queue_tickets',
  ];
  for (const t of CLINICAL) {
    assert.ok(tableEntry(t), t + ' registered');
    assert.ok(canRead(t, 'doctor'), t + ' doctor-readable');
    assert.ok(canRead(t, 'nurse'), t + ' staff-readable');
    // every read column is also individually addressable
    assert.ok(readableColumns(t).includes('id'), t + ' exposes id');
    assert.ok(readableColumns(t).includes('created_at'), t + ' exposes created_at');
  }
  // spot-check that the write matrix matches each table's real actors
  assert.ok(canWrite('recommended_services', 'insert', 'doctor'));   // doctors order referrals
  assert.ok(canWrite('patient_conditions', 'insert', 'doctor'));     // dx sync from the workspace
  assert.ok(canWrite('patient_guardians', 'insert', 'registrar'));   // written at registration
  assert.ok(canWrite('patient_deposits', 'insert', 'cashier'));      // cashier accepts deposits
  assert.ok(canWrite('consultation_templates', 'insert', 'doctor')); // doctor owns SOAP templates
  assert.ok(canWrite('doctor_consultation_prices', 'insert', 'admin'));
  assert.ok(canWrite('invoice_audit_log', 'insert', 'cashier'));     // cashier logs invoice actions
  assert.ok(!canWrite('invoice_audit_log', 'update', 'admin'));      // append-only audit trail
  // filter/order columns the frontend needs are allow-listed
  assert.ok(filterAllowed('patient_deposits', 'notes'));             // .ilike('notes', …) idempotency guard
  assert.ok(filterAllowed('recommended_services', 'recommended_by'));
  assert.ok(readableColumns('patient_vitals').includes('recorded_at'));   // .order('recorded_at')
  assert.ok(readableColumns('consultation_templates').includes('updated_at')); // .order('updated_at')
  // embeds declared where the frontend joins on these tables
  assert.equal(embedEntry('recommended_services', 'services').fk, 'service_id');
  assert.equal(embedEntry('recommended_services', 'patients').fk, 'patient_id');
  assert.equal(embedEntry('patient_deposits', 'patients').fk, 'patient_id');
});

test('inpatient + lab-panel tables (025): staff read, correct write actors', () => {
  const INPATIENT = ['admission_services', 'admission_transfers', 'admission_prescriptions', 'med_administrations'];
  const LAB = ['lab_panels', 'lab_panel_analytes'];
  for (const t of [...INPATIENT, ...LAB]) {
    assert.ok(tableEntry(t), t + ' registered');
    assert.ok(canRead(t, 'nurse'), t + ' nurse-readable');
    assert.ok(canRead(t, 'lab'), t + ' lab-readable');
    assert.ok(readableColumns(t).includes('id'), t + ' exposes id');
    assert.ok(readableColumns(t).includes('created_at'), t + ' exposes created_at');
    assert.ok(filterAllowed(t, 'id'), t + ' filters id');
  }
  // nurses run the inpatient screens (bed board / admission modal)
  assert.ok(canWrite('admission_prescriptions', 'insert', 'nurse'));
  assert.ok(canWrite('med_administrations', 'insert', 'nurse'));
  assert.ok(canWrite('admission_services', 'insert', 'nurse'));
  assert.ok(canWrite('admission_transfers', 'insert', 'nurse'));
  assert.ok(!canWrite('admission_prescriptions', 'insert', 'lab'));   // lab has no place in inpatient orders
  // lab role owns the panel catalog (lab-settings.js); nurses do not
  assert.ok(canWrite('lab_panels', 'insert', 'lab'));
  assert.ok(canWrite('lab_panel_analytes', 'insert', 'lab'));
  assert.ok(canWrite('lab_panel_analytes', 'delete', 'lab'));         // save = delete-then-insert reconcile
  assert.ok(!canWrite('lab_panels', 'insert', 'nurse'));
  // main filtered FKs are allow-listed for the query layer
  assert.ok(filterAllowed('admission_services', 'admission_id'));
  assert.ok(filterAllowed('admission_transfers', 'admission_id'));
  assert.ok(filterAllowed('lab_panel_analytes', 'panel_id'));
  // admission_services embeds the joins the bed board selects
  assert.equal(embedEntry('admission_services', 'services').fk, 'service_id');
  assert.equal(embedEntry('admission_services', 'products').fk, 'clinic_item_id');
  assert.equal(embedEntry('med_administrations', 'patients').fk, 'patient_id');
});

test('staff/RBAC/branch config tables (026): staff read, admin write, correct extras', () => {
  const STAFF_CONFIG = [
    'roles', 'user_branches', 'user_specialties', 'positions',
    'virtual_doctors', 'doctor_conditions', 'companies',
  ];
  for (const t of STAFF_CONFIG) {
    assert.ok(tableEntry(t), t + ' registered');
    assert.ok(canRead(t, 'registrar'), t + ' staff-readable');
    assert.ok(readableColumns(t).includes('id'), t + ' exposes id');
    assert.ok(readableColumns(t).includes('created_at'), t + ' exposes created_at');
    assert.ok(filterAllowed(t, 'id'), t + ' filters id');
    assert.ok(canWrite(t, 'insert', 'admin'), t + ' admin-insertable');
    assert.ok(canWrite(t, 'delete', 'admin'), t + ' admin-deletable');
    assert.ok(!canWrite(t, 'insert', 'registrar'), t + ' not registrar-writable');
  }
  // roles is the dynamic-RBAC table (separate from role_permissions); permissions JSON is read+written
  assert.ok(readableColumns('roles').includes('permissions'));
  assert.ok(writableColumns('roles', 'insert').includes('permissions'));
  // doctor edits their own saved conditions/quick-picks (doctor-profile.js self-edit)
  assert.ok(canWrite('doctor_conditions', 'insert', 'doctor'));
  assert.ok(canWrite('doctor_conditions', 'delete', 'doctor'));   // save = delete-then-insert reconcile
  assert.ok(!canWrite('user_specialties', 'insert', 'doctor'));   // specialty assignment is admin staff-management
  // junction main FKs are allow-listed for the query layer
  assert.ok(filterAllowed('user_branches', 'user_id'));
  assert.ok(filterAllowed('user_specialties', 'user_id'));
  assert.ok(filterAllowed('doctor_conditions', 'doctor_id'));
  assert.ok(filterAllowed('positions', 'department_id'));
  // branch-context.js selects the embedded branch on the junction
  assert.equal(embedEntry('user_branches', 'branches').fk, 'branch_id');
});

test('reference/catalog tables (027): staff read, admin-only writes, key filters', () => {
  const REFERENCE = [
    'service_categories', 'ikpu_codes', 'product_nnm', 'countries', 'regions',
    'districts', 'icd10', 'units', 'tariffs', 'service_templates',
  ];
  for (const t of REFERENCE) {
    assert.ok(tableEntry(t), t + ' registered');
    assert.ok(canRead(t, 'registrar'), t + ' registrar-readable');   // dropdown sources
    assert.ok(canRead(t, 'doctor'), t + ' doctor-readable');
    assert.ok(readableColumns(t).includes('id'), t + ' exposes id');
    assert.ok(readableColumns(t).includes('created_at'), t + ' exposes created_at');
    assert.ok(filterAllowed(t, 'id'), t + ' filters id');
    // catalog/reference config → admin owns every write, no one else
    assert.ok(canWrite(t, 'insert', 'admin'), t + ' admin-insertable');
    assert.ok(canWrite(t, 'update', 'admin'), t + ' admin-updatable');
    assert.ok(canWrite(t, 'delete', 'admin'), t + ' admin-deletable');
    // WIZ_TEMPLATES_REGISTRAR_V1 — service_templates is the one exception, and
    // it is deliberate: unlike the other nine it is not clinic configuration but
    // a working aid the REGISTRAR creates from the смета they just built. Every
    // other reference table keeps the admin-only rule, asserted here as before.
    if (t !== 'service_templates') {
      assert.ok(!canWrite(t, 'insert', 'registrar'), t + ' not registrar-writable');
    }
  }
  // The carve-out, stated in full so it cannot widen by accident.
  assert.ok(canWrite('service_templates', 'insert', 'registrar'), 'registrar saves a смета as a template');
  assert.ok(canWrite('service_templates', 'update', 'registrar'), 'registrar retires a template (active = 0)');
  assert.ok(!canWrite('service_templates', 'delete', 'registrar'), 'hard delete stays admin-only');
  assert.ok(!canWrite('service_templates', 'insert', 'cashier'), 'the grant is for the registrar alone');
  assert.ok(!canWrite('service_templates', 'insert', 'doctor'), 'the grant is for the registrar alone');
  // countries write matrix (spot-check the admin-only rule)
  assert.ok(canWrite('countries', 'insert', 'admin'));
  assert.ok(!canWrite('countries', 'insert', 'registrar'));
  // geo cascade FKs are allow-listed for the registration country→region→district filter chain
  assert.ok(filterAllowed('regions', 'country_id'));
  assert.ok(filterAllowed('districts', 'region_id'));
  assert.ok(filterAllowed('service_categories', 'parent_id'));   // self-nesting tree
  assert.ok(filterAllowed('product_nnm', 'ikpu_code_id'));
  // tariffs uses is_active/visible_in_modal (no `active` column) — its real filters
  assert.ok(filterAllowed('tariffs', 'is_active'));
  assert.ok(filterAllowed('tariffs', 'visible_in_modal'));
  // no direct embeds are selected on these tables in the frontend
  assert.equal(embedEntry('regions', 'countries'), null);
});

test('role_permissions: staff-readable, admin-write-only, role update-locked', () => {
  assert.ok(canRead('role_permissions','registrar'), 'staff can read their role row');
  assert.ok(canRead('role_permissions','admin'));
  assert.ok(canWrite('role_permissions','insert','admin'));
  assert.ok(canWrite('role_permissions','update','admin'));
  assert.ok(!canWrite('role_permissions','update','registrar'), 'non-admin cannot edit permissions');
  assert.ok(!writableColumns('role_permissions','update').includes('role'), 'role name is not update-editable');
  assert.ok(writableColumns('role_permissions','update').includes('permissions'));
});

// LAB_TEMPLATES_V1 — the seeded catalogue is reference content, not clinic data.
// Readable by anyone who can open the lab settings; writable by nobody, because
// it changes only by migration and importing COPIES it into the clinic's own
// lab_panels / lab_panel_analytes.
test('the lab template catalogue is readable by staff and writable by no one', () => {
  for (const t of ['lab_panel_templates', 'lab_panel_template_analytes']) {
    assert.ok(canRead(t, 'lab'), t + ' readable by the lab');
    assert.ok(canRead(t, 'registrar'), t + ' readable by staff');
    for (const role of ['admin', 'lab', 'registrar', 'doctor']) {
      for (const op of ['insert', 'update', 'delete']) {
        assert.equal(canWrite(t, op, role), false, `${role} must not ${op} ${t}`);
      }
    }
  }
  assert.ok(readableColumns('lab_panel_templates').includes('category'), 'category drives the catalogue browser');
  assert.ok(filterAllowed('lab_panel_templates', 'category'), 'and can be filtered on');
  assert.ok(filterAllowed('lab_panel_template_analytes', 'template_id'), 'indicators are fetched per template');
});

test('services.type is filterable, so "the lab services" is one query', () => {
  assert.ok(filterAllowed('services', 'type'), 'type can be filtered on');
  assert.ok(readableColumns('services').includes('type'), 'and it was already readable');
});
