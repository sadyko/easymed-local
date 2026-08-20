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
  // The five files below are forgiven because they CANNOT be renamed. Renaming is
  // the obvious tidy-up and it is the dangerous one: schema_migrations records the
  // FULL FILENAME, so a renamed migration looks new and RE-RUNS. What that costs
  // differs per file, and only one of them is catastrophic:
  //
  //   071_dedupe_lab_results.sql        DELETE FROM lab_results. It removed 89
  //                                     duplicate rows once; a second run deletes
  //                                     live data silently. This is the one that
  //                                     matters.
  //   058_referral_source_person.sql    Fails outright on its ADD COLUMNs
  //                                     ("duplicate column name"), so migrate()
  //                                     throws and the clinic will not boot.
  //   071_queue_local_day_backfill.sql  Documents itself as idempotent and is:
  //                                     its UPDATE is guarded by NOT EXISTS and a
  //                                     re-run matches nothing. Listed only
  //                                     because it shares a number.
  //   058_crm_line_doctor.sql           Additive (ADD COLUMN + index). Listed
  //   071_deposit_invoice_link.sql      only because they share a number.
  //
  // All five are applied and their order is settled. Leave them alone.
  //
  // Forgiveness is per FILENAME, deliberately. Exempting the NUMBER would leave
  // 058 and 071 permanently open for a new colliding file, at exactly the two
  // numbers a future contributor is most likely to reuse by mistake.
  const GRANDFATHERED_COLLISIONS = new Set([
    '058_crm_line_doctor.sql',
    '058_referral_source_person.sql',
    '071_dedupe_lab_results.sql',
    '071_deposit_invoice_link.sql',
    '071_queue_local_day_backfill.sql',
  ]);

  const byNumber = new Map();
  for (const file of files) {
    // Compared as a NUMBER so 001_ and 0001_ cannot both claim slot one; the
    // filename regex above permits 3-or-more digits, so that is reachable.
    const num = Number(file.slice(0, file.indexOf('_')));
    const first = byNumber.get(num);
    if (first === undefined) { byNumber.set(num, file); continue; }
    if (GRANDFATHERED_COLLISIONS.has(file) && GRANDFATHERED_COLLISIONS.has(first)) continue;
    throw new Error(
      `Duplicate migration number: ${String(num).padStart(3, '0')} (${first} and ${file})`
    );
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
