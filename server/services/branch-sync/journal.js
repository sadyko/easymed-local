// BRANCH_RECORDS_V1 — что именно уезжает соседу.
//
// ПЕРЕЧЕНЬ КОЛОНОК В КОДЕ, как у справочника (catalogue.js) и по той же
// причине: фильтр «уберём лишнее перед отправкой» забывают обновить, когда в
// таблицу добавляют колонку, а перечень — нет, потому что новая колонка просто
// не попадает в выгрузку, пока её сюда не впишут.
//
// Денежные поля visit_services (unit_price, total, invoice_item_id) НЕ
// перечислены намеренно: статус нужен лабораторной очереди, деньги — Фаза 3.
import { nextStamp } from './hlc.js';

export const SHIPPED = {
  patients: [
    'mrn', 'full_name', 'first_name', 'last_name', 'middle_name',
    'date_of_birth', 'gender', 'blood_type', 'phone', 'email', 'national_id',
    'address', 'nationality', 'occupation',
    'emergency_contact_name', 'emergency_contact_phone',
    'allergies', 'chronic_conditions', 'notes', 'active', 'registration_date',
  ],
  visits: ['visit_date', 'duration_minutes', 'visit_kind', 'visit_type', 'status', 'notes'],
  visit_services: ['quantity', 'status'],
  lab_results: ['value', 'numeric_value', 'unit', 'reference_range', 'flag', 'notes', 'entered_at', 'verified_at'],
};

// Ссылки: колонка → таблица, на которую она смотрит. Уезжает uid родителя, а не
// его локальный id — id у соседа другой (см. миграцию 083).
export const REFS = {
  visits: { patient_id: 'patients' },
  visit_services: { visit_id: 'visits' },
  lab_results: { visit_service_id: 'visit_services' },
};

const TABLES = Object.keys(SHIPPED);

/**
 * Собрать порцию для соседа: по одной записи на изменённую строку.
 *
 * self — буква ЭТОЙ установки (идёт в метку и в origin); peer — буква узла,
 * КОМУ собираем (по нему читается sent_seq). Два имени — две вещи.
 *
 * @returns {{records: Array, upto: number, clock: object}} upto — seq, до которого собрано
 */
export function buildBatch(db, { self, peer, limit = 5000, clock: clockFn = Date.now } = {}) {
  const from = db.prepare('SELECT sent_seq FROM sync_peers WHERE node = ?').get(peer);
  const since = from ? from.sent_seq : 0;

  // ХОЛОДНЫЙ СОСЕД — строки в sync_peers ещё нет. «Холодный» значит «ни разу не
  // отдавали», а не sent_seq = 0: журнал мог быть пуст в момент засева, и по
  // нулю засев повторялся бы вечно. Журнал не засеян для строк, существовавших
  // до миграции 084 (на живой клинике после 083+084 журнал ПУСТ), поэтому
  // первую порцию собираем из самих таблиц — тот же приём, что у справочника.
  // Дальше — только хвост журнала. Последняя запись про каждую строку: у
  // пациента, правленного сто раз, есть одно текущее состояние, а не сто.
  // Голая колонка `at` при GROUP BY + MAX(seq) — из строки с MAX(seq): SQLite
  // это гарантирует (bare-column rule), и именно это нам нужно.
  const heads = from == null ? seedHeads(db, limit) : db.prepare(`
    SELECT tbl, uid, MAX(seq) AS seq, at
      FROM sync_journal
     WHERE seq > ?
     GROUP BY tbl, uid
     ORDER BY seq
     LIMIT ?
  `).all(since, limit);

  // ЧАСЫ ХРАНЯТСЯ, а не заводятся заново на каждую порцию: часы, переведённые
  // назад между двумя синхронизациями, дали бы метку НИЖЕ уже отправленной —
  // приёмник её пропустит, а sent_seq уже ушёл вперёд: правка исчезает молча.
  // Читаем один раз на порцию, не на запись.
  let clock = readClock(db);
  const records = [];
  // Для холодного засева upto — текущий MAX(seq) журнала: всё, что накопилось
  // до засева, уже покрыто снимком таблиц и не должно уехать вторым разом.
  let upto = from == null
    ? (db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM sync_journal').get().m)
    : since;

  for (const h of heads) {
    upto = Math.max(upto, h.seq);
    if (!TABLES.includes(h.tbl)) continue;

    const row = db.prepare(`SELECT * FROM ${h.tbl} WHERE uid = ?`).get(h.uid);
    // Метка — от ВРЕМЕНИ ПРАВКИ (journal.at), не от времени отправки: иначе
    // правка в 10:00, отправленная в 10:15, побеждала бы настоящую правку соседа
    // в 10:05. Монотонный пол HLC при этом сохраняется. `at` — секундной
    // точности; внутри секунды порядок отдачи.
    clock = nextStamp(clock, self, h.at ? () => Date.parse(h.at) : clockFn);

    if (!row) {
      records.push({ tbl: h.tbl, uid: h.uid, op: 'del', stamp: clock.stamp, origin: self });
      continue;
    }

    const data = {};
    for (const col of SHIPPED[h.tbl]) if (row[col] !== undefined) data[col] = row[col];

    const refs = {};
    for (const [col, parent] of Object.entries(REFS[h.tbl] || {})) {
      const pid = row[col];
      if (pid == null) continue;
      const p = db.prepare(`SELECT uid FROM ${parent} WHERE id = ?`).get(pid);
      if (p) refs[col] = p.uid;
    }

    records.push({ tbl: h.tbl, uid: h.uid, op: 'put', stamp: clock.stamp, data, refs, origin: self });
  }
  return { records, upto, clock };
}

// Первая порция холодному соседу: все строки четырёх таблиц как «изменённые».
// seq = 0 у всех: настоящий журнал начнётся после этой порции. Порядок —
// родители раньше детей, чтобы приёмнику меньше держать в ожидании.
function seedHeads(db, limit) {
  const out = [];
  for (const tbl of TABLES) {
    for (const r of db.prepare(`SELECT uid, created_at AS at FROM ${tbl} WHERE uid IS NOT NULL ORDER BY id`).all()) {
      out.push({ tbl, uid: r.uid, seq: 0, at: r.at });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

// Хвост, отданный ВСЕМ соседям, больше не нужен: без чистки журнал растёт
// ~4.7 млн строк в год на клинике с 300 визитами в день, а сборка порции
// сканирует его целиком. Сосед, молчавший дольше STALE_DAYS, забывается: его
// строка удаляется, и по возвращении он получает холодный засев из таблиц —
// иначе он навсегда пропустил бы всё, что вычищено за время его отсутствия.
// Удалять строку ОБЯЗАТЕЛЬНО раньше, чем считать пол: если просто исключить
// такого соседа из MIN(sent_seq), его собственная sync_peers-строка
// (старый sent_seq) остаётся на месте — buildBatch увидит её, посчитает
// соседа тёплым и станет читать хвост журнала НИЖЕ уже вычищенного места:
// дыра, а не переотправка.
const STALE_DAYS = 30;
export function pruneJournal(db, { now = () => new Date() } = {}) {
  const cutoff = new Date(now().getTime() - STALE_DAYS * 86400000).toISOString();
  db.prepare('DELETE FROM sync_peers WHERE last_ok IS NULL OR last_ok < ?').run(cutoff);
  const floor = db.prepare('SELECT MIN(sent_seq) AS m FROM sync_peers WHERE last_ok IS NOT NULL AND last_ok >= ?').get(cutoff);
  if (!floor || floor.m == null || floor.m <= 0) return 0;
  return db.prepare('DELETE FROM sync_journal WHERE seq <= ?').run(floor.m).changes;
}

const CLOCK_KEY = 'sync_clock';

// control_state(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT) —
// та же таблица и та же форма upsert, что в rpc/branch-sync.js (getState /
// putState); здесь не переиспользованы напрямую, потому что там не
// экспортированы, а тянуть ради двух строк весь модуль RPC — лишняя связь.

/** Последнее состояние часов из control_state. Строки → числа (TEXT-колонка). */
export function readClock(db) {
  const row = db.prepare('SELECT value FROM control_state WHERE key = ?').get(CLOCK_KEY);
  if (!row) return null;
  let v;
  try {
    v = JSON.parse(row.value);
  } catch {
    // Испорченная запись не должна ронять сборку порции — часы просто
    // начнутся заново от текущего времени, как при самом первом запуске.
    return null;
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const ms = Number(v.ms);
  const cnt = Number(v.cnt);
  if (!Number.isFinite(ms) || !Number.isFinite(cnt)) return null;
  return { ms, cnt };
}

/** Записать часы — только если ушли вперёд. После удачной отправки и после каждого приёма. */
export function writeClock(db, clock) {
  if (!clock) return;
  const prev = readClock(db);
  // Часы не откатываются НАЗАД записью: порция, собранная позже за то же
  // время (тот же ms, меньший или равный cnt), не должна вернуть часы назад —
  // иначе следующая метка могла бы повториться или уйти ниже уже отправленной.
  if (prev && (prev.ms > clock.ms || (prev.ms === clock.ms && prev.cnt >= clock.cnt))) return;
  db.prepare(`
    INSERT INTO control_state (key, value, updated_at)
    VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(CLOCK_KEY, JSON.stringify({ ms: clock.ms, cnt: clock.cnt }));
}

/** Отметить, докуда соседу отдано, сохранить часы, вычистить хвост. ТОЛЬКО после подтверждённой отправки. */
export function markSent(db, peer, upto, clock = null, { now = () => new Date() } = {}) {
  db.prepare(`
    INSERT INTO sync_peers (node, sent_seq, last_ok) VALUES (?, ?, ?)
    ON CONFLICT(node) DO UPDATE SET sent_seq = MAX(sent_seq, excluded.sent_seq), last_ok = excluded.last_ok
  `).run(peer, upto, now().toISOString());
  writeClock(db, clock);
  pruneJournal(db, { now });
}
