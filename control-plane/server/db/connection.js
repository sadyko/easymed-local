import Database from 'better-sqlite3';

// One shared connection per process. WAL = many readers + one writer, which
// matches a small vendor service taking occasional check-ins. foreign_keys is
// off by default in SQLite.
//
// Adapted from the clinic app's server/db/connection.js — same pragmas, same
// reasoning. The clinic app also registers a `lower_uni` UDF there for
// Cyrillic-aware case-insensitive search (CYRILLIC_ILIKE_V1); this registry
// has no free-text patient/clinical search of that kind (clinic name lookups
// are by exact clinic_id or a short admin list), so it is not carried over —
// registering an unused UDF on every connection is a thing to explain later
// for no benefit now.
export function openDb(file) {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}
