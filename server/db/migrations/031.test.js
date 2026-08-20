import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { compile } from '../query-compiler.js';

const ADMIN = { id: 1, role: 'admin' };

test('031 creates doc_branding', () => {
  const db = openDb(':memory:'); migrate(db);
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='doc_branding'").get());
});

test('031 doc_branding upsert keeps company_id as conflict target + JSON-serialises settings; read parses back', () => {
  const db = openDb(':memory:'); migrate(db);
  const settings = { accent: '#167873', variant: { invoice: 'compact' }, tagline: 'X' };

  const c1 = compile({ table: 'doc_branding', op: 'upsert',
    values: { company_id: 1, settings, updated_at: '2026-08-06T00:00:00Z' }, onConflict: 'company_id' }, ADMIN);
  // company_id survives (it's allow-listed) -> ON CONFLICT (company_id) DO UPDATE the non-key cols
  assert.match(c1.sql, /ON CONFLICT \("company_id"\) DO UPDATE SET "settings" = excluded\."settings", "updated_at" = excluded\."updated_at"/);
  // settings bound as a JSON string, never "[object Object]"
  assert.ok(c1.params.some((p) => typeof p === 'string' && p.includes('"accent"')));
  db.prepare(c1.sql).run(...c1.params);

  // read: meta flags settings as JSON; the stored TEXT parses back to the object
  const cSel = compile({ table: 'doc_branding', op: 'select', columns: 'settings', filters: [{ col: 'company_id', op: 'eq', val: 1 }] }, ADMIN);
  assert.deepEqual(cSel.meta.json, ['settings']);
  assert.deepEqual(JSON.parse(db.prepare(cSel.sql).get(...cSel.params).settings), settings);

  // a second save updates in place — one branding row per clinic
  const c2 = compile({ table: 'doc_branding', op: 'upsert',
    values: { company_id: 1, settings: { accent: '#000' }, updated_at: '2026-08-06T01:00:00Z' }, onConflict: 'company_id' }, ADMIN);
  db.prepare(c2.sql).run(...c2.params);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM doc_branding').get().n, 1);
  assert.equal(JSON.parse(db.prepare('SELECT settings FROM doc_branding WHERE company_id=1').get().settings).accent, '#000');
});

test('031 regression: patient_relationships upsert still strips company_id (not allow-listed there)', () => {
  const c = compile({ table: 'patient_relationships', op: 'upsert',
    values: { patient_id_a: 1, patient_id_b: 2, relation_type: 'spouse' }, onConflict: 'company_id,patient_id_a,patient_id_b' }, { id: 1, role: 'registrar' });
  assert.match(c.sql, /ON CONFLICT \("patient_id_a", "patient_id_b"\)/);
});

test('031 non-admin cannot write doc_branding, but any staff may read it', () => {
  // registrar lacks insert/update on doc_branding -> upsert 403
  assert.throws(() => compile({ table: 'doc_branding', op: 'upsert', values: { company_id: 1, settings: {} }, onConflict: 'company_id' }, { id: 2, role: 'registrar' }));
  // …but the read (used to hydrate print branding) is open to all staff
  assert.ok(compile({ table: 'doc_branding', op: 'select', columns: 'settings', filters: [{ col: 'company_id', op: 'eq', val: 1 }] }, { id: 2, role: 'registrar' }).sql);
});
