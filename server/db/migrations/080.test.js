import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = path.dirname(fileURLToPath(import.meta.url));

function freshDb() { const db = openDb(':memory:'); migrate(db); return db; }

test('the main branch is A, and a new branch gets its own letter column', () => {
  const db = freshDb();
  const main = db.prepare('SELECT letter FROM branches WHERE id = 1').get();
  assert.equal(main.letter, 'A', 'the seeded Main Branch must be A');
});

test('this install knows which branch it is, and starts as the main branch', () => {
  const db = freshDb();
  const me = db.prepare('SELECT * FROM branch_identity WHERE id = 1').get();
  assert.equal(me.letter, 'A');
  assert.equal(me.role, 'main');
});

test("'A' is already spent, so letters.js can never hand it to a second branch", () => {
  const db = freshDb();
  // The ledger, not branches.letter, is what makes reuse impossible: a deleted
  // branch takes its letter row with it, and the next allocation would reissue
  // it to a different person's MRN years later.
  assert.deepEqual(db.prepare('SELECT letter FROM branch_letters_spent ORDER BY letter').all(), [{ letter: 'A' }]);
});

test('a new patient MRN carries this install branch letter', () => {
  const db = freshDb();
  db.prepare("INSERT INTO patients (full_name) VALUES ('Тестов Тест')").run();
  const p = db.prepare('SELECT mrn FROM patients ORDER BY id DESC LIMIT 1').get();
  assert.match(p.mrn, /^A-\d{2}-\d{5}$/, 'got ' + p.mrn);
});

test('an MRN supplied explicitly is never overwritten (the Excel importer relies on this)', () => {
  const db = freshDb();
  db.prepare("INSERT INTO patients (full_name, mrn) VALUES ('Импорт', 'P-24-00777')").run();
  const p = db.prepare("SELECT mrn FROM patients WHERE full_name = 'Импорт'").get();
  assert.equal(p.mrn, 'P-24-00777');
});

test('numbering continues past legacy P- rows instead of restarting at 1', () => {
  const db = freshDb();
  const yy = String(new Date().getFullYear()).slice(2);
  db.prepare('INSERT INTO patients (full_name, mrn) VALUES (?, ?)').run('Старый', `P-${yy}-00042`);
  db.prepare("INSERT INTO patients (full_name) VALUES ('Новый')").run();
  const p = db.prepare("SELECT mrn FROM patients WHERE full_name = 'Новый'").get();
  assert.equal(p.mrn, `A-${yy}-00043`, 'must not collide with the legacy row');
});

test('a two-letter branch still numbers correctly (the suffix is the last 5 chars, not a fixed offset)', () => {
  const db = freshDb();
  const yy = String(new Date().getFullYear()).slice(2);
  db.prepare("UPDATE branch_identity SET letter = 'AB' WHERE id = 1").run();
  db.prepare('INSERT INTO patients (full_name, mrn) VALUES (?, ?)').run('Первый', `AB-${yy}-00009`);
  db.prepare("INSERT INTO patients (full_name) VALUES ('Второй')").run();
  const p = db.prepare("SELECT mrn FROM patients WHERE full_name = 'Второй'").get();
  assert.equal(p.mrn, `AB-${yy}-00010`);
});

// ---------------------------------------------------------------------------
// The year predicate, proven rather than assumed.
//
// The trigger matches the year with substr(mrn, -9, 4) = '-YY-'. Getting this
// wrong is silent and expensive in exactly two directions: too narrow and
// numbering restarts at 1 while last year's numbers are still live (UNIQUE
// violations, or worse, two patients sharing a printed card number); too wide
// and it never rolls over. The tests below pin both edges.
// ---------------------------------------------------------------------------

test('the year window lands on -YY- for every letter length, so no shape is missed', () => {
  const db = freshDb();
  const yy = String(new Date().getFullYear()).slice(2);
  // One row per letter shape a clinic can actually hold: legacy, this branch,
  // a two-letter branch past 26, a three-letter one past 702.
  for (const [name, mrn] of [
    ['Легаси', `P-${yy}-00011`],
    ['Свой',   `A-${yy}-00022`],
    ['Двойной', `AB-${yy}-00033`],
    ['Тройной', `ABC-${yy}-00044`],
  ]) db.prepare('INSERT INTO patients (full_name, mrn) VALUES (?, ?)').run(name, mrn);

  const matched = db.prepare(
    "SELECT mrn FROM patients WHERE substr(mrn, -9, 4) = '-' || ? || '-' ORDER BY mrn"
  ).all(yy).map((r) => r.mrn);
  assert.deepEqual(matched, [`A-${yy}-00022`, `AB-${yy}-00033`, `ABC-${yy}-00044`, `P-${yy}-00011`],
    'all four shapes must be visible to the predicate, not just the one-letter one');

  // …and the allocator therefore starts past the highest of them, whichever
  // branch printed it. A narrower predicate would reissue a printed number.
  db.prepare("INSERT INTO patients (full_name) VALUES ('Следующий')").run();
  assert.equal(db.prepare("SELECT mrn FROM patients WHERE full_name='Следующий'").get().mrn, `A-${yy}-00045`);
});

test('a new year starts at 1 again and does not collide with last year', () => {
  const db = freshDb();
  const yy = String(new Date().getFullYear()).slice(2);
  const prev = String(new Date().getFullYear() - 1).slice(2);
  // Last year ran to 99 000-odd. This year must NOT continue from there.
  db.prepare('INSERT INTO patients (full_name, mrn) VALUES (?, ?)').run('Прошлогодний', `A-${prev}-99000`);
  db.prepare("INSERT INTO patients (full_name) VALUES ('Первый в году')").run();
  assert.equal(db.prepare("SELECT mrn FROM patients WHERE full_name='Первый в году'").get().mrn, `A-${yy}-00001`,
    'last year must be excluded — the year itself is what keeps the two apart');
});

test('the trigger fires only when mrn IS NULL — an UPDATE never re-triggers it', () => {
  const db = freshDb();
  const yy = String(new Date().getFullYear()).slice(2);
  db.prepare("INSERT INTO patients (full_name) VALUES ('Первичный')").run();
  const before = db.prepare("SELECT id, mrn FROM patients WHERE full_name='Первичный'").get();
  assert.equal(before.mrn, `A-${yy}-00001`);
  // The trigger's own UPDATE writes patients.mrn; if it were AFTER UPDATE, or
  // if the WHEN guard were dropped, this rename would loop or renumber.
  db.prepare("UPDATE patients SET full_name='Переименованный' WHERE id=?").run(before.id);
  assert.equal(db.prepare('SELECT mrn FROM patients WHERE id=?').get(before.id).mrn, before.mrn);
});

test('an existing clinic with 70 000 legacy P- MRNs upgrades without error and without renumbering', () => {
  // The real upgrade path, not a fresh install: migrate to 079, fill the base
  // the way a clinic that has been running for years is filled, THEN apply 080.
  // Every existing MRN is printed on a card the patient carries, so the one
  // outcome this migration may never produce is a renumbered patient.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-080-'));
  try {
    fs.cpSync(MIGRATIONS_DIR, dir, { recursive: true, filter: (s) => !path.basename(s).startsWith('080') });
    const db = openDb(':memory:');
    migrate(db, dir);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='branch_identity'").get().n, 0,
      'sanity: this database must be at 079, i.e. before branch identity exists');

    const yy = String(new Date().getFullYear()).slice(2);
    const ins = db.prepare('INSERT INTO patients (full_name, mrn) VALUES (?, ?)');
    db.transaction(() => {
      for (let i = 1; i <= 70000; i++) ins.run('Пациент ' + i, `P-${yy}-${String(i).padStart(5, '0')}`);
    })();

    fs.cpSync(path.join(MIGRATIONS_DIR, '080_branch_identity.sql'), path.join(dir, '080_branch_identity.sql'));
    migrate(db, dir);   // throws if the migration fails; that is the "without error" half

    assert.equal(db.prepare('SELECT COUNT(*) n FROM patients').get().n, 70000);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM patients WHERE mrn LIKE 'P-%'").get().n, 70000,
      'not one legacy MRN may be rewritten — they are printed on cards patients carry');
    assert.equal(db.prepare('SELECT mrn FROM patients WHERE id=1').get().mrn, `P-${yy}-00001`);
    assert.equal(db.prepare('SELECT letter FROM branch_identity WHERE id=1').get().letter, 'A');

    // The first patient registered after the upgrade continues the clinic's
    // own numbering under the new letter — 70001, not 1.
    db.prepare("INSERT INTO patients (full_name) VALUES ('Первый после обновления')").run();
    assert.equal(db.prepare("SELECT mrn FROM patients WHERE full_name='Первый после обновления'").get().mrn,
      `A-${yy}-70001`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
