import Database from 'better-sqlite3';

// DISK_GUARD_V1 (docs/specs/2026-10-29-3181-cabinet-print-disk-design.md,
// раздел 3, п. 10) — журнал базы (-wal) не держит пиковый размер. После
// большой записи (миграции, импорт, длинный отчёт, во время которого журнал
// нельзя сжать) SQLite оставляет файл -wal того размера, до которого он
// вырос: гигабайты на диске клиники, которые ничего не хранят.
// journal_size_limit обрезает его до 64 МБ после каждой контрольной точки, а
// раз в час wal_checkpoint(TRUNCATE) сжимает до нуля (server/index.js).
export const JOURNAL_SIZE_LIMIT = 64 * 1024 * 1024;
const WAL_CHECKPOINT_INTERVAL_MS = 60 * 60 * 1000;

// One shared connection per process. WAL = many readers + one writer,
// which matches a clinic LAN. foreign_keys is off by default in SQLite.
export function openDb(file) {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma(`journal_size_limit = ${JOURNAL_SIZE_LIMIT}`);   // DISK_GUARD_V1
  registerUdfs(db);
  return db;
}

/**
 * DISK_GUARD_V1 — сжать журнал базы до нуля. Не ждёт: на время вызова
 * busy_timeout = 0, и если поток отчётов (V3120_PERF) ещё читает старый
 * снимок, SQLite сразу отвечает busy=1 — попробуем через час. Иначе вызов
 * стоял бы до 5 секунд, а вместе с ним и регистратура (better-sqlite3
 * синхронный). Никогда не бросает.
 * @returns {{busy:number, log:number, checkpointed:number}|null}
 */
export function checkpointWal(db) {
  let prev = null;
  try {
    prev = db.pragma('busy_timeout', { simple: true });
    db.pragma('busy_timeout = 0');
    return db.pragma('wal_checkpoint(TRUNCATE)')[0] || null;
  } catch (e) {
    console.warn('[db] журнал базы не сжат (попробуем через час):', e && e.message);
    return null;
  } finally {
    if (prev !== null) {
      try { db.pragma(`busy_timeout = ${Number(prev) || 0}`); } catch { /* база закрылась */ }
    }
  }
}

/** DISK_GUARD_V1 — сжатие раз в час. Таймер unref: остановку программы не держит. */
export function scheduleWalCheckpoint(db, { intervalMs = WAL_CHECKPOINT_INTERVAL_MS } = {}) {
  const timer = setInterval(() => checkpointWal(db), intervalMs);
  timer.unref();
  return timer;
}

// SQL-функции приложения — на КАЖДОМ соединении, в том числе на соединении
// потока отчётов (V3120_PERF, services/report-worker.js): запрос, собранный
// одним и тем же кодом, обязан находить их в обоих местах.
export function registerUdfs(db) {
  // CYRILLIC_ILIKE_V1 — SQLite's LIKE folds case only for ASCII, so «иванов»
  // never matched «Иванов». lower_uni is a JS lower() UDF the compiler wraps
  // around every ilike/contains term — case-insensitive search for Cyrillic
  // (and any other script) across the whole app.
  db.function('lower_uni', { deterministic: true }, (s) => (s == null ? null : String(s).toLowerCase()));
}
