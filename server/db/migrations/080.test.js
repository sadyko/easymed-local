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

test('branches gains a letter column and the seeded Main Branch is A', () => {
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

// The rule letters.js (Task 2) implements, mirrored here so this file can pin
// the ledger's INTENT without waiting for that module to exist: the next letter
// is the highest ISSUED one plus one, then walk forward past anything present
// at all. 'A' -> 'B', 'Z' -> 'AA', 'AZ' -> 'BA'.
const bump = (s) => {
  const c = s.split('');
  for (let i = c.length - 1; ; i--) {
    if (c[i] !== 'Z') { c[i] = String.fromCharCode(c[i].charCodeAt(0) + 1); return c.join(''); }
    c[i] = 'A';
    if (i === 0) return 'A' + c.join('');
  }
};
function nextLetter(db) {
  // KEEP EVERY SCENARIO IN THIS FILE UNDER 26 BRANCHES. This MAX() is a LEXICAL
  // maximum; the real allocator (letters.js) takes the highest by POSITION, so
  // the two disagree past Z — with {A,B,AA} issued letters.js answers AB and
  // this mirror answers C, because 'AA' < 'B' as text. Add a >26-branch case
  // here and it would pin the wrong rule while looking authoritative.
  const highestIssued = db.prepare("SELECT MAX(letter) m FROM branch_letters_spent WHERE kind = 'issue'").get().m;
  const present = new Set(db.prepare('SELECT letter FROM branch_letters_spent').all().map((r) => r.letter));
  let cand = bump(highestIssued);
  while (present.has(cand)) cand = bump(cand);
  return cand;
}

test("'P' is burned, not issued: unusable as a branch letter, and it does not push the next branch past B", () => {
  const db = freshDb();
  // DO NOT DELETE THE 'P' ROW. If a frozen test elsewhere starts failing, this
  // is the test that says why the row is here — read it before touching the
  // seed. 'P' is the prefix ~70 000 legacy MRNs already carry (002 and 034
  // minted 'P-YY-NNNNN' for years). A branch lettered P would be a separate
  // database with no legacy rows, so it would start at P-26-00001 and climb
  // through numbers the main branch printed years ago — one number on two
  // people, which is the fleet-wide rule 080 states once, just above
  // branch_letters_spent.
  //
  // The reason it is kind='burn' and not kind='issue' is this test's second
  // half. 'issue' means "handed to a real branch" and drives what comes next;
  // 'burn' means "never a branch and never allowed to be one". Seeded as
  // 'issue', 'P' would be the highest issued letter and the clinic's SECOND
  // branch would be lettered Q, skipping B through O — and the obvious fix for
  // THAT is deleting this row, which silently undoes the collision guard.
  assert.equal(nextLetter(db), 'B',
    "the second branch must be B: 'P' is burned, not issued, so it must not drag the allocator up to Q");

  const p = db.prepare("SELECT kind FROM branch_letters_spent WHERE letter = 'P'").get();
  assert.equal(p.kind, 'burn', "'P' must never be marked issued — see the comment above, it is the legacy MRN prefix");

  // …and it is still unusable: present in the ledger, so the walk-forward skips
  // it when allocation eventually reaches that far.
  db.prepare("INSERT INTO branch_letters_spent (letter, kind) VALUES ('O','issue')").run();
  assert.equal(nextLetter(db), 'Q', "allocation must step over the burned 'P', not through it");
});

test("a letter that is not plain A-Z is rejected by both tables that store one", () => {
  const db = freshDb();
  for (const bad of ['', 'a', '1', 'Ab', 'aB', 'A1', 'A-']) {
    assert.throws(() => db.prepare('UPDATE branch_identity SET letter = ? WHERE id = 1').run(bad),
      /CHECK constraint failed/, 'branch_identity.letter ' + JSON.stringify(bad));
    assert.throws(() => db.prepare('INSERT INTO branch_letters_spent (letter) VALUES (?)').run(bad),
      /CHECK constraint failed/, 'branch_letters_spent.letter ' + JSON.stringify(bad));
  }
  // branch_letters_spent is the table letters.js reads to decide the next
  // letter, so a junk row there is a junk MRN prefix on a whole branch.
  db.prepare("INSERT INTO branch_letters_spent (letter) VALUES ('AA')").run();
  assert.equal(db.prepare("SELECT kind FROM branch_letters_spent WHERE letter = 'AA'").get().kind, 'issue',
    "kind defaults to 'issue' — a plain allocation should not have to name it");
});

test("'A' and 'P' are already spent, so letters.js can never hand either to a branch", () => {
  const db = freshDb();
  // The ledger, not branches.letter, is what makes reuse impossible: a deleted
  // branch takes its letter row with it, and the next allocation would reissue
  // it to a different person's MRN years later.
  //
  // 'P' is the dangerous one and it is not obvious. letters.js allocates
  // A, B, C ... so the SIXTEENTH branch would be lettered P — the prefix every
  // legacy MRN already carries. That branch is a different database with no
  // legacy rows, so its allocator would start at P-26-00001 and climb straight
  // through numbers the main branch printed years ago — one number on two
  // people, the rule 080 states just above branch_letters_spent. The unanchored
  // year predicate below cannot help: it only sees one database.
  assert.deepEqual(db.prepare('SELECT letter, kind FROM branch_letters_spent ORDER BY letter').all(),
    [{ letter: 'A', kind: 'issue' }, { letter: 'P', kind: 'burn' }]);
});

test('a missing branch identity aborts the registration instead of minting a NULL MRN', () => {
  const db = freshDb();
  // mrn is UNIQUE, and SQLite allows unlimited NULLs in a UNIQUE column. So a
  // trigger that quietly produced NULL would register patient after patient
  // with no medical record number and nothing would complain until someone
  // tried to find one of them. Failing the registration loudly is the lesser
  // harm — and the only outcome an operator will actually report.
  db.prepare('DELETE FROM branch_identity WHERE id = 1').run();
  assert.throws(() => db.prepare("INSERT INTO patients (full_name) VALUES ('Без номера')").run(),
    /branch identity missing/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM patients').get().n, 0,
    'RAISE(ABORT) must roll the half-registered patient back, not leave it with mrn = NULL');
});

test('the letter shapes letters.js really produces stay legal', () => {
  const db = freshDb();
  for (const good of ['B', 'Z', 'AA', 'AB']) {
    db.prepare('UPDATE branch_identity SET letter = ? WHERE id = 1').run(good);
    assert.equal(db.prepare('SELECT letter FROM branch_identity WHERE id = 1').get().letter, good);
  }
});

test('two branches cannot hold the same letter, but unlettered branches are fine', () => {
  const db = freshDb();
  // Without this index the ledger is only advisory: a hand-written INSERT, or
  // letters.js racing itself, could put 'A' on two rows and both would then
  // mint the same MRNs.
  assert.throws(() => db.prepare("INSERT INTO branches (name, letter) VALUES ('Дубль', 'A')").run(),
    /UNIQUE constraint failed/);
  db.prepare("INSERT INTO branches (name, letter) VALUES ('Второй', 'B')").run();
  // NULLs stay distinct in SQLite, so branches created before a letter is
  // allocated do not collide with each other.
  db.prepare("INSERT INTO branches (name) VALUES ('Без буквы 1')").run();
  db.prepare("INSERT INTO branches (name) VALUES ('Без буквы 2')").run();
  assert.equal(db.prepare('SELECT COUNT(*) n FROM branches WHERE letter IS NULL').get().n, 2);
});

test('branches.letter is held to the same shape rule as the other two tables', () => {
  const db = freshDb();
  // The first draft of this migration left this column bare TEXT while
  // branch_identity.letter and branch_letters_spent.letter both carried the
  // rule — so the one table that actually names a branch was the one that would
  // accept 'a' or 'A1' and put that on every MRN the branch ever prints.
  for (const bad of ['', 'a', '1', 'Ab', 'aB', 'A1', 'A-']) {
    assert.throws(() => db.prepare('INSERT INTO branches (name, letter) VALUES (?, ?)').run('Плохая', bad),
      /CHECK constraint failed/, 'branches.letter ' + JSON.stringify(bad));
  }
  // …and NULL still passes, because an upgraded clinic's branches carry no
  // letter until letters.js allocates one. A SQLite CHECK fails only on an
  // explicit false, so the nullable column needs no special case.
  db.prepare("INSERT INTO branches (name) VALUES ('Ещё без буквы')").run();
  assert.equal(db.prepare('SELECT COUNT(*) n FROM branches WHERE letter IS NULL').get().n, 1);
});

test('a branch letter cannot be duplicated in another case either', () => {
  const db = freshDb();
  // branches_letter_uniq is COLLATE NOCASE. Under the default BINARY, a 'b'
  // beside an allocated 'B' is two branches minting 'b-26-00001' and
  // 'B-26-00001' — different strings to SQLite, the same number on the printed
  // card and to any Stage 2 matcher that normalises case. It is the same
  // collision class letters.js guards against in patients.mrn, and it has to be
  // shut on both sides.
  db.prepare("INSERT INTO branches (name, letter) VALUES ('Второй', 'B')").run();
  assert.throws(() => db.prepare("UPDATE branches SET letter = 'b' WHERE name = 'Второй'").run(),
    /CHECK constraint failed/, 'the shape rule refuses lowercase first');
  // Now reach past the CHECK the way a restored backup or a hand-edited row
  // does, and the index is what is left standing.
  db.pragma('ignore_check_constraints = ON');
  assert.throws(() => db.prepare("INSERT INTO branches (name, letter) VALUES ('Дубль', 'b')").run(),
    /UNIQUE constraint failed/, "'b' must collide with the allocated 'B'");
  assert.throws(() => db.prepare("INSERT INTO branches (name, letter) VALUES ('Дубль', 'a')").run(),
    /UNIQUE constraint failed/, "…and 'a' with the seeded main branch 'A'");
  db.pragma('ignore_check_constraints = OFF');
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
    // Filter on the migration NUMBER, not on the string '080'. The day 081 is
    // written, a name-prefix filter would copy it in, migrate would apply it
    // BEFORE 080 (081 sorts after 079 but 080 is not there yet), the
    // branch_identity sanity check below would still pass, and this test would
    // quietly stop testing the upgrade while running the schema out of order.
    fs.cpSync(MIGRATIONS_DIR, dir, { recursive: true, filter: (src) => {
      if (fs.statSync(src).isDirectory()) return true;
      const m = /^(\d{3,})_.*\.sql$/.exec(path.basename(src));
      return m ? Number(m[1]) < 80 : false;   // .sql only; migrate() ignores the rest
    } });
    const db = openDb(':memory:');
    migrate(db, dir);
    const base = db.prepare('SELECT name FROM schema_migrations ORDER BY name').all().map((r) => r.name);
    assert.equal(base.at(-1), '079_branch_sync.sql',
      'the base must stop exactly one migration short of 080, whatever lands later');
    assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='branch_identity'").get().n, 0,
      'sanity: this database must be at 079, i.e. before branch identity exists');

    const yy = String(new Date().getFullYear()).slice(2);
    const ins = db.prepare('INSERT INTO patients (full_name, mrn) VALUES (?, ?)');
    db.transaction(() => {
      for (let i = 1; i <= 70000; i++) ins.run('Пациент ' + i, `P-${yy}-${String(i).padStart(5, '0')}`);
    })();

    fs.cpSync(path.join(MIGRATIONS_DIR, '080_branch_identity.sql'), path.join(dir, '080_branch_identity.sql'));
    migrate(db, dir);   // throws if the migration fails; that is the "without error" half
    assert.deepEqual(db.prepare('SELECT name FROM schema_migrations ORDER BY name').all().map((r) => r.name),
      base.concat('080_branch_identity.sql'), 'exactly one migration ran, and it was 080');

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
