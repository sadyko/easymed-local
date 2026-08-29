// BRANCH_IDENTITY_V1 — the letter that namespaces a branch's patient numbers.
//
// A letter is SPENT the moment it is issued and is never handed out again, even
// after the branch that held it is deleted. Reuse would let two different people
// carry the same MRN years apart, and no part of the system would flag it — the
// numbers would simply be equal.
//
// The ledger this reads (branch_letters_spent) and the reasoning behind its
// 'issue'/'burn' split live in server/db/migrations/080_branch_identity.sql.

const A = 'A'.charCodeAt(0);

// Spreadsheet-column ordering: A..Z, AA..AZ, BA.. — short for the first 26
// branches (which is every clinic we have) and everyone reads it unexplained.
function toIndex(letter) {
  let n = 0;
  for (const ch of String(letter).toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - A + 1);
  return n;
}

// The `- 1` before BOTH the modulo and the division is the whole trick, and not
// decoration: this is BIJECTIVE base-26, which has no zero digit — A is 1, Z is
// 26, and 27 must come out 'AA'. Ordinary base-26 would spell 26 as digits (1,0)
// and so need a letter for a zero that has no spelling. Drop either `- 1` and
// the Z -> AA boundary is where it shows.
function fromIndex(n) {
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(A + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

// `issued` drives WHERE WE ARE; `taken` is everything the ledger holds at all.
//
// The two differ because migration 080 BURNS 'P' — the prefix ~70,000 legacy
// MRNs already carry — without it ever having been a branch. If a burn counted
// as issued, the highest would be P and a clinic's SECOND branch would be
// lettered Q, silently skipping B..O.
//
// The highest is taken by INDEX, not by string comparison: past 26 branches
// 'AA' sorts before 'B' lexically, so a MAX() over the text would hand out a
// letter that is already on a branch.
//
// BOTH arguments are REQUIRED, and that is a deliberate reversal: `taken` used to
// default to `issued`, which reads like a safety net and provably is not one.
// Every member of `issued` has an index <= highest and the walk starts at
// highest + 1, so a defaulted `taken` can never block anything — the default
// silently meant "this ledger has no burns", and every ledger has at least one.
// The cost of the omission was specific: nextLetter(['A'..'O']) answered 'P',
// the single letter this module exists never to issue. Refusing beats answering
// wrongly — the same trade migration 080 makes when its trigger RAISEs instead
// of minting a NULL MRN. A caller with genuinely no burns passes the ledger
// twice, which states that premise instead of assuming it.
export function nextLetter(issued, taken) {
  if (!Array.isArray(issued) || !Array.isArray(taken)) {
    throw new TypeError(
      'nextLetter(issued, taken): both are required. `taken` is the WHOLE ledger, burns included; '
      + 'omit it and a fifteen-branch clinic is handed P, the legacy MRN prefix.',
    );
  }
  const highest = issued.reduce((max, l) => Math.max(max, toIndex(l)), 0);
  const blocked = new Set(taken.map((l) => String(l).toUpperCase()));
  let n = highest + 1;
  while (blocked.has(fromIndex(n))) n += 1;   // step over burns
  return fromIndex(n);
}

// Is some patients.mrn already numbered under this letter?
//
// CASE-INSENSITIVE, and that is the whole reason this is a scan and not a seek.
// patients.mrn is indexed BINARY, so the fast form — the half-open range
// `mrn >= 'B-' AND mrn < 'B.'` — seeks the index but can only ever match ONE
// spelling. Probing spellings instead does not close the gap: an n-character
// letter has 2^n of them, so a two-letter branch needs AA/Aa/aA/aa and the guard
// gets weaker exactly as a clinic grows past 26 branches — precisely where the
// collision it exists to prevent starts to bite. COLLATE NOCASE says what is
// meant in one predicate, for every letter length, permanently.
//
// The cost, measured on a 70,000-row clinic (the size that motivated all this):
//
//   range, BINARY seek     0.0007 ms   one spelling only, therefore wrong
//   this, COLLATE NOCASE   3.8 ms      worst case: letter free, whole index read
//   ditto, letter in use   0.0009 ms   stops at the first hit
//
// 3.8 ms is bought, not paid: allocation runs a handful of times in a clinic's
// entire life, when the owner adds a branch. The plan asked whether this
// predicate could use an index — it cannot (SQLite applies substr() per row over
// the covering index idx_patients_mrn), and that is the right trade here.
//
// COLLATE NOCASE rather than `mrn LIKE ? || '-%'`, which measured faster at
// 2.3 ms and folds case identically: LIKE folds only while PRAGMA
// case_sensitive_like is off. That is the default and connection.js never sets
// it — but it is a CONNECTION-WIDE switch, so anyone who flips it for an
// unrelated query silently turns this guard case-sensitive again, with no test
// failing anywhere. An explicit COLLATE in the SQL text cannot be switched off
// from a distance.
//
// Why case matters at all: the Excel importer takes the MRN column as typed, so
// an export from a lower-casing system arrives as 'b-24-00500'. BINARY makes
// that a different string from 'B-26-00001', so nothing would ever raise — yet
// it is the same printed series to the staff reading the cards, and to any
// Stage 2 matcher that normalises case.
function mrnPrefixInUse(db, letter) {
  return !!db.prepare(
    "SELECT 1 FROM patients WHERE substr(mrn, 1, length(?) + 1) = ? || '-' COLLATE NOCASE LIMIT 1",
  ).get(letter, letter);
}

export function allocateLetter(db, { name = '' } = {}) {
  // ONE transaction around read-decide-write, and IMMEDIATE so the write lock is
  // taken before the ledger is read. Two reasons, both about the same failure:
  //
  //   * Atomicity. A burn recorded below must not survive a later failure in
  //     this same allocation — the branches.letter UNIQUE index (080) fires when
  //     a restored backup or a hand-edited row already holds the letter, and
  //     letters lost that way are lost forever, for an allocation that never
  //     happened. Rolling the burns back is safe: they are re-derived from
  //     patients.mrn on the next call.
  //   * Racing. better-sqlite3 is synchronous, so nothing inside one process can
  //     interleave here, but a second process on the same file (a CLI tool, the
  //     other half of a pairing) can. Deferred, its write would land between our
  //     read and our INSERT; IMMEDIATE serialises the whole decision. The PRIMARY
  //     KEY on branch_letters_spent and the UNIQUE index on branches.letter stay
  //     the backstop — a duplicate raises instead of issuing the same letter.
  //
  // THE LOCKING HALF HOLDS ONLY IF THIS OPENS THE OUTERMOST TRANSACTION.
  // better-sqlite3 (13.0.2, lib/methods/transaction.js:54) issues a SAVEPOINT
  // instead of BEGIN when db.inTransaction, so nested inside a caller's
  // transaction the BEGIN IMMEDIATE above is never executed — silently, with no
  // error. Atomicity survives (the savepoint still rolls the burns back); the
  // cross-process serialisation does not, and the outer transaction's own mode
  // decides it. That is a live case, not a hypothetical: the branch_identity
  // block in 080 has identity.js setting both of its columns in one transaction,
  // and Task 5 allocates during activation. A caller that needs the lock must open
  // its own transaction with .immediate().
  return db.transaction(() => {
    const rows = db.prepare('SELECT letter, kind FROM branch_letters_spent').all();
    const issued = rows.filter((r) => r.kind === 'issue').map((r) => r.letter);
    const taken = rows.map((r) => r.letter);

    // A prefix that already exists in this database's own patient numbers must
    // never become a branch letter: an Excel import can carry in MRNs from a
    // clinic's previous system, and 080 cannot know which prefixes those are.
    // Recorded as a burn so the knowledge accumulates in one place, and so the
    // letter stays refused even after the imported rows are deleted — their
    // numbers are printed on cards and quoted on old invoices.
    //
    // A LOOP, not recursion. Every pass adds its candidate to `taken`, and
    // nextLetter never returns a letter in `taken`, so each pass moves strictly
    // forward and the walk ends at the first clean letter — there are finitely
    // many prefixes in patients.mrn, so one always exists. The recursive form
    // terminated for the same reason, but its depth was bounded only by the
    // number of poisoned prefixes in the data (one stack frame each), and it
    // re-read the whole ledger on every level.
    //
    // NOTE (Stage 2): this must eventually check the FLEET's MRNs, not only this
    // install's. A poisoned prefix can sit in a SECONDARY branch's imported rows,
    // and the main branch — which allocates — would not see it here.
    //
    // A plain INSERT, deliberately not INSERT OR IGNORE: a candidate is by
    // construction absent from the ledger, so a PRIMARY KEY conflict here means
    // the walk is handing out a letter that is already spent. That must raise,
    // not be swallowed — it is the one failure this file exists to prevent.
    const burn = db.prepare("INSERT INTO branch_letters_spent (letter, kind) VALUES (?, 'burn')");
    let letter = nextLetter(issued, taken);
    while (mrnPrefixInUse(db, letter)) {
      burn.run(letter);
      taken.push(letter);
      letter = nextLetter(issued, taken);
    }

    db.prepare("INSERT INTO branch_letters_spent (letter, kind) VALUES (?, 'issue')").run(letter);

    // The nameless form SPENDS A LETTER AND CREATES NOTHING, and the spend is
    // irreversible — the header's first paragraph is exactly about this. The
    // default stays because allocating without a branch row is a real need (a
    // secondary install already has its roster row and only needs the letter),
    // but a caller that meant to create a branch and forgot the name has just
    // burned a letter out of the clinic's supply with nothing to show for it.
    // This line is also the ONLY INSERT INTO branches on the server, so in
    // practice this function is createBranch wearing another name.
    if (name) db.prepare('INSERT INTO branches (name, letter) VALUES (?, ?)').run(name, letter);
    return letter;
  }).immediate();
}
