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
