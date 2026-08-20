import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

test('022 adds services.type routing column with backfill and CHECK constraint', () => {
  const db = openDb(':memory:'); migrate(db);
  const cols = db.prepare("PRAGMA table_info(services)").all().map(c => c.name);
  assert.ok(cols.includes('type'), 'missing column type');

  // A fresh row inserted with is_lab=1 now comes out typed 'lab'.
  //
  // This assertion used to expect 'consultation', on the reasoning that 022's
  // backfill "only touched rows that existed at migrate() time". That was true,
  // and it was the bug: `type` and `is_lab` are two answers to the same question
  // written by two different editors, and with nothing keeping them in step they
  // drifted. A service marked «Лаборатория» in Settings kept is_lab=0 and never
  // appeared in the laboratory queue, which filters on is_lab. Migration 048 adds
  // triggers that hold the pair together in both directions — see 048.test.js.
  db.prepare("INSERT INTO services (name, is_lab) VALUES ('Glucose test', 1)").run();
  const row = db.prepare("SELECT * FROM services WHERE name='Glucose test'").get();
  assert.equal(row.type, 'lab', 'is_lab=1 on insert implies type=lab (migration 048)');

  // A row with neither flag still defaults to 'consultation'.
  db.prepare("INSERT INTO services (name) VALUES ('Приём терапевта')").run();
  assert.equal(db.prepare("SELECT type FROM services WHERE name='Приём терапевта'").get().type, 'consultation');

  // CHECK constraint rejects invalid type values
  assert.throws(() => {
    db.prepare("INSERT INTO services (name, type) VALUES ('Bogus', 'bogus')").run();
  });
});
