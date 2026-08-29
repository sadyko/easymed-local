// BRANCH_IDENTITY_V1 — which branch THIS install is.
//
// Read from the database rather than data/branch-sync.json because the MRN
// trigger (migration 080) needs the letter and a trigger cannot read a file.
// The file keeps what only JavaScript reads: addresses, secrets, keys — and
// `role`, which is the one field BOTH stores hold.
//
// THAT SECOND COPY IS REAL AND NOTHING SYNCHRONISES IT, so read this before
// writing a caller. pairing.js owns the file's copy: readPairing validates it,
// makeMainKey refuses a paired secondary ('already_secondary'), pairWithKey
// refuses a main ('already_main') and writes it. branch_identity.role is the
// database's copy, guarded here, and the two never consult each other.
//
// The drift is reachable today. If becomeSecondary succeeds and the pairing
// file is then not written — pairing.js has a real write_failed path — the file
// says "not paired" while the database says secondary, so «Сделать главным» is
// allowed and the install serves the catalogue as a main branch while minting
// C- numbers as a secondary.
//
// Task 5 must therefore own BOTH writes in one activation and write the
// DATABASE LAST, because the file is rewritable and this identity is not: fail
// with the file written and the database untouched and the install is merely
// unpaired with a stale file, which a retry fixes; fail the other way round and
// a letter has been spent for an activation that never finished.
//
// This file ADOPTS a letter; it never allocates one. Allocation is letters.js,
// and it happens on the MAIN branch, against the fleet's one ledger. A
// secondary allocating from its OWN ledger would be reading a history that
// holds 'A' and 'P' and nothing else: it would answer 'B' and hand itself a
// letter the main branch has already given to another building. The letter
// arrives from outside, in the branch key the owner carries (Task 5).

import { mrnPrefixInUse } from './letters.js';

// Every refusal here carries a REASON CODE, and a caller must branch on that
// rather than on the message.
//
// The shape is borrowed from pairing.js, the module Task 5 activates alongside
// this one: it answers { ok: false, reason: 'already_secondary' | 'bad_key' |
// 'write_failed' } and never throws in 28 KB, leaving the wording to the UI.
// This file throws because its contract does — but the wording decision is the
// same one, and it goes the same way.
//
// The English message is DIAGNOSTIC: for the log, and for whoever is reading
// this code. It is NOT what the owner reads. rpc.js and db.js put e.message
// straight into the HTTP response and this clinic's UI is Russian, so a message
// surfaced verbatim would be a wall of English at the worst moment of an
// activation. The Russian sentence belongs in i18n-strings.js, keyed by code.
function refusal(reason, message) {
  const e = new Error(message);
  e.reason = reason;
  return e;
}

// A branch letter is plain A-Z, and all three tables that store one (080) say
// so in a CHECK. Reaching those CHECKs is the wrong way to find out: this value
// comes off a key an owner pasted into an activation screen, and "CHECK
// constraint failed: branch_identity" tells them nothing they can act on.
//
// Trimmed and upper-cased rather than refused, because ' c ' can only ever mean
// branch C — branches_letter_uniq is COLLATE NOCASE, so 'c' would collide with
// an allocated 'C' anyway, and every comparison in this file and in letters.js
// folds case. What is deliberately NOT normalised away is a letter that merely
// LOOKS like A-Z: the owner types on a Russian keyboard, where Cyrillic 'С' is
// pixel-identical to Latin 'C'. It survives toUpperCase and fails here, which
// is the right answer — adopted, it would put a character nobody can type into
// a search box on every number this branch ever prints.
//
// Which is exactly why the shape is tested BEFORE the fold and not after.
// Upper-casing can MANUFACTURE a letter that was never A-Z: 'ß' folds to 'SS',
// 'ﬁ' to 'FI', 'ı' to 'I'. Test the folded value and all three are accepted as
// branch letters — the same look-alike this guard exists to refuse, arriving
// through the normaliser instead of past it.
function normalizeLetter(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!/^[A-Za-z]+$/.test(raw)) {
    throw refusal(
      'bad_letter',
      'A branch letter is one or more plain A-Z characters, and this is not one: '
      + JSON.stringify(value) + '. Check the branch key was pasted whole.',
    );
  }
  return raw.toUpperCase();
}

/**
 * This install's identity: { letter, role, branch_id }.
 *
 * Raises rather than returning a partial answer when the row is missing. 080
 * creates it and it is id = 1 forever; if it is gone, the MRN trigger is
 * ALREADY refusing every registration with these exact words, so saying them
 * here too means the operator and the log see one phrase whichever layer
 * noticed first. It also beats what the plan's version produced — a TypeError
 * about reading 'letter' of undefined, which names this file instead of the
 * missing row.
 */
export function readIdentity(db) {
  const row = db.prepare('SELECT letter, role, branch_id FROM branch_identity WHERE id = 1').get();
  if (!row) throw refusal('identity_missing', 'branch identity missing');
  return { letter: row.letter, role: row.role, branch_id: row.branch_id };
}

/**
 * Adopt the letter a branch key carried, and become that branch. Called once,
 * when an install is activated with a branch key.
 *
 * THROWS on every refusal, and writes nothing when it does. An activation
 * screen reading "letter C is already spent in this database" sends the owner
 * back for a different key, which is a recoverable afternoon; adopting anyway
 * is not recoverable, because the numbers that follow are printed on cards and
 * handed to patients.
 *
 * @returns {{letter: string, role: string, branch_id: number}} the new identity
 * @throws {Error} with `reason` — bad_letter | identity_missing |
 *   already_secondary | already_numbered | letter_spent | letter_in_mrns |
 *   letter_on_branch. Branch on `reason`; `message` is for the log.
 */
export function becomeSecondary(db, { letter, name } = {}) {
  // Shape first, outside the transaction: a mistyped key never takes a write
  // lock on a clinic's database to be told it is mistyped.
  const adopted = normalizeLetter(letter);

  // .immediate(), with every check INSIDE it, for the reason letters.js sets
  // out at its own transaction: this is read-decide-write over the same two
  // tables, and better-sqlite3 is synchronous only WITHIN one process. A second
  // process on the same file (the CLI, the other half of a pairing) can land a
  // write between a check and an INSERT, so checking outside the transaction
  // would be checking a state that is free to change before the write lands.
  //
  // AND A CALLER MUST NOT WRAP THIS IN ITS OWN TRANSACTION. .immediate()
  // degrades to a SAVEPOINT when db.inTransaction (better-sqlite3 13.0.2,
  // lib/methods/transaction.js:54) — silently, with no error — so nested inside
  // an activation transaction the BEGIN IMMEDIATE is never issued and the
  // cross-process lock is simply gone. Atomicity survives either way; the
  // serialisation does not. The constraints stay the backstop: the PRIMARY KEY
  // on branch_letters_spent and branches_letter_uniq both raise rather than let
  // two rows hold one letter.
  //
  // That trap is also why nothing here calls allocateLetter — it would nest in
  // exactly that way, and a secondary must not allocate at all (see the header).
  return db.transaction(() => {
    const me = readIdentity(db);

    // ONE identity per install. Not reversible from here either: undoing it
    // would mean abandoning a letter under which this branch has already
    // printed numbers, which is the same collision as the guard below. A branch
    // that must be re-pointed at a different clinic gets a fresh install.
    //
    // But re-adopting the letter this install ALREADY holds is a NO-OP, not a
    // refusal, and that distinction is the whole of activation's retryability.
    // Task 5 writes this identity and then the pairing file, and pairing.js has
    // a real write_failed path; when it fires the owner presses the button
    // again. Refusing then would leave the install half-activated — database
    // secondary, file unpaired — with no route forward but a fresh install that
    // discards the clinic's database. The roster row and the ledger entry a
    // second call would write are already here and already ours, so there is
    // nothing to do and nothing to undo. (The letter IS the identity; a `name`
    // that differs on the retry is not applied — renaming a branch is the
    // roster's job, not activation's.)
    if (me.role === 'secondary') {
      if (me.letter === adopted) return me;
      throw refusal(
        'already_secondary',
        'This install is already branch ' + me.letter + ' and cannot change identity.',
      );
    }

    // A MAIN install that has already MINTED numbers may not be re-lettered,
    // and this refusal is the one the plan did not ask for.
    //
    // Existing MRNs are never renumbered — 080 says why: they are printed on
    // cards patients carry. So an install that registered A-26-00042 and then
    // becomes branch C keeps that row forever, while letter A stays with the
    // main branch, which goes on minting A-26-000NN of its own. Two databases,
    // one number, two different people — which breaks the fleet-wide rule 080
    // states once, in its branch_letters_spent block; read it there rather than
    // a summary of it here. That is the exact failure the letter exists to
    // prevent, reached from the other end.
    //
    // The ordinary path is untouched: a branch PC is installed, seeded main/A
    // by 080, and the key is pasted before anyone registers a patient. Nothing
    // has been minted, so nothing can collide.
    //
    // The test is "numbers under MY letter", not "any patients at all", and the
    // difference is deliberate. An upgraded clinic's legacy 'P-' rows do not
    // block adoption: 'P' is BURNED fleet-wide (080), so no branch can ever be
    // lettered P and no install can mint a number that collides with them. Rows
    // an Excel import brought in under some other prefix are not this install's
    // series either.
    //
    // NOT covered, and not coverable from here: a database COPIED onto the
    // second branch's PC instead of a fresh install. Its patients are the SAME
    // people as the main branch's, so Stage 2 matching folds the two copies
    // back together rather than confusing two people — a data-hygiene problem,
    // not this collision — and nothing in these rows tells a copy from a fresh
    // install anyway.
    if (mrnPrefixInUse(db, me.letter)) {
      throw refusal(
        'already_numbered',
        'This install has already registered patients under letter ' + me.letter
        + ', so it cannot become branch ' + adopted + '. Those numbers stay here and are already printed, '
        + 'while letter ' + me.letter + ' stays with the branch that owns it.',
      );
    }

    // A letter already spent in THIS ledger is refused, which is why the plan's
    // INSERT OR IGNORE is written out. Ignoring the conflict adopts the letter
    // and leaves the ledger describing somebody else: the row that records who
    // spent it, and when, would belong to another holder. All three ways this
    // fires are real:
    //   'A'  — the key names the main branch's own letter (a key issued before
    //          the letter field existed, or defaulted somewhere upstream).
    //   'P'  — the burned legacy MRN prefix. Adopting it would mint straight
    //          into ~70 000 numbers the clinic has already printed.
    //   any letter this install issued while it was still the main branch.
    //
    // COLLATE NOCASE although the PRIMARY KEY is BINARY: a restored backup or a
    // hand-edited row can hold 'c', which a BINARY lookup would not see — and
    // branches_letter_uniq, which IS NOCASE, would then refuse the roster row a
    // few lines below with a bare "UNIQUE constraint failed". A check and the
    // constraint behind it have to agree on what "already spent" means.
    const spent = db.prepare('SELECT letter, kind FROM branch_letters_spent WHERE letter = ? COLLATE NOCASE')
      .get(adopted);
    if (spent) {
      throw refusal(
        'letter_spent',
        'Letter ' + adopted + ' is already spent in this database (' + spent.kind + ') and cannot be adopted. '
        + 'A letter is spent once and never reissued.',
      );
    }

    // The other half of the poisoned-prefix guard in letters.js, standing on the
    // side that can actually see the rows. That guard refuses to ISSUE a letter
    // which already prefixes an MRN, but it runs on the main branch and reads
    // the main branch's patients — its own Stage 2 note says the fleet's rows
    // are invisible to it. An Excel import HERE, from this building's previous
    // system, is precisely the row it cannot see, and adoption is the last
    // moment before this install starts minting into that series.
    //
    // A REFUSAL, not a burn, and that is the deliberate difference from
    // letters.js, which RECORDS the same discovery (kind='burn') so the letter
    // stays refused even after the offending rows are deleted. Both mrn checks
    // here are derived from live rows and therefore forget: delete the imported
    // patients and the letter becomes adoptable again. It has to be that way
    // round. A burn belongs in the ledger the MAIN branch allocates from, and a
    // secondary writing one into its own copy would file it where no allocator
    // will ever read it — while leaving the main branch free to issue the same
    // letter to somebody else tomorrow. What a secondary can do is refuse at
    // the one moment the key can still be swapped, and say why, so the poisoned
    // prefix travels back to the main branch as a fact a human acts on rather
    // than as a burn nobody sees.
    if (mrnPrefixInUse(db, adopted)) {
      throw refusal(
        'letter_in_mrns',
        'Letter ' + adopted + ' already prefixes patient numbers in this database (imported from an older '
        + 'system) and cannot be adopted — new numbers would land in a series that is already printed.',
      );
    }

    // Given a reason of its own rather than left to branches_letter_uniq. The
    // index would still stop it, but it raises "UNIQUE constraint failed:
    // branches.letter" — a string no caller can classify and no screen can
    // translate, from a constraint that also fires for causes this refusal is
    // not about. The index stays, and stays NOCASE: it is what catches such a
    // row arriving between this SELECT and the INSERT.
    const held = db.prepare('SELECT id, name FROM branches WHERE letter = ? COLLATE NOCASE').get(adopted);
    if (held) {
      throw refusal(
        'letter_on_branch',
        'Letter ' + adopted + ' is already on branch "' + held.name + '" in this database and cannot be adopted.',
      );
    }

    // Our own row in the roster, ALONGSIDE the main branch's — 080 is explicit
    // that a secondary keeps the main branch's 'A' row in `branches` and answers
    // "which of them am I" from branch_identity. Row 1 is deliberately not
    // renamed or re-lettered: local invoices, cashier shifts and user_branches
    // already reference branch_id = 1, and rewriting that row would silently
    // move every one of them to a different branch.
    const info = db.prepare('INSERT INTO branches (name, letter) VALUES (?, ?)')
      .run(String(name || '').trim() || adopted, adopted);

    // kind spelled out although the column defaults to 'issue'. A letter a
    // secondary adopts WAS issued — to this building, by the main branch — and
    // issue-versus-burn is what letters.js reads to decide where allocation
    // stands. Leaving it to the default would make the two writers of this table
    // disagree about whether the distinction is worth stating, and it is the one
    // column here that carries meaning rather than bookkeeping.
    db.prepare("INSERT INTO branch_letters_spent (letter, kind) VALUES (?, 'issue')").run(adopted);

    // updated_at is written HERE because 080 names this function as its only
    // maintainer. The column defaults to install time, so a missed write leaves
    // it answering "when was this install created" under a name that promises
    // "when did this branch last change identity" — wrong, and confidently so.
    //
    // strftime rather than a JS timestamp, so every value in the column has the
    // one shape the default produces: toISOString would put milliseconds on this
    // row and none on the row written at install, and the two would compare and
    // sort as different formats forever.
    db.prepare(
      "UPDATE branch_identity SET letter = ?, role = 'secondary', branch_id = ?, "
      + "updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = 1",
    ).run(adopted, info.lastInsertRowid);

    return readIdentity(db);
  }).immediate();
}
