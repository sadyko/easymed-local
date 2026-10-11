// PUBLIC_SERVER_V1 — миграции публичного сервера: те же правила, что у
// control-plane/server/db/migrate.js (имя NNN_имя.sql, номер не повторяется,
// каждый файл — в своей транзакции). Своя копия, а не импорт: публичный сервер
// и сервер лицензий — разные службы, и общего кода о базе у них нет.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');
const NAME_RE = /^\d{3,}_[\w.-]+\.sql$/;

function files(dir) {
  const list = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const seen = new Map();
  for (const f of list) {
    if (!NAME_RE.test(f)) throw new Error('Bad migration filename (expected NNN_name.sql): ' + f);
    const n = Number(f.slice(0, f.indexOf('_')));
    if (seen.has(n)) throw new Error('Duplicate migration number: ' + seen.get(n) + ' and ' + f);
    seen.set(n, f);
  }
  return list;
}

export function migrate(db, dir = MIGRATIONS_DIR) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  )`);
  const applied = new Set(db.prepare('SELECT name FROM schema_migrations').all().map((r) => r.name));
  for (const f of files(dir)) {
    if (applied.has(f)) continue;
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(f);
    })();
  }
}
