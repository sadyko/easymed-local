import test from 'node:test';
import assert from 'node:assert/strict';
import { nextLetter, allocateLetter } from './letters.js';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';

function freshDb() { const db = openDb(':memory:'); migrate(db); return db; }

test('letters run A, B, C ... Z, then AA, AB', () => {
  assert.equal(nextLetter([]), 'A');
  assert.equal(nextLetter(['A']), 'B');
  assert.equal(nextLetter(['A', 'B']), 'C');
  assert.equal(nextLetter(['Z']), 'AA');
  assert.equal(nextLetter(['AA']), 'AB');
  assert.equal(nextLetter(['AZ']), 'BA');
});

test('a letter is never reused, even when its branch is gone', () => {
  assert.equal(nextLetter(['A', 'B', 'C']), 'D', 'not B, even if B was deleted');
});

test('allocation is driven by the highest letter ever issued, not by the count', () => {
  const db = freshDb();
  db.prepare("INSERT INTO branches (name, letter) VALUES ('Второй', 'B')").run();
  db.prepare("INSERT INTO branch_letters_spent (letter, kind) VALUES ('B','issue')").run();
  db.prepare("DELETE FROM branches WHERE letter = 'B'").run();
  assert.equal(allocateLetter(db), 'C', 'B was used once and is spent forever');
});

test("a BURNED letter is skipped but does not drag the next letter past it", () => {
  const db = freshDb();
  const spent = db.prepare('SELECT letter, kind FROM branch_letters_spent ORDER BY letter').all();
  assert.deepEqual(spent, [{ letter: 'A', kind: 'issue' }, { letter: 'P', kind: 'burn' }]);
  assert.equal(allocateLetter(db, { name: 'Второй' }), 'B', "burning P must not push past B");
});

test('a burned letter is never issued, even when allocation reaches it', () => {
  const db = freshDb();
  for (const l of 'BCDEFGHIJKLMNO') {
    db.prepare("INSERT INTO branch_letters_spent (letter, kind) VALUES (?, 'issue')").run(l);
  }
  assert.equal(allocateLetter(db, { name: 'Шестнадцатый' }), 'Q', 'P is burned and must be stepped over');
});

test('allocateLetter writes the letter onto the branch row it creates', () => {
  const db = freshDb();
  const letter = allocateLetter(db, { name: 'Юнусабад' });
  const row = db.prepare('SELECT * FROM branches WHERE letter = ?').get(letter);
  assert.equal(row.name, 'Юнусабад');
  assert.equal(letter, 'B', 'A is the main branch');
});

test('a prefix already present in imported patient numbers is burned, not issued', () => {
  // Migration 080 can only burn the prefix THIS codebase ever generated ('P').
  // A clinic migrating from another system imports MRNs through Excel, and that
  // importer accepts arbitrary text — so 'B-24-00500' can already exist before
  // any branch is called B. Issuing B would then mint numbers colliding with
  // rows that are already printed.
  const db = freshDb();
  db.prepare("INSERT INTO patients (full_name, mrn) VALUES ('Импорт', 'B-24-00500')").run();
  assert.equal(allocateLetter(db, { name: 'Второй' }), 'C', 'B is taken by imported data');
  const b = db.prepare("SELECT kind FROM branch_letters_spent WHERE letter = 'B'").get();
  assert.equal(b.kind, 'burn', 'and the reason is recorded, not recomputed next time');
});

// ---------------------------------------------------------------------------
// The tests above are the contract. The tests below pin the three things the
// first draft of letters.js got wrong, so that a revert to that draft fails
// here rather than in a clinic.
// ---------------------------------------------------------------------------

test('a whole run of poisoned prefixes is walked past in one call, and every skipped letter is burned', () => {
  // The draft recursed once per poisoned prefix. It terminated — each level
  // burns its candidate, so the next level moves strictly forward — but its
  // depth was set by the DATA (one stack frame per prefix an old system's
  // export happened to use) and every level re-read the whole ledger. The loop
  // that replaced it has neither property; this proves the walk itself still
  // steps over every clash and records why.
  const db = freshDb();
  const poisoned = [];
  for (const l of 'BCDEFGHIJKLMNOPQRSTUVWXYZ') poisoned.push(l);
  for (const l of 'ABCDEFGHIJ') poisoned.push('A' + l);
  const ins = db.prepare('INSERT INTO patients (full_name, mrn) VALUES (?, ?)');
  for (const p of poisoned) ins.run('Импорт ' + p, `${p}-24-00500`);

  assert.equal(allocateLetter(db, { name: 'Первый чистый' }), 'AK',
    'B..Z and AA..AJ are all in use by imported data, AK is the first free one');

  // 'P' was already burned by 080 and must not be burned twice (its row is the
  // one that carries the legacy-MRN reasoning, and its issued_at with it).
  const burned = db.prepare("SELECT letter FROM branch_letters_spent WHERE kind = 'burn' ORDER BY letter").all()
    .map((r) => r.letter);
  assert.deepEqual(burned.slice().sort(), poisoned.slice().sort(),
    'every letter the walk stepped over is recorded as burned — including P, which 080 seeded');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM branch_letters_spent WHERE letter = 'P'").get().n, 1);
});

test('a failed allocation burns nothing: letters are not spent by an allocation that never happened', () => {
  // The draft committed each burn on its own, OUTSIDE the transaction that
  // issued the letter. Any failure after a burn therefore consumed letters
  // permanently for an allocation that produced no branch — and burns are by
  // design irreversible. The trigger used here is the realistic one named in
  // 080: a branches row already holds the letter (restored backup, hand edit)
  // while the ledger does not, so branches_letter_uniq fires mid-allocation.
  const db = freshDb();
  db.prepare("INSERT INTO patients (full_name, mrn) VALUES ('Импорт', 'B-24-00500')").run();
  db.prepare("INSERT INTO branches (name, letter) VALUES ('Из бэкапа', 'C')").run();

  assert.throws(() => allocateLetter(db, { name: 'Новый' }), /UNIQUE constraint failed/);

  assert.equal(db.prepare("SELECT COUNT(*) n FROM branch_letters_spent WHERE letter IN ('B','C')").get().n, 0,
    "B's burn must roll back with C's issue — nothing was allocated, so nothing may be spent");
  // …and the very next attempt still reaches the same answer from the data.
  db.prepare("DELETE FROM branches WHERE letter = 'C'").run();
  assert.equal(allocateLetter(db, { name: 'Новый' }), 'C', 'the burn is re-derived from patients.mrn');
  assert.equal(db.prepare("SELECT kind FROM branch_letters_spent WHERE letter = 'B'").get().kind, 'burn');
});

test('an imported prefix in lower case blocks the letter too', () => {
  // patients.mrn is indexed BINARY, so 'b-24-00500' and 'B-26-00001' are
  // different strings to SQLite and would never raise a UNIQUE error. They are
  // the same series to the staff reading the printed card, and to any Stage 2
  // matcher that normalises case — which is the collision this file exists to
  // prevent. The Excel importer takes the column as typed, so this is what an
  // export from a lower-casing system actually looks like.
  const db = freshDb();
  db.prepare("INSERT INTO patients (full_name, mrn) VALUES ('Импорт', 'b-24-00500')").run();
  assert.equal(allocateLetter(db, { name: 'Второй' }), 'C');
  assert.equal(db.prepare("SELECT kind FROM branch_letters_spent WHERE letter = 'B'").get().kind, 'burn');
});

test('thirty branches in a row: every letter distinct, P stepped over, Z rolling into AA', () => {
  // Answers the two self-review questions at once — can allocateLetter return a
  // letter already in the ledger, and can two branches created back to back
  // collide. Sequential calls are the real pattern: the owner adds branches one
  // after another in the same session.
  const db = freshDb();
  const got = [];
  for (let i = 0; i < 30; i++) got.push(allocateLetter(db, { name: 'Филиал ' + i }));
  assert.deepEqual(got, [
    'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O',
    'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z',
    'AA', 'AB', 'AC', 'AD', 'AE', 'AF',
  ], 'P is skipped, and Z rolls into AA rather than repeating');
  assert.equal(new Set(got).size, got.length, 'no letter is handed out twice');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM branches WHERE letter IS NULL').get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM branch_letters_spent WHERE kind='issue'").get().n, 31,
    'A plus the thirty just issued');
});

test('past Z the highest letter is found by position, not alphabetically', () => {
  // 'AA' < 'B' as text, so a MAX() over the letter column would answer 'B' for a
  // clinic already at AA and reissue a letter that is on a branch. Only bites
  // past 26 branches, which is exactly when nobody is looking.
  assert.equal(nextLetter(['AA', 'B']), 'AB');
  assert.equal(nextLetter(['B', 'AA']), 'AB');
  const db = freshDb();
  db.prepare("INSERT INTO branch_letters_spent (letter, kind) VALUES ('B','issue'),('AA','issue')").run();
  assert.equal(allocateLetter(db, { name: 'Двадцать восьмой' }), 'AB');
});

test('the A..Z..AA..ZZ..AAA sequence never repeats a letter', () => {
  // toIndex/fromIndex must round-trip for every value the allocator can reach,
  // and the boundaries are where a base-26 encoding goes wrong: Z->AA (26->27)
  // and ZZ->AAA (702->703).
  const seen = new Set();
  let letter = nextLetter([]);
  for (let i = 1; i <= 703; i++) {
    assert.equal(seen.has(letter), false, 'repeated ' + letter + ' at position ' + i);
    seen.add(letter);
    if (i === 26) assert.equal(letter, 'Z');
    if (i === 27) assert.equal(letter, 'AA');
    if (i === 702) assert.equal(letter, 'ZZ');
    if (i === 703) assert.equal(letter, 'AAA');
    letter = nextLetter([letter]);
  }
  // Every letter produced is a shape both tables in 080 accept (plain A-Z).
  for (const l of seen) assert.match(l, /^[A-Z]+$/);
});
