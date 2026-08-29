import test from 'node:test';
import assert from 'node:assert/strict';
import { nextLetter, allocateLetter } from './letters.js';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';

function freshDb() { const db = openDb(':memory:'); migrate(db); return db; }

test('letters run A, B, C ... Z, then AA, AB', () => {
  // The ledger is passed TWICE on purpose, and this test is where that shape is
  // learned: `issued` is what has been handed to a real branch, `taken` is every
  // row the ledger holds, burns included. These cases have no burns, so the two
  // are the same list — said out loud rather than defaulted, because a defaulted
  // `taken` means "no burns" and answers 'P' for a fifteen-branch clinic.
  assert.equal(nextLetter([], []), 'A');
  assert.equal(nextLetter(['A'], ['A']), 'B');
  assert.equal(nextLetter(['A', 'B'], ['A', 'B']), 'C');
  assert.equal(nextLetter(['Z'], ['Z']), 'AA');
  assert.equal(nextLetter(['AA'], ['AA']), 'AB');
  assert.equal(nextLetter(['AZ'], ['AZ']), 'BA');
});

test('nextLetter refuses to guess the ledger rather than answering without it', () => {
  // The omission is not a near-miss, it is the worst available answer: fifteen
  // branches in, a one-argument call returned 'P' — the legacy MRN prefix, the
  // one letter migration 080 burns and the whole reason the ledger has a `kind`.
  // Throwing is the same choice 080's trigger makes with RAISE(ABORT): loud and
  // recoverable beats silent and discovered years later.
  assert.throws(() => nextLetter('ABCDEFGHIJKLMNO'.split('')), /both are required/);
  assert.throws(() => nextLetter(['A']), /both are required/);
  assert.throws(() => nextLetter(), /both are required/);
  assert.throws(() => nextLetter(['A'], null), /both are required/);
  // …and the message names what the omission costs, not just that it happened.
  assert.throws(() => nextLetter(['A']), /P, the legacy MRN prefix/);
});

test('a letter is never reused, even when its branch is gone', () => {
  // The single failure this whole scheme exists to prevent. A closed branch
  // frees nothing: its letter prefixes MRNs printed on cards patients still
  // carry and quoted on invoices already issued. Hand B out a second time and
  // two different people carry the same number years apart — and nothing flags
  // it, because the numbers are simply equal. That is the fleet-wide rule 080
  // states once, just above branch_letters_spent; the consequence is written
  // out there.
  assert.equal(nextLetter(['A', 'B', 'C'], ['A', 'B', 'C']), 'D', 'not B, even if B was deleted');
});

test('allocation is driven by the highest letter ever issued, not by the count', () => {
  // Which is why the LEDGER is the authority and branches.letter is not.
  // Counting branches, or reading the highest letter off the branches table,
  // both give the same wrong answer here: the row is deleted, so B looks free.
  // Only branch_letters_spent still remembers that it was spent — that is the
  // whole reason 080 created a second table instead of reading branches.
  const db = freshDb();
  db.prepare("INSERT INTO branches (name, letter) VALUES ('Второй', 'B')").run();
  db.prepare("INSERT INTO branch_letters_spent (letter, kind) VALUES ('B','issue')").run();
  db.prepare("DELETE FROM branches WHERE letter = 'B'").run();
  assert.equal(allocateLetter(db), 'C', 'B was used once and is spent forever');
});

test("a BURNED letter is skipped but does not drag the next letter past it", () => {
  // READ THIS BEFORE TOUCHING THE 'P' SEED IN MIGRATION 080. Why 'P' is spent
  // without ever having been a branch is written out once, at the seed itself
  // (080_branch_identity.sql, the branch_letters_spent block) — go and read it
  // there rather than trusting a summary.
  //
  // What belongs HERE is why the ledger has a `kind` and why 'P' is 'burn'.
  // 'issue' means "handed to a real branch" and drives where allocation is;
  // 'burn' means "never a branch and never allowed to be one". Seed 'P' as
  // 'issue' and it becomes the highest issued letter in a one-branch clinic, so
  // the clinic's SECOND branch comes out lettered Q, silently skipping B..O —
  // and the obvious fix would be to delete the burn row, undoing the reason it
  // exists. A guard whose failure mode invites its own removal is worse than no
  // guard, so this test pins both halves at once: the row is there, AND it does
  // not move the allocator.
  const db = freshDb();
  const spent = db.prepare('SELECT letter, kind FROM branch_letters_spent ORDER BY letter').all();
  assert.deepEqual(spent, [{ letter: 'A', kind: 'issue' }, { letter: 'P', kind: 'burn' }]);
  assert.equal(allocateLetter(db, { name: 'Второй' }), 'B', "burning P must not push past B");
});

test('a burned letter is never issued, even when allocation reaches it', () => {
  // The other half of the same rule, and the half that actually fires one day.
  // The test above proves a burn does not PUSH allocation forward; this one
  // proves allocation cannot walk THROUGH it once it arrives. Fifteen branches
  // in, the next letter by position is P — so the walk must step over it and
  // land on Q. If it ever returns P, every MRN that branch mints collides with
  // the legacy series, and nothing downstream can tell the two apart.
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
// The tests above are the contract: what a branch letter IS, and what the
// ledger's two kinds mean. Everything below is a regression test — each one
// names a bug that a draft of letters.js actually shipped, so that writing that
// code again fails here instead of in a clinic. They are not all from the same
// draft: the walk, the rollback and the ordering come from the first, the
// mixed-case guard from the second. Read each test's comment for which.
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

test('a MIXED-case imported prefix blocks a two-letter branch, not just an all-lower one', () => {
  // The bug this pins: probing only toUpperCase() and toLowerCase() covers a
  // one-character letter exhaustively and a two-character one only half — 'Aa-'
  // and 'aA-' go unseen, so the 27th branch is issued AA and mints straight into
  // an imported series. It bites ONLY past 26 branches, which is also the only
  // place the collision itself can happen, so the guard was weakest exactly
  // where it was needed. The predicate is COLLATE NOCASE for this reason; the
  // spelling-probe approach needs 2^n queries and gets worse as letters grow.
  for (const imported of ['Aa-24-00500', 'aA-24-00500', 'aa-24-00500', 'AA-24-00500']) {
    const db = freshDb();
    for (const l of 'BCDEFGHIJKLMNOQRSTUVWXYZ') {   // P is already burned by 080
      db.prepare("INSERT INTO branch_letters_spent (letter, kind) VALUES (?, 'issue')").run(l);
    }
    db.prepare('INSERT INTO patients (full_name, mrn) VALUES (?, ?)').run('Импорт', imported);
    assert.equal(allocateLetter(db, { name: 'Двадцать седьмой' }), 'AB',
      `${imported} must block AA whatever case it was imported in`);
    assert.equal(db.prepare("SELECT kind FROM branch_letters_spent WHERE letter = 'AA'").get().kind, 'burn');
  }
});

test('the prefix check matches a whole letter, never a longer or shorter one', () => {
  // COLLATE NOCASE folds case; it must not also blur length. 'AAA-…' must not
  // block AA, and 'A-…' must not block AA — otherwise the walk burns letters
  // that are perfectly free and the clinic loses them forever.
  const db = freshDb();
  for (const l of 'BCDEFGHIJKLMNOQRSTUVWXYZ') {
    db.prepare("INSERT INTO branch_letters_spent (letter, kind) VALUES (?, 'issue')").run(l);
  }
  db.prepare("INSERT INTO patients (full_name, mrn) VALUES ('Длинный', 'AAA-24-00500')").run();
  db.prepare("INSERT INTO patients (full_name, mrn) VALUES ('Короткий', 'A-24-00500')").run();
  assert.equal(allocateLetter(db, { name: 'Двадцать седьмой' }), 'AA', 'neither row is an AA- number');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM branch_letters_spent WHERE kind='burn'").get().n, 1,
    "only 080's 'P' — nothing was burned by mistake");
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
  assert.equal(nextLetter(['AA', 'B'], ['AA', 'B']), 'AB');
  assert.equal(nextLetter(['B', 'AA'], ['B', 'AA']), 'AB');
  const db = freshDb();
  db.prepare("INSERT INTO branch_letters_spent (letter, kind) VALUES ('B','issue'),('AA','issue')").run();
  assert.equal(allocateLetter(db, { name: 'Двадцать восьмой' }), 'AB');
});

test('the A..Z..AA..ZZ..AAA sequence never repeats a letter', () => {
  // toIndex/fromIndex must round-trip for every value the allocator can reach,
  // and the boundaries are where a base-26 encoding goes wrong: Z->AA (26->27)
  // and ZZ->AAA (702->703).
  const seen = new Set();
  let letter = nextLetter([], []);
  for (let i = 1; i <= 703; i++) {
    assert.equal(seen.has(letter), false, 'repeated ' + letter + ' at position ' + i);
    seen.add(letter);
    if (i === 26) assert.equal(letter, 'Z');
    if (i === 27) assert.equal(letter, 'AA');
    if (i === 702) assert.equal(letter, 'ZZ');
    if (i === 703) assert.equal(letter, 'AAA');
    letter = nextLetter([letter], [letter]);
  }
  // Every letter produced is a shape both tables in 080 accept (plain A-Z).
  for (const l of seen) assert.match(l, /^[A-Z]+$/);
});
