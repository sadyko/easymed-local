import Database from 'better-sqlite3';

// One shared connection per process. WAL = many readers + one writer,
// which matches a clinic LAN. foreign_keys is off by default in SQLite.
export function openDb(file) {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // CYRILLIC_ILIKE_V1 — SQLite's LIKE folds case only for ASCII, so «иванов»
  // never matched «Иванов». lower_uni is a JS lower() UDF the compiler wraps
  // around every ilike/contains term — case-insensitive search for Cyrillic
  // (and any other script) across the whole app.
  db.function('lower_uni', { deterministic: true }, (s) => (s == null ? null : String(s).toLowerCase()));
  return db;
}
