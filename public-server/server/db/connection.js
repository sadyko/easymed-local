// PUBLIC_SERVER_V1 — одна база на процесс (better-sqlite3, как control-plane/).
//
//   • WAL — много читающих и один пишущий: партнёры читают, клиники пишут.
//   • secure_delete — стёртая строка очереди (шифротекст данных пациента)
//     затирается нулями на странице базы, а не остаётся «свободным местом»
//     до перезаписи (решение владельца 16: меньше данных — меньше риска).
//   • busy_timeout — короткое ожидание замка вместо мгновенной ошибки.
import Database from 'better-sqlite3';

export function openDb(file) {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('secure_delete = ON');
  db.pragma('busy_timeout = 2000');
  return db;
}
