import test from 'node:test';
import assert from 'node:assert/strict';
import { compile, CompileError } from './query-compiler.js';
import { openDb } from './connection.js';
import { migrate } from './migrate.js';

const asRegistrar = { role: 'registrar', id: 1 };

test('select expands * to declared columns and binds filters', () => {
  const { sql, params } = compile({ table:'patients', op:'select', columns:'*',
    filters:[{col:'branch_id',op:'eq',val:1}], order:[{col:'created_at',asc:false}], limit:20 }, asRegistrar);
  assert.match(sql, /^SELECT /);
  assert.doesNotMatch(sql, /\*/);
  assert.match(sql, /WHERE "patients"\."branch_id" = \?/);
  assert.match(sql, /ORDER BY "created_at" DESC/);
  assert.match(sql, /LIMIT 20/);
  assert.deepEqual(params, [1]);
});

test('unknown table, column, filter, op, or role are rejected', () => {
  assert.throws(() => compile({table:'secrets',op:'select',columns:'*'}, asRegistrar), CompileError);
  assert.throws(() => compile({table:'patients',op:'select',columns:'ssn'}, asRegistrar), /column/);
  assert.throws(() => compile({table:'patients',op:'select',columns:'*',filters:[{col:'notes',op:'eq',val:'x'}]}, asRegistrar), /filter/);
  assert.throws(() => compile({table:'patients',op:'select',columns:'*',filters:[{col:'id',op:'evil',val:1}]}, asRegistrar), /operator/);
  assert.throws(() => compile({table:'patients',op:'insert',values:{full_name:'x'}}, {role:'doctor'}), /not allowed/);
});

test('insert keeps only writable columns and drops extras', () => {
  const asRegistrar = { role:'registrar', id:1 };
  const { sql, params } = compile({table:'patients',op:'insert',values:{full_name:'Ann',phone:'123'},returning:true}, asRegistrar);
  assert.match(sql, /INSERT INTO "patients"/);
  assert.ok(params.includes('Ann') && params.includes('123'));
  // an extra/unknown key is silently dropped, not thrown, and not present in SQL
  const dropped = compile({table:'patients',op:'insert',values:{full_name:'Ann',telegram_opt_in:true,id:99}}, asRegistrar);
  assert.doesNotMatch(dropped.sql, /telegram_opt_in|"id"/);
  assert.match(dropped.sql, /"full_name"/);
  // but an all-unknown payload → 400
  assert.throws(() => compile({table:'patients',op:'insert',values:{telegram_opt_in:true}}, asRegistrar), /no writable columns/);
});

test('update drops non-writable keys and still requires a filter', () => {
  const asRegistrar = { role:'registrar', id:1 };
  const { sql } = compile({table:'patients',op:'update',values:{phone:'9',created_at:'x',bogus:1},filters:[{col:'id',op:'eq',val:3}]}, asRegistrar);
  assert.match(sql, /"phone" = \?/);
  assert.doesNotMatch(sql, /created_at = |"bogus"/);   // created_at not writable, bogus unknown
  assert.throws(() => compile({table:'patients',op:'update',values:{bogus:1},filters:[{col:'id',op:'eq',val:3}]}, asRegistrar), /no writable columns/);
});

test('update and delete REQUIRE a filter (no mass mutation)', () => {
  assert.throws(() => compile({table:'patients',op:'update',values:{phone:'9'}}, asRegistrar), /filter/);
  const ok = compile({table:'patients',op:'update',values:{phone:'9'},filters:[{col:'id',op:'eq',val:3}]}, asRegistrar);
  assert.match(ok.sql, /UPDATE "patients" SET/);
  assert.match(ok.sql, /WHERE "id" = \?/);
  // PATIENTS_SECTION_V1 — admin delete is now allowed (Settings → Пациенты row
  // delete); a registrar still can't, and a delete still REQUIRES a filter.
  assert.throws(() => compile({table:'patients',op:'delete',filters:[{col:'id',op:'eq',val:3}]}, asRegistrar), /not allowed/);
  assert.throws(() => compile({table:'patients',op:'delete'}, {role:'admin'}), /filter/);
  assert.match(compile({table:'patients',op:'delete',filters:[{col:'id',op:'eq',val:3}]}, {role:'admin'}).sql, /DELETE FROM "patients"/);
});

test('embedded select uses a declared join only', () => {
  const { sql } = compile({table:'patients',op:'select',columns:'id,full_name,branches(name)'}, asRegistrar);
  assert.match(sql, /LEFT JOIN "branches"/);
  assert.throws(() => compile({table:'patients',op:'select',columns:'id,evil(secret)'}, asRegistrar), /embed/);
});

test('in / ilike / gte operators compile with correct SQL and params', () => {
  const r = compile({table:'patients',op:'select',columns:'id',filters:[
    {col:'id',op:'in',val:[1,2,3]}, {col:'full_name',op:'ilike',val:'%an%'}, {col:'created_at',op:'gte',val:'2026-01-01'}]}, asRegistrar);
  assert.match(r.sql, /"id" IN \(\?, ?\?, ?\?\)/);
  // CYRILLIC_ILIKE_V1 — ilike wraps both sides in the Unicode lower UDF
  assert.match(r.sql, /lower_uni\("patients"\."full_name"\) LIKE lower_uni\(\?\)/i);
  assert.match(r.sql, /"created_at" >= \?/);
  assert.deepEqual(r.params, [1,2,3,'%an%','2026-01-01']);
});

test('prototype-chain names for op and embed are rejected, not executed', () => {
  const asRegistrar = { role:'registrar', id:1 };
  assert.throws(() => compile({table:'patients',op:'select',columns:'*',filters:[{col:'id',op:'constructor',val:1}]}, asRegistrar), /operator/);
  assert.throws(() => compile({table:'patients',op:'select',columns:'*',filters:[{col:'id',op:'toString',val:1}]}, asRegistrar), /operator/);
  assert.throws(() => compile({table:'patients',op:'select',columns:'id,constructor(x)'}, asRegistrar), /embed/);
  assert.throws(() => compile({table:'patients',op:'select',columns:'id,__proto__(x)'}, asRegistrar), /embed/);
});

test('malformed input types are clean 400s, not crashes', () => {
  const u = { role:'registrar', id:1 };
  assert.throws(() => compile({table:'patients',op:'select',columns:'*',filters:{}}, u), /array/);
  assert.throws(() => compile({table:'patients',op:'select',columns:'*',order:'created_at'}, u), /array/);
  assert.throws(() => compile({table:'patients',op:'select',columns:'*',filters:[{col:'id',op:'eq',val:{a:1}}]}, u), /value type/);
  assert.throws(() => compile({table:'patients',op:'insert',values:{full_name:{a:1}}}, u), /value type/);
  assert.throws(() => compile({table:'patients',op:'select',columns:'*',limit:-1}, u), /limit/);
  assert.throws(() => compile({table:'patients',op:'select',columns:'*',limit:1e21}, u), /limit/);
});

test('boolean filter values bind as 0/1', () => {
  const { params } = compile({table:'patients',op:'select',columns:'id',filters:[{col:'active',op:'eq',val:true}]}, { role:'registrar', id:1 });
  assert.deepEqual(params, [1]);
});

test('embedded select executes and returns nested objects (no ambiguous column)', () => {
  const db = openDb(':memory:'); migrate(db);
  db.prepare("INSERT INTO patients (full_name, branch_id) VALUES ('Ann', 1)").run();
  const asRegistrar = { role:'registrar', id:1 };
  const { sql, params, meta } = compile({ table:'patients', op:'select', columns:'*, branches(name)',
    filters:[{col:'branch_id',op:'eq',val:1}] }, asRegistrar);
  const rows = db.prepare(sql).all(...params);       // must NOT throw "ambiguous column name"
  assert.ok(rows.length >= 1);
  // (the nesting itself is asserted at the route/HTTP level below)
  assert.ok(Array.isArray(meta.embeds) && meta.embeds[0].name === 'branches');
});

test('id-only base + embed does not throw ambiguous column', () => {
  const db = openDb(':memory:'); migrate(db);
  db.prepare("INSERT INTO patients (full_name, branch_id) VALUES ('Bo', 1)").run();
  const { sql, params } = compile({ table:'patients', op:'select', columns:'id,full_name,branches(name)' }, { role:'registrar', id:1 });
  assert.doesNotThrow(() => db.prepare(sql).all(...params));
});

// LABS_UI_V1 regression — the worklist's 2-hop patient lookup is exactly this
// shape: `.from('visits').select('id,visit_date,patients(full_name,mrn)').in('id', visitIds)`.
// Every embed LEFT JOINs on "<embed_table>"."id" (see parseColumns), so filtering
// the base table by an unqualified "id" used to throw SQLite's "ambiguous column
// name: id" the instant an embed was present — the WHERE clause never got the
// same base-table qualification the SELECT projection already had.
// TENANCY_NOOP_V1 — the original multi-tenant easymed.uz views filter every
// query by company_id/clinic_id/branch_id to scope to one clinic/branch.
// Locally there is exactly one clinic, so on tables that don't allow-list
// these columns the filter is a harmless no-op: silently dropped rather than
// a 400, so the original views run unmodified. Tables that DO allow-list
// branch_id (patients, visits, invoices, ...) still apply it normally.
test('company_id filter on a table without it in the allow-list is silently ignored', () => {
  const { sql, params } = compile({ table:'services', op:'select', columns:'*',
    filters:[{col:'company_id',op:'eq',val:1}] }, { role:'admin', id:1 });
  assert.doesNotMatch(sql, /WHERE/);
  assert.doesNotMatch(sql, /company_id/);
  assert.deepEqual(params, []);
});

test('tenancy no-op filter alongside a real filter: only the real one lands in WHERE', () => {
  const { sql, params } = compile({ table:'services', op:'select', columns:'*',
    filters:[{col:'company_id',op:'eq',val:1},{col:'active',op:'eq',val:1}] }, { role:'admin', id:1 });
  assert.match(sql, /WHERE "services"\."active" = \?/);
  assert.doesNotMatch(sql, /company_id/);
  assert.deepEqual(params, [1]);
});

test('branch_id on a table that DOES allow-list it still applies (not soft-ignored)', () => {
  const { sql, params } = compile({ table:'visits', op:'select', columns:'*',
    filters:[{col:'branch_id',op:'eq',val:1}] }, { role:'admin', id:1 });
  assert.match(sql, /WHERE "visits"\."branch_id" = \?/);
  assert.deepEqual(params, [1]);
});

test('clinic_id is soft-ignored the same as company_id/branch_id', () => {
  const { sql, params } = compile({ table:'services', op:'select', columns:'*',
    filters:[{col:'clinic_id',op:'eq',val:5}] }, { role:'admin', id:1 });
  assert.doesNotMatch(sql, /WHERE/);
  assert.deepEqual(params, []);
});

test('an unknown non-tenancy column still throws 400', () => {
  assert.throws(() => compile({table:'services',op:'select',columns:'*',
    filters:[{col:'bogus_col',op:'eq',val:1}]}, { role:'admin', id:1 }), /unknown filter column/);
});

test('tenancy no-op also applies to update/delete filter compilation', () => {
  const upd = compile({table:'services',op:'update',values:{active:0},
    filters:[{col:'company_id',op:'eq',val:1},{col:'id',op:'eq',val:3}]}, { role:'admin', id:1 });
  assert.doesNotMatch(upd.sql, /company_id/);
  assert.match(upd.sql, /WHERE "id" = \?/);
});

test('filtering by id with an embed present does not throw ambiguous column', () => {
  const db = openDb(':memory:'); migrate(db);
  const patientId = db.prepare("INSERT INTO patients (full_name, branch_id) VALUES ('Cy', 1)").run().lastInsertRowid;
  const visitId = db.prepare("INSERT INTO visits (patient_id, branch_id, visit_date) VALUES (?, 1, '2026-08-12T09:00:00Z')").run(patientId).lastInsertRowid;
  const { sql, params } = compile({ table:'visits', op:'select', columns:'id,visit_date,patients(full_name,mrn)',
    filters:[{col:'id',op:'in',val:[visitId]}] }, { role:'registrar', id:1 });
  const rows = db.prepare(sql).all(...params);   // must NOT throw "ambiguous column name"
  assert.equal(rows.length, 1);
  assert.equal(rows[0]['id'], visitId);
  assert.equal(rows[0]['patients.full_name'], 'Cy');
});

// ─── ALIASED + MULTIPLE SAME-TABLE EMBEDS (Phase 2 compiler upgrade) ─────────
// The ORIGINAL easymed frontend selects PostgREST embeds the local compiler
// could not previously represent: aliased `alias:relation(cols)` and TWO embeds
// of the SAME table in one select (e.g. from/to beds on admission_transfers).
// Both used to 400 ("unknown embed") or 500 (duplicate unaliased LEFT JOIN).
// This reshape() mirrors routes/db.js exactly so the nesting is exercised
// end-to-end (keys by embed `name`, which is now the alias/output name).
function reshape(rows, meta) {
  if (!meta.embeds || meta.embeds.length === 0) return rows;
  return rows.map((row) => {
    for (const { name, columns } of meta.embeds) {
      const nested = {};
      let allNull = true;
      for (const col of columns) {
        const key = `${name}.${col}`;
        const val = row[key];
        nested[col] = val;
        if (val !== null && val !== undefined) allNull = false;
        delete row[key];
      }
      row[name] = allNull ? null : nested;
    }
    return row;
  });
}

test('aliased embed compiles: alias:relation(cols) -> aliased LEFT JOIN + dotted projection', () => {
  const { sql, meta } = compile({ table:'recommended_services', op:'select',
    columns:'*, recommended_by:recommended_by(full_name)' }, { role:'admin', id:1 });
  assert.match(sql, /LEFT JOIN "users" AS "recommended_by" ON "recommended_services"\."recommended_by" = "recommended_by"\."id"/);
  assert.match(sql, /"recommended_by"\."full_name" AS "recommended_by\.full_name"/);
  assert.ok(Array.isArray(meta.embeds) && meta.embeds.some((e) => e.name === 'recommended_by'));
});

test('two embeds of the SAME table -> two DISTINCT aliased joins, nested under each alias', () => {
  const db = openDb(':memory:'); migrate(db);
  const wardId = db.prepare("INSERT INTO wards (name) VALUES ('W1')").run().lastInsertRowid;
  const bedA = db.prepare("INSERT INTO beds (code, ward_id) VALUES ('B-A', ?)").run(wardId).lastInsertRowid;
  const bedB = db.prepare("INSERT INTO beds (code, ward_id) VALUES ('B-B', ?)").run(wardId).lastInsertRowid;
  const patientId = db.prepare("INSERT INTO patients (full_name, branch_id) VALUES ('Pat', 1)").run().lastInsertRowid;
  const admissionId = db.prepare("INSERT INTO admissions (patient_id, bed_id, ward_id) VALUES (?, ?, ?)").run(patientId, bedB, wardId).lastInsertRowid;
  db.prepare("INSERT INTO admission_transfers (admission_id, from_bed_id, to_bed_id) VALUES (?, ?, ?)").run(admissionId, bedA, bedB);

  const { sql, params, meta } = compile({ table:'admission_transfers', op:'select',
    columns:'*, from:from_bed_id(code), to:to_bed_id(code)',
    filters:[{col:'admission_id',op:'eq',val:admissionId}] }, { role:'admin', id:1 });
  // two distinct aliased joins on the same underlying table, no duplicate
  assert.match(sql, /LEFT JOIN "beds" AS "from" ON "admission_transfers"\."from_bed_id" = "from"\."id"/);
  assert.match(sql, /LEFT JOIN "beds" AS "to" ON "admission_transfers"\."to_bed_id" = "to"\."id"/);
  assert.match(sql, /"from"\."code" AS "from\.code"/);
  assert.match(sql, /"to"\."code" AS "to\.code"/);
  const rows = reshape(db.prepare(sql).all(...params), meta);   // must NOT throw duplicate/ambiguous
  assert.equal(rows.length, 1);
  assert.equal(rows[0].from.code, 'B-A');
  assert.equal(rows[0].to.code, 'B-B');
});

test('backward-compat: a plain relation(cols) embed still joins + nests under the relation name', () => {
  const db = openDb(':memory:'); migrate(db);
  const doctorId = db.prepare("INSERT INTO users (username, password_hash, full_name, role) VALUES ('drx','x','Dr X','doctor')").run().lastInsertRowid;
  const patientId = db.prepare("INSERT INTO patients (full_name, branch_id) VALUES ('Dee', 1)").run().lastInsertRowid;
  db.prepare("INSERT INTO visits (patient_id, doctor_id, branch_id, visit_date) VALUES (?, ?, 1, '2026-08-12T09:00:00Z')").run(patientId, doctorId);
  const { sql, params, meta } = compile({ table:'visits', op:'select', columns:'*, doctor(full_name)',
    filters:[{col:'doctor_id',op:'eq',val:doctorId}] }, { role:'registrar', id:1 });
  assert.match(sql, /LEFT JOIN "users" AS "doctor" ON "visits"\."doctor_id" = "doctor"\."id"/);
  const rows = reshape(db.prepare(sql).all(...params), meta);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].doctor.full_name, 'Dr X');
});

test('aliased/multi embed: unknown relation still 403, bad subcol still 400', () => {
  // unknown relation (after the alias) still throws 403
  assert.throws(() => compile({ table:'admission_transfers', op:'select',
    columns:'*, from:not_a_relation(code)' }, { role:'admin', id:1 }), (e) => e instanceof CompileError && e.status === 403);
  // a subcol that is not in the embed's allow-list still throws 400
  assert.throws(() => compile({ table:'admission_transfers', op:'select',
    columns:'*, from:from_bed_id(secret)' }, { role:'admin', id:1 }), (e) => e instanceof CompileError && e.status === 400);
});
