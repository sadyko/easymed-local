import test from 'node:test';
import assert from 'node:assert/strict';
import { readIdentity, becomeSecondary } from './identity.js';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';

function freshDb() { const db = openDb(':memory:'); migrate(db); return db; }

test('a fresh install is the main branch, letter A', () => {
  const db = freshDb();
  assert.deepEqual(readIdentity(db), { letter: 'A', role: 'main', branch_id: 1 });
});

test('becoming a secondary branch adopts the letter the main branch issued', () => {
  const db = freshDb();
  becomeSecondary(db, { letter: 'C', name: 'Чиланзар' });
  const me = readIdentity(db);
  assert.equal(me.letter, 'C');
  assert.equal(me.role, 'secondary');
});

test('new patients here are numbered with the adopted letter', () => {
  const db = freshDb();
  becomeSecondary(db, { letter: 'C', name: 'Чиланзар' });
  db.prepare("INSERT INTO patients (full_name) VALUES ('Пациент')").run();
  const p = db.prepare('SELECT mrn FROM patients ORDER BY id DESC LIMIT 1').get();
  assert.match(p.mrn, /^C-\d{2}-\d{5}$/, 'got ' + p.mrn);
});

test('adopting a letter twice is refused - an install has ONE identity', () => {
  const db = freshDb();
  becomeSecondary(db, { letter: 'C', name: 'Чиланзар' });
  assert.throws(() => becomeSecondary(db, { letter: 'D', name: 'Другой' }), /already/i);
});

test('the roster keeps the main branch alongside us, and branch_id names OUR row', () => {
  // The invariant 080 spells out: `branches` is the ROSTER as this install knows
  // it — a secondary still holds the main branch's 'A' row — while
  // branch_identity is the one-row answer to "which of them am I". Row 1 is
  // never renamed or re-lettered here: local invoices, cashier shifts and
  // user_branches already point at branch_id = 1, and rewriting that row would
  // move all of them to a different branch without a word.
  const db = freshDb();
  const me = becomeSecondary(db, { letter: 'C', name: 'Чиланзар' });
  assert.deepEqual(db.prepare('SELECT id, name, letter FROM branches ORDER BY id').all(), [
    { id: 1, name: 'Main Branch', letter: 'A' },
    { id: 2, name: 'Чиланзар', letter: 'C' },
  ]);
  assert.deepEqual(me, { letter: 'C', role: 'secondary', branch_id: 2 },
    'the return value is the identity that now stands, not the one that was asked for');
  assert.deepEqual(readIdentity(db), me);
});

test('adopting stamps updated_at, which nothing else in the schema maintains', () => {
  // 080 names this function as the column's only writer. Miss it and a column
  // called updated_at reads INSTALL TIME forever — confidently answering the
  // wrong question the first time anyone asks when this branch was re-pointed.
  //
  // The sentinel is from another era on purpose. strftime here has one-second
  // granularity, so the default and a write in the same second are the SAME
  // string, and "it changed" is only observable against a value the default
  // cannot produce.
  const db = freshDb();
  db.prepare("UPDATE branch_identity SET updated_at = '2000-01-01T00:00:00Z' WHERE id = 1").run();
  becomeSecondary(db, { letter: 'C', name: 'Чиланзар' });
  const at = db.prepare('SELECT updated_at FROM branch_identity WHERE id = 1').get().updated_at;
  assert.notEqual(at, '2000-01-01T00:00:00Z', 'becomeSecondary must write updated_at');
  assert.match(at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
    "…in the column's one format — a JS toISOString would put milliseconds on this row and none on the other");
});

test('the adopted letter joins the ledger as ISSUED, beside the rows already there', () => {
  // 'issue' means "handed to a real branch", and a letter a secondary adopts was
  // genuinely issued to it — by the main branch, which spent it from the fleet's
  // ledger. The distinction from 'burn' is what letters.js reads to decide where
  // allocation stands, so it is written out rather than left to the default.
  const db = freshDb();
  becomeSecondary(db, { letter: 'C', name: 'Чиланзар' });
  assert.deepEqual(db.prepare('SELECT letter, kind FROM branch_letters_spent ORDER BY letter').all(),
    [{ letter: 'A', kind: 'issue' }, { letter: 'C', kind: 'issue' }, { letter: 'P', kind: 'burn' }],
    "our letter is recorded as issued, and neither the main branch's 'A' nor the burned 'P' is disturbed");
});

test('a letter already spent in this database is refused, never silently ignored', () => {
  // The plan wrote this INSERT as INSERT OR IGNORE. Ignoring the conflict adopts
  // the letter anyway and leaves the ledger describing SOMEBODY ELSE: the row
  // recording who spent it, and when, would belong to the other holder. All
  // three of these are reachable from an activation screen.
  const db = freshDb();

  assert.throws(() => becomeSecondary(db, { letter: 'A', name: 'Свой' }),
    /already spent in this database \(issue\)/, "'A' is the main branch's own letter");

  assert.throws(() => becomeSecondary(db, { letter: 'P', name: 'Свой' }),
    /already spent in this database \(burn\)/,
    "'P' is the burned legacy MRN prefix — adopting it would mint into ~70 000 printed numbers");

  // A letter this install issued while it was still the main branch.
  db.prepare("INSERT INTO branch_letters_spent (letter, kind) VALUES ('B','issue')").run();
  assert.throws(() => becomeSecondary(db, { letter: 'B', name: 'Свой' }), /already spent/i);

  // A restored backup or a hand-edited row can hold 'd'; the ledger's PRIMARY
  // KEY is BINARY, so only a NOCASE lookup sees it. Miss it and the refusal
  // arrives three lines later as a bare "UNIQUE constraint failed" from
  // branches_letter_uniq, which IS case-insensitive.
  db.pragma('ignore_check_constraints = ON');
  db.prepare("INSERT INTO branch_letters_spent (letter, kind) VALUES ('d','issue')").run();
  db.pragma('ignore_check_constraints = OFF');
  assert.throws(() => becomeSecondary(db, { letter: 'D', name: 'Свой' }), /already spent/i);

  assert.deepEqual(readIdentity(db), { letter: 'A', role: 'main', branch_id: 1 },
    'four refusals, and this install is still exactly what it was');
});

test('a letter that already prefixes patient numbers here is refused', () => {
  // letters.js refuses to ISSUE a letter that already prefixes an MRN, but it
  // runs on the MAIN branch and reads the MAIN branch's rows — its own Stage 2
  // note says the fleet's are invisible to it. An Excel import at THIS building,
  // from the clinic's previous system, is exactly the row it cannot see, and
  // adoption is the last moment before this install mints into that series.
  for (const imported of ['C-24-00500', 'c-24-00500']) {
    const db = freshDb();
    db.prepare('INSERT INTO patients (full_name, mrn) VALUES (?, ?)').run('Импорт', imported);
    assert.throws(() => becomeSecondary(db, { letter: 'C', name: 'Чиланзар' }),
      /already prefixes patient numbers/,
      `${imported} must block C — patients.mrn is indexed BINARY, so only a NOCASE check sees the lower-case one`);
  }
});

test('a main install that has already numbered patients cannot be re-lettered', () => {
  // The refusal the plan did not ask for. MRNs are never renumbered (080: they
  // are printed on cards patients carry), so an install that registered
  // A-26-00042 and then became branch C would keep that row forever while
  // letter A stays with the main branch — which goes on minting A-26-000NN of
  // its own. Two databases, one number, two different people; Stage 2 matches
  // on natural: ['mrn'] and merges them into one medical record. That is the
  // collision the letter exists to prevent, reached from the other end.
  const db = freshDb();
  db.prepare("INSERT INTO patients (full_name) VALUES ('Свой пациент')").run();
  assert.throws(() => becomeSecondary(db, { letter: 'C', name: 'Чиланзар' }),
    /already registered patients under letter A/);
  assert.deepEqual(readIdentity(db), { letter: 'A', role: 'main', branch_id: 1 },
    'and it stays the main branch');
});

test('an upgraded clinic whose only numbers are legacy P- ones still becomes a branch', () => {
  // The other side of that decision, and why the test is "numbers under MY
  // letter" rather than "any patients at all". 'P' is BURNED fleet-wide (080),
  // so no branch can ever be lettered P and no install can mint a number that
  // collides with these rows — they cannot become two people with one number,
  // which is the only thing the guard above is defending.
  const db = freshDb();
  db.prepare("INSERT INTO patients (full_name, mrn) VALUES ('Старый', 'P-24-00042')").run();
  becomeSecondary(db, { letter: 'C', name: 'Чиланзар' });
  assert.equal(readIdentity(db).letter, 'C');
  assert.equal(db.prepare("SELECT mrn FROM patients WHERE full_name='Старый'").get().mrn, 'P-24-00042',
    'and the legacy number is untouched — it is printed on a card');
});

test('a two-letter branch adopts and numbers exactly like a one-letter one', () => {
  // Past 26 branches is where every letter bug in this feature has hidden, so
  // nothing here may assume a single character: not the shape test, not the
  // ledger lookup, and not the MRN trigger's last-five-characters suffix.
  const db = freshDb();
  becomeSecondary(db, { letter: 'AB', name: 'Двадцать восьмой' });
  db.prepare("INSERT INTO patients (full_name) VALUES ('Пациент')").run();
  assert.match(db.prepare('SELECT mrn FROM patients ORDER BY id DESC LIMIT 1').get().mrn, /^AB-\d{2}-\d{5}$/);
});

test('a letter that is not plain A-Z is refused before anything is written', () => {
  const db = freshDb();
  // 'С' here is CYRILLIC ES, pixel-identical to Latin 'C' and one keyboard
  // layout away when the owner types the key by hand. It survives toUpperCase,
  // so only the A-Z test catches it — adopted, it would put a character nobody
  // can type into a search box on every number this branch ever prints.
  for (const bad of ['', '   ', 'C1', 'C-', 'A B', 'С', 'AB1', null, undefined, 7]) {
    assert.throws(() => becomeSecondary(db, { letter: bad, name: 'Чиланзар' }),
      /plain A-Z characters/, 'letter ' + JSON.stringify(bad));
  }
  assert.throws(() => becomeSecondary(db), /plain A-Z characters/, 'and no options at all');
  assert.deepEqual(readIdentity(db), { letter: 'A', role: 'main', branch_id: 1 });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM branches').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM branch_letters_spent').get().n, 2, "still just 'A' and 'P'");
});

test('a lower-case or padded letter means the same branch, and is taken as such', () => {
  // ' c ' can only mean branch C: branches_letter_uniq is COLLATE NOCASE, so a
  // 'c' row would collide with an allocated 'C' anyway, and both letter CHECKs
  // in 080 refuse lower case outright. Normalising is the only way the value can
  // be accepted at all, and refusing it would answer an owner who pasted a key
  // through a lower-casing tool with a CHECK-constraint message.
  const db = freshDb();
  becomeSecondary(db, { letter: ' c ', name: '  ' });
  assert.equal(readIdentity(db).letter, 'C');
  assert.equal(db.prepare('SELECT name FROM branches WHERE letter = ?').get('C').name, 'C',
    'and a blank name falls back to the letter — branches.name is NOT NULL and a blank row reads as missing');
});

test('a failure after the roster row takes the ledger row with it', () => {
  // Atomicity, on the only thing here that cannot be undone: a letter spent for
  // an adoption that never happened is spent forever, and the next attempt with
  // the correct key would be refused by the row this one left behind. The abort
  // is forced with a trigger because every foreseeable clash is refused before
  // the first INSERT — what is being proven is that an UNforeseen one still
  // rolls back, which is exactly the guarantee letters.js leans on too.
  const db = freshDb();
  db.exec("CREATE TRIGGER t_boom BEFORE UPDATE ON branch_identity BEGIN SELECT RAISE(ABORT, 'boom'); END");
  assert.throws(() => becomeSecondary(db, { letter: 'C', name: 'Чиланзар' }), /boom/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM branch_letters_spent WHERE letter='C'").get().n, 0,
    'the letter must not be spent by an adoption that did not happen');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM branches WHERE letter='C'").get().n, 0);
  assert.deepEqual(readIdentity(db), { letter: 'A', role: 'main', branch_id: 1 });
});

test('a letter already on a branch row is refused in words, not by the index', () => {
  // The realistic source is the one 080 names: a restored backup or a
  // hand-edited row holding the letter while the ledger does not. The index
  // would still stop it, but "UNIQUE constraint failed: branches.letter" is
  // what the owner would then read on the activation screen.
  const db = freshDb();
  db.prepare("INSERT INTO branches (name, letter) VALUES ('Из бэкапа', 'C')").run();
  assert.throws(() => becomeSecondary(db, { letter: 'C', name: 'Чиланзар' }),
    /already on branch "Из бэкапа"/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM branch_letters_spent WHERE letter='C'").get().n, 0);
  assert.deepEqual(readIdentity(db), { letter: 'A', role: 'main', branch_id: 1 });
});

test('a missing identity row is named, not dereferenced', () => {
  // Same words as the MRN trigger's RAISE(ABORT, 'branch identity missing'), on
  // purpose: whichever layer notices first, the operator and the log see one
  // phrase. The plan's version read row.letter and produced a TypeError naming
  // identity.js instead of the missing row.
  const db = freshDb();
  db.prepare('DELETE FROM branch_identity WHERE id = 1').run();
  assert.throws(() => readIdentity(db), /branch identity missing/);
  assert.throws(() => becomeSecondary(db, { letter: 'C', name: 'Чиланзар' }), /branch identity missing/);
});
