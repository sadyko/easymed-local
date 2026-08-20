import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

const MIGRATION_NAME_RE = /^\d{3,}_[\w.-]+\.sql$/;

// Applies every .sql file in migrations/ (sorted by name) that is not yet
// recorded in schema_migrations. Each file runs inside a transaction, so a
// failed migration leaves the database untouched.
export function migrate(db, dir = MIGRATIONS_DIR) {
  if (!fs.existsSync(dir)) throw new Error('Migrations directory not found: ' + dir);

  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  )`);

  // Zero-padded 3+ digit prefixes make lexical sort == numeric order.
  // Reject anything else (e.g. "4_x.sql" sorting after "10_x.sql") up front,
  // before any migration is applied.
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (!MIGRATION_NAME_RE.test(file)) {
      throw new Error('Bad migration filename (expected NNN_name.sql): ' + file);
    }
  }

  // DUP_MIGRATION_GUARD_V1 — two files sharing a number prefix sort against each
  // other ALPHABETICALLY, not by intent. That is survivable while a human watches
  // one machine; it is not survivable once releases are delivered to clinics
  // remotely, which is where this project is going.
  //
  // The 058 and 071 groups below are grandfathered because they CANNOT be fixed.
  // schema_migrations records the FULL FILENAME, so renaming an applied migration
  // makes it look new and re-runs it — and 071_dedupe_lab_results.sql opens with
  // `DELETE FROM lab_results`, while 071_queue_local_day_backfill.sql and
  // 058_referral_source_person.sql both open with UPDATE. Renaming them to tidy up
  // the numbering would wipe real clinical data on every install that already has
  // them. They are applied, their order is settled, and they are left alone.
  //
  // Nothing may join this set. It is a record of damage already done, not a
  // mechanism for permitting more.
  const GRANDFATHERED_COLLISIONS = new Set(['058', '071']);

  const byNumber = new Map();
  for (const file of files) {
    const num = file.slice(0, file.indexOf('_'));
    if (GRANDFATHERED_COLLISIONS.has(num)) continue;
    if (byNumber.has(num)) {
      throw new Error(`Duplicate migration number: ${num} (${byNumber.get(num)} and ${file})`);
    }
    byNumber.set(num, file);
  }

  const applied = new Set(db.prepare('SELECT name FROM schema_migrations').all().map(r => r.name));
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(file);
    })();
  }
}
